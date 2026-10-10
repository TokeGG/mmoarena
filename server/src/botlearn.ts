import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip as gunzipCb, gzip as gzipCb } from 'node:zlib';
import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';
import { BRAIN_BOUNDS, CLASS_IDS, NOTE_WEIGHT, describeVariant, parseNote, plainClassMoves, variantLabel, playersEntry, roundBrain, MISTAKE_LABELS, brainDiff, mistakeLines, brainFor, buildReport, contentHash, forcedStudy, freshenPopulation, lessonBrain, limitChange, mergeLessons, mergeStyle, newPopulation, pickVariant, readReplay, recordResult, sanityClamp, styledBrain, sumLines } from '@arena/shared';
import type { BotBug, BotTest, Brain, ClassId, ClassKnowledge, NoteEffect, NoteInfo, ClassReport, CountLine, HumanStyle, LearnReport, LearnSource, Lessons, LiveLearning, Population, PlayersFile, ReplayData, StudyOptions } from '@arena/shared';
import type { Store } from './store';

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

/** How many reports of what the bots learned are kept for the owner, newest first. */
export const REPORTS_MAX = 50;
const REPORTS_KEY = 'botreports';
const STAT_KEY = (c: ClassId) => `botstat:${c}`;
/** Per class: replays that taught it, when last, and the mistakes seen so far by label. */
interface LearnStat { replays: number; lastAt: number | null; mistakes: Record<string, number>; /** Small graded adjustments added up per number. */ nudge?: Partial<Record<keyof Brain, number>>; /** How far (share of its range) each number may drift from the shipped brain; widened when a number reaches its limit. */ room?: Partial<Record<keyof Brain, number>> }
/** One replay never moves a number by more than this share of its range (times the passes, up to 3). */
const STEP_LIMIT = 0.2;
/** However much is learned, a number stays within this share of its range of the shipped brain. */
const DRIFT_LIMIT = 0.6;
/** One graded nudge moves a number this share of its range at full strength (a loss; a win counts half). */
const NUDGE_STEP = 0.04;
/** A number at its drift limit gets this much more room, up to ROOM_MAX. */
const ROOM_WIDEN = 0.1;
const ROOM_MAX = 0.95;

const NOTES_KEY = 'botnotes';
const BUGS_KEY = 'botbugs';
/** Notes and bug reports kept (newest first). */
export const NOTES_MAX = 100;
export const BUGS_MAX = 100;

const LIVE_KEY = 'botlive';
/** What the live learner has studied (kept in the store): matches with people and bot-only matches, per class, and the commit counter. */
interface LiveStat { people: number; botOnly: number; lastAt: number | null; sinceCommit: number; lastCommit: LiveLearning['lastCommit']; byClass: Record<string, { people: number; botOnly: number }> }
const emptyLive = (): LiveStat => ({ people: 0, botOnly: 0, lastAt: null, sinceCommit: 0, lastCommit: null, byClass: {} });
/** A variant that has played this many games against people has earned a hearing when it is compared with the lesson brain. */
const PROVEN_GAMES = 30;
/** What the admin log is told about each match the bots studied on their own (counted matches, and every match with "train on every match"). */
export interface StudiedEvent { replayId: string; kind: 'people' | 'bots'; text: string }

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
 * A small pool of worker threads that measure replays off the game loop, so several replays can be trained on at the
 * same time. Each job goes to the worker with the fewest jobs waiting. If a worker cannot start (or dies), the
 * measurement falls back to the main thread rather than being lost.
 */
export class MeasureWorker {
  private workers: { w: Worker; pending: number }[] = [];
  private nextId = 1;
  private waiting = new Map<number, { resolve: (m: Measured) => void; reject: (e: unknown) => void; slot: { pending: number } }>();
  private broken = false;

  constructor(private size = Math.min(4, Math.max(1, cpus().length - 1))) {}

  readonly measure: Measure = (replay, opts) => {
    const slot = this.pick();
    if (!slot) return measureInline(replay, opts);
    const id = this.nextId++;
    return new Promise<Measured>((resolve, reject) => {
      // a worker that never answers must not leak the job forever
      const timer = setTimeout(() => { const j = this.waiting.get(id); if (j) { this.waiting.delete(id); j.slot.pending--; reject(new Error('measuring timed out')); } }, 180000);
      timer.unref();
      this.waiting.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); }, slot });
      slot.pending++;
      slot.w.postMessage({ id, replay, opts });
    });
  };

  /** The worker with the least waiting, starting another one while the pool has room. */
  private pick(): { w: Worker; pending: number } | null {
    if (this.broken) return null;
    const idle = this.workers.find((x) => x.pending === 0);
    if (idle) return idle;
    if (this.workers.length < this.size) {
      const made = this.spawn();
      if (made) return made;
      if (!this.workers.length) return null;
    }
    return this.workers.reduce((a, b) => (b.pending < a.pending ? b : a));
  }

  private spawn(): { w: Worker; pending: number } | null {
    try {
      const w = new Worker(new URL('./learnWorkerBoot.mjs', import.meta.url));
      w.unref(); // never keeps the process alive
      const slot = { w, pending: 0 };
      w.on('message', (m: { id: number; ok: boolean; measured?: Measured }) => {
        const job = this.waiting.get(m.id);
        if (!job) return;
        this.waiting.delete(m.id);
        job.slot.pending--;
        if (m.ok && m.measured) job.resolve(m.measured);
        else job.reject(new Error('unreadable replay'));
      });
      const fail = (e: unknown) => {
        if (!this.workers.includes(slot)) return; // already closed on purpose
        this.workers = this.workers.filter((x) => x !== slot);
        if (!this.workers.length) this.broken = true; // no endless respawning: later replays are measured inline
        for (const [id, job] of this.waiting) if (job.slot === slot) { this.waiting.delete(id); job.reject(e); }
      };
      w.on('error', fail);
      w.on('exit', (code) => { if (code !== 0) fail(new Error(`worker exited ${code}`)); else this.workers = this.workers.filter((x) => x !== slot); });
      this.workers.push(slot);
      return slot;
    } catch {
      this.broken = this.workers.length === 0;
      return null;
    }
  }

  close(): Promise<void> {
    const ws = this.workers;
    this.workers = [];
    return Promise.all(ws.map((x) => x.w.terminate())).then(() => undefined);
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
  private stats = new Map<ClassId, LearnStat>();
  private reports: LearnReport[] = [];
  private notes: NoteInfo[] = [];
  private bugs: BotBug[] = [];
  private live: LiveStat = emptyLive();
  /** Told about every match the bots studied by themselves, with what came of it, even when no number moved (the admin log). */
  onStudied?: (e: StudiedEvent) => void;
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
      try {
        const raw = await this.store.get(STAT_KEY(c));
        if (raw) this.stats.set(c, JSON.parse(raw) as LearnStat);
      } catch {
        /* no counters yet */
      }
    }
    try {
      const raw = await this.store.get(REPORTS_KEY);
      const v = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(v)) this.reports = v as LearnReport[];
    } catch {
      /* no log yet */
    }
    for (const [key, set] of [[NOTES_KEY, (v: unknown[]) => (this.notes = v as NoteInfo[])], [BUGS_KEY, (v: unknown[]) => (this.bugs = v as BotBug[])]] as const) {
      try {
        const raw = await this.store.get(key);
        const v = raw ? (JSON.parse(raw) as unknown) : null;
        if (Array.isArray(v)) set(v);
      } catch {
        /* none yet */
      }
    }
    try {
      const raw = await this.store.get(LIVE_KEY);
      const v = raw ? (JSON.parse(raw) as LiveStat) : null;
      if (v && typeof v === 'object' && typeof v.people === 'number') this.live = { ...emptyLive(), ...v };
    } catch {
      /* start counting again */
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
  async learnFrom(replay: ReplayData, matchId?: string): Promise<LearnReport | null> {
    await this.ready;
    if (matchId) this.archive(matchId, replay);
    const kind = hasPeople(replay) ? 'people' : 'bots';
    let measured: Measured;
    try {
      measured = await this.measure(replay);
    } catch {
      this.onStudied?.({ replayId: matchId ?? 'live', kind, text: 'could not be studied: the recording was unreadable' });
      return null; // an unreadable recording teaches nothing
    }
    return this.learn(measured, { replayId: matchId ?? 'live', source: 'auto', passes: 1, log: true, kind });
  }

  /**
   * The owner chose this replay to train on (from the match list, or an uploaded file): learn from it now, and keep it
   * for offline study. A bots-only match teaches its losers through its winners. `passes` (1..5) repeats the lesson, so
   * the evidence counts several times. Resolves to the report of what was learned, or a reason it could not be used.
   */
  async trainOn(replay: ReplayData, id: string, o: { passes?: number; source?: LearnSource; log?: boolean } = {}): Promise<{ ok: true; lessons: number; habits: number; report: LearnReport } | { ok: false; reason: string }> {
    await this.ready;
    const kind = hasPeople(replay) ? 'people' : 'bots';
    const skip = (reason: string) => {
      if (o.source === 'auto') this.onStudied?.({ replayId: id, kind, text: `skipped: ${reason}` });
      return { ok: false as const, reason };
    };
    if (replay.hash !== contentHash(replay.tickMs)) return skip('That replay was recorded on an older version of the game, so it cannot be played back the same.');
    const opts = forcedStudy(replay);
    if (!opts) return skip('Nothing to learn: no people played in it and nobody won.');
    let measured: Measured;
    try {
      measured = await this.measure(replay, opts);
    } catch {
      return skip('That replay could not be played back.');
    }
    const passes = Math.max(1, Math.min(5, Math.round(o.passes ?? 1)));
    const report = this.learn(measured, { replayId: id, source: o.source ?? 'owner', passes, log: o.log ?? true, kind });
    this.archive(id, replay, true);
    const lessons = measured.study.bots.filter((b) => Object.keys(b.lessons).length).length;
    const habits = measured.humans.filter((h) => Object.keys(h.sample).length).length + measured.study.players.filter((p) => Object.keys(p.sample).length).length;
    return { ok: true, lessons, habits, report };
  }

  /** Apply what a measured replay teaches and write down what came of it. */
  private learn(measured: Measured, o: { replayId: string; source: LearnSource; passes: number; log: boolean; kind?: 'people' | 'bots'; replaysRead?: number; skipped?: number }): LearnReport {
    const classes = this.apply(measured, o.passes);
    const habits = measured.humans.filter((h) => Object.keys(h.sample).length).length + measured.study.players.filter((p) => Object.keys(p.sample).length).length;
    const report = buildReport({ id: `${Date.now().toString(36)}${Math.floor(this.rng() * 1e4).toString(36)}`, replayId: o.replayId, at: Date.now(), source: o.source, passes: o.passes, study: measured.study, classes, habits, replaysRead: o.replaysRead, skipped: o.skipped });
    if (o.log) this.remember(report);
    if (o.source === 'auto' && o.kind) {
      // a match the bots studied on their own (live play): counted, and written down even when no number moved
      this.countLive(o.kind, [...new Set([...measured.study.bots.map((b) => b.classId), ...measured.humans.map((h) => h.classId), ...measured.study.players.map((p) => p.classId)])]);
      this.onStudied?.({ replayId: o.replayId, kind: o.kind, text: report.headline });
    }
    return report;
  }

  private countLive(kind: 'people' | 'bots', classes: ClassId[]): void {
    const l = this.live;
    if (kind === 'people') {
      l.people++;
      l.sinceCommit++;
    } else l.botOnly++;
    l.lastAt = Date.now();
    for (const c of classes) {
      const e = (l.byClass[c] ??= { people: 0, botOnly: 0 });
      if (kind === 'people') e.people++;
      else e.botOnly++;
    }
    this.saveLive();
  }

  private saveLive(): void {
    const json = JSON.stringify(this.live);
    this.archiving = this.archiving.then(() => this.store.set(LIVE_KEY, json)).catch(() => undefined);
  }

  private remember(report: LearnReport): void {
    this.reports = [report, ...this.reports].slice(0, REPORTS_MAX);
    const json = JSON.stringify(this.reports);
    this.archiving = this.archiving.then(() => this.store.set(REPORTS_KEY, json)).catch(() => undefined);
  }

  /** The last reports of what the bots learned, newest first. */
  learnReports(): LearnReport[] {
    return structuredClone(this.reports);
  }

  /**
   * Train on every archived replay one after another. Replays recorded on another version of the game cannot be played
   * back the same and are skipped (and counted). `progress` is told after each one. Resolves to one report for the lot.
   */
  async trainArchive(progress: (p: { done: number; total: number; skipped: number }) => void, o: { passes?: number } = {}): Promise<LearnReport> {
    await this.ready;
    const index = await this.archived();
    const before = this.classBrains();
    let skipped = 0;
    let done = 0;
    const reports: LearnReport[] = [];
    for (const e of index) {
      let replay: ReplayData | null = null;
      try {
        const gz = await this.archivedReplay(e.id);
        replay = gz ? (JSON.parse((await gunzip(gz)).toString('utf8')) as ReplayData) : null;
      } catch {
        replay = null;
      }
      if (!replay || !Array.isArray(replay.units) || replay.hash !== contentHash(replay.tickMs)) skipped++;
      else {
        const r = await this.trainOn(replay, e.id, { passes: o.passes, source: 'archive', log: false }).catch(() => null);
        if (r?.ok) reports.push(r.report);
        else skipped++;
      }
      done++;
      progress({ done, total: index.length, skipped });
    }
    const after = this.classBrains();
    const classes: ClassReport[] = CLASS_IDS.map((c) => ({ classId: c, moved: brainDiff(before.get(c)!, after.get(c)!), replays: this.stats.get(c)?.replays ?? 0 }));
    const merged = buildReport({ id: `${Date.now().toString(36)}all`, replayId: 'all archived replays', at: Date.now(), source: 'archive', passes: Math.max(1, Math.min(5, Math.round(o.passes ?? 1))), study: { bots: [], players: [] }, classes, habits: reports.reduce((n, r) => n + r.habits, 0), replaysRead: done - skipped, skipped });
    // the batch's own mistake counts and bot lines come from the reports it read
    merged.bots = reports.flatMap((r) => r.bots);
    merged.totals = sumLines(reports.map((r) => r.totals));
    if (!classes.some((c) => c.moved.length)) {
      merged.nothing = done === 0 ? 'there are no archived replays yet' : done === skipped ? `all ${skipped} replays were skipped (another version of the game, or unreadable)` : 'every lesson in them points the way the bots already play, or the evidence is still too thin to move a number';
      merged.headline = `Nothing to learn from ${done - skipped} replay${done - skipped === 1 ? '' : 's'}: ${merged.nothing}.`;
    } else {
      merged.headline = `${done - skipped} replay${done - skipped === 1 ? '' : 's'} read${skipped ? `, ${skipped} skipped` : ''}: ${classes.filter((c) => c.moved.length).map((c) => `${c.classId}: ${c.moved.map((m) => `${m.key} ${m.before.toFixed(2)} -> ${m.after.toFixed(2)}`).join(', ')}`).join('; ')}`;
    }
    this.remember(merged);
    return merged;
  }

  /** The brain each class is playing its "lesson" with now (the best brain when nothing was learned yet). */
  private classBrains(): Map<ClassId, Brain> {
    const out = new Map<ClassId, Brain>();
    for (const c of CLASS_IDS) out.set(c, this.learnedBrain(c));
    return out;
  }

  private learnedBrain(c: ClassId): Brain {
    const pop = this.pops.get(c);
    const rate = (v: { wins: number; games: number }) => (v.wins + 1) / (v.games + 2);
    const lesson = pop?.variants.find((v) => v.id === 'lesson');
    if (lesson) return lesson.brain;
    const base = pop ? [...pop.variants].filter((v) => v.id !== 'human').sort((a, b) => rate(b) - rate(a))[0] : undefined;
    return base?.brain ?? brainFor(c);
  }

  /** What the bots know: per class the learned numbers against the shipped ones, how many replays taught them, and when last. */
  knowledge(): ClassKnowledge[] {
    return CLASS_IDS.map((c) => {
      const st = this.stats.get(c);
      const shipped = brainFor(c);
      const learned = this.learnedBrain(c);
      const lv = this.pops.get(c)?.variants.find((v) => v.id === 'lesson');
      return {
        classId: c, replays: st?.replays ?? 0, lastAt: st?.lastAt ?? null, shipped, learned, diff: brainDiff(shipped, learned),
        mistakes: Object.entries(st?.mistakes ?? {}).map(([label, count]): CountLine => ({ label, count })).sort((a, b) => b.count - a.count),
        variant: lv && lv.games ? { games: lv.games, winRate: lv.wins / lv.games } : null,
        variants: (this.pops.get(c)?.variants ?? []).map((v) => {
          const t = describeVariant(c, v.id, v.brain, v, shipped);
          return { id: v.id, label: variantLabel(v.id), games: v.games, wins: Math.round(v.wins * 10) / 10, tries: (t?.tries ?? []).map((x) => ({ text: x.text })), more: t?.more ?? 0 };
        }),
      };
    });
  }

  /**
   * What a bot playing this variant is testing, in words (the owner/dev "testing" marker), from the variant's own record.
   * `brain` is the brain the bot was handed (a variant's brain can be rebuilt after a lesson or a note; the marker says what the bot plays).
   * Null when it plays the shipped brain.
   */
  variantTest(classId: ClassId, variantId: string, brain?: Brain): Omit<BotTest, 'unit'> | null {
    const v = this.pops.get(classId)?.variants.find((x) => x.id === variantId);
    const b = brain ?? v?.brain;
    if (!b) return null;
    return describeVariant(classId, variantId, b, { games: v?.games ?? 0, wins: v?.wins ?? 0 });
  }

  /** Notes written for the bots, newest first. */
  noteList(): NoteInfo[] {
    return structuredClone(this.notes);
  }

  /** Bot bugs reported in notes, newest first (fixed ones included). */
  bugList(): BotBug[] {
    return structuredClone(this.bugs);
  }

  /** The owner marks a reported bot bug fixed (or open again). */
  markBug(id: string, fixed: boolean, by: string): boolean {
    const b = this.bugs.find((x) => x.id === id);
    if (!b) return false;
    b.fixed = fixed;
    if (fixed) {
      b.fixedAt = Date.now();
      b.fixedBy = by;
    } else {
      delete b.fixedAt;
      delete b.fixedBy;
    }
    this.saveList(BUGS_KEY, this.bugs);
    return true;
  }

  private saveList(key: string, list: unknown[]): void {
    const json = JSON.stringify(list);
    this.archiving = this.archiving.then(() => this.store.set(key, json)).catch(() => undefined);
  }

  /**
   * A note for the bots from the owner or a dev (see shared/src/botnote.ts). What it asks for is nudged into the 'lesson'
   * variant of the classes it names (every bot class of the match when it names none), by NOTE_WEIGHT times a graded nudge,
   * through the same room, step and bound limits, so the bots actually try it against people. What reports a bug goes to the bug
   * list; what cannot be placed is handed back. Always writes a report (source 'note') so "What was learned" shows its effect.
   */
  async addNote(o: { matchId: string; text: string; by: string; role: 'owner' | 'dev'; matchClasses: ClassId[]; liveSec?: number; /** Reads a note the phrase list could not place (Ask Claude): the moves, the bugs and what it still could not place. */ interpret?: (text: string) => Promise<{ effects: NoteEffect[]; bugs: string[]; unplaced: string[]; requests?: { title: string; detail: string }[]; understood?: string } | null>; /** Files something no brain number can do as a change request (Claude builds it); resolves with the title it was filed under, or null. */ fileRequest?: (title: string, detail: string) => Promise<string | null> }): Promise<{ note: NoteInfo; report: LearnReport; understood?: string; filed: string[] }> {
    await this.ready;
    let parsed = parseNote(o.text);
    let understood: string | undefined;
    const filed: string[] = [];
    if (o.interpret) {
      const read = await o.interpret(o.text).catch(() => null);
      if (read) {
        const fresh = read.effects.filter((e) => !parsed.effects.some((x) => x.key === e.key && x.dir === e.dir));
        parsed = { effects: [...parsed.effects, ...fresh], conflicts: parsed.conflicts, bugs: [...parsed.bugs, ...read.bugs], unmapped: read.unplaced };
        understood = read.understood;
        // what no brain number can do becomes a change request: Claude writes it and it comes back as a pull request
        for (const r of read.requests ?? []) {
          const title = await o.fileRequest?.(r.title, r.detail).catch(() => null);
          if (title) filed.push(title);
        }
      }
    }
    const wanted = new Map<ClassId, Map<keyof Brain, { dir: 1 | -1; said: string; strength: number }>>();
    const conflicts = [...parsed.conflicts];
    for (const e of parsed.effects) {
      for (const c of e.classes ?? o.matchClasses) {
        if (!this.pops.has(c)) continue;
        const m = wanted.get(c) ?? new Map();
        wanted.set(c, m);
        const have = m.get(e.key);
        if (have && have.dir !== e.dir) {
          m.delete(e.key);
          conflicts.push(`"${have.said}" and "${e.said}" ask for opposite things about ${c} bots`);
        } else if (!have) m.set(e.key, { dir: e.dir, said: e.said, strength: e.strength ?? 2 });
      }
    }
    const asked: NoteInfo['asked'] = [];
    const classes: ClassReport[] = [];
    for (const [classId, want] of wanted) {
      const pop = this.pops.get(classId)!;
      const stat = this.stats.get(classId) ?? { replays: 0, lastAt: null, mistakes: {} };
      const nudge = (stat.nudge ??= {});
      const room = (stat.room ??= {});
      const shipped = brainFor(classId);
      const rate = (v: { wins: number; games: number }) => (v.wins + 1) / (v.games + 2);
      const base = [...pop.variants].filter((v) => v.id !== 'human' && v.id !== 'lesson').sort((a, b) => rate(b) - rate(a))[0] ?? pop.variants[0];
      const mine = pop.variants.find((v) => v.id === 'lesson');
      const before = mine?.brain ?? base.brain;
      const brain = { ...before };
      const why = new Map<keyof Brain, string>();
      const notes: string[] = [];
      for (const [k, { dir, said, strength }] of want) {
        const [bl, bh] = BRAIN_BOUNDS[k];
        const span = bh - bl;
        const str = strength / 2; // "slightly" is half a step, "a lot" one and a half
        const step = Math.min(NUDGE_STEP * span * NOTE_WEIGHT * str, STEP_LIMIT * span * Math.max(1, str)) * dir;
        for (let attempt = 0; attempt < 2; attempt++) {
          const r = room[k] ?? DRIFT_LIMIT;
          const allowLo = Math.max(bl, shipped[k] - r * span);
          const allowHi = Math.min(bh, shipped[k] + r * span);
          const next = Math.min(allowHi, Math.max(allowLo, brain[k] + step));
          if (Math.abs(next - brain[k]) > 1e-9) {
            nudge[k] = (nudge[k] ?? 0) + (next - brain[k]);
            brain[k] = next;
            why.set(k, `your note said "${said}"`);
            break;
          }
          if (r < ROOM_MAX && ((dir > 0 && allowHi < bh) || (dir < 0 && allowLo > bl))) {
            room[k] = Math.min(ROOM_MAX, r + ROOM_WIDEN);
            notes.push(`${k} reached its limit (${Math.round(r * 100)}% of its range from what shipped), so the room was widened to ${Math.round(room[k]! * 100)}%.`);
          } else {
            notes.push(`${k} is at its bound, so "${said}" could not move it further.`);
            break;
          }
        }
        asked.push({ classId, key: k, dir, said, moved: Math.abs(brain[k] - before[k]) > 1e-9 });
      }
      const moved = brainDiff(before, brain, 0.0005).map((mv) => ({ ...mv, why: why.get(mv.key) ?? 'your note' }));
      if (moved.length) {
        if (mine) mine.brain = brain;
        else pop.variants.push({ id: 'lesson', brain, wins: 0, games: 0 });
      }
      stat.lastAt = Date.now();
      this.stats.set(classId, stat);
      classes.push({ classId, moved, notes, replays: stat.replays });
      this.persist(classId, () => Promise.all([this.store.set(KEY(classId), JSON.stringify(pop)), this.store.set(STAT_KEY(classId), JSON.stringify(stat))]));
    }
    const at = Date.now();
    const note: NoteInfo = {
      id: randomBytes(6).toString('hex'), matchId: o.matchId, at, by: o.by, role: o.role, text: o.text, ...(o.liveSec !== undefined ? { liveSec: o.liveSec } : {}),
      classes: [...wanted.keys()], asked, unmapped: parsed.unmapped, bugs: parsed.bugs, conflicts, weight: NOTE_WEIGHT,
    };
    const report = buildReport({ id: `${at.toString(36)}${Math.floor(this.rng() * 1e4).toString(36)}`, replayId: o.matchId, at, source: 'note', passes: 1, study: { bots: [], players: [] }, classes, habits: 0 });
    const moved = classes.filter((c) => c.moved.length);
    if (moved.length) {
      report.nothing = null;
      report.headline = `Your note moved: ${moved.map((c) => plainClassMoves(c.classId, c.moved)).join('. ')}.`;
    } else {
      report.nothing = !parsed.effects.length && !parsed.bugs.length ? 'nothing in it matched a phrase the bots understand' : !parsed.effects.length ? 'it only reported a bug, and no brain number can fix that' : 'the numbers it asked for are already at their limit, or it asked for opposite things';
      report.headline = `Your note did not move any bot numbers: ${report.nothing}.`;
    }
    report.note = note;
    this.remember(report);
    this.notes = [note, ...this.notes].slice(0, NOTES_MAX);
    this.saveList(NOTES_KEY, this.notes);
    for (const frag of parsed.bugs) this.bugs = [{ id: randomBytes(6).toString('hex'), matchId: o.matchId, at, by: o.by, text: frag, fixed: false }, ...this.bugs].slice(0, BUGS_MAX);
    if (parsed.bugs.length) this.saveList(BUGS_KEY, this.bugs);
    return { note, report, ...(understood ? { understood } : {}), filed };
  }

  /** Where the bots' learning stands, for the Bot training tab: matches studied, whether the store keeps them, per-class results against people. */
  liveStatus(): LiveLearning {
    const l = this.live;
    return {
      persistent: this.store.kind !== 'memory', storeKind: this.store.kind,
      people: l.people, botOnly: l.botOnly, lastAt: l.lastAt, sinceCommit: l.sinceCommit, lastCommit: l.lastCommit,
      classes: CLASS_IDS.map((c) => {
        let g = 0;
        let w = 0;
        for (const [k, e] of Object.entries(this.ledger)) if (k.startsWith(`${c}>`)) { g += e.g; w += e.w; }
        const lv = this.pops.get(c)?.variants.find((v) => v.id === 'lesson');
        const by = l.byClass[c];
        return { classId: c, people: by?.people ?? 0, botOnly: by?.botOnly ?? 0, vsGames: g, vsWinRate: g ? w / g : null, variant: lv && lv.games ? { games: lv.games, winRate: lv.wins / lv.games } : null };
      }),
    };
  }

  /**
   * The brain to commit for a class: the "lesson" brain (the best brain moved towards what the people taught it), unless
   * another variant has played PROVEN_GAMES against people and clearly beats it. Null when that is what already ships.
   */
  private championFor(c: ClassId): Brain | null {
    const pop = this.pops.get(c);
    if (!pop) return null;
    const rate = (v: { wins: number; games: number }) => (v.wins + 1) / (v.games + 2);
    const lesson = pop.variants.find((v) => v.id === 'lesson');
    const proven = pop.variants.filter((v) => v.id !== 'lesson' && v.id !== 'human' && v.games >= PROVEN_GAMES).sort((a, b) => rate(b) - rate(a))[0];
    let pick = lesson;
    if (proven && (!lesson || (lesson.games >= PROVEN_GAMES && rate(proven) > rate(lesson) + 0.05))) pick = proven;
    if (!pick) return null;
    const same = JSON.stringify(roundBrain(pick.brain)) === JSON.stringify(roundBrain(brainFor(c)));
    return same ? null : pick.brain;
  }

  /**
   * What "Commit learned bots" writes, in the formats scripts/study-replays.ts writes: the brain each class has learned
   * (only the classes that differ from what ships) for botbrain.json, and the human-style data and real results against
   * people for players.json. `matches` is how many matches with people were studied since the last commit.
   */
  async exportLive(): Promise<{ brains: Partial<Record<ClassId, Record<string, number>>>; players: PlayersFile; matches: number }> {
    await this.ready;
    await this.flush();
    const brains: Partial<Record<ClassId, Record<string, number>>> = {};
    const players: PlayersFile = {};
    for (const c of CLASS_IDS) {
      const b = this.championFor(c);
      if (b) brains[c] = roundBrain(b);
      const vs = new Map<string, { games: number; botWins: number }>();
      for (const [k, e] of Object.entries(this.ledger)) {
        if (!k.startsWith(`${c}>`)) continue;
        const person = k.slice(c.length + 1).split(':')[0];
        const cur = vs.get(person) ?? { games: 0, botWins: 0 };
        cur.games += e.g;
        cur.botWins += e.w;
        vs.set(person, cur);
      }
      players[c] = playersEntry(this.styles.get(c), vs);
    }
    return { brains, players, matches: this.live.sinceCommit };
  }

  /** The learned bots went to the repository: start counting matches again from here. */
  markCommitted(c: { version: string; url: string; matches: number }): void {
    this.live.sinceCommit = 0;
    this.live.lastCommit = { at: Date.now(), ...c };
    this.saveLive();
  }

  /** Put every class back to the brain it ships with: the learned variants, lessons, habits and counters are cleared. */
  async resetBrain(): Promise<void> {
    await this.ready;
    for (const c of CLASS_IDS) {
      const pop = newPopulation(c, this.rng);
      this.pops.set(c, pop);
      this.lessons.delete(c);
      this.styles.delete(c);
      this.stats.delete(c);
      this.persist(c, () => Promise.all([this.store.set(KEY(c), JSON.stringify(pop)), this.store.set(LESSON_KEY(c), '{}'), this.store.set(STYLE_KEY(c), '{}'), this.store.set(STAT_KEY(c), JSON.stringify({ replays: 0, lastAt: null, mistakes: {} }))]));
    }
    this.reports = [];
    this.notes = []; // the bug list stays: it is the owner's to-do list, not something the bots learned
    await this.store.set(REPORTS_KEY, '[]').catch(() => undefined);
    await this.store.set(NOTES_KEY, '[]').catch(() => undefined);
    await this.flush();
  }

  /**
   * Keep a replay of people against bots for offline study (scripts/study-replays.ts), solo practice included: those
   * are exactly the games that show how people beat bots. The newest LEARN_REPLAYS_MAX are kept, each for 30 days.
   */
  private archive(id: string, replay: ReplayData, forced = false): void {
    const kind = (u: ReplayData['units'][number]) => (u.controller === 'bot' ? 'bot' : u.controller === 'player' || u.controller === undefined ? 'human' : 'other');
    const bots = replay.units.filter((u) => kind(u) === 'bot');
    const humans = replay.units.filter((u) => kind(u) === 'human');
    if ((!bots.length && !forced) || (!humans.length && !forced) || !/^[0-9a-z]{6,24}$/i.test(id)) return;
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

  private apply(measured: Measured, passes = 1): ClassReport[] {
    const classes = this.applyLessons(measured.study, passes);
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
    return classes;
  }

  /**
   * How people beat the bots (see shared/src/outplay.ts and mistakes.ts): each class's lessons are running evidence
   * (older evidence fades a little with each replay), and a "lesson" variant (the best brain moved towards them) is
   * rebuilt after every replay. It competes like any other variant. One replay moves a number at most STEP_LIMIT of its
   * range (more with several passes), and nothing ends up further than DRIFT_LIMIT from the shipped brain.
   */
  private applyLessons(study: Measured['study'], passes: number): ClassReport[] {
    // the people's own kick and fake habits are part of how people play
    for (const { classId, sample } of study.players) {
      if (!Object.keys(sample).length || !this.pops.has(classId)) continue;
      this.styles.set(classId, mergeStyle(this.styles.get(classId) ?? {}, sample));
    }
    const out: ClassReport[] = [];
    const classes = [...new Set(study.bots.map((b) => b.classId))];
    for (const classId of classes) {
      const pop = this.pops.get(classId);
      if (!pop) continue;
      const bots = study.bots.filter((b) => b.classId === classId);
      // the mistakes seen, whether or not they were enough to teach a number yet
      const stat = this.stats.get(classId) ?? { replays: 0, lastAt: null, mistakes: {} };
      stat.replays++;
      stat.lastAt = Date.now();
      for (const b of bots) {
        for (const [k, v] of Object.entries(b.facts.mistakes)) stat.mistakes[MISTAKE_LABELS[k as keyof typeof MISTAKE_LABELS] ?? k] = (stat.mistakes[MISTAKE_LABELS[k as keyof typeof MISTAKE_LABELS] ?? k] ?? 0) + (v ?? 0);
        for (const [label, n] of [['casts kicked', b.facts.kicked], ['died with a defensive ready', b.facts.diedWithDefensive], ['burst deaths', b.facts.burstDeaths], ['long casts taken in the open', b.facts.bigCastsTaken], ['hits taken in ground effects', b.facts.zoneHits]] as [string, number][]) if (n) stat.mistakes[label] = (stat.mistakes[label] ?? 0) + n;
      }
      this.stats.set(classId, stat);
      let merged = this.lessons.get(classId) ?? {};
      for (const b of bots) for (let i = 0; i < passes; i++) if (Object.keys(b.lessons).length) merged = mergeLessons(merged, b.lessons);
      this.lessons.set(classId, merged);
      const rate = (v: { wins: number; games: number }) => (v.wins + 1) / (v.games + 2);
      const base = [...pop.variants].filter((v) => v.id !== 'human' && v.id !== 'lesson').sort((a, b) => rate(b) - rate(a))[0] ?? pop.variants[0];
      const mine = pop.variants.find((v) => v.id === 'lesson');
      const before = mine?.brain ?? base.brain;
      const shipped = brainFor(classId);
      let brain = lessonBrain(base.brain, merged, LESSON_PULL, LESSON_FULL);
      brain = limitChange(before, brain, STEP_LIMIT * Math.min(3, passes));
      // the graded nudges added up over every match so far ride on top of the lessons
      const nudge = (stat.nudge ??= {});
      const room = (stat.room ??= {});
      for (const k of Object.keys(nudge) as (keyof Brain)[]) brain[k] = Math.min(BRAIN_BOUNDS[k][1], Math.max(BRAIN_BOUNDS[k][0], brain[k] + (nudge[k] ?? 0)));
      brain = sanityClamp(brain, shipped, DRIFT_LIMIT, room);
      const why = new Map<keyof Brain, string[]>();
      const notes: string[] = [];
      const lessonWhy = bots.flatMap((b) => mistakeLines(b.facts).slice(0, 3).map((c) => `${c.count} ${c.label}`)).slice(0, 3).join(', ');
      for (const k of Object.keys(merged) as (keyof Brain)[]) if (Math.abs(brain[k] - before[k]) > 0.0049) why.set(k, [lessonWhy ? `lesson from ${lessonWhy}` : 'lesson from earlier matches']);
      for (const b of bots) {
        const m = b.won ? 0.5 : 1;
        for (const n of b.nudges) {
          let applied = false;
          // first the number with room for most of the step; if every number on the list is nearly at a bound, whichever has any
          for (const need of [0.5, 0]) {
            for (const k of n.keys) {
              const [bl, bh] = BRAIN_BOUNDS[k];
              const span = bh - bl;
              const step = NUDGE_STEP * span * n.strength * m * Math.min(3, passes) * n.sign;
              for (let attempt = 0; attempt < 2 && !applied; attempt++) {
                const r = room[k] ?? DRIFT_LIMIT;
                const allowLo = Math.max(bl, shipped[k] - r * span);
                const allowHi = Math.min(bh, shipped[k] + r * span);
                const next = Math.min(allowHi, Math.max(allowLo, brain[k] + step));
                if (Math.abs(next - brain[k]) > 1e-9 && Math.abs(next - brain[k]) >= need * Math.abs(step)) {
                  nudge[k] = (nudge[k] ?? 0) + (next - brain[k]);
                  brain[k] = next;
                  const list = why.get(k) ?? [];
                  list.push(`${n.metric}: ${n.why}`);
                  why.set(k, list);
                  applied = true;
                } else if (r < ROOM_MAX && ((n.sign > 0 && allowHi < bh) || (n.sign < 0 && allowLo > bl))) {
                  room[k] = Math.min(ROOM_MAX, r + ROOM_WIDEN);
                  notes.push(`${k} reached its limit (${Math.round(r * 100)}% of its range from what shipped), so the room was widened to ${Math.round(room[k]! * 100)}%.`);
                } else {
                  if (need === 0 || Math.abs(next - brain[k]) <= 1e-9) notes.push(`${k} is at its bound ${n.sign > 0 ? bh : bl}, so ${n.metric} moves the next number on its list.`);
                  break;
                }
              }
              if (applied) break;
            }
            if (applied) break;
          }
        }
      }
      if (mine) mine.brain = brain;
      else if (Object.keys(merged).length || Object.keys(nudge).length) pop.variants.push({ id: 'lesson', brain, wins: 0, games: 0 });
      const moved = brainDiff(before, brain, 0.0005).map((mv) => ({ ...mv, why: (why.get(mv.key) ?? ['graded signals']).join('; ') }));
      out.push({ classId, moved, notes, replays: stat.replays });
      this.persist(classId, () => Promise.all([this.store.set(KEY(classId), JSON.stringify(pop)), this.store.set(LESSON_KEY(classId), JSON.stringify(merged)), this.store.set(STAT_KEY(classId), JSON.stringify(stat))]));
    }
    return out;
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

/** Did a person play in this match (a recording without a controller marker is a person's)? */
function hasPeople(replay: ReplayData): boolean {
  return replay.units.some((u) => u.controller === 'player' || u.controller === undefined);
}
