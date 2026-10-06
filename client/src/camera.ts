/** Mouse-wheel zoom for the orbit camera. Distance 0 is first person; third person runs from MIN to MAX yards. */
export const CAM_MIN = 3;
export const CAM_MAX = 30;

export function zoomStep(dist: number, deltaY: number): number {
  if (deltaY === 0) return dist;
  if (dist <= 0.01) return deltaY > 0 ? CAM_MIN : 0; // first person: scroll out leaves it
  if (deltaY < 0 && dist <= CAM_MIN + 0.01) return 0; // already at the closest third-person view: one more notch goes first person
  const next = dist * Math.exp(deltaY * 0.001);
  return deltaY < 0 && next < CAM_MIN * 0.8 ? 0 : Math.min(CAM_MAX, Math.max(CAM_MIN, next));
}

/**
 * How far behind the head the camera can sit. `want` is the zoom distance, `offset` the unit vector from the head to
 * the camera. Walls and floor are checked here; `hit` is the nearest pillar hit along the ray (or Infinity).
 * A result under ~1.1 means first person.
 */
export function cameraReach(
  want: number,
  head: { x: number; y: number; z: number },
  offset: { x: number; y: number; z: number },
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  hit = Infinity,
): number {
  if (want <= 0.35) return want;
  let d = Math.min(want, hit - 0.4);
  const lim = (o: number, p: number, lo: number, hi: number) => (o > 1e-6 ? (hi - 0.4 - p) / o : o < -1e-6 ? (lo + 0.4 - p) / o : Infinity);
  d = Math.min(d, lim(offset.x, head.x, bounds.minX, bounds.maxX), lim(offset.z, head.z, bounds.minZ, bounds.maxZ), offset.y < -1e-6 ? (head.y - 0.5) / -offset.y : Infinity);
  return d;
}
