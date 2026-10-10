import type { ArenaDef, Rect, Vec2 } from '@arena/shared';

/**
 * The map editor's editing rules, apart from the drawing and the DOM so they can be tested: what is under the pointer,
 * moving and resizing a piece, adding one, deleting one, mirroring one to the other side. The draft is a plain ArenaDef
 * that is changed in place; the editor validates it (cleanCustomArena) after every change.
 */

export type RectKind = 'wall' | 'low' | 'flat' | 'ramp' | 'pier';
export type Sel =
  | { kind: 'pillar'; i: number }
  | { kind: RectKind; i: number }
  | { kind: 'spawn'; team: 0 | 1; i: number }
  | null;
export type Tool = 'select' | 'pillar' | 'wall' | 'low' | 'lava' | 'flat' | 'ramp' | 'pier';
export type Rise = '+x' | '-x' | '+z' | '-z';

export const SNAP = 0.5;
export const snap = (v: number, step = SNAP): number => (step > 0 ? Math.round(v / step) * step : Math.round(v * 100) / 100);

export const RECT_KINDS: readonly RectKind[] = ['wall', 'low', 'flat', 'ramp', 'pier'];

export const KIND_LABEL: Record<RectKind | 'pillar' | 'spawn', string> = {
  pillar: 'Pillar', wall: 'Wall', low: 'Low wall', flat: 'Walkway flat', ramp: 'Ramp', pier: 'Pier', spawn: 'Start spot',
};

/** The list a kind lives in (undefined when the draft has none yet). */
export function listOf(d: ArenaDef, kind: RectKind): (Rect & { rise?: Rise; lava?: boolean })[] | undefined {
  switch (kind) {
    case 'wall': return d.walls;
    case 'low': return d.lows;
    case 'flat': return d.deck?.flats;
    case 'ramp': return d.deck?.ramps;
    case 'pier': return d.deck?.piers;
  }
}

/** The piece a selection points to, or null. */
export function itemOf(d: ArenaDef, sel: Sel): (Rect & { rise?: Rise; lava?: boolean }) | { x: number; z: number; r: number } | Vec2 | null {
  if (!sel) return null;
  if (sel.kind === 'pillar') return d.pillars[sel.i] ?? null;
  if (sel.kind === 'spawn') return d.spawns[sel.team]?.[sel.i] ?? null;
  return listOf(d, sel.kind)?.[sel.i] ?? null;
}

const isRect = (it: unknown): it is Rect => !!it && typeof it === 'object' && 'x0' in it;
const inRect = (r: Rect, x: number, z: number, tol: number) => x >= r.x0 - tol && x <= r.x1 + tol && z >= r.z0 - tol && z <= r.z1 + tol;

/** What is at a point (world yards), topmost first: start spots, pillars, walls, low walls, piers, ramps, flats. `tol` widens small pieces so they can be grabbed. */
export function hitTest(d: ArenaDef, x: number, z: number, tol = 0.4): Sel {
  for (const team of [0, 1] as const) for (let i = 0; i < (d.spawns[team]?.length ?? 0); i++) if (Math.hypot(d.spawns[team][i].x - x, d.spawns[team][i].z - z) <= 1 + tol) return { kind: 'spawn', team, i };
  for (let i = d.pillars.length - 1; i >= 0; i--) if (Math.hypot(d.pillars[i].x - x, d.pillars[i].z - z) <= d.pillars[i].r + tol) return { kind: 'pillar', i };
  for (const kind of ['wall', 'low', 'pier', 'ramp', 'flat'] as const) {
    const l = listOf(d, kind);
    if (l) for (let i = l.length - 1; i >= 0; i--) if (inRect(l[i], x, z, kind === 'flat' || kind === 'ramp' ? 0 : tol)) return { kind, i };
  }
  return null;
}

export type Handle = { hx: -1 | 0 | 1; hz: -1 | 0 | 1 };

/** Which edge or corner of a rect is under the point (for resizing), or null when it is the body. */
export function handleAt(r: Rect, x: number, z: number, tol = 0.6): Handle | null {
  const nearX0 = Math.abs(x - r.x0) <= tol, nearX1 = Math.abs(x - r.x1) <= tol;
  const nearZ0 = Math.abs(z - r.z0) <= tol, nearZ1 = Math.abs(z - r.z1) <= tol;
  const withinX = x >= r.x0 - tol && x <= r.x1 + tol, withinZ = z >= r.z0 - tol && z <= r.z1 + tol;
  const hx: -1 | 0 | 1 = nearX0 && withinZ ? -1 : nearX1 && withinZ ? 1 : 0;
  const hz: -1 | 0 | 1 = nearZ0 && withinX ? -1 : nearZ1 && withinX ? 1 : 0;
  // inside a small piece every side would be near: grabbing the middle moves it
  if (r.x1 - r.x0 < 2 * tol && r.z1 - r.z0 < 2 * tol) return null;
  return hx || hz ? { hx, hz } : null;
}

/** Drag an edge or corner to (x, z), keeping at least `min` yards each way. */
export function resizeRect(r: Rect, h: Handle, x: number, z: number, min = 0.5): void {
  if (h.hx === -1) r.x0 = Math.min(x, r.x1 - min);
  if (h.hx === 1) r.x1 = Math.max(x, r.x0 + min);
  if (h.hz === -1) r.z0 = Math.min(z, r.z1 - min);
  if (h.hz === 1) r.z1 = Math.max(z, r.z0 + min);
}

/** Move the selected piece by (dx, dz). */
export function moveSel(d: ArenaDef, sel: Sel, dx: number, dz: number): void {
  const it = itemOf(d, sel);
  if (!it) return;
  if (isRect(it)) {
    it.x0 += dx; it.x1 += dx; it.z0 += dz; it.z1 += dz;
  } else {
    (it as Vec2).x += dx;
    (it as Vec2).z += dz;
  }
}

/** A rect between two corners, put in order, never thinner than `min`. */
export function rectBetween(a: Vec2, b: Vec2, min = 1): Rect {
  const x0 = Math.min(a.x, b.x), z0 = Math.min(a.z, b.z);
  return { x0, x1: Math.max(x0 + min, Math.max(a.x, b.x)), z0, z1: Math.max(z0 + min, Math.max(a.z, b.z)) };
}

/** Which way a ramp climbs by default for a drawn box: along the longer side, towards the nearest map edge's opposite (any is valid; the form changes it). */
export const defaultRise = (r: Rect): Rise => (r.x1 - r.x0 >= r.z1 - r.z0 ? '+x' : '+z');

/** Add a piece for a tool, from the two corners dragged (a click: `a` equals `b`). Returns its selection. */
export function addItem(d: ArenaDef, tool: Exclude<Tool, 'select'>, a: Vec2, b: Vec2): Sel {
  if (tool === 'pillar') {
    const r = Math.max(0.8, Math.min(6, Math.round(Math.hypot(b.x - a.x, b.z - a.z) * 2) / 2 || 2));
    d.pillars.push({ x: a.x, z: a.z, r });
    return { kind: 'pillar', i: d.pillars.length - 1 };
  }
  const big = Math.abs(b.x - a.x) > 0.6 || Math.abs(b.z - a.z) > 0.6;
  const defaults: Record<string, [number, number]> = { wall: [6, 1.5], low: [5, 1], lava: [6, 6], flat: [10, 6], ramp: [6, 4], pier: [1.2, 1.2] };
  const [w, h] = defaults[tool];
  const r = big ? rectBetween(a, b, 0.5) : { x0: a.x - w / 2, x1: a.x + w / 2, z0: a.z - h / 2, z1: a.z + h / 2 };
  switch (tool) {
    case 'wall':
      (d.walls ??= []).push(r);
      return { kind: 'wall', i: d.walls.length - 1 };
    case 'low':
    case 'lava':
      (d.lows ??= []).push(tool === 'lava' ? { ...r, lava: true } : r);
      return { kind: 'low', i: d.lows.length - 1 };
    case 'flat':
      d.deck ??= { height: 3.2, flats: [], ramps: [] };
      d.deck.flats.push(r);
      return { kind: 'flat', i: d.deck.flats.length - 1 };
    case 'ramp':
      d.deck ??= { height: 3.2, flats: [], ramps: [] };
      d.deck.ramps.push({ ...r, rise: defaultRise(r) });
      return { kind: 'ramp', i: d.deck.ramps.length - 1 };
    case 'pier':
      d.deck ??= { height: 3.2, flats: [], ramps: [] };
      (d.deck.piers ??= []).push(r);
      return { kind: 'pier', i: d.deck.piers.length - 1 };
  }
}

/** Remove the selected piece (a start spot cannot be removed). Empty lists and an empty walkway are dropped so the map stays tidy. Returns whether something went. */
export function deleteSel(d: ArenaDef, sel: Sel): boolean {
  if (!sel || sel.kind === 'spawn') return false;
  if (sel.kind === 'pillar') return d.pillars.splice(sel.i, 1).length > 0;
  const l = listOf(d, sel.kind);
  if (!l || !l[sel.i]) return false;
  l.splice(sel.i, 1);
  if (sel.kind === 'wall' && !d.walls!.length) delete d.walls;
  if (sel.kind === 'low' && !d.lows!.length) delete d.lows;
  if (sel.kind === 'pier' && d.deck && !d.deck.piers!.length) d.deck.piers = []; // an empty list means "no piers", not "automatic"
  if (d.deck && !d.deck.flats.length && !d.deck.ramps.length && !(d.deck.piers?.length)) delete d.deck;
  return true;
}

const FLIP: Record<Rise, Rise> = { '+x': '-x', '-x': '+x', '+z': '-z', '-z': '+z' };

/** Add the point-symmetric twin (x, z -> -x, -z) of the selected piece: how the built-in maps stay fair. Returns the twin's selection. */
export function addTwin(d: ArenaDef, sel: Sel): Sel {
  if (!sel || sel.kind === 'spawn') return null;
  if (sel.kind === 'pillar') {
    const p = d.pillars[sel.i];
    if (!p) return null;
    d.pillars.push({ x: 0 - p.x, z: 0 - p.z, r: p.r });
    return { kind: 'pillar', i: d.pillars.length - 1 };
  }
  const l = listOf(d, sel.kind);
  const r = l?.[sel.i];
  if (!l || !r) return null;
  const twin = { ...r, x0: 0 - r.x1, x1: 0 - r.x0, z0: 0 - r.z1, z1: 0 - r.z0 };
  if (r.rise) twin.rise = FLIP[r.rise];
  l.push(twin);
  return { kind: sel.kind, i: l.length - 1 };
}

/** The same spot mirrored in the other team's half, for the three start spots of a team: team 2 = team 1 turned around the centre. */
export function mirrorSpawns(d: ArenaDef, from: 0 | 1): void {
  d.spawns[1 - from] = d.spawns[from].map((p) => ({ x: 0 - p.x, z: 0 - p.z }));
}

/** World <-> canvas for a bounds box drawn into w x h pixels with a margin. x runs right, z runs down. */
export interface View { scale: number; ox: number; oz: number; px(x: number): number; py(z: number): number; wx(px: number): number; wz(py: number): number }
export function makeView(b: ArenaDef['bounds'], w: number, h: number, pad = 14): View {
  const scale = Math.min((w - 2 * pad) / (b.maxX - b.minX), (h - 2 * pad) / (b.maxZ - b.minZ));
  const ox = (w - scale * (b.maxX - b.minX)) / 2 - scale * b.minX;
  const oz = (h - scale * (b.maxZ - b.minZ)) / 2 - scale * b.minZ;
  return { scale, ox, oz, px: (x) => ox + x * scale, py: (z) => oz + z * scale, wx: (px) => (px - ox) / scale, wz: (py) => (py - oz) / scale };
}
