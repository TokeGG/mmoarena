import * as THREE from 'three';
import type { ArenaDef, Rect } from '@arena/shared';
import { coverStyle } from './arenaMap';
import { COVER_MAX, COVER_PROUD, DEBRIS_MAX, lowParts, lowTopParts, partMatrix, pillarParts, wallParts } from './cover';
import type { CoverPart } from './cover';

/**
 * Cover audit: how wide is each drawn piece at the heights a player sees and stands at, against the shape the sim blocks
 * with (a circle per pillar, a box per wall or low barricade). Pure geometry (no renderer): the same part builders the
 * scenery uses (cover.ts), sliced with a horizontal plane. Used by scripts/audit-cover.ts and client/test/cover.test.ts.
 */
export const AUDIT_HEIGHTS = [0.1, 0.5, 1.0, 1.4, 2.0, 2.5];
/** Pillars may be this much thinner than the circle (a faceted shaft) and `COVER_PROUD` wider. */
export const MAX_UNDER = 0.1;
/** Walls and lows: the drawn faces are within this of the rect (either way). */
export const RECT_TOL = 0.1;

export type Seg = [number, number, number, number]; // x0 z0 x1 z1

/** The outline of the parts at height y: every mesh triangle cut by the plane gives one segment. */
export function sectionAt(parts: CoverPart[], y: number): Seg[] {
  y += 1e-4; // not exactly on a ring of vertices
  const segs: Seg[] = [];
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (const part of parts) {
    const geo = part.geo.index ? part.geo.toNonIndexed() : part.geo;
    const pos = geo.attributes.position;
    const m = partMatrix(part);
    for (let t = 0; t + 2 < pos.count; t += 3) {
      for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(pos, t + k).applyMatrix4(m);
      const hit: [number, number][] = [];
      for (let e = 0; e < 3; e++) {
        const a = v[e], b = v[(e + 1) % 3];
        if ((a.y - y) * (b.y - y) < 0) {
          const s = (y - a.y) / (b.y - a.y);
          hit.push([a.x + (b.x - a.x) * s, a.z + (b.z - a.z) * s]);
        }
      }
      if (hit.length === 2) segs.push([hit[0][0], hit[0][1], hit[1][0], hit[1][1]]);
    }
  }
  return segs;
}

/** How far the drawn outline reaches from (cx, cz) in each of n directions (the farthest crossing); 0 where nothing is drawn. */
export function radialReach(segs: Seg[], cx: number, cz: number, n = 180): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
    let best = 0;
    for (const [x0, z0, x1, z1] of segs) {
      const ex = x1 - x0, ez = z1 - z0, den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-12) continue;
      const qx = x0 - cx, qz = z0 - cz;
      const t = (qx * ez - qz * ex) / den, u = (qx * dz - qz * dx) / den;
      if (t > 0 && u >= -1e-9 && u <= 1 + 1e-9 && t > best) best = t;
    }
    out.push(best);
  }
  return out;
}

export interface PillarRow { arena: string; index: number; r: number; kind: string; y: number; outer: number; inner: number; over: number; under: number }
export interface RectRow { arena: string; what: 'wall' | 'low'; index: number; y: number; over: number; under: number }

/** Drawn pillar width at one height: outer and inner radius (the shaft is closed, so inner is the least reach in any direction). */
export function pillarRow(arena: ArenaDef, index: number, y: number, parts = pillarPartsOf(arena, index)): PillarRow {
  const p = arena.pillars[index];
  const reach = radialReach(sectionAt(parts.filter((q) => q.role === 'body'), y), p.x, p.z);
  const outer = Math.max(...reach), inner = Math.min(...reach);
  return { arena: arena.id, index, r: p.r, kind: coverStyle(arena.theme).pillar, y, outer, inner, over: outer - p.r, under: p.r - inner };
}

export const pillarPartsOf = (arena: ArenaDef, index: number): CoverPart[] => pillarParts(coverStyle(arena.theme).pillar, { p: arena.pillars[index], i: index });
export const wallPartsOf = (arena: ArenaDef, index: number): CoverPart[] => wallParts(coverStyle(arena.theme).wall, arena.walls![index], index);
export const lowPartsOf = (arena: ArenaDef, index: number): CoverPart[] => [...lowParts(coverStyle(arena.theme).low, arena.lows![index], index), ...lowTopParts(coverStyle(arena.theme).low, arena.lows![index], index)];

/** Signed overshoot of the drawn outline past a rect: positive = wider than the shape, negative = narrower (worst of the four sides). */
export function rectRow(arena: ArenaDef, what: 'wall' | 'low', index: number, y: number): RectRow | null {
  const r: Rect = what === 'wall' ? arena.walls![index] : arena.lows![index];
  const parts = (what === 'wall' ? wallPartsOf(arena, index) : lowPartsOf(arena, index)).filter((q) => q.role === 'body');
  const segs = sectionAt(parts, y);
  if (!segs.length) return null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [a, b, c, d] of segs) {
    x0 = Math.min(x0, a, c); x1 = Math.max(x1, a, c); z0 = Math.min(z0, b, d); z1 = Math.max(z1, b, d);
  }
  const out = [r.x0 - x0, x1 - r.x1, r.z0 - z0, z1 - r.z1]; // positive: the drawing sticks out
  return { arena: arena.id, what, index, y, over: Math.max(0, ...out), under: Math.max(0, ...out.map((v) => -v)) };
}

/** Debris and decals: where they end up in world space. */
export function partBounds(part: CoverPart): THREE.Box3 {
  return new THREE.Box3().setFromBufferAttribute(part.geo.attributes.position as THREE.BufferAttribute).applyMatrix4(partMatrix(part));
}
export function partPoints(part: CoverPart): THREE.Vector3[] {
  const pos = part.geo.attributes.position, m = partMatrix(part);
  return Array.from({ length: pos.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m));
}

export interface ArenaAudit { arena: string; pillars: PillarRow[]; walls: RectRow[]; lows: RectRow[]; problems: string[] }

/** Every piece of cover in an arena against the shape that blocks, at AUDIT_HEIGHTS (lows only up to their top). */
export function auditArena(arena: ArenaDef): ArenaAudit {
  const pillars: PillarRow[] = [], walls: RectRow[] = [], lows: RectRow[] = [], problems: string[] = [];
  arena.pillars.forEach((p, i) => {
    const parts = pillarPartsOf(arena, i);
    for (const y of AUDIT_HEIGHTS) {
      const row = pillarRow(arena, i, y, parts);
      pillars.push(row);
      if (row.over > COVER_PROUD + 1e-6) problems.push(`pillar ${i} (${p.x}, ${p.z}) r ${p.r}: drawn ${row.outer.toFixed(2)} out at ${y} yards (+${row.over.toFixed(2)})`);
      if (row.under > MAX_UNDER + 1e-6) problems.push(`pillar ${i} (${p.x}, ${p.z}) r ${p.r}: drawn only ${row.inner.toFixed(2)} at ${y} yards (-${row.under.toFixed(2)})`);
    }
    for (const part of parts) {
      const b = partBounds(part);
      if (part.role === 'decal' && b.max.y > 0.06) problems.push(`pillar ${i}: a decal stands ${b.max.y.toFixed(2)} high`);
      if (part.role === 'debris') {
        if (b.max.y > DEBRIS_MAX) problems.push(`pillar ${i}: debris ${b.max.y.toFixed(2)} high`);
        if (partPoints(part).some((q) => Math.hypot(q.x - p.x, q.z - p.z) < p.r - 0.02)) problems.push(`pillar ${i}: debris inside the circle`);
      }
    }
  });
  for (const [what, list, into] of [['wall', arena.walls ?? [], walls], ['low', arena.lows ?? [], lows]] as const) {
    list.forEach((r, i) => {
      const top = what === 'low' ? 1.45 : COVER_MAX;
      for (const y of AUDIT_HEIGHTS.filter((h) => h <= top)) {
        const row = rectRow(arena, what, i, y);
        if (!row) {
          problems.push(`${what} ${i}: nothing drawn at ${y} yards`);
          continue;
        }
        into.push(row);
        if (row.over > RECT_TOL + 1e-6 || row.under > RECT_TOL + 1e-6) problems.push(`${what} ${i} [${r.x0}..${r.x1}, ${r.z0}..${r.z1}]: drawn +${row.over.toFixed(2)} / -${row.under.toFixed(2)} at ${y} yards`);
      }
      const parts = what === 'wall' ? wallPartsOf(arena, i) : lowPartsOf(arena, i);
      for (const part of parts.filter((q) => q.role === 'debris')) {
        const b = partBounds(part);
        if (b.max.y > DEBRIS_MAX) problems.push(`${what} ${i}: debris ${b.max.y.toFixed(2)} high`);
        if (partPoints(part).some((q) => q.x > r.x0 + 0.02 && q.x < r.x1 - 0.02 && q.z > r.z0 + 0.02 && q.z < r.z1 - 0.02)) problems.push(`${what} ${i}: debris inside the box`);
      }
    });
  }
  return { arena: arena.id, pillars, walls, lows, problems };
}
