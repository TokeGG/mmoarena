import { promisify } from 'node:util';
import { gzip as gzipCb } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { CLASS_IDS, contentHash, forcedStudy, freshenPopulation, lessonBrain, mergeStyle, newPopulation, pickVariant, readReplay, recordResult, styledBrain } from '@arena/shared';
import type { Brain, ClassId, HumanStyle, Lessons, Population, ReplayData, StudyOptions } from '@arena/shared';
import type { Store } from './store';

const gzip = promisify(gzipCb);

type Measured = ReturnType<typeof readReplay>;
/**
 * Turns a replay into what the bots learn from it: per-human style samples, and how the people beat the bots. The server
 * does it on a worker thread; tests may pass their own.
 */
export type Measure = (replay: ReplayData, opts?: StudyOptions) => Promise<Measured>;

/** Measure on the calling thread, but on a later turn of the event loop (the fallback when no worker can be started). */
export const measureInline: Measure = (replay, opts) => new Promise((resolve, reject) => setImmediate(() => { try { resolve(readReplay(replay, opts)); } catch (e) { reject(e); } }));

/** Replays of matches between people and bots kept for offline study (scripts/study-replays.ts): how many, how long. */
export const LEARN_REPLAYS_MAX = 400;
export const LEARN_REPLAY_TTL_S = 30 * 24 * 3600;
export const LEARN_INDEX_KEY = 'lrp:index';
export const learnReplayKey = (id: string) => `lrp:${id}`;
/** One entry of the study index: which match, when, which bot classes faced which people, and who won. */
export interface LearnIndexEntry { id: string; at: number; bots: ClassId[]; humans: ClassId[]; humansWon: boolean | null; /** The owner chose it for training. */ forced?: boolean }

/** Real results of bots against people, by bot class, the person's class and the bot's difficulty. */
export type Ledger = Record<string, { w: number; g: number }>;
export const ledgerKey = (bot: ClassId, person: ClassId, difficulty: string) => `${bot}>${person}:${difficulty}`;

/**
 * One long-lived worker thread that measures replays off the game loop. If the worker cannot start (or dies), the
 * measurement falls back to the main thread rather than being lost.
 */
export class MeasureWorker {
  private worker: Worker | null = null;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (m: Measured) => void; reject: (e: unknown) => void }>();
  private broken = false;

  readonly measure: Measure = (replay, opts) => {
    const w = this.ensure();
    if (!w) return measureInline(replay, opts);
    const id = this.nextId++;
    return new Promise<Measured>((resolve, reject) => {
      // a worker that never answers must not leak the job forever
      const timer = setTimeout(() => { if (this.waiting.delete(id)) reject(new Error('measuring timed out')); }, 120000);
      timer.unref();
      this.waiting.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      w.postMessage({ id, replay, opts });
    });
  };

  private ensure(): Worker | null {
    if (this.broken) return null;
    if (this.worker) return this.worker;
    try {
      const w = new Worker(new URL('./learnWorkerBoot.mjs', import.meta.url));
      w.unref(); // never keeps the process alive
      w.on('message', (m: { id: number; ok: boolean; measured?: Measured }) => {
        const job = this.waiting.get(m.id);
        if (!job) return;
        this.waiting.delete(m.id);
        if (m.ok && m.measured) job.resolve(m.measured);
        else job.reject(new Error('unreadable replay'));
      });
      const fail = (e: unknown) => {
        this.worker = null;
        this.broken = true; // no endless respawning: later replays are measured inline
        for (const job of this.waiting.values()) job.reject(e);
        this.waiting.clear();
      };
      w.on('error', fail);
      w.on('exit', (code) => { if (this.worker === w && code !== 0) fail(new Error(`worker exited ${code}`)); else if (this.worker === w) this.worker = null; });
      this.worker = w;
      return w;
    } catch {
      this.broken = true;
      return null;
    }
  }

  close(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    return w ? w.terminate().then(() => undefined) : Promise.resolve();
  }
}

const KEY = (c: ClassId) => `botlearn:${c}`;
const STYLE_KEY = (c: ClassId) => `humanstyle:${c}`;
const LESSON_KEY = (c: ClassId) => `botlesson:${c}`;
const LEDGER_KEY = 'botledger';
/** How far full evidence of being outplayed moves a bot, and the weight at which it counts in full (faster than style). */
const LESSON_PULL = 0.8;
const LESSON_FULL = 150;

/**
 * Live learning for bots: each class keeps a small population of brains (see shared/src/botbrain.ts). Every bot a room
 * spawns draws one by Thompson sampling, and when a match against a human ends the result is credited back, so the
 * variants that beat real players are drawn more often and the weakest is replaced by a mutation of the best.
 * Persists through the same store as accounts; without Upstash it lives in memory until the next restart.
 */
export class BotLearner {
  private pops = new Map<ClassId, Population>();
  private styles = new Map<ClassId, HumanStyle>();
  private lessons = new Map<ClassId, Lessons>();
  private ledger: Ledger = {};
  private ready: Promise<void>;
  /** Archive writes run one after another, so two matches ending together never lose each other's index entry. */
  private archiving: Promise<void> = Promise.resolve();
  private saving = new Map<ClassId, Promise<void>>();

  constructor(private store: Store, private rng: () => number = Math.random, private measure: Measure = measureInline) {
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
      this.pops.set(c, freshenPopulation(pop)); // brains saved by an older version get the newer traits from the trained baseline
      try {
        const raw = await this.store.get(STYLE_KEY(c));
        if (raw) this.styles.set(c, JSON.parse(raw) as HumanStyle);
      } catch {
        /* no stored style yet */
      }
      try {
        const raw = await this.store.get(LESSON_KEY(c));
        if (raw) this.lessons.set(c, JSON.parse(raw) as Lessons);
      } catch {
        /* nothing learned yet */
      }
    }
    try {
      const raw = await this.store.get(LEDGER_KEY);
      const v = raw ? (JSON.parse(raw) as unknown) : null;
      if (v && typeof v === 'object' && !Array.isArray(v)) this.ledger = v as Ledger;
    } catch {
      /* start counting again */
    }
  }

  private persist(classId: ClassId, job: () => Promise<unknown>): void {
    const prev = this.saving.get(classId) ?? Promise.resolve();
    this.saving.set(classId, prev.then(job).then(() => undefined).catch(() => undefined));
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

  /**
   * Credit a finished game against humans to the variant that played it, and count it in the ledger of real results
   * (`people`: the classes of the people it fought). A new variant is bred towards what the bots have been learning
   * from their losses, not only at random, so the population improves faster.
   */
  report(classId: ClassId, variantId: string, won: boolean, score?: number, people: ClassId[] = [], difficulty = 'normal'): void {
    const pop = this.pops.get(classId);
    if (!pop) return;
    recordResult(pop, variantId, won, this.rng, score, this.lessons.get(classId));
    this.persist(classId, () => this.store.set(KEY(classId), JSON.stringify(pop)));
    for (const p of new Set(people)) {
      const e = (this.ledger[ledgerKey(classId, p, difficulty)] ??= { w: 0, g: 0 });
      e.g++;
      if (won) e.w++;
    }
    if (people.length) void this.store.set(LEDGER_KEY, JSON.stringify(this.ledger)).catch(() => undefined);
  }

  /** Real results of bots against people so far. */
  results(): Ledger {
    return structuredClone(this.ledger);
  }

  /**
   * Learn from a finished match: play its replay back, measure what each human did and fold it into that class's human
   * style, then keep a "human" variant (the best bot brain pulled towards that style) in the population. It competes with
   * the others like any variant, so people's habits only stick if they win against people.
   */
  async learnFrom(replay: ReplayData, matchId?: string): Promise<void> {
    if (matchId) this.archive(matchId, replay);
    let measured: Measured;
    try {
      measured = await this.measure(replay);
    } catch {
      return; // an unreadable recording teaches nothing
    }
    this.apply(measured);
  }

  /**
   * The owner chose this replay to train on (from the match list, or an uploaded file): learn from it now, and keep it
   * for offline study. A bots-only match teaches its losers through its winners. Resolves to how many bots learned
   * something, or a reason it could not be used.
   */
  async trainOn(replay: ReplayData, id: string): Promise<{ ok: true; lessons: number } | { ok: false; reason: string }> {
    if (replay.hash !== contentHash()) return { ok: false, reason: 'That replay was recorded on an older version of the game, so it cannot be played back the same.' };
    const opts = forcedStudy(replay);
    if (!opts) return { ok: false, reason: 'Nothing to learn: no people played in it and nobody won.' };
    let measured: Measured;
    try {
      measured = await this.measure(replay, opts);
    } catch {
      return { ok: false, reason: 'That replay could not be played back.' };
    }
    this.apply(measured);
    this.archive(id, replay, true);
    return { ok: true, lessons: measured.study.bots.filter((b) => Object.keys(b.lessons).length).length };
  }

  /**
   * Keep a replay of people against bots for offline study (scripts/study-replays.ts), solo practice included: those
   * are exactly the games that show how people beat bots. The newest LEARN_REPLAYS_MAX are kept, each for 30 days.
   */
  private archive(id: string, replay: ReplayData, forced = false): void {
    const kind = (u: ReplayData['units'][number]) => (u.controller === 'bot' ? 'bot' : u.controller === 'player' || u.controller === undefined ? 'human' : 'other');
    const bots = replay.units.filter((u) => kind(u) === 'bot');
    const humans = replay.units.filter((u) => kind(u) === 'human');
    if (!bots.length || (!humans.length && !forced) || !/^[0-9a-z]{6,24}$/i.test(id)) return;
    const humanTeam = humans[0]?.team;
    const entry: LearnIndexEntry = { id, at: Date.now(), bots: bots.map((u) => u.classId), humans: humans.map((u) => u.classId), humansWon: replay.winner === null || replay.winner === 'draw' || humanTeam === undefined ? null : replay.winner === humanTeam, ...(forced ? { forced: true } : {}) };
    this.archiving = this.archiving.then(async () => {
      const gz = await gzip(JSON.stringify(replay));
      await this.store.set(learnReplayKey(id), gz.toString('base64'), LEARN_REPLAY_TTL_S);
      let index: LearnIndexEntry[] = [];
      try {
        const raw = await this.store.get(LEARN_INDEX_KEY);
        const v = raw ? (JSON.parse(raw) as unknown) : [];
        if (Array.isArray(v)) index = v as LearnIndexEntry[];
      } catch {
        /* a broken index starts over */
      }
      index = [entry, ...index.filter((e) => e.id !== id)].slice(0, LEARN_REPLAYS_MAX);
      await this.store.set(LEARN_INDEX_KEY, JSON.stringify(index));
    }).catch(() => undefined);
  }

  /** The study index: newest first. */
  async archived(): Promise<LearnIndexEntry[]> {
    await this.archiving;
    try {
      const raw = await this.store.get(LEARN_INDEX_KEY);
      const v = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(v) ? (v as LearnIndexEntry[]) : [];
    } catch {
      return [];
    }
  }

  /** One kept replay, gzipped JSON (null when it is gone or the id is malformed). */
  async archivedReplay(id: string): Promise<Buffer | null> {
    if (!/^[0-9a-z]{6,24}$/i.test(id)) return null;
    const raw = await this.store.get(learnReplayKey(id));
    return raw ? Buffer.from(raw, 'base64') : null;
  }

  /** Waits for pending writes (tests). */
  async flush(): Promise<void> {
    await this.archiving;
    await Promise.all(this.saving.values());
  }

  private apply(measured: Measured): void {
    this.applyLessons(measured.study);
    for (const { classId, sample } of measured.humans) {
      const pop = this.pops.get(classId);
      if (!pop || !Object.keys(sample).length) continue;
      const style = mergeStyle(this.styles.get(classId) ?? {}, sample);
      this.styles.set(classId, style);
      const rate = (v: { wins: number; games: number }) => (v.wins + 1) / (v.games + 2);
      const base = [...pop.variants].filter((v) => v.id !== 'human' && v.id !== 'lesson').sort((a, b) => rate(b) - rate(a))[0] ?? pop.variants[0];
      const brain = styledBrain(base.brain, style);
      const mine = pop.variants.find((v) => v.id === 'human');
      if (mine) mine.brain = brain;
      else pop.variants.push({ id: 'human', brain, wins: 0, games: 0 });
      this.persist(classId, () => Promise.all([this.store.set(KEY(classId), JSON.stringify(pop)), this.store.set(STYLE_KEY(classId), JSON.stringify(style))]));
    }
  }

  /**
   * How people beat the bots (see shared/src/outplay.ts): each class's lessons are a running average, and a "lesson"
   * variant (the best brain moved towards them) is rebuilt after every replay. It competes like any other variant.
   */
  private applyLessons(study: Measured['study']): void {
    // the people's own kick and fake habits are part of how people play
    for (const { classId, sample } of study.players) {
      if (!Object.keys(sample).length || !this.pops.has(classId)) continue;
      this.styles.set(classId, mergeStyle(this.styles.get(classId) ?? {}, sample));
    }
    for (const { classId, lessons } of study.bots) {
      const pop = this.pops.get(classId);
      if (!pop || !Object.keys(lessons).length) continue;
      const merged = mergeStyle(this.lessons.get(classId) ?? {}, lessons);
      this.lessons.set(classId, merged);
      const rate = (v: { wins: number; games: number }) => (v.wins + 1) / (v.games + 2);
      const base = [...pop.variants].filter((v) => v.id !== 'human' && v.id !== 'lesson').sort((a, b) => rate(b) - rate(a))[0] ?? pop.variants[0];
      const brain = lessonBrain(base.brain, merged, LESSON_PULL, LESSON_FULL);
      const mine = pop.variants.find((v) => v.id === 'lesson');
      if (mine) mine.brain = brain;
      else pop.variants.push({ id: 'lesson', brain, wins: 0, games: 0 });
      this.persist(classId, () => Promise.all([this.store.set(KEY(classId), JSON.stringify(pop)), this.store.set(LESSON_KEY(classId), JSON.stringify(merged))]));
    }
  }

  /** What the bots have learned from losing to people, per class. */
  outplayLessons(): Record<string, Lessons> {
    return Object.fromEntries(this.lessons);
  }

  /** What has been learned from people so far, per class. */
  humanStyles(): Record<string, HumanStyle> {
    return Object.fromEntries(this.styles);
  }

  /** For the status endpoint and the owner: how each class's variants are doing. */
  summary(): Record<string, { generation: number; variants: { id: string; games: number; winRate: number }[]; vsPeople: Record<string, { games: number; botWinRate: number }> }> {
    const out: ReturnType<BotLearner['summary']> = {};
    for (const [c, p] of this.pops) {
      const vsPeople: Record<string, { games: number; botWinRate: number }> = {};
      for (const [k, e] of Object.entries(this.ledger)) if (k.startsWith(`${c}>`)) vsPeople[k.slice(c.length + 1)] = { games: e.g, botWinRate: e.g ? Math.round((e.w / e.g) * 1000) / 1000 : 0 };
      out[c] = { generation: p.generation, variants: p.variants.map((v) => ({ id: v.id, games: v.games, winRate: v.games ? v.wins / v.games : 0 })), vsPeople };
    }
    return out;
  }
}
