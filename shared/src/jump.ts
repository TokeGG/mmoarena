/**
 * Jumping is cosmetic: it changes how high a unit is drawn, never where it is on the ground, so it cannot dodge,
 * clip or reach anything. The server decides when a jump starts (and snapshots the height for everyone); the client
 * uses the same curve to show its own jump instantly.
 */
export const JUMP_MS = 650;
/** Peak height. Raised (from 1.45) so a jump carries you over a player-height barricade; every rule that asks "high enough?" scaled with it, so jump timings are unchanged. */
export const JUMP_HEIGHT = 1.8;
/** Minimum gap after landing before the next jump can start. */
export const JUMP_GAP_MS = 40;

/** Height above the ground `elapsedMs` after a jump began (0 before it and after it ends). */
export function jumpHeight(elapsedMs: number): number {
  if (elapsedMs <= 0 || elapsedMs >= JUMP_MS) return 0;
  const t = elapsedMs / JUMP_MS;
  return 4 * JUMP_HEIGHT * t * (1 - t);
}

/** Airborne at least this high when a ground effect pulses, and the unit avoids that pulse. */
export const JUMP_DODGE_HEIGHT = 0.62;
/** A jump only grants ground-effect immunity if the previous immune jump began at least this long ago (no hop-spamming). */
export const JUMP_DODGE_CD = 1500;

export const canStartJump = (sinceLastStartMs: number): boolean => sinceLastStartMs >= JUMP_MS + JUMP_GAP_MS;

/** A unit lifted straight up and held there (Ascend to the Heavens). */
export interface HoverDef { height: number; riseMs: number; fallMs: number }

/** Height above the ground `elapsedMs` into a hover that lasts `totalMs`: a smooth rise, a hold, a smooth fall back down (0 outside it). */
export function hoverHeight(h: HoverDef, elapsedMs: number, totalMs: number): number {
  if (elapsedMs <= 0 || elapsedMs >= totalMs) return 0;
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const up = Math.min(1, elapsedMs / h.riseMs);
  const down = Math.min(1, (totalMs - elapsedMs) / h.fallMs);
  return h.height * smooth(Math.min(up, down));
}
