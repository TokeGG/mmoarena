/**
 * How far in the past other players are drawn, and what to draw when that moment is newer than the newest snapshot.
 * Pure functions and a small state holder, unit tested in client/test/interpDelay.test.ts.
 */
import { percentile } from './netClock';

export const MIN_DELAY_MS = 60;
export const MAX_DELAY_MS = 200;
/** Longest stretch drawn past the newest snapshot (a guess along the last velocity, fading out). */
export const MAX_EXTRAPOLATE_MS = 100;

/** The delay the buffer should have: at least 1.5 snapshot intervals, and an interval plus the jitter the link shows plus a margin. */
export function targetDelay(intervalMs: number, latenessP95Ms: number): number {
  const d = Math.max(1.5 * intervalMs, intervalMs + latenessP95Ms + 10);
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, d));
}

/** The current interpolation delay: rises quickly when the link gets worse, falls back slowly so the picture does not breathe. */
export class InterpDelay {
  delay = 100;
  constructor(private up = 0.2, private down = 0.02) {}

  update(intervalMs: number, latenessP95Ms: number): number {
    const t = targetDelay(intervalMs, latenessP95Ms);
    this.delay += (t - this.delay) * (t > this.delay ? this.up : this.down);
    return this.delay;
  }
}

/** Mean and p95 of the interval between server snapshots (their time labels), kept as a small window. */
export class IntervalTracker {
  private last = Number.NaN;
  private vals: number[] = [];
  mean = 50;
  add(serverTime: number): void {
    if (Number.isFinite(this.last) && serverTime > this.last) {
      this.vals.push(serverTime - this.last);
      if (this.vals.length > 40) this.vals.shift();
      this.mean = percentile(this.vals, 0.5);
    }
    this.last = serverTime;
  }
  reset(): void {
    this.last = Number.NaN;
    this.vals = [];
    this.mean = 50;
  }
}

export interface Pose {
  t: number;
  x: number;
  z: number;
  y: number;
  facing: number;
}

const lerpAngle = (a: number, b: number, t: number) => {
  const d = ((((b - a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return a + d * t;
};

/** Faster than anything in the game moves (units per second): a jump between two snapshots this fast is a teleport, not motion. */
const MAX_PLAUSIBLE_SPEED = 45;

/**
 * Where a unit is drawn at server time `rt`, given its two newest-bracketing snapshots `a` (older) and `b`.
 * Between them: linear. Past `b`: continues along the a-to-b velocity, slowing to a stop over `maxMs`
 * (the distance is v * (e - e^2 / (2 maxMs)) for e ms past b, capped at e = maxMs), unless the step looks like a teleport.
 */
export function poseAt(a: Pose, b: Pose, rt: number, maxMs = MAX_EXTRAPOLATE_MS): Pose & { extrapolated: boolean } {
  if (rt <= a.t) return { ...a, extrapolated: false };
  if (rt <= b.t) {
    const t = b.t > a.t ? (rt - a.t) / (b.t - a.t) : 1;
    return { t: rt, x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, y: a.y + (b.y - a.y) * t, facing: lerpAngle(a.facing, b.facing, t), extrapolated: false };
  }
  const span = b.t - a.t;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (span <= 0 || Math.hypot(dx, dz) / (span / 1000) > MAX_PLAUSIBLE_SPEED) return { ...b, extrapolated: false };
  const e = Math.min(rt - b.t, maxMs);
  const k = (e - (e * e) / (2 * maxMs)) / span;
  return { t: rt, x: b.x + dx * k, z: b.z + dz * k, y: b.y, facing: b.facing, extrapolated: true };
}

/** Render time = clock minus delay, but never earlier than the last frame's (a rising delay pauses the picture rather than rewinding it). */
export class RenderTime {
  private last = -Infinity;
  next(clockNow: number, delayMs: number): number {
    const t = clockNow - delayMs;
    if (t > this.last) this.last = t;
    return this.last;
  }
  reset(): void {
    this.last = -Infinity;
  }
}
