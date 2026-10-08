/**
 * How far in the past other players are drawn, and what to draw when that moment is newer than the newest snapshot.
 * Pure functions and a small state holder, unit tested in client/test/interpDelay.test.ts.
 */
import { percentile } from './netClock';

export const MIN_DELAY_MS = 24;
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

  /** A new match at a tick length: start at what a clean link needs for it (1.5 snapshot intervals) rather than at a 20 Hz value. */
  reset(tickMs = 50): void {
    this.delay = Math.max(MIN_DELAY_MS, 1.5 * tickMs + 25);
  }

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
      if (this.vals.length > 40) this.vals.shift(); // 40 intervals: 0.64 s at 62.5 Hz is short but enough for a median
      this.mean = percentile(this.vals, 0.5);
    }
    this.last = serverTime;
  }
  reset(tickMs = 50): void {
    this.last = Number.NaN;
    this.vals = [];
    this.mean = tickMs;
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
 * (the distance is v * (e - e^2 / (2 maxMs)) for e ms past b, capped at e = maxMs; `linear`: v * e at full speed), unless the step looks like a teleport.
 */
export function poseAt(a: Pose, b: Pose, rt: number, maxMs = MAX_EXTRAPOLATE_MS, linear = false): Pose & { extrapolated: boolean } {
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
  const k = (linear ? e : e - (e * e) / (2 * maxMs)) / span; // linear: dead reckoning at full speed up to maxMs (see Lead)
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

/** Dead reckoning of other players: drawn this fraction of the round trip ahead of the buffered time (netstudy --target: the smallest pairwise error at 0.75). */
export const LEAD_FRACTION = 0.75;
export const LEAD_MAX_MS = 150;
/** Longest stretch dead reckoning runs past the newest snapshot (buffer + lead + a late packet). */
export const LEAD_EXTRAPOLATE_MS = 400;

/** How far ahead of the buffered render time other players are drawn so that two screens show each other in the same place: a fraction of the measured round trip, clamped, and eased so it never makes a unit jump. */
export class Lead {
  ms = 0;
  /** `rttMs` NaN (no ping answered yet) means no lead. Call once per drawn frame with the frame time in seconds. */
  update(rttMs: number, dtSec: number): number {
    const target = Number.isFinite(rttMs) ? Math.min(LEAD_MAX_MS, Math.max(0, LEAD_FRACTION * rttMs)) : 0;
    this.ms += (target - this.ms) * (1 - Math.exp(-dtSec * 2)); // about half a second to settle: a change of 10 ms moves a runner by under 0.1 yd
    return this.ms;
  }
  reset(): void {
    this.ms = 0;
  }
}
