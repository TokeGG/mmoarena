/**
 * Pure matchmaking: given everyone waiting, find two teams of exactly `size` players. An entry is a solo player or a
 * whole party (never split). Players who picked a specific arena only play there; 'random' entries fit anywhere.
 */
export interface QEntry<T> {
  members: T[];
  size: 1 | 2 | 3;
  /** An arena id, or 'random'. */
  pref: string;
  /** When they started waiting (ms); older entries are tried first. */
  at: number;
  /** Ranked ladder (signed-in players only) or the unrated guest queue; the two never mix. */
  ranked?: boolean;
}

export interface Found<T> {
  map: string;
  teamA: QEntry<T>[];
  teamB: QEntry<T>[];
}

const MAX_POOL = 10;

/** Split `pool` into two disjoint groups each totalling `size` players. `must` (an index) cannot be left out. */
function split<T>(pool: QEntry<T>[], size: number, must: number): { a: QEntry<T>[]; b: QEntry<T>[] } | null {
  const a: QEntry<T>[] = [];
  const b: QEntry<T>[] = [];
  const go = (i: number, sa: number, sb: number): boolean => {
    if (sa === size && sb === size) return true;
    if (i >= pool.length) return false;
    const n = pool[i].members.length;
    if (sa + n <= size) {
      a.push(pool[i]);
      if (go(i + 1, sa + n, sb)) return true;
      a.pop();
    }
    if (sb + n <= size) {
      b.push(pool[i]);
      if (go(i + 1, sa, sb + n)) return true;
      b.pop();
    }
    if (i !== must) return go(i + 1, sa, sb);
    return false;
  };
  return go(0, 0, 0) ? { a, b } : null;
}

export function findMatch<T>(entries: QEntry<T>[], size: 1 | 2 | 3, randomMap: () => string): Found<T> | null {
  const mine = entries.filter((e) => e.size === size && e.members.length <= size).sort((x, y) => x.at - y.at);
  // arenas people asked for, oldest request first; each is anchored on its oldest waiting entry
  const specific = [...new Set(mine.filter((e) => e.pref !== 'random').map((e) => e.pref))];
  for (const map of specific) {
    const pool = mine.filter((e) => e.pref === map || e.pref === 'random').slice(0, MAX_POOL);
    const anchor = pool.findIndex((e) => e.pref === map);
    const r = split(pool, size, anchor);
    if (r) return { map, teamA: r.a, teamB: r.b };
  }
  const randoms = mine.filter((e) => e.pref === 'random').slice(0, MAX_POOL);
  const r = split(randoms, size, 0);
  return r ? { map: randomMap(), teamA: r.a, teamB: r.b } : null;
}
