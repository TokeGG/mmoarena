/** Which patch notes the player has already seen: the newest version they opened the list at, kept in localStorage. */
export const LAST_SEEN_KEY = 'arena.lastSeenPatch.v1';

/** Compare "0.69.3" style versions: negative when a is older than b. Missing or odd parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** How many entries are newer than the last seen version. No stored version (a fresh install) means nothing is new. */
export function unseenPatchCount(patches: { version: string }[], lastSeen: string | null): number {
  if (!lastSeen) return 0;
  return patches.filter((p) => compareVersions(p.version, lastSeen) > 0).length;
}

/** The version to store once the list was shown: the newest entry (never older than what was already stored). */
export function markSeen(patches: { version: string }[], lastSeen: string | null): string | null {
  let newest = lastSeen;
  for (const p of patches) if (!newest || compareVersions(p.version, newest) > 0) newest = p.version;
  return newest;
}

/** "You missed 3 updates since your last visit", or an empty string when nothing is new. */
export function missedText(n: number): string {
  return n > 0 ? `You missed ${n} update${n === 1 ? '' : 's'} since your last visit.` : '';
}
