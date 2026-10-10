import type { ArenaDef, MoveInput, Rect, TeamId, Vec2 } from './types';

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

/** Sight lines between units run at this height above their floor. */
const CHEST = 1.2;
/** How thick a walkway's deck is (its underside is this far below the top). */
export const DECK_THICKNESS = 0.6;
/** A sight line that grazes the last bit of a deck's edge still gets through. */
const LOS_EDGE = 0.15;

/** A unit this high in a jump clears deck rails. */
export const CLEAR_HEIGHT = 0.62;
/** A unit this high in a jump clears a low barricade (you need most of a jump). */
export const LOW_CLEAR = 1.12;
/**
 * How tall a low barricade is: about as tall as a person, so standing on the ground you cannot see (or cast) past it;
 * jump and your sight line rises over it for a moment, long enough for an instant spell.
 */
export const LOW_HEIGHT = 1.6;
/** How much of a jump's height counts for stepping onto a ramp's side (the reach jumps had before they were raised). */
const RAMP_AIR = 0.8;
/** A slope this high you can step onto without jumping. */
export const STEP_HEIGHT = 0.4;
/** How thick a deck rail is (it stands just outside the edge it guards). */
export const RAIL_THICKNESS = 0.4;
/** A unit pressed against a rail sits a hair inside its reach after being pushed out of something else; only deeper than this counts as having landed in it. */
const RAIL_SETTLE = 0.02;

/**
 * Push a position out of walls and pillars, and whatever else is solid at that level: the ramps, piers and low barricades
 * on the ground, the rails up on a walkway. `air` is how high the unit is in a jump: from CLEAR_HEIGHT up it sails over
 * rails, from LOW_CLEAR up over barricades.
 */
export function resolveCollisions(p: Vec2, arena: ArenaDef, level: Level = 0, air = 0, from?: Vec2): Vec2 {
  const b = arena.bounds;
  const R = PLAYER_RADIUS;
  let x = clamp(p.x, b.minX + R, b.maxX - R);
  let z = clamp(p.z, b.minZ + R, b.maxZ - R);
  const clear = air >= CLEAR_HEIGHT;
  const dk = arena.deck;
  const solids: Rect[] = [...(arena.walls ?? [])];
  // rails a unit has come down inside (a jump over them ended short): they ease it out at its own pace instead of shoving it to the
  // nearest face at once, which snapped it back or forward by up to a yard in a single tick
  const inside: Rect[] = [];
  if (dk) {
    if (level !== 1) solids.push(...dk.ramps, ...deckPiers(arena));
    else if (!clear) {
      for (const q of deckRails(arena)) (from && rectDist(from.x, from.z, q) < R - RAIL_SETTLE ? inside : solids).push(q);
    }
  }
  if (level === 0 && air < LOW_CLEAR) {
    for (const r of arena.lows ?? []) {
      // a lava pit takes whoever is in a jump or already in it (they are not pushed out, they burn and cannot walk out: see the end); walking in from outside is still blocked
      if (r.lava && (air > 0 || (from && from.x > r.x0 && from.x < r.x1 && from.z > r.z0 && from.z < r.z1))) continue;
      solids.push(r);
    }
  }
  if (inside.length && from) {
    const step = Math.hypot(x - from.x, z - from.z);
    for (const q of inside) ({ x, z } = pushOutOfBox(x, z, q, R));
    const moved = Math.hypot(x - from.x, z - from.z);
    if (moved > step) { // never faster than it walks: pushed with its stride it just keeps going, pushed across it slides out sideways
      x = from.x + ((x - from.x) * step) / moved;
      z = from.z + ((z - from.z) * step) / moved;
    }
  }
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
    for (const w of solids) ({ x, z } = pushOutOfBox(x, z, w, R));
    x = clamp(x, b.minX + R, b.maxX - R);
    z = clamp(z, b.minZ + R, b.maxZ - R);
  }
  // in a lava pit the rim holds you in: you cannot walk out through it, only jump out (from LOW_CLEAR up you sail over it)
  if (level === 0 && air < LOW_CLEAR && from) {
    const pit = (arena.lows ?? []).find((r) => r.lava && from.x > r.x0 && from.x < r.x1 && from.z > r.z0 && from.z < r.z1);
    if (pit) {
      const m = LAVA_RIM_MARGIN;
      x = clamp(x, pit.x0 + m, pit.x1 - m);
      z = clamp(z, pit.z0 + m, pit.z1 - m);
    }
  }
  return { x, z };
}

/** How far inside a lava pit's rim your centre must stay while you are in it. */
const LAVA_RIM_MARGIN = 0.3;

/** Push a circle of radius R out of an axis-aligned box. */
function pushOutOfBox(x: number, z: number, w: Rect, R: number): Vec2 {
  const cx = clamp(x, w.x0, w.x1);
  const cz = clamp(z, w.z0, w.z1);
  const dx = x - cx;
  const dz = z - cz;
  const d = Math.hypot(dx, dz);
  if (d >= R) return { x, z };
  if (d > 1e-6) return { x: cx + (dx / d) * R, z: cz + (dz / d) * R };
  // the centre is inside the box: leave through the nearest face
  const l = x - w.x0, r = w.x1 - x, t = z - w.z0, bt = w.z1 - z;
  const m = Math.min(l, r, t, bt);
  if (m === l) return { x: w.x0 - R, z };
  if (m === r) return { x: w.x1 + R, z };
  if (m === t) return { x, z: w.z0 - R };
  return { x, z: w.z1 + R };
}

const inBox = (x: number, z: number, r: Rect) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
/** Distance from a point to a box (0 inside). */
export const rectDist = (x: number, z: number, r: Rect): number => Math.hypot(x - clamp(x, r.x0, r.x1), z - clamp(z, r.z0, r.z1));

type Ramp = NonNullable<ArenaDef['deck']>['ramps'][number];

/** A ramp's foot: which axis it runs along, the coordinate of the low end, and +1/-1 for the way out to open ground. */
function footOf(r: Ramp): { axis: 'x' | 'z'; foot: number; out: 1 | -1; len: number } {
  const axis = r.rise[1] as 'x' | 'z';
  const up = r.rise[0] === '+';
  const lo = axis === 'x' ? r.x0 : r.z0;
  const hi = axis === 'x' ? r.x1 : r.z1;
  return { axis, foot: up ? lo : hi, out: up ? -1 : 1, len: hi - lo };
}

/** Height of a ramp's surface over a point (clamped onto the ramp). */
function rampHeight(r: Ramp, x: number, z: number, H: number): number {
  const f = footOf(r);
  const c = f.axis === 'x' ? clamp(x, r.x0, r.x1) : clamp(z, r.z0, r.z1);
  return H * clamp(((c - f.foot) * -f.out) / f.len, 0, 1);
}

/** 0 = the ground (and under a walkway); 1 = up on a walkway's deck or ramps. */
export type Level = 0 | 1;

/** A rail: a thin solid box just outside an open deck edge; `inward` points onto the deck (used to draw it at the right height). */
export type Rail = Rect & { inward: Vec2 };

const railCache = new WeakMap<ArenaDef, Rail[]>();
/**
 * The rails of a walkway: every edge of a flat or ramp that does not join another piece, except a ramp's foot (the way on)
 * and the low part of a ramp's sides (low enough to step on and off), and edges against the arena wall.
 */
export function deckRails(arena: ArenaDef): Rail[] {
  const dk = arena.deck;
  if (!dk) return [];
  let out = railCache.get(arena);
  if (out) return out;
  out = [];
  const T = RAIL_THICKNESS;
  const b = arena.bounds;
  const pieces: { r: Rect; ramp?: Ramp }[] = [...dk.flats.map((r) => ({ r })), ...dk.ramps.map((r) => ({ r, ramp: r }))];
  const overlapsDeck = (q: Rect) => pieces.some((p) => Math.min(q.x1, p.r.x1) - Math.max(q.x0, p.r.x0) > 1e-6 && Math.min(q.z1, p.r.z1) - Math.max(q.z0, p.r.z0) > 1e-6);
  for (const P of pieces) {
    const r = P.r;
    const sides = [
      { fixed: 'x' as const, at: r.x0, dir: -1, lo: r.z0, hi: r.z1 },
      { fixed: 'x' as const, at: r.x1, dir: 1, lo: r.z0, hi: r.z1 },
      { fixed: 'z' as const, at: r.z0, dir: -1, lo: r.x0, hi: r.x1 },
      { fixed: 'z' as const, at: r.z1, dir: 1, lo: r.x0, hi: r.x1 },
    ];
    for (const sd of sides) {
      if (sd.fixed === 'x' ? sd.at <= b.minX + 1e-6 || sd.at >= b.maxX - 1e-6 : sd.at <= b.minZ + 1e-6 || sd.at >= b.maxZ - 1e-6) continue;
      let spans: [number, number][] = [[sd.lo, sd.hi]];
      if (P.ramp) {
        const f = footOf(P.ramp);
        if (sd.fixed === f.axis && Math.abs(sd.at - f.foot) < 1e-6) continue; // the foot is the way on
        if (sd.fixed !== f.axis) {
          // a side: no rail where the slope is still low enough to step over
          const d = (STEP_HEIGHT / dk.height) * f.len;
          spans = spans.map(([a, c]) => (f.out < 0 ? [Math.max(a, f.foot + d), c] : [a, Math.min(c, f.foot - d)]));
        }
      }
      for (const Q of pieces) {
        if (Q === P) continue;
        const q = Q.r;
        const opp = sd.fixed === 'x' ? (sd.dir < 0 ? q.x1 : q.x0) : sd.dir < 0 ? q.z1 : q.z0;
        if (Math.abs(opp - sd.at) > 1e-6) continue;
        const qlo = sd.fixed === 'x' ? q.z0 : q.x0;
        const qhi = sd.fixed === 'x' ? q.z1 : q.x1;
        spans = spans.flatMap(([a, c]): [number, number][] => {
          const s0 = Math.max(a, qlo), s1 = Math.min(c, qhi);
          if (s1 <= s0) return [[a, c]];
          return ([[a, s0], [s1, c]] as [number, number][]).filter(([u, v]) => v - u > 1e-6);
        });
      }
      for (let [a, c] of spans) {
        if (c - a < 0.05) continue;
        const box = (u: number, v: number): Rect => {
          const w0 = sd.dir < 0 ? sd.at - T : sd.at;
          return sd.fixed === 'x' ? { x0: w0, x1: w0 + T, z0: u, z1: v } : { x0: u, x1: v, z0: w0, z1: w0 + T };
        };
        // close the corner where the rail meets the next edge of the same piece (never onto another piece's floor)
        if (Math.abs(a - sd.lo) < 1e-6 && !overlapsDeck(box(a - T, a))) a -= T;
        if (Math.abs(c - sd.hi) < 1e-6 && !overlapsDeck(box(c, c + T))) c += T;
        const inward = sd.fixed === 'x' ? { x: -sd.dir, z: 0 } : { x: 0, z: -sd.dir };
        out.push({ ...box(a, c), inward });
      }
    }
  }
  railCache.set(arena, out);
  return out;
}

const pierCache = new WeakMap<ArenaDef, Rect[]>();
/** The stone piers under a walkway's flat pieces: as listed, else a pair at each end of every flat and every ~12 yards between. */
export function deckPiers(arena: ArenaDef): Rect[] {
  const dk = arena.deck;
  if (!dk) return [];
  if (dk.piers) return dk.piers;
  let out = pierCache.get(arena);
  if (out) return out;
  out = [];
  const S = 1.2;
  const b = arena.bounds;
  for (const f of dk.flats) {
    const alongX = f.x1 - f.x0 >= f.z1 - f.z0;
    const lo = alongX ? f.x0 : f.z0, hi = alongX ? f.x1 : f.z1;
    const n = Math.max(2, Math.ceil((hi - lo) / 12) + 1);
    for (let i = 0; i < n; i++) {
      const c = lo + S / 2 + ((hi - lo - S) * i) / (n - 1);
      for (const side of [0, 1]) {
        const r: Rect = alongX
          ? { x0: c - S / 2, x1: c + S / 2, z0: side ? f.z1 - S : f.z0, z1: side ? f.z1 : f.z0 + S }
          : { x0: side ? f.x1 - S : f.x0, x1: side ? f.x1 : f.x0 + S, z0: c - S / 2, z1: c + S / 2 };
        if (r.x0 <= b.minX + 1e-6 || r.x1 >= b.maxX - 1e-6 || r.z0 <= b.minZ + 1e-6 || r.z1 >= b.maxZ - 1e-6) continue; // against the wall: not needed
        out.push(r);
      }
    }
  }
  pierCache.set(arena, out);
  return out;
}

/** Inside a walkway piece (deck or ramp) as seen from above. */
export function onRaised(arena: ArenaDef, x: number, z: number): boolean {
  const dk = arena.deck;
  return !!dk && (dk.flats.some((f) => inBox(x, z, f)) || dk.ramps.some((r) => inBox(x, z, r)));
}

/** How far a point is from the nearest walkway piece (Infinity without a walkway). */
function deckDistance(arena: ArenaDef, p: Vec2): number {
  const dk = arena.deck;
  if (!dk) return Infinity;
  let d = Infinity;
  for (const r of [...dk.flats, ...dk.ramps]) d = Math.min(d, rectDist(p.x, p.z, r));
  return d;
}

/** Ground height under a unit at a level, for drawing: the deck and ramps are raised, everything else is flat. */
export function heightAt(arena: ArenaDef, x: number, z: number, level: Level = 1): number {
  const dk = arena.deck;
  if (!dk || level === 0) return 0;
  let best = Infinity;
  let h = 0;
  for (const f of dk.flats) {
    const d = rectDist(x, z, f);
    if (d < best) { best = d; h = dk.height; }
  }
  for (const r of dk.ramps) {
    const d = rectDist(x, z, r);
    if (d < best - 1e-9) { best = d; h = rampHeight(r, x, z, dk.height); }
  }
  return best <= PLAYER_RADIUS + 0.05 ? h : 0; // just past an edge (a jump off, the foot of a ramp) you are still drawn on it
}

/**
 * Move to `to` from where you stood. On the ground, touching a ramp where its surface is low enough (a step, or a jump's
 * height plus a step) puts you on it. Up top, the rails hold you unless you are high enough in a jump to clear them; once
 * you are a body's width clear of the walkway you are on the ground again (walked off a ramp's foot or jumped off).
 */
export function moveTo(arena: ArenaDef, level: Level, from: Vec2, to: Vec2, air = 0): { pos: Vec2; level: Level } {
  const dk = arena.deck;
  if (!dk) return { pos: resolveCollisions(to, arena, 0, air, from), level: 0 };
  let lv = level;
  if (lv === 0) {
    for (const r of dk.ramps) {
      if (rectDist(to.x, to.z, r) < PLAYER_RADIUS - 1e-6 && rampHeight(r, to.x, to.z, dk.height) <= air * RAMP_AIR + STEP_HEIGHT) {
        lv = 1;
        break;
      }
    }
  }
  let pos = resolveCollisions(to, arena, lv, air, from);
  if (lv === 1 && deckDistance(arena, pos) >= PLAYER_RADIUS) {
    lv = 0;
    pos = resolveCollisions(pos, arena, 0, air, from);
  }
  return { pos, level: lv };
}

/** Is this spot inside a lava pit (on the ground; whoever stands there burns)? */
export function inLava(arena: ArenaDef, p: Vec2): boolean {
  return (arena.lows ?? []).some((r) => r.lava && p.x > r.x0 && p.x < r.x1 && p.z > r.z0 && p.z < r.z1);
}

export const angleTo = (a: Vec2, b: Vec2): number => Math.atan2(b.x - a.x, b.z - a.z);

export function distPointToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const len2 = abx * abx + abz * abz;
  const t = len2 === 0 ? 0 : clamp(((p.x - a.x) * abx + (p.z - a.z) * abz) / len2, 0, 1);
  return Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
}

/**
 * Line of sight between two points (units' feet), chest to chest. `ha` and `hb` are how high each is in a jump: a low
 * barricade blocks the line where it passes the barricade lower than its top, so two people on the ground cannot see
 * past one, and a jump lifts the line over it. Pillars and walls always block it; on the ground so do ramps and piers;
 * across levels the deck overhead does.
 */
function rayLOS(a: Vec2, b: Vec2, arena: ArenaDef, la: Level, lb: Level, ha: number, hb: number): boolean {
  for (const pl of arena.pillars) {
    if (distPointToSegment(pl, a, b) < pl.r) return false;
  }
  for (const w of arena.walls ?? []) if (segmentHitsRect(a, b, w.x0, w.x1, w.z0, w.z1)) return false;
  const ya = heightAt(arena, a.x, a.z, la) + CHEST + ha, yb = heightAt(arena, b.x, b.z, lb) + CHEST + hb;
  for (const lw of arena.lows ?? []) {
    const span = segmentRectSpan(a, b, lw.x0, lw.x1, lw.z0, lw.z1);
    // the line is straight, so it is lowest over the barricade at one of the two edges it crosses; a unit over the
    // barricade itself (mid-jump across it) is not hidden by it
    if (span && span[0] > 0 && span[1] < 1 && Math.min(ya + (yb - ya) * span[0], ya + (yb - ya) * span[1]) < LOW_HEIGHT) return false;
  }
  const dk = arena.deck;
  if (dk) {
    // the deck is a floor between levels: sight runs chest to chest, and it is blocked where that line passes through a
    // flat piece (its top or its underside), so someone above you is hidden unless you see them past the edge
    for (const plane of [dk.height, dk.height - DECK_THICKNESS]) {
      if ((ya - plane) * (yb - plane) >= 0) continue; // both on one side of it
      const t = (plane - ya) / (yb - ya);
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      if (dk.flats.some((f) => x > f.x0 + LOS_EDGE && x < f.x1 - LOS_EDGE && z > f.z0 + LOS_EDGE && z < f.z1 - LOS_EDGE)) return false;
    }
    if (la === 0 && lb === 0) {
      for (const r of [...dk.ramps, ...deckPiers(arena)]) if (segmentHitsRect(a, b, r.x0, r.x1, r.z0, r.z1)) return false; // on the ground, the ramps and piers are walls
    } else {
      // someone up on a ramp (or the deck) and someone on the far side of a ramp: the ramp is a solid wedge, so the line is
      // blocked wherever it passes below the ramp's surface (sampled along the part of the line over the ramp)
      for (const r of dk.ramps) {
        const span = segmentRectSpan(a, b, r.x0, r.x1, r.z0, r.z1);
        if (!span) continue;
        const [t0, t1] = span;
        const n = Math.max(4, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) * (t1 - t0) * 2));
        for (let i = 1; i < n; i++) {
          const t = t0 + ((t1 - t0) * i) / n;
          const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
          if (ya + (yb - ya) * t < rampHeight(r, x, z, dk.height) - 0.05) return false;
        }
      }
    }
  }
  return true;
}

/** Half the width of the body that sees and is seen: the sight line may slide this far to either side to get past an edge. */
export const LOS_PEEK = 0.35;

/**
 * Line of sight between two points, as a body sees it rather than a single thread: if the centre line is blocked, the
 * line may slide up to LOS_PEEK to either side (from either end), so a unit whose edge shows past a pillar or a wall end
 * is seen and can be targeted, as the picture shows. A pillar, wall or barricade still blocks whatever stands fully behind it.
 */
export function hasLOS(a: Vec2, b: Vec2, arena: ArenaDef, la: Level = 0, lb: Level = 0, ha = 0, hb = 0): boolean {
  if (rayLOS(a, b, arena, la, lb, ha, hb)) return true;
  const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
  if (d < 1e-6) return false;
  const px = (-dz / d) * LOS_PEEK, pz = (dx / d) * LOS_PEEK;
  for (const s of [-1, 1]) {
    const o = { x: px * s, z: pz * s };
    const a2 = { x: a.x + o.x, z: a.z + o.z }, b2 = { x: b.x + o.x, z: b.z + o.z };
    if (rayLOS(a2, b2, arena, la, lb, ha, hb) || rayLOS(a, b2, arena, la, lb, ha, hb) || rayLOS(a2, b, arena, la, lb, ha, hb)) return true;
  }
  return false;
}

function segmentHitsRect(a: Vec2, b: Vec2, x0: number, x1: number, z0: number, z1: number): boolean {
  return segmentRectSpan(a, b, x0, x1, z0, z1) !== null;
}

/** The part of segment a→b inside a rectangle, as fractions [enter, leave] along it, or null when it misses. */
function segmentRectSpan(a: Vec2, b: Vec2, x0: number, x1: number, z0: number, z1: number): [number, number] | null {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dz, a.z - z0], [dz, z1 - a.z]] as const) {
    if (Math.abs(p) < 1e-9) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [t0, t1];
}

/** One fixed step of movement. Deterministic, shared by server and client prediction. */
export function stepMovementL(pos: Vec2, level: Level, input: Pick<MoveInput, 'fwd' | 'strafe' | 'facing'>, speed: number, dtSec: number, arena: ArenaDef, air = 0): { pos: Vec2; level: Level } {
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
  return moveTo(arena, level, pos, { x: pos.x + dx * speed * dtSec, z: pos.z + dz * speed * dtSec }, air);
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

// ------------------------------------------------------------------ walking routes around walls (bots)

const NAV_MARGIN = PLAYER_RADIUS + 0.35;
/** Can a unit walk the straight line between two points without touching a wall? */
export function walkClear(a: Vec2, b: Vec2, arena: ArenaDef): boolean {
  for (const w of arena.walls ?? []) if (segmentHitsRect(a, b, w.x0 - NAV_MARGIN, w.x1 + NAV_MARGIN, w.z0 - NAV_MARGIN, w.z1 + NAV_MARGIN)) return false;
  return true;
}

const navLinks = new WeakMap<ArenaDef, number[][]>();
function linksOf(arena: ArenaDef): number[][] {
  let l = navLinks.get(arena);
  if (!l) {
    const nav = arena.nav ?? [];
    l = nav.map((p, i) => nav.flatMap((q, j) => (i !== j && walkClear(p, q, arena) ? [j] : [])));
    navLinks.set(arena, l);
  }
  return l;
}

/**
 * The next point to head for to get from `from` to `to` around the arena's walls, or null when the straight line is
 * clear (or the arena has no walls or route points). Shortest route over the waypoint graph.
 */
export function navStep(from: Vec2, to: Vec2, arena: ArenaDef): Vec2 | null {
  const nav = arena.nav;
  if (!arena.walls?.length || !nav?.length || walkClear(from, to, arena)) return null;
  const links = linksOf(arena);
  const dst = nav.map(() => Infinity);
  const prev = nav.map(() => -1);
  const done = nav.map(() => false);
  nav.forEach((p, i) => {
    if (walkClear(from, p, arena)) dst[i] = dist(from, p);
  });
  let best = -1;
  let bestCost = Infinity;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nav.length; i++) if (!done[i] && dst[i] < Infinity && (u < 0 || dst[i] < dst[u])) u = i;
    if (u < 0) break;
    done[u] = true;
    if (walkClear(nav[u], to, arena)) {
      const cost = dst[u] + dist(nav[u], to);
      if (cost < bestCost) {
        bestCost = cost;
        best = u;
      }
    }
    for (const v of links[u]) {
      const nd = dst[u] + dist(nav[u], nav[v]);
      if (nd < dst[v]) {
        dst[v] = nd;
        prev[v] = u;
      }
    }
  }
  if (best < 0) return null;
  let at = best;
  while (prev[at] >= 0) at = prev[at];
  return nav[at];
}
