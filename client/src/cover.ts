import * as THREE from 'three';
import { LOW_HEIGHT } from '@arena/shared';
import type { ArenaDef } from '@arena/shared';
import { COVER_FLAT, crystalCluster, hornGeometry, jaggedBox, rng, rockGeometry, spireGeometry, taperedShaft, worldBox } from './arenaKit';

/**
 * Cover: what you see is what blocks. The sim blocks sight and movement with a vertical circle per pillar (x, z, r) and
 * a box per wall and low barricade (shared/src/geometry.ts), the same at every height a player can see or stand at. This
 * module builds the pieces that are drawn for them, as a list of parts, so the scenery (arenaMap.ts) and the audit
 * (scripts/audit-cover.ts, client/test/cover.test.ts) use the very same geometry:
 *  - 'body' parts make the solid piece. Up to COVER_MAX (2.5 yards, above a player's head) their footprint is the collision
 *    shape: a pillar's cross-section is a round (or fine-faceted) shaft of radius r, wall and low faces sit on the rect;
 *    any taper, flare, lean or ornament is above that height. Trim that sits proud of it stays within COVER_PROUD.
 *  - 'decal' parts are flat on the floor (a ring of moss, snow or embers round a base): they never stand in the way.
 *  - 'debris' parts are small stones OUTSIDE the shape, lower than DEBRIS_MAX, that do not claim to block anything.
 */
export const COVER_MAX = 2.5;
/** Trim may stand this far outside the collision shape (yards). */
export const COVER_PROUD = 0.04;
/** Debris is lower than this. */
export const DEBRIS_MAX = 0.6;

export type PillarKind = 'column' | 'ruin' | 'crystal' | 'spire' | 'chimney' | 'obelisk';
export type LowKind = 'crates' | 'rubble' | 'ice' | 'basalt' | 'basin';
export type WallKind = 'rock' | 'stack' | 'stone';

/** Material slots; the scenery maps them to its themed materials. */
export type CoverMat = 'shaft' | 'trim' | 'gold' | 'ember' | 'moss' | 'rock' | 'ice' | 'snow' | 'horn' | 'body' | 'carved' | 'cap' | 'basinBrick' | 'basinLip' | 'lowBasalt' | 'lowIce' | 'lowStone' | 'wallRock' | 'obelisk' | 'pedestal';

export interface CoverPart {
  geo: THREE.BufferGeometry;
  pos: [number, number, number];
  rot?: [number, number, number];
  mat: CoverMat;
  role: 'body' | 'decal' | 'debris';
  /** The camera keeps clear of these (pillar shafts and wall bodies). */
  camera?: boolean;
  /** Replaced by a scanned piece when the pack arrives (sandstone obelisks). */
  slot?: 'obelisk';
}

export const partMatrix = (p: CoverPart): THREE.Matrix4 => {
  const m = new THREE.Matrix4();
  m.compose(new THREE.Vector3(...p.pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(p.rot ?? [0, 0, 0]))), new THREE.Vector3(1, 1, 1));
  return m;
};

const uvScale = (g: THREE.BufferGeometry, su: number, sv: number) => {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return g;
};
/** UV repeats that keep texels square on a shaft of radius r and height h. */
const shaftUV = (r: number, h: number, tile: number) => [Math.max(1, Math.round((r * Math.PI * 2) / tile)), h / tile] as const;

const cyl = (rt: number, rb: number, h: number, sides: number) => new THREE.CylinderGeometry(rt, rb, h, sides);
const flatRing = (r0: number, r1: number, sides: number) => new THREE.RingGeometry(r0, r1, sides).rotateX(-Math.PI / 2);

/** Small stones lying round a circle (outside it) or a rect (outside it); they are low and inside no collision shape. */
function pebblesRound(p: { x: number; z: number; r: number }, n: number, seed: number, mat: CoverMat, out: CoverPart[], minS = 0.16, maxS = 0.28) {
  const rnd = rng(seed);
  for (let k = 0; k < n; k++) {
    const a = rnd() * Math.PI * 2, s = minS + rnd() * (maxS - minS);
    const rr = p.r + 1.25 * s + 0.08 + rnd() * 0.5;
    out.push({ geo: rockGeometry(s, seed + k), pos: [p.x + Math.cos(a) * rr, s * 0.3, p.z + Math.sin(a) * rr], rot: [rnd() * 3, rnd() * 3, rnd() * 3], mat, role: 'debris' });
  }
}
function pebblesRect(w: { x0: number; x1: number; z0: number; z1: number }, n: number, seed: number, mat: CoverMat, out: CoverPart[], minS = 0.16, maxS = 0.28) {
  const rnd = rng(seed);
  for (let k = 0; k < n; k++) {
    const s = minS + rnd() * (maxS - minS), off = 1.25 * s + 0.08 + rnd() * 0.3, t = rnd();
    const side = Math.floor(rnd() * 4);
    const x = side < 2 ? w.x0 + (w.x1 - w.x0) * t : side === 2 ? w.x0 - off : w.x1 + off;
    const z = side < 2 ? (side === 0 ? w.z0 - off : w.z1 + off) : w.z0 + (w.z1 - w.z0) * t;
    out.push({ geo: rockGeometry(s, seed + k), pos: [x, s * 0.3, z], rot: [rnd() * 3, rnd() * 3, rnd() * 3], mat, role: 'debris' });
  }
}

/** A shaft's radius at height y for taperedShaft(r, h, ..., top): r up to COVER_FLAT, then linearly to top * r. */
export const shaftRadius = (r: number, h: number, top: number, y: number) => r * (1 - (1 - top) * Math.min(1, Math.max(0, (y - COVER_FLAT) / (h - COVER_FLAT))));

export interface PillarCtx {
  p: { x: number; z: number; r: number };
  /** Index in the arena's pillar list (seeds the variation). */
  i: number;
}

/** Everything drawn for one pillar; the circle (p.x, p.z, p.r) is what blocks. */
export function pillarParts(kind: PillarKind, { p, i: pi }: PillarCtx): CoverPart[] {
  const out: CoverPart[] = [];
  const at = (y: number): [number, number, number] => [p.x, y, p.z];
  const proud = p.r + COVER_PROUD * 0.75;
  if (kind === 'column') {
    const H = 8;
    out.push({ geo: uvScale(taperedShaft(p.r, H, 24, 0.94), ...shaftUV(p.r, H, 4)), pos: at(0), mat: 'shaft', role: 'body', camera: true });
    out.push({ geo: cyl(proud, proud, 0.7, 24), pos: at(0.35), mat: 'trim', role: 'body' });
    out.push({ geo: cyl(p.r * 1.25, p.r * 0.98, 0.8, 24), pos: at(H + 0.1), mat: 'trim', role: 'body' });
    out.push({ geo: cyl(proud, proud, 0.16, 24), pos: at(H - 1.3), mat: 'gold', role: 'body' });
    out.push({ geo: cyl(proud, proud, 0.16, 24), pos: at(1.6), mat: 'gold', role: 'body' });
  } else if (kind === 'ruin') {
    const rnd = rng(4100 + pi);
    const big = p.r > 3;
    const h = big ? 10.5 : 4.5 + rnd() * 3.5;
    out.push({ geo: uvScale(taperedShaft(p.r, h, 20, 0.9), ...shaftUV(p.r, h, 3.5)), pos: at(0), mat: 'shaft', role: 'body', camera: true });
    out.push({ geo: rockGeometry(p.r * 0.85, 900 + pi, 0.5), pos: at(h + 0.1), rot: [rnd() * 2, rnd() * 6, rnd()], mat: 'rock', role: 'body' });
    out.push({ geo: flatRing(p.r, p.r * 1.3, 20), pos: at(0.03), mat: 'moss', role: 'decal' });
    pebblesRound(p, 5, 40 + pi * 7, 'rock', out);
  } else if (kind === 'crystal') {
    const h = 8 + (pi % 3) * 1.2;
    out.push({ geo: spireGeometry(p.r, h, 300 + pi, 12, 0.04), pos: at(0), mat: 'ice', role: 'body', camera: true });
    // the crystal cluster grows out of the spire above head height, where it may be as wide as it likes
    out.push({ geo: crystalCluster(p.r * 1.7, h * 0.34, 500 + pi, 6), pos: at(COVER_MAX + 0.9), mat: 'ice', role: 'body' });
    out.push({ geo: flatRing(p.r, p.r * 1.45, 20), pos: at(0.03), mat: 'snow', role: 'decal' });
  } else if (kind === 'spire') {
    // obsidian horn: a tall crooked ridged shaft of black glass, cracked with lava low down
    const h = 8.5 + (pi % 3) * 1.4;
    out.push({ geo: hornGeometry(p.r, h, 60 + pi, 5), pos: at(0), rot: [0, pi * 1.9, 0], mat: 'horn', role: 'body', camera: true });
    out.push({ geo: flatRing(p.r, p.r * 1.35, 24), pos: at(0.03), mat: 'ember', role: 'decal' });
    pebblesRound(p, 4, 80 + pi * 5, 'rock', out);
  } else if (kind === 'chimney') {
    // a brick forge chimney with a glowing band and a fire bowl on its top
    const H = 7.5, top = 0.86;
    out.push({ geo: uvScale(taperedShaft(p.r, H, 20, top), ...shaftUV(p.r, H, 3)), pos: at(0), mat: 'shaft', role: 'body', camera: true });
    out.push({ geo: cyl(proud, proud, 0.9, 20), pos: at(0.45), mat: 'trim', role: 'body' });
    out.push({ geo: cyl(proud, proud, 0.18, 20), pos: at(2.0), mat: 'ember', role: 'body' });
    const rb = shaftRadius(p.r, H, top, H - 1.2) + 0.02;
    out.push({ geo: cyl(rb, rb, 0.18, 20), pos: at(H - 1.2), mat: 'ember', role: 'body' });
    out.push({ geo: cyl(p.r * 1.2, p.r * 0.9, 0.7, 20), pos: at(H + 0.2), mat: 'trim', role: 'body' });
  } else {
    // obelisk: a round carved pedestal as wide as the collision circle, and above head height the tall four-sided shaft with
    // a gilded tip (the scanned obelisk replaces the shaft when the pack arrives)
    const PED = COVER_MAX + 0.1, H = 7.4;
    out.push({ geo: uvScale(cyl(p.r, p.r, PED, 16).translate(0, PED / 2, 0), 5, PED / 2.5), pos: at(0), mat: 'pedestal', role: 'body', camera: true });
    out.push({ geo: cyl(proud, proud, 0.35, 16), pos: at(PED - 0.2), mat: 'trim', role: 'body' });
    const sh = H - PED;
    const shaft = new THREE.CylinderGeometry(p.r * 0.36, p.r * 0.56, sh, 4, 1).rotateY(Math.PI / 4);
    out.push({ geo: uvScale(shaft, 1.4, sh / 3.5), pos: at(PED + sh / 2), mat: 'obelisk', role: 'body', slot: 'obelisk' });
    out.push({ geo: new THREE.ConeGeometry(p.r * 0.36, 1.1, 4).rotateY(Math.PI / 4), pos: at(H + 0.55), mat: 'gold', role: 'body', slot: 'obelisk' });
  }
  return out;
}

/** Where the scanned obelisk goes on a pedestal (it is 0.19 wide and 1 tall before scaling): base height and the scale. */
export function scannedObelisk(r: number, h = 7.4): { y: number; sx: number; sy: number } {
  const base = COVER_MAX + 0.1;
  return { y: base, sx: r * 3.4, sy: h - base + 1.6 };
}

export const wallKindOf = (pillar: PillarKind, extras: string): WallKind => (pillar === 'spire' || extras === 'lava' ? 'rock' : pillar === 'obelisk' ? 'stack' : 'stone');

export const COVER_WALL_H = 5;
/** Everything drawn for one wall box; the rect is what blocks (at every height). */
export function wallParts(kind: WallKind, w: { x0: number; x1: number; z0: number; z1: number }, wi: number): CoverPart[] {
  const out: CoverPart[] = [];
  const ww = w.x1 - w.x0, wd = w.z1 - w.z0, wx = (w.x0 + w.x1) / 2, wz = (w.z0 + w.z1) / 2;
  if (kind === 'rock') {
    out.push({ geo: jaggedBox(ww, COVER_WALL_H, wd, 200 + wi, 0.34, 3), pos: [wx, COVER_WALL_H / 2, wz], mat: 'wallRock', role: 'body', camera: true });
    out.push({ geo: new THREE.BoxGeometry(ww + 0.08, 0.1, wd + 0.08), pos: [wx, 0.5, wz], mat: 'ember', role: 'body' });
    pebblesRect(w, 3, 300 + wi * 3, 'wallRock', out);
  } else if (kind === 'stack') {
    // stacked carved sandstone blocks, two high (a person is 2.2 tall: sight over the stack is blocked like the rule says)
    const CH = 1.7, nx = Math.max(1, Math.round(ww / 1.7)), nz = Math.max(1, Math.round(wd / 1.7)), layers = 2;
    for (let ly = 0; ly < layers; ly++)
      for (let i = 0; i < nx; i++)
        for (let k = 0; k < nz; k++) {
          const bw = ww / nx, bd = wd / nz;
          const g = new THREE.BoxGeometry(bw - 0.05, CH - 0.04, bd - 0.05);
          out.push({ geo: g, pos: [w.x0 + bw * (i + 0.5) + (ly ? (i % 2 ? 0.03 : -0.03) : 0), CH * (ly + 0.5), w.z0 + bd * (k + 0.5)], mat: 'carved', role: 'body', camera: true });
        }
    out.push({ geo: new THREE.BoxGeometry(ww + 0.2, 0.18, wd + 0.2), pos: [wx, CH * layers + 0.09, wz], mat: 'cap', role: 'body', camera: true });
  } else {
    out.push({ geo: worldBox(ww, COVER_WALL_H, wd, 4), pos: [wx, COVER_WALL_H / 2, wz], mat: 'body', role: 'body', camera: true });
    out.push({ geo: worldBox(ww + 0.25, 0.4, wd + 0.25, 2), pos: [wx, COVER_WALL_H + 0.2, wz], mat: 'trim', role: 'body' });
    out.push({ geo: worldBox(ww + 0.08, 0.5, wd + 0.08, 2), pos: [wx, 0.25, wz], mat: 'trim', role: 'body' });
    out.push({ geo: new THREE.BoxGeometry(ww + 0.08, 0.14, wd + 0.08), pos: [wx, COVER_WALL_H - 0.7, wz], mat: 'gold', role: 'body' });
  }
  return out;
}

export const LOW_H = LOW_HEIGHT - 0.14; // the cap finishes at the height that blocks sight

/** Everything drawn for one low barricade; the rect is what blocks sight below LOW_HEIGHT. */
export function lowParts(kind: LowKind, lw: { x0: number; x1: number; z0: number; z1: number }, li: number): CoverPart[] {
  const out: CoverPart[] = [];
  const ww = lw.x1 - lw.x0, wd = lw.z1 - lw.z0, wx = (lw.x0 + lw.x1) / 2, wz = (lw.z0 + lw.z1) / 2;
  const along = ww > wd;
  if (kind === 'crates') {
    // carved sandstone blocks laid side by side, a block-wide cap on top
    const n = Math.max(1, Math.round(Math.max(ww, wd) / 1.6));
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      const x0 = along ? lw.x0 + ww * t0 : lw.x0, x1 = along ? lw.x0 + ww * t1 : lw.x1;
      const z0 = along ? lw.z0 : lw.z0 + wd * t0, z1 = along ? lw.z1 : lw.z0 + wd * t1;
      out.push({ geo: new THREE.BoxGeometry(x1 - x0 - 0.04, LOW_H, z1 - z0 - 0.04), pos: [(x0 + x1) / 2, LOW_H / 2, (z0 + z1) / 2], mat: 'carved', role: 'body' });
    }
    out.push({ geo: new THREE.BoxGeometry(ww + 0.08, 0.14, wd + 0.08), pos: [wx, LOW_H + 0.07, wz], mat: 'cap', role: 'body' });
  } else if (kind === 'basin') {
    // a stone lava basin: brick sides, a glowing lava surface just under the brim
    out.push({ geo: worldBox(ww, LOW_H, wd, 3), pos: [wx, LOW_H / 2, wz], mat: 'basinBrick', role: 'body' });
    out.push({ geo: worldBox(ww + 0.08, 0.16, wd + 0.08, 2), pos: [wx, LOW_H - 0.02, wz], mat: 'basinLip', role: 'body' });
  } else if (kind === 'basalt') {
    out.push({ geo: jaggedBox(ww, LOW_H, wd, 500 + li, 0.18, 3), pos: [wx, LOW_H / 2, wz], mat: 'lowBasalt', role: 'body' });
    out.push({ geo: new THREE.BoxGeometry(ww + 0.08, 0.08, wd + 0.08), pos: [wx, 0.35, wz], mat: 'ember', role: 'body' });
  } else if (kind === 'ice') {
    out.push({ geo: worldBox(ww, LOW_H, wd, 3), pos: [wx, LOW_H / 2, wz], mat: 'lowIce', role: 'body' });
    out.push({ geo: worldBox(ww + 0.08, 0.2, wd + 0.08, 2), pos: [wx, LOW_H + 0.05, wz], mat: 'snow', role: 'body' });
  } else {
    // rubble wall: broken moss brick with a few tumbled blocks on top (small enough to sit inside the wall's footprint)
    out.push({ geo: worldBox(ww, LOW_H, wd, 3), pos: [wx, LOW_H / 2, wz], mat: 'lowStone', role: 'body' });
  }
  return out;
}

/** The loose bits that sit on top of a low barricade (cones of ice, tumbled stones) and stay inside its rect. */
export function lowTopParts(kind: LowKind, lw: { x0: number; x1: number; z0: number; z1: number }, li: number): CoverPart[] {
  const out: CoverPart[] = [];
  const ww = lw.x1 - lw.x0, wd = lw.z1 - lw.z0, wx = (lw.x0 + lw.x1) / 2, wz = (lw.z0 + lw.z1) / 2;
  const along = ww > wd;
  const rnd = rng(600 + li * 9);
  if (kind === 'ice') {
    const n = Math.max(2, Math.round(Math.max(ww, wd) / 1.6));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      out.push({ geo: new THREE.ConeGeometry(0.12, 0.35 + rnd() * 0.25, 5), pos: [along ? lw.x0 + ww * t : wx, LOW_H + 0.3, along ? wz : lw.z0 + wd * t], mat: 'ice', role: 'body' });
    }
  } else if (kind === 'rubble') {
    const n = Math.max(2, Math.round(Math.max(ww, wd) / 1.4));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n, s = 0.12 + rnd() * 0.1;
      out.push({ geo: rockGeometry(s, 600 + li * 9 + i), pos: [along ? lw.x0 + ww * t : wx + (rnd() - 0.5) * 0.1, LOW_H + 0.05, along ? wz + (rnd() - 0.5) * 0.1 : lw.z0 + wd * t], mat: 'rock', role: 'body' });
    }
  }
  return out;
}
