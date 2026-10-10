import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import type { WebSocket } from 'ws';
import { ARENAS, ArenaSim, disabledMaps, mapDisabled, findArena, customArenas, isCustomArena, Bot, TUNING, SlimEncoder, CLASSES, PATCHES, botBuild, PROTOCOL_VERSION, ReplayRecorder, START_RATING, arenaById, resolveCosmetics, packHudDefault } from '@arena/shared';
import type { HudLayoutMap, StatRow, FriendRow, FriendStatus, LiveMatch, MatchPlayer, MatchRecord, PartyInfo, RosterEntry, Snapshot, SimEvent, Unit } from '@arena/shared';
import { issueProfile, verifyProfile } from './profile';
import { findMatch } from './matchmaking';
import type { QEntry } from './matchmaking';
import { REPLAY_MAX_BYTES, bannedText, publicInfo } from './accounts';
import type { AccountRecord, Accounts } from './accounts';
import type { BotLearner } from './botlearn';
import type { Suggestions } from './suggestions';
import { DEFAULT_BOT_NAMES, pickBotName, validateBotNames, currentValue, barSwapped, cleanGear, emptyBuild, gearLook, isOwnerName, mergePatches, specOf, validateBuild, withPatches, smokeProblem, ABILITIES, PARTY_MAX, PARTY_SIDE_MAX, partyWaitingText } from '@arena/shared';
import { formatReport } from '@arena/shared';
import { whereIs } from './geoip';
import type { ChatChange, ChatTurn, AdminAct, AdminOnline, AdminRoom, DataPatch, ReplayData, TrainJobRow, UnitBuild } from '@arena/shared';
import { TickMeter } from './tickmeter';
import type { DevTools } from './devtools';
import type { AdminLog } from './adminlog';
import type { CustomMaps } from './custommaps';
import type { AiTune, StoredTurn } from './aitune';
import type { DevRequests } from './devrequests';
import { label as patchLabel } from './devtools';
import { PlayTime } from './playtime';
import type { ServerHealth } from './health';
import type { TimeSample } from './playtime';
import { TIME_IDLE_MS } from '@arena/shared';

import type { ArenaDef, BotTest, Brain, Build, ClassId, ClientMsg, Difficulty, PracticeDifficulty, ServerMsg, TeamId, TeamSize } from '@arena/shared';

type JoinMsg = Extract<ClientMsg, { t: 'join' }>;

/** Spectators see ranked matches this far behind, so watching cannot help the players. */
const SPECTATE_DELAY_MS = 5000;
const MS_AFTER_END = 300 * 1000; // the end screen is a ready check: the room stays open until everyone is ready or leaves (or sits idle this long)
/** A match must have been live this long to count towards gear unlocks (stops instant-win farming). */
const MIN_COUNTED_MATCH_MS = 20000;

export interface Player {
  id: number;
  ws: WebSocket;
  name: string;
  classId: ClassId;
  unitId?: number;
  room?: Room;
  /** Verified progress and the validated build chosen at join. */
  matches: number;
  wins: number;
  build?: Build;
  /** What the player has picked in the menu while in a party (shown to the others): class, spec and a gear summary. */
  view?: { classId: ClassId; spec: string; look: string };
  /** Network address, for rate limiting account actions. */
  ip: string;
  /** When the connection opened, and the country the host's proxy reported, if any. */
  since?: number;
  country?: string;
  /** Signed-in account (authoritative progress and rating) and its session token. */
  account?: AccountRecord;
  token?: string;
  /** Owner code entered for this session: custom styles, GIF icon, admin panel. */
  ownerOk?: boolean;
  /** Account actions run one at a time per connection. */
  chain: Promise<void>;
  lastSettingsSave?: number;
  /** A settings upload that arrived inside the rate-limit window, written when the window ends. */
  settingsLater?: string;
  /** Arena chosen at join: an arena id or 'random'. */
  mapPref: string;
  /** Players per team chosen at join. */
  size: TeamSize;
  /** The match this connection is watching, if any. */
  watching?: Room;
  /** Owner only, never sent to anyone: the bot unit this connection plays right now (it also stays `watching` that room). */
  ctl?: { room: Room; unitId: number };
  /** Dev tools: test numbers kept for this session, put into every match this dev plays (cleared on sign-out or by hand). */
  devSession?: DataPatch[];
  /** Owner: the account (key) this connection follows into every match it plays. */
  follow?: string;
  party?: Party;
  /** Waiting for this friend to join a duel (account key), and since when. */
  duelWith?: string;
  duelAt?: number;
  /** Account messages waiting their turn on `chain` (capped so a flood cannot pile up work). */
  pending?: number;
  /** The socket has closed: queued account work for it is skipped. */
  gone?: boolean;
  /** When the player last did something (any message but background polling), for play time: an idle menu stops counting. */
  activeAt?: number;
}

export interface Party {
  id: string;
  leader: Player;
  members: Player[];
  /** Members who pressed play and are waiting for the rest. */
  ready: Set<Player>;
  /** Which side each member plays on in a party match. */
  sides: Map<Player, 0 | 1>;
}

interface Invite {
  id: string;
  kind: 'party' | 'duel';
  from: Player;
  to: Player;
  at: number;
  /** For party invites: the party it was for. */
  party?: Party;
}

const INVITE_TTL_MS = 60000;
const DUEL_WAIT_MS = 30000;
/** Leaving a ranked match during the countdown keeps you out of the ranked queue this long. */
export const QUEUE_BAN_MS = 60000;
/** Account messages a connection may have waiting at once; more are dropped. */
const MAX_PENDING_ACCOUNT_MSGS = 8;
/** One suggestion per account and per network address this often. */
const SUGGEST_GAP_MS = 20000;

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
/** How long an announcement is still shown to people who come online after it. */
const ANNOUNCE_KEEP_MS = 10 * 60_000;

export function send(p: Player, msg: ServerMsg): void {
  if (p.ws.readyState === 1 /* OPEN */) p.ws.send(JSON.stringify(msg));
}

/** Who is told which bots are playing an experimental brain: the owner (code entered) and accounts with the dev tag. Nobody else, ever. */
export function canSeeBotTests(p: Player): boolean {
  return !!p.ownerOk || !!p.account?.grants?.includes('dev');
}

/** The arena every duel is played on. */
export const DUEL_MAP = 'overlook';

/** An arena id, resolving 'random' (or anything unknown) to a random arena. */
export function pickMap(pref: string, avoid?: string): string {
  if (findArena(pref) && !mapDisabled(pref)) return pref; // a custom map can be picked by name; it is never in the random pool below
  const open = ARENAS.filter((a) => a.randomPool !== false);
  const pool = open.some((a) => !mapDisabled(a.id)) ? open.filter((a) => !mapDisabled(a.id)) : open; // switched off maps are left out (unless that leaves none)
  const fresh = pool.filter((a) => a.id !== avoid); // never the arena that was just played
  const from = fresh.length ? fresh : pool;
  return from[Math.floor(Math.random() * from.length)].id;
}

/**
 * The map a queued player asks for. Custom maps are for practice, parties and the owner's bot matches only: the ranked and
 * the normal queue (which pair people who ask for the same map) treat a custom pick as 'random', so the pool is built-ins.
 */
export const queuePref = (pref: string): string => (isCustomArena(pref) || mapDisabled(pref) ? 'random' : pref);

export class Room {
  readonly sim: ArenaSim;
  readonly players = new Map<number, Player>(); // unitId -> player
  closed = false;
  private bots: Bot[] = [];
  /** Owner takeovers (secret): unit id -> the owner's connection and the bot that was stopped. */
  private ctl = new Map<number, { p: Player; bot: Bot }>();
  /** A bot was played by the owner at some point: no learning from this match (internal, never sent). */
  private tookOver = false;
  /** Which learned brain each bot is playing with, to credit the result at the end. */
  private botMeta: { unitId: number; classId: ClassId; variantId: string; difficulty: string; /** The brain the bot was handed (a variant can be rebuilt later). */ brain: Brain }[] = [];
  /** The testing markers went out once (on the first tick). */
  private testsSent = false;
  learner?: BotLearner;
  private botsReported = false;
  private endedTicks = 0;
  private finalSent = false;
  private finalSentLate = false;
  /** Who has pressed Play again, and what the lobby needs to rebuild the match when everyone has. */
  private rematchVotes = new Set<Player>();
  /** Per team: what identity its players were sent; and who has had their first complete frame (see snapslim.ts). */
  private encoders = new Map<number, SlimEncoder>();
  private slimSeen = new Set<Player>();
  onRematch: ((room: Room) => void) | null = null;
  /** Ranked only: someone left before the gates opened. The lobby cancels the match and puts the others back in the queue. */
  onAbort: ((room: Room, leaver: Player) => void) | null = null;
  /** Ranked only: Play again after someone left. There is no rematch without the full roster, so the voter goes back to the queue. */
  onRequeue: ((room: Room, p: Player) => void) | null = null;
  /** How many people started the match (a ranked rematch needs all of them). */
  private startedHumans = 0;
  /** Whether the replay is worth storing for everyone to open (ranked, party and duel matches; not solo practice). */
  keepReplay = true;
  private npcPlan: { classId: ClassId; team: TeamId; difficulty: PracticeDifficulty }[] = [];

  private credited = false;
  readonly id = crypto.randomBytes(6).toString('hex');
  /** Players per team, for the match record. */
  size: TeamSize = 2;
  readonly spectators = new Set<Player>();
  /** Set by the lobby so friends see who is in a match. */
  notify: ((p: Player) => void) | null = null;
  private delayed: { snap: Snapshot; events: SimEvent[] }[] = [];
  private recorder: ReplayRecorder | null = null;
  private seed = 0;
  private prepMsUsed = 0;
  private startedWall = Date.now();
  /** Account key and rating change per unit, filled in as results arrive. */
  private keys = new Map<number, string>();
  private ratingAtStart = new Map<number, number>();
  private deltas = new Map<number, { rating: number; delta: number }>();

  /** `countsForProgress`: whether finishing this match earns gear-tier progress (not true for dummy practice). */
  constructor(prepMs: number, private countsForProgress = true, private minCountedMs = MIN_COUNTED_MATCH_MS, private ranked = false, private accounts?: Accounts, public arenaId: string = ARENAS[0].id, readonly tickMs: number = TUNING.tickMs) {
    this.seed = Math.floor(Math.random() * 2 ** 31);
    this.prepMsUsed = prepMs;
    this.sim = new ArenaSim({ tickMs, prepMs, seed: this.seed, arena: arenaById(arenaId), facing: true });
    // matches that count are recorded so they can be replayed; dummy practice is not worth storing
    // every match is recorded (the owner can watch any of them again, and train bots on it)
    if (accounts) this.recorder = new ReplayRecorder(this.sim, { arena: arenaId, seed: this.seed, prepMs });
  }

  /** How many ticks of this room last `ms` milliseconds (at least one). */
  ticksIn(ms: number): number {
    return Math.max(1, Math.round(ms / this.tickMs));
  }

  get isRanked(): boolean {
    return this.ranked;
  }

  addPlayer(p: Player, team: TeamId): void {
    const u = this.sim.addUnit({ name: p.name, classId: p.classId, team, controller: 'player', build: p.build });
    p.unitId = u.id;
    p.room = this;
    this.players.set(u.id, p);
    this.startedHumans++;
    if (p.account) {
      this.keys.set(u.id, p.account.key);
      this.ratingAtStart.set(u.id, p.account.rating);
    }
    this.notify?.(p);
    send(p, { t: 'welcome', protocol: PROTOCOL_VERSION, unitId: u.id, team, classId: p.classId, spec: u.spec, ...(barSwapped(u.classId, u.spec, u.bar) ? { bar: u.bar } : {}), map: this.arenaId, tickMs: this.tickMs });
    if (!p.account) send(p, { t: 'profile', token: issueProfile({ matches: p.matches, wins: p.wins }), matches: p.matches, wins: p.wins });
    this.onJoin?.(p);
    if (this.devPatches.length || this.paused || this.sim.noCooldowns) send(p, { t: 'dev_state', paused: this.paused, patches: this.devPatches, noCooldowns: this.sim.noCooldowns });
  }

  /** The owner's "train on every match" switch, read when the match ends. */
  autoTrain?: () => boolean;
  /** The bots already studied this match the usual way (people against bots, counted). */
  private studied = false;

  /** A player joined (the lobby brings in a dev's session numbers). */
  onJoin?: (p: Player) => void;

  /** Tell everyone in the room how the signed-in players want to be shown (emblem, title, name colour). */
  roster(): RosterEntry[] {
    const people = [...this.players.entries()]
      .filter(([, p]) => p.account)
      .map(([unitId, p]) => ({ unitId, rating: p.account!.rating, ...resolveCosmetics(p.account!.cosmetics), avatarUrl: p.account!.avatar ? `/avatar/${p.account!.key}?v=${p.account!.avatar}` : undefined }));
    // bots wear their spec as the title (their name is "Bot <Name>"), so it stays clear what each one is; no colour of their own
    const bots = this.realUnits()
      .filter((u) => u.controller === 'bot')
      .map((u) => ({ unitId: u.id, rating: 0, emblem: '🤖', title: specOf(u.classId, u.spec ?? '')?.name ?? CLASSES[u.classId].name, color: '' }));
    return [...people, ...bots];
  }

  /** The names bots may take ("Bot <Name>"); the lobby points this at the owner's list. */
  botNames: () => readonly string[] = () => DEFAULT_BOT_NAMES;

  broadcastRoster(): void {
    const players = this.roster();
    if (!players.length) return;
    for (const p of [...this.players.values(), ...this.spectators]) send(p, { t: 'roster', players });
  }

  /** Any match with a person in it can be watched while it runs (dummy training is private and skipped). */
  get watchable(): boolean {
    // bot matches the owner starts are open to everyone in Watch live too
    return ((this.countsForProgress && this.players.size > 0) || this.botsOnly) && !this.closed && this.sim.phase !== 'ended';
  }

  live(): LiveMatch {
    return {
      id: this.id,
      map: this.arenaId,
      size: this.size,
      elapsedMs: Math.max(0, Math.round(this.sim.time - this.sim.prepEndsAt)),
      ranked: this.ranked,
      players: this.realUnits().map((u) => ({ name: u.name, classId: u.classId, team: u.team })),
      ...(this.botsOnly ? { bots: true } : {}),
    };
  }

  /** The units that are people, bots and dummies: Mirror Images are copies and never count as part of the roster, scoreboard or result. */
  private realUnits(): Unit[] {
    return [...this.sim.units.values()].filter((u) => !u.image);
  }

  /** Running damage and healing totals per unit, for the owner's scoreboard. */
  private totals = new Map<number, { dmg: number; heal: number; taken: number; healTaken: number; overheal: number }>();

  private tally(events: SimEvent[]): void {
    const row = (id: number) => {
      let r = this.totals.get(id);
      if (!r) this.totals.set(id, (r = { dmg: 0, heal: 0, taken: 0, healTaken: 0, overheal: 0 }));
      return r;
    };
    for (const e of events) {
      if (e.t === 'damage') {
        const n = e.amount + e.absorbed;
        const by = this.sim.units.get(e.src)?.image?.owner ?? e.src; // what an image does counts for its caster
        if (by >= 0 && by !== e.tgt && !this.sim.units.get(e.tgt)?.image) row(by).dmg += n;
        if (!this.sim.units.get(e.tgt)?.image) row(e.tgt).taken += n;
      } else if (e.t === 'heal') {
        row(e.src).heal += e.amount;
        row(e.src).overheal += e.overheal;
        row(e.tgt).healTaken += e.amount;
      }
    }
  }

  statRows(): StatRow[] {
    return this.realUnits().map((u) => {
      const t = this.totals.get(u.id);
      return { id: u.id, name: u.name, classId: u.classId, team: u.team, dmg: Math.round(t?.dmg ?? 0), heal: Math.round(t?.heal ?? 0), taken: Math.round(t?.taken ?? 0), healTaken: Math.round(t?.healTaken ?? 0), overheal: Math.round(t?.overheal ?? 0) };
    });
  }

  addSpectator(p: Player): void {
    this.spectators.add(p);
    p.watching = this;
    send(p, { t: 'spectating', id: this.id, map: this.arenaId, size: this.size });
    const players = this.roster();
    if (players.length) send(p, { t: 'roster', players });
    if (p.ownerOk) send(p, { t: 'stats', rows: this.statRows() });
    send(p, { t: 'builds', units: this.builds() });
    this.sendBotTests(p);
  }

  /** The classes of the bots in this match (a note for the bots without a class tag moves these). */
  botClasses(): ClassId[] {
    return [...new Set(this.realUnits().filter((u) => u.controller === 'bot' && !u.image).map((u) => u.classId))];
  }

  /** Seconds into the fight, or undefined once it is over (a note written now is a live note). */
  liveSec(): number | undefined {
    return this.sim.phase === 'ended' ? undefined : Math.max(0, Math.round((this.sim.time - this.sim.prepEndsAt) / 1000));
  }

  /**
   * The testing markers: which bots play a brain that differs from the shipped one, and what they are trying. Built from the
   * learner's own variant records. Owner and devs only: it is its own message, never part of a snapshot, a replay or anything
   * the other clients get. A unit an owner is playing by hand has none.
   */
  botTestsMsg(): Extract<ServerMsg, { t: 'bot_tests' }> | null {
    const bots = this.bots.length + this.ctl.size;
    if (!bots) return null;
    const units: BotTest[] = [];
    if (this.learner) {
      for (const m of this.botMeta) {
        if (this.ctl.has(m.unitId) || !this.bots.some((b) => b.unitId === m.unitId)) continue;
        const t = this.learner.variantTest(m.classId, m.variantId, m.brain);
        if (t) units.push({ unit: m.unitId, ...t });
      }
    }
    return { t: 'bot_tests', match: this.id, bots, units };
  }

  /** Send the markers to one viewer, or to every owner and dev in the match (players, watchers, an owner playing a bot). */
  sendBotTests(only?: Player): void {
    const msg = this.botTestsMsg();
    if (!msg) return;
    const to = only ? [only] : [...new Set([...this.players.values(), ...this.spectators, ...[...this.ctl.values()].map((c) => c.p)])];
    for (const q of to) if (canSeeBotTests(q)) send(q, msg);
  }

  /** Every unit's spec, talents and bar, for people watching (and a dev in the match). */
  builds(): UnitBuild[] {
    return this.realUnits().map((u) => ({ id: u.id, name: u.name, classId: u.classId, team: u.team, spec: u.spec, talents: u.talents, bar: u.bar, ...(u.controller === 'bot' ? { bot: true } : {}) }));
  }

  /**
   * Owner only, silent: the owner plays a bot's unit. The unit stays a bot to the sim, the replay and every message other people
   * get (name, look, flags); only this one connection is bound to it, with the same view its team gets. Returns why not, or null.
   */
  takeOverCheck(unitId: number): string | null {
    const u = this.sim.units.get(unitId);
    if (this.closed || this.sim.phase === 'ended') return 'That match is over.';
    if (!u || u.image || u.controller !== 'bot' || !this.bots.some((b) => b.unitId === unitId)) return 'That unit is not a bot.';
    return null;
  }

  takeOver(p: Player, unitId: number): string | null {
    const why = this.takeOverCheck(unitId);
    if (why) return why;
    const u = this.sim.units.get(unitId)!;
    this.handBack(p);
    const i = this.bots.findIndex((b) => b.unitId === unitId);
    const [bot] = this.bots.splice(i, 1);
    this.spectators.delete(p);
    this.ctl.set(unitId, { p, bot });
    p.ctl = { room: this, unitId };
    p.watching = this;
    this.tookOver = true; // what the bots did in this match says nothing about how they play
    send(p, { t: 'controlling', protocol: PROTOCOL_VERSION, unitId, team: u.team, classId: u.classId, spec: u.spec, ...(barSwapped(u.classId, u.spec, u.bar) ? { bar: u.bar } : {}), map: this.arenaId, tickMs: this.tickMs });
    const players = this.roster();
    if (players.length) send(p, { t: 'roster', players });
    send(p, { t: 'builds', units: this.builds() });
    if (this.devPatches.length || this.paused || this.sim.noCooldowns) send(p, { t: 'dev_state', paused: this.paused, patches: this.devPatches, noCooldowns: this.sim.noCooldowns });
    this.sendBotTests(); // the unit played by hand has no marker any more
    return null;
  }

  /**
   * Mind Control: the priest's screen switches to the unit they took (their own commands drive it in the sim) and back when it ends.
   * Everyone on a team already gets the same view, and the taken unit is on the priest's team meanwhile, so nothing else changes.
   */
  private mindView(casterId: number, targetId: number | null, until?: number): void {
    const p = [...this.players.values()].find((q) => q.unitId === casterId);
    if (!p) return; // a bot has no screen
    const u = this.sim.units.get(targetId ?? casterId);
    if (!u) return;
    send(p, { t: 'controlling', protocol: PROTOCOL_VERSION, unitId: u.id, team: u.team, classId: u.classId, spec: u.spec, ...(barSwapped(u.classId, u.spec, u.bar) ? { bar: u.bar } : {}), map: this.arenaId, tickMs: this.tickMs, mind: targetId === null ? 'own' : 'control', ...(until !== undefined ? { until } : {}) });
  }

  /** Give the unit back to a fresh bot at once, nothing said to anyone. The owner is neither spectator nor player afterwards. */
  handBack(p: Player): void {
    const c = p.ctl;
    if (!c || c.room !== this) return;
    p.ctl = undefined;
    const held = this.ctl.get(c.unitId);
    this.ctl.delete(c.unitId);
    this.slimSeen.delete(p);
    const u = this.sim.units.get(c.unitId);
    if (held && u && !this.closed) {
      const learned = this.learner?.pick(u.classId);
      this.bots.push(new Bot(this.sim, c.unitId, held.bot.difficulty, Math.floor(Math.random() * 2 ** 31), learned?.brain));
      this.botMeta = this.botMeta.filter((m) => m.unitId !== c.unitId);
      if (learned) this.botMeta.push({ unitId: c.unitId, classId: u.classId, variantId: learned.variantId, difficulty: held.bot.difficulty, brain: learned.brain });
      this.sendBotTests(); // a fresh brain: the marker says what it is trying now
    }
  }

  /** Hand the unit back and go on watching the match. */
  releaseControl(p: Player): void {
    if (p.ctl?.room !== this) return;
    this.handBack(p);
    if (!this.closed) this.addSpectator(p);
  }

  /** Dev tools: the match starts over with the same units and builds. */
  devRestart(): void {
    this.devTest = true;
    withPatches(this.devPatches, () => this.sim.resetMatch());
    // the bots start with a clear head too
    this.bots = this.bots.map((b) => new Bot(this.sim, b.unitId, b.difficulty, Math.floor(Math.random() * 2 ** 31)));
    this.botMeta = []; // these bots play the default brain: nothing to mark
    this.sendBotTests();
    this.endedTicks = 0;
    this.finalSent = false;
    this.finalSentLate = false;
    this.paused = false;
    this.clearInputs();
  }

  /** Drop every queued movement input (a pause or a restart). */
  clearInputs(): void {
    for (const u of this.sim.units.values()) u.inputQueue.length = 0;
  }

  /** Dev tools: the same match on another map: units, builds, bots, dummies and live numbers stay, everyone is back at the new spawns. */
  devSwapMap(id: string): void {
    this.devTest = true;
    this.arenaId = id;
    this.recorder = null; // the recording knows one map; a swapped match is never stored as a replay
    withPatches(this.devPatches, () => this.sim.switchArena(arenaById(id)));
    this.bots = this.bots.map((b) => new Bot(this.sim, b.unitId, b.difficulty, Math.floor(Math.random() * 2 ** 31)));
    this.botMeta = [];
    this.sendBotTests();
    this.endedTicks = 0;
    this.finalSent = false;
    this.finalSentLate = false;
    this.delayed = [];
    this.clearInputs();
    this.pausedTicks = 0; // a paused room sends its next frame at once, so every screen learns the new positions now
  }

  /** Dev tools: a bot gets another class and build in the middle of the match (which then counts for nothing). */
  devRebuild(unitId: number, classId: ClassId, build: Build, own = false): boolean {
    const i = this.bots.findIndex((b) => b.unitId === unitId);
    const u = this.sim.units.get(unitId);
    if (!u) return false;
    // a bot, or the dev's own unit
    if (!(u.controller === 'bot' && i >= 0) && !(own && u.controller === 'player')) return false;
    this.devTest = true;
    // a rebuilt bot keeps its name; its title (the spec) follows in the roster
    withPatches(this.devPatches, () => this.sim.rebuildUnit(unitId, classId, build));
    if (i >= 0) this.bots[i] = new Bot(this.sim, unitId, this.bots[i].difficulty, Math.floor(Math.random() * 2 ** 31));
    this.broadcastRoster();
    this.botMeta = this.botMeta.filter((m) => m.unitId !== unitId);
    this.sendBotTests();
    return true;
  }

  /** This match, as the owner's admin panel lists it. */
  adminRow(owner = false, viewer?: Player): AdminRoom {
    const humans = this.players.size;
    const bots = this.realUnits().filter((u) => u.controller === 'bot').length;
    const kind: AdminRoom['kind'] = this.botsOnly ? 'bots' : this.ranked ? 'ranked' : humans > 1 && !bots ? 'party' : bots ? 'practice' : 'dummies';
    return {
      id: this.id, map: this.arenaId, size: this.size, kind, elapsedMs: Math.max(0, Math.round(this.sim.time - this.sim.prepEndsAt)),
      players: this.realUnits().map((u) => ({ name: u.name, classId: u.classId, team: u.team, human: u.controller === 'player', ...(owner ? { id: u.id, bot: u.controller === 'bot' && !u.image } : {}) })),
      ...(owner && viewer?.ctl?.room === this ? { youControl: viewer.ctl.unitId } : {}),
      watchers: this.spectators.size, devTest: this.devTest, paused: this.paused, watchable: this.watchable, ...(this.sim.noCooldowns ? { noCooldowns: true } : {}),
    };
  }

  /** A one-on-one between two friends (a duel), for play time. */
  duel = false;

  /** An owner's private bot match: nobody plays in it, and it closes once nobody is watching. */
  botsOnly = false;

  removeSpectator(p: Player): void {
    this.handBack(p); // an owner playing a bot who leaves, switches match or goes offline gives it back first
    this.spectators.delete(p);
    p.watching = undefined;
    if (this.botsOnly && this.spectators.size === 0 && this.ctl.size === 0) this.close('match over');
  }

  /** Average rating of the humans on a team; guests and bots count as the starting rating. */
  private teamAvg(team: number): number {
    const r: number[] = [];
    for (const [id, p] of this.players) if (this.sim.units.get(id)?.team === team) r.push(p.account?.rating ?? START_RATING);
    return r.length ? r.reduce((a, b) => a + b, 0) / r.length : START_RATING;
  }

  /** A stand-in that never acts (difficulty 'dummy') or a bot that plays by the normal rules. */
  addNpc(classId: ClassId, team: TeamId, difficulty: PracticeDifficulty, spec?: string): void {
    this.npcPlan.push({ classId, team, difficulty });
    const label = CLASSES[classId].name;
    if (difficulty === 'dummy') {
      this.sim.addUnit({ name: `Dummy ${label}`, classId, team, controller: 'dummy' });
      return;
    }
    const seed = Math.floor(Math.random() * 2 ** 31);
    const build = botBuild(classId, seed, true, spec);
    // "Bot <Name>" from the owner's list, unique in this match; the roster gives it the spec as its title
    const taken = new Set([...this.sim.units.values()].map((x) => x.name));
    const u = this.sim.addUnit({ name: pickBotName(this.botNames(), taken), classId, team, controller: 'bot', build });
    const learned = this.learner?.pick(classId);
    this.bots.push(new Bot(this.sim, u.id, difficulty as Difficulty, seed, learned?.brain));
    if (learned) this.botMeta.push({ unitId: u.id, classId, variantId: learned.variantId, difficulty, brain: learned.brain });
  }

  command(p: Player, msg: ClientMsg): void {
    // a dev's test numbers hold only while this room runs (they are put back afterwards)
    withPatches(this.devPatches, () => this.commandNow(p, msg));
  }

  private commandNow(p: Player, msg: ClientMsg): void {
    const mine = p.ctl?.room === this ? p.ctl.unitId : undefined; // the owner playing a bot
    const id = p.unitId ?? mine;
    if (id === undefined || this.closed) return;
    if (mine !== undefined && (msg.t === 'mark' || msg.t === 'rematch')) return; // nothing the others could notice
    // paused by a dev: nothing a player sends moves the match on
    if (this.paused && (msg.t === 'input' || msg.t === 'cast' || msg.t === 'target' || msg.t === 'auto')) return;
    switch (msg.t) {
      case 'input':
        this.sim.queueInput(id, { seq: msg.seq, fwd: msg.fwd, strafe: msg.strafe, facing: msg.facing, jump: msg.jump });
        break;
      case 'target': {
        const r = this.sim.setTarget(id, msg.id);
        if (!r.ok) send(p, { t: 'error', reason: r.reason });
        break;
      }
      case 'cast': {
        const rewind = msg.vt !== undefined ? this.sim.time - msg.vt : 0; // how far behind live the player's screen was
        const r = this.sim.useAbility(id, msg.ability, msg.target, msg.x !== undefined && msg.z !== undefined ? { x: msg.x, z: msg.z, ...(msg.lv === 1 ? { lv: 1 as const } : {}) } : null, rewind);
        if (!r.ok) send(p, { t: 'error', reason: r.reason, ability: msg.ability });
        break;
      }
      case 'auto':
        this.sim.setAutoAttack(id, msg.on);
        break;
      case 'autoOff':
        this.sim.setAutoDisabled(id, msg.off);
        break;
      case 'mark':
        this.mark(p, msg.unit, msg.mark);
        break;
      case 'rematch':
        if (this.sim.phase !== 'ended') break;
        if (msg.on && this.ranked && this.players.size < this.startedHumans && this.onRequeue) {
          // a ranked rematch is only ever the full roster; with someone gone, Play again means the queue
          this.onRequeue(this, p);
          break;
        }
        if (msg.on) this.rematchVotes.add(p);
        else this.rematchVotes.delete(p);
        this.afterVote();
        break;
    }
  }

  /** Tell everyone how many are ready, and start the next match once all of them are. */
  private afterVote(): void {
    for (const q of this.players.values()) send(q, { t: 'rematch', ready: this.rematchVotes.size, total: this.players.size, you: this.rematchVotes.has(q) });
    if (this.ranked && this.players.size < this.startedHumans) return; // never a ranked rematch with part of the roster
    if (this.sim.phase === 'ended' && !this.closed && this.players.size > 0 && this.rematchVotes.size >= this.players.size) this.onRematch?.(this);
  }

  /** What the lobby needs to play this match again. */
  rematchPlan() {
    return {
      prepMs: this.prepMsUsed, counts: this.countsForProgress, ranked: this.ranked, map: this.arenaId, size: this.size, npcs: this.npcPlan, keepReplay: this.keepReplay,
      humans: [...this.players.entries()].map(([id, p]) => ({ p, team: this.sim.units.get(id)!.team })),
    };
  }

  /** Hand every player over to the next match without telling them the room closed. */
  release(): void {
    for (const p of this.players.values()) {
      p.room = undefined;
      p.unitId = undefined;
    }
    this.players.clear();
    this.close('match over');
  }

  removePlayer(p: Player): void {
    this.rematchVotes.delete(p);
    if (p.unitId !== undefined) {
      if (this.ranked && this.sim.phase === 'prep' && this.players.size > 1 && this.onAbort) {
        // gone before the gates opened: nobody is made to play a man down, the match is called off
        this.onAbort(this, p);
        return;
      }
      if (this.sim.phase !== 'ended') {
        // leaving a live ranked match is a loss, charged to the account that started it (signing out first changes nothing)
        const me = this.sim.units.get(p.unitId);
        const key = this.keys.get(p.unitId);
        if (this.ranked && this.accounts && key && me && this.sim.phase === 'live') {
          const before = this.ratingAtStart.get(p.unitId) ?? START_RATING;
          this.accounts
            .recordForfeit(key, this.teamAvg(1 - me.team))
            .then((a) => {
              if (!a) return;
              this.deltas.set(me.id, { rating: a.rating, delta: a.rating - before });
              if (p.account?.key === a.key) {
                p.account = a;
                send(p, { t: 'account', account: publicInfo(a, p.ownerOk) });
              }
            })
            .catch(() => {});
        }
        this.sim.forfeit(p.unitId);
      }
      this.players.delete(p.unitId);
    }
    p.room = undefined;
    p.unitId = undefined;
    if (this.players.size === 0) this.close('Everyone left the match.'); // and anyone watching is told, not left hanging
    else if (this.sim.phase === 'ended') this.afterVote(); // the ones still here may all be ready already
    this.notify?.(p);
  }

  /** Call the match off before it started: everyone still in it is handed back to the lobby (no 'closed' sent here). */
  abort(): Player[] {
    const were = [...this.players.values()];
    for (const p of were) {
      p.room = undefined;
      p.unitId = undefined;
    }
    this.players.clear();
    this.close('match cancelled');
    return were;
  }

  /** Raid marks per team: unit id -> mark (1-8). Each mark sits on one unit at a time, each unit wears one mark. */
  private marks = new Map<TeamId, Map<number, number>>();

  /** A player marks a unit for their team (0 clears it); the team sees it over the unit's head. */
  mark(p: Player, unitId: number, mark: number): void {
    const me = p.unitId !== undefined ? this.sim.units.get(p.unitId) : undefined;
    if (!me || !this.sim.units.has(unitId)) return;
    const team = this.marks.get(me.team) ?? new Map<number, number>();
    this.marks.set(me.team, team);
    this.sim.raidMarks.set(me.team, team); // the bots follow them (skull: kill this first)
    const had = team.get(unitId);
    team.delete(unitId); // 0, or the same mark again, takes it off
    if (mark > 0 && had !== mark) {
      for (const [u, m] of team) if (m === mark) team.delete(u); // the mark moves from whoever wore it
      team.set(unitId, mark);
    }
    const msg: ServerMsg = { t: 'marks', marks: [...team] };
    for (const q of this.players.values()) if (q.unitId !== undefined && this.sim.units.get(q.unitId)?.team === me.team) send(q, msg);
  }

  /** Dev tools: the test numbers in this match, whether it is paused, and whether either ever happened (then it counts for nothing). */
  devPatches: DataPatch[] = [];
  paused = false;
  /** Who paused it (shown in the Paused banner). */
  pausedBy = '';
  devTest = false;
  private pausedTicks = 0;

  /** Everyone who is sent their own unit's view: the players, and an owner playing a bot (who gets exactly what a player on that side gets). */
  private viewers(): [Player, number][] {
    const v: [Player, number][] = [];
    for (const p of this.players.values()) v.push([p, p.unitId!]);
    for (const [id, c] of this.ctl) v.push([c.p, id]);
    return v;
  }

  tick(): void {
    withPatches(this.devPatches, () => this.tickNow());
  }

  private tickNow(): void {
    if (this.paused) {
      // nothing moves; the players get a paused frame now and then so their screen says so
      if (this.pausedTicks++ % this.ticksIn(250) === 0) {
        for (const [p, id] of this.viewers()) {
          const me = this.sim.units.get(id);
          if (me && p.ws.readyState === 1) p.ws.send(JSON.stringify({ t: 'snapshot', snap: { ...this.sim.snapshot(me.team), paused: true, ...(this.pausedBy ? { pausedBy: this.pausedBy } : {}) }, events: [] }));
        }
        // watchers see it paused too (late watchers stay on their delayed view, which stops moving)
        if (this.spectators.size) {
          const frame = JSON.stringify({ t: 'snapshot', snap: { ...this.sim.snapshot(), paused: true, ...(this.pausedBy ? { pausedBy: this.pausedBy } : {}) }, events: [] });
          for (const w of this.spectators) if (w.ownerOk && w.ws.readyState === 1) w.ws.send(frame);
        }
      }
      return;
    }
    if (!this.testsSent) {
      this.testsSent = true;
      this.sendBotTests();
    }
    for (const bot of this.bots) bot.tick(); // bots queue their input for this tick, then the sim steps
    this.sim.step();
    const events = this.sim.drainEvents();
    for (const e of events) {
      if (e.t === 'mindControl') this.mindView(e.caster, e.target, e.until);
      else if (e.t === 'mindControlEnd') this.mindView(e.caster, null);
    }
    // the match is over: the owner goes back to watching it (the final scoreboard reaches spectators)
    if (this.ctl.size && this.sim.phase === 'ended') for (const c of [...this.ctl.values()]) this.releaseControl(c.p);
    // everyone on a team gets the same view, so build and serialise it once per team
    // a unit's identity (name, class, look, bar...) is not repeated every tick: it goes out with the first frame and when it changes
    const frames = new Map<number, { slim: string; first: () => string }>();
    for (const [p, id] of this.viewers()) {
      const me = this.sim.units.get(id);
      if (!me) continue;
      let frame = frames.get(me.team);
      if (frame === undefined) {
        // a stealthed enemy's casts and buffs are left out along with its position
        let enc = this.encoders.get(me.team);
        if (!enc) this.encoders.set(me.team, (enc = new SlimEncoder()));
        const { snap, info, allInfo } = enc.encode(this.sim.snapshot(me.team));
        const ev = this.sim.eventsFor(me.team, events);
        frame = {
          slim: JSON.stringify({ t: 'snapshot', snap, events: ev, ...(info.length ? { info } : {}) }),
          first: () => JSON.stringify({ t: 'snapshot', snap, events: ev, info: allInfo }),
        };
        frames.set(me.team, frame);
      }
      if (p.ws.readyState === 1 /* OPEN */) {
        p.ws.send(this.slimSeen.has(p) ? frame.slim : frame.first());
        this.slimSeen.add(p);
      }
    }
    this.tally(events);
    if (this.countsForProgress || this.spectators.size) {
      // spectators get the whole arena (nothing hidden), five seconds late; the owner watches live (a private bot match
      // has no players, only its watcher)
      const snap = this.sim.snapshot();
      if (this.countsForProgress) this.delayed.push({ snap, events });
      if (this.spectators.size) {
        // nobody plays in a bot match, so everyone watching it sees it live
        const live = [...this.spectators].filter((w) => w.ownerOk || this.botsOnly);
        if (live.length) {
          const frame = JSON.stringify({ t: 'snapshot', snap, events });
          const stats = this.sim.tickNo % this.ticksIn(500) === 0 ? JSON.stringify({ t: 'stats', rows: this.statRows() }) : null;
          for (const w of live) if (w.ws.readyState === 1) { w.ws.send(frame); if (stats) w.ws.send(stats); }
        }
      }
      if (this.delayed.length > this.ticksIn(SPECTATE_DELAY_MS)) {
        const f = this.delayed.shift()!;
        const late = [...this.spectators].filter((w) => !w.ownerOk && !this.botsOnly);
        if (late.length) {
          const frame = JSON.stringify({ t: 'snapshot', snap: f.snap, events: f.events });
          // the delayed view reaches the end five seconds after the players do, and only then gets the scoreboard
          const final = f.snap.phase === 'ended' && !this.finalSentLate ? JSON.stringify({ t: 'stats', rows: this.statRows(), final: true }) : null;
          if (final) this.finalSentLate = true;
          for (const w of late) if (w.ws.readyState === 1) { w.ws.send(frame); if (final) w.ws.send(final); }
        }
      }
    }
    if (this.sim.phase === 'ended') {
      if (!this.finalSent) {
        // everyone in the match (and the owner, who watches live) gets the final totals to put up as a scoreboard
        this.finalSent = true;
        const frame = JSON.stringify({ t: 'stats', rows: this.statRows(), final: true });
        for (const p of this.players.values()) if (p.ws.readyState === 1) p.ws.send(frame);
        for (const w of this.spectators) if (w.ownerOk && w.ws.readyState === 1) w.ws.send(frame);
      }
      this.creditProgress();
      // matches that earn nothing (bots only, dummies, test numbers, too short) still go in the owner's match list
      if (!this.recordSaved && !this.recordQueued) {
        this.recordQueued = true;
        const replay = this.recorder?.finish(this.roster()) ?? null;
        this.study(replay, false); // only with the owner's "train on every match" switch on
        void this.saveRecord(replay).catch(() => {});
      }
      this.reportBots();
      if (++this.endedTicks >= this.ticksIn(MS_AFTER_END)) this.close('match over');
    }
  }

  /**
   * Once per match, the bots study its replay. `counted`: a match that earns progress (people played it out), which the
   * bots always study the usual way. With the owner's "train on every match" switch on, every match is trained on as if
   * the owner picked it: player-only matches teach the losers' classes through the winners, bots-only matches too.
   */
  private study(replay: ReturnType<ReplayRecorder['finish']> | null, counted: boolean): void {
    if (!replay || !this.learner || this.studied || this.devTest || this.tookOver || isCustomArena(this.arenaId)) return; // a custom map teaches nothing general (and may be deleted before the replay is studied)
    const forced = !!this.autoTrain?.() && this.sim.time - this.sim.prepEndsAt >= 20000;
    if (!counted && !forced) return;
    this.studied = true;
    if (forced) void this.learner.trainOn(replay, this.id, { source: 'auto' }).catch(() => undefined);
    else void this.learner.learnFrom(replay, this.id);
  }

  /** Once per match: tell the bot learner how each bot's brain did against the humans it faced. */
  private reportBots(): void {
    if (this.botsReported) return;
    this.botsReported = true;
    if (this.devTest || this.tookOver || isCustomArena(this.arenaId)) return; // custom maps, test numbers, or a bot the owner played, say nothing about how the bots play
    const w = this.sim.winner;
    if (!this.learner || w === 'draw' || w === null || w === undefined) return;
    if (this.sim.time - this.sim.prepEndsAt < 20000) return; // a forfeit or an instant loss says nothing about play
    const humanTeams = new Set<number>();
    for (const id of this.players.keys()) {
      const t = this.sim.units.get(id)?.team;
      if (t !== undefined) humanTeams.add(t);
    }
    for (const m of this.botMeta) {
      const team = this.sim.units.get(m.unitId)?.team;
      if (team === undefined || ![...humanTeams].some((t) => t !== team)) continue;
      const bot = this.sim.units.get(m.unitId)!;
      const lasted = Math.min(1, (this.sim.time - this.sim.prepEndsAt) / 90000);
      // a win with health to spare counts for more; a loss counts for something if the bot stayed alive and lasted
      const score = w === team ? 0.7 + 0.3 * (bot.health / bot.maxHealth) : 0.3 * lasted + (bot.alive ? 0.1 : 0);
      const people = [...this.players.keys()].map((id) => this.sim.units.get(id)).filter((x) => x && x.team !== team).map((x) => x!.classId);
      this.learner.report(m.classId, m.variantId, w === team, score, people, m.difficulty);
    }
  }

  /** Once per match: players still connected earn progress, counted in your matches and wins. */
  private creditProgress(): void {
    if (this.credited) return;
    this.credited = true;
    this.finishers = [...this.players.values()];
    if (!this.countsForProgress || this.devTest || this.sim.time - this.sim.prepEndsAt < this.minCountedMs) return;
    const draw = this.sim.winner === 'draw';
    const replay = this.recorder?.finish(this.roster()) ?? null;
    this.study(replay, true); // the bots study how the people played and how they beat the bots (on a worker thread); kept for offline study too
    const jobs: Promise<void>[] = [];
    for (const p of this.players.values()) {
      const me = this.sim.units.get(p.unitId!);
      if (!me) continue;
      const won = this.sim.winner === me.team;
      if (p.account && this.accounts) {
        // signed in: the server-side account is the source of truth, and ranked matches move the rating
        const before = p.account.rating;
        jobs.push(this.accounts
          .recordMatch(p.account.name, { won, draw, rated: this.ranked, opponentAvg: this.teamAvg(1 - me.team) })
          .then(async (a) => {
            if (!a) return;
            if (this.ranked) this.deltas.set(me.id, { rating: a.rating, delta: a.rating - before });
            p.account = a;
            send(p, { t: 'account', account: publicInfo(p.account, p.ownerOk) });
          })
          .catch(() => {}));
        continue;
      }
      p.matches++;
      if (won) p.wins++;
      send(p, { t: 'profile', token: issueProfile({ matches: p.matches, wins: p.wins }), matches: p.matches, wins: p.wins });
    }
    this.recordQueued = true;
    void Promise.all(jobs).then(() => this.saveRecord(replay)).catch(() => {});
  }

  /** Match history for every signed-in human who took part, plus the replay they can all open. */
  /** The match's record has been (or is being) written: once per match, whichever way it ended. */
  private recordSaved = false;
  private recordQueued = false;

  private async saveRecord(replay: ReturnType<ReplayRecorder['finish']> | null): Promise<void> {
    const acc = this.accounts;
    if (!acc || this.recordSaved) return;
    this.recordSaved = true;
    let stored = false;
    // kept for every match now: the owner's match list can play any of them again or train bots on it
    if (replay) {
      let tooBig = false;
      try {
        const gz = await gzip(JSON.stringify(replay));
        tooBig = gz.length > REPLAY_MAX_BYTES;
        stored = !tooBig && (await acc.saveReplay(this.id, gz));
      } catch {
        stored = false;
      }
      if (tooBig) for (const p of this.everyone) send(p, { t: 'notice', text: 'That match was too long to keep a replay of. Your result still counts.' });
    }
    const players: MatchPlayer[] = this.realUnits().map((u) => {
      const d = this.deltas.get(u.id);
      return { name: u.name, classId: u.classId, spec: u.spec, team: u.team, human: u.controller === 'player', ...(d ? { rating: d.rating, delta: d.delta } : {}) };
    });
    const rec: MatchRecord = { id: this.id, at: Date.now(), size: this.size, ranked: this.ranked, map: this.arenaId, durationMs: Math.max(0, Math.round(this.sim.time - this.sim.prepEndsAt)), winner: this.sim.winner, players, replay: stored, ...(this.botsOnly ? { bots: true } : {}) };
    if (this.keys.size) await acc.addHistory([...this.keys.values()], rec);
    await acc.addFeed(rec);
  }

  /** Players who took part and are still connected to this room or just left it at the end. */
  private get everyone(): Player[] {
    return [...this.players.values(), ...this.finishers];
  }
  /** Who was in the match when it ended (they get told about the replay even if they already left the end screen). */
  private finishers: Player[] = [];

  close(reason: string): void {
    this.closed = true;
    const were = [...this.players.values()];
    for (const p of were) {
      send(p, { t: 'closed', reason });
      p.room = undefined;
      p.unitId = undefined;
    }
    this.players.clear();
    for (const p of were) this.notify?.(p);
    for (const w of this.spectators) {
      send(w, { t: 'closed', reason });
      w.watching = undefined;
    }
    this.spectators.clear();
    for (const c of this.ctl.values()) {
      send(c.p, { t: 'closed', reason });
      c.p.ctl = undefined;
      c.p.watching = undefined;
    }
    this.ctl.clear();
  }
}

export interface LobbyConfig {
  practicePrepMs: number;
  queuePrepMs: number;
  /** Live time a match needs before it counts towards gear unlocks. Defaults to 20 s. */
  minCountedMatchMs?: number;
  /** Milliseconds per tick for every room (default TUNING.tickMs; the server reads ARENA_TICK_MS). */
  tickMs?: number;
  /** The clock for play time and idle detection (tests inject a fake one). */
  now?: () => number;
}

/** What the dev tag may do in the admin panel (admin_act); everything else in AdminAct is the owner's. */
const DEV_ADMIN_ACTS: ReadonlySet<AdminAct> = new Set<AdminAct>(['history', 'log', 'feed', 'train', 'train_passes', 'train_all', 'train_status', 'bot_knowledge']);
/** How a refused action is named in the message a dev gets. */
const DEV_REFUSED: Partial<Record<AdminAct, string>> = { kick: 'Kicking players', kill: 'Killing players', time: 'Play time statistics', ban: 'Banning', unban: 'Unbanning', mute: 'Muting', unmute: 'Unmuting', set_rating: 'Changing ratings', reset_stats: 'Resetting stats', note: 'Account notes', maintenance: 'Maintenance mode', pause_match: 'Pausing other people\'s matches', cooldowns_reset: 'Resetting cooldowns', cooldowns_off: 'Switching cooldowns off', autotrain: 'The train-on-every-match switch', bot_reset: 'Resetting the learned brain', bot_commit: 'Committing the learned bots to GitHub', bug_fixed: 'Marking a bot bug fixed' };

export class Lobby {
  private rooms = new Set<Room>();
  private queue: QEntry<Player>[] = [];
  private invites = new Map<string, Invite>();
  private nextPlayerId = 1;
  private inQueue(p: Player): boolean {
    return this.queue.some((e) => e.members.includes(p));
  }

  constructor(private cfg: LobbyConfig, private accounts?: Accounts, private learner?: BotLearner, private suggestions?: Suggestions, private dev?: DevTools, private adminLog?: AdminLog, private ai?: AiTune, private requests?: DevRequests, private time?: PlayTime, private health?: ServerHealth, private customMaps?: CustomMaps) {
    this.tickMs = Math.max(1, Math.round(cfg.tickMs ?? TUNING.tickMs));
    this.meter = new TickMeter(this.tickMs);
    // the saved state, unless the owner already changed it while it loaded
    void this.adminLog?.maintenance().then((m) => {
      if (!this.maintSet) this.maint = m;
    });
    void this.adminLog?.hudDefault().then((d) => {
      if (this.hudSet || !d) return;
      this.hudDef = { t: 'hud_default', layout: d.layout, at: d.at, by: d.by };
      for (const q of this.conns) send(q, this.hudDef);
    });
    void this.adminLog?.botNames().then((n) => {
      if (!this.botNamesSet && n) this.botNames = n;
    });
    void this.adminLog?.autoTrain().then((on) => {
      if (!this.autoTrainSet) this.autoTrain = on;
    });
    // every match the bots study on their own is written in the admin log with what came of it, even when no number moved
    if (this.learner) this.learner.onStudied = (e) => void this.adminLog?.add('bots (automatic)', e.kind === 'people' ? 'studied a match with people' : 'studied a bot-only match', e.replayId, e.text);
  }

  /** The owner's switch: the bots train on every finished match (player matches and bot matches too). */
  private autoTrain = false;
  private autoTrainSet = false;

  /** The names bots take: the owner's saved list, or the built-in one. Only the owner is ever sent it. */
  private botNames: readonly string[] = DEFAULT_BOT_NAMES;
  private botNamesSet = false;

  /** The owner's default HUD layout (what every client is sent), or null. */
  private hudDef: Extract<ServerMsg, { t: 'hud_default' }> | null = null;
  private hudSet = false;

  /** Maintenance mode: while set, nobody but the owner starts a match; the text says why. */
  private maint: string | null = null;
  private maintSet = false;
  private readonly startedAt = Date.now();

  /** What /api/status and the admin overview show about the loop. */
  tickReport() {
    return { ...this.meter.report(), rooms: this.rooms.size };
  }

  /** Everyone connected, guests included, for the owner: name, address, country and what they are doing. */
  private onlineList(withAddress: boolean): AdminOnline[] {
    const now = Date.now();
    return [...this.conns].map((q) => ({
      name: q.account?.name ?? q.name, guest: !q.account, ...(withAddress ? { ip: q.ip, where: whereIs(q.ip, q.country) } : {}),
      status: q.room && !q.room.closed ? `in a ${q.room.adminRow().kind} match` : this.inQueue(q) ? 'in the queue' : 'in the menu',
      sinceMs: now - (q.since ?? now),
    })).sort((a, b) => a.sinceMs - b.sinceMs);
  }

  /** `access` decides how much: a dev gets no addresses or locations, and nothing about what only the owner may change. */
  private overviewMsg(access: 'owner' | 'dev' = 'owner', viewer?: Player): ServerMsg {
    return {
      t: 'admin_overview', online: this.conns.size, players: this.onlineList(access === 'owner'), queued: this.queue.reduce((n, e) => n + e.members.length, 0), rooms: [...this.rooms].filter((r) => !r.closed).map((r) => r.adminRow(access === 'owner', viewer)),
      uptimeMs: Date.now() - this.startedAt, version: PATCHES[0]?.version, overrides: this.dev?.overrides.length ?? 0, maintenance: this.maint,
      tick: this.tickReport(), pullRequests: !!this.dev?.canOpenPr, ai: !!this.ai?.enabled, autoTrain: this.autoTrain, notes: !!this.dev?.notifies || !!this.suggestions?.notifies,
    };
  }

  /** Every connection signed in to this account. */
  private connsOf(key: string): Player[] {
    return [...this.conns].filter((q) => q.account?.key === key);
  }

  private clock(): number {
    return this.cfg.now ? this.cfg.now() : Date.now();
  }
  private lastTimeAt = 0;

  /** What a connection is doing, for play time. */
  private timeSample(q: Player, now: number): TimeSample {
    const base = { ...(q.account ? { key: q.account.key, name: q.account.name } : { conn: q.id }) };
    const room = q.room && !q.room.closed ? q.room : undefined;
    if (room && room.sim.phase !== 'ended') {
      const u = q.unitId !== undefined ? room.sim.units.get(q.unitId) : undefined;
      const humans = room.players.size;
      const cat = room.devTest ? 'dev' : room.isRanked ? 'ranked' : room.duel ? 'duel' : humans > 1 ? 'party' : 'practice';
      return { ...base, cat, active: true, classId: u?.classId ?? q.classId, spec: u?.spec ?? q.build?.spec ?? emptyBuild(q.classId).spec, map: room.arenaId, size: room.size };
    }
    if (q.watching && !q.watching.closed) return { ...base, cat: 'spectate', active: true };
    if (this.inQueue(q) || q.duelWith !== undefined) return { ...base, cat: 'queue', active: true };
    // the menu (and the end screen of a match) stops counting when nobody has touched anything for a while
    return { ...base, cat: 'menu', active: now - (q.activeAt ?? q.since ?? now) < TIME_IDLE_MS };
  }

  /** Hand every connection's state to the play time counter. */
  private sampleTime(): void {
    if (!this.time) return;
    const now = this.clock();
    this.lastTimeAt = now;
    this.time.tick([...this.conns].map((q) => this.timeSample(q, now)), now);
  }

  /** Count the last seconds and write every record (shutdown). */
  async saveTime(): Promise<void> {
    this.sampleTime();
    await this.time?.flush().catch(() => undefined);
    await this.health?.flush().catch(() => undefined);
  }

  /** The owner's moderation and server actions (admin panel). Everything is logged. */
  private async adminAct(p: Player, msg: Extract<ClientMsg, { t: 'admin_act' }>): Promise<void> {
    const acc = this.accounts;
    const by = p.account?.name ?? p.name;
    const log = (action: string, target?: string, detail?: string) => void this.adminLog?.add(by, action, target, detail);
    const key = msg.name?.toLowerCase() ?? '';
    // the server decides what a dev may do, whatever the client shows
    const access = this.adminAccess(p);
    if (!access) return;
    if (access === 'dev' && !DEV_ADMIN_ACTS.has(msg.act)) {
      return void send(p, { t: 'dev_result', ok: false, text: `${DEV_REFUSED[msg.act] ?? 'That'} is for the owner only. The dev tag opens the panel's read and training tools.` });
    }
    switch (msg.act) {
      case 'kick': {
        const conns = this.connsOf(key);
        for (const q of conns) {
          send(q, { t: 'closed', reason: `You were removed from the server by the owner${msg.reason ? `: ${msg.reason}` : '.'}` });
          q.ws.close();
        }
        log('kick', msg.name, msg.reason);
        send(p, { t: 'dev_result', ok: true, text: conns.length ? `Kicked ${msg.name}.` : `${msg.name} is not online.` });
        break;
      }
      case 'kill': {
        const conn = this.connsOf(key).find((q) => q.room && q.unitId !== undefined);
        const killed = !!conn?.room && !conn.room.closed && conn.room.sim.adminKill(conn.unitId!);
        log('kill', msg.name, killed ? conn!.room!.id : 'not in a match');
        send(p, { t: 'dev_result', ok: killed, text: killed ? `Killed ${msg.name} in their match.` : `${msg.name} is not alive in a match right now.` });
        break;
      }
      case 'ban':
      case 'unban':
      case 'mute':
      case 'unmute':
      case 'set_rating':
      case 'reset_stats':
      case 'note': {
        if (!acc) return;
        const r = await acc.adminModerate(msg.name!, msg.act, { minutes: msg.minutes, reason: msg.reason, value: msg.value, text: msg.text, by });
        if (!r.ok) return void send(p, { t: 'admin_result', ok: false, name: msg.name!, reason: r.reason });
        for (const q of this.connsOf(r.account.key)) {
          if (msg.act === 'ban') {
            send(q, { t: 'closed', reason: bannedText(r.account) ?? 'Banned.' });
            q.ws.close();
            continue;
          }
          q.account = r.account;
          send(q, { t: 'account', account: publicInfo(r.account, q.ownerOk) });
          if (msg.act === 'mute') send(q, { t: 'notice', text: `You are muted${r.account.muted?.until ? ` until ${new Date(r.account.muted.until).toUTCString()}` : ''}: no suggestions, invites or friend requests.` });
          if (msg.act === 'unmute') send(q, { t: 'notice', text: 'You are no longer muted.' });
        }
        const detail = msg.act === 'ban' || msg.act === 'mute' ? `${msg.minutes ? `${msg.minutes} min` : 'permanent'}${msg.reason ? `: ${msg.reason}` : ''}` : msg.act === 'set_rating' ? String(msg.value) : msg.act === 'note' ? msg.text : undefined;
        log(msg.act.replace('_', ' '), r.account.name, detail);
        send(p, { t: 'admin_result', ok: true, name: r.account.name, row: acc.adminRow(r.account, this.onlineKeys().has(r.account.key)) });
        break;
      }
      case 'autotrain': {
        this.autoTrain = !!msg.on;
        this.autoTrainSet = true;
        log(this.autoTrain ? 'train on every match: on' : 'train on every match: off');
        await this.adminLog?.setAutoTrain(this.autoTrain);
        send(p, this.overviewMsg('owner', p));
        break;
      }
      case 'maintenance': {
        const text = msg.on ? (msg.text?.trim() || 'The server is in maintenance. Matches are paused for a few minutes.') : null;
        this.maint = text;
        this.maintSet = true;
        for (const q of this.conns) if (q !== p) send(q, { t: 'notice', text: text ? `🛠 ${text}` : 'Maintenance is over: matches are open again.' });
        log(text ? 'maintenance on' : 'maintenance off', undefined, text ?? undefined);
        await this.adminLog?.setMaintenance(text);
        send(p, this.overviewMsg('owner', p));
        break;
      }
      case 'pause_match': {
        const room = [...this.rooms].find((r) => r.id === msg.id && !r.closed);
        if (!room) return;
        room.paused = !!msg.on;
        room.pausedBy = room.paused ? 'the owner' : '';
        room.devTest = true; // a paused match no longer counts
        for (const q of [...room.players.values(), ...room.spectators]) {
          send(q, { t: 'dev_state', paused: room.paused, patches: room.devPatches, noCooldowns: room.sim.noCooldowns });
        }
        log(msg.on ? 'pause match' : 'resume match', room.id);
        send(p, this.overviewMsg('owner', p));
        break;
      }
      case 'cooldowns_reset':
      case 'cooldowns_off': {
        const room = [...this.rooms].find((r) => r.id === msg.id && !r.closed);
        if (!room) return;
        room.devTest = true; // a match with changed cooldowns no longer counts
        if (msg.act === 'cooldowns_reset') room.sim.resetCooldowns();
        else room.sim.noCooldowns = !!msg.on;
        if (msg.act === 'cooldowns_off' && msg.on) room.sim.resetCooldowns();
        for (const q of [...room.players.values(), ...room.spectators]) {
          send(q, { t: 'notice', text: msg.act === 'cooldowns_reset' ? 'The owner reset every cooldown (the match no longer counts).' : msg.on ? 'The owner switched cooldowns off (the match no longer counts).' : 'The owner switched cooldowns back on.' });
        }
        log(msg.act === 'cooldowns_reset' ? 'reset cooldowns' : msg.on ? 'cooldowns off' : 'cooldowns on', room.id);
        send(p, this.overviewMsg('owner', p));
        break;
      }
      case 'history': {
        if (!acc) return;
        send(p, { t: 'admin_history', name: msg.name!, rows: await acc.history(key) });
        break;
      }
      case 'time': {
        if (!this.time) return void send(p, { t: 'dev_result', ok: false, text: 'Play time tracking is off on this server.' });
        if (msg.name) send(p, { t: 'admin_time_player', name: msg.name, rec: await this.time.player(msg.name) });
        else send(p, { t: 'admin_time', ...(await this.time.overview(this.onlineKeys())), health: await this.health?.list() });
        break;
      }
      case 'log':
        send(p, { t: 'admin_log', rows: (await this.adminLog?.list()) ?? [] });
        break;
      case 'feed':
        if (acc) send(p, { t: 'admin_feed', rows: await acc.feed() });
        break;
      case 'train': {
        // training starts at once; the progress comes back as train_status
        if (!acc || !this.learner) return void send(p, { t: 'dev_result', ok: false, text: 'Bot learning is not running on this server.' });
        void this.trainOnReplay(by, () => acc.getReplay(msg.id!), msg.id!);
        break;
      }
      case 'train_passes': {
        // the owner's forced training: the same replay, several passes (1..5), so its lessons count several times
        if (!acc || !this.learner) return void send(p, { t: 'dev_result', ok: false, text: 'Bot learning is not running on this server.' });
        void this.trainOnReplay(by, () => acc.getReplay(msg.id!), msg.id!, { passes: msg.value });
        break;
      }
      case 'train_all': {
        if (!this.learner) return void send(p, { t: 'dev_result', ok: false, text: 'Bot learning is not running on this server.' });
        void this.trainOnArchive(by, msg.value);
        break;
      }
      case 'bot_knowledge':
        send(p, this.botKnowledgeMsg());
        break;
      case 'bot_reset': {
        if (!this.learner) return void send(p, { t: 'dev_result', ok: false, text: 'Bot learning is not running on this server.' });
        await this.learner.resetBrain();
        log('reset the learned bot brain');
        await this.adminLog?.add(by, 'reset learned bot brain', 'all classes');
        send(p, { t: 'dev_result', ok: true, text: 'Every class is back on the brain it ships with. What the bots learned (lessons, habits, counters and the log) is cleared.' });
        for (const q of this.panelViewers()) send(q, this.botKnowledgeMsg());
        break;
      }
      case 'bot_commit': {
        // owner only: the learner's current state (brains and human-style data) goes to the main branch in one commit that is also a patch
        const dev = this.dev;
        const learner = this.learner;
        if (!learner || !dev) return void send(p, { t: 'dev_result', ok: false, text: 'Bot learning is not running on this server.' });
        if (!dev.canOpenPr) return void send(p, { t: 'dev_result', ok: false, text: 'No GITHUB_TOKEN on the server: nothing was committed.' });
        try {
          const data = await learner.exportLive();
          const r = await dev.commitLearnedBots(data, by);
          learner.markCommitted({ version: r.version, url: r.url, matches: r.matches });
          log('committed learned bots to GitHub', r.version, `${r.matches} match${r.matches === 1 ? '' : 'es'}; brains: ${r.classes.join(', ') || 'none changed'}; ${r.url}`);
          send(p, { t: 'dev_result', ok: true, text: `Committed the learned bots to the main branch on GitHub as patch ${r.version} (${r.matches} match${r.matches === 1 ? '' : 'es'} studied; brains changed for ${r.classes.join(', ') || 'no class'}). The game updates when the next deploy finishes.`, url: r.url });
        } catch (e) {
          log('commit learned bots failed', undefined, (e as Error).message);
          send(p, { t: 'dev_result', ok: false, text: (e as Error).message });
        }
        for (const q of this.panelViewers()) send(q, this.botKnowledgeMsg());
        break;
      }
      case 'train_status':
        send(p, this.trainStatusMsg());
        break;
      case 'bug_fixed': {
        // owner only (a dev reports bugs; the owner closes them)
        if (!this.learner) return void send(p, { t: 'dev_result', ok: false, text: 'Bot learning is not running on this server.' });
        const ok = this.learner.markBug(msg.id!, msg.on !== false, by);
        log(msg.on === false ? 'reopened a bot bug' : 'marked a bot bug fixed', msg.id);
        if (!ok) send(p, { t: 'dev_result', ok: false, text: 'That bug is not in the list any more.' });
        for (const q of this.panelViewers()) send(q, this.botKnowledgeMsg());
        break;
      }
    }
  }

  // ------------------------------------------------------------------ notes for the bots

  private lastBotNote = new Map<string, number>();

  /** Which bot classes a match had, and whether it is still running (a live note). Null when the match is not known. */
  private async matchBots(id: string): Promise<{ classes: ClassId[]; liveSec?: number } | null> {
    const room = [...this.rooms].find((r) => r.id === id && !r.closed);
    if (room) return { classes: room.botClasses(), liveSec: room.liveSec() };
    const entry = (await this.learner?.archived())?.find((e) => e.id === id);
    if (entry) return { classes: [...new Set(entry.bots)] };
    try {
      const gz = await this.accounts?.getReplay(id);
      if (!gz) return null;
      const replay = JSON.parse((await gunzip(gz)).toString('utf8')) as ReplayData;
      if (!replay || !Array.isArray(replay.units)) return null;
      return { classes: [...new Set(replay.units.filter((u) => u.controller === 'bot').map((u) => u.classId))] };
    } catch {
      return null;
    }
  }

  /**
   * A note for the bots from the owner or a dev (see shared/src/botnote.ts): applied to the bots' lesson variant at once, kept
   * with the match, logged. A normal player cannot send one.
   */
  private async botNote(p: Player, msg: Extract<ClientMsg, { t: 'bot_note' }>): Promise<void> {
    if (!this.isDev(p)) return void send(p, { t: 'dev_result', ok: false, text: 'Dev tools need the dev tag.' });
    const fail = (text: string) => send(p, { t: 'bot_note_ack', id: msg.id, ok: false, text });
    const learner = this.learner;
    if (!learner) return fail('Bot learning is not running on this server.');
    const by = p.account?.name ?? p.name;
    const now = this.clock();
    if (now - (this.lastBotNote.get(by) ?? 0) < 1000) return fail('One note at a time: wait a second.');
    this.lastBotNote.set(by, now);
    const m = await this.matchBots(msg.id);
    if (!m) return fail('That match is not known any more (replays are kept for 30 days).');
    if (!m.classes.length) return fail('There were no bots in that match, so there is nothing to teach.');
    const ai = this.ai?.enabled ? this.ai : null;
    const { note, report } = await learner.addNote({ matchId: msg.id, text: msg.text, by, role: p.ownerOk ? 'owner' : 'dev', matchClasses: m.classes, liveSec: m.liveSec, ...(ai ? { interpret: (t: string) => ai.interpretNote(t, m.classes) } : {}) });
    void this.adminLog?.add(by, 'note for the bots', msg.id, `"${msg.text.slice(0, 160)}": ${report.headline.slice(0, 200)}${note.bugs.length ? ` (${note.bugs.length} bug${note.bugs.length === 1 ? '' : 's'} reported)` : ''}`);
    send(p, { t: 'bot_note_ack', id: msg.id, ok: true, text: report.headline, lines: formatReport(report), unmapped: note.unmapped, bug: note.bugs.length > 0 });
    for (const q of this.panelViewers()) send(q, this.botKnowledgeMsg());
  }

  // ------------------------------------------------------------------ bot training queue

  private trainJobs = new Map<string, TrainJobRow>();
  private trainRuns = new Map<string, Promise<{ ok: boolean; text: string }>>();
  /** Milliseconds of measuring per replay tick, learned from finished jobs (0 = not known yet). */
  private msPerTick = 0;
  private trainTimer: ReturnType<typeof setInterval> | null = null;

  private botKnowledgeMsg(): Extract<ServerMsg, { t: 'bot_knowledge' }> {
    return { t: 'bot_knowledge', classes: this.learner?.knowledge() ?? [], reports: this.learner?.learnReports() ?? [], ...(this.learner ? { live: this.learner.liveStatus() } : {}), autoTrain: this.autoTrain, canCommit: !!this.dev?.canOpenPr, ...(this.learner ? { notes: this.learner.noteList(), bugs: this.learner.bugList() } : {}) };
  }

  /** Train on every archived replay in turn, with the progress shown in the queue like any other job. */
  async trainOnArchive(by: string, passes?: number): Promise<{ ok: boolean; text: string }> {
    const id = 'all-archived';
    if (!this.learner) return { ok: false, text: 'Bot learning is not running on this server.' };
    const running = this.trainRuns.get(id);
    if (running) return running;
    const job: TrainJobRow = { id, state: 'training', startedAt: Date.now(), etaMs: 60000, progress: { done: 0, total: 0, skipped: 0 } };
    this.trainJobs.set(id, job);
    this.pushTrain();
    const run = (async (): Promise<{ ok: boolean; text: string }> => {
      try {
        const report = await this.learner!.trainArchive((p) => {
          job.progress = p;
          // the time left from the pace so far
          if (p.done > 0) job.etaMs = Math.round(((Date.now() - job.startedAt) / p.done) * p.total);
          this.pushTrain();
        }, { passes });
        job.state = 'done';
        job.report = report;
        job.text = report.headline;
        void this.adminLog?.add(by, 'train bots on all archived replays', undefined, `${report.replaysRead} read, ${report.skipped} skipped`);
      } catch {
        job.state = 'failed';
        job.text = 'Training on the archive failed.';
      }
      job.finishedAt = Date.now();
      this.trainRuns.delete(id);
      this.pushTrain();
      for (const q of this.panelViewers()) send(q, this.botKnowledgeMsg());
      return { ok: job.state === 'done', text: job.text ?? '' };
    })();
    this.trainRuns.set(id, run);
    return run;
  }

  private trainStatusMsg(): Extract<ServerMsg, { t: 'train_status' }> {
    const jobs = [...this.trainJobs.values()].sort((a, b) => b.startedAt - a.startedAt);
    return { t: 'train_status', jobs, active: jobs.filter((j) => j.state === 'training').length };
  }

  private pushTrain(): void {
    const msg = this.trainStatusMsg();
    for (const q of this.panelViewers()) send(q, msg);
    // while something trains, the time left is refreshed every second
    if (msg.active && !this.trainTimer) {
      this.trainTimer = setInterval(() => this.pushTrain(), 1000);
      this.trainTimer.unref();
    } else if (!msg.active && this.trainTimer) {
      clearInterval(this.trainTimer);
      this.trainTimer = null;
    }
  }

  /**
   * Train the bots on a replay the owner picked (from the match list) or uploaded: gzipped or plain JSON. Logged in the
   * admin log; resolves to a message fit to show.
   */
  async trainOnReplay(by: string, source: Buffer | (() => Promise<Buffer | null>), id: string, opts: { passes?: number } = {}): Promise<{ ok: boolean; text: string }> {
    if (!this.learner) return { ok: false, text: 'Bot learning is not running on this server.' };
    const running = this.trainRuns.get(id);
    if (running) return running; // already training on it
    const finishedAvg = [...this.trainJobs.values()].filter((j) => j.state === 'done' && j.finishedAt).map((j) => j.finishedAt! - j.startedAt);
    const guess = finishedAvg.length ? finishedAvg.reduce((x, y) => x + y, 0) / finishedAvg.length : 8000;
    const job: TrainJobRow = { id, state: 'training', startedAt: Date.now(), etaMs: Math.round(guess) };
    this.trainJobs.set(id, job);
    // only a few finished jobs are kept for the list
    for (const old of [...this.trainJobs.values()].filter((j) => j.state !== 'training').sort((x, y) => (y.finishedAt ?? 0) - (x.finishedAt ?? 0)).slice(30)) this.trainJobs.delete(old.id);
    this.pushTrain();
    const finish = (r: { ok: boolean; text: string }) => {
      job.state = r.ok ? 'done' : 'failed';
      job.finishedAt = Date.now();
      job.text = r.text;
      this.pushTrain();
      this.trainRuns.delete(id);
      return r;
    };
    const run = (async (): Promise<{ ok: boolean; text: string }> => {
      const raw = typeof source === 'function' ? await source() : source;
      if (!raw) return finish({ ok: false, text: 'That replay is gone (they are kept for 30 days).' });
      let replay: ReplayData;
      try {
        const text = (raw[0] === 0x1f && raw[1] === 0x8b ? await gunzip(raw) : raw).toString('utf8');
        replay = JSON.parse(text) as ReplayData;
        if (!replay || typeof replay !== 'object' || !Array.isArray(replay.units) || !Array.isArray(replay.cmds)) throw new Error('shape');
      } catch {
        return finish({ ok: false, text: 'That is not a replay file this game can read.' });
      }
      // the time it should take, from how long replays took before per tick of play
      if (this.msPerTick > 0 && replay.ticks > 0) {
        job.etaMs = Math.max(1000, Math.round(replay.ticks * this.msPerTick));
        this.pushTrain();
      }
      const started = Date.now();
      let r: Awaited<ReturnType<BotLearner['trainOn']>>;
      try {
        r = await this.learner!.trainOn(replay, id, { passes: opts.passes });
      } catch {
        return finish({ ok: false, text: 'Training on that replay failed.' });
      }
      if (r.ok && replay.ticks > 0) {
        const per = (Date.now() - started) / replay.ticks;
        this.msPerTick = this.msPerTick ? this.msPerTick * 0.6 + per * 0.4 : per;
      }
      void this.adminLog?.add(by, 'train bots on replay', id, r.ok ? r.report.headline.slice(0, 200) : r.reason);
      if (r.ok) {
        job.report = r.report;
        for (const q of this.panelViewers()) send(q, this.botKnowledgeMsg());
      }
      // the learner has already put the new brains into the population, so the next bots spawned can draw them
      return finish(r.ok ? { ok: true, text: r.report.headline } : { ok: false, text: r.reason });
    })();
    this.trainRuns.set(id, run);
    return run;
  }

  /**
   * Put test numbers into a match: everyone in it plays on the same numbers and sees them in their tooltips, and is told
   * who changed what. From then on the match counts for nothing (progress, rating, replays, bot learning).
   */
  private setRoomPatches(room: Room, p: Player, patches: DataPatch[]): void {
    const broken = smokeProblem(patches); // a whole entry rewritten as data must still run
    if (broken) return void send(p, { t: 'dev_result', ok: false, text: broken });
    room.devTest = true;
    room.devPatches = patches;
    // class, spec and talent numbers are worked into each unit, so they are worked out again
    withPatches(patches, () => room.sim.refreshMods());
    const by = p.account?.name ?? p.name;
    for (const q of [...room.players.values(), ...room.spectators]) {
      send(q, { t: 'dev_state', paused: room.paused, patches: room.devPatches, noCooldowns: room.sim.noCooldowns });
      if (q !== p) send(q, { t: 'notice', text: patches.length ? `${by} is testing ${patches.length} changed number${patches.length === 1 ? '' : 's'} in this match (it no longer counts${room.isRanked ? ' for rating' : ''}).` : `${by} put the real numbers back.` });
    }
  }

  /** A dev with session numbers joined a match they may test in: the match gets those numbers. */
  private bringSession(room: Room, p: Player): void {
    if (!p.devSession?.length || !this.isDev(p) || room.isRanked) return; // ranked never silently stops counting
    this.setRoomPatches(room, p, mergePatches(room.devPatches, p.devSession));
  }

  /** The dev's test numbers now: the match's, or the session's when not in one; in the Tuning tab, what they have proposed and nobody has handled yet. */
  private testingOf(p: Player, propose = false): DataPatch[] {
    if (propose) {
      const by = p.account?.name ?? p.name;
      return [...(this.dev?.proposals ?? [])].reverse().filter((r) => r.status === 'pending' && r.by === by).reduce<DataPatch[]>((acc, r) => mergePatches(acc, r.patches), []);
    }
    return this.devRoom(p)?.devPatches ?? p.devSession ?? [];
  }

  private setTesting(p: Player, list: DataPatch[]): void {
    const room = this.devRoom(p);
    if (room && !room.closed) this.setRoomPatches(room, p, list);
    else {
      p.devSession = list;
      send(p, { t: 'dev_session', patches: list });
    }
  }

  /** Claude's changes: tried in the dev's match (or kept for their session), or, in the Tuning tab, added to the proposals list. */
  private async applyAi(p: Player, rec: StoredTurn): Promise<boolean> {
    if (rec.propose) {
      if (!this.dev) return false;
      const row = await this.dev.propose(p.account?.name ?? p.name, rec.patches, 'Ask Claude');
      rec.proposalId = row.id;
      for (const q of this.panelViewers()) send(q, { t: 'proposals', rows: this.dev.proposals });
    } else {
      rec.before = this.testingOf(p);
      this.setTesting(p, mergePatches(rec.before, rec.patches));
    }
    rec.applied = true;
    return true;
  }

  /** Every dev gets their change requests (the owner all of them). */
  private sendRequests(): void {
    if (!this.requests) return;
    for (const q of this.conns) {
      if (!this.isDev(q)) continue;
      const all = this.adminAccess(q) === 'owner';
      send(q, { t: 'dev_requests', rows: this.requests.visible(q.account?.name ?? q.name, all), all });
    }
  }

  /** The owner (with the code entered this session) or an account the owner gave the 'dev' tag. */
  private isDev(p: Player): boolean {
    return !!p.ownerOk || !!p.account?.grants?.includes('dev');
  }

  /**
   * Who may use the admin panel: the owner (code entered this session) has all of it; an account with the 'dev' tag has the
   * read and operational part (see DEV_ADMIN_ACTS); everyone else, guests included, nothing. Checked on every message, from
   * the live account record, so taking the tag away takes effect at once.
   */
  adminAccess(p: Player): 'owner' | 'dev' | null {
    if (p.ownerOk) return 'owner';
    return p.account?.grants?.includes('dev') ? 'dev' : null;
  }

  /** Refuse a dev (clearly) an owner-only part of the panel. Returns true when `p` is not the owner so the caller stops. */
  private ownerOnly(p: Player, what: string): boolean {
    const access = this.adminAccess(p);
    if (access === 'owner') return false;
    if (access === 'dev') send(p, { t: 'dev_result', ok: false, text: `${what} is for the owner only. The dev tag opens the panel's read and training tools.` });
    return true;
  }

  /** Every admin-panel viewer (owner and devs) for broadcasts of what the panel shows. */
  private panelViewers(): Player[] {
    return [...this.conns].filter((q) => this.adminAccess(q) !== null);
  }

  /**
   * A match a dev may try numbers in and pause: any match they play in that is not ranked (alone against bots, or with
   * friends in practice, a party match or a duel). Everyone in it is told, and it stops counting for anything.
   */
  private devRoom(p: Player): Room | null {
    // the owner can do it anywhere: in their own match or one they are watching, ranked included (it then stops counting)
    if (p.ctl) return null; // playing a bot in secret: nothing that would announce itself to the others
    if (p.ownerOk) return p.room ?? p.watching ?? null;
    if (!this.isDev(p)) return null;
    // a dev can also tune and pause a bot match they are watching (those are made for testing)
    const r = p.room ?? (p.watching?.botsOnly ? p.watching : null);
    return r && !r.isRanked ? r : null;
  }
  /** Last suggestion time per account and per network address (old entries are swept). */
  private lastSuggest = new Map<string, number>();
  /** Accounts that left a ranked match during the countdown, and until when they may not queue ranked. */
  private queueBans = new Map<string, number>();

  private conns = new Set<Player>();
  private onlineKeys(): Set<string> {
    return new Set([...this.conns].flatMap((q) => (q.account ? [q.account.key] : [])));
  }

  /** The owner's session after a stored avatar change, so every connection of that account stays in sync. */
  syncAccount(a: AccountRecord): void {
    for (const q of this.conns) if (q.account?.key === a.key) {
      q.account = a;
      send(q, { t: 'account', account: publicInfo(a, q.ownerOk) });
    }
  }

  connect(ws: WebSocket, ip = '', country?: string): Player {
    const out = this.connectNow(ws, ip);
    out.country = country;
    // numbers a dev saved for everyone: the client applies them over its own copy of the data
    if (this.dev?.overrides.length) send(out, { t: 'overrides', patches: this.dev.overrides });
    // the owner's default HUD layout, for everyone (guests and spectators too)
    if (this.hudDef) send(out, this.hudDef);
    // the owner's custom maps, so the pickers, the scene and the minimap know them
    if (customArenas().length || disabledMaps().length) send(out, { t: 'custom_maps', maps: [...customArenas()], off: disabledMaps() });
    // a recent announcement greets people who come online just after it
    if (this.lastAnnounce && Date.now() - this.lastAnnounce.at < ANNOUNCE_KEEP_MS) send(out, this.lastAnnounce);
    return out;
  }

  /** The custom maps changed: every connected client gets the new list (their pickers and scenes). */
  customMapsChanged(maps: readonly ArenaDef[]): void {
    for (const q of this.conns) send(q, { t: 'custom_maps', maps: [...maps], off: disabledMaps() });
  }

  /** Save (or, with null, remove) the default HUD layout, tell everyone connected, and write the admin log. */
  private async setHudDefault(p: Player, layout: HudLayoutMap | null): Promise<void> {
    const who = p.account?.name ?? p.name;
    const at = Date.now();
    const count = layout ? Object.keys(layout).length : 0;
    if (layout && !packHudDefault(layout)) return void send(p, { t: 'dev_result', ok: false, text: 'That HUD layout is too big to keep.' });
    this.hudSet = true;
    this.hudDef = layout ? { t: 'hud_default', layout, at, by: who } : null;
    const ok = await this.adminLog?.setHudDefault(layout ? { layout, at, by: who } : null).catch(() => false);
    if (this.adminLog && !ok) return void send(p, { t: 'dev_result', ok: false, text: 'The HUD default could not be saved. Try again.' });
    const out: ServerMsg = this.hudDef ?? { t: 'hud_default', layout: null, at };
    for (const q of this.conns) send(q, out);
    void this.adminLog?.add(who, layout ? 'hud default saved' : 'hud default removed', undefined, layout ? `${count} elements` : undefined);
  }

  /** The owner's last announcement. */
  private lastAnnounce: Extract<ServerMsg, { t: 'announce' }> | null = null;

  private connectNow(ws: WebSocket, ip = ''): Player {
    const p: Player = { id: this.nextPlayerId++, ws, name: 'Player', classId: 'warrior', matches: 0, wins: 0, ip, since: Date.now(), chain: Promise.resolve(), mapPref: 'random', size: 2, pending: 0 };
    this.conns.add(p);
    return p;
  }

  /** Account messages are async (hashing, storage), so they run in order per connection off the game loop. */
  private account(p: Player, msg: ClientMsg): void {
    // a flood of requests is dropped rather than queued, and work for a closed socket is skipped
    if (p.gone || (p.pending ?? 0) >= MAX_PENDING_ACCOUNT_MSGS) return;
    p.pending = (p.pending ?? 0) + 1;
    p.chain = p.chain
      .then(() => (p.gone ? undefined : this.handleAccount(p, msg)))
      .catch(() => {})
      .finally(() => { p.pending = Math.max(0, (p.pending ?? 1) - 1); });
  }

  /** Why `p` cannot start something new right now (in a match, queued, or waiting for a duel), or null. */
  private busy(p: Player): string | null {
    if (p.room) return 'Finish or leave your match first.';
    if (this.inQueue(p)) return 'You are already in the queue.';
    if (p.duelWith !== undefined) return 'You are waiting for a duel to start.';
    return null;
  }

  /** Another window signed in to the same account is in a match, the queue or a duel. */
  private accountBusyElsewhere(p: Player): boolean {
    const key = p.account?.key;
    return !!key && [...this.conns].some((q) => q !== p && q.account?.key === key && this.busy(q) !== null);
  }

  private async handleAccount(p: Player, msg: ClientMsg): Promise<void> {
    const acc = this.accounts;
    if (!acc) return void send(p, { t: 'auth_error', reason: 'Accounts are not available on this server.' });
    try {
      switch (msg.t) {
        case 'register':
        case 'login':
        case 'resume': {
          if (this.busy(p)) return void send(p, { t: 'auth_error', reason: 'Finish or leave your match first.' });
          const r = msg.t === 'register' ? await acc.register(msg.name, msg.password, p.ip, msg.ownerCode) : msg.t === 'login' ? await acc.login(msg.name, msg.password, p.ip) : await acc.resume(msg.token);
          if (!r.ok) return void send(p, { t: 'auth_error', reason: r.reason });
          p.account = r.account;
          p.token = r.token;
          p.matches = r.account.matches;
          p.wins = r.account.wins;
          p.ownerOk = await acc.isOwnerSession(r.token, r.account);
          send(p, { t: 'account', account: publicInfo(r.account, p.ownerOk), token: msg.t === 'resume' ? undefined : r.token });
          send(p, { t: 'settings', data: r.account.settings ?? '' });
          this.pushFriends(p);
          this.changed(p);
          break;
        }
        case 'logout':
          // signing out mid-match would dodge the result: finish (or leave, which counts as a loss) first
          if ((p.room && p.room.sim.phase !== 'ended') || this.inQueue(p) || p.duelWith !== undefined) return void send(p, { t: 'auth_error', reason: 'Finish or leave your match first.' });
          p.ctl?.room.releaseControl(p);
          if (p.token) await acc.logout(p.token);
          this.leaveParty(p);
          this.dropInvites(p);
          {
            const was = p.account;
            p.account = undefined;
            p.token = undefined;
            p.ownerOk = false;
            p.devSession = undefined;
            send(p, { t: 'logged_out' });
            if (was) this.changed(p, was);
          }
          break;
        case 'customize': {
          if (!p.account) return;
          const updated = await acc.customize(p.account, msg.cosmetics, !!p.ownerOk);
          if (!updated) return void send(p, { t: 'auth_error', reason: 'That cosmetic is still locked.' });
          p.account = updated;
          send(p, { t: 'account', account: publicInfo(updated, p.ownerOk) });
          break;
        }
        case 'save_settings': {
          if (!p.account) return;
          try {
            const obj = JSON.parse(msg.data) as unknown;
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
            if (!Object.entries(obj).every(([k, v]) => k.startsWith('arena.') && k.length < 80 && typeof v === 'string')) return;
          } catch {
            return;
          }
          const now = Date.now();
          const wait = 1500 - (now - (p.lastSettingsSave ?? 0));
          if (wait > 0) {
            // at most one write per 1.5 s per connection, but the newest copy is never dropped: it is written when the
            // window ends, even if the socket has closed by then
            const first = p.settingsLater === undefined;
            p.settingsLater = msg.data;
            const account = p.account;
            if (first) setTimeout(() => {
              const data = p.settingsLater;
              p.settingsLater = undefined;
              if (data === undefined) return;
              p.lastSettingsSave = Date.now();
              void acc.saveSettings(p.account?.key === account.key ? p.account : account, data).catch(() => {});
            }, wait).unref?.();
            return;
          }
          p.lastSettingsSave = now;
          await acc.saveSettings(p.account, msg.data);
          break;
        }
        case 'leaderboard':
          send(p, { t: 'leaderboard', rows: await acc.leaderboard(20) });
          break;
        case 'owner_unlock': {
          const r = await acc.ownerUnlock(p.token, p.account, msg.code, p.ip);
          if (r.ok && p.account) p.ownerOk = true;
          send(p, { t: 'owner', ok: r.ok, reason: r.reason });
          if (r.ok && p.account) send(p, { t: 'account', account: publicInfo(p.account, true) });
          break;
        }
        case 'friends':
          if (p.account) this.pushFriends(p);
          break;
        case 'friend': {
          if (!p.account) return void send(p, { t: 'notice', text: 'Sign in to use friends.' });
          if (msg.op === 'add' && acc.isMuted(p.account)) return void send(p, { t: 'notice', text: 'You are muted: no friend requests for now.' });
          const r = await acc.friendOp(p.account.key, msg.op, msg.name);
          if (!r.ok) return void send(p, { t: 'notice', text: r.reason });
          p.account = r.me;
          if (r.other) {
            for (const q of this.conns) {
              if (q.account?.key !== r.other.key) continue;
              q.account = r.other;
              this.pushFriends(q);
              if (msg.op === 'add' && r.note?.startsWith('Request sent')) send(q, { t: 'notice', text: `${p.account.name} sent you a friend request.` });
              if (msg.op === 'accept' || (msg.op === 'add' && r.note?.startsWith('You and'))) send(q, { t: 'notice', text: `${p.account.name} is now your friend.` });
            }
          }
          if (r.note) send(p, { t: 'notice', text: r.note });
          this.pushFriends(p);
          this.changed(p);
          break;
        }
        case 'history':
          if (!p.account) return;
          send(p, { t: 'history', rows: await acc.history(p.account.key) });
          break;
        case 'admin_list': {
          if (!p.ownerOk) return void send(p, { t: 'auth_error', reason: this.adminAccess(p) ? 'The player list and moderation are for the owner only.' : 'Owner tools are locked.' });
          send(p, { t: 'admin_accounts', rows: await acc.adminList(this.onlineKeys()) });
          break;
        }
        case 'admin_set': {
          if (!p.ownerOk) return void send(p, { t: 'auth_error', reason: this.adminAccess(p) ? 'Account changes (tags, passwords) are for the owner only.' : 'Owner tools are locked.' });
          const r = await acc.adminSet(msg.name, msg);
          if (!r.ok) return void send(p, { t: 'admin_result', ok: false, name: msg.name, reason: r.reason });
          // a friend who is online gets the change immediately (and a reset password signs them out)
          for (const q of this.conns) {
            if (q.account?.key !== r.account.key) continue;
            if (msg.resetPassword) {
              q.ctl?.room.releaseControl(q);
              q.account = undefined;
              q.token = undefined;
              q.ownerOk = false;
              send(q, { t: 'logged_out' });
            } else {
              q.account = r.account;
              send(q, { t: 'account', account: publicInfo(r.account) });
            }
          }
          void this.adminLog?.add(p.account?.name ?? p.name, msg.resetPassword ? 'reset password' : 'edit account', r.account.name, msg.grants ? `grants: ${msg.grants.join(', ') || 'none'}` : undefined);
          send(p, { t: 'admin_result', ok: true, name: r.account.name, row: acc.adminRow(r.account, this.onlineKeys().has(r.account.key)), tempPassword: r.tempPassword });
          break;
        }
      }
    } catch {
      send(p, { t: 'auth_error', reason: 'Account service error. Try again in a moment.' });
    }
  }

  /** Validate and store a player's name, class and build. False (after telling them) if the build is invalid. */
  private applyIdentity(p: Player, msg: { name: string; classId: ClassId; build?: Build; profile?: string }): boolean {
    const progress = p.account ? { matches: p.account.matches, wins: p.account.wins } : verifyProfile(msg.profile) ?? { matches: 0, wins: 0 };
    // cosmetics that no longer exist (an old save) are dropped quietly rather than refusing the match;
    // owner-only looks need the owner session (name and code), not just the name
    const isOwner = !!p.account && isOwnerName(p.account.name) && !!p.ownerOk;
    const build = msg.build ? { ...msg.build, gear: cleanGear(msg.build.gear, isOwner, progress.matches) } : undefined;
    if (build) {
      const check = validateBuild(msg.classId, build, isOwner, progress.matches);
      if (!check.ok) {
        send(p, { t: 'error', reason: `Invalid build: ${check.reason}` });
        send(p, { t: 'closed', reason: `Invalid build: ${check.reason}` });
        return false;
      }
    }
    p.matches = progress.matches;
    p.wins = progress.wins;
    p.build = build;
    p.name = p.account ? p.account.name : msg.name;
    p.classId = msg.classId;
    return true;
  }

  handle(p: Player, msg: ClientMsg): void {
    // background polling (pings, the live-match badge) is not the player doing something
    if (msg.t !== 'ping' && msg.t !== 'live' && msg.t !== 'admin_overview' && !(msg.t === 'admin_proposals' && msg.op === 'list')) p.activeAt = this.clock();
    switch (msg.t) {
      case 'ping':
        send(p, { t: 'pong', n: msg.n, load: this.meter.report().load }); // answered at once, in any state
        break;
      case 'join': {
        if (p.room || this.inQueue(p)) return;
        if (this.maint && !p.ownerOk) return void send(p, { t: 'closed', reason: this.maint });
        if (p.duelWith !== undefined && msg.mode !== 'duel') return void send(p, { t: 'closed', reason: 'You are waiting for a duel to start. It is called off after 30 seconds if your friend does not join.' });
        if (msg.mode !== 'practice' && this.accountBusyElsewhere(p)) return void send(p, { t: 'closed', reason: 'Your account is already playing in another window.' });
        p.watching?.removeSpectator(p);
        if (p.party && p.party.members.length > 1 && p.party.leader !== p) {
          send(p, { t: 'closed', reason: 'Only the party leader picks the mode. Press Ready.' });
          return;
        }
        if (!this.applyIdentity(p, msg)) return;
        p.mapPref = msg.map ?? 'random';
        p.size = msg.size ?? 2;
        if (msg.mode === 'practice') this.startPractice(p, msg);
        else if (msg.mode === 'duel') this.joinDuel(p, msg.duelWith);
        else if (msg.mode === 'party') this.startPartyMatch(p, msg);
        else this.enqueue(p);
        break;
      }
      case 'leave': {
        if (p.ctl) return void p.ctl.room.releaseControl(p); // playing a bot: Leave gives it back and goes on watching
        // leaving a match keeps the socket (and the party) alive: tell the client to go back to the menu
        const inMatch = !!p.room;
        this.leave(p);
        if (inMatch) send(p, { t: 'closed', reason: 'You left the match.' });
        break;
      }
      case 'ready': {
        const party = p.party;
        if (!party || party.leader === p) return;
        // a mark is only kept while the member sits in the menu; whatever is refused, the party is sent again so a client that
        // toggled its button on its own can never disagree with the server (the old "ready again" bug)
        const why = this.busy(p) ?? (p.watching ? 'Stop watching first.' : null);
        if (msg.on && why) send(p, { t: 'notice', text: why });
        if (why) {
          this.sendParty(party);
          return;
        }
        if (msg.on) {
          if (this.applyIdentity(p, msg)) party.ready.add(p);
          else party.ready.delete(p);
        } else party.ready.delete(p);
        this.sendParty(party);
        break;
      }
      case 'party_look': {
        const party = p.party;
        if (!party || p.room || this.inQueue(p)) return;
        // lenient on purpose: drop what is not allowed (an owner skin without the code) instead of hiding the whole model
        const build = msg.build ?? emptyBuild(msg.classId);
        const spec = specOf(msg.classId, build.spec) ? build.spec : emptyBuild(msg.classId).spec;
        p.view = { classId: msg.classId, spec, look: gearLook(cleanGear(build.gear, !!p.ownerOk, p.account?.matches ?? p.matches ?? 0)) };
        this.sendParty(party);
        break;
      }
      case 'party_side': {
        const party = p.party;
        if (!party || p.room || this.inQueue(p)) return;
        const there = party.members.filter((m) => m !== p && (party.sides.get(m) ?? 0) === msg.side).length;
        if (there >= PARTY_SIDE_MAX) return void send(p, { t: 'notice', text: `Team ${msg.side + 1} already has ${PARTY_SIDE_MAX} players.` });
        party.sides.set(p, msg.side);
        this.sendParty(party);
        break;
      }
      case 'live':
        if (!p.account) return void send(p, { t: 'live', rows: [], signIn: true });
        send(p, { t: 'live', rows: [...this.rooms].filter((r) => r.watchable).map((r) => r.live()) });
        break;
      case 'spectate': {
        if (this.busy(p)) return;
        if (!p.account) return void send(p, { t: 'notice', text: 'Sign in to watch live matches.' });
        // the owner can watch any match (practice and private bot matches too); everyone else only listed ones
        const room = [...this.rooms].find((r) => r.id === msg.id && !r.closed && (r.watchable || p.ownerOk));
        if (!room) return void send(p, { t: 'closed', reason: 'That match is over.' });
        p.watching?.removeSpectator(p);
        room.addSpectator(p);
        this.changed(p);
        break;
      }
      case 'bot_note':
        void this.botNote(p, msg).catch(() => send(p, { t: 'bot_note_ack', id: msg.id, ok: false, text: 'That did not work. Try again.' }));
        break;
      case 'dev_pause':
      case 'dev_patch': {
        const room = this.devRoom(p);
        if (!room) return void send(p, { t: 'dev_result', ok: false, text: !this.isDev(p) ? 'Dev tools need the dev tag.' : p.room ? 'Not in ranked matches.' : 'Start a match first.' });
        if (msg.t === 'dev_pause') {
          room.devTest = true; // from now on this match counts for nothing (progress, rating, replays, bot learning)
          room.paused = msg.on;
          room.pausedBy = msg.on ? (p.account?.name ?? p.name) : '';
          room.clearInputs(); // whatever was queued before the pause must not move anyone after it
          for (const q of [...room.players.values(), ...room.spectators]) {
            send(q, { t: 'dev_state', paused: room.paused, patches: room.devPatches, noCooldowns: room.sim.noCooldowns });
          }
        } else this.setRoomPatches(room, p, msg.patches);
        break;
      }
      case 'dev_session': {
        if (!this.isDev(p)) return void send(p, { t: 'dev_result', ok: false, text: 'Dev tools need the dev tag.' });
        if (msg.live) {
          // "Make it live": everyone gets these numbers at once, and the same match keeps them as well
          if (this.ownerOnly(p, 'Making numbers live')) return;
          const by = p.account?.name ?? p.name;
          void this.dev?.save(msg.patches).then(() => {
            void this.adminLog?.add(by, 'numbers made live', undefined, `${msg.patches.length} number${msg.patches.length === 1 ? '' : 's'}`);
            for (const q of this.conns) send(q, { t: 'overrides', patches: this.dev?.overrides ?? [] });
          });
        }
        p.devSession = msg.patches;
        send(p, { t: 'dev_session', patches: p.devSession });
        // the match running now gets them too
        const room = this.devRoom(p);
        if (room && msg.patches.length) this.setRoomPatches(room, p, mergePatches(room.devPatches, msg.patches));
        send(p, { t: 'dev_result', ok: true, text: msg.patches.length ? `Kept ${msg.patches.length} number${msg.patches.length === 1 ? '' : 's'} for your session: every match you start uses them until you clear them or sign out.` : 'Session numbers cleared: your next match uses the real numbers.' });
        break;
      }
      case 'dev_restart': {
        const room = this.devRoom(p);
        if (!room) return void send(p, { t: 'dev_result', ok: false, text: !this.isDev(p) ? 'Dev tools need the dev tag.' : 'Start a match that is not ranked first.' });
        if (room.closed) return void send(p, { t: 'dev_result', ok: false, text: 'That match is over.' });
        room.devRestart();
        const by = p.account?.name ?? p.name;
        for (const q of [...room.players.values(), ...room.spectators]) {
          send(q, { t: 'dev_state', paused: room.paused, patches: room.devPatches, noCooldowns: room.sim.noCooldowns, reset: true });
          if (q !== p) send(q, { t: 'notice', text: `${by} restarted the match (it no longer counts).` });
        }
        send(p, { t: 'dev_result', ok: true, text: 'The match started over with the same builds.' });
        break;
      }
      case 'dev_reset':
      case 'dev_cooldowns': {
        const room = this.devRoom(p);
        if (!room || room.closed) return void send(p, { t: 'dev_result', ok: false, text: !this.isDev(p) ? 'Dev tools need the dev tag.' : 'Start a match that is not ranked first.' });
        room.devTest = true; // from now on this match counts for nothing
        const by = p.account?.name ?? p.name;
        let text = '';
        if (msg.t === 'dev_cooldowns') {
          room.sim.noCooldowns = msg.off;
          if (msg.off) room.sim.resetCooldowns();
          text = msg.off ? 'Cooldowns are off: no skill starts one.' : 'Cooldowns are back on.';
        } else if (msg.what === 'cooldowns') {
          room.sim.resetCooldowns();
          text = 'Every cooldown was reset.';
        } else {
          room.sim.devReset(msg.what);
          text = { health: 'Everyone alive is at full health.', resources: 'Every resource is full.', auras: 'Every buff and debuff was cleared.', positions: 'Everyone is back at their spawn.', revive: 'The dead are back at their spawns.' }[msg.what];
        }
        for (const q of [...room.players.values(), ...room.spectators]) {
          send(q, { t: 'dev_state', paused: room.paused, patches: room.devPatches, noCooldowns: room.sim.noCooldowns, ...(msg.t === 'dev_reset' && (msg.what === 'positions' || msg.what === 'revive') ? { reset: true } : {}) });
          if (q !== p) send(q, { t: 'notice', text: `${by}: ${text}` });
        }
        send(p, { t: 'dev_result', ok: true, text });
        break;
      }
      case 'dev_unit': {
        // the owner moderates from inside a match (played or watched): the unit's player, not a name typed in
        if (!p.ownerOk) return void send(p, { t: 'dev_result', ok: false, text: 'Killing, kicking and banning are for the owner only.' });
        const room = this.devRoom(p);
        const u = room && !room.closed ? room.sim.units.get(msg.unit) : undefined;
        if (!room || !u) return void send(p, { t: 'dev_result', ok: false, text: 'That unit is not in a match you are in or watching.' });
        const target = room.players.get(msg.unit);
        const by = p.account?.name ?? p.name;
        const log = (action: string, detail?: string) => void this.adminLog?.add(by, action, u.name, detail);
        if (msg.op === 'kill') {
          const killed = room.sim.adminKill(msg.unit);
          if (killed) room.devTest = true; // the result is not a real one any more
          log('kill in match', room.id);
          return void send(p, { t: 'dev_result', ok: killed, text: killed ? `Killed ${u.name}.` : `${u.name} is already dead.` });
        }
        if (!target || target === p) return void send(p, { t: 'dev_result', ok: false, text: target === p ? 'That is you.' : `${u.name} is a bot: use Kill.` });
        if (msg.op === 'kick') {
          for (const q of this.connsOf(target.account?.key ?? '')) if (q !== p) { send(q, { t: 'closed', reason: `You were removed from the server by the owner${msg.reason ? `: ${msg.reason}` : '.'}` }); q.ws.close(); }
          if (!target.account) { send(target, { t: 'closed', reason: `You were removed from the server by the owner${msg.reason ? `: ${msg.reason}` : '.'}` }); target.ws.close(); }
          log('kick in match', msg.reason);
          return void send(p, { t: 'dev_result', ok: true, text: `Kicked ${u.name}.` });
        }
        const acc = this.accounts;
        if (!target.account || !acc) return void send(p, { t: 'dev_result', ok: false, text: `${u.name} is a guest: there is no account to ban. Kick them instead.` });
        void (async () => {
          const r = await acc.adminModerate(target.account!.name, 'ban', { minutes: msg.minutes, reason: msg.reason, by });
          if (!r.ok) return void send(p, { t: 'dev_result', ok: false, text: r.reason });
          for (const q of this.connsOf(r.account.key)) {
            send(q, { t: 'closed', reason: bannedText(r.account) ?? 'Banned.' });
            q.ws.close();
          }
          log('ban in match', `${msg.minutes ? `${msg.minutes} min` : 'permanent'}${msg.reason ? `: ${msg.reason}` : ''}`);
          send(p, { t: 'dev_result', ok: true, text: `Banned ${r.account.name} ${msg.minutes ? `for ${msg.minutes} minutes` : 'for good'}.` });
        })();
        break;
      }
      case 'dev_map': {
        const room = this.devRoom(p);
        if (!room) return void send(p, { t: 'dev_result', ok: false, text: !this.isDev(p) ? 'Dev tools need the dev tag.' : 'Start a match that is not ranked first.' });
        if (room.closed) return void send(p, { t: 'dev_result', ok: false, text: 'That match is over.' });
        const map = findArena(msg.id);
        if (!map) return void send(p, { t: 'dev_result', ok: false, text: 'That map does not exist.' });
        room.devSwapMap(map.id);
        const by = p.account?.name ?? p.name;
        for (const q of [...room.players.values(), ...room.spectators]) {
          send(q, { t: 'dev_map', map: map.id });
          send(q, { t: 'notice', text: q === p ? `Map: ${map.name}` : `${by} changed the map to ${map.name} (the match no longer counts).` });
        }
        break;
      }
      case 'dev_bot': {
        const room = this.devRoom(p);
        if (!room) return void send(p, { t: 'dev_result', ok: false, text: !this.isDev(p) ? 'Dev tools need the dev tag.' : 'Start a match that is not ranked first.' });
        const ok = validateBuild(msg.classId, msg.build, !!p.ownerOk, 99);
        if (!ok.ok) return void send(p, { t: 'dev_result', ok: false, text: `That build is not valid: ${ok.reason}` });
        const mine = msg.unit === p.unitId && p.room === room;
        if (!room.devRebuild(msg.unit, msg.classId, msg.build, mine)) return void send(p, { t: 'dev_result', ok: false, text: 'That is not a bot in this match, or your own character.' });
        if (mine) p.classId = msg.classId;
        const by = p.account?.name ?? p.name;
        for (const q of [...room.players.values(), ...room.spectators]) {
          send(q, { t: 'builds', units: room.builds() });
          if (q !== p) send(q, { t: 'notice', text: `${by} changed a bot's class and build (the match no longer counts).` });
        }
        send(p, { t: 'dev_result', ok: true, text: mine ? 'You have your new class and build.' : 'The bot has its new class and build.' });
        break;
      }
      case 'dev_builds': {
        const room = p.room ?? p.watching;
        if (!room || (!this.isDev(p) && !p.watching)) return;
        send(p, { t: 'builds', units: room.builds() });
        break;
      }
      case 'dev_save': {
        if (!this.isDev(p) || !this.dev) return void send(p, { t: 'dev_result', ok: false, text: 'Dev tools need the dev tag.' });
        const by = p.account?.name ?? p.name;
        const dev = this.dev;
        // nothing goes live: the changes wait in the owner's admin panel, stacked with everyone else's
        void (async () => {
          try {
            await dev.propose(by, msg.patches, msg.note);
            void this.adminLog?.add(by, 'proposed numbers', undefined, msg.patches.map((x) => `${x.id}.${x.path.join('.')}=${x.value}`).join(', '));
            for (const q of this.panelViewers()) send(q, { t: 'proposals', rows: dev.proposals });
            send(p, { t: 'dev_result', ok: true, text: `Sent ${msg.patches.length} change${msg.patches.length === 1 ? '' : 's'} to the owner's admin panel. Nothing is live until the owner applies it.` });
          } catch {
            send(p, { t: 'dev_result', ok: false, text: 'Could not send the changes.' });
          }
        })();
        break;
      }
      case 'owner_log': {
        if (!p.ownerOk || !this.dev) return void send(p, { t: 'owner_log', rows: [], error: 'Only the owner can see this.' });
        void this.dev.ownerLog().then((r) => send(p, { t: 'owner_log', ...r }));
        break;
      }
      case 'dev_commits': {
        if (!this.isDev(p) || !this.dev) return;
        send(p, { t: 'dev_commits', rows: this.dev.commits, running: PATCHES[0]?.version ?? '0.0.0' });
        break;
      }
      case 'dev_redeploy': {
        if (!this.isDev(p) || !this.dev) return void send(p, { t: 'dev_result', ok: false, text: 'Dev tools need the dev tag.' });
        const by = p.account?.name ?? p.name;
        const dev = this.dev;
        void (async () => {
          try {
            const text = await dev.redeploy();
            void this.adminLog?.add(by, 'redeploy on Render');
            send(p, { t: 'dev_result', ok: true, text });
            for (const q of this.conns) if (q !== p) send(q, { t: 'notice', text: 'A new update is being deployed. The game restarts in a minute or two; a Refresh button appears when it is ready.' });
          } catch (e) {
            send(p, { t: 'dev_result', ok: false, text: (e as Error).message });
          }
        })();
        break;
      }
      case 'dev_commit': {
        if (!this.isDev(p) || !this.dev) return void send(p, { t: 'dev_result', ok: false, text: 'Dev tools need the dev tag.' });
        const by = p.account?.name ?? p.name;
        const dev = this.dev;
        // the owner's choice: a dev's numbers go straight to the main branch (data files only, one commit per file)
        void (async () => {
          try {
            const r = await dev.commitToBase(msg.patches, by, msg.note);
            void this.adminLog?.add(by, 'committed numbers to GitHub', undefined, msg.patches.map((x) => `${x.id}.${x.path.join('.')}=${x.value}`).join(', '));
            send(p, { t: 'dev_commits', rows: dev.commits, running: PATCHES[0]?.version ?? '0.0.0' });
            send(p, { t: 'dev_result', ok: true, text: `Committed ${r.applied} number${r.applied === 1 ? '' : 's'} to the main branch on GitHub as patch ${r.version}. The game updates when the next deploy finishes.${r.skipped.length ? ` Left out: ${r.skipped.join('; ')}.` : ''}`, url: r.url });
          } catch (e) {
            send(p, { t: 'dev_result', ok: false, text: (e as Error).message });
          }
        })();
        break;
      }
      case 'admin_proposals': {
        const access = this.adminAccess(p);
        if (!access || !this.dev) return;
        const dev = this.dev;
        if (msg.op === 'list') return void send(p, { t: 'proposals', rows: dev.proposals });
        // devs send proposals (from the dev panel) and read them here; applying or dismissing is the owner's call
        // devs commit proposals to GitHub and clear them; making them live or opening a pull request stays the owner's
        if (msg.op === 'live' || msg.op === 'pr') if (this.ownerOnly(p, msg.op === 'live' ? 'Making proposals live' : 'Opening a pull request')) return;
        const by = p.account?.name ?? p.name;
        void dev.actOn(msg.op, msg.ids, by, msg.note).then(async (r) => {
          if (r.ok) {
            void this.adminLog?.add(by, `proposals: ${msg.op}`, undefined, r.text);
            if (msg.op === 'live') for (const q of this.conns) send(q, { t: 'overrides', patches: dev.overrides });
          }
          send(p, { t: 'dev_result', ok: r.ok, text: r.text, ...(r.url ? { url: r.url } : {}) });
          for (const q of this.panelViewers()) send(q, { t: 'proposals', rows: dev.proposals });
        });
        break;
      }
      case 'dev_ai': {
        if (!this.isDev(p)) return void send(p, { t: 'dev_result', ok: false, text: 'Dev tools need the dev tag.' });
        if (!this.ai) return void send(p, { t: 'dev_result', ok: false, text: 'Ask Claude is off on this server.' });
        const who = p.account?.key ?? p.ip;
        const by = p.account?.name ?? p.name;
        const scope = msg.classId ? `class:${msg.classId}` : msg.ability;
        const scopeName = msg.classId ? CLASSES[msg.classId].name : ABILITIES[msg.ability]?.name ?? msg.ability;
        const propose = !!msg.propose;
        void this.ai.chat(who, msg.ability, msg.classId, msg.text, this.testingOf(p, propose)).then(async (a) => {
          const rec = this.ai?.turn(who, a.turn);
          const changes: ChatChange[] = a.patches.map((x) => ({ label: patchLabel(x), from: currentValue(x) ?? null, to: x.value }));
          let applied = false;
          if (rec && a.patches.length) rec.propose = propose;
          if (rec && a.patches.length && a.confident) applied = await this.applyAi(p, rec);
          const turn: ChatTurn = { id: a.turn, kind: a.kind, scope, text: a.text, ...(a.questions.length ? { questions: a.questions } : {}), ...(changes.length ? { changes, applied, patches: a.patches, ...(rec?.proposalId ? { proposalId: rec.proposalId } : {}) } : {}), ...(a.dropped.length ? { dropped: a.dropped } : {}) };
          if (a.ok && a.kind === 'request' && a.request) {
            if (!this.requests) {
              turn.kind = 'error';
              turn.text = `${a.text} (Requests are not set up on this server, so nothing was filed.)`;
            } else {
              const tested: ChatChange[] = this.testingOf(p, propose).slice(0, 40).map((x) => ({ label: patchLabel(x), from: currentValue(x) ?? null, to: x.value }));
              const r = await this.requests.file(by, scopeName, a.request, tested);
              if (!r.ok || !r.row) {
                turn.kind = 'error';
                turn.text = r.text;
              } else {
                const row = r.row;
                turn.request = { id: row.id, title: row.title, ...(row.issueUrl ? { issueUrl: row.issueUrl, issueNumber: row.issueNumber } : {}), ...(row.issueError ? { issueError: row.issueError } : {}) };
                turn.text = `${a.text}\n\nThat needs a code change. I have saved it as a request for the owner with the full details ("${row.title}"); you can follow its status in the dev panel.${row.build ? ' Claude is writing the code on GitHub now: a pull request appears on the request in a few minutes, and the owner can merge it from there once its checks pass.' : ''}${row.issueUrl ? ` A GitHub issue was opened too: ${row.issueUrl}` : ''}${row.issueError ? `\n\nThe GitHub issue could not be opened (${row.issueError}). The request is saved for the owner anyway.` : ''}`;
                this.sendRequests();
              }
            }
          }
          if (rec) rec.view = turn;
          void this.adminLog?.add(by, 'ask Claude', scopeName, `${msg.text} → ${turn.kind}${a.patches.length ? `: ${a.patches.map((x) => `${x.id}.${x.path.join('.')}=${x.value}`).join(', ')}` : ''}${turn.request ? ` (request ${turn.request.id})` : ''}`);
          send(p, { t: 'dev_chat', turn });
        });
        break;
      }
      case 'dev_ai_apply':
      case 'dev_ai_undo': {
        if (!this.isDev(p) || !this.ai) return void send(p, { t: 'dev_result', ok: false, text: 'Dev tools need the dev tag.' });
        const rec = this.ai.turn(p.account?.key ?? p.ip, msg.turn);
        if (!rec?.view) return void send(p, { t: 'dev_result', ok: false, text: 'That answer is too old to change. Ask again.' });
        const view = rec.view;
        void (async () => {
          if (msg.t === 'dev_ai_apply') {
            if (!rec.applied) await this.applyAi(p, rec);
          } else if (rec.applied) {
            if (rec.propose) {
              // the proposal it made is taken off the list
              if (rec.proposalId && this.dev) {
                await this.dev.actOn('dismiss', [rec.proposalId], p.account?.name ?? p.name);
                for (const q of this.panelViewers()) send(q, { t: 'proposals', rows: this.dev.proposals });
              }
              rec.proposalId = undefined;
            } else {
              const k = (x: DataPatch) => `${x.file}:${x.id}:${x.path.join('.')}`;
              const keys = new Set(rec.patches.map(k));
              this.setTesting(p, [...this.testingOf(p).filter((x) => !keys.has(k(x))), ...(rec.before ?? []).filter((x) => keys.has(k(x)))]);
            }
            rec.applied = false;
          }
          const { proposalId: _drop, ...rest } = view;
          rec.view = { ...rest, applied: rec.applied, ...(rec.proposalId ? { proposalId: rec.proposalId } : {}) };
          send(p, { t: 'dev_chat', turn: rec.view });
        })();
        break;
      }
      case 'dev_ai_clear':
        if (this.isDev(p)) this.ai?.clear(p.account?.key ?? p.ip, msg.scope);
        break;
      case 'dev_requests': {
        const access = this.adminAccess(p);
        if (!this.isDev(p) || !this.requests) return void send(p, { t: 'dev_result', ok: false, text: 'Dev tools need the dev tag.' });
        const reqs = this.requests;
        const by = p.account?.name ?? p.name;
        if (msg.op === 'list') {
          send(p, { t: 'dev_requests', rows: reqs.visible(by, access === 'owner'), all: access === 'owner' });
          break;
        }
        if (msg.op === 'check' && msg.id) {
          void reqs.checkPr(msg.id).then(() => this.sendRequests());
          break;
        }
        if (msg.op === 'merge') {
          if (this.ownerOnly(p, 'Merging a pull request') || !msg.id) return;
          void reqs.merge(msg.id).then((r) => {
            send(p, { t: 'dev_result', ok: r.ok, text: r.text });
            if (r.ok) void this.adminLog?.add(by, 'request: merged the pull request', undefined, msg.id);
            this.sendRequests();
          });
          break;
        }
        if (msg.op === 'build') {
          if (this.ownerOnly(p, 'Asking Claude to build a request') || !msg.id) return;
          void reqs.build(msg.id, by).then((r) => {
            send(p, { t: 'dev_result', ok: r.ok, text: r.text });
            if (r.ok) void this.adminLog?.add(by, 'request: build with Claude', undefined, msg.id);
            this.sendRequests();
          });
          break;
        }
        if (this.ownerOnly(p, 'Marking or deleting requests') || !msg.id) return;
        if (msg.op !== 'done' && msg.op !== 'reopen' && msg.op !== 'delete') return;
        void reqs.mark(msg.id, msg.op).then((ok) => {
          if (!ok) return void send(p, { t: 'dev_result', ok: false, text: 'That request is gone.' });
          void this.adminLog?.add(by, `request: ${msg.op}`, undefined, msg.id);
          this.sendRequests();
        });
        break;
      }
      case 'dev_note': {
        if (!this.isDev(p)) return void send(p, { t: 'dev_result', ok: false, text: 'Dev tools need the dev tag.' });
        const by = p.account?.name ?? p.name;
        const testing = this.devRoom(p)?.devPatches ?? [];
        void Promise.all([
          this.dev?.note(by, msg.ability, msg.text, testing) ?? Promise.resolve(false),
          this.suggestions?.add(by, `[Skill note · ${ABILITIES[msg.ability]?.name ?? msg.ability}] ${msg.text}`) ?? Promise.resolve(false),
        ]).then(([sent, kept]) => send(p, { t: 'dev_result', ok: sent || kept, text: sent ? 'Note sent to the owner.' : kept ? 'Note saved in the suggestion box.' : 'Could not send the note.' }));
        break;
      }
      case 'admin_overview': {
        const access = this.adminAccess(p);
        if (!access) return;
        send(p, this.overviewMsg(access, p));
        break;
      }
      case 'admin_takeover': {
        // owner only (not the dev tag), and nothing is said to anyone but the owner
        if (!p.ownerOk) return;
        if (p.room || this.inQueue(p) || p.duelWith !== undefined) return void send(p, { t: 'dev_result', ok: false, text: 'Finish or leave your own match first.' });
        const room = [...this.rooms].find((r) => r.id === msg.id && !r.closed);
        if (!room) return void send(p, { t: 'dev_result', ok: false, text: 'That match is over.' });
        const why = room.takeOverCheck(msg.unit);
        if (why) return void send(p, { t: 'dev_result', ok: false, text: why });
        if (p.watching && p.watching !== room) p.watching.removeSpectator(p);
        room.takeOver(p, msg.unit);
        this.changed(p);
        break;
      }
      case 'admin_release': {
        if (!p.ownerOk) return;
        p.ctl?.room.releaseControl(p);
        break;
      }
      case 'admin_act': {
        if (!this.adminAccess(p)) return;
        void this.adminAct(p, msg).catch(() => send(p, { t: 'dev_result', ok: false, text: 'That did not work. Try again.' }));
        break;
      }
      case 'admin_announce': {
        if (this.ownerOnly(p, 'Announcements')) return;
        this.lastAnnounce = { t: 'announce', text: msg.text, by: p.account?.name ?? p.name, at: Date.now() };
        for (const q of this.conns) send(q, this.lastAnnounce);
        void this.adminLog?.add(p.account?.name ?? p.name, 'announce', undefined, msg.text);
        break;
      }
      case 'admin_hud_default': {
        if (this.ownerOnly(p, 'The HUD default for everyone')) return;
        if (!p.ownerOk) return;
        void this.setHudDefault(p, msg.layout);
        break;
      }
      case 'admin_botnames': {
        if (this.ownerOnly(p, 'The bot names')) return;
        if (!p.ownerOk) return;
        let error: string | undefined;
        if (msg.names !== undefined) {
          const v = msg.names === null ? null : validateBotNames(msg.names);
          if (v && !v.ok) error = v.error;
          else {
            this.botNames = v ? v.names : DEFAULT_BOT_NAMES;
            this.botNamesSet = true;
            void this.adminLog?.setBotNames(v ? v.names : null);
            void this.adminLog?.add(p.account?.name ?? p.name, v ? 'bot names changed' : 'bot names reset', undefined, v ? v.names.join(', ') : undefined);
          }
        }
        send(p, { t: 'botnames', names: [...this.botNames], custom: this.botNames !== DEFAULT_BOT_NAMES, ...(error ? { error } : {}) });
        break;
      }
      case 'admin_end': {
        if (this.ownerOnly(p, 'Ending a match')) return;
        const room = [...this.rooms].find((r) => r.id === msg.id);
        if (room) {
          room.close('The owner ended this match.');
          void this.adminLog?.add(p.account?.name ?? p.name, 'end match', room.id, room.adminRow().players.map((x) => x.name).join(', '));
        }
        send(p, this.overviewMsg('owner', p));
        break;
      }
      case 'overrides_pr': {
        if (this.ownerOnly(p, 'Opening a pull request') || !this.dev) return;
        const dev = this.dev;
        const by = p.account?.name ?? p.name;
        if (!dev.overrides.length) return void send(p, { t: 'dev_result', ok: false, text: 'There are no live number changes to propose.' });
        void dev.openPullRequest(dev.overrides, by, msg.note).then(
          (url) => {
            void this.adminLog?.add(by, 'pull request for live numbers', undefined, url);
            send(p, { t: 'dev_result', ok: true, text: `Pull request opened with ${dev.overrides.length} number${dev.overrides.length === 1 ? '' : 's'}.`, url });
          },
          (e: Error) => send(p, { t: 'dev_result', ok: false, text: e.message }),
        );
        break;
      }
      case 'overrides_clear': {
        if (this.ownerOnly(p, 'Clearing the live numbers') || !this.dev) return;
        void this.adminLog?.add(p.account?.name ?? p.name, 'clear number overrides');
        void this.dev.clear().then(() => {
          for (const q of this.conns) send(q, { t: 'overrides', patches: [] });
          send(p, { t: 'dev_result', ok: true, text: 'Live number changes cleared: the data files rule again.' });
        });
        break;
      }
      case 'follow': {
        if (!this.adminAccess(p)) return void send(p, { t: 'notice', text: 'Only the owner can follow players.' });
        if (msg.name === null) {
          p.follow = undefined;
          return void send(p, { t: 'following', name: null });
        }
        const key = msg.name.toLowerCase();
        p.follow = key;
        send(p, { t: 'following', name: msg.name });
        // already in a match: go and watch it now (dummy practice included: the owner sees everything)
        const target = [...this.conns].find((q) => q.account?.key === key && (q.room || q.watching));
        if (target && !this.busy(p)) this.pullFollowers(target);
        else send(p, { t: 'notice', text: `Following ${msg.name}: you will join their next match as soon as it starts.` });
        break;
      }
      case 'maps_list':
        if (!this.adminAccess(p)) return; // the owner and devs share the map tools
        send(p, { t: 'custom_maps', maps: [...customArenas()], off: disabledMaps() });
        break;
      case 'map_enable':
        if (!this.adminAccess(p) || !this.customMaps) return;
        void this.customMaps.setAvailable(p.account?.name ?? p.name, msg.id, msg.on).then((r) => send(p, { t: 'map_result', ok: r.ok, text: r.text, ...(r.ok ? { id: r.id } : {}) }));
        break;
      case 'map_save':
      case 'map_delete': {
        if (!this.adminAccess(p) || !this.customMaps) return;
        const by = p.account?.name ?? p.name;
        void (msg.t === 'map_save' ? this.customMaps.save(by, msg.map) : this.customMaps.remove(by, msg.id)).then((r) => {
          send(p, { t: 'map_result', ok: r.ok, text: r.text, ...(r.ok ? { id: r.id, warnings: r.warnings } : {}) });
        });
        break;
      }
      case 'bot_match': {
        // the owner's and devs' test bench: bots against bots, watched live, in a room nobody else can find
        if (!p.ownerOk && !this.isDev(p)) return void send(p, { t: 'notice', text: 'Only the owner or a dev can start a bot match.' });
        if (this.busy(p)) return;
        p.watching?.removeSpectator(p);
        const room = this.makeRoom(this.cfg.practicePrepMs, false, false, pickMap(msg.map));
        room.size = msg.size;
        room.botsOnly = true;
        msg.teams.forEach((side, team) => side.forEach((b) => room.addNpc(b.classId, team as TeamId, msg.difficulty, b.spec)));
        this.rooms.add(room);
        room.addSpectator(p);
        this.pullFollowers(p); // whoever follows this account comes along
        this.changed(p);
        break;
      }
      case 'invite':
        if (this.accounts?.isMuted(p.account)) return void send(p, { t: 'notice', text: 'You are muted: no invites for now.' });
        this.invite(p, msg.kind, msg.name);
        break;
      case 'invite_reply':
        this.replyInvite(p, msg.id, msg.accept);
        break;
      case 'party_leave':
        this.leaveParty(p);
        break;
      case 'party_kick': {
        const party = p.party;
        if (!party || party.leader !== p) return;
        const target = party.members.find((m) => m.account?.key === msg.name.toLowerCase());
        if (target && target !== p) {
          this.leaveParty(target);
          send(target, { t: 'notice', text: 'You were removed from the party.' });
        }
        break;
      }
      case 'register':
      case 'login':
      case 'resume':
      case 'logout':
      case 'customize':
      case 'save_settings':
      case 'leaderboard':
      case 'owner_unlock':
      case 'admin_list':
      case 'admin_set':
      case 'history':
      case 'friends':
      case 'friend':
        this.account(p, msg);
        break;
      case 'suggest': {
        if (!p.account) return void send(p, { t: 'suggest_ack', ok: false, reason: 'Sign in to send suggestions.' });
        if (!this.suggestions) return void send(p, { t: 'suggest_ack', ok: false, reason: 'The suggestion box is not available.' });
        if (this.accounts?.isMuted(p.account)) return void send(p, { t: 'suggest_ack', ok: false, reason: 'You are muted: no suggestions for now.' });
        // limited per account and per address, so reconnecting (or a second account on the same network) does not reset it
        const now = Date.now();
        const keys = [`a:${p.account.key}`, `i:${p.ip}`];
        if (keys.some((k) => now - (this.lastSuggest.get(k) ?? 0) < SUGGEST_GAP_MS)) return void send(p, { t: 'suggest_ack', ok: false, reason: 'Slow down: one suggestion every 20 seconds.' });
        for (const k of keys) this.lastSuggest.set(k, now);
        void this.suggestions.add(p.account.name, msg.text, msg.note).then((ok) => send(p, { t: 'suggest_ack', ok, reason: ok ? undefined : 'Could not save that, try again.' }));
        break;
      }
      case 'suggestions':
        if (!this.adminAccess(p) || !this.suggestions) return void send(p, { t: 'suggest_ack', ok: false, reason: 'Only the owner can read the box.' });
        void this.suggestions.list().then((rows) => send(p, { t: 'suggestions', rows }));
        break;
      case 'suggest_delete':
        if (!p.ownerOk || !this.suggestions) return void send(p, { t: 'suggest_ack', ok: false, reason: 'Only the owner can delete suggestions.' });
        void this.suggestions.remove(msg.at, msg.text).then(() => this.suggestions!.list()).then((rows) => send(p, { t: 'suggestions', rows }));
        break;
      default:
        (p.room ?? p.ctl?.room)?.command(p, msg);
    }
  }

  disconnect(p: Player): void {
    p.gone = true;
    this.sampleTime(); // the time up to now still counts
    this.conns.delete(p);
    this.leave(p);
    this.leaveParty(p);
    this.dropInvites(p);
    this.changed(p);
    this.sampleTime(); // writes the account's record if this was its last connection
  }

  private leave(p: Player): void {
    this.dequeue(p);
    p.duelWith = undefined;
    p.room?.removePlayer(p);
    p.watching?.removeSpectator(p);
    if (p.party) {
      // leaving a match or the queue starts the party's ready check over for everyone
      p.party.ready.clear();
      this.sendParty(p.party);
    }
    this.changed(p);
  }

  // ------------------------------------------------------------------ friends and presence

  private statusOf(q: Player): FriendStatus {
    if (q.room || q.watching) return 'match';
    if (this.inQueue(q)) return 'queue';
    if (q.party) return 'party';
    return 'menu';
  }

  private friendRows(p: Player): FriendRow[] {
    const rows: FriendRow[] = [];
    for (const name of p.account?.friends ?? []) {
      const q = [...this.conns].find((c) => c.account?.key === name.toLowerCase());
      rows.push(q?.account ? { name: q.account.name, status: this.statusOf(q), rating: q.account.rating, cosmetics: q.account.cosmetics, ...(q.account.avatar ? { avatar: q.account.avatar } : {}) } : { name, status: 'offline' });
    }
    const rank: Record<FriendStatus, number> = { menu: 0, party: 0, queue: 1, match: 1, offline: 2 };
    return rows.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
  }

  private pushFriends(p: Player): void {
    if (p.account) send(p, { t: 'friends', friends: this.friendRows(p), requests: p.account.requests ?? [] });
  }

  /** Something about `p` changed (online, queueing, in a match...): tell the friends who are watching their list. */
  /** `q` just went into a match: an owner following them comes along as a live spectator, wherever they were watching. */
  private pullFollowers(q: Player): void {
    const room = q.room ?? q.watching; // in a match, or watching one (a bot battle they just started)
    const key = q.account?.key;
    if (!room || !key) return;
    for (const f of this.conns) {
      // a dev follows into matches a dev may watch (listed ones, on the delayed view) and into bot battles, never into private practice
      if (f.follow !== key || !(f.ownerOk || (this.adminAccess(f) && (room.watchable || room.botsOnly))) || f === q || f.room || this.inQueue(f) || f.watching === room) continue;
      f.watching?.removeSpectator(f);
      room.addSpectator(f);
      send(f, { t: 'notice', text: `Following ${q.account!.name} into their match.` });
    }
  }

  private changed(p: Player, account = p.account): void {
    if (!account) return;
    const me = account.name.toLowerCase();
    for (const q of this.conns) {
      if (q !== p && q.account?.friends?.some((f) => f.toLowerCase() === me)) this.pushFriends(q);
    }
  }

  // ------------------------------------------------------------------ parties and invites

  private partyInfo(party: Party): PartyInfo {
    return { id: party.id, leader: party.leader.account?.name ?? party.leader.name, members: party.members.map((m) => ({ name: m.account?.name ?? m.name, ready: m === party.leader || party.ready.has(m), side: party.sides.get(m) ?? 0, ...(m.view ?? { classId: m.classId, spec: emptyBuild(m.classId).spec, look: '' }) })) };
  }

  private sendParty(party: Party): void {
    const info = this.partyInfo(party);
    for (const m of party.members) send(m, { t: 'party', party: info });
  }

  private leaveParty(p: Player): void {
    const party = p.party;
    if (!party) return;
    // anyone waiting in the queue as part of this party goes back to the menu
    this.dequeueParty(party);
    p.party = undefined;
    party.members = party.members.filter((m) => m !== p);
    party.ready.delete(p);
    party.sides.delete(p);
    send(p, { t: 'party', party: null });
    if (party.members.length <= 1) {
      for (const m of party.members) {
        m.party = undefined;
        send(m, { t: 'party', party: null });
        send(m, { t: 'notice', text: 'The party was disbanded.' });
        this.changed(m);
      }
      party.members = [];
    } else {
      if (party.leader === p) {
        party.leader = party.members[0];
        for (const m of party.members) send(m, { t: 'notice', text: m === party.leader ? 'You are the party leader now.' : `${party.leader.account?.name ?? party.leader.name} is the party leader now.` });
      }
      party.ready.clear();
      this.sendParty(party);
    }
    this.changed(p);
  }

  /** Take a party's queue entry (if any) back out and clear its ready marks. */
  private dequeueParty(party: Party): void {
    const before = this.queue.length;
    this.queue = this.queue.filter((e) => !e.members.some((m) => party.members.includes(m) || m.party === party));
    party.ready.clear();
    if (this.queue.length !== before) {
      for (const m of party.members) send(m, { t: 'notice', text: 'Your party left the queue.' });
      this.announceQueue();
    }
  }

  private dropInvites(p: Player): void {
    for (const [id, inv] of this.invites) {
      if (inv.from === p || inv.to === p) {
        this.invites.delete(id);
        send(inv.to === p ? inv.from : inv.to, { t: 'invite_gone', id });
        if (inv.to === p) this.dissolveIfAlone(inv.from);
      }
    }
  }

  /** A party of one (its only invite was declined, expired or withdrawn) is no party: it would only block duel invites. */
  private dissolveIfAlone(p: Player): void {
    const party = p.party;
    if (!party || party.members.length !== 1 || party.members[0] !== p) return;
    if ([...this.invites.values()].some((i) => i.kind === 'party' && i.party === party)) return; // still waiting on someone
    p.party = undefined;
    send(p, { t: 'party', party: null });
    this.changed(p);
  }

  private idle(q: Player): boolean {
    return !q.room && !q.watching && !this.inQueue(q) && q.duelWith === undefined;
  }

  private invite(p: Player, kind: 'party' | 'duel', name: string): void {
    if (!p.account) return void send(p, { t: 'notice', text: 'Sign in to invite friends.' });
    const to = [...this.conns].find((c) => c.account?.key === name.toLowerCase());
    if (!p.account.friends?.some((f) => f.toLowerCase() === name.toLowerCase())) return void send(p, { t: 'notice', text: 'You can only invite friends.' });
    if (!to) return void send(p, { t: 'notice', text: `${name} is offline.` });
    if (!this.idle(p)) return void send(p, { t: 'notice', text: 'Finish what you are doing first.' });
    if (!this.idle(to)) return void send(p, { t: 'notice', text: `${to.account!.name} is ${to.room || to.watching ? 'in a match' : this.inQueue(to) ? 'in the queue' : 'busy'} right now.` });
    if ([...this.invites.values()].some((i) => i.from === p && i.to === to)) return void send(p, { t: 'notice', text: 'Already invited.' });
    let party: Party | undefined;
    if (kind === 'party') {
      if (to.party) return void send(p, { t: 'notice', text: to.party === p.party ? `${to.account!.name} is already in your party.` : `${to.account!.name} is already in another party.` });
      party = p.party;
      if (party && party.leader !== p) return void send(p, { t: 'notice', text: 'Only the party leader can invite.' });
      const pending = [...this.invites.values()].filter((i) => i.kind === 'party' && i.from === p).length;
      if (party && party.members.length + pending >= PARTY_MAX) return void send(p, { t: 'notice', text: `Your party is full: a party holds at most ${PARTY_MAX} players.` });
      if (!party) {
        party = { id: crypto.randomBytes(4).toString('hex'), leader: p, members: [p], ready: new Set(), sides: new Map() };
        p.party = party;
        this.assignSide(party, p);
        this.sendParty(party);
        this.changed(p);
      }
    } else {
      if (p.party || to.party) return void send(p, { t: 'notice', text: 'Leave your party before a duel.' });
    }
    const id = crypto.randomBytes(5).toString('hex');
    this.invites.set(id, { id, kind, from: p, to, at: Date.now(), party });
    send(to, { t: 'invite', id, kind, from: p.account.name });
    send(p, { t: 'notice', text: `${kind === 'duel' ? 'Duel' : 'Party'} invite sent to ${to.account!.name}.` });
  }

  private replyInvite(p: Player, id: string, accept: boolean): void {
    const inv = this.invites.get(id);
    if (!inv || inv.to !== p) return;
    this.invites.delete(id);
    const from = inv.from;
    if (!accept) {
      send(from, { t: 'notice', text: `${p.account?.name ?? 'They'} declined.` });
      this.dissolveIfAlone(from);
      return;
    }
    if (!this.idle(p) || !this.idle(from)) return void send(p, { t: 'notice', text: 'That invite is no longer possible.' });
    if (inv.kind === 'party') {
      const party = inv.party;
      if (!party || party.members.length === 0 || from.party !== party) return void send(p, { t: 'notice', text: 'That party is gone.' });
      if (party.members.length >= PARTY_MAX) return void send(p, { t: 'notice', text: `That party is full (${PARTY_MAX} players).` });
      if (p.party) return void send(p, { t: 'notice', text: 'Leave your current party first.' });
      party.members.push(p);
      p.party = party;
      this.assignSide(party, p);
      party.ready.clear();
      this.sendParty(party);
      this.changed(p);
    } else {
      // both sides now send a join in duel mode with their current class and build
      send(from, { t: 'duel_go', with: p.account!.name });
      send(p, { t: 'duel_go', with: from.account!.name });
    }
  }

  /** A duel starts once both friends have joined naming each other. Unranked, one on one. */
  private joinDuel(p: Player, other: string | undefined): void {
    if (!p.account || !other) return void send(p, { t: 'closed', reason: 'Duels need a signed-in friend.' });
    p.duelWith = other.toLowerCase();
    p.duelAt = Date.now();
    const mate = [...this.conns].find((q) => q !== p && q.duelWith === p.account!.key && q.account?.key === p.duelWith);
    if (!mate) return void send(p, { t: 'queued', waiting: 1, needed: 2 });
    const first = (mate.duelAt ?? 0) <= (p.duelAt ?? 0) ? mate : p;
    void first; // duels never use anyone's map pick: they always play on The Overlook
    const room = this.makeRoom(this.cfg.queuePrepMs, true, false, DUEL_MAP);
    room.size = 1;
    room.duel = true;
    p.duelWith = mate.duelWith = undefined;
    room.addPlayer(mate, 0);
    room.addPlayer(p, 1);
    room.broadcastRoster();
    this.rooms.add(room);
  }

  // ------------------------------------------------------------------ rooms and the queue

  private makeRoom(prepMs: number, counts: boolean, ranked: boolean, map: string): Room {
    const room = new Room(prepMs, counts, this.cfg.minCountedMatchMs, ranked, this.accounts, map, this.tickMs);
    room.notify = (q) => {
      this.changed(q);
      this.pullFollowers(q);
    };
    room.learner = this.learner;
    room.onJoin = (q) => this.bringSession(room, q);
    room.autoTrain = () => this.autoTrain;
    room.botNames = () => this.botNames;
    room.onRematch = (old) => this.rematch(old);
    room.onAbort = (r, leaver) => this.abortRanked(r, leaver);
    room.onRequeue = (r, q) => this.requeueAfterRanked(r, q);
    return room;
  }

  /**
   * Someone left a ranked match before it started: call it off, put everyone else back at the front of the queue (parties
   * together), and keep the leaver out of the ranked queue for a short while.
   */
  private abortRanked(room: Room, leaver: Player): void {
    const others = room.abort().filter((q) => q !== leaver);
    if (leaver.account) this.queueBans.set(leaver.account.key, Date.now() + QUEUE_BAN_MS);
    const groups: Player[][] = [];
    for (const q of others) {
      const g = q.party ? groups.find((x) => x[0].party === q.party) : undefined;
      if (g) g.push(q);
      else groups.push([q]);
    }
    for (const g of groups) {
      for (const q of g) send(q, { t: 'closed', reason: `${leaver.name} left before the start. You are back in the queue.` });
      this.queue.push({ members: g, size: room.size, pref: queuePref(g[0].mapPref), at: 0, ranked: true }); // first in line
    }
    for (const q of [...others, leaver]) this.changed(q);
    this.tryMatch(room.size, true);
    this.announceQueue();
  }

  /** Play again in a ranked match someone has left: the voter goes back to the ranked queue on their own. */
  private requeueAfterRanked(room: Room, p: Player): void {
    room.removePlayer(p);
    send(p, { t: 'closed', reason: 'Your opponents left, so there is no rematch. Back in the ranked queue.' });
    if (!p.account || this.banned(p)) return;
    this.queue.push({ members: [p], size: room.size, pref: queuePref(p.mapPref), at: Date.now(), ranked: true });
    this.changed(p);
    this.tryMatch(room.size, true);
    this.announceQueue();
  }

  /** Seconds left on a ranked queue ban, or 0. */
  private banned(p: Player): number {
    const until = p.account ? this.queueBans.get(p.account.key) ?? 0 : 0;
    return Math.max(0, Math.ceil((until - Date.now()) / 1000));
  }

  /** Everyone in a finished match pressed Play again: same players, sides and bots in a fresh room. */
  private rematch(old: Room): void {
    const plan = old.rematchPlan();
    old.release();
    // against bots, Play again is a fresh random map; matches between people keep the arena they were on
    const map = plan.npcs.length && !plan.ranked ? pickMap('random', plan.map) : plan.map;
    const room = this.makeRoom(plan.prepMs, plan.counts, plan.ranked, map);
    room.size = plan.size;
    room.keepReplay = plan.keepReplay;
    for (const h of plan.humans) room.addPlayer(h.p, h.team);
    room.broadcastRoster();
    // and the bots on the other side are a fresh random pick too (practice dummies stay as they were)
    const ours = new Set(plan.humans.map((h) => h.team));
    const classes: ClassId[] = ['warrior', 'mage', 'priest', 'rogue'];
    for (const n of plan.npcs) {
      const foe = !ours.has(n.team) && n.difficulty !== 'dummy' && !plan.ranked;
      const others = classes.filter((c) => c !== n.classId); // a different class than last match
      room.addNpc(foe ? others[Math.floor(Math.random() * others.length)] : n.classId, n.team, n.difficulty);
    }
    this.rooms.add(room);
  }

  /** Defaults (nothing specified): passive dummies; for 2v2 a priest ally, a warrior and a mage on the other side. */
  private startPractice(p: Player, msg: JoinMsg): void {
    const difficulty = msg.difficulty ?? 'dummy';
    const size = p.size;
    const defaultFoes: ClassId[] = ['warrior', 'mage', 'rogue'];
    const defaultAllies: ClassId[] = ['priest', 'mage'];
    // explicit lists are honoured as sent (a lopsided practice is allowed); defaults follow the team size
    const foes = msg.foes && msg.foes.length ? msg.foes.slice(0, 3) : defaultFoes.slice(0, size);
    const allies = (msg.allies ?? (msg.ally === undefined ? defaultAllies.slice(0, size - 1) : msg.ally ? [msg.ally] : [])).slice(0, 2);
    const wait0 = this.notReady(p);
    if (wait0) return void send(p, { t: 'closed', reason: wait0 });
    const room = this.makeRoom(this.cfg.practicePrepMs, difficulty !== 'dummy', false, pickMap(p.mapPref));
    room.size = size;
    const wait = this.notReady(p);
    if (wait) return void send(p, { t: 'closed', reason: wait });
    const humans = [p, ...this.partyMates(p)].slice(0, size);
    room.keepReplay = humans.length > 1; // solo practice is not worth storing; practising with friends is
    for (const h of humans) h.size = size;
    for (const h of humans) room.addPlayer(h, 0);
    room.broadcastRoster();
    // friends take the place of ally bots
    allies.splice(Math.max(0, size - humans.length));
    if (p.party) {
      p.party.ready.clear();
      this.sendParty(p.party);
    }
    for (const ally of allies) room.addNpc(ally, 0, difficulty);
    for (const foe of foes) room.addNpc(foe, 1, difficulty);
    this.rooms.add(room);
  }

  /** The leader starts on side 0; everyone who joins plays on the leader's side until it holds PARTY_SIDE_MAX, then on the other. */
  private assignSide(party: Party, p: Player): void {
    const lead: 0 | 1 = party.leader === p ? 0 : party.sides.get(party.leader) ?? 0;
    const on = party.members.filter((m) => m !== p && (party.sides.get(m) ?? 0) === lead).length;
    party.sides.set(p, on < PARTY_SIDE_MAX ? lead : lead === 0 ? 1 : 0);
  }

  /**
   * A friendly match for the whole party: every member plays on the side they picked and bots fill the empty places, so nobody is left out
   * of a 2v2 with three friends. A side with more friends than the chosen size grows the match (three on one side makes it 3v3).
   */
  private startPartyMatch(p: Player, msg: JoinMsg): void {
    const party = p.party;
    if (!party || party.members.length < 2) return void send(p, { t: 'closed', reason: 'Invite a friend to start a party match.' });
    const wait = this.notReady(p);
    if (wait) return void send(p, { t: 'closed', reason: wait });
    const sideOf = (m: Player): 0 | 1 => party.sides.get(m) ?? 0;
    const humans: [Player[], Player[]] = [party.members.filter((m) => sideOf(m) === 0), party.members.filter((m) => sideOf(m) === 1)];
    const size = Math.min(3, Math.max(p.size, humans[0].length, humans[1].length)) as TeamSize;
    const difficulty = msg.difficulty ?? 'normal';
    const room = this.makeRoom(this.cfg.practicePrepMs, difficulty !== 'dummy', false, pickMap(p.mapPref));
    room.size = size;
    for (const side of [0, 1] as const) for (const h of humans[side]) { h.size = size; room.addPlayer(h, side); }
    room.broadcastRoster();
    const rotation: ClassId[] = ['priest', 'warrior', 'mage', 'rogue'];
    for (const side of [0, 1] as const) {
      const used = humans[side].map((h) => h.classId);
      const spare = rotation.filter((c) => !used.includes(c));
      for (let i = humans[side].length; i < size; i++) room.addNpc(spare[(i - humans[side].length) % spare.length] ?? rotation[i % rotation.length], side, difficulty);
    }
    party.ready.clear();
    this.sendParty(party);
    this.rooms.add(room);
  }

  /** The other party members that must be ready before the leader starts anything (none for a solo player). */
  private partyMates(p: Player): Player[] {
    return p.party && p.party.members.length > 1 ? p.party.members.filter((m) => m !== p) : [];
  }

  /** Why a leader cannot start yet, or null when every other member is ready. */
  private notReady(p: Player): string | null {
    const mates = this.partyMates(p);
    // a mate who went off (a match, the queue, a duel, watching) since pressing Ready is not ready either
    const waiting = mates.filter((m) => !p.party!.ready.has(m) || !this.idle(m));
    return waiting.length ? partyWaitingText(waiting.map((m) => m.account?.name ?? m.name), mates.length + 1 - waiting.length, mates.length + 1) : null;
  }

  /**
   * Solo players queue straight away. A party's leader picks the mode once everyone else is ready.
   * A party bigger than the team size queues as separate players, so friends can still land in the same match.
   */
  private enqueue(p: Player): void {
    const wait = this.notReady(p);
    if (wait) return void send(p, { t: 'closed', reason: wait });
    // the ranked ladder is for signed-in players only; guests play the unrated queue and never meet a ladder match
    const ranked = !!p.account;
    const mates = this.partyMates(p);
    for (const m of [p, ...mates]) {
      const ban = this.banned(m);
      if (ranked && ban) return void send(p, { t: 'closed', reason: m === p ? `You left a ranked match before it started. You can queue again in ${ban} s.` : `${m.account?.name ?? m.name} cannot queue for another ${ban} s.` });
      if (m !== p && this.accountBusyElsewhere(m)) return void send(p, { t: 'closed', reason: `${m.account?.name ?? m.name} is already playing in another window.` });
    }
    const party = p.party;
    const now = Date.now();
    if (mates.length && mates.length + 1 <= p.size) {
      const all = [p, ...mates];
      for (const m of all) {
        m.size = p.size;
        m.mapPref = p.mapPref;
      }
      this.queue.push({ members: all, size: p.size, pref: queuePref(p.mapPref), at: now, ranked });
    } else {
      for (const m of [p, ...mates]) {
        m.size = p.size;
        m.mapPref = p.mapPref;
        this.queue.push({ members: [m], size: p.size, pref: queuePref(p.mapPref), at: now, ranked });
      }
      if (mates.length) for (const m of [p, ...mates]) send(m, { t: 'notice', text: 'Your party is bigger than the team size, so you queue separately and may not be placed together.' });
    }
    if (party) {
      party.ready.clear();
      this.sendParty(party);
    }
    for (const m of [p, ...mates]) this.changed(m);
    this.tryMatch(p.size, ranked);
    this.announceQueue();
  }

  private tryMatch(size: TeamSize, ranked: boolean): void {
    for (;;) {
      const m = findMatch(this.queue.filter((e) => !!e.ranked === ranked && !this.selfMatch(e)), size, () => pickMap('random'));
      if (!m) return;
      // never the same account on both sides (or twice on one side): the later copy is dropped from the queue
      const twice = this.sameAccountTwice([...m.teamA, ...m.teamB]);
      if (twice) {
        this.queue = this.queue.filter((e) => e !== twice);
        for (const q of twice.members) send(q, { t: 'closed', reason: 'Your account is already queued in another window.' });
        continue;
      }
      const room = this.makeRoom(this.cfg.queuePrepMs, true, ranked, m.map);
      room.size = size;
      const taken = new Set([...m.teamA, ...m.teamB]);
      this.queue = this.queue.filter((e) => !taken.has(e));
      m.teamA.forEach((e) => e.members.forEach((pl) => room.addPlayer(pl, 0)));
      m.teamB.forEach((e) => e.members.forEach((pl) => room.addPlayer(pl, 1)));
      room.broadcastRoster();
      this.rooms.add(room);
    }
  }

  /** Take a player (and whoever queued with them) out of the queue. */
  private dequeue(p: Player): void {
    const e = this.queue.find((x) => x.members.includes(p));
    if (!e) return;
    // a party that queued as separate players comes out together
    const out = p.party ? this.queue.filter((x) => x.members.some((m) => m.party === p.party)) : [e];
    this.queue = this.queue.filter((x) => !out.includes(x) && x !== e);
    for (const m of out.flatMap((x) => x.members)) {
      if (m !== p) send(m, { t: 'notice', text: 'Your party left the queue.' });
      if (m.party) m.party.ready.clear();
      this.changed(m);
    }
    this.announceQueue();
  }

  /** An entry whose account already plays elsewhere (another window) is skipped by matchmaking. */
  private selfMatch(e: QEntry<Player>): boolean {
    return e.members.some((m) => m.room !== undefined);
  }

  /** The later of two entries that share an account, if any. */
  private sameAccountTwice(entries: QEntry<Player>[]): QEntry<Player> | null {
    const seen = new Set<string>();
    for (const e of [...entries].sort((a, b) => a.at - b.at)) {
      const keys = e.members.map((m) => m.account?.key ?? `#${m.id}`);
      if (keys.some((k) => seen.has(k))) return e;
      for (const k of keys) seen.add(k);
    }
    return null;
  }

  private announceQueue(): void {
    for (const e of this.queue) {
      const compatible = this.queue.filter((x) => x.size === e.size && !!x.ranked === !!e.ranked && (x.pref === 'random' || e.pref === 'random' || x.pref === e.pref));
      const waiting = compatible.reduce((n, x) => n + x.members.length, 0);
      for (const m of e.members) send(m, { t: 'queued', waiting, needed: e.size * 2 });
    }
  }

  /** Forget expired rate-limit and ban entries so the maps never grow without bound. */
  private sweep(now: number): void {
    for (const [k, t] of this.lastSuggest) if (now - t >= SUGGEST_GAP_MS) this.lastSuggest.delete(k);
    for (const [k, t] of this.queueBans) if (t <= now) this.queueBans.delete(k);
  }

  /** How long a whole server tick takes (all rooms): smoothed and the worst since start, for /api/status. */
  tickCost = { avgMs: 0, maxMs: 0 };
  /** Milliseconds per tick of every room this server runs. */
  readonly tickMs: number;
  readonly meter: TickMeter;
  private lastSweep = Date.now();
  private lastHealthAt = 0;
  roomCount(): number {
    return this.rooms.size;
  }

  tick(): void {
    const t0 = performance.now();
    for (const room of this.rooms) {
      room.tick();
      if (room.closed) this.rooms.delete(room);
    }
    const spent = performance.now() - t0;
    if (this.meter.record(t0, spent)) {
      const r = this.meter.report();
      console.warn(`server busy: ticks take ${r.avgMs} ms of a ${this.tickMs} ms step (load ${Math.round(r.load * 100)} %, ${r.late} late ticks in the last minute). Raise the Render plan or set ARENA_TICK_MS=50.`);
    }
    this.tickCost.avgMs += (spent - this.tickCost.avgMs) * 0.02;
    if (spent > this.tickCost.maxMs) this.tickCost.maxMs = spent;
    const now = Date.now();
    for (const [id, inv] of this.invites) {
      if (now - inv.at > INVITE_TTL_MS) {
        this.invites.delete(id);
        send(inv.to, { t: 'invite_gone', id });
        this.dissolveIfAlone(inv.from);
      }
    }
    if (now - this.lastSweep >= 60000) { this.lastSweep = now; this.sweep(now); } // once a minute
    if (this.time && this.clock() - this.lastTimeAt >= 1000) this.sampleTime(); // play time: once a second
    if (this.health && this.clock() - this.lastHealthAt >= 1000) {
      this.lastHealthAt = this.clock();
      this.health.record(this.meter.drain(), this.conns.size);
    }
    for (const q of this.conns) {
      if (q.duelWith !== undefined && now - (q.duelAt ?? 0) > DUEL_WAIT_MS) {
        q.duelWith = undefined;
        send(q, { t: 'closed', reason: 'Your friend did not join the duel.' });
      }
    }
  }
}
