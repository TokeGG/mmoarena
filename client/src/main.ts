import { ARENA, CLASSES, PROTOCOL_VERSION, TUNING, barFor, clampToGate, compileMods, specOf, stepMovement } from '@arena/shared';
import type { Build, ClassId, ClientMsg, MoveInput, ServerMsg, Snapshot, TeamId, UnitSnap } from '@arena/shared';
import pkg from '../package.json';
import { ArenaScene } from './scene';
import type { RenderUnit } from './scene';
import { Controls } from './input';
import { Hud } from './hud';
import { Keybinds, SLOT_ACTIONS } from './keybinds';
import { Menu } from './menu';
import { Effects } from './effects';
import { HudLayout } from './hudLayout';
import { MainMenu } from './mainMenu';
import type { PlayRequest } from './mainMenu';
import { initTooltips } from './tooltip';
import { installTips, setTipMods, setTipProgress } from './tips';
import { applyAccountProgress, defaultBuild, loadProfile, progress, restoreGuestProgress, saveProfile } from './profile';
import { AccountUi } from './accountUi';
import { SettingsSync } from './settingsSync';

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
/** The ability bar for the current spec (keys 1..6). */
let bar: string[] = CLASSES.mage.bar;
let myBuild: Build = defaultBuild('mage');
let targetId: number | null = null;

let latest: Snapshot | null = null;
let latestAt = 0;
const snaps: { at: number; snap: Snapshot }[] = [];

/** Client-side prediction for our own movement only. Abilities are never predicted. */
const pred = { x: 0, z: 0 };
/** Previous predicted step, so rendering can interpolate between 20 Hz steps at full frame rate. */
const prevPred = { x: 0, z: 0 };
/** What is actually drawn for our unit and camera: interpolated, then eased, so motion is never stepped. */
const vis = { x: 0, z: 0, facing: 0, yaw: 0, pitch: 0.5, dist: 14, ready: false };
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
  onEditHud: () => hudLayout.start(),
});
const hudLayout = new HudLayout();
hudLayout.onChange = (editing) => {
  controls.enabled = !editing;
  if (editing) controls.releaseAll();
  if (!editing && !latest) {
    // finished editing from the main menu: put the menu back
    document.body.classList.remove('hud-demo');
    hud.show(false);
    mainMenu.show(true);
  }
};

/** Edit the HUD before a match: show it filled with a pretend fight, over the menu's 3D backdrop. */
function editHudFromMenu() {
  document.body.classList.add('hud-demo');
  const c = mainMenu.selectedClass;
  mainMenu.show(false);
  hud.demo(c, barFor(c, mainMenu.currentBuild, CLASSES[c].bar));
  relabel();
  hud.show(true);
  hudLayout.start();
}
let leaving = false;
const relabel = () => hud.setKeyLabels(SLOT_ACTIONS.map((a) => binds.label(a)));
binds.onChange = relabel;

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
      bar = specOf(classId, m.spec ?? '')?.bar ?? CLASSES[classId].bar;
      setTipMods(compileMods(classId, myBuild));
      latest = null;
      snaps.length = 0;
      pending = [];
      seq = 0;
      targetId = null;
      vis.ready = false;
      controls.yaw = controls.facing = ARENA.spawnFacing[team];
      vis.facing = vis.yaw = controls.yaw;
      vis.pitch = controls.pitch;
      vis.dist = controls.dist;
      hud.setBar(classId, bar);
      relabel();
      hud.show(true);
      mainMenu.show(false);
      joinMsg('');
      break;
    case 'account':
    case 'auth_error':
    case 'logged_out':
    case 'leaderboard':
      accountUi.handle(m);
      break;
    case 'settings':
      if (!latest) settingsSync.onServer(m.data);
      break;
    case 'roster':
      hud.setRoster(m.players);
      break;
    case 'profile':
      saveProfile(m.token, m.matches, m.wins);
      setTipProgress(m.matches);
      mainMenu.refresh();
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
      hud.setRoster([]);
      menu.close();
      hud.show(false);
      latest = null;
      mainMenu.show(true);
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
    if (!vis.ready) {
      prevPred.x = vis.x = me.x;
      prevPred.z = vis.z = me.z;
    }
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
  prevPred.x = pred.x;
  prevPred.z = pred.z;
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
  const ability = bar[i];
  if (ability) send({ t: 'cast', ability, target: targetId });
}

controls.onClick = (x, y) => {
  const id = scene.pick(x, y);
  if (id !== null) setTarget(id);
};
controls.onKey = (code, e) => {
  if (code === 'Escape') {
    if (hudLayout.editing) {
      hudLayout.stop();
      return;
    }
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
    // Menu backdrop: the chosen class idles in the arena and sways gently towards the camera.
    const t = now / 1000;
    const spot = ARENA.spawns[0][0];
    const face = ARENA.spawnFacing[0] + Math.PI + Math.sin(t * 0.6) * 0.55;
    scene.setPhase('prep');
    scene.update([{ id: -1, classId: mainMenu.selectedClass, team: 0, x: spot.x, z: spot.z, facing: face, alive: true, stealthed: false, casting: false, sheep: false }], 0, null);
    scene.setCamera(spot.x, spot.z, ARENA.spawnFacing[0] + Math.sin(t * 0.6) * 0.1, 0.12, 6.5);
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

  // our own unit: interpolate between the last two 20 Hz predictions, then ease towards that (hides corrections too)
  {
    const alpha = Math.min(1, Math.max(0, acc / DT));
    const tx = prevPred.x + (pred.x - prevPred.x) * alpha;
    const tz = prevPred.z + (pred.z - prevPred.z) * alpha;
    if (!vis.ready || Math.hypot(tx - vis.x, tz - vis.z) > 4) {
      vis.x = tx;
      vis.z = tz;
      vis.ready = true;
    } else {
      const k = 1 - Math.exp(-dt * 38);
      vis.x += (tx - vis.x) * k;
      vis.z += (tz - vis.z) * k;
    }
    vis.facing = lerpAngle(vis.facing, controls.facing, 1 - Math.exp(-dt * 16));
    // camera: a touch of ease on orbit and zoom so it glides
    vis.yaw = lerpAngle(vis.yaw, controls.yaw, 1 - Math.exp(-dt * 32));
    vis.pitch += (controls.pitch - vis.pitch) * (1 - Math.exp(-dt * 32));
    vis.dist += (controls.dist - vis.dist) * (1 - Math.exp(-dt * 10));
  }

  const units: RenderUnit[] = snap.units.map((u) => {
    let x = u.x;
    let z = u.z;
    let facing = u.facing;
    const i = interp.get(u.id);
    if (i) ({ x, z, facing } = i);
    if (u.id === you) {
      x = vis.x;
      z = vis.z;
      facing = vis.facing;
    }
    return { id: u.id, classId: u.classId, team: u.team, x, z, facing, alive: u.alive, stealthed: u.stealthed, casting: !!snap.units.find((x) => x.id === u.id)?.cast, sheep: !!snap.units.find((x) => x.id === u.id)?.auras.some((a) => a.id === 'polymorph') };
  });

  renderPos.clear();
  for (const u of units) renderPos.set(u.id, { x: u.x, z: u.z, facing: u.facing });

  scene.setPhase(snap.phase);
  scene.update(units, team, targetId);
  effects.update(
    dt,
    snap.units.map((s) => {
      const p = renderPos.get(s.id)!;
      return { id: s.id, x: p.x, z: p.z, facing: p.facing, alive: s.alive, auras: s.auras.map((a) => a.id) };
    }),
  );
  scene.setCamera(vis.x, vis.z, vis.yaw, vis.pitch, vis.dist);
  scene.render(); // render first so projection uses this frame's camera

  hud.update({ snap, now: estNow, you, targetId });
  hud.nameplates(
    units.map((u) => {
      const s = scene.project(u.x, 2.7, u.z);
      const meta = snap.units.find((x) => x.id === u.id)!;
      return { id: u.id, x: s.x, y: s.y, visible: s.visible, name: meta.name, health: meta.health, maxHealth: meta.maxHealth, enemy: u.team !== team, alive: u.alive, cast: meta.cast ? { ability: meta.cast.ability, start: meta.cast.start, end: meta.cast.end } : null };
    }),
    estNow,
  );
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------ main menu

loadProfile();
setTipProgress(progress.matches);
installTips();
initTooltips();

function joinMsg(text: string) {
  mainMenu.setMessage(text);
}

/** Open the socket (once) and resolve true when it is usable. A saved session is resumed on every open. */
let connecting: Promise<boolean> | null = null;
function connect(): Promise<boolean> {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(true);
  if (connecting && ws && ws.readyState === WebSocket.CONNECTING) return connecting;
  connecting = new Promise<boolean>((resolve) => {
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws = sock;
    sock.onopen = () => {
      accountUi.resume();
      resolve(true);
    };
    sock.onmessage = onMessage;
    sock.onclose = () => {
      resolve(false);
      if (ws !== sock) return;
      ws = null;
      const inMatch = !!latest;
      hud.show(false);
      hud.setRoster([]);
      latest = null;
      menu.close();
      mainMenu.show(true);
      mainMenu.refresh();
      // an idle socket dropping at the menu is silent; it reconnects when needed
      if (inMatch || leaving) joinMsg(leaving ? 'You left the match.' : 'Disconnected from server.');
      leaving = false;
    };
  });
  return connecting;
}

async function play(req: PlayRequest) {
  classId = req.classId;
  myBuild = req.build;
  joinMsg('Connecting…');
  if (!(await connect())) {
    joinMsg('Could not reach the server.');
    return;
  }
  // a saved session resumes in the background; the server must know who is joining
  await accountUi.settled();
  if (mainMenu.selectedClass === req.classId) myBuild = mainMenu.currentBuild;
  const profile = accountUi.account ? undefined : progress.token || undefined;
  const msg: ClientMsg =
    req.mode === 'practice'
      ? { t: 'join', name: req.name, classId: req.classId, mode: 'practice', foes: req.foes, ally: req.ally, difficulty: req.difficulty, build: myBuild, profile }
      : { t: 'join', name: req.name, classId: req.classId, mode: 'queue', build: myBuild, profile };
  send(msg);
}

const settingsSync = new SettingsSync((data) => send({ t: 'save_settings', data }));
const accountUi = new AccountUi({
  send: (m) => {
    if (ws && ws.readyState === WebSocket.OPEN) send(m);
    else void connect().then((ok) => (ok ? send(m) : accountUi.fail('Could not reach the server.')));
  },
  onAccount: (a) => {
    if (a) applyAccountProgress(a.matches, a.wins);
    else {
      restoreGuestProgress();
      settingsSync.stop();
    }
    setTipProgress(progress.matches);
    mainMenu.setAccount(a);
    mainMenu.refresh();
  },
});

const mainMenu = new MainMenu(document.getElementById('join')!, {
  onPlay: play,
  onControls: () => menu.open(false, 'keys'),
  onEditHud: editHudFromMenu,
  onSelect: (c, b) => setTipMods(compileMods(c, b)),
  extras: accountUi.chip,
});
accountUi.promptIfNew();
if (accountUi.token) void connect();
setTipMods(compileMods(mainMenu.selectedClass, mainMenu.currentBuild));
const verEl = document.getElementById('ver');
if (verEl) verEl.textContent = `v${pkg.version}`;
