import { ARENA, CLASSES, CLASS_IDS, PROTOCOL_VERSION, TUNING, clampToGate, stepMovement } from '@arena/shared';
import type { ClassId, ClientMsg, MoveInput, PracticeDifficulty, ServerMsg, Snapshot, TeamId, UnitSnap } from '@arena/shared';
import pkg from '../package.json';
import { ArenaScene } from './scene';
import type { RenderUnit } from './scene';
import { Controls } from './input';
import { Hud } from './hud';
import { Keybinds, SLOT_ACTIONS } from './keybinds';
import { Menu } from './menu';
import { Effects } from './effects';

const DT = TUNING.tickMs / 1000;
/** Remote units are drawn this far in the past so there are always two snapshots to blend between. */
const INTERP_DELAY_MS = 100;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const scene = new ArenaScene(canvas);
const binds = new Keybinds();
const controls = new Controls(canvas, binds);

// ------------------------------------------------------------------ state

let ws: WebSocket | null = null;
let you = 0;
let team: TeamId = 0;
let classId: ClassId = 'mage';
let targetId: number | null = null;

let latest: Snapshot | null = null;
let latestAt = 0;
const snaps: { at: number; snap: Snapshot }[] = [];

/** Client-side prediction for our own movement only. Abilities are never predicted. */
const pred = { x: 0, z: 0 };
let seq = 0;
let pending: MoveInput[] = [];

const renderPos = new Map<number, { x: number; z: number; facing: number }>();
const effects = new Effects(scene.scene, (id) => renderPos.get(id) ?? null);
effects.onSwing = (id) => scene.swing(id);
effects.onHit = (id) => scene.flash(id);

const hud = new Hud({
  onTarget: (id) => setTarget(id),
  onSlot: (i) => castSlot(i),
});

const menu = new Menu(binds, {
  onToggle: (open) => {
    controls.enabled = !open;
    if (open) controls.releaseAll();
  },
  onLeave: () => {
    leaving = true;
    ws?.close();
  },
  onSensitivity: (v) => (controls.sens = v),
});
let leaving = false;
const relabel = () => hud.setKeyLabels(SLOT_ACTIONS.map((a) => binds.label(a)));
binds.onChange = relabel;
document.getElementById('btn-keys')!.addEventListener('click', () => menu.open(false, 'keys'));

// ------------------------------------------------------------------ networking

function send(m: ClientMsg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

function onMessage(raw: MessageEvent) {
  const m = JSON.parse(raw.data as string) as ServerMsg;
  switch (m.t) {
    case 'welcome':
      if (m.protocol !== PROTOCOL_VERSION) {
        joinMsg('Client is out of date. Refresh the page.');
        ws?.close();
        return;
      }
      you = m.unitId;
      team = m.team;
      classId = m.classId;
      latest = null;
      snaps.length = 0;
      pending = [];
      seq = 0;
      targetId = null;
      controls.yaw = controls.facing = ARENA.spawnFacing[team];
      hud.setClass(classId);
      relabel();
      hud.show(true);
      document.getElementById('join')!.classList.add('hidden');
      joinMsg('');
      break;
    case 'queued':
      joinMsg(`Waiting for players… ${m.waiting}/${m.needed}`);
      break;
    case 'snapshot':
      onSnapshot(m.snap, m.events);
      break;
    case 'error':
      hud.error(m.reason);
      break;
    case 'closed':
      menu.close();
      hud.show(false);
      latest = null;
      document.getElementById('join')!.classList.remove('hidden');
      joinMsg(m.reason === 'match over' ? 'Match over. Queue again?' : m.reason);
      break;
  }
}

function onSnapshot(snap: Snapshot, events: Parameters<Hud['event']>[0][]) {
  const at = performance.now();
  snaps.push({ at, snap });
  if (snaps.length > 30) snaps.shift();
  latest = snap;
  latestAt = at;

  const me = snap.units.find((u) => u.id === you);
  if (me) {
    // Reconcile: start from the server's position, then replay inputs it has not processed yet.
    pred.x = me.x;
    pred.z = me.z;
    while (pending.length && pending[0].seq <= me.lastSeq) pending.shift();
    if (me.alive && !me.controlled) for (const i of pending) applyInput(i, me);
  }

  const ctx = {
    you,
    nameOf: (id: number) => snap.units.find((u) => u.id === id)?.name ?? (id === 0 ? 'Environment' : 'Someone'),
    project: (id: number) => {
      const p = renderPos.get(id);
      if (!p) return null;
      const s = scene.project(p.x, 2.2, p.z);
      return s.visible ? s : null;
    },
  };
  for (const ev of events) {
    hud.event(ev, ctx);
    effects.event(ev);
  }
}

// ------------------------------------------------------------------ movement prediction

function applyInput(i: MoveInput, me: UnitSnap) {
  const speed = TUNING.runSpeed * me.speedMult;
  if (speed <= 0) return;
  let p = stepMovement({ x: pred.x, z: pred.z }, i, speed, DT, ARENA);
  if (latest?.phase === 'prep') p = clampToGate(p, team, ARENA);
  pred.x = p.x;
  pred.z = p.z;
}

/** Runs at exactly the server tick rate so one input is produced per server step. */
function fixedStep() {
  if (!latest) return;
  const me = latest.units.find((u) => u.id === you);
  if (!me) return;
  const input: MoveInput = { seq: ++seq, ...controls.sample(DT) };
  send({ t: 'input', ...input });
  pending.push(input);
  if (pending.length > 60) pending.shift();
  if (me.alive && !me.controlled) applyInput(input, me);
}

// ------------------------------------------------------------------ interpolation of other units

const lerpAngle = (a: number, b: number, t: number) => {
  const d = ((((b - a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return a + d * t;
};

function interpolate(rt: number): Map<number, { x: number; z: number; facing: number }> {
  const out = new Map<number, { x: number; z: number; facing: number }>();
  if (!snaps.length) return out;
  let i = snaps.length - 1;
  while (i > 0 && snaps[i].snap.time > rt) i--;
  const a = snaps[i].snap;
  const b = snaps[Math.min(i + 1, snaps.length - 1)].snap;
  const span = b.time - a.time;
  const t = span > 0 ? Math.min(1, Math.max(0, (rt - a.time) / span)) : 0;
  for (const ua of a.units) {
    const ub = b.units.find((u) => u.id === ua.id) ?? ua;
    out.set(ua.id, { x: ua.x + (ub.x - ua.x) * t, z: ua.z + (ub.z - ua.z) * t, facing: lerpAngle(ua.facing, ub.facing, t) });
  }
  for (const ub of b.units) if (!out.has(ub.id)) out.set(ub.id, { x: ub.x, z: ub.z, facing: ub.facing });
  return out;
}

// ------------------------------------------------------------------ targeting & abilities

function setTarget(id: number | null) {
  targetId = id;
  send({ t: 'target', id });
}

function cycleTarget(dir: 1 | -1) {
  if (!latest) return;
  const enemies = latest.units
    .filter((u) => u.team !== team && u.alive)
    .sort((a, b) => Math.hypot(a.x - pred.x, a.z - pred.z) - Math.hypot(b.x - pred.x, b.z - pred.z));
  if (!enemies.length) return;
  const idx = enemies.findIndex((u) => u.id === targetId);
  const next = idx < 0 ? enemies[dir > 0 ? 0 : enemies.length - 1] : enemies[(idx + dir + enemies.length) % enemies.length];
  setTarget(next.id);
}

function castSlot(i: number) {
  const ability = CLASSES[classId].bar[i];
  if (ability) send({ t: 'cast', ability, target: targetId });
}

controls.onClick = (x, y) => {
  const id = scene.pick(x, y);
  if (id !== null) setTarget(id);
};
controls.onKey = (code, e) => {
  if (code === 'Escape') {
    // Esc closes the menu if open, else clears the target, else opens the menu (WoW behaviour).
    if (menu.isOpen) menu.back();
    else if (!latest) return;
    else if (targetId !== null) setTarget(null);
    else menu.open(true);
    return;
  }
  if (!latest) return;
  const action = binds.actionFor(code);
  if (!action) return;
  const slot = SLOT_ACTIONS.indexOf(action);
  if (slot >= 0) castSlot(slot);
  else if (action === 'nextTarget') cycleTarget(e.shiftKey ? -1 : 1);
  else if (action === 'prevTarget') cycleTarget(-1);
  else if (action === 'autoAttack') {
    const me = latest.units.find((u) => u.id === you);
    send({ t: 'auto', on: !me?.autoAttack });
  }
};

// ------------------------------------------------------------------ frame loop

let lastT = performance.now();
let acc = 0;

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, (now - lastT) / 1000);
  lastT = now;

  if (!latest) {
    scene.setCamera(ARENA.spawns[0][0].x, ARENA.spawns[0][0].z, ARENA.spawnFacing[0], 0.5, 16);
    scene.update([], 0, null);
    scene.render();
    return;
  }

  acc += dt;
  while (acc >= DT) {
    acc -= DT;
    fixedStep();
  }

  const snap = latest;
  const estNow = snap.time + (performance.now() - latestAt);
  const interp = interpolate(estNow - INTERP_DELAY_MS);

  const units: RenderUnit[] = snap.units.map((u) => {
    let x = u.x;
    let z = u.z;
    let facing = u.facing;
    const i = interp.get(u.id);
    if (i) ({ x, z, facing } = i);
    if (u.id === you) {
      x = pred.x;
      z = pred.z;
      facing = controls.facing;
    }
    return { id: u.id, classId: u.classId, team: u.team, x, z, facing, alive: u.alive, stealthed: u.stealthed, casting: !!snap.units.find((x) => x.id === u.id)?.cast, sheep: !!snap.units.find((x) => x.id === u.id)?.auras.some((a) => a.id === 'polymorph') };
  });

  renderPos.clear();
  for (const u of units) renderPos.set(u.id, { x: u.x, z: u.z, facing: u.facing });

  scene.update(units, team, targetId);
  effects.update(
    dt,
    snap.units.map((s) => {
      const p = renderPos.get(s.id)!;
      return { id: s.id, x: p.x, z: p.z, facing: p.facing, alive: s.alive, auras: s.auras.map((a) => a.id) };
    }),
  );
  scene.setCamera(pred.x, pred.z, controls.yaw, controls.pitch, controls.dist);
  scene.render(); // render first so projection uses this frame's camera

  hud.update({ snap, now: estNow, you, targetId });
  hud.nameplates(
    units.map((u) => {
      const s = scene.project(u.x, 2.7, u.z);
      const meta = snap.units.find((x) => x.id === u.id)!;
      return { id: u.id, x: s.x, y: s.y, visible: s.visible, name: meta.name, health: meta.health, maxHealth: meta.maxHealth, enemy: u.team !== team, alive: u.alive };
    }),
  );
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------ join screen

const nameInput = document.getElementById('name') as HTMLInputElement;
const classBox = document.getElementById('classes')!;
let selected: ClassId = 'mage';

function joinMsg(text: string) {
  document.getElementById('join-msg')!.textContent = text;
}

try {
  nameInput.value = localStorage.getItem('arena.name') ?? '';
  const saved = localStorage.getItem('arena.class') as ClassId | null;
  if (saved && saved in CLASSES) selected = saved;
} catch {
  /* storage can be unavailable (private mode) */
}

const classButtons = CLASS_IDS.map((id) => {
  const b = document.createElement('button');
  b.textContent = CLASSES[id].name;
  b.style.color = CLASSES[id].color;
  b.addEventListener('click', () => {
    selected = id;
    refreshClassButtons();
  });
  classBox.append(b);
  return { id, b };
});
function refreshClassButtons() {
  for (const { id, b } of classButtons) b.classList.toggle('sel', id === selected);
}
refreshClassButtons();

const foesSel = document.getElementById('foes') as HTMLSelectElement;
const allySel = document.getElementById('ally') as HTMLSelectElement;
const diffSel = document.getElementById('difficulty') as HTMLSelectElement;
const PRACTICE_FIELDS: [string, HTMLSelectElement][] = [['arena.foes', foesSel], ['arena.ally', allySel], ['arena.difficulty', diffSel]];
try {
  for (const [key, sel] of PRACTICE_FIELDS) {
    const v = localStorage.getItem(key);
    if (v && [...sel.options].some((o) => o.value === v)) sel.value = v;
  }
} catch {
  /* ignore */
}
document.getElementById('ver')!.textContent = `v${pkg.version}`;

function join(mode: 'practice' | 'queue') {
  const name = nameInput.value.trim() || 'Player';
  try {
    localStorage.setItem('arena.name', name);
    localStorage.setItem('arena.class', selected);
    for (const [key, sel] of PRACTICE_FIELDS) localStorage.setItem(key, sel.value);
  } catch {
    /* ignore */
  }
  const msg: ClientMsg =
    mode === 'practice'
      ? {
          t: 'join', name, classId: selected, mode,
          foes: foesSel.value.split(',') as ClassId[],
          ally: allySel.value === 'none' ? null : (allySel.value as ClassId),
          difficulty: diffSel.value as PracticeDifficulty,
        }
      : { t: 'join', name, classId: selected, mode };
  const sendJoin = () => send(msg);
  if (ws && ws.readyState === WebSocket.OPEN) return sendJoin();

  joinMsg('Connecting…');
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = sendJoin;
  ws.onmessage = onMessage;
  ws.onclose = () => {
    hud.show(false);
    latest = null;
    menu.close();
    document.getElementById('join')!.classList.remove('hidden');
    joinMsg(leaving ? 'You left the match.' : 'Disconnected from server.');
    leaving = false;
  };
}
document.getElementById('btn-practice')!.addEventListener('click', () => join('practice'));
document.getElementById('btn-queue')!.addEventListener('click', () => join('queue'));
