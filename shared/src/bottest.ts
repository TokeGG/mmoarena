import { BRAIN_BOUNDS, BRAIN_KEYS, brainFor } from './botbrain';
import type { Brain } from './botbrain';
import { BRAIN_WORDS, showBrainValue } from './brainwords';
import type { ClassId } from './types';

/**
 * The "testing" marker: what a bot in a match is trying that the shipped brain does not. Only the owner and devs are ever
 * sent it (a separate `bot_tests` message, never a snapshot); the server builds it from the variant's own record, the same
 * brains and counts the "What was learned" report is built from.
 */
export interface BotTestTry {
  key: keyof Brain;
  /** What it does differently, with the numbers: "use defensive cooldowns later (62% instead of 65%)". */
  text: string;
  /** What to look for in the match. */
  watch: string;
}
export interface BotTest {
  /** The bot's unit in the match. */
  unit: number;
  classId: ClassId;
  /** Which brain it plays: "lesson", "variant g2v481", "human style". */
  label: string;
  /** The biggest differences from the shipped brain (at most TRIES_SHOWN). */
  tries: BotTestTry[];
  /** How many further differences are not listed. */
  more: number;
  /** The variant's record against people so far (wins counts partial scores, so it may be fractional). */
  games: number;
  wins: number;
}

export const TRIES_SHOWN = 3;
/** A number counts as different from the shipped brain when it is this share of its range away. */
export const TEST_EPS = 0.005;

export function variantLabel(variantId: string): string {
  if (variantId === 'lesson') return 'lesson';
  if (variantId === 'human') return 'human style';
  return `variant ${variantId}`;
}

const noParen = (s: string) => s.replace(/\s*\([^)]*\)/g, '').trim();

/** One difference in words: "use defensive cooldowns later (62% instead of 65%)". */
export function tryText(key: keyof Brain, before: number, after: number): string {
  const w = BRAIN_WORDS[key];
  return `${noParen(after > before ? w.up : w.down)} (${showBrainValue(key, after)} instead of ${showBrainValue(key, before)})`;
}

/** The numbers where `brain` differs from `shipped`, biggest first (by share of the number's range). */
export function biggestDifferences(brain: Brain, shipped: Brain): { key: keyof Brain; before: number; after: number; share: number }[] {
  const out: { key: keyof Brain; before: number; after: number; share: number }[] = [];
  for (const key of BRAIN_KEYS) {
    const [lo, hi] = BRAIN_BOUNDS[key];
    const share = Math.abs(brain[key] - shipped[key]) / (hi - lo || 1);
    if (share > TEST_EPS) out.push({ key, before: shipped[key], after: brain[key], share });
  }
  return out.sort((a, b) => b.share - a.share);
}

/** What a bot playing `brain` is testing, or null when it plays the shipped brain (nothing to mark). */
export function describeVariant(classId: ClassId, variantId: string, brain: Brain, record: { games: number; wins: number }, shipped: Brain = brainFor(classId)): Omit<BotTest, 'unit'> | null {
  const diffs = biggestDifferences(brain, shipped);
  if (!diffs.length) return null;
  return {
    classId,
    label: variantLabel(variantId),
    tries: diffs.slice(0, TRIES_SHOWN).map((d) => ({ key: d.key, text: tryText(d.key, d.before, d.after), watch: BRAIN_WORDS[d.key].watch })),
    more: Math.max(0, diffs.length - TRIES_SHOWN),
    games: record.games,
    wins: Math.round(record.wins * 10) / 10,
  };
}
