import { CLASS_IDS, newPopulation, pickVariant, recordResult } from '@arena/shared';
import type { Brain, ClassId, Population } from '@arena/shared';
import type { Store } from './store';

const KEY = (c: ClassId) => `botlearn:${c}`;

/**
 * Live learning for bots: each class keeps a small population of brains (see shared/src/botbrain.ts). Every bot a room
 * spawns draws one by Thompson sampling, and when a match against a human ends the result is credited back, so the
 * variants that beat real players are drawn more often and the weakest is replaced by a mutation of the best.
 * Persists through the same store as accounts; without Upstash it lives in memory until the next restart.
 */
export class BotLearner {
  private pops = new Map<ClassId, Population>();
  private ready: Promise<void>;
  private saving = new Map<ClassId, Promise<void>>();

  constructor(private store: Store, private rng: () => number = Math.random) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    for (const c of CLASS_IDS) {
      let pop: Population | undefined;
      try {
        const raw = await this.store.get(KEY(c));
        if (raw) pop = JSON.parse(raw) as Population;
      } catch {
        /* a bad or unreachable record just means starting fresh */
      }
      if (!pop || pop.classId !== c || !Array.isArray(pop.variants) || !pop.variants.length) pop = newPopulation(c, this.rng);
      this.pops.set(c, pop);
    }
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  /** The brain a new bot of this class should play with (the trained baseline until the store has loaded). */
  pick(classId: ClassId): { variantId: string; brain: Brain } | null {
    const pop = this.pops.get(classId);
    if (!pop) return null;
    const v = pickVariant(pop, this.rng);
    return { variantId: v.id, brain: v.brain };
  }

  /** Credit a finished game against humans to the variant that played it. */
  report(classId: ClassId, variantId: string, won: boolean): void {
    const pop = this.pops.get(classId);
    if (!pop) return;
    recordResult(pop, variantId, won, this.rng);
    const prev = this.saving.get(classId) ?? Promise.resolve();
    this.saving.set(
      classId,
      prev.then(() => this.store.set(KEY(classId), JSON.stringify(pop))).catch(() => undefined),
    );
  }

  /** For the status endpoint and the owner: how each class's variants are doing. */
  summary(): Record<string, { generation: number; variants: { id: string; games: number; winRate: number }[] }> {
    const out: Record<string, { generation: number; variants: { id: string; games: number; winRate: number }[] }> = {};
    for (const [c, p] of this.pops) {
      out[c] = { generation: p.generation, variants: p.variants.map((v) => ({ id: v.id, games: v.games, winRate: v.games ? v.wins / v.games : 0 })) };
    }
    return out;
  }
}
