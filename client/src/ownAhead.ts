/**
 * Where our own character is drawn: the predicted position projected forward to the render time inside the current tick,
 * instead of blended up to one tick behind. Pure; unit tested in client/test/ownAhead.test.ts.
 */
export function ownAhead(pred: { x: number; z: number }, prev: { x: number; z: number }, accSec: number, dtSec: number, maxStep: number): { x: number; z: number } {
  const f = dtSec > 0 ? Math.min(1, Math.max(0, accSec / dtSec)) : 0;
  let vx = pred.x - prev.x;
  let vz = pred.z - prev.z;
  const len = Math.hypot(vx, vz);
  if (len > maxStep) {
    // a correction or a teleport is not velocity: only a normal step is projected
    vx = 0;
    vz = 0;
  }
  return { x: pred.x + vx * f, z: pred.z + vz * f };
}
