import { BRAIN_KEYS } from './botbrain';
import type { Brain } from './botbrain';
import type { HumanStyle } from './humanstyle';
import { CLASS_IDS } from './data';
import type { ClassId } from './types';

/**
 * The files the bots' learning is committed in (shared/data/botbrain.json and shared/data/players.json) and how they are
 * written. scripts/study-replays.ts (offline, from replays) and the server's "Commit learned bots" action (live, from what
 * the learner knows) both use these, so the two always produce the same format.
 */

/** One class's entry in players.json: how people of that class play, and how the bots really did against them. */
export interface PlayersEntry { style: HumanStyle; vsPeople: Record<string, { games: number; botWins: number }> }
export type PlayersFile = Record<string, PlayersEntry>;

/** A brain as botbrain.json has it: every number, three decimals. */
export function roundBrain(b: Brain): Record<string, number> {
  return Object.fromEntries(BRAIN_KEYS.map((k) => [k, Math.round(b[k] * 1000) / 1000]));
}

/** A class's players.json entry from its measured style and its real results (person class -> games and bot wins). */
export function playersEntry(style: HumanStyle | undefined, vs: Iterable<[string, { games: number; botWins: number }]>): PlayersEntry {
  return {
    style: Object.fromEntries(Object.entries(style ?? {}).map(([k, m]) => [k, { value: Math.round(m!.value * 1000) / 1000, weight: Math.round(m!.weight) }])) as HumanStyle,
    vsPeople: Object.fromEntries(vs),
  };
}

/** Does players.json hold anything measured from real people for this class? */
export function hasHumanData(file: Partial<Record<string, Partial<PlayersEntry>>> | undefined, c: ClassId): boolean {
  const e = file?.[c];
  return !!e && (Object.keys(e.style ?? {}).length > 0 || Object.keys(e.vsPeople ?? {}).length > 0);
}

/**
 * The live data over what the file already has: per class, a style number keeps whichever side has more weight behind it
 * and a match-up whichever has more games, so a server that only just restarted (little learned) never wipes out what an
 * earlier commit kept.
 */
export function mergePlayers(existing: Partial<Record<string, Partial<PlayersEntry>>>, live: PlayersFile): PlayersFile {
  const out: PlayersFile = {};
  for (const c of CLASS_IDS) {
    const a = existing[c] ?? {};
    const b = live[c] ?? { style: {}, vsPeople: {} };
    const style: Record<string, { value: number; weight: number }> = { ...((a.style ?? {}) as Record<string, { value: number; weight: number }>) };
    for (const [k, m] of Object.entries(b.style as Record<string, { value: number; weight: number }>)) if (!style[k] || m.weight >= style[k].weight) style[k] = m;
    const vs = { ...(a.vsPeople ?? {}) };
    for (const [p, e] of Object.entries(b.vsPeople)) if (!vs[p] || e.games >= vs[p].games) vs[p] = e;
    out[c] = { style: style as HumanStyle, vsPeople: vs };
  }
  return out;
}

/** players.json / botbrain.json text. */
export const dataFileText = (v: unknown): string => JSON.stringify(v, null, 1) + '\n';
