/** The arena after (step 1) or before (step -1) `current` in the list, wrapping round. An unknown current id starts from the first. */
export function cycleArena(ids: readonly string[], current: string, step: 1 | -1): string {
  if (!ids.length) return current;
  const i = ids.indexOf(current);
  if (i < 0) return ids[step === 1 ? 0 : ids.length - 1];
  return ids[(i + step + ids.length) % ids.length];
}
