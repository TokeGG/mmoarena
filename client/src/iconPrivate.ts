/**
 * The icons of a private pack (their licence forbids sharing the files, so the repository does not have them): the server says
 * which ones it can serve. Asked once when the Icon edit page opens, and again after a pack upload. A failed request means none.
 */
let known: Set<string> | null = null;
let pending: Promise<Set<string>> | null = null;

/** The ids the server has files for, as last heard (null before the first answer). */
export const privateIconsNow = (): ReadonlySet<string> | null => known;

export function loadPrivateIcons(force = false): Promise<Set<string>> {
  if (pending && !force) return pending;
  pending = (async () => {
    try {
      const r = await fetch('/api/icons/private', { cache: 'no-store' });
      if (!r.ok) return (known = new Set());
      const j = (await r.json()) as { available?: unknown };
      return (known = new Set(Array.isArray(j.available) ? j.available.filter((x): x is string => typeof x === 'string') : []));
    } catch {
      return (known = new Set());
    }
  })();
  return pending;
}
