import { ABILITIES, ARENAS, AURAS, CLASSES, SPECS, TALENTS, TUNING, arenaById } from './data';
import { ArenaSim } from './sim';
import type { AddUnitOptions, SimCommand } from './sim';
import type { RosterEntry } from './accounts';
import type { SimEvent, Snapshot, TeamId } from './types';

/**
 * Bump when the simulation's rules (code, not data) change in a way that alters outcomes: older replays would no longer
 * play out the same, so they are refused instead of showing something wrong. Data changes are caught by `contentHash`.
 */
export const SIM_REVISION = 7;

/** A small hash of every balance-relevant data file; a replay only plays on the data it was recorded with. */
export function contentHash(): string {
  const text = JSON.stringify([ABILITIES, AURAS, CLASSES, SPECS, TALENTS, TUNING, ARENAS]);
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
  seed: number;
  prepMs: number;
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
    return { v: 1, hash: contentHash(), ...this.meta, units: this.units, cmds: this.cmds, ticks: this.sim.tickNo, winner: this.sim.winner, roster };
  }
}

/** Plays a recording forward on a local sim. Same commands on the same tick = same match. */
export class ReplayRunner {
  sim!: ArenaSim;
  private cursor = 0;
  constructor(readonly data: ReplayData) {
    this.reset();
  }
  get tick(): number {
    return this.sim.tickNo;
  }
  get done(): boolean {
    return this.sim.tickNo >= this.data.ticks;
  }
  reset(): void {
    this.sim = new ArenaSim({ seed: this.data.seed, prepMs: this.data.prepMs, arena: arenaById(this.data.arena) });
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
          this.sim.useAbility(id, a[0] as string, a[1] as number | null, typeof a[2] === 'number' && typeof a[3] === 'number' ? { x: a[2], z: a[3] } : null);
          break;
        case 3:
          this.sim.setAutoAttack(id, a[0] === true);
          break;
        case 4:
          this.sim.forfeit(id);
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
