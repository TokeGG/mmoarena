import { ABILITIES, ARENAS, AURAS, CLASSES, SPECS, TALENTS, TUNING, arenaById, findArena, isCustomArena } from './data';
import { ArenaSim } from './sim';
import type { AddUnitOptions, SimCommand } from './sim';
import type { RosterEntry } from './accounts';
import type { SimEvent, Snapshot, TeamId } from './types';

/**
 * Bump when the simulation's rules (code, not data) change in a way that alters outcomes: older replays would no longer
 * play out the same, so they are refused instead of showing something wrong. Data changes are caught by `contentHash`.
 */
export const SIM_REVISION = 136;

/** A small hash of every balance-relevant data file; a replay only plays on the data it was recorded with. */
export function contentHash(tickMs: number = TUNING.tickMs): string {
  // the tick length a match was played at is part of what it needs (a replay recorded at 16 ms plays on 16 ms steps whatever the server runs now)
  const text = JSON.stringify([ABILITIES, AURAS, CLASSES, SPECS, TALENTS, tickMs === TUNING.tickMs ? TUNING : { ...TUNING, tickMs }, ARENAS]);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${SIM_REVISION}.${(h >>> 0).toString(36)}`;
}

export interface ReplayData {
  v: 1;
  hash: string;
  arena: string;
  /** The map is one of the owner's custom maps (not part of the game's data): the replay needs it to still exist. */
  custom?: true;
  seed: number;
  prepMs: number;
  /** Milliseconds per tick the match was played at (absent: TUNING.tickMs, what older recordings used). `ticks` and every command's tick number count these. */
  tickMs?: number;
  /** Practice against bots: the match has no time limit and no dampening. */
  endless?: true;
  /** Units in the order they were added (so their ids are 1..n). */
  units: AddUnitOptions[];
  cmds: SimCommand[];
  /** Ticks the match ran for. */
  ticks: number;
  winner: TeamId | 'draw' | null;
  roster: RosterEntry[];
}

/** Collects what a replay needs from a live sim. Attach right after constructing the sim, before any unit is added. */
export class ReplayRecorder {
  private units: AddUnitOptions[] = [];
  private cmds: SimCommand[] = [];
  constructor(private sim: ArenaSim, private meta: { arena: string; seed: number; prepMs: number }) {
    sim.onUnit = (o) => this.units.push(structuredClone(o));
    sim.onCommand = (c) => this.cmds.push(c);
  }
  finish(roster: RosterEntry[]): ReplayData {
    this.sim.onUnit = null;
    this.sim.onCommand = null;
    return { v: 1, hash: contentHash(this.sim.tickMs), ...this.meta, ...(isCustomArena(this.meta.arena) ? { custom: true as const } : {}), ...(this.sim.tickMs !== TUNING.tickMs ? { tickMs: this.sim.tickMs } : {}), ...(this.sim.endless ? { endless: true as const } : {}), units: this.units, cmds: this.cmds, ticks: this.sim.tickNo, winner: this.sim.winner, roster };
  }
}

/**
 * Why a recording cannot be played because of its map, or null. A replay records the map id (and `custom` when it is one of the
 * owner's custom maps). If that custom map was deleted since, or this client was not sent it, playing it on the default map
 * would show something wrong, so it is refused with a plain message. Other unknown ids keep the old behaviour (default map).
 */
export function replayMapProblem(data: Pick<ReplayData, 'arena' | 'custom'>): string | null {
  return data.custom && !findArena(data.arena) ? `This match was played on a custom map ("${data.arena}") that no longer exists, so it cannot be replayed.` : null;
}

/** Plays a recording forward on a local sim. Same commands on the same tick = same match. */
export class ReplayRunner {
  sim!: ArenaSim;
  private cursor = 0;
  constructor(readonly data: ReplayData) {
    const gone = replayMapProblem(data);
    if (gone) throw new Error(gone);
    this.reset();
  }
  /** Milliseconds per tick of this recording. */
  get tickMs(): number {
    return this.data.tickMs ?? TUNING.tickMs;
  }
  get tick(): number {
    return this.sim.tickNo;
  }
  get done(): boolean {
    return this.sim.tickNo >= this.data.ticks;
  }
  reset(): void {
    this.sim = new ArenaSim({ tickMs: this.data.tickMs, seed: this.data.seed, prepMs: this.data.prepMs, arena: arenaById(this.data.arena), facing: true });
    if (this.data.endless) this.sim.endless = true;
    for (const u of this.data.units) this.sim.addUnit(u);
    this.cursor = 0;
  }
  /** Advance one tick and return what happened in it. */
  step(): SimEvent[] {
    const { cmds } = this.data;
    const now = this.sim.tickNo;
    while (this.cursor < cmds.length && cmds[this.cursor][0] <= now) {
      const [, op, id, ...a] = cmds[this.cursor++];
      switch (op) {
        case 0:
          this.sim.queueInput(id, { seq: a[0] as number, fwd: a[1] as number, strafe: a[2] as number, facing: a[3] as number, jump: a[4] === 1 });
          break;
        case 1:
          this.sim.setTarget(id, a[0] as number | null);
          break;
        case 2:
          this.sim.useAbility(id, a[0] as string, a[1] as number | null, typeof a[2] === 'number' && typeof a[3] === 'number' ? { x: a[2], z: a[3], ...(a[5] === 1 ? { lv: 1 as const } : {}) } : null, typeof a[4] === 'number' ? a[4] : 0, typeof a[6] === 'number' ? a[6] : undefined);
          break;
        case 3:
          this.sim.setAutoAttack(id, a[0] === true);
          break;
        case 5:
          this.sim.setAutoDisabled(id, a[0] === true);
          break;
        case 4:
          this.sim.forfeit(id);
          break;
        case 6:
          this.sim.stopCast(id);
          break;
      }
    }
    this.sim.step();
    return this.sim.drainEvents();
  }
  /** Jump to a tick (rewinding re-simulates from the start, which is cheap at 20 Hz). */
  seek(tick: number): void {
    if (tick < this.sim.tickNo) this.reset();
    while (this.sim.tickNo < Math.min(tick, this.data.ticks)) this.step();
  }
  snapshot(): Snapshot {
    return this.sim.snapshot();
  }
}
