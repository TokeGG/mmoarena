import { CLASS_IDS, measureHumans, mergeStyle, newPopulation, pickVariant, recordResult, styledBrain } from '@arena/shared';
import type { Brain, ClassId, HumanStyle, Population, ReplayData } from '@arena/shared';
import type { Store } from './store';

const KEY = (c: ClassId) => `botlearn:${c}`;
const STYLE_KEY = (c: ClassId) => `humanstyle:${c}`;

/**
 * Live learning for bots: each class keeps a small population of brains (see shared/src/botbrain.ts). Every bot a room
 * spawns draws one by Thompson sampling, and when a match against a human ends the result is credited back, so the
 * variants that beat real players are drawn more often and the weakest is replaced by a mutation of the best.
 * Persists through the same store as accounts; without Upstash it lives in memory until the next restart.
 */
export class BotLearner {
  private pops = new Map<ClassId, Population>();
  private styles = new Map<ClassId, HumanStyle>();
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
      try {
        const raw = await this.store.get(STYLE_KEY(c));
        if (raw) this.styles.set(c, JSON.parse(raw) as HumanStyle);
      } catch {
        /* no stored style yet */
      }
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

  /**
   * Learn from a finished match: play its replay back, measure what each human did and fold it into that class's human
   * style, then keep a "human" variant (the best bot brain pulled towards that style) in the population. It competes with
   * the others like any variant, so people's habits only stick if they win against people.
   */
  learnFrom(replay: ReplayData): void {
    let measured: ReturnType<typeof measureHumans>;
    try {
      measured = measureHumans(replay);
    } catch {
      return; // an unreadable recording teaches nothing
    }
    for (const { classId, sample } of measured) {
      const pop = this.pops.get(classId);
      if (!pop || !Object.keys(sample).length) continue;
      const style = mergeStyle(this.styles.get(classId) ?? {}, sample);
      this.styles.set(classId, style);
      const rate = (v: { wins: number; games: number }) => (v.wins + 1) / (v.games + 2);
      const base = [...pop.variants].filter((v) => v.id !== 'human').sort((a, b) => rate(b) - rate(a))[0] ?? pop.variants[0];
      const brain = styledBrain(base.brain, style);
      const mine = pop.variants.find((v) => v.id === 'human');
      if (mine) mine.brain = brain;
      else pop.variants.push({ id: 'human', brain, wins: 0, games: 0 });
      const prev = this.saving.get(classId) ?? Promise.resolve();
      this.saving.set(
        classId,
        prev.then(() => Promise.all([this.store.set(KEY(classId), JSON.stringify(pop)), this.store.set(STYLE_KEY(classId), JSON.stringify(style))])).then(() => undefined).catch(() => undefined),
      );
    }
  }

  /** What has been learned from people so far, per class. */
  humanStyles(): Record<string, HumanStyle> {
    return Object.fromEntries(this.styles);
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
