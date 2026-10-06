/**
 * Jumping is cosmetic: it changes how high a unit is drawn, never where it is on the ground, so it cannot dodge,
 * clip or reach anything. The server decides when a jump starts (and snapshots the height for everyone); the client
 * uses the same curve to show its own jump instantly.
 */
export const JUMP_MS = 650;
export const JUMP_HEIGHT = 1.45;
/** Minimum gap after landing before the next jump can start. */
export const JUMP_GAP_MS = 40;

/** Height above the ground `elapsedMs` after a jump began (0 before it and after it ends). */
export function jumpHeight(elapsedMs: number): number {
  if (elapsedMs <= 0 || elapsedMs >= JUMP_MS) return 0;
  const t = elapsedMs / JUMP_MS;
  return 4 * JUMP_HEIGHT * t * (1 - t);
}

/** Airborne at least this high when a ground effect pulses, and the unit avoids that pulse. */
export const JUMP_DODGE_HEIGHT = 0.5;
/** A jump only grants ground-effect immunity if the previous immune jump began at least this long ago (no hop-spamming). */
export const JUMP_DODGE_CD = 1500;

export const canStartJump = (sinceLastStartMs: number): boolean => sinceLastStartMs >= JUMP_MS + JUMP_GAP_MS;
