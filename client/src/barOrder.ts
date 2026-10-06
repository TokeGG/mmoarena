/** Player-chosen order of the action bar, saved per class and spec (keys 1-8 follow the order). */

const key = (classId: string, spec: string | null) => `arena.barorder.${classId}.${spec ?? '-'}`;

/** Put `bar` into the saved order. Abilities the save does not know (a new talent swap) keep their default slot if it is free, else go last. */
export function applyOrder(bar: readonly string[], saved: readonly string[] | null | undefined): string[] {
  if (!saved || !saved.length) return [...bar];
  const out: (string | null)[] = new Array(bar.length).fill(null);
  const left = new Set(bar);
  saved.forEach((id, i) => {
    if (i < out.length && left.has(id)) {
      out[i] = id;
      left.delete(id);
    }
  });
  // unknown abilities (swapped in by a talent) take the slots of the ones they replaced, then any free slot
  for (const id of bar) {
    if (!left.has(id)) continue;
    let at = bar.indexOf(id);
    if (out[at] !== null) at = out.indexOf(null);
    out[at] = id;
    left.delete(id);
  }
  return out as string[];
}

/** Swap two slots. */
export function swapSlots(bar: readonly string[], a: number, b: number): string[] {
  const out = [...bar];
  if (a < 0 || b < 0 || a >= out.length || b >= out.length || a === b) return out;
  [out[a], out[b]] = [out[b], out[a]];
  return out;
}

export function loadOrder(classId: string, spec: string | null): string[] | null {
  try {
    const raw = localStorage.getItem(key(classId, spec));
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null;
  } catch {
    return null;
  }
}

export function saveOrder(classId: string, spec: string | null, bar: readonly string[]): void {
  try {
    localStorage.setItem(key(classId, spec), JSON.stringify(bar));
  } catch {
    /* ignore */
  }
}
