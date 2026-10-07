import type { ArenaDef, MoveInput, TeamId, Vec2 } from './types';

/** Collision radius of a player, in yards. */
export const PLAYER_RADIUS = 0.6;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Facing convention: facing 0 looks toward +z, increasing facing turns toward +x.
 * This matches Three.js rotation.y, so the client can use it directly.
 */
export const dirOf = (facing: number): Vec2 => ({ x: Math.sin(facing), z: Math.cos(facing) });
export const rightOf = (facing: number): Vec2 => ({ x: -Math.cos(facing), z: Math.sin(facing) });

/** Push a position out of walls and pillars. */
export function resolveCollisions(p: Vec2, arena: ArenaDef): Vec2 {
  const b = arena.bounds;
  const R = PLAYER_RADIUS;
  let x = clamp(p.x, b.minX + R, b.maxX - R);
  let z = clamp(p.z, b.minZ + R, b.maxZ - R);
  for (let i = 0; i < 2; i++) {
    for (const pl of arena.pillars) {
      const dx = x - pl.x;
      const dz = z - pl.z;
      const d = Math.hypot(dx, dz);
      const min = pl.r + R;
      if (d < min) {
        if (d < 1e-6) {
          x = pl.x + min;
        } else {
          x = pl.x + (dx / d) * min;
          z = pl.z + (dz / d) * min;
        }
      }
    }
    for (const v of arena.voids ?? []) {
      if (x > v.minX - R && x < v.maxX + R && z > v.minZ - R && z < v.maxZ + R) {
        // leave through the nearest side
        const l = x - (v.minX - R), r = v.maxX + R - x, t = z - (v.minZ - R), bt = v.maxZ + R - z;
        const m = Math.min(l, r, t, bt);
        if (m === l) x = v.minX - R;
        else if (m === r) x = v.maxX + R;
        else if (m === t) z = v.minZ - R;
        else z = v.maxZ + R;
      }
    }
    x = clamp(x, b.minX + R, b.maxX - R);
    z = clamp(z, b.minZ + R, b.maxZ - R);
  }
  return { x, z };
}

/** Ground height at a point: 0 everywhere except on a bridge's ramps and deck. Used for drawing; the sim itself is flat. */
export function heightAt(arena: ArenaDef, x: number, z: number): number {
  const br = arena.bridge;
  if (!br || Math.abs(z) > br.halfWidth) return 0;
  const ax = Math.abs(x);
  if (ax <= br.deckHalf) return br.height;
  if (ax >= br.deckHalf + br.rampLen) return 0;
  return br.height * (1 - (ax - br.deckHalf) / br.rampLen);
}

export const angleTo = (a: Vec2, b: Vec2): number => Math.atan2(b.x - a.x, b.z - a.z);

export function distPointToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const len2 = abx * abx + abz * abz;
  const t = len2 === 0 ? 0 : clamp(((p.x - a.x) * abx + (p.z - a.z) * abz) / len2, 0, 1);
  return Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
}

/** Line of sight is blocked when the segment passes through a pillar. */
export function hasLOS(a: Vec2, b: Vec2, arena: ArenaDef): boolean {
  for (const pl of arena.pillars) {
    if (distPointToSegment(pl, a, b) < pl.r) return false;
  }
  return true;
}

/** One fixed step of movement. Deterministic, shared by server and client prediction. */
export function stepMovement(pos: Vec2, input: Pick<MoveInput, 'fwd' | 'strafe' | 'facing'>, speed: number, dtSec: number, arena: ArenaDef): Vec2 {
  const f = dirOf(input.facing);
  const r = rightOf(input.facing);
  let dx = f.x * input.fwd + r.x * input.strafe;
  let dz = f.z * input.fwd + r.z * input.strafe;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return pos;
  if (len > 1) {
    dx /= len;
    dz /= len;
  }
  return resolveCollisions({ x: pos.x + dx * speed * dtSec, z: pos.z + dz * speed * dtSec }, arena);
}

/** Walk forward in small steps and stop before the first obstacle. */
export function blinkDestination(pos: Vec2, facing: number, distance: number, arena: ArenaDef): Vec2 {
  const d = dirOf(facing);
  const step = 0.5;
  let last = pos;
  for (let t = step; t <= distance + 1e-6; t += step) {
    const next = { x: pos.x + d.x * t, z: pos.z + d.z * t };
    const fixed = resolveCollisions(next, arena);
    if (Math.hypot(fixed.x - next.x, fixed.z - next.z) > 1e-3) break;
    last = next;
  }
  return last;
}

/** During the prep phase each team is held behind its gate. */
export function clampToGate(p: Vec2, team: TeamId, arena: ArenaDef): Vec2 {
  return team === 0 ? { x: Math.min(p.x, -arena.gateX), z: p.z } : { x: Math.max(p.x, arena.gateX), z: p.z };
}
