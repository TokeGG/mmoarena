/**
 * Touch support for watching on a phone: the camera gestures (one finger orbits, two fingers pinch to zoom, a tap picks a
 * unit, a double tap goes to the next one) and the "light mode" decision. Everything here is pure (no DOM, no clock of its own)
 * so it can be tested; `input.ts` feeds it pointer events.
 */
import { CAM_MAX, CAM_MIN } from './camera';

/** A finger that stays within this many pixels and lifts within `TAP_MS` made a tap, not a drag. */
export const TAP_SLOP = 10;
export const TAP_MS = 350;
/** Two taps this close in time and place are a double tap. */
export const DOUBLE_TAP_MS = 320;
export const DOUBLE_TAP_DIST = 40;
/** Radians of camera turn per pixel of drag (the mouse uses 0.005; a thumb covers less of the screen, so a little more). */
export const ORBIT_PER_PX = 0.006;
export const PITCH_MIN = -0.15;
export const PITCH_MAX = 1.35;

export type Gesture =
  | { kind: 'orbit'; dx: number; dy: number }
  | { kind: 'pinch'; scale: number; cx: number; cy: number }
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'doubletap'; x: number; y: number };

interface Finger {
  x: number;
  y: number;
  downX: number;
  downY: number;
  downAt: number;
  travel: number;
}

/**
 * Follows the fingers on the screen and says what they did. Feed it `down`, `move`, `up` and `cancel` with a pointer id,
 * the position and the time in ms; each returns the gestures that call produced.
 */
export class TouchGestures {
  private fingers = new Map<number, Finger>();
  private lastTap: { x: number; y: number; at: number } | null = null;
  /** The span between two fingers when the pinch began (or last reset). */
  private span = 0;
  /** Set once a second finger touched: the gesture can no longer end in a tap. */
  private multi = false;

  get count(): number {
    return this.fingers.size;
  }

  down(id: number, x: number, y: number, t: number): Gesture[] {
    if (this.fingers.size === 0) this.multi = false;
    this.fingers.set(id, { x, y, downX: x, downY: y, downAt: t, travel: 0 });
    if (this.fingers.size >= 2) {
      this.multi = true;
      this.span = this.currentSpan();
    }
    return [];
  }

  move(id: number, x: number, y: number, _t: number): Gesture[] {
    const f = this.fingers.get(id);
    if (!f) return [];
    const dx = x - f.x;
    const dy = y - f.y;
    f.x = x;
    f.y = y;
    f.travel += Math.abs(dx) + Math.abs(dy);
    if (this.fingers.size === 1) {
      // a finger that has not yet left its slop is still a possible tap: no orbit until it has
      if (Math.hypot(x - f.downX, y - f.downY) <= TAP_SLOP && f.travel <= TAP_SLOP * 2) return [];
      return [{ kind: 'orbit', dx, dy }];
    }
    if (this.fingers.size === 2) {
      const span = this.currentSpan();
      const prev = this.span;
      this.span = span;
      if (prev < 1 || span < 1) return [];
      const [a, b] = [...this.fingers.values()];
      return [{ kind: 'pinch', scale: span / prev, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }];
    }
    return [];
  }

  up(id: number, t: number): Gesture[] {
    const f = this.fingers.get(id);
    if (!f) return [];
    this.fingers.delete(id);
    if (this.fingers.size >= 2) this.span = this.currentSpan();
    if (this.fingers.size > 0 || this.multi) return [];
    if (t - f.downAt > TAP_MS || Math.hypot(f.x - f.downX, f.y - f.downY) > TAP_SLOP || f.travel > TAP_SLOP * 2) return [];
    const last = this.lastTap;
    if (last && t - last.at <= DOUBLE_TAP_MS && Math.hypot(f.x - last.x, f.y - last.y) <= DOUBLE_TAP_DIST) {
      this.lastTap = null;
      return [{ kind: 'doubletap', x: f.x, y: f.y }];
    }
    this.lastTap = { x: f.x, y: f.y, at: t };
    return [{ kind: 'tap', x: f.x, y: f.y }];
  }

  cancel(id: number): void {
    this.fingers.delete(id);
    if (this.fingers.size === 0) this.multi = false;
    else if (this.fingers.size >= 2) this.span = this.currentSpan();
  }

  reset(): void {
    this.fingers.clear();
    this.lastTap = null;
    this.multi = false;
  }

  private currentSpan(): number {
    const [a, b] = [...this.fingers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
}

/** The camera angles after dragging a finger by (dx, dy) pixels. Dragging right turns the view like the mouse does. */
export function orbitBy(yaw: number, pitch: number, dx: number, dy: number, sens = 1): { yaw: number; pitch: number } {
  return { yaw: yaw - dx * ORBIT_PER_PX * sens, pitch: Math.min(PITCH_MAX, Math.max(PITCH_MIN, pitch + dy * ORBIT_PER_PX * sens)) };
}

/** The camera distance after a pinch: fingers moving apart (scale above 1) bring the camera closer. Stays within the third-person range. */
export function pinchZoom(dist: number, scale: number): number {
  if (!(scale > 0) || !Number.isFinite(scale)) return dist;
  return Math.min(CAM_MAX, Math.max(CAM_MIN, (dist > 0 ? dist : CAM_MIN) / scale));
}

// ------------------------------------------------------------------ light mode

export interface LightEnv {
  /** The primary pointer is a finger (`(pointer: coarse)`). */
  coarse: boolean;
  /** The shorter side of the screen in CSS pixels. */
  screenMin: number;
  /** `navigator.deviceMemory` in GB where the browser says (Chrome only). */
  memoryGb?: number;
  /** The person's saved choice: '1' on, '0' off, anything else means automatic. */
  saved?: string | null;
}

/** Small screens and finger-driven devices start in light mode; a saved choice always wins. */
export function lightModeDefault(env: LightEnv): boolean {
  if (env.saved === '1') return true;
  if (env.saved === '0') return false;
  if (env.coarse) return true;
  if (env.screenMin > 0 && env.screenMin <= 600) return true;
  return env.memoryGb !== undefined && env.memoryGb > 0 && env.memoryGb <= 2;
}

/** How many device pixels per CSS pixel to render at: light mode caps it lower so a 3x phone screen does not draw nine times the pixels. */
export function pixelRatioCap(light: boolean): number {
  return light ? 1.5 : 2;
}

export function pixelRatioFor(dpr: number, light: boolean): number {
  return Math.max(1, Math.min(dpr || 1, pixelRatioCap(light)));
}
