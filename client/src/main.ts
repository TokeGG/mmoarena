import { tours } from './tour'; // first: its key listener must run before every other one (see tour.ts)
import { helpWindow } from './tourUi';
import { hasPower, ABILITIES, AURAS, ARENAS, arenaById, registerCustomArenas, setDisabledMaps, lockedByAura, silencedBy, hasLOS, heightAt, onRaised, stepMovementL, CLASSES, ReplayRunner, canStartJump, jumpHeight, PROTOCOL_VERSION, SnapMerger, TUNING, barFor, clampToGate, gearLook, specOf, weaponFor, fxNum, } from '@arena/shared';
import type { ArenaDef, Build, ClassId, DevPageId, ClientMsg, MoveInput, ServerMsg, Snapshot, TeamId, UnitBuild, UnitSnap } from '@arena/shared';
import pkg from '../package.json';
import { UpdateNotice } from './updateNotice';
import { ArenaScene, fallToward } from './scene';
import { menuSpots } from './lobbySpot';
import { preloadRiggedModels } from './riggedModels';
import type { RenderUnit } from './scene';
import { Controls } from './input';
import { Hud } from './hud';
import { Keybinds, MARK_ACTIONS, SLOT_ACTIONS } from './keybinds';
import type { Action } from './keybinds';
import { Menu } from './menu';
import { Effects } from './effects';
import { HudLayout } from './hudLayout';
import { MainMenu, patchBadgeEl } from './mainMenu';
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
import { badgeText, liveCount } from './counts';
import { LobbyTags } from './lobbyTags';
import { Audio } from './audio';
import { soundHooks } from './soundsUi';
import { applyModelData } from './modelData';
import type { Spatial } from './audio';
import { BuildsPanel, LivePicker, SpectateBar, loadReplay, mapName } from './spectate';
import { TakeoverUi } from './takeoverUi';
import { DataLayers, DevPanel } from './devPanel';
import { AdminPanel, adminAccessOf } from './adminPanel';
import type { Tab as AdminTab } from './adminPanel';
import { ToolsWindow } from './toolsWindow';
import { designer } from './designer';
import { AnnounceBanner } from './announce';
import { KillFeed } from './killfeed';
import { DpsMeter, METRICS } from './dpsMeter';
import { look, setLook } from './hudLook';
import type { MeterMetric, MeterNumbers, MeterWho } from './dpsMeter';
import { Recap } from './recap';
import { botTests } from './botTestState';
import { handleNoteAck, noteBox } from './botNoteUi';
import { RecapCard } from './recapCard';
import { MarkPicker } from './markPicker';
import { closeAllPopups, registerPopup } from './popups';
import { initCursors, refreshCursor } from './cursors';
import { NetClock } from './netClock';
import { DashTracker, anchorBlend, anchorSnaps } from './dashPath';
import { IntervalTracker, InterpDelay, LEAD_EXTRAPOLATE_MS, Lead, RenderTime, poseAt } from './interpDelay';
import type { Pose } from './interpDelay';
import { NetStats, NetStatsView } from './netStats';
import { ownAhead } from './ownAhead';
import { anchorWorldY, plateKind } from './nameplateLayout';
import { plateProfile } from './nameplateStore';

/** Milliseconds per server tick: the server says so in `welcome` (a replay uses the tick length it was recorded at); prediction, the input cadence and the snapshot buffer all follow it. */
let tickMs: number = TUNING.tickMs;
let DT = tickMs / 1000;
/** The match is paused (dev tools): from the last snapshot's flag (what is drawn) and from dev_state (what is sent). */
let devPaused = false;
function setTickMs(ms: number | undefined): void {
  tickMs = Number.isFinite(ms) && ms! >= 4 && ms! <= 100 ? Math.round(ms!) : TUNING.tickMs;
  DT = tickMs / 1000;
  netStats.tickMs = tickMs;
}
/** Smoothed server clock, snapshot interval and the adaptive delay other players are drawn in the past by (see netClock.ts, interpDelay.ts). */
const netClock = new NetClock();
/** Rebuilds full units from the slim snapshots of the player's own feed (identity arrives once, then only on change). */
const merger = new SnapMerger();
const snapInterval = new IntervalTracker();
const interpDelay = new InterpDelay();
/** Our own Charge or Heroic Leap: drawn along the snapshot timeline instead of the 20 Hz prediction (see dashPath.ts). */
const dash = new DashTracker();
let ownDashing = false;
/** Units in the air from a Heroic Leap (their arc height is scaled by the Animations page). */
const leaping = new Set<number>();
const renderTime = new RenderTime();
/** Other players are drawn this far ahead of the buffered time (dead reckoning along their last movement), so two screens agree on where each stands. */
const lead = new Lead();
const netStats = new NetStats();
const netView = new NetStatsView();
let showNetStats = false;
/** The server time of the world drawn in the last frame (what a cast's `vt` reports), and when that frame was drawn. */
const drawn = { rt: 0, at: -1e9 };

const audio = new Audio();
applyModelData(); // the Models page's numbers (shared/data/models.json) over the model registry
soundHooks.preview = (id, file) => audio.preview(id, file); // the Sounds page of the dev panel plays through the game's own engine
const canvas = document.getElementById('c') as HTMLCanvasElement;
const scene = new ArenaScene(canvas);
void preloadRiggedModels(); // skinned character models load in the background; until then (or if one fails) the procedural models are used
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
/** A match was joined and its first snapshot has not arrived yet. */
let matchStarting = false;
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
  box.id = 'endchoice'; // a HUD element (hudLayout.ts)
  box.style.cssText = 'position:fixed;left:50%;bottom:9%;transform:translateX(-50%);display:none;flex-direction:column;align-items:center;gap:10px;z-index:60;';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:14px;';
  const status = document.createElement('div');
  status.style.cssText = 'color:#fff;font-weight:600;text-shadow:0 1px 4px #000;';
  const mk = (label: string, primary: boolean) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = `ec-btn${primary ? ' ec-primary' : ''}`; // styled in index.html (hudSkin.ts changes it)
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
const killFeed = new KillFeed();
const dpsMeter = new DpsMeter();
// click the meter's header to show the next thing (damage, healing, damage taken, interrupts...); the Look window and Edit HUD set all of it
dpsMeter.onCycle = () => {
  const i = METRICS.findIndex((m) => m.id === look.dpsMetric);
  setLook('dpsMetric', METRICS[(i + 1) % METRICS.length].id);
};
const recap = new Recap();
const recapCard = new RecapCard();
let recapPhase = '';
/** False once a replay was scrubbed: its counts no longer cover the whole match. */
let recapExact = true;
/** The recap card for the end of the match, titled like the scoreboard. */
function showRecap(snap: Snapshot) {
  if (!recapExact) return;
  const w = snap.winner;
  const mine = snap.units.find((u) => u.id === you)?.team;
  recapCard.show(recap, w === undefined || w === null ? 'Match over' : w === 'draw' ? 'Draw' : spec || mine === undefined ? `Team ${Number(w) + 1} wins` : w === mine ? 'Victory' : 'Defeat', spec ? null : team, botTests.match && botTests.bots > 0 && isDev() ? noteBox(botTests.match, send) : null);
}
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

/** Where each model is drawn: ground position, the height of its feet (floor plus jump or levitation) and facing. */
const renderPos = new Map<number, { x: number; y: number; z: number; facing: number }>();
const effects = new Effects(scene.scene, (id) => renderPos.get(id) ?? null);
effects.groundY = (x, z) => heightAt(arena, x, z, predLevel);
effects.camera = scene.camera;
effects.onSwing = (id, fast) => scene.swing(id, fast);
effects.onShout = (id) => scene.shout(id);
effects.onHit = (id) => scene.flash(id);

let barSpec: string | null = null;
/** The bar as the server built it (before you reordered it) and the build it came from, to notice a dev changing your class or talents mid-match. */
let baseBar = '';
let ownBuildKey = '';
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
    if (controlling) {
      send({ t: 'admin_release' }); // a bot plays it again and you go on watching; the others' match is not left
      return;
    }
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
  onBrightness: (v) => scene.setBrightness(v),
  onAutoAttack: (enabled) => {
    autoEnabled = enabled;
    send({ t: 'autoOff', off: !enabled });
  },
  onNetStats: (on) => (showNetStats = on),
  onEditHud: () => (latest ? hudLayout.start() : editHudFromMenu()),
  onHelp: () => helpWindow.open(),
});
const hudLayout = new HudLayout();
// the owner's part of the editor: who is the owner, and sending the layout to the server as the default for everyone
hudLayout.isOwner = () => !!accountUi.account?.ownerOk;
hudLayout.publish = (layout) => void send({ t: 'admin_hud_default', layout });
// the HUD editor opened from the main menu (over a pretend fight) is tracked by the editor itself (hudEditState.ts)
hudLayout.onChange = (editing, restoreMenu) => {
  controls.enabled = !editing;
  if (editing) controls.releaseAll();
  if (!editing) {
    document.body.classList.remove('hud-demo');
  }
  if (!editing && restoreMenu) {
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
  hudLayout.stop(true); // the editor must not bring the menu back over the match that is starting
  document.body.classList.remove('hud-demo');
}

/** Edit the HUD before a match: show it filled with a pretend fight, over the menu's 3D backdrop. */
function editHudFromMenu() {
  document.body.classList.add('hud-demo');
  const c = mainMenu.selectedClass;
  mainMenu.show(false);
  hud.demo(c, barFor(c, mainMenu.currentBuild, CLASSES[c].bar));
  relabel();
  hud.show(true);
  hudLayout.refit();
  hudLayout.start(true);
}
let leaving = false;
const relabel = () => {
  hud.setKeyLabels([...SLOT_ACTIONS, 'trinket' as const].map((a) => binds.label(a)));
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
    case 'controlling':
      botTests.clear();
      clearMenuLayers();
      if (m.t === 'controlling' && !m.mind) {
        // owner only: the watched match turns into a normal match for the unit just taken over (no delay, no spectator bar)
        if (spec) {
          spec = null;
          spectateBar.hide();
          document.body.classList.remove('spectating');
        }
        resetRecap();
        controlling = true;
        syncTarget = true;
      }
      endChoice.hide();
      endBoardUp = false;
      spectateBar.board.toggle(false);
      if (m.protocol !== PROTOCOL_VERSION) {
        joinMsg('Client is out of date. Refresh the page.');
        ws?.close();
        return;
      }
      arena = arenaById(m.map);
      scene.setMap(arena.id);
      if (!(m.t === 'controlling' && m.mind)) mindDriving = false;
      matchStarting = true; // until its first snapshot, the menu backdrop must not swap the map back to the menu's pick
      // dev tools start fresh in every match (test numbers never carry over), and so do raid marks
      devPanel.setAvailable(false);
      teamMarks = new Map();
      markPicker.hide();
      buildsPanel.clear();
      lastBuilds = [];
      buildsAsked = false;
      if (isDev()) devPanel.setAvailable(true);
      audio.ambience(arena.theme);
      setTickMs(m.tickMs);
      devPaused = false;
      wasPausedSnap = false;
      interpDelay.reset(tickMs);
      you = m.unitId;
      team = m.team;
      classId = m.classId;
      send({ t: 'autoOff', off: !autoEnabled });
      barSpec = m.spec ?? myBuild.spec ?? null;
      bar = applyOrder(m.bar ?? specOf(classId, m.spec ?? '')?.bar ?? CLASSES[classId].bar, loadOrder(classId, barSpec));
      baseBar = (m.bar ?? specOf(classId, m.spec ?? '')?.bar ?? CLASSES[classId].bar).join();
      ownBuildKey = '';
      setTipBuild(classId, myBuild);
      latest = null;
      snaps.length = 0;
      netClock.reset(tickMs);
      lead.reset();
      renderTime.reset();
      snapInterval.reset(tickMs);
      netStats.reset();
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
      if (m.t === 'controlling' && m.mind) {
        // a priest took an enemy (or it ended): the screen follows that unit, the match goes on
        mindDriving = m.mind === 'control';
        hud.error(m.mind === 'control' ? `Mind Control: you play ${lastBuilds.find((u) => u.id === m.unitId)?.name ?? 'the enemy'}` : 'Mind Control ended');
      } else if (m.t === 'controlling') {
        devPanel.setAvailable(false); // nothing a pause or a patch would announce to the others
        takeoverUi.setControlling(lastBuilds.find((u) => u.id === m.unitId)?.name ?? 'a bot');
      }
      break;
    case 'account':
    case 'auth_error':
    case 'logged_out':
      if (m.t === 'logged_out') devPanel.handle({ t: 'dev_session', patches: [] }); // the server dropped the session numbers
    // falls through
    case 'leaderboard':
    case 'owner':
    case 'admin_accounts':
    case 'admin_result':
      accountUi.handle(m);
      adminPanel.handle(m);
      break;
    case 'botnames':
    case 'admin_log':
    case 'admin_history':
    case 'admin_feed':
    case 'admin_time':
    case 'admin_time_player':
      accountUi.handle(m);
      adminPanel.handle(m);
      break;
    case 'settings':
      if (!latest) settingsSync.onServer(m.data, accountUi.account?.name ?? 'default');
      tours.setSyncPending(false); // the seen-tours list rides along with the account's settings
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
    case 'marks':
      teamMarks = new Map(m.marks);
      break;
    case 'hud_default':
      hudLayout.setDefault(m.layout, m.at, m.by);
      break;
    case 'owner_log':
      mainMenu.showOwnerLog(m.rows, m.error);
      break;
    case 'custom_maps':
      // the owner's custom maps: known to every lookup from now on (menus, scene, minimap, watch labels)
      registerCustomArenas(m.maps);
      setDisabledMaps(m.off ?? []);
      mainMenu.refreshMaps();
      adminPanel.handle(m);
      break;
    case 'map_result':
      adminPanel.handle(m);
      break;
    case 'announce':
      announceBanner.show(m, () => audio.ui('select'));
      break;
    case 'duel_go':
      void joinDuel(m.with);
      break;
    case 'live':
      setBadge(liveBadge, liveCount(m.rows));
      // the menu asks for the count quietly every so often: the list only opens when the player asked for it or already has it open
      if (liveWanted || livePicker.popup.isOpen()) livePicker.show(m.rows);
      liveWanted = false;
      break;
    case 'spectating':
      botTests.clear();
      startSpectate('live', m.map, m.id);
      break;
    case 'bot_tests':
      // owner and devs only (the server sends nobody else this): which bots wear the learning-test marker
      botTests.handle(m);
      if (lastBuilds.length && (spec || isDev())) buildsPanel.set(lastBuilds);
      devPanel.refresh();
      break;
    case 'bot_note_ack':
      handleNoteAck(m);
      adminPanel.handle(m);
      break;
    case 'builds':
      lastBuilds = m.units;
      if (spec || isDev()) buildsPanel.set(m.units);
      if (controlling) takeoverUi.setControlling(m.units.find((u) => u.id === you)?.name ?? 'a bot');
      spectateBar.setPlayAs(!!spec && spec.kind === 'live' && !!accountUi.account?.ownerOk && m.units.some((u) => u.bot));
      devPanel.refresh();
      break;
    case 'overrides':
      dataLayers.setLive(m.patches);
      accountUi.handle(m);
      adminPanel.handle(m);
      devPanel.handle(m);
      break;
    case 'dev_map':
      swapMatchMap(m.map);
      devPanel.handle(m);
      break;
    case 'dev_state':
      if (!spec) {
        devPaused = m.paused;
        if (m.paused) pending = [];
        if (m.reset) resetNetState();
      }
      devPanel.handle(m);
      break;
    case 'dev_session':
    case 'dev_commits':
      devPanel.handle(m);
      break;
    case 'dev_chat':
    case 'dev_requests':
      designer.handle(m);
      adminPanel.handle(m);
      break;
    case 'dev_result':
      if (!m.ok && latest) hud.error(m.text); // a refusal is said where it is seen, not only in the panel
      devPanel.handle(m);
      designer.handle(m);
      accountUi.handle(m);
      adminPanel.handle(m);
      break;
    case 'admin_overview':
      accountUi.handle(m);
      adminPanel.handle(m);
      break;
    case 'following':
      following = m.name;
      followBox.set(m.name);
      if (!m.name) friendsUi.handle({ t: 'notice', text: 'Stopped following.' });
      break;
    case 'pong':
      netStats.rtt.add(performance.now() - m.n);
      netStats.serverLoad = m.load ?? 0;
      break;
    case 'profile':
      saveProfile(m.token, m.matches, m.wins);
      setTipProgress(m.matches);
      mainMenu.refresh();
      refreshCursor();
      break;
    case 'queued':
      joinMsg(`Waiting for players… ${m.waiting}/${m.needed}`);
      break;
    case 'snapshot':
      if (!spec && you === 0) break; // a late frame from a match we already left
      // a dev sees everyone's build in their own match too (asked once the bots are in)
      if (!spec && !buildsAsked && isDev()) {
        buildsAsked = true;
        send({ t: 'dev_builds' });
      }
      // a new round has started: the end scoreboard belongs to the end screen only
      if (endBoardUp && m.snap.phase !== 'ended') {
        endBoardUp = false;
        resetRecap();
        spectateBar.board.toggle(false);
        endChoice.hide();
      }
      onSnapshot(merger.merge(m.snap, m.info), m.events);
      break;
    case 'suggest_ack':
    case 'proposals':
    case 'train_status':
    case 'bot_knowledge':
      adminPanel.handle(m);
      break;
    case 'suggestions':
      suggestUi.handle(m);
      adminPanel.handle(m);
      break;
    case 'rematch':
      endChoice.update(m.ready, m.total, m.you);
      break;
    case 'stats':
      if (m.final) {
        // the match is over: the recap card is the end screen. The scoreboard only stands in when there is no exact recap (a scrubbed replay)
        const w = latest?.winner;
        const mine = latest?.units.find((u) => u.id === you)?.team;
        spectateBar.board.update(m.rows, w === undefined || w === null ? 'Match over' : w === 'draw' ? 'Draw' : spec || mine === undefined ? `Team ${Number(w) + 1} wins` : w === mine ? 'Victory' : 'Defeat');
        if (!recapExact) spectateBar.board.toggle(true);
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
      botTests.clear();
      controlling = false;
      takeoverUi.setControlling(null);
      matchStarting = false;
      resetRecap();
      devPanel.setAvailable(false);
      if (!spec) buildsPanel.clear();
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

/** Forget every position, speed and time estimate held for the world as it was (a resume after a pause, a restart, another map): the next snapshot is the new truth and nothing is carried across the gap. */
function resetNetState(): void {
  snaps.length = 0;
  netClock.reset(tickMs);
  renderTime.reset();
  snapInterval.reset(tickMs);
  interpDelay.reset(tickMs);
  lead.reset();
  dash.reset();
  leaping.clear();
  netStats.reset();
  pending = [];
  jumpTicks = 1e6;
  acc = 0;
  predLevel = 0;
  prevPred.x = pred.x;
  prevPred.z = pred.z;
  vis.ready = false; // the camera and the own model go straight to the next position
}
let wasPausedSnap = false;

/** You are playing an enemy you took with Mind Control: that unit is free in your hands, though its own player cannot act. */
let mindDriving = false;

function onSnapshot(snap: Snapshot, events: Parameters<Hud['event']>[0][]) {
  const at = performance.now();
  const own = snap.units.find((u) => u.id === you);
  if (own?.mcd && !mindDriving) own.controlled = true; // the player whose unit was taken cannot act
  // a resume: the server clock stood still for the whole pause, so the clock, the delay and every buffered snapshot are started afresh
  if (!spec && wasPausedSnap && !snap.paused) resetNetState();
  wasPausedSnap = !spec && !!snap.paused;
  snaps.push({ at, snap });
  if (snaps.length > Math.max(30, Math.ceil(1500 / tickMs))) snaps.shift(); // at least 1.5 s of snapshots at any tick length
  latest = snap;
  latestAt = at;
  if (!spec && !snap.paused) {
    netClock.sample(snap.time, at);
    snapInterval.add(snap.time);
    interpDelay.update(snapInterval.mean, netClock.latenessP95());
    netStats.snapshot(at, snap.tick);
    netStats.delayMs = interpDelay.delay;
  }
  devPanel.feed(events as never, snap.time);
  dpsMeter.feed(events, snap.time);
  if (spec && (!snap.units.some((u) => u.id === you) || you === 0)) {
    const first = snap.units.find((u) => u.team === 0) ?? snap.units[0];
    if (first) setFollow(first.id, snap);
  }

  const me = snap.units.find((u) => u.id === you);
  if (syncTarget && me) {
    syncTarget = false;
    targetId = me.target ?? null; // the bot's target carries over to the owner
  }
  if (me) {
    dash.sample(snap.time, me.x, me.z, me.controlled && me.alive, TUNING.runSpeed * (me.speedMult || 1));
    // Reconcile: start from the server's position, then replay inputs it has not processed yet.
    // While we can't act (stunned, feared, sheep) the server moves us, so glide from the last position to the new one;
    // otherwise the render position would swing back to where the crowd control began on every tick.
    if (me.controlled || hovers(me) || !me.alive) {
      prevPred.x = pred.x;
      prevPred.z = pred.z;
    }
    pred.x = me.x;
    pred.z = me.z;
    predLevel = me.lv ?? 0;
    if (snap.paused) {
      prevPred.x = pred.x; // standing still: no speed to carry the own model on with
      prevPred.z = pred.z;
      pending = [];
    }
    if (!vis.ready) {
      prevPred.x = vis.x = me.x;
      prevPred.z = vis.z = me.z;
    }
    while (pending.length && pending[0].seq <= me.lastSeq) pending.shift();
    if (me.alive && !me.controlled && !hovers(me) && !snap.paused) for (const i of pending) applyInput(i, me);
  }

  const ctx = {
    you,
    nameOf: (id: number) => snap.units.find((u) => u.id === id)?.name ?? (id === 0 ? 'Environment' : 'Someone'),
    project: (id: number) => {
      const p = renderPos.get(id);
      if (!p) return null;
      const s = scene.project(p.x, p.y + 2.2, p.z);
      return s.visible ? s : null;
    },
  };
  // the recap and kill feed start afresh with every round (the prep phase) and the card comes up when it ends
  if (snap.phase !== recapPhase) {
    if (snap.phase === 'prep') {
      recap.reset();
      killFeed.clear();
      dpsMeter.reset();
      recapCard.hide();
      recapExact = true;
    }
    // joined mid-match (live spectating): the counts miss the start
    else if (recapPhase === '') recapExact = false;
    recapPhase = snap.phase;
  }
  recap.setUnits(snap.units);
  dpsMeter.paint(snap.units, you, { metric: look.dpsMetric as MeterMetric, also: [look.dpsMetric2, look.dpsMetric3].filter((m) => m !== 'none') as MeterMetric[], who: look.dpsWho as MeterWho, numbers: look.dpsNumbers as MeterNumbers, rows: Number(look.dpsRows) || 5, friendly: spec ? 0 : team });
  const unitOf = (id: number) => snap.units.find((u) => u.id === id);
  for (const ev of events) {
    recap.add(ev);
    if (!(ev.t === 'death' && unitOf(ev.unit)?.img !== undefined)) killFeed.event(ev, unitOf, spec ? null : team);
    if (ev.t === 'phase' && ev.phase === 'ended') showRecap(snap);
    // a teleport behind someone turns you round: the camera comes with you
    if (ev.t === 'turn' && ev.unit === you && !spec) controls.yaw = controls.facing = ev.facing;
    hud.event(ev, ctx);
    if (ev.t === 'leap') leaping.add(ev.unit);
    else if (ev.t === 'leap_land' || ev.t === 'death') leaping.delete(ev.unit);
    effects.event(ev);
    if (ev.t === 'cast') scene.cast(ev.unit);
    // Mirror Image: an enemy that had the caster targeted loses the target (the server cleared its own side)
    if (ev.t === 'cast' && !spec && ev.unit === targetId && ABILITIES[ev.ability]?.effects.some((e) => e.type === 'dropTargets')) setTarget(null);
    audio.event(ev, you, team, spatial);
  }
}

/** How loud and where a unit's sound should be, from its distance and screen position relative to the camera. */
function spatial(id: number): Spatial | null {
  const p = renderPos.get(id);
  if (!p) return { gain: 0.6, pan: 0 };
  const dist = Math.hypot(p.x - vis.x, p.z - vis.z);
  if (dist > 60) return null;
  const s = scene.project(p.x, p.y + 1.5, p.z);
  const pan = s.visible ? Math.max(-1, Math.min(1, (s.x / window.innerWidth - 0.5) * 2)) * 0.7 : 0;
  return { gain: Math.max(0.12, 1 - dist / 55) * (s.visible ? 1 : 0.6) * (id === you ? 1.1 : 1), pan };
}

// ------------------------------------------------------------------ movement prediction

/** Hovering (Ascend to the Heavens) holds you in place without taking your hands: you can cast, you cannot walk or jump. */
const hovers = (u: { auras: { id: string }[]; cast?: { ability: string } | null }): boolean => u.auras.some((a) => AURAS[a.id]?.hover) || !!(u.cast && ABILITIES[u.cast.ability]?.channel?.hold); // a channel that holds you (Slice and Dice) keeps you where you stand

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

/** A leaping unit's height with the Animations page's arc scale (a picture change only: the server's landing is unchanged). */
function leapArc(id: number, y: number): number {
  return leaping.has(id) ? y * fxNum('heroicLeap', 'arcScale') : y;
}

/** How high your own character is in the air: your predicted jump, or (while the server moves you, e.g. Heroic Leap) its arc. */
function ownHeight(u: UnitSnap | undefined, serverY?: number): number {
  const jump = jumpHeight(performance.now() - myJumpAt);
  // held up by Ascend to the Heavens: the height is the server's (you cannot jump up there), shown to you as it is to everyone else
  if (u?.auras.some((a) => AURAS[a.id]?.hover)) return Math.max(jump, serverY ?? u.y ?? 0);
  return u?.controlled || ownDashing ? Math.max(jump, leapArc(u?.id ?? 0, serverY ?? u?.y ?? 0)) : jump;
}

/** Runs at exactly the server tick rate so one input is produced per server step. */
function fixedStep() {
  if (!latest || spec || latest.paused || devPaused) { pending = []; return; } // paused by a dev: nothing is sent, nothing is predicted, nothing queued
  const me = latest.units.find((u) => u.id === you);
  if (!me) return;
  const sample = controls.sample(DT);
  const jump = sample.jump && me.alive && !me.controlled && !hovers(me) && canStartJump((jumpTicks + 1) * tickMs); // counted in ticks like the server (one input per tick), not wall time: a late frame that plays several steps at once must not send a jump the server will refuse
  if (jump) {
    myJumpAt = performance.now();
    audio.jump();
  }
  const input: MoveInput = { seq: ++seq, ...sample, jump: jump || undefined };
  lastFacing = sample.facing;
  send({ t: 'input', ...input });
  jumpTicks = jump ? 0 : jumpTicks + 1;
  const mine = { ...input, air: jumpHeight(jumpTicks * tickMs) };
  pending.push(mine);
  if (pending.length > Math.ceil(3000 / tickMs)) pending.shift(); // 3 s of unacknowledged inputs
  if (me.alive && !me.controlled && !hovers(me)) applyInput(mine, me);
}

// ------------------------------------------------------------------ interpolation of other units

const lerpAngle = (a: number, b: number, t: number) => {
  const d = ((((b - a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return a + d * t;
};

function interpolate(rt: number, extrapolate = false, linear = false): Map<number, { x: number; z: number; y: number; facing: number }> {
  const out = new Map<number, { x: number; z: number; y: number; facing: number }>();
  if (!snaps.length) return out;
  const n = snaps.length;
  if (extrapolate && n >= 2 && rt > snaps[n - 1].snap.time) {
    // the buffer ran dry: carry on along the last movement for a moment (fading out) instead of freezing
    const a = snaps[n - 2].snap;
    const b = snaps[n - 1].snap;
    const pose = (u: UnitSnap, t: number): Pose => ({ t, x: u.x, z: u.z, y: u.y, facing: u.facing });
    for (const ub of b.units) {
      const ua = a.units.find((u) => u.id === ub.id);
      const p = poseAt(ua ? pose(ua, a.time) : pose(ub, a.time), pose(ub, b.time), rt, linear ? LEAD_EXTRAPOLATE_MS : undefined, linear);
      out.set(ub.id, { x: p.x, z: p.z, y: p.y, facing: p.facing });
    }
    return out;
  }
  let i = n - 1;
  while (i > 0 && snaps[i].snap.time > rt) i--;
  const a = snaps[i].snap;
  const b = snaps[Math.min(i + 1, n - 1)].snap;
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

/**
 * Smoke Bomb cuts sight at the cloud's edge (as the server rules it): an enemy inside a cloud you are not in, or outside
 * the cloud you are in, cannot be seen or targeted. Both inside the same cloud: business as usual.
 */
function smokeHidden(id: number, snap = latest): boolean {
  if (!snap || spec) return false;
  const me = snap.units.find((u) => u.id === you);
  const o = snap.units.find((u) => u.id === id);
  if (!me || !o || o.team === me.team) return false;
  const inside = (u: { x: number; z: number }, z: { x: number; z: number; r: number }) => Math.hypot(u.x - z.x, u.z - z.z) <= z.r;
  return (snap.zones ?? []).some((z) => z.smoke && inside(me, z) !== inside(o, z));
}

function setTarget(id: number | null) {
  if (spec) {
    if (id !== null) setFollow(id, latest);
    return;
  }
  if (id !== null && smokeHidden(id)) {
    hud.error('Hidden by smoke');
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
    .filter((u) => u.team !== team && u.id !== you && u.alive && !smokeHidden(u.id)) // never yourself, whatever team you are shown on
    .sort((a, b) => Math.hypot(a.x - pred.x, a.z - pred.z) - Math.hypot(b.x - pred.x, b.z - pred.z));
  if (!enemies.length) return;
  const idx = enemies.findIndex((u) => u.id === targetId);
  const next = idx < 0 ? enemies[dir > 0 ? 0 : enemies.length - 1] : enemies[(idx + dir + enemies.length) % enemies.length];
  setTarget(next.id);
}

/** Target the closest living enemy, whoever was targeted before (Next enemy walks the list in order instead). */
function nearestTarget() {
  if (!latest || spec) return;
  const near = latest.units
    .filter((u) => u.team !== team && u.id !== you && u.alive && !smokeHidden(u.id))
    .sort((a, b) => Math.hypot(a.x - pred.x, a.z - pred.z) - Math.hypot(b.x - pred.x, b.z - pred.z))[0];
  if (near) setTarget(near.id);
}

/** Your team's raid marks over heads (unit id -> mark 1-8), as the server last sent them. */
let teamMarks = new Map<number, number>();

/** Put a raid mark on your target for your team (the same mark again, or 0, takes it off). */
function markTarget(mark: number) {
  if (spec || !latest) return;
  if (targetId === null) return void hud.error('Target someone to mark them');
  send({ t: 'mark', unit: targetId, mark });
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
  const slots = bar.map((id) => (stealthed && (me?.stealthSwaps?.[id] ?? ABILITIES[id]?.stealthSwap)) || id);
  return me?.trinket ? [...slots, me.trinket] : slots;
}
let shownKey = '';

function castSlot(i: number) {
  if (spec || tours.blocking) return; // a tour that dims the page never casts
  const ability = shownBar()[i];
  if (!ability) return;
  const def = ABILITIES[ability];
  if (def?.target === 'ground') {
    // first press arms the spell (a ring follows the cursor); pressing it again or clicking places it. A spell still on
    // its cooldown never brings the ring up (a moment's slack for lag only)
    if (aiming === ability) confirmAim();
    else {
      const why = groundBlocked(ability);
      if (why) hud.error(why);
      else setAiming(ability);
    }
    return;
  }
  setAiming(null);
  // spell queue: pressing a global-cooldown spell while casting or on the GCD holds it and sends it the moment you are free
  const me = latest?.units.find((u) => u.id === you);
  const nowS = estimatedNow();
  if (me && def?.gcd && me.alive && mustWait(me, ability, nowS) && (me.cooldowns[ability] ?? 0) - nowS < 1500) {
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
  // the world drawn in the last frame, exactly (a frame is at most a few tens of ms old); before any frame, the clock minus the delay
  if (!spec && performance.now() - drawn.at < 250) return Math.round(drawn.rt);
  return Math.round(estimatedNow() - (spec ? 100 : interpDelay.delay - lead.ms));
}

const QUEUE_SAME_MS = 250;
/**
 * Does this spell have to wait (be queued) right now? A different spell starts at once, even in the middle of a cast or the global
 * cooldown: it ends the one before it. The same spell waits for its own cast or the global cooldown, and so does anything while an
 * unstoppable channel runs.
 */
function mustWait(me: { cast: { ability: string; end: number } | null; gcdEnd: number; gcdBy?: string }, ability: string, now: number): boolean {
  if (me.cast && (me.cast.ability === ability || ABILITIES[me.cast.ability]?.unstoppable)) return true;
  return me.gcdEnd > now && !(TUNING.gcdSwitch && me.gcdBy !== ability);
}
/** A queued spell is sent this long before the global cooldown ends: the server holds it for its cast grace, so it starts the moment it can. */
const QUEUE_EARLY_MS = 120;
/** The last spell sent, so a repeat press of it is not queued on top of itself. */
const lastSent = { ability: '', at: 0 };
function sendCast(msg: Extract<ClientMsg, { t: 'cast' }>) {
  if (ABILITIES[msg.ability]?.coneDeg && msg.facing === undefined && Number.isFinite(lastFacing)) msg = { ...msg, facing: lastFacing };
  lastSent.ability = msg.ability;
  lastSent.at = performance.now();
  send(msg);
}

/** The way the player faced in the last step sent (cone skills carry it so they point where the screen shows). */
let lastFacing = NaN;
let queued: { ability: string; target: number | null; until: number; ground?: { x: number; z: number; lv?: 1 } } | null = null;
function estimatedNow(): number {
  if (!latest) return 0;
  if (!spec && latest.paused) return latest.time; // the server's clock stands still
  if (!spec && netClock.ready) return netClock.now(performance.now());
  return latest.time + (performance.now() - latestAt);
}
/** Sends the queued spell once the current cast and global cooldown are over. */
function flushQueue() {
  if (!queued) return;
  const me = latest?.units.find((u) => u.id === you);
  if (spec || !me || !me.alive || performance.now() > queued.until) { queued = null; return; }
  if (mustWait(me, queued.ability, estimatedNow() + QUEUE_EARLY_MS) || (me.cooldowns[queued.ability] ?? 0) > estimatedNow() + QUEUE_EARLY_MS) return;
  const q = queued;
  queued = null;
  sendCast({ t: 'cast', ability: q.ability, target: q.target, vt: viewTime(), ...(q.ground ? { x: q.ground.x, z: q.ground.z, ...(q.ground.lv === 1 ? { lv: 1 as const } : {}) } : {}) });
}

/** How long until a spell is off its own cooldown (not the global one), as far as this client can tell. */
function groundCooldownLeft(ability: string): number {
  const me = latest?.units.find((u) => u.id === you);
  if (!me) return 0;
  // being cast right now counts too: its cooldown only starts when the cast lands
  if (me.cast?.ability === ability) return Infinity;
  return Math.max(0, (me.cooldowns[ability] ?? 0) - estimatedNow());
}
const GROUND_SLACK_MS = 250;

/** Why a ground spell cannot be cast right now (cooldown, mana, stun, silence), or null when it is ready. The aiming ring only shows while it is ready. */
function groundBlocked(ability: string): string | null {
  const me = latest?.units.find((u) => u.id === you);
  const def = ABILITIES[ability];
  if (!me || !def || !me.alive) return null;
  const now = estimatedNow();
  if (groundCooldownLeft(ability) > GROUND_SLACK_MS) return 'That is not ready yet';
  if (me.resource < def.cost) return `Not enough ${me.resourceType}`;
  if (me.auras.some((a) => AURAS[a.id]?.noCast) || (def.class !== 'trinket' && !!silencedBy(me.auras, def)) || (me.controlled && !def.ignoresControl) || lockedByAura(def, me.auras)) return 'You cannot act right now';
  if (!def.ignoresLockout && (me.lockouts?.[def.school] ?? 0) > now) return `${def.school} is locked out`;
  return null;
}

/** Like groundBlocked, but the global cooldown and a cast in progress do not count (a placed spell is queued behind them). */
function groundBlockedWhileAiming(ability: string): boolean {
  const me = latest?.units.find((u) => u.id === you);
  const def = ABILITIES[ability];
  if (!me || !def) return false;
  if (me.cast?.ability === ability) return true;
  if ((me.cooldowns[ability] ?? 0) - estimatedNow() > GROUND_SLACK_MS) return true;
  if (!def.ignoresLockout && (me.lockouts?.[def.school] ?? 0) > estimatedNow()) return true;
  return me.resource < def.cost;
}

/** The ground spell waiting for a click (Flamestrike, Blizzard), or null. The aiming ring only shows while this is set. */
let aiming: string | null = null;
/** The last spot the aiming ring showed green. */
let lastGreen: { g: { x: number; z: number; lv?: 1 }; at: number; ability: string } | null = null;
function setAiming(id: string | null) {
  aiming = id;
  hud.setAiming(id);
}
function confirmAim() {
  const def = aiming ? ABILITIES[aiming] : undefined;
  if (!aiming || !def) return;
  let g = groundAim(def.range);
  // the spot the ring showed green a moment ago counts when the cursor just slipped (a click made in a hurry)
  if (!g && lastGreen && performance.now() - lastGreen.at < 250 && lastGreen.ability === aiming) g = lastGreen.g;
  if (!g) return; // cursor on the sky: keep aiming
  if (!hasLOS({ x: pred.x, z: pred.z }, g, arena, predLevel, aimLevel(g), jumpHeight(performance.now() - myJumpAt))) return void hud.error('No line of sight to that spot'); // red spot: nothing is sent, nothing is spent, still aiming
  const spot = { x: g.x, z: g.z, ...(g.lv === 1 ? { lv: 1 as const } : {}) };
  const me = latest?.units.find((u) => u.id === you);
  const nowS = estimatedNow();
  if (me && def.gcd && mustWait(me, aiming, nowS)) {
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
controls.onDoubleTap = () => {
  if (spec) cycleFollow(1); // watching on a phone: a double tap is "next player"
};
controls.onRightClick = (x, y) => {
  if (spec || aiming) return;
  const id = scene.pick(x, y, you, false); // right-click is for enemies and allies, never yourself (your model is under the cursor whenever you steer)
  if (id === null) return;
  setTarget(id);
  const me = latest?.units.find((u) => u.id === you);
  const t = latest?.units.find((u) => u.id === id);
  if (autoEnabled && me && t && t.team !== me.team && !me.autoAttack) send({ t: 'auto', on: true }); // right-click an enemy: target and start swinging
};
let modalAtEsc = false;

/** Turning your own model in the lobby: drag anywhere on the menu's empty middle. */
const lobbySpin = { yaw: 0, at: -1e9, dragX: null as number | null };
const lobbyZoom = { d: 6.5, fy: 0, last: 0 };
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
    if (hudLayout.editing) return hudLayout.stop(); // before anything else: Esc always leaves the HUD editor
    if (aiming) return void setAiming(null);
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
  // F2: the tools window (Dev and Admin tabs; Shift+F2 switches), in the menu, a match, a watched match or replay and the end screen
  if (code === 'F2' && !binds.actionForEvent(e)) {
    if (tools.f2(e.shiftKey)) e.preventDefault();
    return;
  }
  if (!latest) return;
  if (code === 'KeyB' && (spec?.kind === 'live' || spectateBar.board.visible)) return void spectateBar.board.toggle();
  // N: the builds panel (watching, or a dev in a match); F2: dev tools. Only when the key is not bound to something else
  if (code === 'KeyN' && (spec || (isDev() && devPanel.matchMode)) && !binds.actionForEvent(e)) {
    if (!spec) send({ t: 'dev_builds' });
    return void buildsPanel.toggle();
  }
  const action = binds.actionForEvent(e);
  if (!action) return;
  const slot = SLOT_ACTIONS.indexOf(action);
  if (action === 'trinket') {
    if (shownBar().length > bar.length) castSlot(bar.length);
  } else if (slot >= 0) castSlot(slot);
  else if (action === 'nextTarget') cycleTarget(e.shiftKey ? -1 : 1);
  else if (action === 'prevTarget') cycleTarget(-1);
  else if (action === 'nearestTarget') nearestTarget();
  else if (action in MARK_ACTIONS) markTarget(MARK_ACTIONS[action]!);
  else if (action === 'autoAttack') {
    if (spec || !autoEnabled) return;
    const me = latest.units.find((u) => u.id === you);
    send({ t: 'auto', on: !me?.autoAttack });
  }
};

// ------------------------------------------------------------------ frame loop

// a ping twice a second-ish: round trip time for the readout (the server answers at once)
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) send({ t: 'ping', n: performance.now() });
}, 2000);

const lobbyTags = new LobbyTags();
let lastT = performance.now();
let acc = 0;

function frame(now: number) {
  tools.sync(); // the 🛠 button and the open window follow the account
  tours.setContext(spec ? (latest ? 'watch' : 'other') : latest ? 'match' : mainMenu.visible ? 'menu' : 'other');
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, (now - lastT) / 1000);
  lastT = now;

  if (!latest && spec) {
    // waiting for the first frame of a live match (it arrives 5 s late)
    vis.yaw = controls.yaw;
    scene.setViewShift(0, 0);
    scene.setPhase('prep');
    scene.update([], 0, null);
    scene.setCamera(0, 0, controls.yaw, 0.6, 30);
    scene.render();
    return;
  }
  if (latest || spec) {
    lobbyTags.hide();
    scene.setViewShift(0, 0);
  }
  if (!latest) {
    // Menu backdrop: the chosen class idles in the arena and sways gently towards the camera.
    const t = now / 1000;
    // preview the arena picked in the menu (random shows the last one)
    const previewMap = mainMenu.selectedMap;
    if (previewMap !== 'random' && !matchStarting) scene.setMap(previewMap);
    // the scene is the truth about which arena is on screen ('random' keeps showing whatever it already shows, and a map
    // being started is not swapped): the characters stand on ITS spawn, never on another map's coordinates
    const prev = arenaById(scene.arenaId);
    // drag on the empty middle of the menu to turn your character; the idle sway fades out while you do and comes back after
    // the Look window's buttons: turn steps ease in, auto-rotate keeps turning (and holds the idle sway off)
    const lv = mainMenu.lookView;
    const lookOpen = mainMenu.lookOpen;
    if (lv.zoom !== lobbyZoom.last) {
      lobbyZoom.last = lv.zoom;
      if (lv.zoom === 1) lv.turn = ((Math.PI - lobbySpin.yaw) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI; // head close-up: show the front
    }
    if (lv.turn !== 0) {
      const step = lv.turn * Math.min(1, dt * 8);
      lobbySpin.yaw += step;
      lv.turn -= step;
      if (Math.abs(lv.turn) < 0.002) lv.turn = 0;
      lobbySpin.at = now;
    }
    if (lookOpen && lv.auto && lobbySpin.dragX === null) {
      lobbySpin.yaw += dt * 0.9;
      lobbySpin.at = now;
    }
    const sway = lobbySpin.dragX !== null ? 0 : Math.min(1, Math.max(0, (now - lobbySpin.at - 2500) / 2000));
    const face = prev.spawnFacing[0] + Math.PI + lobbySpin.yaw + Math.sin(t * 0.6) * 0.55 * sway;
    scene.setPhase('lobby'); // no start gates: their blue barrier planes read as glitches across the stadium
    // party members stand beside you with the class, weapon and skins they picked
    const me = accountUi.account?.name;
    const mates = (mainMenu.currentParty?.members ?? []).filter((m) => m.name !== me && m.classId && CLASSES[m.classId as ClassId]);
    const spots = menuSpots(prev, mates.length);
    const spot = spots[0]!; // always the first spawn
    const f0 = prev.spawnFacing[0];
    const menuUnits: RenderUnit[] = [{ id: -1, classId: mainMenu.selectedClass, look: gearLook(mainMenu.currentBuild.gear), weapon: weaponFor(mainMenu.selectedClass, mainMenu.currentBuild.spec), team: 0, x: spot.x, z: spot.z, y: 0, facing: face, alive: true, stealthed: false, casting: false, sheep: false }];
    const placedMates: typeof mates = [];
    mates.forEach((m, i) => {
      const o = spots[i + 1]; // free ground beside you; a mate with no room is left out
      if (!o) return;
      placedMates.push(m);
      menuUnits.push({ id: -2 - i, classId: m.classId as ClassId, look: m.look ?? '', weapon: weaponFor(m.classId as ClassId, m.spec), team: 0, x: o.x, z: o.z, y: 0, facing: f0 + Math.PI + Math.sin(t * 0.6 + i + 1) * 0.55, alive: true, stealthed: false, casting: false, sheep: false });
    });
    scene.update(menuUnits, 0, null);
    // Look window open: slide the picture so the model sits in the free half, and zoom to head / weapon on request
    const zoomTo = lookOpen ? [{ d: mates.length ? 9.5 : 6.5, fy: 0 }, { d: window.innerWidth <= 760 ? 3.8 : 2.7, fy: -0.1 }, { d: window.innerWidth <= 760 ? 4.6 : 3.4, fy: -0.85 }][lv.zoom] : { d: mates.length ? 9.5 : 6.5, fy: 0 };
    lobbyZoom.d += (zoomTo.d - lobbyZoom.d) * Math.min(1, dt * 7);
    lobbyZoom.fy += (zoomTo.fy - lobbyZoom.fy) * Math.min(1, dt * 7);
    const narrow = window.innerWidth <= 760;
    scene.setViewShift(lookOpen ? (narrow ? 0 : -Math.min(260, window.innerWidth * 0.3) / window.innerWidth) : 0, lookOpen && narrow ? -0.24 : 0);
    scene.setCamera(spot.x, spot.z, f0 + Math.sin(t * 0.6) * 0.1, 0.12, lobbyZoom.d, lobbyZoom.fy);
    // everyone in the party: their model's name tag with a check once ready (the leader is always ready)
    const party = mainMenu.currentParty;
    if (party && me) {
      const placed = [{ name: me, x: menuUnits[0].x, z: menuUnits[0].z }, ...placedMates.map((m, i) => ({ name: m.name, x: menuUnits[i + 1].x, z: menuUnits[i + 1].z }))];
      lobbyTags.show(party, placed, (x, y, z) => scene.project(x, y, z));
    } else lobbyTags.hide();
    scene.render();
    return;
  }

  // the scene always shows the match's arena (Play again against bots moves to a new random map)
  matchStarting = false;
  scene.setMap(arena.id);

  if (spec?.runner && !spec.paused && !spec.runner.done) {
    spec.clock += dt * 1000 * spec.rate;
    const evs: Parameters<Hud['event']>[0][] = [];
    let n = 0;
    while (spec.clock >= spec.runner.tickMs && !spec.runner.done) {
      spec.clock -= spec.runner.tickMs;
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

  if (aiming && groundCooldownLeft(aiming) > GROUND_SLACK_MS) setAiming(null); // it went on cooldown: no ring for a spell you cannot cast
  flushQueue();
  const snap = latest!;
  const rate = !spec ? 1 : spec.paused || (spec.runner?.done ?? false) ? 0 : spec.rate;
  const estNow = !spec && netClock.ready ? netClock.now(performance.now()) : snap.time + (performance.now() - latestAt) * rate;
  scene.viewLevel = predLevel;
  const drawAt = spec ? estNow - (rate > 0 ? Math.max(100 * rate, 60) : 0) : renderTime.next(estNow, interpDelay.delay);
  // others are drawn `lead` ms later than the buffered time (dead reckoning), and casts report that time too
  const frozen = !spec && !!snap.paused;
  const leadMs = spec || frozen ? 0 : lead.update(netStats.rtt.rtt, dt);
  const shownAt = frozen ? snap.time : drawAt + leadMs; // paused: the world stands exactly on the last snapshot
  if (!spec) {
    drawn.rt = shownAt;
    drawn.at = performance.now();
    netStats.leadMs = leadMs;
    netStats.frame(drawAt > snap.time);
  }
  const interp = interpolate(shownAt, !spec && !frozen, leadMs > 1);
  if (spec) targetId = snap.units.find((u) => u.id === you)?.target ?? null;

  // our own unit: interpolate between the last two 20 Hz predictions, then ease towards that (hides corrections too)
  {
    const alpha = Math.min(1, Math.max(0, acc / DT));
    const meNow0 = spec ? undefined : snap.units.find((u) => u.id === you);
    let tx = prevPred.x + (pred.x - prevPred.x) * alpha;
    let tz = prevPred.z + (pred.z - prevPred.z) * alpha;
    if (!spec && meNow0?.alive && !meNow0.controlled) {
      // drawn where we are now: the last predicted step carried on for the time since it was taken (not blended up to a tick behind)
      const p = ownAhead(pred, prevPred, acc, DT, TUNING.runSpeed * DT * 3);
      tx = p.x;
      tz = p.z;
    }
    // a Charge or Heroic Leap: the server is moving us fast, so we are drawn on the same snapshot timeline as everyone else (smooth, no lag, no snapping)
    const ownI = interp.get(you);
    ownDashing = !spec && !!meNow0?.alive && !!ownI && dash.dashing(snap.time, ownI, meNow0, meNow0.controlled);
    if (ownDashing && ownI) {
      tx = ownI.x;
      tz = ownI.z;
    }
    if (spec) {
      // watching: the camera follows the interpolated server position of the followed unit
      const f = interp.get(you);
      if (f) {
        tx = f.x;
        tz = f.z;
        vis.facing = f.facing;
      }
    }
    if (!vis.ready || anchorSnaps(Math.hypot(tx - vis.x, tz - vis.z), ownDashing)) {
      vis.x = tx;
      vis.z = tz;
      vis.ready = true;
    } else {
      // while stunned, feared or polymorphed the server is moving us, so the camera anchor is damped heavily and the view stays steady
      const held = !spec && !!meNow0?.alive && meNow0.controlled;
      const k = anchorBlend(dt, ownDashing, held);
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

  const units: RenderUnit[] = snap.units.filter((u) => !smokeHidden(u.id, snap)).map((u) => {
    let x = u.x;
    let z = u.z;
    let facing = u.facing;
    let y = u.y;
    const i = interp.get(u.id);
    if (i) ({ x, z, y, facing } = i);
    y = leapArc(u.id, y);
    if (!spec && u.id === you) {
      x = vis.x;
      z = vis.z;
      facing = vis.facing;
      y = u.alive ? ownHeight(u, i?.y) : 0; // a leap's arc comes from the server, a jump is predicted here
    }
    return { id: u.id, classId: u.classId, look: u.look, weapon: weaponFor(u.classId, u.spec), team: u.team, x, z, y, lv: u.id === you && !spec ? predLevel : (u.lv ?? 0), facing, alive: u.alive, stealthed: u.stealthed, casting: !!snap.units.find((x) => x.id === u.id)?.cast && !ABILITIES[snap.units.find((x) => x.id === u.id)!.cast!.ability]?.channel?.hold, sheep: !!snap.units.find((x) => x.id === u.id)?.auras.some((a) => a.id === 'polymorph') };
  });

  scene.setPhase(snap.phase);
  scene.followId = spec ? -99 : you;
  scene.teamRings = snap.units.length > 2;
  scene.update(units, team, targetId);
  renderPos.clear();
  for (const u of units) renderPos.set(u.id, { x: u.x, y: scene.unitY(u.id) ?? u.y, z: u.z, facing: u.facing });
  effects.setZones(snap.zones ?? [], estNow);
  effects.update(
    dt,
    snap.units.map((s) => {
      const p = renderPos.get(s.id)!;
      return { id: s.id, x: p.x, y: p.y, z: p.z, facing: p.facing, alive: s.alive, auras: s.auras.map((a) => a.id) };
    }),
  );
  scene.setCamera(vis.x, vis.z, vis.yaw, vis.pitch, vis.dist < 0.3 ? 0 : vis.dist, ((spec ? interp.get(you)?.y ?? 0 : ownHeight(latest?.units.find((x) => x.id === you), interp.get(you)?.y)) * 0.45) + (camFloor.y = fallToward(camFloor.y, heightAt(arena, vis.x, vis.z, predLevel), dt, camFloor)));
  {
    // aimed spells (Flamestrike, Blizzard): show where they would land
    const meNow = snap.units.find((u) => u.id === you);
    if (aiming && (spec || !meNow?.alive || meNow.controlled)) setAiming(null); // casting something else keeps the aim: it is placed into the queue
    // a spell that stops being castable while aimed (its cooldown starts, mana runs out, a silence lands) hides its ring until it is ready again
    const aimed = !spec && aiming && !groundBlockedWhileAiming(aiming) ? ABILITIES[aiming] : undefined;
    const g = aimed ? groundAim(aimed.range) : null;
    const r = aimed?.effects.find((e) => e.type === 'zone');
    if (g && aiming && hasLOS({ x: pred.x, z: pred.z }, g, arena, predLevel, aimLevel(g), jumpHeight(performance.now() - myJumpAt))) lastGreen = { g, at: performance.now(), ability: aiming };
    scene.setReticle(g && snap.units.find((u) => u.id === you)?.alive ? g : null, r && r.type === 'zone' ? r.radius : 5, !g || hasLOS({ x: pred.x, z: pred.z }, g, arena, predLevel, aimLevel(g), jumpHeight(performance.now() - myJumpAt)));
  }
  if (spec) spectateBar.update(snap.tick, snap.units.find((u) => u.id === you)?.name ?? '');
  netView.show(!spec && (showNetStats || isDev()));
  netView.update(netStats, performance.now());
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

  if (!spec && targetId !== null && smokeHidden(targetId)) setTarget(null); // the smoke's edge takes your target away
  // a dev rebuilt you in the middle of the match (class, talents or skills): the bar and tooltips follow
  {
    const mine = !spec ? latest?.units.find((u) => u.id === you) : undefined;
    if (mine) {
      const mb = mine.bar ?? specOf(mine.classId, mine.spec ?? '')?.bar ?? CLASSES[mine.classId].bar;
      const tal = lastBuilds.find((b) => b.id === you)?.talents ?? [];
      const key = `${mine.classId}|${mine.spec}|${tal.join()}|${mb.join()}`;
      if (!ownBuildKey) ownBuildKey = key;
      else if (key !== ownBuildKey) {
        ownBuildKey = key;
        if (mb.join() !== baseBar || mine.classId !== classId) {
          classId = mine.classId;
          barSpec = mine.spec;
          baseBar = mb.join();
          bar = applyOrder(mb, loadOrder(classId, barSpec));
          shownKey = '';
        }
        setTipBuild(classId, { spec: mine.spec ?? specOf(classId, '')?.id ?? '', talents: tal, gear: {} });
      }
    }
  }
  const shown = shownBar();
  if (shown.join() !== shownKey) {
    shownKey = shown.join();
    hud.setBar(classId, shown, !!shown.length && shown.length > bar.length);
    relabel();
  }
  hud.autoEnabled = autoEnabled;
  hud.update({ snap, now: estNow, you, targetId });
  hud.nameplates(
    units.map((u) => {
      const kind = plateKind({ id: u.id, enemy: u.team !== team }, you, !!spec);
      const prof = plateProfile(kind);
      const uy = scene.unitY(u.id) ?? u.y; // the model's real height: up decks, ramps and jumps
      const s = scene.project(u.x, anchorWorldY(prof.anchor, uy), u.z); // the plate's head or feet anchor
      s.y -= prof.offsetY;
      const meta = snap.units.find((x) => x.id === u.id)!;
      return { id: u.id, x: s.x, y: s.y, visible: s.visible, kind, dist: scene.distanceTo(u.x, uy, u.z), name: meta.name, health: meta.health, maxHealth: meta.maxHealth, enemy: u.team !== team, alive: u.alive, cast: meta.cast ? { ability: meta.cast.ability, start: meta.cast.start, end: meta.cast.end } : null, auras: meta.auras, absorb: meta.absorb, resource: meta.resource, resourceMax: meta.resourceMax, resourceType: meta.resourceType, target: !spec && u.id === targetId && u.id !== you, mark: spec ? 0 : teamMarks.get(u.id) ?? 0, classId: u.classId };
    }),
    estNow,
    spec ? 0 : you,
  );
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------ watching: live matches and replays

/** Watching: everyone's spec, talents and skills, on the side. */
const buildsPanel = new BuildsPanel();
/** The last builds the server sent (watching, or a dev in a match). */
let lastBuilds: UnitBuild[] = [];
let buildsAsked = false;
/** The numbers this client plays with: data files, then saved dev changes, then a dev's test numbers. */
const dataLayers = new DataLayers();
const devPanel = new DevPanel({ send: (m) => accountUi.sendRaw(m), builds: () => lastBuilds, myBar: () => bar, youId: () => you, spectating: () => !!spec, mapId: () => arena.id, isOwner: () => !!accountUi.account?.ownerOk, menuClass: () => mainMenu.selectedClass, noteMatch: () => (botTests.match && botTests.bots > 0 ? botTests.match : null) }, dataLayers);
/** The owner (unlocked this session) or an account with the dev tag. */
const isDev = () => !!accountUi.account && (!!accountUi.account.ownerOk || accountUi.account.grants.includes('dev'));
const spectateBar = new SpectateBar({
  switchKey: () => binds.label('nextTarget'),
  onCycle: (dir) => cycleFollow(dir),
  onBuilds: () => buildsPanel.toggle(),
  onSettings: () => (menu.isOpen ? menu.back() : menu.open(true)),
  onPlayAs: (anchor) => {
    if (!lastBuilds.some((u) => u.bot)) accountUi.sendRaw({ t: 'dev_builds' }); // ask again: the list may not have arrived yet
    takeoverUi.pick(lastBuilds, anchor);
  },
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
    recap.reset();
    killFeed.clear();
    dpsMeter.reset();
    recapCard.hide();
    recapExact = tick <= 0;
    onSnapshot(spec.runner.snapshot(), []);
  },
});
/** Owner: who is being followed into their matches. */
let following: string | null = null;
/** A box that stays on screen for as long as you are following someone, with a way to stop. */
const followBox = (() => {
  const box = document.createElement('div');
  box.className = 'follow-box hidden';
  const lbl = document.createElement('span');
  lbl.className = 'fb-lbl';
  lbl.textContent = '👁 Following';
  const nameEl = document.createElement('b');
  nameEl.className = 'fb-name';
  const stop = document.createElement('button');
  stop.textContent = 'Stop';
  stop.title = 'Stop following';
  stop.addEventListener('click', () => send({ t: 'follow', name: null }));
  box.append(lbl, nameEl, stop);
  document.body.append(box);
  return {
    set(name: string | null) {
      box.classList.toggle('hidden', !name);
      nameEl.textContent = name ?? '';
      box.title = name ? `Following ${name}: you join every match they play. Press Stop to go back to normal.` : '';
    },
  };
})();
/** Owner only: the unit of a live match played right now, and the picker and chip for it. */
let controlling = false;
let syncTarget = false;
const takeoverUi = new TakeoverUi({
  onPick: (unit) => {
    if (spec?.id) send({ t: 'admin_takeover', id: spec.id, unit });
  },
  onRelease: () => send({ t: 'admin_release' }),
});
const livePicker = new LivePicker(
  (id) => send({ t: 'spectate', id }),
  () => send({ t: 'live' }),
  () => !!accountUi.account,
  () => accountUi.openAuth(),
  { isOwner: () => !!accountUi.account?.ownerOk, current: () => following, set: (name) => send({ t: 'follow', name }) },
);

/** Dev tools: the running test match moved to another map (the server put everyone at its spawns). */
function swapMatchMap(mapId: string) {
  arena = arenaById(mapId);
  scene.setMap(arena.id);
  audio.ambience(arena.theme);
  matchStarting = true;
  // forget the old positions: the next snapshot says where everyone stands on the new map (no clock, buffer, speed or prediction of the old one survives)
  if (!spec) resetNetState();
  snaps.length = 0;
  pending = [];
  targetId = null;
  vis.ready = false;
  const face = spec ? arena.spawnFacing[0] : arena.spawnFacing[team];
  controls.yaw = controls.facing = face;
  vis.facing = vis.yaw = face;
  vis.pitch = controls.pitch;
  vis.dist = controls.dist;
  setAiming(null);
}

function startSpectate(kind: 'live' | 'replay', mapId: string, id?: string, runner?: ReplayRunner) {
  clearMenuLayers();
  controlling = false;
  takeoverUi.setControlling(null);
  spec = { kind, runner, id, rate: 1, paused: false, clock: 0 };
  arena = arenaById(mapId);
  scene.setMap(arena.id);
  matchStarting = true; // a watched match or replay is on its own map, whatever the menu shows
  devPanel.setAvailable(false); // test numbers never carry over from a match you played
  if ((accountUi.account?.ownerOk || isDev()) && kind === 'live') devPanel.setAvailable(true); // the owner can pause and tune a match being watched, a dev one of the bot matches (the server says no to the others)
  if (accountUi.account?.ownerOk && kind === 'live') accountUi.sendRaw({ t: 'dev_builds' }); // the bots list for the Play as picker, without opening the tools window
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
    spectateBar.showReplay(runner.data.ticks, `${mapName(runner.data.arena)} · ${names.join(', ')}`, `${location.origin}/?replay=${id}`, runner.tickMs);
    onSnapshot(runner.snapshot(), []);
    // the recording has every unit's build: show it like a live watch does
    buildsPanel.set(runner.data.units.map((o, i) => ({ id: i + 1, name: o.name, classId: o.classId, team: o.team, spec: o.build?.spec ?? null, talents: o.build?.talents ?? [], bar: barFor(o.classId, o.build, CLASSES[o.classId].bar) })));
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

function resetRecap() {
  recap.reset();
  killFeed.clear();
  dpsMeter.reset();
  recapCard.hide();
  recapPhase = '';
  recapExact = true;
}

function endSpectateState() {
  botTests.clear();
  resetRecap();
  if (!spec) return;
  spec = null;
  spectateBar.hide();
  buildsPanel.clear();
  devPanel.setAvailable(false);
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
  liveWanted = true;
  send({ t: 'live' });
}

let liveWanted = false;
const liveBadge = Object.assign(document.createElement('span'), { className: 'hdr-badge live hidden' });
const adminBadge = Object.assign(document.createElement('span'), { className: 'hdr-badge new hidden' });
function setBadge(b: HTMLElement, n: number) {
  b.textContent = badgeText(n);
  b.classList.toggle('hidden', n <= 0);
}
/** While signed in at the menu: how many matches can be watched, and (owner) how many dev proposals wait. */
const pollBadges = () => {
  if (!accountUi.account || !mainMenu.visible || document.hidden) return;
  send({ t: 'live' });
  if (adminAccessOf(accountUi.account)) send({ t: 'admin_proposals', op: 'list' });
};
window.setInterval(pollBadges, 20000);
window.setTimeout(pollBadges, 4000);

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
const updateNotice = new UpdateNotice(pkg.version);
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
      updateNotice.afterDrop();
      if (ws !== sock) return;
      ws = null;
      audio.stopAmbience();
      controlling = false;
      takeoverUi.setControlling(null);
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
  openAdmin: (tab) => adminPanel.open(tab),
  openLook: (section) => mainMenu.openLookSection(section),
  refreshLook: () => mainMenu.refreshLook(),
  send: (m) => {
    if (ws && ws.readyState === WebSocket.OPEN) send(m);
    else void connect().then((ok) => (ok ? send(m) : accountUi.fail('Could not reach the server.')));
  },
  onAccount: (a) => {
    flags.owner = a?.role === 'owner';
    friendsUi.setAccount(a?.name ?? null);
    paintHeader();
    // the admin panel follows the account (unlocking the owner code there opens the rest of it)
    queueMicrotask(() => {
      if (adminPanel.isOpen) {
        if (a?.role === 'owner' || adminAccessOf(a)) adminPanel.open();
        else adminPanel.close();
      }
    });
    if (a) {
      applyAccountProgress(a.matches, a.wins);
      waitForTourSync();
    } else {
      tours.setSyncPending(false);
      restoreGuestProgress();
      settingsSync.stop();
    }
    setTipProgress(progress.matches);
    mainMenu.setAccount(a);
    mainMenu.refresh();
    refreshCursor(); // unlocked cursors follow the account
  },
});

const friendsUi = new FriendsUi({
  send: (m) => {
    if (ws && ws.readyState === WebSocket.OPEN) send(m);
    else void connect().then((ok) => ok && send(m));
  },
  signedIn: () => !!accountUi.account,
  needSignIn: () => accountUi.openAuth(),
  follow: { isOwner: () => !!accountUi.account?.ownerOk, current: () => following, set: (name) => send({ t: 'follow', name }) },
  onParty: (p) => {
    mainMenu.setParty(p);
    sendLook();
  },
});
const suggestUi = new SuggestUi({ send: (m) => send(m), isOwner: () => !!accountUi.account?.ownerOk, signedIn: () => !!accountUi.account, needSignIn: () => accountUi.openAuth() });
/** Raid marks: right-click the target frame for the picker. */
const markPicker = new MarkPicker((mark) => markTarget(mark), () => (targetId !== null ? teamMarks.get(targetId) ?? 0 : 0));
/** The owner's announcements: a big banner at the top of the screen. */
const announceBanner = new AnnounceBanner();
/** The owner's admin panel (its own window, from the 🛡 button). */
const adminPanel = new AdminPanel({
  send: (m) => accountUi.sendRaw(m),
  token: () => accountUi.token ?? '',
  account: () => accountUi.account,
  watch: (id) => send({ t: 'spectate', id }),
  follow: (name) => send({ t: 'follow', name }),
  replay: (id) => void startReplay(id),
  playOn: (id) => mainMenu.playOn(id),
  onPending: (n) => {
    setBadge(adminBadge, n);
    tools.setPending(n);
    adminBadge.title = `${n} dev proposal${n === 1 ? '' : 's'} not checked yet`;
  },
});
registerPopup(adminPanel.bbPopup);
/** Dev tools and the admin panel in one window with a tab for each (the 🛠 button and F2, anywhere the account has access). */
const tools = new ToolsWindow(devPanel, adminPanel, () => accountUi.account);
registerPopup(tools.popup);
const menuExtras = document.createElement('div');
menuExtras.className = 'menu-extras';
const header = buildHeaderBar([
  { icon: 'profile', label: 'Profile', onClick: () => (accountUi.account ? accountUi.openProfile() : accountUi.openAuth()) },
  { icon: 'friends', label: 'Friends and party', onClick: () => friendsUi.openOrSignIn(), badge: friendsUi.badge },
  { icon: 'patches', label: 'Patch notes', onClick: () => mainMenu.openPatches(), badge: patchBadgeEl },
  { icon: 'watch', label: 'Watch live matches', onClick: () => void openLive(), badge: liveBadge },
  { icon: 'suggest', label: 'Suggestions', onClick: () => suggestUi.open() },
  { icon: 'settings', label: 'Settings (sound, graphics)', onClick: () => menu.open(false) },
  { icon: 'bots', label: 'Bot battle', onClick: () => adminPanel.openBotBattle() },
  { icon: 'admin', label: 'Admin panel', onClick: () => adminPanel.open(), badge: adminBadge },
]);
const paintHeader = () => {
  const a = accountUi.account;
  const b = header.buttons.profile;
  b.title = a ? `Profile · ${a.name}` : 'Sign in or register';
  b.classList.toggle('hdr-signin', !a);
  header.buttons.admin.classList.toggle('hidden', a?.role !== 'owner' && !adminAccessOf(a)); // the founder account and accounts with the dev tag see the admin button
  header.buttons.bots.classList.toggle('hidden', (!adminAccessOf(a) && a?.role !== 'owner') || (adminAccessOf(a) === 'dev' && !hasPower(a?.grants, 'botmatch'))); // and the bot battle button
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
  nameSection: () => accountUi.nameSection(),
  onWatch: () => void openLive(),
  ownerLog: () => (accountUi.account?.ownerOk ? send({ t: 'owner_log' }) : undefined),
  isOwner: () => !!accountUi.account?.ownerOk,
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
// the mouse cursor (client/src/cursors.ts): your chosen style, except a red sword over enemies, a green cross over allies and a crosshair while aiming
initCursors({
  canvas,
  situation: () => {
    const me = latest?.units.find((u) => u.id === you);
    const inMatch = !!latest && (!!spec || you !== 0);
    let aim: 'aim' | 'aimBlocked' | null = null;
    if (aiming && !spec && me?.alive) {
      // the same checks as the aiming ring: red when the spell cannot be cast now or the spot has no line of sight, green otherwise
      const def = ABILITIES[aiming];
      const g = def ? groundAim(def.range) : null;
      const sight = !g || hasLOS({ x: pred.x, z: pred.z }, g, arena, predLevel, aimLevel(g), jumpHeight(performance.now() - myJumpAt));
      aim = groundBlockedWhileAiming(aiming) || !sight ? 'aimBlocked' : 'aim';
    }
    return { inMatch, spectating: !!spec, aim, myTeam: me ? me.team : null };
  },
  pick: (x, y) => {
    const id = scene.pick(x, y, you, true);
    const u = id === null ? undefined : latest?.units.find((w) => w.id === id);
    return u ? { team: u.team, alive: u.alive, self: u.id === you } : null;
  },
  stats: () => accountUi.account ?? { name: undefined, matches: progress.matches, wins: progress.wins, peak: 0 },
  classColor: () => {
    const me = latest?.units.find((u) => u.id === you);
    return CLASSES[me && !spec ? me.classId : mainMenu.selectedClass]?.color ?? null;
  },
});
// dev server only (stripped from the build): lets a test read the camera and the followed unit
if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) (window as unknown as Record<string, unknown>).__cam = () => ({ yaw: controls.yaw, pitch: controls.pitch, dist: controls.dist, you, spec: !!spec, rate: spec?.rate, paused: spec?.paused, tick: latest?.tick });
// guided tours (tour.ts): what they may open, and the wait for the account's settings (they carry the list of tours already seen)
let tourSyncTimer = 0;
function waitForTourSync() {
  tours.setSyncPending(true);
  window.clearTimeout(tourSyncTimer);
  tourSyncTimer = window.setTimeout(() => tours.setSyncPending(false), 8000); // no settings came: go on with this browser's list
}
tours.setHost({
  releaseInput: () => controls.releaseAll(),
  openDevPanel: () => {
    return tools.show('dev');
  },
  devShow: (o) => devPanel.tourShow({ ...o, page: o.page as DevPageId | undefined }),
  openAdmin: (tab) => adminPanel.showTab(tab as AdminTab),
  closeAdmin: () => {
    if (tools.tab === 'admin') tools.hide();
  },
  closeMenus: () => {
    menu.close();
    helpWindow.close();
  },
  access: () => adminAccessOf(accountUi.account),
});
if (accountUi.token) waitForTourSync();
const verEl = document.getElementById('ver');
if (verEl) verEl.textContent = `v${pkg.version}`;
updateNotice.watch();
