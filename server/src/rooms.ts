import type { WebSocket } from 'ws';
import { ARENAS, ArenaSim, Bot, CLASSES, PROTOCOL_VERSION, START_RATING, arenaById, resolveCosmetics } from '@arena/shared';
import { issueProfile, verifyProfile } from './profile';
import { publicInfo } from './accounts';
import type { AccountRecord, Accounts } from './accounts';
import { validateBuild } from '@arena/shared';
import type { Build, ClassId, ClientMsg, Difficulty, PracticeDifficulty, ServerMsg, TeamId } from '@arena/shared';

type JoinMsg = Extract<ClientMsg, { t: 'join' }>;

const QUEUE_SIZE = 4; // 2v2
const TICKS_AFTER_END = 20 * 8; // keep the room open 8s so everyone sees the result
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
}

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
  private endedTicks = 0;

  private credited = false;

  /** `countsForProgress`: whether finishing this match earns gear-tier progress (not true for dummy practice). */
  constructor(prepMs: number, private countsForProgress = true, private minCountedMs = MIN_COUNTED_MATCH_MS, private ranked = false, private accounts?: Accounts, readonly arenaId: string = ARENAS[0].id) {
    this.sim = new ArenaSim({ prepMs, seed: Math.floor(Math.random() * 2 ** 31), arena: arenaById(arenaId) });
  }

  addPlayer(p: Player, team: TeamId): void {
    const u = this.sim.addUnit({ name: p.name, classId: p.classId, team, controller: 'player', build: p.build });
    p.unitId = u.id;
    p.room = this;
    this.players.set(u.id, p);
    send(p, { t: 'welcome', protocol: PROTOCOL_VERSION, unitId: u.id, team, classId: p.classId, spec: u.spec, map: this.arenaId });
    if (!p.account) send(p, { t: 'profile', token: issueProfile({ matches: p.matches, wins: p.wins }), matches: p.matches, wins: p.wins });
  }

  /** Tell everyone in the room how the signed-in players want to be shown (emblem, title, name colour). */
  broadcastRoster(): void {
    const players = [...this.players.entries()]
      .filter(([, p]) => p.account)
      .map(([unitId, p]) => ({ unitId, rating: p.account!.rating, ...resolveCosmetics(p.account!.cosmetics), avatarUrl: p.account!.avatar ? `/avatar/${p.account!.key}?v=${p.account!.avatar}` : undefined }));
    if (!players.length) return;
    for (const p of this.players.values()) send(p, { t: 'roster', players });
  }

  /** Average rating of the humans on a team; guests and bots count as the starting rating. */
  private teamAvg(team: number): number {
    const r: number[] = [];
    for (const [id, p] of this.players) if (this.sim.units.get(id)?.team === team) r.push(p.account?.rating ?? START_RATING);
    return r.length ? r.reduce((a, b) => a + b, 0) / r.length : START_RATING;
  }

  /** A stand-in that never acts (difficulty 'dummy') or a bot that plays by the normal rules. */
  addNpc(classId: ClassId, team: TeamId, difficulty: PracticeDifficulty): void {
    const label = CLASSES[classId].name;
    if (difficulty === 'dummy') {
      this.sim.addUnit({ name: `Dummy ${label}`, classId, team, controller: 'dummy' });
      return;
    }
    const u = this.sim.addUnit({ name: `Bot ${label}`, classId, team, controller: 'bot' });
    this.bots.push(new Bot(this.sim, u.id, difficulty as Difficulty, Math.floor(Math.random() * 2 ** 31)));
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
        const r = this.sim.useAbility(id, msg.ability, msg.target);
        if (!r.ok) send(p, { t: 'error', reason: r.reason, ability: msg.ability });
        break;
      }
      case 'auto':
        this.sim.setAutoAttack(id, msg.on);
        break;
    }
  }

  removePlayer(p: Player): void {
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
  }

  tick(): void {
    for (const bot of this.bots) bot.tick(); // bots queue their input for this tick, then the sim steps
    this.sim.step();
    const events = this.sim.drainEvents();
    for (const p of this.players.values()) {
      const me = this.sim.units.get(p.unitId!);
      if (!me) continue;
      send(p, { t: 'snapshot', snap: this.sim.snapshot(me.team), events });
    }
    if (this.sim.phase === 'ended') {
      this.creditProgress();
      if (++this.endedTicks >= TICKS_AFTER_END) this.close('match over');
    }
  }

  /** Once per match: players still connected earn progress, which unlocks higher gear tiers. */
  private creditProgress(): void {
    if (this.credited) return;
    this.credited = true;
    if (!this.countsForProgress || this.sim.time - this.sim.prepEndsAt < this.minCountedMs) return;
    const draw = this.sim.winner === 'draw';
    for (const p of this.players.values()) {
      const me = this.sim.units.get(p.unitId!);
      if (!me) continue;
      const won = this.sim.winner === me.team;
      if (p.account && this.accounts) {
        // signed in: the server-side account is the source of truth, and ranked matches move the rating
        this.accounts
          .recordMatch(p.account.name, { won, draw, rated: this.ranked, opponentAvg: this.teamAvg(1 - me.team) })
          .then(async (a) => {
            if (!a) return;
            p.account = a;
            const loot = await this.accounts!.grantLoot(a.name, this.ranked ? 'ranked' : 'practice', won);
            if (loot) p.account = loot.account;
            send(p, { t: 'account', account: publicInfo(p.account, p.ownerOk) });
            if (loot && loot.drops.length) send(p, { t: 'loot', drops: loot.drops, discarded: loot.discarded });
          })
          .catch(() => {});
        continue;
      }
      p.matches++;
      if (won) p.wins++;
      send(p, { t: 'profile', token: issueProfile({ matches: p.matches, wins: p.wins }), matches: p.matches, wins: p.wins });
    }
  }

  private close(reason: string): void {
    this.closed = true;
    for (const p of this.players.values()) {
      send(p, { t: 'closed', reason });
      p.room = undefined;
      p.unitId = undefined;
    }
    this.players.clear();
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
  private queue: Player[] = [];
  private nextPlayerId = 1;

  constructor(private cfg: LobbyConfig, private accounts?: Accounts) {}

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
    const p: Player = { id: this.nextPlayerId++, ws, name: 'Player', classId: 'warrior', matches: 0, wins: 0, ip, chain: Promise.resolve(), mapPref: 'random' };
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
          if (p.room || this.queue.includes(p)) return void send(p, { t: 'auth_error', reason: 'Finish or leave your match first.' });
          const r = msg.t === 'register' ? await acc.register(msg.name, msg.password, p.ip, msg.ownerCode) : msg.t === 'login' ? await acc.login(msg.name, msg.password, p.ip) : await acc.resume(msg.token);
          if (!r.ok) return void send(p, { t: 'auth_error', reason: r.reason });
          p.account = r.account;
          p.token = r.token;
          p.matches = r.account.matches;
          p.wins = r.account.wins;
          p.ownerOk = await acc.isOwnerSession(r.token, r.account);
          send(p, { t: 'account', account: publicInfo(r.account, p.ownerOk), token: msg.t === 'resume' ? undefined : r.token });
          send(p, { t: 'settings', data: r.account.settings ?? '' });
          break;
        }
        case 'logout':
          if (p.token) await acc.logout(p.token);
          p.account = undefined;
          p.token = undefined;
          p.ownerOk = false;
          send(p, { t: 'logged_out' });
          break;
        case 'customize': {
          if (!p.account) return;
          const updated = await acc.customize(p.account, msg.cosmetics, !!p.ownerOk);
          if (!updated) return void send(p, { t: 'auth_error', reason: 'That cosmetic is still locked.' });
          p.account = updated;
          send(p, { t: 'account', account: publicInfo(updated, p.ownerOk) });
          break;
        }
        case 'discard': {
          if (!p.account) return;
          const updated = await acc.discard(p.account, msg.id);
          if (!updated) return;
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

  handle(p: Player, msg: ClientMsg): void {
    switch (msg.t) {
      case 'join':
        if (p.room || this.queue.includes(p)) return;
        {
          const progress = p.account ? { matches: p.account.matches, wins: p.account.wins } : verifyProfile(msg.profile) ?? { matches: 0, wins: 0 };
          const build = msg.build;
          if (build) {
            const check = validateBuild(msg.classId, build, progress.matches, p.account?.inventory);
            if (!check.ok) {
              send(p, { t: 'error', reason: `Invalid build: ${check.reason}` });
              send(p, { t: 'closed', reason: `Invalid build: ${check.reason}` });
              return;
            }
          }
          p.matches = progress.matches;
          p.wins = progress.wins;
          p.build = build;
        }
        p.name = p.account ? p.account.name : msg.name;
        p.classId = msg.classId;
        p.mapPref = msg.map ?? 'random';
        if (msg.mode === 'practice') this.startPractice(p, msg);
        else this.enqueue(p);
        break;
      case 'leave':
        this.leave(p);
        break;
      case 'register':
      case 'login':
      case 'resume':
      case 'logout':
      case 'customize':
      case 'save_settings':
      case 'discard':
      case 'leaderboard':
      case 'owner_unlock':
      case 'admin_list':
      case 'admin_set':
        this.account(p, msg);
        break;
      default:
        p.room?.command(p, msg);
    }
  }

  disconnect(p: Player): void {
    this.conns.delete(p);
    this.leave(p);
  }

  private leave(p: Player): void {
    const i = this.queue.indexOf(p);
    if (i >= 0) {
      this.queue.splice(i, 1);
      this.announceQueue();
    }
    p.room?.removePlayer(p);
  }

  /** Defaults (nothing specified): passive dummies, a priest ally, a warrior and a mage on the other side. */
  private startPractice(p: Player, msg: JoinMsg): void {
    const difficulty = msg.difficulty ?? 'dummy';
    const foes = msg.foes ?? (['warrior', 'mage'] as ClassId[]);
    const ally = msg.ally === undefined ? 'priest' : msg.ally;
    const room = new Room(this.cfg.practicePrepMs, difficulty !== 'dummy', this.cfg.minCountedMatchMs, false, this.accounts, pickMap(p.mapPref));
    room.addPlayer(p, 0);
    room.broadcastRoster();
    if (ally) room.addNpc(ally, 0, difficulty);
    for (const foe of foes) room.addNpc(foe, 1, difficulty);
    this.rooms.add(room);
  }

  private enqueue(p: Player): void {
    this.queue.push(p);
    const match = this.findMatch();
    if (match) {
      const room = new Room(this.cfg.queuePrepMs, true, this.cfg.minCountedMatchMs, true, this.accounts, match.map);
      for (const player of match.group) this.queue.splice(this.queue.indexOf(player), 1);
      match.group.forEach((player, i) => room.addPlayer(player, i < QUEUE_SIZE / 2 ? 0 : 1));
      room.broadcastRoster();
      this.rooms.add(room);
    }
    this.announceQueue();
  }

  /**
   * Four players who can share an arena. Someone who picked a specific arena only plays there; 'random' players fill in
   * anywhere. The arena with the longest-waiting specific player is tried first; four randoms get a random arena.
   */
  private findMatch(): { map: string; group: Player[] } | null {
    const randoms = this.queue.filter((p) => p.mapPref === 'random');
    const ids = [...new Set(this.queue.filter((p) => p.mapPref !== 'random').map((p) => p.mapPref))];
    for (const id of ids) {
      const group = [...this.queue.filter((p) => p.mapPref === id), ...randoms].slice(0, QUEUE_SIZE);
      if (group.length >= QUEUE_SIZE) return { map: id, group };
    }
    if (randoms.length >= QUEUE_SIZE) return { map: pickMap('random'), group: randoms.slice(0, QUEUE_SIZE) };
    return null;
  }

  private announceQueue(): void {
    for (const p of this.queue) {
      const waiting = this.queue.filter((q) => q.mapPref === 'random' || p.mapPref === 'random' || q.mapPref === p.mapPref).length;
      send(p, { t: 'queued', waiting, needed: QUEUE_SIZE });
    }
  }

  tick(): void {
    for (const room of this.rooms) {
      room.tick();
      if (room.closed) this.rooms.delete(room);
    }
  }
}
