import type { WebSocket } from 'ws';
import { ArenaSim, Bot, CLASSES, PROTOCOL_VERSION } from '@arena/shared';
import { issueProfile, verifyProfile } from './profile';
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
}

export function send(p: Player, msg: ServerMsg): void {
  if (p.ws.readyState === 1 /* OPEN */) p.ws.send(JSON.stringify(msg));
}

export class Room {
  readonly sim: ArenaSim;
  readonly players = new Map<number, Player>(); // unitId -> player
  closed = false;
  private bots: Bot[] = [];
  private endedTicks = 0;

  private credited = false;

  /** `countsForProgress`: whether finishing this match earns gear-tier progress (not true for dummy practice). */
  constructor(prepMs: number, private countsForProgress = true, private minCountedMs = MIN_COUNTED_MATCH_MS) {
    this.sim = new ArenaSim({ prepMs, seed: Math.floor(Math.random() * 2 ** 31) });
  }

  addPlayer(p: Player, team: TeamId): void {
    const u = this.sim.addUnit({ name: p.name, classId: p.classId, team, controller: 'player', build: p.build });
    p.unitId = u.id;
    p.room = this;
    this.players.set(u.id, p);
    send(p, { t: 'welcome', protocol: PROTOCOL_VERSION, unitId: u.id, team, classId: p.classId, spec: u.spec });
    send(p, { t: 'profile', token: issueProfile({ matches: p.matches, wins: p.wins }), matches: p.matches, wins: p.wins });
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
        this.sim.queueInput(id, { seq: msg.seq, fwd: msg.fwd, strafe: msg.strafe, facing: msg.facing });
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
      if (this.sim.phase !== 'ended') this.sim.forfeit(p.unitId);
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
    for (const p of this.players.values()) {
      const me = this.sim.units.get(p.unitId!);
      if (!me) continue;
      p.matches++;
      if (this.sim.winner === me.team) p.wins++;
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

  constructor(private cfg: LobbyConfig) {}

  connect(ws: WebSocket): Player {
    return { id: this.nextPlayerId++, ws, name: 'Player', classId: 'warrior', matches: 0, wins: 0 };
  }

  handle(p: Player, msg: ClientMsg): void {
    switch (msg.t) {
      case 'join':
        if (p.room || this.queue.includes(p)) return;
        {
          const progress = verifyProfile(msg.profile) ?? { matches: 0, wins: 0 };
          const build = msg.build;
          if (build) {
            const check = validateBuild(msg.classId, build, progress.matches);
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
        p.name = msg.name;
        p.classId = msg.classId;
        if (msg.mode === 'practice') this.startPractice(p, msg);
        else this.enqueue(p);
        break;
      case 'leave':
        this.leave(p);
        break;
      default:
        p.room?.command(p, msg);
    }
  }

  disconnect(p: Player): void {
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
    const room = new Room(this.cfg.practicePrepMs, difficulty !== 'dummy', this.cfg.minCountedMatchMs);
    room.addPlayer(p, 0);
    if (ally) room.addNpc(ally, 0, difficulty);
    for (const foe of foes) room.addNpc(foe, 1, difficulty);
    this.rooms.add(room);
  }

  private enqueue(p: Player): void {
    this.queue.push(p);
    if (this.queue.length >= QUEUE_SIZE) {
      const room = new Room(this.cfg.queuePrepMs, true, this.cfg.minCountedMatchMs);
      const group = this.queue.splice(0, QUEUE_SIZE);
      group.forEach((player, i) => room.addPlayer(player, i < QUEUE_SIZE / 2 ? 0 : 1));
      this.rooms.add(room);
    }
    this.announceQueue();
  }

  private announceQueue(): void {
    for (const p of this.queue) send(p, { t: 'queued', waiting: this.queue.length, needed: QUEUE_SIZE });
  }

  tick(): void {
    for (const room of this.rooms) {
      room.tick();
      if (room.closed) this.rooms.delete(room);
    }
  }
}
