/** Owner-only play time statistics: where each signed-in account spends its time on the server. All durations are milliseconds. */

/** What a connection is doing. Match kinds are told apart by who plays and how: ranked queue, a duel, friends together, one player against bots, or a dev test match (changed numbers). */
export const TIME_CATS = ['menu', 'queue', 'practice', 'party', 'duel', 'ranked', 'spectate', 'dev'] as const;
export type TimeCat = (typeof TIME_CATS)[number];
/** Categories that are played in a match (they are also broken down by class, spec, arena and mode). */
export const TIME_MATCH_CATS: readonly TimeCat[] = ['practice', 'party', 'duel', 'ranked', 'dev'];
export const TIME_CAT_LABEL: Record<TimeCat, string> = { menu: 'Main menu', queue: 'In the queue', practice: 'Practice vs bots', party: 'Party / friends', duel: 'Duels', ranked: 'Ranked', spectate: 'Spectating', dev: 'Dev test matches' };
export const TIME_MODES = ['1v1', '2v2', '3v3'] as const;
/** Days of per-day history that are kept. */
export const TIME_DAYS = 30;
/** No input for this long in the menu stops the clock. */
export const TIME_IDLE_MS = 5 * 60 * 1000;

export type TimeBuckets = Record<string, number>;

/** One account. `total` is counted play time (idle time is not in it; it is kept in `idle`). */
export interface TimeRecord {
  first: number;
  last: number;
  sessions: number;
  total: number;
  idle: number;
  cat: Record<TimeCat, number>;
  /** classId, "classId:specId", arena id and "2v2" to milliseconds. */
  cls: TimeBuckets;
  spec: TimeBuckets;
  map: TimeBuckets;
  mode: TimeBuckets;
  /** "YYYYMMDD" (UTC) to milliseconds, the last TIME_DAYS days. */
  days: TimeBuckets;
}

/** The whole server: accounts and guests together, with the guests also on their own. */
export interface TimeGlobal {
  since: number;
  sessions: number;
  total: number;
  cat: Record<TimeCat, number>;
  cls: TimeBuckets;
  spec: TimeBuckets;
  map: TimeBuckets;
  mode: TimeBuckets;
  days: TimeBuckets;
  /** Milliseconds spent in each hour of the day, UTC. */
  hours: number[];
  guests: { total: number; sessions: number; cat: Record<TimeCat, number> };
}

/** One line of the owner's table. */
export interface TimeRow {
  name: string;
  total: number;
  last: number;
  online: boolean;
  cat: Record<TimeCat, number>;
}

export const emptyCats = (): Record<TimeCat, number> => ({ menu: 0, queue: 0, practice: 0, party: 0, duel: 0, ranked: 0, spectate: 0, dev: 0 });
