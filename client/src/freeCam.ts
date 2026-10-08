/**
 * Free camera for dead players and spectators: pure state and maths (no DOM, no three.js), so it can be tested.
 * Yaw is the compass heading the camera looks along (0 = +z, as the orbit camera); pitch is the angle LOOKING DOWN
 * (positive = down, the same sign as the orbit camera's pitch, so mouse look feels the same in both).
 */

/** How far outside the arena walls the camera may go (yards), so you can look in from outside. */
export const FREE_MARGIN = 6;
/** Lowest the camera may sit above the ground under it, and the highest above the floor (yards). */
export const FREE_MIN_H = 0.6;
export const FREE_MAX_H = 40;
/** Look-down limit (radians), a little short of straight up or down so the view never flips. */
export const FREE_PITCH = 1.45;
/** Fly speed in yards per second at 1x, and the multipliers of the modifier keys. */
export const FREE_SPEED = 14;
export const FAST_MULT = 3;
export const SLOW_MULT = 0.3;
/** How quickly the velocity follows the keys (1/s): about a third of a second to get up to speed. */
export const FREE_ACCEL = 9;
/** The wheel scales the fly speed by this per notch, between these limits. */
export const WHEEL_MIN = 0.2;
export const WHEEL_MAX = 5;
/** The settings slider (fly speed) range. */
export const SPEED_SETTING_MIN = 0.5;
export const SPEED_SETTING_MAX = 3;

export interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }
export interface Pose { x: number; y: number; z: number; yaw: number; pitch: number }
export interface FreeInput {
  /** Along the view (including its pitch), -1 back to 1 forward. */
  forward: number;
  /** Sideways relative to the view, -1 left to 1 right. */
  right: number;
  /** World up, -1 down to 1 up. */
  up: number;
  fast: boolean;
  slow: boolean;
}

export const NO_INPUT: FreeInput = { forward: 0, right: 0, up: 0, fast: false, slow: false };

/**
 * Who gets the free camera. Spectators always (their feed is delayed anyway). A dead player only outside ranked matches:
 * in ranked it would let the dead scout the enemy and call positions to living teammates.
 */
export function canFreeCam(s: { dead: boolean; spectating: boolean; ranked: boolean }): boolean {
  if (s.spectating) return true;
  return s.dead && !s.ranked;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrapAngle = (a: number) => {
  if (a >= -Math.PI && a <= Math.PI) return a;
  const t = (a + Math.PI) % (Math.PI * 2);
  return (t < 0 ? t + Math.PI * 2 : t) - Math.PI;
};

/** Wheel notch to a new speed factor (scroll up = faster). */
export function wheelSpeed(factor: number, deltaY: number): number {
  return clamp(factor * Math.exp(-deltaY * 0.001), WHEEL_MIN, WHEEL_MAX);
}

/** The fly-speed setting from storage text, clamped (bad values: 1x). */
export function speedSetting(raw: string | null | undefined): number {
  const v = Number(raw);
  return raw != null && raw !== '' && Number.isFinite(v) ? clamp(v, SPEED_SETTING_MIN, SPEED_SETTING_MAX) : 1;
}

/** The unit vector the camera looks along. */
export function lookDir(yaw: number, pitch: number): { x: number; y: number; z: number } {
  const h = Math.cos(pitch);
  return { x: Math.sin(yaw) * h, y: -Math.sin(pitch), z: Math.cos(yaw) * h };
}

/** Put a position inside the arena walls plus the margin, above the ground and below the ceiling. */
export function clampPos(p: { x: number; y: number; z: number }, bounds: Bounds, groundAt: (x: number, z: number) => number): { x: number; y: number; z: number } {
  const x = clamp(p.x, bounds.minX - FREE_MARGIN, bounds.maxX + FREE_MARGIN);
  const z = clamp(p.z, bounds.minZ - FREE_MARGIN, bounds.maxZ + FREE_MARGIN);
  const lo = groundAt(x, z) + FREE_MIN_H;
  return { x, y: clamp(p.y, lo, Math.max(lo, FREE_MAX_H)), z };
}

export class FreeCam {
  active = false;
  pose: Pose = { x: 0, y: 5, z: 0, yaw: 0, pitch: 0.5 };
  /** Wheel factor on top of the setting. */
  wheel = 1;
  /** The settings slider (0.5 to 3). */
  setting = 1;
  private vx = 0;
  private vy = 0;
  private vz = 0;

  /** Start flying from where the camera is now (no jump); the position is only moved if it is outside the allowed space. */
  enter(from: Pose, bounds: Bounds, groundAt: (x: number, z: number) => number): void {
    const p = clampPos(from, bounds, groundAt);
    this.pose = { ...p, yaw: wrapAngle(from.yaw), pitch: clamp(from.pitch, -FREE_PITCH, FREE_PITCH) };
    this.vx = this.vy = this.vz = 0;
    this.active = true;
  }

  exit(): void {
    this.active = false;
    this.vx = this.vy = this.vz = 0;
  }

  /** Mouse look (absolute angles, as the Controls hold them). */
  look(yaw: number, pitch: number): void {
    this.pose.yaw = wrapAngle(yaw);
    this.pose.pitch = clamp(pitch, -FREE_PITCH, FREE_PITCH);
  }

  /** Current fly speed in yards per second with no modifier key held. */
  get speed(): number {
    return FREE_SPEED * this.setting * this.wheel;
  }

  /** Advance dt seconds: velocity eases towards the keys' target (exact integration, so the distance does not depend on the frame rate). */
  update(dt: number, input: FreeInput, bounds: Bounds, groundAt: (x: number, z: number) => number): Pose {
    if (!this.active || !(dt > 0)) return this.pose;
    const { yaw, pitch } = this.pose;
    const f = lookDir(yaw, pitch);
    const r = { x: -Math.cos(yaw), z: Math.sin(yaw) };
    let tx = f.x * input.forward + r.x * input.right;
    let ty = f.y * input.forward + input.up;
    let tz = f.z * input.forward + r.z * input.right;
    const len = Math.hypot(tx, ty, tz);
    const mult = this.speed * (input.fast ? FAST_MULT : 1) * (input.slow ? SLOW_MULT : 1);
    if (len > 1e-6) {
      const k = (len > 1 ? 1 / len : 1) * mult; // diagonals are no faster
      tx *= k;
      ty *= k;
      tz *= k;
    } else tx = ty = tz = 0;
    // v(t) = T + (v0 - T) e^(-kt): the displacement over dt has a closed form
    const e = Math.exp(-FREE_ACCEL * dt);
    const ease = (1 - e) / FREE_ACCEL;
    const move = (v0: number, t: number) => t * dt + (v0 - t) * ease;
    const next = clampPos({ x: this.pose.x + move(this.vx, tx), y: this.pose.y + move(this.vy, ty), z: this.pose.z + move(this.vz, tz) }, bounds, groundAt);
    this.vx = tx + (this.vx - tx) * e;
    this.vy = ty + (this.vy - ty) * e;
    this.vz = tz + (this.vz - tz) * e;
    // pressing on a limit (the wall, the floor) does not store up speed
    if (next.x <= bounds.minX - FREE_MARGIN || next.x >= bounds.maxX + FREE_MARGIN) this.vx = 0;
    if (next.z <= bounds.minZ - FREE_MARGIN || next.z >= bounds.maxZ + FREE_MARGIN) this.vz = 0;
    if (next.y <= groundAt(next.x, next.z) + FREE_MIN_H + 1e-9 || next.y >= FREE_MAX_H) this.vy = 0;
    this.pose.x = next.x;
    this.pose.y = next.y;
    this.pose.z = next.z;
    return this.pose;
  }

  /** The on-screen hint while flying. */
  hint(): string {
    return `Free cam: ${(this.setting * this.wheel).toFixed(this.setting * this.wheel < 10 ? 1 : 0)}× speed (wheel) · WASD fly · Space / C up, down · Shift fast · Alt / Z slow`;
  }
}
