/**
 * The body animation of a shout, roar, scream or breath: a one-shot overlay on top of whatever the model is doing.
 * The character leans back with the chest out and the head thrown back (arms out a little), then snaps forward as the
 * sound / fire leaves the mouth, and settles. Plain numbers (no three.js) so the three animators share it and it can be tested:
 * RigAnimator (procedural bones), ClipAnimator (clip models, applied after the mixer) and the procedural Character.
 *
 * Conventions are the ones of riggedPose.ts: a positive spine / chest / head pitch leans forward, a negative arm pitch swings
 * the arm forward, a positive roll on the left arm (negative on the right) swings it outward.
 */

/** Seconds the whole pose lasts. */
export const SHOUT_DUR = 0.95;
/** Seconds into the pose when the sound leaves the mouth: the lean back is over and the snap forward begins. Effects delay the waves by this much. */
export const SHOUT_RELEASE = 0.26;

export interface ShoutPose {
  /** Pitch added to the spine and the chest (negative = leaning back). */
  spine: number;
  chest: number;
  neck: number;
  head: number;
  /** Pitch added to both upper arms (positive = back) and the outward roll (positive = away from the body). */
  armX: number;
  armZ: number;
  /** Elbow bend added to both forearms. */
  elbow: number;
  /** Body lunge forward in yards. */
  lunge: number;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOut = (x: number) => 1 - (1 - clamp01(x)) ** 3;
const smooth = (x: number) => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

export const newShoutPose = (): ShoutPose => ({ spine: 0, chest: 0, neck: 0, head: 0, armX: 0, armZ: 0, elbow: 0, lunge: 0 });

/** The pose `q` (0..1 through SHOUT_DUR) into the shout; all zero outside that range. Writes into `out` (no allocation). */
export function shoutPose(q: number, out: ShoutPose = newShoutPose()): ShoutPose {
  if (q < 0 || q >= 1) return Object.assign(out, newShoutPose());
  const t = q * SHOUT_DUR;
  const T1 = SHOUT_RELEASE; // lean back finished
  const T2 = T1 + 0.14; // snapped forward
  let k: number;
  if (t < T1) {
    // draw breath: chest out, head back, arms drift out and back
    k = easeOut(t / T1);
    out.spine = -0.32 * k;
    out.chest = -0.42 * k;
    out.neck = -0.3 * k;
    out.head = -0.42 * k;
    out.armX = 0.3 * k;
    out.armZ = 0.6 * k;
    out.elbow = -0.1 * k;
    out.lunge = -0.05 * k;
  } else if (t < T2) {
    // the shout: snap forward, head and chest thrust at the target, arms flung forward
    k = easeOut((t - T1) / (T2 - T1));
    out.spine = lerp(-0.32, 0.18, k);
    out.chest = lerp(-0.42, 0.26, k);
    out.neck = lerp(-0.3, 0.15, k);
    out.head = lerp(-0.42, 0.26, k);
    out.armX = lerp(0.3, -0.45, k);
    out.armZ = lerp(0.6, 0.35, k);
    out.elbow = lerp(-0.1, -0.35, k);
    out.lunge = lerp(-0.05, 0.14, k);
  } else {
    // hold the follow-through a moment, then settle
    k = smooth((t - T2) / (SHOUT_DUR - T2));
    const h = 1 - k;
    out.spine = 0.18 * h;
    out.chest = 0.26 * h;
    out.neck = 0.15 * h;
    out.head = 0.26 * h;
    out.armX = -0.45 * h;
    out.armZ = 0.35 * h;
    out.elbow = -0.35 * h;
    out.lunge = 0.14 * h;
  }
  return out;
}
