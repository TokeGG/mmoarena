import { BRAIN_WORDS, plainMove, showBrainValue } from './brainwords';
import { BRAIN_KEYS } from './botbrain';
import type { Brain } from './botbrain';
import { FACT_LABELS, MISTAKE_LABELS } from './mistakes';
import type { MistakeKind } from './mistakes';
import type { BotStudy, MatchStudy } from './outplay';
import type { ClassId } from './types';

/**
 * What the bots took from a replay, in words the owner can read: which mistakes were found (by type and count), which
 * brain numbers moved (before -> after), or why nothing did. Built by the bot learner on the server and by
 * scripts/study-replays.ts offline; both print it with `formatReport`.
 */
export type LearnSource = 'owner' | 'auto' | 'upload' | 'archive' | 'script' | 'note';

export interface BrainMove { key: keyof Brain; before: number; after: number; /** What in the match asked for it. */ why?: string }
export interface CountLine { label: string; count: number }
/**
 * A note an owner or dev wrote for the bots (see botnote.ts): who, about which match, what it asked for in plain words, what
 * could not be placed. Kept with the report it produced, in the admin log and in the Bot training tab.
 */
export interface NoteInfo {
  id: string;
  matchId: string;
  at: number;
  by: string;
  role: 'owner' | 'dev';
  text: string;
  /** Written while the match was still running: seconds into the fight. */
  liveSec?: number;
  /** The classes it moved (named in the note, or every bot class in the match). */
  classes: ClassId[];
  /** Each request it was understood to make, in plain words ("break line of sight more"), with the words that said it. */
  asked: { classId: ClassId; key: keyof Brain; dir: 1 | -1; said: string; moved: boolean }[];
  /** Parts it could not place (rephrase them). */
  unmapped: string[];
  /** Parts that report broken behaviour (kept in the bug list). */
  bugs: string[];
  /** Asked for opposite things: nothing was done about these. */
  conflicts: string[];
  /** How many replays of evidence it counted for. */
  weight: number;
}
/** Something the bots do wrong that no brain number can fix, reported in a note: the owner's to-do list. */
export interface BotBug { id: string; matchId: string; at: number; by: string; text: string; fixed: boolean; fixedAt?: number; fixedBy?: string }

export interface BotReport {
  classId: ClassId;
  won: boolean;
  foes: ClassId[];
  engagedSec: number;
  mistakes: CountLine[];
  /** How it played against the people, in words (one line per measure that differed). */
  compared: string[];
  /** The brain numbers this bot's play taught (value wanted, weight of the evidence). */
  lessons: { key: keyof Brain; value: number; weight: number }[];
}
export interface ClassReport { classId: ClassId; moved: BrainMove[]; /** Numbers that were at a limit and what was done about it. */ notes?: string[]; /** Replays that have taught this class so far, this one included. */ replays: number }
export interface LearnReport {
  id: string;
  replayId: string;
  at: number;
  source: LearnSource;
  passes: number;
  /** Replays read in a batch (train on everything archived); 1 otherwise. */
  replaysRead: number;
  /** Replays a batch skipped (older version of the game) or could not read. */
  skipped: number;
  bots: BotReport[];
  classes: ClassReport[];
  /** People whose habits were studied. */
  habits: number;
  /** Every mistake found, by type, summed over the bots. */
  totals: CountLine[];
  /** Why nothing moved; null when something did. */
  nothing: string | null;
  headline: string;
  /** The note this report is about (source 'note'). */
  note?: NoteInfo;
}

/** What the bots of one class know now against what shipped, for the owner's overview. */
export interface ClassKnowledge {
  classId: ClassId;
  replays: number;
  lastAt: number | null;
  /** The brain the class ships with (shared/data/botbrain.json). */
  shipped: Brain;
  /** The brain the learning has built (the shipped one when nothing was learned). */
  learned: Brain;
  /** Numbers where they differ. */
  diff: BrainMove[];
  /** Mistakes seen so far, by label. */
  mistakes: CountLine[];
  /** How the learned variant is doing against the others (null before it has played). */
  variant: { games: number; winRate: number } | null;
  /** Every brain in play for the class, in the words the testing marker uses (same records, same words). */
  variants?: { id: string; label: string; games: number; wins: number; tries: { text: string }[]; more: number }[];
}

/** The server's live learning at a glance (admin panel, Bot training tab): what it has studied and whether it will survive a restart. */
export interface LiveClassStat {
  classId: ClassId;
  /** Matches with people that taught this class (a bot of the class was in them). */
  people: number;
  /** Bot-only matches that taught it. */
  botOnly: number;
  /** Real games of this class's bots against people, and their win rate (null before any). */
  vsGames: number;
  vsWinRate: number | null;
  /** The learned ("lesson") variant against the others. */
  variant: { games: number; winRate: number } | null;
}
export interface LiveLearning {
  /** False when the store is the in-memory fallback: everything learned is lost when the server restarts. */
  persistent: boolean;
  storeKind: string;
  /** Matches studied live, with at least one person in them / bots only. */
  people: number;
  botOnly: number;
  lastAt: number | null;
  /** Matches with people studied since the learned bots were last committed to GitHub. */
  sinceCommit: number;
  lastCommit: { at: number; version: string; url: string; matches: number } | null;
  classes: LiveClassStat[];
}

export const fmtNum = (n: number) => (Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2));

/** Numbers that differ by more than rounding. */
export function brainDiff(before: Brain, after: Brain, eps = 0.0049): BrainMove[] {
  const out: BrainMove[] = [];
  for (const key of BRAIN_KEYS) if (Math.abs(after[key] - before[key]) > eps) out.push({ key, before: before[key], after: after[key] });
  return out;
}

/** A move in plain words, class by class: what the bots now do differently. */
export const plainClassMoves = (classId: string, moves: BrainMove[]): string => `${classId} bots now ${moves.map(plainMove).join('; and ')}`;

export const moveText = (m: BrainMove) => {
  const small = Math.abs(m.after - m.before) < 0.01;
  const f = (n: number) => (small ? n.toFixed(3) : fmtNum(n));
  return `${m.key} ${f(m.before)} -> ${f(m.after)}`;
};

/** The mistakes one bot's play showed, by type. */
export function mistakeLines(f: BotStudy['facts']): CountLine[] {
  const out: CountLine[] = [];
  const add = (label: string, count: number) => count > 0 && out.push({ label, count: Math.round(count) });
  add(FACT_LABELS.kicked, f.kicked);
  add(FACT_LABELS.juked, f.juked);
  add(FACT_LABELS.diedWithDefensive, f.diedWithDefensive);
  add(FACT_LABELS.burstDeaths, f.burstDeaths);
  add(FACT_LABELS.bigCastsTaken, f.bigCastsTaken);
  add(FACT_LABELS.zoneHits, f.zoneHits);
  if (f.kitedFrac >= 0.25) add('seconds kited out of melee reach', f.kitedFrac * f.engagedSec);
  if (f.pinnedFrac >= 0.25) add('seconds pinned by melee as a caster', f.pinnedFrac * f.engagedSec);
  for (const k of Object.keys(f.mistakes) as MistakeKind[]) add(MISTAKE_LABELS[k] ?? k, f.mistakes[k] ?? 0);
  return out;
}

export function sumLines(lists: CountLine[][]): CountLine[] {
  const by = new Map<string, number>();
  for (const l of lists) for (const c of l) by.set(c.label, (by.get(c.label) ?? 0) + c.count);
  return [...by].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

export function botReports(study: MatchStudy): BotReport[] {
  return study.bots.map((b) => ({
    classId: b.classId,
    won: b.won,
    foes: b.foes,
    engagedSec: b.facts.engagedSec,
    mistakes: mistakeLines(b.facts),
    compared: b.nudges.map((n) => n.why),
    lessons: (Object.keys(b.lessons) as (keyof Brain)[]).map((key) => ({ key, value: b.lessons[key]!.value, weight: b.lessons[key]!.weight })),
  }));
}

/** An honest reason nothing moved. */
export function nothingReason(bots: BotReport[], hadReplay = true): string {
  if (!hadReplay) return 'the replay could not be used';
  if (!bots.length) return 'no bot fought a person in it, so there was nothing to compare against';
  if (bots.every((b) => b.engagedSec < 8)) return `the fight was too short to measure (${Math.max(...bots.map((b) => b.engagedSec))}s of fighting)`;
  const found = bots.reduce((n, b) => n + b.mistakes.reduce((m, c) => m + c.count, 0), 0);
  if (found > 0) {
    const top = sumLines(bots.map((b) => b.mistakes)).slice(0, 3).map((c) => `${c.count} ${c.label}`).join(', ');
    return `${found} mistake${found === 1 ? '' : 's'} showed (${top}), but that is still too little evidence to move a brain number, or the bots already play past what it asks`;
  }
  return 'the bots played this fight the way the people did on every measure (movement, cooldowns, defensives, target switching), within the noise, and no mistake was found';
}

export function buildReport(o: {
  id: string;
  replayId: string;
  at: number;
  source: LearnSource;
  passes: number;
  study: MatchStudy;
  classes: ClassReport[];
  habits: number;
  replaysRead?: number;
  skipped?: number;
  hadReplay?: boolean;
}): LearnReport {
  const bots = botReports(o.study);
  const moved = o.classes.filter((c) => c.moved.length);
  const nothing = moved.length ? null : nothingReason(bots, o.hadReplay);
  const headline = moved.length
    ? `${moved.length} bot class${moved.length === 1 ? '' : 'es'} changed. ${moved.map((c) => `${plainClassMoves(c.classId, c.moved)}.`).join(' ')}`
    : `Nothing to learn from this match: ${nothing}.`;
  return {
    id: o.id, replayId: o.replayId, at: o.at, source: o.source, passes: o.passes, replaysRead: o.replaysRead ?? 1, skipped: o.skipped ?? 0,
    bots, classes: o.classes, habits: o.habits, totals: sumLines(bots.map((b) => b.mistakes)), nothing, headline,
  };
}

/** The report as lines of text (the admin panel's expandable lines, the study script's output). */
export function formatReport(r: LearnReport): string[] {
  const lines = [r.headline];
  if (r.note) lines.push(...noteLines(r.note));
  if (r.replaysRead > 1 || r.skipped) lines.push(`Read ${r.replaysRead} replays${r.skipped ? `, skipped ${r.skipped} (recorded on another version of the game, or unreadable)` : ''}.`);
  if (r.passes > 1) lines.push(`Trained ${r.passes} passes on it.`);
  for (const b of r.bots) {
    const mist = b.mistakes.length ? b.mistakes.map((c) => `${c.count} ${c.label}`).join(', ') : 'no mistakes found';
    lines.push(`${b.classId} bot (${b.won ? 'won' : 'lost'} against ${b.foes.join(', ') || 'nobody'}, ${b.engagedSec}s of fighting): ${mist}.`);
    for (const c of b.compared) lines.push(`  compared with the people: ${c}.`);
    if (b.lessons.length) lines.push(`  taught: ${b.lessons.map((l) => `${BRAIN_WORDS[l.key]?.what ?? l.key} towards ${showBrainValue(l.key, l.value)} (evidence ${Math.round(l.weight)})`).join('; ')}.`);
  }
  for (const c of r.classes) {
    if (!c.moved.length) {
      lines.push(`${c.classId}: nothing changed.`);
      continue;
    }
    lines.push(`${c.classId} bots (${c.replays} replay${c.replays === 1 ? '' : 's'} learned from so far) are trying:`);
    for (const m of c.moved) lines.push(`  • ${plainMove(m)}${m.why ? ` because ${m.why}` : ''}. Look for: ${BRAIN_WORDS[m.key]?.watch ?? 'a change in how they play'}. [${moveText(m)}]`);
  }
  for (const c of r.classes) for (const n of c.notes ?? []) lines.push(`${c.classId}: ${n}`);
  if (r.habits) lines.push(`${r.habits} player${r.habits === 1 ? '’s' : 's’'} habits (kick timing, fakes, spacing) were studied.`);
  if (r.note) return lines;
  lines.push('The changed brain joins the class as a "lesson" variant and plays in a share of its games until it proves itself; a variant that wins more is picked more.');
  return lines;
}

/** A note's effect in plain words (the lines under "What was learned"). */
export function noteLines(n: NoteInfo): string[] {
  const lines = [`Note from ${n.by} (${n.role === 'owner' ? 'owner' : 'dev'})${n.liveSec !== undefined ? ` ${n.liveSec}s into the match` : ' after the match'}, match ${n.matchId}: "${n.text}"`];
  lines.push(`It counted like ${n.weight} replays of evidence, inside the same step, drift and bound limits as graded learning.`);
  for (const a of n.asked) lines.push(`  • ${a.classId} bots: "${a.said}" means ${BRAIN_WORDS[a.key].what} should ${a.dir > 0 ? 'go up' : 'go down'}${a.moved ? '' : ' (it was already at its limit, so nothing moved)'}.`);
  for (const c of n.conflicts) lines.push(`  • Not done: ${c}.`);
  if (n.bugs.length) lines.push(`Bot bug${n.bugs.length === 1 ? '' : 's'} reported (no brain number can fix it, it is in the bug list): ${n.bugs.map((b) => `"${b}"`).join('; ')}.`);
  if (n.unmapped.length) lines.push(`Could not place: ${n.unmapped.map((b) => `"${b}"`).join('; ')}. Rephrase it with words like "didn't los enough", "ran out of mana" or "kicked too early".`);
  return lines;
}
