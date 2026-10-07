import type { ArenaDef, MoveInput, TeamId, Vec2 } from './types';

/** Collision radius of a player, in yards. */
export const PLAYER_RADIUS = 0.6;

/** Walking backwards moves at this fraction of run speed. */
export const BACKWARD_SPEED = 0.75;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Facing convention: facing 0 looks toward +z, increasing facing turns toward +x.
 * This matches Three.js rotation.y, so the client can use it directly.
 */
export const dirOf = (facing: number): Vec2 => ({ x: Math.sin(facing), z: Math.cos(facing) });
export const rightOf = (facing: number): Vec2 => ({ x: -Math.cos(facing), z: Math.sin(facing) });

/** Push a position out of walls and pillars. */
export function resolveCollisions(p: Vec2, arena: ArenaDef, level: Level = 0): Vec2 {
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
    ({ x, z } = bridgeCollide(arena, level, x, z));
    x = clamp(x, b.minX + R, b.maxX - R);
    z = clamp(z, b.minZ + R, b.maxZ - R);
  }
  return { x, z };
}

/** 0 = the ground (and the tunnel under a bridge); 1 = a bridge's ramps and deck. */
export type Level = 0 | 1;

/** Where the raised part ends: past this |x| you are back on the ground. */
export const bridgeEnd = (arena: ArenaDef): number => (arena.bridge ? arena.bridge.deckHalf + arena.bridge.rampLen : 0);

/** Under the deck: the tunnel, open at both long sides. */
export function inTunnel(arena: ArenaDef, x: number, z: number): boolean {
  const br = arena.bridge;
  return !!br && Math.abs(x) < br.deckHalf && Math.abs(z) < br.halfWidth;
}

/** Inside the raised corridor (deck and both ramps) as seen from above. */
export function onRaised(arena: ArenaDef, x: number, z: number): boolean {
  const br = arena.bridge;
  return !!br && Math.abs(z) < br.halfWidth && Math.abs(x) < bridgeEnd(arena);
}

/**
 * Which level a unit is on after moving from `from` to `to`: walking in at a ramp's foot climbs it, walking off the foot
 * comes back down. Nothing else changes level (the tunnel and the deck share the same ground plan).
 */
export function nextLevel(arena: ArenaDef, level: Level, from: Vec2, to: Vec2): Level {
  const br = arena.bridge;
  if (!br) return 0;
  const gate = bridgeEnd(arena) + PLAYER_RADIUS; // the ground-level wall of the ramp stands this far out
  if (level === 0 && Math.abs(from.x) >= gate - 1e-6 && Math.abs(to.x) < gate && Math.abs(to.z) < br.halfWidth) return 1;
  if (level === 1 && Math.abs(to.x) >= gate) return 0;
  return level;
}

/** Bridge solids: level 0 cannot enter the ramps, level 1 cannot leave the corridor sideways. */
function bridgeCollide(arena: ArenaDef, level: Level, x: number, z: number): Vec2 {
  const br = arena.bridge;
  if (!br) return { x, z };
  const R = PLAYER_RADIUS;
  const end = bridgeEnd(arena);
  if (level === 1) {
    if (Math.abs(x) < end) z = clamp(z, -(br.halfWidth - R), br.halfWidth - R); // rails
    return { x, z };
  }
  // level 0: each ramp is a solid block
  for (const s of [-1, 1]) {
    const lo = Math.min(s * br.deckHalf, s * end) - R;
    const hi = Math.max(s * br.deckHalf, s * end) + R;
    const zr = br.halfWidth + R;
    if (x > lo && x < hi && z > -zr && z < zr) {
      const dl = x - lo, dr = hi - x, dt = z + zr, db = zr - z;
      const m = Math.min(dl, dr, dt, db);
      if (m === dl) x = lo;
      else if (m === dr) x = hi;
      else if (m === dt) z = -zr;
      else z = zr;
    }
  }
  return { x, z };
}

/** Ground height under a unit at a level, for drawing: the deck and ramps are raised, everything else is flat. */
export function heightAt(arena: ArenaDef, x: number, z: number, level: Level = 1): number {
  const br = arena.bridge;
  if (!br || level === 0 || Math.abs(z) > br.halfWidth) return 0;
  const ax = Math.abs(x);
  if (ax <= br.deckHalf) return br.height;
  if (ax >= bridgeEnd(arena)) return 0;
  return br.height * (1 - (ax - br.deckHalf) / br.rampLen);
}

/** Move to `to` from where you stood: settle the level, then push out of whatever is solid at that level. */
export function moveTo(arena: ArenaDef, level: Level, from: Vec2, to: Vec2): { pos: Vec2; level: Level } {
  const lv = nextLevel(arena, level, from, to);
  return { pos: resolveCollisions(to, arena, lv), level: lv };
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
export function hasLOS(a: Vec2, b: Vec2, arena: ArenaDef, la: Level = 0, lb: Level = 0): boolean {
  for (const pl of arena.pillars) {
    if (distPointToSegment(pl, a, b) < pl.r) return false;
  }
  const br = arena.bridge;
  if (br) {
    // the deck is a ceiling over the tunnel: no sight between the tunnel and the raised part
    if (la !== lb && (la === 0 ? inTunnel(arena, a.x, a.z) : inTunnel(arena, b.x, b.z))) return false;
    // on the ground, the ramps are walls
    if (la === 0 && lb === 0) {
      const end = bridgeEnd(arena);
      for (const s of [-1, 1]) {
        const x0 = Math.min(s * br.deckHalf, s * end), x1 = Math.max(s * br.deckHalf, s * end);
        if (segmentHitsRect(a, b, x0, x1, -br.halfWidth, br.halfWidth)) return false;
      }
    }
  }
  return true;
}

function segmentHitsRect(a: Vec2, b: Vec2, x0: number, x1: number, z0: number, z1: number): boolean {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dz, a.z - z0], [dz, z1 - a.z]] as const) {
    if (Math.abs(p) < 1e-9) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

/** One fixed step of movement. Deterministic, shared by server and client prediction. */
export function stepMovementL(pos: Vec2, level: Level, input: Pick<MoveInput, 'fwd' | 'strafe' | 'facing'>, speed: number, dtSec: number, arena: ArenaDef): { pos: Vec2; level: Level } {
  const f = dirOf(input.facing);
  const r = rightOf(input.facing);
  const fw = input.fwd < 0 ? input.fwd * BACKWARD_SPEED : input.fwd; // backpedalling is slower
  let dx = f.x * fw + r.x * input.strafe;
  let dz = f.z * fw + r.z * input.strafe;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return { pos, level };
  if (len > 1) {
    dx /= len;
    dz /= len;
  }
  return moveTo(arena, level, pos, { x: pos.x + dx * speed * dtSec, z: pos.z + dz * speed * dtSec });
}

/** One step on the ground (level 0). */
export function stepMovement(pos: Vec2, input: Pick<MoveInput, 'fwd' | 'strafe' | 'facing'>, speed: number, dtSec: number, arena: ArenaDef): Vec2 {
  return stepMovementL(pos, 0, input, speed, dtSec, arena).pos;
}

/** Walk forward in small steps and stop before the first obstacle. */
export function blinkDestination(pos: Vec2, facing: number, distance: number, arena: ArenaDef, level: Level = 0): Vec2 {
  const d = dirOf(facing);
  const step = 0.5;
  let last = pos;
  for (let t = step; t <= distance + 1e-6; t += step) {
    const next = { x: pos.x + d.x * t, z: pos.z + d.z * t };
    const fixed = resolveCollisions(next, arena, level);
    if (Math.hypot(fixed.x - next.x, fixed.z - next.z) > 1e-3) break;
    last = next;
  }
  return last;
}

/** During the prep phase each team is held behind its gate. */
export function clampToGate(p: Vec2, team: TeamId, arena: ArenaDef): Vec2 {
  return team === 0 ? { x: Math.min(p.x, -arena.gateX), z: p.z } : { x: Math.max(p.x, arena.gateX), z: p.z };
}
