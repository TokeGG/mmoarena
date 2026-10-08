/** Pure helpers for the waving banner cloth (no THREE import so they can be unit tested). */

/** Depth displacement of cloth point (u along the cloth away from the pole, v down from the top, both 0..1). */
export function clothWave(u: number, v: number, t: number, amp = 0.28): number {
  const free = u * u * 0.6 + u * 0.4; // pinned at the pole, free at the far edge
  return amp * free * (Math.sin(u * 7 - t * 7.5 + v * 1.6) + 0.35 * Math.sin(u * 13 - t * 11 + v * 3));
}

/** Slope of the wave along u (finite difference), used to shade the folds. */
export function clothShade(u: number, v: number, t: number): number {
  const e = 0.02;
  const d = (clothWave(Math.min(1, u + e), v, t) - clothWave(Math.max(0, u - e), v, t)) / (2 * e);
  return Math.max(0.55, Math.min(1.1, 0.85 + d * 0.35));
}

/** 0..1 unfurl progress of a banner planted `age` seconds ago (dropping in for `drop` s, then unfurling over `unfurl` s). */
export function unfurlProgress(age: number, drop = 0.22, unfurl = 0.3): number {
  const k = Math.min(1, Math.max(0, (age - drop) / unfurl));
  return 1 - (1 - k) * (1 - k);
}

/** Fade multiplier over the last second of a zone's life. */
export function endFade(leftMs: number): number {
  return Math.min(1, Math.max(0, leftMs / 1000));
}
