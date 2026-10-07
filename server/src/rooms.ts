import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { WebSocket } from 'ws';
import { ARENAS, ArenaSim, Bot, CLASSES, botBuild, PROTOCOL_VERSION, ReplayRecorder, START_RATING, arenaById, resolveCosmetics } from '@arena/shared';
import type { StatRow, FriendRow, FriendStatus, LiveMatch, MatchPlayer, MatchRecord, PartyInfo, RosterEntry, Snapshot, SimEvent } from '@arena/shared';
import { issueProfile, verifyProfile } from './profile';
import { findMatch } from './matchmaking';
import type { QEntry } from './matchmaking';
import { publicInfo } from './accounts';
import type { AccountRecord, Accounts } from './accounts';
import type { BotLearner } from './botlearn';
import type { Suggestions } from './suggestions';
import { barSwapped, cleanGear, emptyBuild, gearLook, isOwnerName, specOf, validateBuild } from '@arena/shared';
import type { Build, ClassId, ClientMsg, Difficulty, PracticeDifficulty, ServerMsg, TeamId, TeamSize } from '@arena/shared';

type JoinMsg = Extract<ClientMsg, { t: 'join' }>;

/** Spectators see ranked matches this far behind, so watching cannot help the players. */
const SPECTATE_DELAY_TICKS = 20 * 5;
const TICKS_AFTER_END = 20 * 300; // the end screen is a ready check: the room stays open until everyone is ready or leaves (or sits idle this long)
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
  /** Signed-in account (authoritative progress and rating) and its session token. */
  account?: AccountRecord;
  token?: string;
  /** Owner code entered for this session: custom styles, GIF icon, admin panel. */
  ownerOk?: boolean;
  /** Account actions run one at a time per connection. */
  chain: Promise<void>;
  lastSettingsSave?: number;
  /** Arena chosen at join: an arena id or 'random'. */
  mapPref: string;
  /** Players per team chosen at join. */
  size: TeamSize;
  /** The match this connection is watching, if any. */
  watching?: Room;
  party?: Party;
  /** Waiting for this friend to join a duel (account key), and since when. */
  duelWith?: string;
  duelAt?: number;
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

export function send(p: Player, msg: ServerMsg): void {
  if (p.ws.readyState === 1 /* OPEN */) p.ws.send(JSON.stringify(msg));
}

/** An arena id, resolving 'random' (or anything unknown) to a random arena. */
export function pickMap(pref: string): string {
  return ARENAS.some((a) => a.id === pref) ? pref : ARENAS[Math.floor(Math.random() * ARENAS.length)].id;
}

export class Room {
  readonly sim: ArenaSim;
  readonly players = new Map<number, Player>(); // unitId -> player
  closed = false;
  private bots: Bot[] = [];
  /** Which learned brain each bot is playing with, to credit the result at the end. */
  private botMeta: { unitId: number; classId: ClassId; variantId: string }[] = [];
  learner?: BotLearner;
  private botsReported = false;
  private endedTicks = 0;
  private finalSent = false;
  private finalSentLate = false;
  /** Who has pressed Play again, and what the lobby needs to rebuild the match when everyone has. */
  private rematchVotes = new Set<Player>();
  onRematch: ((room: Room) => void) | null = null;
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
  private deltas = new Map<number, { rating: number; delta: number }>();

  /** `countsForProgress`: whether finishing this match earns gear-tier progress (not true for dummy practice). */
  constructor(prepMs: number, private countsForProgress = true, private minCountedMs = MIN_COUNTED_MATCH_MS, private ranked = false, private accounts?: Accounts, readonly arenaId: string = ARENAS[0].id) {
    this.seed = Math.floor(Math.random() * 2 ** 31);
    this.prepMsUsed = prepMs;
    this.sim = new ArenaSim({ prepMs, seed: this.seed, arena: arenaById(arenaId), facing: true });
    // matches that count are recorded so they can be replayed; dummy practice is not worth storing
    if (accounts && countsForProgress) this.recorder = new ReplayRecorder(this.sim, { arena: arenaId, seed: this.seed, prepMs });
  }

  addPlayer(p: Player, team: TeamId): void {
    const u = this.sim.addUnit({ name: p.name, classId: p.classId, team, controller: 'player', build: p.build });
    p.unitId = u.id;
    p.room = this;
    this.players.set(u.id, p);
    if (p.account) this.keys.set(u.id, p.account.key);
    this.notify?.(p);
    send(p, { t: 'welcome', protocol: PROTOCOL_VERSION, unitId: u.id, team, classId: p.classId, spec: u.spec, ...(barSwapped(u.classId, u.spec, u.bar) ? { bar: u.bar } : {}), map: this.arenaId });
    if (!p.account) send(p, { t: 'profile', token: issueProfile({ matches: p.matches, wins: p.wins }), matches: p.matches, wins: p.wins });
  }

  /** Tell everyone in the room how the signed-in players want to be shown (emblem, title, name colour). */
  roster(): RosterEntry[] {
    return [...this.players.entries()]
      .filter(([, p]) => p.account)
      .map(([unitId, p]) => ({ unitId, rating: p.account!.rating, ...resolveCosmetics(p.account!.cosmetics), avatarUrl: p.account!.avatar ? `/avatar/${p.account!.key}?v=${p.account!.avatar}` : undefined }));
  }

  broadcastRoster(): void {
    const players = this.roster();
    if (!players.length) return;
    for (const p of [...this.players.values(), ...this.spectators]) send(p, { t: 'roster', players });
  }

  /** Any match with a person in it can be watched while it runs (dummy training is private and skipped). */
  get watchable(): boolean {
    return this.countsForProgress && this.players.size > 0 && !this.closed && this.sim.phase !== 'ended';
  }

  live(): LiveMatch {
    return {
      id: this.id,
      map: this.arenaId,
      size: this.size,
      elapsedMs: Math.max(0, Math.round(this.sim.time - this.sim.prepEndsAt)),
      ranked: this.ranked,
      players: [...this.sim.units.values()].map((u) => ({ name: u.name, classId: u.classId, team: u.team })),
    };
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
        if (e.src >= 0 && e.src !== e.tgt) row(e.src).dmg += n;
        row(e.tgt).taken += n;
      } else if (e.t === 'heal') {
        row(e.src).heal += e.amount;
        row(e.src).overheal += e.overheal;
        row(e.tgt).healTaken += e.amount;
      }
    }
  }

  statRows(): StatRow[] {
    return [...this.sim.units.values()].map((u) => {
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
  }

  removeSpectator(p: Player): void {
    this.spectators.delete(p);
    p.watching = undefined;
  }

  /** Average rating of the humans on a team; guests and bots count as the starting rating. */
  private teamAvg(team: number): number {
    const r: number[] = [];
    for (const [id, p] of this.players) if (this.sim.units.get(id)?.team === team) r.push(p.account?.rating ?? START_RATING);
    return r.length ? r.reduce((a, b) => a + b, 0) / r.length : START_RATING;
  }

  /** A stand-in that never acts (difficulty 'dummy') or a bot that plays by the normal rules. */
  addNpc(classId: ClassId, team: TeamId, difficulty: PracticeDifficulty): void {
    this.npcPlan.push({ classId, team, difficulty });
    const label = CLASSES[classId].name;
    if (difficulty === 'dummy') {
      this.sim.addUnit({ name: `Dummy ${label}`, classId, team, controller: 'dummy' });
      return;
    }
    const seed = Math.floor(Math.random() * 2 ** 31);
    const u = this.sim.addUnit({ name: `Bot ${label}`, classId, team, controller: 'bot', build: botBuild(classId, seed) });
    const learned = this.learner?.pick(classId);
    this.bots.push(new Bot(this.sim, u.id, difficulty as Difficulty, seed, learned?.brain));
    if (learned) this.botMeta.push({ unitId: u.id, classId, variantId: learned.variantId });
  }

  command(p: Player, msg: ClientMsg): void {
    const id = p.unitId;
    if (id === undefined || this.closed) return;
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
        const r = this.sim.useAbility(id, msg.ability, msg.target, msg.x !== undefined && msg.z !== undefined ? { x: msg.x, z: msg.z } : null, rewind);
        if (!r.ok) send(p, { t: 'error', reason: r.reason, ability: msg.ability });
        break;
      }
      case 'auto':
        this.sim.setAutoAttack(id, msg.on);
        break;
      case 'autoOff':
        this.sim.setAutoDisabled(id, msg.off);
        break;
      case 'rematch':
        if (this.sim.phase !== 'ended') break;
        if (msg.on) this.rematchVotes.add(p);
        else this.rematchVotes.delete(p);
        this.afterVote();
        break;
    }
  }

  /** Tell everyone how many are ready, and start the next match once all of them are. */
  private afterVote(): void {
    for (const q of this.players.values()) send(q, { t: 'rematch', ready: this.rematchVotes.size, total: this.players.size, you: this.rematchVotes.has(q) });
    if (this.sim.phase === 'ended' && !this.closed && this.players.size > 0 && this.rematchVotes.size >= this.players.size) this.onRematch?.(this);
  }

  /** What the lobby needs to play this match again. */
  rematchPlan() {
    return {
      prepMs: this.prepMsUsed, counts: this.countsForProgress, ranked: this.ranked, map: this.arenaId, size: this.size, npcs: this.npcPlan,
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
      if (this.sim.phase !== 'ended') {
        // leaving a live ranked match is a loss
        const me = this.sim.units.get(p.unitId);
        if (this.ranked && this.accounts && p.account && me && this.sim.phase === 'live') {
          const acc = p.account;
          this.accounts
            .recordForfeit(acc.name, this.teamAvg(1 - me.team))
            .then((a) => {
              if (a) {
                this.deltas.set(me.id, { rating: a.rating, delta: a.rating - acc.rating });
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
    if (this.players.size === 0) this.closed = true;
    else if (this.sim.phase === 'ended') this.afterVote(); // the ones still here may all be ready already
    this.notify?.(p);
  }

  tick(): void {
    for (const bot of this.bots) bot.tick(); // bots queue their input for this tick, then the sim steps
    this.sim.step();
    const events = this.sim.drainEvents();
    // everyone on a team gets the same view, so build and serialise it once per team
    const frames = new Map<number, string>();
    for (const p of this.players.values()) {
      const me = this.sim.units.get(p.unitId!);
      if (!me) continue;
      let frame = frames.get(me.team);
      if (frame === undefined) {
        frame = JSON.stringify({ t: 'snapshot', snap: this.sim.snapshot(me.team), events });
        frames.set(me.team, frame);
      }
      if (p.ws.readyState === 1 /* OPEN */) p.ws.send(frame);
    }
    this.tally(events);
    if (this.countsForProgress) {
      // spectators get the whole arena (nothing hidden), five seconds late; the owner watches live
      const snap = this.sim.snapshot();
      this.delayed.push({ snap, events });
      if (this.spectators.size) {
        const live = [...this.spectators].filter((w) => w.ownerOk);
        if (live.length) {
          const frame = JSON.stringify({ t: 'snapshot', snap, events });
          const stats = this.sim.tickNo % 10 === 0 ? JSON.stringify({ t: 'stats', rows: this.statRows() }) : null;
          for (const w of live) if (w.ws.readyState === 1) { w.ws.send(frame); if (stats) w.ws.send(stats); }
        }
      }
      if (this.delayed.length > SPECTATE_DELAY_TICKS) {
        const f = this.delayed.shift()!;
        const late = [...this.spectators].filter((w) => !w.ownerOk);
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
      this.reportBots();
      if (++this.endedTicks >= TICKS_AFTER_END) this.close('match over');
    }
  }

  /** Once per match: tell the bot learner how each bot's brain did against the humans it faced. */
  private reportBots(): void {
    if (this.botsReported) return;
    this.botsReported = true;
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
      this.learner.report(m.classId, m.variantId, w === team);
    }
  }

  /** Once per match: players still connected earn progress, counted in your matches and wins. */
  private creditProgress(): void {
    if (this.credited) return;
    this.credited = true;
    if (!this.countsForProgress || this.sim.time - this.sim.prepEndsAt < this.minCountedMs) return;
    const draw = this.sim.winner === 'draw';
    const replay = this.recorder?.finish(this.roster()) ?? null;
    if (replay && this.learner) setImmediate(() => this.learner?.learnFrom(replay)); // the bots study how the people played
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
    void Promise.all(jobs).then(() => this.saveRecord(replay)).catch(() => {});
  }

  /** Match history for every signed-in human who took part, plus the replay they can all open. */
  private async saveRecord(replay: ReturnType<ReplayRecorder['finish']> | null): Promise<void> {
    const acc = this.accounts;
    if (!acc || this.keys.size === 0) return;
    let stored = false;
    if (replay) {
      try {
        stored = await acc.saveReplay(this.id, zlib.gzipSync(JSON.stringify(replay)));
      } catch {
        stored = false;
      }
    }
    const players: MatchPlayer[] = [...this.sim.units.values()].map((u) => {
      const d = this.deltas.get(u.id);
      return { name: u.name, classId: u.classId, spec: u.spec, team: u.team, human: u.controller === 'player', ...(d ? { rating: d.rating, delta: d.delta } : {}) };
    });
    const rec: MatchRecord = { id: this.id, at: Date.now(), size: this.size, ranked: this.ranked, map: this.arenaId, durationMs: Math.max(0, Math.round(this.sim.time - this.sim.prepEndsAt)), winner: this.sim.winner, players, replay: stored };
    await acc.addHistory([...this.keys.values()], rec);
  }

  private close(reason: string): void {
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
  }
}

export interface LobbyConfig {
  practicePrepMs: number;
  queuePrepMs: number;
  /** Live time a match needs before it counts towards gear unlocks. Defaults to 20 s. */
  minCountedMatchMs?: number;
}

export class Lobby {
  private rooms = new Set<Room>();
  private queue: QEntry<Player>[] = [];
  private invites = new Map<string, Invite>();
  private nextPlayerId = 1;
  private inQueue(p: Player): boolean {
    return this.queue.some((e) => e.members.includes(p));
  }

  constructor(private cfg: LobbyConfig, private accounts?: Accounts, private learner?: BotLearner, private suggestions?: Suggestions) {}
  private lastSuggest = new Map<number, number>();

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

  connect(ws: WebSocket, ip = ''): Player {
    const p: Player = { id: this.nextPlayerId++, ws, name: 'Player', classId: 'warrior', matches: 0, wins: 0, ip, chain: Promise.resolve(), mapPref: 'random', size: 2 };
    this.conns.add(p);
    return p;
  }

  /** Account messages are async (hashing, storage), so they run in order per connection off the game loop. */
  private account(p: Player, msg: ClientMsg): void {
    p.chain = p.chain.then(() => this.handleAccount(p, msg)).catch(() => {});
  }

  private async handleAccount(p: Player, msg: ClientMsg): Promise<void> {
    const acc = this.accounts;
    if (!acc) return void send(p, { t: 'auth_error', reason: 'Accounts are not available on this server.' });
    try {
      switch (msg.t) {
        case 'register':
        case 'login':
        case 'resume': {
          if (p.room || this.inQueue(p)) return void send(p, { t: 'auth_error', reason: 'Finish or leave your match first.' });
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
          if (p.token) await acc.logout(p.token);
          this.leaveParty(p);
          this.dropInvites(p);
          {
            const was = p.account;
            p.account = undefined;
            p.token = undefined;
            p.ownerOk = false;
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
          const now = Date.now();
          if (now - (p.lastSettingsSave ?? 0) < 1500) return; // at most one write per 1.5 s per connection
          p.lastSettingsSave = now;
          try {
            const obj = JSON.parse(msg.data) as unknown;
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
            if (!Object.entries(obj).every(([k, v]) => k.startsWith('arena.') && k.length < 80 && typeof v === 'string')) return;
          } catch {
            return;
          }
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
          if (!p.ownerOk) return void send(p, { t: 'auth_error', reason: 'Owner tools are locked.' });
          send(p, { t: 'admin_accounts', rows: await acc.adminList(this.onlineKeys()) });
          break;
        }
        case 'admin_set': {
          if (!p.ownerOk) return void send(p, { t: 'auth_error', reason: 'Owner tools are locked.' });
          const r = await acc.adminSet(msg.name, msg);
          if (!r.ok) return void send(p, { t: 'admin_result', ok: false, name: msg.name, reason: r.reason });
          // a friend who is online gets the change immediately (and a reset password signs them out)
          for (const q of this.conns) {
            if (q.account?.key !== r.account.key) continue;
            if (msg.resetPassword) {
              q.account = undefined;
              q.token = undefined;
              q.ownerOk = false;
              send(q, { t: 'logged_out' });
            } else {
              q.account = r.account;
              send(q, { t: 'account', account: publicInfo(r.account) });
            }
          }
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
    // cosmetics that no longer exist (an old save) are dropped quietly rather than refusing the match
    const isOwner = !!p.account && isOwnerName(p.account.name);
    const build = msg.build ? { ...msg.build, gear: cleanGear(msg.build.gear, isOwner) } : undefined;
    if (build) {
      const check = validateBuild(msg.classId, build, isOwner);
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
    switch (msg.t) {
      case 'join':
        if (p.room || this.inQueue(p)) return;
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
      case 'leave': {
        // leaving a match keeps the socket (and the party) alive: tell the client to go back to the menu
        const inMatch = !!p.room;
        this.leave(p);
        if (inMatch) send(p, { t: 'closed', reason: 'You left the match.' });
        break;
      }
      case 'ready': {
        const party = p.party;
        if (!party || party.leader === p || p.room || this.inQueue(p)) return;
        if (msg.on) {
          if (!this.applyIdentity(p, msg)) return;
          party.ready.add(p);
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
        p.view = { classId: msg.classId, spec, look: gearLook(cleanGear(build.gear, !!p.ownerOk)) };
        this.sendParty(party);
        break;
      }
      case 'party_side': {
        const party = p.party;
        if (!party || p.room || this.inQueue(p)) return;
        party.sides.set(p, msg.side);
        this.sendParty(party);
        break;
      }
      case 'live':
        send(p, { t: 'live', rows: [...this.rooms].filter((r) => r.watchable).map((r) => r.live()) });
        break;
      case 'spectate': {
        if (p.room || this.inQueue(p)) return;
        const room = [...this.rooms].find((r) => r.id === msg.id && r.watchable);
        if (!room) return void send(p, { t: 'closed', reason: 'That match is over.' });
        p.watching?.removeSpectator(p);
        room.addSpectator(p);
        this.changed(p);
        break;
      }
      case 'invite':
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
        const last = this.lastSuggest.get(p.id) ?? 0;
        if (!this.suggestions) return void send(p, { t: 'suggest_ack', ok: false, reason: 'The suggestion box is not available.' });
        if (Date.now() - last < 20000) return void send(p, { t: 'suggest_ack', ok: false, reason: 'Slow down: one suggestion every 20 seconds.' });
        this.lastSuggest.set(p.id, Date.now());
        void this.suggestions.add(p.account?.name ?? p.name ?? 'guest', msg.text).then((ok) => send(p, { t: 'suggest_ack', ok, reason: ok ? undefined : 'Could not save that, try again.' }));
        break;
      }
      case 'suggestions':
        if (!p.ownerOk || !this.suggestions) return void send(p, { t: 'suggest_ack', ok: false, reason: 'Only the owner can read the box.' });
        void this.suggestions.list().then((rows) => send(p, { t: 'suggestions', rows }));
        break;
      case 'suggest_delete':
        if (!p.ownerOk || !this.suggestions) return void send(p, { t: 'suggest_ack', ok: false, reason: 'Only the owner can delete suggestions.' });
        void this.suggestions.remove(msg.at, msg.text).then(() => this.suggestions!.list()).then((rows) => send(p, { t: 'suggestions', rows }));
        break;
      default:
        p.room?.command(p, msg);
    }
  }

  disconnect(p: Player): void {
    this.conns.delete(p);
    this.leave(p);
    this.leaveParty(p);
    this.dropInvites(p);
    this.changed(p);
  }

  private leave(p: Player): void {
    this.dequeue(p);
    p.duelWith = undefined;
    p.room?.removePlayer(p);
    p.watching?.removeSpectator(p);
    if (p.party) {
      p.party.ready.delete(p);
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
      rows.push(q?.account ? { name: q.account.name, status: this.statusOf(q), rating: q.account.rating, cosmetics: q.account.cosmetics } : { name, status: 'offline' });
    }
    const rank: Record<FriendStatus, number> = { menu: 0, party: 0, queue: 1, match: 1, offline: 2 };
    return rows.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
  }

  private pushFriends(p: Player): void {
    if (p.account) send(p, { t: 'friends', friends: this.friendRows(p), requests: p.account.requests ?? [] });
  }

  /** Something about `p` changed (online, queueing, in a match...): tell the friends who are watching their list. */
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
      if (party.leader === p) party.leader = party.members[0];
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
      }
    }
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
    if (!this.idle(to)) return void send(p, { t: 'notice', text: `${to.account!.name} is busy right now.` });
    if ([...this.invites.values()].some((i) => i.from === p && i.to === to)) return void send(p, { t: 'notice', text: 'Already invited.' });
    let party: Party | undefined;
    if (kind === 'party') {
      if (to.party) return void send(p, { t: 'notice', text: `${to.account!.name} is already in a party.` });
      party = p.party;
      if (party && party.leader !== p) return void send(p, { t: 'notice', text: 'Only the party leader can invite.' });
      const pending = [...this.invites.values()].filter((i) => i.kind === 'party' && i.from === p).length;
      if (party && party.members.length + pending >= 3) return void send(p, { t: 'notice', text: 'A party holds at most three players.' });
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
    if (!accept) return void send(from, { t: 'notice', text: `${p.account?.name ?? 'They'} declined.` });
    if (!this.idle(p) || !this.idle(from)) return void send(p, { t: 'notice', text: 'That invite is no longer possible.' });
    if (inv.kind === 'party') {
      const party = inv.party;
      if (!party || party.members.length === 0 || from.party !== party) return void send(p, { t: 'notice', text: 'That party is gone.' });
      if (party.members.length >= 3) return void send(p, { t: 'notice', text: 'That party is full.' });
      if (p.party) return;
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
    const room = this.makeRoom(this.cfg.queuePrepMs, true, false, pickMap(first.mapPref));
    room.size = 1;
    p.duelWith = mate.duelWith = undefined;
    room.addPlayer(mate, 0);
    room.addPlayer(p, 1);
    room.broadcastRoster();
    this.rooms.add(room);
  }

  // ------------------------------------------------------------------ rooms and the queue

  private makeRoom(prepMs: number, counts: boolean, ranked: boolean, map: string): Room {
    const room = new Room(prepMs, counts, this.cfg.minCountedMatchMs, ranked, this.accounts, map);
    room.notify = (q) => this.changed(q);
    room.learner = this.learner;
    room.onRematch = (old) => this.rematch(old);
    return room;
  }

  /** Everyone in a finished match pressed Play again: same players, sides and bots in a fresh room. */
  private rematch(old: Room): void {
    const plan = old.rematchPlan();
    old.release();
    const room = this.makeRoom(plan.prepMs, plan.counts, plan.ranked, plan.map);
    room.size = plan.size;
    for (const h of plan.humans) room.addPlayer(h.p, h.team);
    room.broadcastRoster();
    for (const n of plan.npcs) room.addNpc(n.classId, n.team, n.difficulty);
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

  /** A new party member joins whichever side has fewer players. */
  private assignSide(party: Party, p: Player): void {
    const on = (side: number) => [...party.sides].filter(([m, s]) => m !== p && s === side && party.members.includes(m)).length;
    party.sides.set(p, on(0) <= on(1) ? 0 : 1);
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
    const waiting = this.partyMates(p).filter((m) => !p.party!.ready.has(m));
    return waiting.length ? `Waiting for ${waiting.map((m) => m.account?.name ?? m.name).join(', ')} to press Ready.` : null;
  }

  /**
   * Solo players queue straight away. A party's leader picks the mode once everyone else is ready.
   * A party bigger than the team size queues as separate players, so friends can still land in the same match.
   */
  private enqueue(p: Player): void {
    const wait = this.notReady(p);
    if (wait) return void send(p, { t: 'closed', reason: wait });
    const mates = this.partyMates(p);
    const party = p.party;
    const now = Date.now();
    if (mates.length && mates.length + 1 <= p.size) {
      const all = [p, ...mates];
      for (const m of all) {
        m.size = p.size;
        m.mapPref = p.mapPref;
      }
      this.queue.push({ members: all, size: p.size, pref: p.mapPref, at: now });
    } else {
      for (const m of [p, ...mates]) {
        m.size = p.size;
        m.mapPref = p.mapPref;
        this.queue.push({ members: [m], size: p.size, pref: p.mapPref, at: now });
      }
      if (mates.length) for (const m of [p, ...mates]) send(m, { t: 'notice', text: 'Your party is bigger than the team size, so you queue separately and may not be placed together.' });
    }
    if (party) {
      party.ready.clear();
      this.sendParty(party);
    }
    for (const m of [p, ...mates]) this.changed(m);
    this.tryMatch(p.size);
    this.announceQueue();
  }

  private tryMatch(size: TeamSize): void {
    for (;;) {
      const m = findMatch(this.queue, size, () => pickMap('random'));
      if (!m) return;
      const room = this.makeRoom(this.cfg.queuePrepMs, true, true, m.map);
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
      if (m.party) m.party.ready.delete(m);
      this.changed(m);
    }
    this.announceQueue();
  }

  private announceQueue(): void {
    for (const e of this.queue) {
      const compatible = this.queue.filter((x) => x.size === e.size && (x.pref === 'random' || e.pref === 'random' || x.pref === e.pref));
      const waiting = compatible.reduce((n, x) => n + x.members.length, 0);
      for (const m of e.members) send(m, { t: 'queued', waiting, needed: e.size * 2 });
    }
  }

  tick(): void {
    for (const room of this.rooms) {
      room.tick();
      if (room.closed) this.rooms.delete(room);
    }
    const now = Date.now();
    for (const [id, inv] of this.invites) {
      if (now - inv.at > INVITE_TTL_MS) {
        this.invites.delete(id);
        send(inv.to, { t: 'invite_gone', id });
      }
    }
    for (const q of this.conns) {
      if (q.duelWith !== undefined && now - (q.duelAt ?? 0) > DUEL_WAIT_MS) {
        q.duelWith = undefined;
        send(q, { t: 'closed', reason: 'Your friend did not join the duel.' });
      }
    }
  }
}
