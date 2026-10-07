import { ABILITIES, ARENAS, hasLOS, heightAt, onRaised, stepMovementL, CLASSES, ReplayRunner, canStartJump, jumpHeight, PROTOCOL_VERSION, TUNING, barFor, clampToGate, compileMods, gearLook, specOf, weaponFor, } from '@arena/shared';
import type { ArenaDef, Build, ClassId, ClientMsg, MoveInput, ServerMsg, Snapshot, TeamId, UnitSnap } from '@arena/shared';
import pkg from '../package.json';
import { ArenaScene, fallToward } from './scene';
import type { RenderUnit } from './scene';
import { Controls } from './input';
import { Hud, blockedByCondition } from './hud';
import { Keybinds, SLOT_ACTIONS } from './keybinds';
import type { Action } from './keybinds';
import { Menu } from './menu';
import { Effects } from './effects';
import { HudLayout } from './hudLayout';
import { MainMenu } from './mainMenu';
import { SuggestUi } from './suggestUi';
import { buildHeaderBar } from './headerBar';
import type { PlayRequest } from './mainMenu';
import { initTooltips, setDetailKey } from './tooltip';
import { installTips, setTipBuild, setTipProgress } from './tips';
import { applyAccountProgress, defaultBuild, flags, loadProfile, progress, restoreGuestProgress, saveProfile } from './profile';
import { AccountUi } from './accountUi';
import { applyOrder, loadOrder, saveOrder, swapSlots } from './barOrder';
import { SettingsSync } from './settingsSync';
import { FriendsUi } from './friendsUi';
import { LobbyTags } from './lobbyTags';
import { Audio } from './audio';
import type { Spatial } from './audio';
import { LivePicker, SpectateBar, loadReplay, mapName } from './spectate';
import { closeAllPopups, registerPopup } from './popups';

const DT = TUNING.tickMs / 1000;
/** Remote units are drawn this far in the past so there are always two snapshots to blend between. */
const INTERP_DELAY_MS = 100;

const audio = new Audio();
const canvas = document.getElementById('c') as HTMLCanvasElement;
const scene = new ArenaScene(canvas);
const binds = new Keybinds();
const controls = new Controls(canvas, binds);
controls.inMatch = () => !!latest;
// a stray browser shortcut (or F5) during a live match asks before leaving the page, instead of dropping you from it
window.addEventListener('beforeunload', (e) => {
  if (latest && !spec && latest.phase !== 'ended') {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ------------------------------------------------------------------ state

let ws: WebSocket | null = null;
/** The arena of the current match (or the menu preview). */
let arena: ArenaDef = ARENAS[0];
let you = 0;
let team: TeamId = 0;
let classId: ClassId = 'mage';
/** The ability bar for the current spec (keys 1..6). */
let bar: string[] = CLASSES.mage.bar;
let myBuild: Build = defaultBuild('mage');
let autoEnabled = true; // the auto-attack setting (Esc menu)
let targetId: number | null = null;

/**
 * Watching instead of playing: a live match (snapshots arrive from the server, 5 s late) or a replay (re-simulated here).
 * `follow` is the unit whose view we show; it plays the role `you` has in a real match.
 */
let spec: { kind: 'live' | 'replay'; runner?: ReplayRunner; id?: string; rate: number; paused: boolean; clock: number } | null = null;

let endBoardUp = false;
/** The end screen is a ready check: everyone presses Play again (or leaves) and the next match starts when all are ready. */
const endChoice = (() => {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:50%;bottom:9%;transform:translateX(-50%);display:none;flex-direction:column;align-items:center;gap:10px;z-index:60;';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:14px;';
  const status = document.createElement('div');
  status.style.cssText = 'color:#fff;font-weight:600;text-shadow:0 1px 4px #000;';
  const mk = (label: string, primary: boolean) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `padding:12px 28px;font-size:18px;font-weight:700;border-radius:8px;border:2px solid ${primary ? '#ffd34a' : '#8a93a6'};background:${primary ? '#ffd34a' : 'rgba(20,24,34,.9)'};color:${primary ? '#1a1a1a' : '#fff'};cursor:pointer;`;
    row.append(b);
    return b;
  };
  const again = mk('Ready: play again', true);
  const leave = mk('Leave', false);
  box.append(status, row);
  document.body.append(box);
  let ready = false;
  const paint = (r: number, total: number, you: boolean) => {
    ready = you;
    again.textContent = you ? 'Ready ✓ (click to cancel)' : 'Ready: play again';
    status.textContent = total > 1 ? `${r}/${total} ready for another match` : '';
  };
  again.onclick = () => send({ t: 'rematch', on: !ready });
  leave.onclick = () => {
    box.style.display = 'none';
    send({ t: 'leave' });
  };
  return {
    show: () => { paint(0, 0, false); box.style.display = 'flex'; },
    update: paint,
    hide: () => { box.style.display = 'none'; },
  };
})();
let latest: Snapshot | null = null;
let latestAt = 0;
let lastCount = -1;
let wasAir = false;
let stepAcc = 0;
const lastStepPos = { x: 0, z: 0 };
const snaps: { at: number; snap: Snapshot }[] = [];

/** Client-side prediction for our own movement only. Abilities are never predicted. */
const pred = { x: 0, z: 0 };
/** Which bridge level we are on (0 ground/tunnel, 1 deck and ramps); predicted like the position. */
let predLevel: 0 | 1 = 0;
/** Previous predicted step, so rendering can interpolate between 20 Hz steps at full frame rate. */
const prevPred = { x: 0, z: 0 };
/** What is actually drawn for our unit and camera: interpolated, then eased, so motion is never stepped. */
const vis = { x: 0, z: 0, facing: 0, yaw: 0, pitch: 0.5, dist: 14, ready: false };
let seq = 0;
/** When our own jump began (performance.now). Drawn locally the instant it starts, like movement. */
let myJumpAt = -1e9;
let pending: (MoveInput & { air: number })[] = [];
/** Server ticks since our last jump began: how high we are in it decides whether rails and barricades are cleared (as on the server). */
let jumpTicks = 1e6;
/** The camera's floor height, smoothed like the character's (it falls with you off a walkway). */
const camFloor: { y?: number; fallV?: number } = {};

const renderPos = new Map<number, { x: number; z: number; facing: number }>();
const effects = new Effects(scene.scene, (id) => renderPos.get(id) ?? null);
effects.groundY = (x, z) => heightAt(arena, x, z, predLevel);
effects.onSwing = (id) => scene.swing(id);
effects.onHit = (id) => scene.flash(id);

let barSpec: string | null = null;
const hud = new Hud({
  onTarget: (id) => setTarget(id),
  onSlot: (i) => castSlot(i),
  onReorder: (from, to) => {
    if (spec) return;
    bar = swapSlots(bar, from, to);
    saveOrder(classId, barSpec, bar);
    hud.setBar(classId, bar);
    shownKey = '';
    relabel();
  },
});

const menu = new Menu(binds, {
  onToggle: (open) => {
    controls.enabled = !open;
    if (open) controls.releaseAll();
  },
  onLeave: () => {
    if (spec) {
      if (spec.kind === 'live') send({ t: 'leave' });
      exitSpectate();
      return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      send({ t: 'leave' }); // the server answers with 'closed'; the socket stays up so the party and presence survive
      return;
    }
    leaving = true;
    ws?.close();
  },
  onSensitivity: (v) => (controls.sens = v),
  onAutoAttack: (enabled) => {
    autoEnabled = enabled;
    send({ t: 'autoOff', off: !enabled });
  },
  onEditHud: () => (latest ? hudLayout.start() : editHudFromMenu()),
});
const hudLayout = new HudLayout();
/** The HUD editor was opened from the main menu (over a pretend fight), not in a match. */
let editingFromMenu = false;
hudLayout.onChange = (editing) => {
  controls.enabled = !editing;
  if (editing) controls.releaseAll();
  if (!editing && editingFromMenu) {
    editingFromMenu = false;
    document.body.classList.remove('hud-demo');
    // finished editing from the main menu: put the menu back (unless a match started meanwhile)
    if (!latest && !spec && you === 0) {
      hud.show(false);
      mainMenu.show(true);
    }
  }
};

/** A match (or watching one) is starting: nothing from the menu stays open over it. */
function clearMenuLayers() {
  closeAllPopups();
  menu.close();
  if (hudLayout.editing) {
    editingFromMenu = false; // the editor must not bring the menu back over the match that is starting
    hudLayout.stop();
  }
  document.body.classList.remove('hud-demo');
}

/** Edit the HUD before a match: show it filled with a pretend fight, over the menu's 3D backdrop. */
function editHudFromMenu() {
  editingFromMenu = true;
  document.body.classList.add('hud-demo');
  const c = mainMenu.selectedClass;
  mainMenu.show(false);
  hud.demo(c, barFor(c, mainMenu.currentBuild, CLASSES[c].bar));
  relabel();
  hud.show(true);
  hudLayout.refit();
  hudLayout.start();
}
let leaving = false;
const relabel = () => {
  hud.setKeyLabels(SLOT_ACTIONS.map((a) => binds.label(a)));
  hud.autoKey = binds.label('autoAttack'); // hints name the key you bound, not the default
};
binds.onChange = relabel;

// ------------------------------------------------------------------ networking

function send(m: ClientMsg): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(m));
  return true;
}

function onMessage(raw: MessageEvent) {
  const m = JSON.parse(raw.data as string) as ServerMsg;
  switch (m.t) {
    case 'welcome':
      clearMenuLayers();
      endChoice.hide();
      endBoardUp = false;
      spectateBar.board.toggle(false);
      if (m.protocol !== PROTOCOL_VERSION) {
        joinMsg('Client is out of date. Refresh the page.');
        ws?.close();
        return;
      }
      arena = ARENAS.find((a) => a.id === m.map) ?? ARENAS[0];
      scene.setMap(arena.id);
      audio.ambience(arena.theme);
      you = m.unitId;
      team = m.team;
      classId = m.classId;
      send({ t: 'autoOff', off: !autoEnabled });
      barSpec = m.spec ?? myBuild.spec ?? null;
      bar = applyOrder(m.bar ?? specOf(classId, m.spec ?? '')?.bar ?? CLASSES[classId].bar, loadOrder(classId, barSpec));
      setTipBuild(classId, myBuild);
      latest = null;
      snaps.length = 0;
      pending = [];
      seq = 0;
      targetId = null;
      vis.ready = false;
      controls.yaw = controls.facing = arena.spawnFacing[team];
      vis.facing = vis.yaw = controls.yaw;
      vis.pitch = controls.pitch;
      vis.dist = controls.dist;
      hud.setBar(classId, bar);
      shownKey = '';
      setAiming(null);
      relabel();
      hud.show(true);
      hudLayout.refit();
      mainMenu.show(false);
      joinMsg('');
      break;
    case 'account':
    case 'auth_error':
    case 'logged_out':
    case 'leaderboard':
    case 'owner':
    case 'admin_accounts':
    case 'admin_result':
      accountUi.handle(m);
      break;
    case 'settings':
      if (!latest) settingsSync.onServer(m.data, accountUi.account?.name ?? 'default');
      break;
    case 'roster':
      hud.setRoster(m.players);
      break;
    case 'history':
      accountUi.handle(m);
      break;
    case 'invite':
      audio.ui('ping');
      friendsUi.handle(m);
      break;
    case 'friends':
    case 'party':
    case 'invite_gone':
    case 'notice':
      friendsUi.handle(m);
      break;
    case 'duel_go':
      void joinDuel(m.with);
      break;
    case 'live':
      livePicker.show(m.rows);
      break;
    case 'spectating':
      startSpectate('live', m.map, m.id);
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
      if (!spec && you === 0) break; // a late frame from a match we already left
      // a new round has started: the end scoreboard belongs to the end screen only
      if (endBoardUp && m.snap.phase === 'prep') {
        endBoardUp = false;
        spectateBar.board.toggle(false);
        endChoice.hide();
      }
      onSnapshot(m.snap, m.events);
      break;
    case 'suggest_ack':
    case 'suggestions':
      suggestUi.handle(m);
      break;
    case 'rematch':
      endChoice.update(m.ready, m.total, m.you);
      break;
    case 'stats':
      if (m.final) {
        // the match is over: put the scoreboard up for everyone, with the result as its title
        const w = latest?.winner;
        const mine = latest?.units.find((u) => u.id === you)?.team;
        spectateBar.board.update(m.rows, w === undefined || w === null ? 'Match over' : w === 'draw' ? 'Draw' : spec || mine === undefined ? `Team ${Number(w) + 1} wins` : w === mine ? 'Victory' : 'Defeat');
        spectateBar.board.toggle(true);
        endBoardUp = true;
        if (!spec) endChoice.show();
      } else if (spec?.kind === 'live') spectateBar.setStats(m.rows);
      break;
    case 'error':
      if (m.reason === 'already casting that') break; // a repeat press mid-cast is simply ignored, no need to shout about it
      audio.ui('error');
      hud.error(m.reason);
      break;
    case 'closed':
      endBoardUp = false;
      endChoice.hide();
      spectateBar.board.toggle(false);
      audio.stopAmbience();
      hud.setRoster([]);
      menu.close();
      hud.show(false);
      endSpectateState();
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
  if (spec && (!snap.units.some((u) => u.id === you) || you === 0)) {
    const first = snap.units.find((u) => u.team === 0) ?? snap.units[0];
    if (first) setFollow(first.id, snap);
  }

  const me = snap.units.find((u) => u.id === you);
  if (me) {
    // Reconcile: start from the server's position, then replay inputs it has not processed yet.
    // While we can't act (stunned, feared, sheep) the server moves us, so glide from the last position to the new one;
    // otherwise the render position would swing back to where the crowd control began on every tick.
    if (me.controlled || !me.alive) {
      prevPred.x = pred.x;
      prevPred.z = pred.z;
    }
    pred.x = me.x;
    pred.z = me.z;
    predLevel = me.lv ?? 0;
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
    // a teleport behind someone turns you round: the camera comes with you
    if (ev.t === 'turn' && ev.unit === you && !spec) controls.yaw = controls.facing = ev.facing;
    hud.event(ev, ctx);
    effects.event(ev);
    audio.event(ev, you, team, spatial);
  }
}

/** How loud and where a unit's sound should be, from its distance and screen position relative to the camera. */
function spatial(id: number): Spatial | null {
  const p = renderPos.get(id);
  if (!p) return { gain: 0.6, pan: 0 };
  const dist = Math.hypot(p.x - vis.x, p.z - vis.z);
  if (dist > 60) return null;
  const s = scene.project(p.x, 1.5, p.z);
  const pan = s.visible ? Math.max(-1, Math.min(1, (s.x / window.innerWidth - 0.5) * 2)) * 0.7 : 0;
  return { gain: Math.max(0.12, 1 - dist / 55) * (s.visible ? 1 : 0.6) * (id === you ? 1.1 : 1), pan };
}

// ------------------------------------------------------------------ movement prediction

function applyInput(i: MoveInput & { air: number }, me: UnitSnap) {
  const speed = TUNING.runSpeed * me.speedMult;
  if (speed <= 0) return;
  const step = stepMovementL({ x: pred.x, z: pred.z }, predLevel, i, speed, DT, arena, i.air);
  let p = step.pos;
  predLevel = step.level;
  if (latest?.phase === 'prep') p = clampToGate(p, team, arena);
  prevPred.x = pred.x;
  prevPred.z = pred.z;
  pred.x = p.x;
  pred.z = p.z;
}

/** How high your own character is in the air: your predicted jump, or (while the server moves you, e.g. Heroic Leap) its arc. */
function ownHeight(u: UnitSnap | undefined, serverY?: number): number {
  const jump = jumpHeight(performance.now() - myJumpAt);
  return u?.controlled ? Math.max(jump, serverY ?? u.y ?? 0) : jump;
}

/** Runs at exactly the server tick rate so one input is produced per server step. */
function fixedStep() {
  if (!latest || spec) return;
  const me = latest.units.find((u) => u.id === you);
  if (!me) return;
  const sample = controls.sample(DT);
  const jump = sample.jump && me.alive && !me.controlled && canStartJump(performance.now() - myJumpAt);
  if (jump) {
    myJumpAt = performance.now();
    audio.jump();
  }
  const input: MoveInput = { seq: ++seq, ...sample, jump: jump || undefined };
  send({ t: 'input', ...input });
  jumpTicks = jump ? 0 : jumpTicks + 1;
  const mine = { ...input, air: jumpHeight(jumpTicks * TUNING.tickMs) };
  pending.push(mine);
  if (pending.length > 60) pending.shift();
  if (me.alive && !me.controlled) applyInput(mine, me);
}

// ------------------------------------------------------------------ interpolation of other units

const lerpAngle = (a: number, b: number, t: number) => {
  const d = ((((b - a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return a + d * t;
};

function interpolate(rt: number): Map<number, { x: number; z: number; y: number; facing: number }> {
  const out = new Map<number, { x: number; z: number; y: number; facing: number }>();
  if (!snaps.length) return out;
  let i = snaps.length - 1;
  while (i > 0 && snaps[i].snap.time > rt) i--;
  const a = snaps[i].snap;
  const b = snaps[Math.min(i + 1, snaps.length - 1)].snap;
  const span = b.time - a.time;
  const t = span > 0 ? Math.min(1, Math.max(0, (rt - a.time) / span)) : 0;
  for (const ua of a.units) {
    const ub = b.units.find((u) => u.id === ua.id) ?? ua;
    out.set(ua.id, { x: ua.x + (ub.x - ua.x) * t, z: ua.z + (ub.z - ua.z) * t, y: ua.y + (ub.y - ua.y) * t, facing: lerpAngle(ua.facing, ub.facing, t) });
  }
  for (const ub of b.units) if (!out.has(ub.id)) out.set(ub.id, { x: ub.x, z: ub.z, y: ub.y, facing: ub.facing });
  return out;
}

// ------------------------------------------------------------------ targeting & abilities

/** True while you stand in an enemy's smoke cloud: you cannot target. */
function inEnemySmoke(): boolean {
  const me = latest?.units.find((u) => u.id === you);
  if (!latest || !me) return false;
  return (latest.zones ?? []).some((z) => z.smoke && z.team !== me.team && Math.hypot(me.x - z.x, me.z - z.z) <= z.r);
}

function setTarget(id: number | null) {
  if (spec) {
    if (id !== null) setFollow(id, latest);
    return;
  }
  if (id !== null && inEnemySmoke()) {
    hud.error('Blinded by smoke');
    return;
  }
  targetId = id;
  if (id !== null) audio.ui('select');
  send({ t: 'target', id });
}

function cycleTarget(dir: 1 | -1) {
  if (!latest) return;
  if (spec) return cycleFollow(dir);
  const enemies = latest.units
    .filter((u) => u.team !== team && u.alive)
    .sort((a, b) => Math.hypot(a.x - pred.x, a.z - pred.z) - Math.hypot(b.x - pred.x, b.z - pred.z));
  if (!enemies.length) return;
  const idx = enemies.findIndex((u) => u.id === targetId);
  const next = idx < 0 ? enemies[dir > 0 ? 0 : enemies.length - 1] : enemies[(idx + dir + enemies.length) % enemies.length];
  setTarget(next.id);
}

/** The ground point under the cursor for an aimed spell, pulled in to the spell's range from you. */
function groundAim(range: number): { x: number; z: number; lv?: 1 } | null {
  const c = controls.cursor();
  const g = scene.groundPoint(c.x, c.y);
  if (!g) return null;
  const dx = g.x - pred.x;
  const dz = g.z - pred.z;
  const d = Math.hypot(dx, dz);
  if (d > range - 0.3) {
    const p = { x: pred.x + (dx / d) * (range - 0.3), z: pred.z + (dz / d) * (range - 0.3) };
    return g.lv === 1 && onRaised(arena, p.x, p.z) ? { ...p, lv: 1 } : p; // pulled in off the deck: back on the ground
  }
  return g;
}

/** The level of a ground point you aim at: on top of a walkway when the aim hit it, else the ground. */
function aimLevel(g: { x: number; z: number; lv?: 1 }): 0 | 1 {
  return g.lv === 1 ? 1 : 0;
}

/** The bar as it looks right now: slots with a stealth swap show the swapped ability while you are stealthed. */
function shownBar(): string[] {
  const me = latest?.units.find((u) => u.id === you);
  const stealthed = !!me?.stealthed;
  return bar.map((id) => (stealthed && ABILITIES[id]?.stealthSwap) || id);
}
let shownKey = '';

function castSlot(i: number) {
  if (spec) return;
  const ability = shownBar()[i];
  if (!ability) return;
  const def = ABILITIES[ability];
  if (def?.target === 'ground') {
    // first press arms the spell (a ring follows the cursor); pressing it again or clicking places it
    if (aiming === ability) confirmAim();
    else setAiming(ability);
    return;
  }
  setAiming(null);
  // spell queue: pressing a global-cooldown spell while casting or on the GCD holds it and sends it the moment you are free
  const me = latest?.units.find((u) => u.id === you);
  const nowS = estimatedNow();
  if (me && def?.gcd && me.alive && (me.cast || me.gcdEnd > nowS) && (me.cooldowns[ability] ?? 0) - nowS < 1500) {
    // the spell you are casting right now is only queued again in its last quarter second, so one press never casts twice
    const active = me.cast?.ability ?? (performance.now() - lastSent.at < 3000 ? lastSent.ability : null);
    const freeIn = Math.max(me.cast ? me.cast.end - nowS : 0, me.gcdEnd - nowS);
    if (active === ability && freeIn > QUEUE_SAME_MS) return;
    queued = { ability, target: targetId, until: performance.now() + 3000 };
    return;
  }
  queued = null;
  sendCast({ t: 'cast', ability, target: targetId, vt: viewTime() });
}

/** Server time of the frame other players are drawn at right now; the server judges range against where they stood then (lag compensation). */
function viewTime(): number {
  return Math.round(estimatedNow() - INTERP_DELAY_MS);
}

const QUEUE_SAME_MS = 250;
/** The last spell sent, so a repeat press of it is not queued on top of itself. */
const lastSent = { ability: '', at: 0 };
function sendCast(msg: Extract<ClientMsg, { t: 'cast' }>) {
  lastSent.ability = msg.ability;
  lastSent.at = performance.now();
  send(msg);
}

let queued: { ability: string; target: number | null; until: number; ground?: { x: number; z: number; lv?: 1 } } | null = null;
function estimatedNow(): number {
  return latest ? latest.time + (performance.now() - latestAt) : 0;
}
/** Sends the queued spell once the current cast and global cooldown are over. */
function flushQueue() {
  if (!queued) return;
  const me = latest?.units.find((u) => u.id === you);
  if (spec || !me || !me.alive || performance.now() > queued.until) { queued = null; return; }
  if (me.cast || me.gcdEnd > estimatedNow() + 25 || (me.cooldowns[queued.ability] ?? 0) > estimatedNow() + 25) return;
  const q = queued;
  queued = null;
  sendCast({ t: 'cast', ability: q.ability, target: q.target, vt: viewTime(), ...(q.ground ? { x: q.ground.x, z: q.ground.z, ...(q.ground.lv === 1 ? { lv: 1 as const } : {}) } : {}) });
}

/** The ground spell waiting for a click (Flamestrike, Blizzard), or null. The aiming ring only shows while this is set. */
let aiming: string | null = null;
function setAiming(id: string | null) {
  aiming = id;
  hud.setAiming(id);
}
function confirmAim() {
  const def = aiming ? ABILITIES[aiming] : undefined;
  if (!aiming || !def) return;
  const g = groundAim(def.range);
  if (!g) return; // cursor on the sky: keep aiming
  if (!hasLOS({ x: pred.x, z: pred.z }, g, arena, predLevel, aimLevel(g), jumpHeight(performance.now() - myJumpAt))) return; // red spot: nothing is sent, nothing is spent, still aiming
  const spot = { x: g.x, z: g.z, ...(g.lv === 1 ? { lv: 1 as const } : {}) };
  const me = latest?.units.find((u) => u.id === you);
  const nowS = estimatedNow();
  if (me && def.gcd && (me.cast || me.gcdEnd > nowS)) {
    // placed while casting or on the global cooldown: it goes into the spell queue with its spot, like any other spell
    queued = { ability: aiming, target: null, until: performance.now() + 3000, ground: spot };
  } else {
    queued = null;
    sendCast({ t: 'cast', ability: aiming, target: null, ...spot, vt: viewTime() });
  }
  setAiming(null);
}

controls.aimActive = () => !!aiming && !spec;
controls.onAimPress = () => confirmAim(); // placed on mouse DOWN, so no click-and-hold nudges the camera
controls.onClick = (x, y) => {
  if (aiming && !spec) return void confirmAim();
  const id = scene.pick(x, y, spec ? null : you);
  if (id !== null) setTarget(id);
  else if (!spec && targetId !== null) setTarget(null); // clicking empty space drops the target (and auto-attack with it)
};
controls.onRightClick = (x, y) => {
  if (spec || aiming) return;
  const id = scene.pick(x, y, you);
  if (id === null) return;
  setTarget(id);
  const me = latest?.units.find((u) => u.id === you);
  const t = latest?.units.find((u) => u.id === id);
  if (autoEnabled && me && t && t.team !== me.team && !me.autoAttack) send({ t: 'auto', on: true }); // right-click an enemy: target and start swinging
};
let modalAtEsc = false;

/** Turning your own model in the lobby: drag anywhere on the menu's empty middle. */
const lobbySpin = { yaw: 0, at: -1e9, dragX: null as number | null };
{
  const join = document.getElementById('join')!;
  join.addEventListener('pointerdown', (e) => {
    if (e.target !== join || e.button !== 0) return;
    lobbySpin.dragX = e.clientX;
    lobbySpin.at = performance.now();
    join.setPointerCapture(e.pointerId);
    join.style.cursor = 'grabbing';
  });
  join.addEventListener('pointermove', (e) => {
    if (lobbySpin.dragX === null) {
      join.style.cursor = e.target === join ? 'grab' : '';
      return;
    }
    lobbySpin.yaw += (e.clientX - lobbySpin.dragX) * 0.012;
    lobbySpin.dragX = e.clientX;
    lobbySpin.at = performance.now();
  });
  const end = (e: PointerEvent) => {
    if (lobbySpin.dragX === null) return;
    lobbySpin.dragX = null;
    if (join.hasPointerCapture(e.pointerId)) join.releasePointerCapture(e.pointerId);
    join.style.cursor = e.target === join ? 'grab' : '';
  };
  join.addEventListener('pointerup', end);
  join.addEventListener('pointercancel', end);
}
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') modalAtEsc = !!document.querySelector('.mm-modal:not(.hidden), .mm-specpop:not(.hidden)');
}, true);
const joiningNow = () => document.getElementById('join')?.classList.contains('hidden') ?? false;
controls.onKey = (code, e) => {
  if (code === 'Escape') {
    if (aiming) return void setAiming(null);
    if (hudLayout.editing) {
      hudLayout.stop();
      return;
    }
    // Esc closes the menu if open, else clears the target, else opens the menu (WoW behaviour).
    if (menu.isOpen) menu.back();
    else if (!latest) {
      // in the lobby Esc opens the same menu (without Resume/Leave), unless a window was open and Esc just closed it
      if (!modalAtEsc && !hudLayout.editing && !joiningNow()) menu.open(false);
      return;
    }
    else if (!spec && targetId !== null) setTarget(null);
    else menu.open(true);
    return;
  }
  if (!latest) return;
  if (code === 'KeyB' && (spec?.kind === 'live' || spectateBar.board.visible)) return void spectateBar.board.toggle();
  const action = binds.actionForEvent(e);
  if (!action) return;
  const slot = SLOT_ACTIONS.indexOf(action);
  if (slot >= 0) castSlot(slot);
  else if (action === 'nextTarget') cycleTarget(e.shiftKey ? -1 : 1);
  else if (action === 'prevTarget') cycleTarget(-1);
  else if (action === 'autoAttack') {
    if (spec || !autoEnabled) return;
    const me = latest.units.find((u) => u.id === you);
    send({ t: 'auto', on: !me?.autoAttack });
  }
};

// ------------------------------------------------------------------ frame loop

const lobbyTags = new LobbyTags();
let lastT = performance.now();
let acc = 0;

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, (now - lastT) / 1000);
  lastT = now;

  if (!latest && spec) {
    // waiting for the first frame of a live match (it arrives 5 s late)
    vis.yaw = controls.yaw;
    scene.setPhase('prep');
    scene.update([], 0, null);
    scene.setCamera(0, 0, controls.yaw, 0.6, 30);
    scene.render();
    return;
  }
  if (latest || spec) lobbyTags.hide();
  if (!latest) {
    // Menu backdrop: the chosen class idles in the arena and sways gently towards the camera.
    const t = now / 1000;
    // preview the arena picked in the menu (random shows the last one)
    const previewMap = mainMenu.selectedMap;
    if (previewMap !== 'random') scene.setMap(previewMap);
    const prev = ARENAS.find((a) => a.id === (previewMap === 'random' ? arena.id : previewMap)) ?? ARENAS[0];
    const spot = prev.spawns[0][0];
    // drag on the empty middle of the menu to turn your character; the idle sway fades out while you do and comes back after
    const sway = lobbySpin.dragX !== null ? 0 : Math.min(1, Math.max(0, (now - lobbySpin.at - 2500) / 2000));
    const face = prev.spawnFacing[0] + Math.PI + lobbySpin.yaw + Math.sin(t * 0.6) * 0.55 * sway;
    scene.setPhase('prep');
    // party members stand beside you with the class, weapon and skins they picked
    const me = accountUi.account?.name;
    const mates = (mainMenu.currentParty?.members ?? []).filter((m) => m.name !== me && m.classId && CLASSES[m.classId as ClassId]);
    const f0 = prev.spawnFacing[0];
    const right = { x: Math.cos(f0), z: -Math.sin(f0) };
    const slot = (i: number) => (i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 2.4);
    const menuUnits: RenderUnit[] = [{ id: -1, classId: mainMenu.selectedClass, look: gearLook(mainMenu.currentBuild.gear), weapon: weaponFor(mainMenu.selectedClass, mainMenu.currentBuild.spec), team: 0, x: spot.x + right.x * slot(0), z: spot.z + right.z * slot(0), y: 0, facing: face, alive: true, stealthed: false, casting: false, sheep: false }];
    mates.forEach((m, i) => {
      const o = slot(i + 1);
      menuUnits.push({ id: -2 - i, classId: m.classId as ClassId, look: m.look ?? '', weapon: weaponFor(m.classId as ClassId, m.spec), team: 0, x: spot.x + right.x * o, z: spot.z + right.z * o, y: 0, facing: f0 + Math.PI + Math.sin(t * 0.6 + i + 1) * 0.55, alive: true, stealthed: false, casting: false, sheep: false });
    });
    scene.update(menuUnits, 0, null);
    scene.setCamera(spot.x, spot.z, f0 + Math.sin(t * 0.6) * 0.1, 0.12, mates.length ? 9.5 : 6.5);
    // everyone in the party: their model's name tag with a check once ready (the leader is always ready)
    const party = mainMenu.currentParty;
    if (party && me) {
      const placed = [{ name: me, x: menuUnits[0].x, z: menuUnits[0].z }, ...mates.map((m, i) => ({ name: m.name, x: menuUnits[i + 1].x, z: menuUnits[i + 1].z }))];
      lobbyTags.show(party, placed, (x, y, z) => scene.project(x, y, z));
    } else lobbyTags.hide();
    scene.render();
    return;
  }

  if (spec?.runner && !spec.paused && !spec.runner.done) {
    spec.clock += dt * 1000 * spec.rate;
    const evs: Parameters<Hud['event']>[0][] = [];
    let n = 0;
    while (spec.clock >= TUNING.tickMs && !spec.runner.done) {
      spec.clock -= TUNING.tickMs;
      evs.push(...spec.runner.step());
      n++;
    }
    if (n) onSnapshot(spec.runner.snapshot(), evs);
  }

  acc += dt;
  while (acc >= DT) {
    acc -= DT;
    fixedStep();
  }

  flushQueue();
  const snap = latest!;
  const rate = !spec ? 1 : spec.paused || (spec.runner?.done ?? false) ? 0 : spec.rate;
  const estNow = snap.time + (performance.now() - latestAt) * rate;
  scene.viewLevel = predLevel;
  const interp = interpolate(estNow - (rate > 0 ? Math.max(INTERP_DELAY_MS * rate, 60) : 0));
  if (spec) targetId = snap.units.find((u) => u.id === you)?.target ?? null;

  // our own unit: interpolate between the last two 20 Hz predictions, then ease towards that (hides corrections too)
  {
    const alpha = Math.min(1, Math.max(0, acc / DT));
    const meNow0 = spec ? undefined : snap.units.find((u) => u.id === you);
    let tx = prevPred.x + (pred.x - prevPred.x) * alpha;
    let tz = prevPred.z + (pred.z - prevPred.z) * alpha;
    if (spec) {
      // watching: the camera follows the interpolated server position of the followed unit
      const f = interp.get(you);
      if (f) {
        tx = f.x;
        tz = f.z;
        vis.facing = f.facing;
      }
    }
    if (!vis.ready || Math.hypot(tx - vis.x, tz - vis.z) > 4) {
      vis.x = tx;
      vis.z = tz;
      vis.ready = true;
    } else {
      // while stunned, feared or polymorphed the server is moving us, so the camera anchor is damped heavily and the view stays steady
      const held = !spec && !!meNow0?.alive && meNow0.controlled;
      const k = 1 - Math.exp(-dt * (held ? 5 : 38));
      vis.x += (tx - vis.x) * k;
      vis.z += (tz - vis.z) * k;
    }
    // the model only turns with the mouse while we can act; under crowd control it shows what the server says
    if (!spec) vis.facing = lerpAngle(vis.facing, meNow0?.alive && meNow0.controlled ? meNow0.facing : controls.facing, 1 - Math.exp(-dt * 16));
    // camera: a touch of ease on orbit and zoom so it glides
    vis.yaw = lerpAngle(vis.yaw, controls.yaw, 1 - Math.exp(-dt * 32));
    vis.pitch += (controls.pitch - vis.pitch) * (1 - Math.exp(-dt * 32));
    vis.dist += (controls.dist - vis.dist) * (1 - Math.exp(-dt * 10));
  }

  const units: RenderUnit[] = snap.units.map((u) => {
    let x = u.x;
    let z = u.z;
    let facing = u.facing;
    let y = u.y;
    const i = interp.get(u.id);
    if (i) ({ x, z, y, facing } = i);
    if (!spec && u.id === you) {
      x = vis.x;
      z = vis.z;
      facing = vis.facing;
      y = u.alive ? ownHeight(u, i?.y) : 0; // a leap's arc comes from the server, a jump is predicted here
    }
    return { id: u.id, classId: u.classId, look: u.look, weapon: weaponFor(u.classId, u.spec), team: u.team, x, z, y, lv: u.id === you && !spec ? predLevel : (u.lv ?? 0), facing, alive: u.alive, stealthed: u.stealthed, casting: !!snap.units.find((x) => x.id === u.id)?.cast, sheep: !!snap.units.find((x) => x.id === u.id)?.auras.some((a) => a.id === 'polymorph') };
  });

  renderPos.clear();
  for (const u of units) renderPos.set(u.id, { x: u.x, z: u.z, facing: u.facing });

  scene.setPhase(snap.phase);
  scene.followId = spec ? -99 : you;
  scene.teamRings = snap.units.length > 2;
  scene.update(units, team, targetId);
  effects.setZones(snap.zones ?? [], estNow);
  effects.update(
    dt,
    snap.units.map((s) => {
      const p = renderPos.get(s.id)!;
      return { id: s.id, x: p.x, z: p.z, facing: p.facing, alive: s.alive, auras: s.auras.map((a) => a.id) };
    }),
  );
  scene.setCamera(vis.x, vis.z, vis.yaw, vis.pitch, vis.dist < 0.3 ? 0 : vis.dist, ((spec ? interp.get(you)?.y ?? 0 : ownHeight(latest?.units.find((x) => x.id === you), interp.get(you)?.y)) * 0.45) + (camFloor.y = fallToward(camFloor.y, heightAt(arena, vis.x, vis.z, predLevel), dt, camFloor)));
  {
    // aimed spells (Flamestrike, Blizzard): show where they would land
    const meNow = snap.units.find((u) => u.id === you);
    if (aiming && (spec || !meNow?.alive || meNow.controlled)) setAiming(null); // casting something else keeps the aim: it is placed into the queue
    const aimed = !spec && aiming ? ABILITIES[aiming] : undefined;
    const g = aimed ? groundAim(aimed.range) : null;
    const r = aimed?.effects.find((e) => e.type === 'zone');
    scene.setReticle(g && snap.units.find((u) => u.id === you)?.alive ? g : null, r && r.type === 'zone' ? r.radius : 5, !g || hasLOS({ x: pred.x, z: pred.z }, g, arena, predLevel, aimLevel(g), jumpHeight(performance.now() - myJumpAt)));
  }
  if (spec) spectateBar.update(snap.tick, snap.units.find((u) => u.id === you)?.name ?? '');
  // countdown ticks before the gates open, and our own footsteps
  if (snap.phase === 'prep') {
    const left = Math.ceil((snap.phaseEndsAt - estNow) / 1000);
    if (left >= 1 && left <= 3 && left !== lastCount) audio.countdown(left);
    lastCount = left;
  } else lastCount = -1;
  {
    const me = snap.units.find((u) => u.id === you);
    const moved = Math.hypot(vis.x - lastStepPos.x, vis.z - lastStepPos.z);
    lastStepPos.x = vis.x;
    lastStepPos.z = vis.z;
    const inAir = (interp.get(you)?.y ?? 0) >= 0.15;
    if (me?.alive && !spec && moved < 3 && !inAir) {
      stepAcc += moved;
      if (stepAcc > 2.3) {
        stepAcc = 0;
        audio.footstep(arena.theme);
      }
    }
    if (wasAir && !inAir && me?.alive && !spec) audio.jumpLand();
    wasAir = inAir;
    audio.lowHealth(me && me.maxHealth > 0 ? me.health / me.maxHealth : 1, !!me?.alive && !spec);
  }
  scene.render(); // render first so projection uses this frame's camera

  if (!spec && targetId !== null && inEnemySmoke()) setTarget(null); // smoke takes your target away
  const shown = shownBar();
  if (shown.join() !== shownKey) {
    shownKey = shown.join();
    hud.setBar(classId, shown);
    relabel();
  }
  hud.autoEnabled = autoEnabled;
  hud.update({ snap, now: estNow, you, targetId });
  hud.nameplates(
    units.map((u) => {
      const s = scene.project(u.x, 2.7 + u.y, u.z);
      const meta = snap.units.find((x) => x.id === u.id)!;
      return { id: u.id, x: s.x, y: s.y, visible: s.visible, name: meta.name, health: meta.health, maxHealth: meta.maxHealth, enemy: u.team !== team, alive: u.alive, cast: meta.cast ? { ability: meta.cast.ability, start: meta.cast.start, end: meta.cast.end } : null, auras: meta.auras, absorb: meta.absorb };
    }),
    estNow,
  );
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------ watching: live matches and replays

const spectateBar = new SpectateBar({
  switchKey: () => binds.label('nextTarget'),
  onExit: () => {
    if (spec?.kind === 'live') send({ t: 'leave' });
    exitSpectate();
  },
  onPause: (p) => {
    if (spec) spec.paused = p;
  },
  onRate: (r) => {
    if (spec) spec.rate = r;
  },
  onSeek: (tick) => {
    if (!spec?.runner) return;
    spec.runner.seek(tick);
    snaps.length = 0;
    onSnapshot(spec.runner.snapshot(), []);
  },
});
const livePicker = new LivePicker(
  (id) => send({ t: 'spectate', id }),
  () => send({ t: 'live' }),
  () => !!accountUi.account,
  () => accountUi.openAuth(),
);

function startSpectate(kind: 'live' | 'replay', mapId: string, id?: string, runner?: ReplayRunner) {
  clearMenuLayers();
  spec = { kind, runner, id, rate: 1, paused: false, clock: 0 };
  arena = ARENAS.find((a) => a.id === mapId) ?? ARENAS[0];
  scene.setMap(arena.id);
  audio.ambience(arena.theme);
  you = 0;
  team = 0;
  latest = null;
  snaps.length = 0;
  pending = [];
  targetId = null;
  vis.ready = false;
  controls.yaw = controls.facing = arena.spawnFacing[0];
  vis.facing = vis.yaw = controls.yaw;
  vis.pitch = controls.pitch;
  vis.dist = controls.dist;
  livePicker.close();
  hud.show(true);
  hudLayout.refit();
  mainMenu.show(false);
  joinMsg('');
  document.body.classList.add('spectating');
  if (kind === 'replay' && runner) {
    hud.setRoster(runner.data.roster);
    const names = runner.data.units.map((u) => u.name);
    spectateBar.showReplay(runner.data.ticks, `${mapName(runner.data.arena)} · ${names.join(', ')}`, `${location.origin}/?replay=${id}`);
    onSnapshot(runner.snapshot(), []);
  } else spectateBar.showLive();
}

function setFollow(id: number, snap: Snapshot | null) {
  const u = snap?.units.find((x) => x.id === id);
  if (!u) return;
  you = id;
  team = u.team;
  classId = u.classId;
  bar = u.bar ?? specOf(u.classId, u.spec ?? '')?.bar ?? CLASSES[u.classId].bar;
  hud.setBar(classId, bar);
  shownKey = '';
  relabel();
  vis.ready = false;
}

function cycleFollow(dir: 1 | -1) {
  if (!latest) return;
  const all = [...latest.units].sort((a, b) => a.id - b.id);
  const i = all.findIndex((u) => u.id === you);
  const next = all[(i + dir + all.length) % all.length];
  if (next) setFollow(next.id, latest);
}

function endSpectateState() {
  if (!spec) return;
  spec = null;
  spectateBar.hide();
  document.body.classList.remove('spectating');
  you = 0;
}

function exitSpectate() {
  audio.stopAmbience();
  endSpectateState();
  latest = null;
  hud.show(false);
  hud.setRoster([]);
  menu.close();
  mainMenu.show(true);
  mainMenu.refresh();
}

async function startReplay(id: string) {
  joinMsg('Loading replay…');
  try {
    const data = await loadReplay(id);
    startSpectate('replay', data.arena, id, new ReplayRunner(data));
  } catch (e) {
    joinMsg((e as Error).message);
    mainMenu.show(true);
  }
}

async function openLive() {
  if (!accountUi.account) return livePicker.show([]);
  if (!(await connect())) return joinMsg('Could not reach the server.');
  livePicker.show(null);
  send({ t: 'live' });
}

// ------------------------------------------------------------------ main menu

loadProfile();
setTipProgress(progress.matches);
installTips();
initTooltips();
{
  // the Detailed tooltips key works everywhere (menu and match), so it keeps its own record of held keys
  const held = new Set<string>();
  window.addEventListener('keydown', (e) => {
    held.add(e.code);
    if (e.code.startsWith('Alt') && binds.matches('detail', e)) e.preventDefault(); // Alt would otherwise focus the browser menu
  });
  window.addEventListener('keyup', (e) => held.delete(e.code));
  window.addEventListener('blur', () => held.clear());
  setDetailKey(() => binds.isHeld('detail', held));
}

function joinMsg(text: string) {
  mainMenu.setMessage(text);
}

/** Open the socket (once) and resolve true when it is usable. A saved session is resumed on every open. */
let connecting: Promise<boolean> | null = null;
/**
 * Signed in, you stay connected even at the menu: friends see you online and can invite you. Leaving a match closes the
 * socket, so without this a friend who just finished a match showed as offline until they refreshed.
 */
let reconnectDelay = 1000;
let reconnectTimer = 0;
function keepPresence() {
  window.clearTimeout(reconnectTimer);
  if (!accountUi.account) return;
  reconnectTimer = window.setTimeout(() => {
    if (!accountUi.account || (ws && ws.readyState <= WebSocket.OPEN)) return;
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    void connect();
  }, reconnectDelay);
}

function connect(): Promise<boolean> {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(true);
  if (connecting && ws && ws.readyState === WebSocket.CONNECTING) return connecting;
  connecting = new Promise<boolean>((resolve) => {
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws = sock;
    sock.onopen = () => {
      reconnectDelay = 1000;
      accountUi.resume();
      resolve(true);
    };
    sock.onmessage = onMessage;
    sock.onclose = () => {
      resolve(false);
      if (ws !== sock) return;
      ws = null;
      audio.stopAmbience();
      const inMatch = !!latest && !spec;
      if (spec?.kind === 'live') endSpectateState();
      // the end screen (Ready / Leave and the scoreboard) belongs to the match that is gone
      endChoice.hide();
      endBoardUp = false;
      spectateBar.board.toggle(false);
      hud.show(false);
      hud.setRoster([]);
      latest = null;
      menu.close();
      mainMenu.show(true);
      mainMenu.refresh();
      // an idle socket dropping at the menu is silent; it reconnects when needed
      if (inMatch || leaving) joinMsg(leaving ? 'You left the match.' : 'Disconnected from server.');
      leaving = false;
      keepPresence();
    };
  });
  return connecting;
}

async function play(req: PlayRequest) {
  classId = req.classId;
  myBuild = req.build;
  endChoice.hide();
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
    req.mode === 'party'
      ? { t: 'join', name: req.name, classId: req.classId, map: req.map, mode: 'party', size: req.size, difficulty: req.difficulty, build: myBuild, profile }
      : req.mode === 'practice'
      ? { t: 'join', name: req.name, classId: req.classId, map: req.map, mode: 'practice', size: req.size, foes: req.foes, allies: req.allies, difficulty: req.difficulty, build: myBuild, profile }
      : { t: 'join', name: req.name, classId: req.classId, map: req.map, mode: 'queue', size: req.size, build: myBuild, profile };
  send(msg);
}

/** In a party: tell the others which class, spec and skins you have picked, so they see your model in the lobby. Only sent when it differs from what the party already shows. */
function sendLook() {
  const party = mainMenu.currentParty;
  const me = accountUi.account?.name;
  if (!party || !me) return;
  const mine = party.members.find((m) => m.name === me);
  const b = mainMenu.currentBuild;
  const look = gearLook(b.gear);
  if (mine && mine.classId === mainMenu.selectedClass && mine.spec === b.spec && (mine.look ?? '') === look) return;
  send({ t: 'party_look', classId: mainMenu.selectedClass, build: b });
}

function sendReady(on: boolean) {
  classId = mainMenu.selectedClass;
  myBuild = mainMenu.currentBuild;
  const profile = accountUi.account ? undefined : progress.token || undefined;
  send({ t: 'ready', on, name: accountUi.account?.name ?? 'Player', classId: mainMenu.selectedClass, build: mainMenu.currentBuild, profile });
}

const settingsSync = new SettingsSync((data) => send({ t: 'save_settings', data }));
const accountUi = new AccountUi({
  onReplay: (id) => void startReplay(id),
  send: (m) => {
    if (ws && ws.readyState === WebSocket.OPEN) send(m);
    else void connect().then((ok) => (ok ? send(m) : accountUi.fail('Could not reach the server.')));
  },
  onAccount: (a) => {
    flags.owner = a?.role === 'owner';
    friendsUi.setAccount(a?.name ?? null);
    paintHeader();
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

const friendsUi = new FriendsUi({
  send: (m) => {
    if (ws && ws.readyState === WebSocket.OPEN) send(m);
    else void connect().then((ok) => ok && send(m));
  },
  signedIn: () => !!accountUi.account,
  needSignIn: () => accountUi.openAuth(),
  onParty: (p) => {
    mainMenu.setParty(p);
    sendLook();
  },
});
const suggestUi = new SuggestUi({ send: (m) => send(m), isOwner: () => !!accountUi.account?.ownerOk, signedIn: () => !!accountUi.account, needSignIn: () => accountUi.openAuth() });
const menuExtras = document.createElement('div');
menuExtras.className = 'menu-extras';
const header = buildHeaderBar([
  { icon: 'profile', label: 'Profile', onClick: () => (accountUi.account ? accountUi.openProfile() : accountUi.openAuth()) },
  { icon: 'friends', label: 'Friends and party', onClick: () => friendsUi.openOrSignIn(), badge: friendsUi.badge },
  { icon: 'patches', label: 'Patch notes', onClick: () => mainMenu.openPatches() },
  { icon: 'watch', label: 'Watch live matches', onClick: () => void openLive() },
  { icon: 'suggest', label: 'Suggestions', onClick: () => suggestUi.open() },
]);
const paintHeader = () => {
  const a = accountUi.account;
  const b = header.buttons.profile;
  b.title = a ? `Profile · ${a.name}` : 'Sign in or register';
  b.classList.toggle('hdr-signin', !a);
};
paintHeader();
menuExtras.append(header.root, friendsUi.partyChip);

/** Both friends agreed to a duel: join it with the class and build currently picked in the menu. */
async function joinDuel(withName: string) {
  // the duel is played with what is picked in the menu now: tooltips and the bar must describe that, not the last match's build
  classId = mainMenu.selectedClass;
  myBuild = mainMenu.currentBuild;
  joinMsg('Waiting for your friend…');
  if (!(await connect())) return joinMsg('Could not reach the server.');
  send({ t: 'join', name: accountUi.account?.name ?? 'Player', classId, map: 'random', mode: 'duel', duelWith: withName, size: 1, build: myBuild });
}

const mainMenu = new MainMenu(document.getElementById('join')!, {
  onPlay: play,
  onControls: () => menu.open(false, 'keys'),
  onEditHud: editHudFromMenu,
  onWatch: () => void openLive(),
  slotKey: (n) => binds.label(`slot${n}` as Action),
  onSelect: (c, b) => {
    setTipBuild(c, b);
    // a ready party member who changes class or build keeps their ready mark with the new setup
    if (mainMenu.ready) sendReady(true);
    sendLook();
  },
  onReady: (on) => sendReady(on),
  onSide: (side) => send({ t: 'party_side', side }),
  extras: menuExtras,
});
for (const p of [accountUi.popup, friendsUi.popup, suggestUi.popup, livePicker.popup, ...mainMenu.popups]) registerPopup(p);

const replayParam = new URLSearchParams(location.search).get('replay');
if (replayParam && /^[0-9a-f]{12,16}$/.test(replayParam)) void startReplay(replayParam);
else accountUi.promptIfNew();
if (accountUi.token) void connect();
setTipBuild(mainMenu.selectedClass, mainMenu.currentBuild);
// sound controls: mute button and the three volume sliders in the Esc menu
{
  const muteBtn = document.getElementById('mute-btn') as HTMLButtonElement;
  const paint = () => (muteBtn.textContent = audio.isMuted ? '🔇' : '🔊');
  muteBtn.addEventListener('click', () => audio.setMuted(!audio.isMuted));
  audio.onMute = paint;
  paint();
  for (const kind of ['master', 'sfx', 'amb'] as const) {
    const input = document.getElementById(`vol-${kind}`) as HTMLInputElement;
    const label = document.getElementById(`vol-${kind}-val`)!;
    input.value = String(audio.volumes[kind]);
    const show = () => (label.textContent = `${Math.round(Number(input.value) * 100)}%`);
    input.addEventListener('input', () => {
      audio.setVolume(kind, Number(input.value));
      if (audio.isMuted) audio.setMuted(false);
      show();
    });
    show();
  }
}
const verEl = document.getElementById('ver');
if (verEl) verEl.textContent = `v${pkg.version}`;
