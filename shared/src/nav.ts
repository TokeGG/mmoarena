import type { ArenaDef, Vec2 } from './types';
import { PLAYER_RADIUS, STEP_HEIGHT, dist, hasLOS, heightAt, inLava, moveTo, rectDist, resolveCollisions } from './geometry';
import type { Level } from './geometry';
import { JUMP_HEIGHT } from './jump';

/**
 * Walking routes for bots on arenas with walkways and barricades: a one-yard grid on both levels (the ground and the
 * walkway), linked where a unit can really get from one cell to the next: by walking, up or down the low end of a ramp,
 * by jumping onto the lower part of a ramp from the side, by jumping off a walkway, or by jumping a barricade.
 * Routes are distance fields towards a goal cell (cached), so many bots chasing the same target share the work.
 */

const CELL = 1;
/** Links between cells this far apart (centre to centre) are checked for level changes: up/down a ramp foot or a jump off. */
const HOP = 3.2;

interface Edge { to: number; cost: number; jump: boolean }
interface Grid {
  x0: number;
  z0: number;
  cols: number;
  rows: number;
  /** Per node (level * cols * rows + cell): 0 blocked, 1 open, 2 open only in a jump (a barricade). */
  open: Uint8Array;
  out: Edge[][];
  into: { from: number; cost: number }[][];
  fields: Map<number, Float64Array>;
}

const grids = new WeakMap<ArenaDef, Grid>();

/** Does this arena need the grid (walkways or barricades)? Plain arenas keep the simple pillar steering. */
export const needsNavGrid = (arena: ArenaDef): boolean => !!arena.deck || !!arena.lows?.length;

/**
 * Can a walker get from a to b on the sim's own movement rules (`moveTo`, the same call the sim makes each step)? It walks
 * in short steps along the straight line and must stay on that line and arrive on the right level. The grid cannot say
 * this on its own: a corner where a ramp meets a pier passes every cell test and still stops a walker dead.
 */
function walksBetween(arena: ArenaDef, a: Vec2, la: Level, b: Vec2, lb: Level): boolean {
  const n = Math.max(4, Math.ceil(dist(a, b) / 0.2));
  let pos = a;
  let lv: Level = la;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const want = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    const m = moveTo(arena, lv, pos, want, 0);
    if (dist(m.pos, want) > 0.25) return false;
    pos = m.pos;
    lv = m.level;
  }
  return lv === lb && dist(pos, b) < 0.6;
}

function gridOf(arena: ArenaDef): Grid {
  let g = grids.get(arena);
  if (g) return g;
  const b = arena.bounds;
  const cols = Math.floor((b.maxX - b.minX) / CELL);
  const rows = Math.floor((b.maxZ - b.minZ) / CELL);
  const N = cols * rows;
  const open = new Uint8Array(N * 2);
  const x0 = b.minX + CELL / 2, z0 = b.minZ + CELL / 2;
  const dk = arena.deck;
  const pieces = dk ? [...dk.flats, ...dk.ramps] : [];
  const onDeck = (p: Vec2) => pieces.some((r) => rectDist(p.x, p.z, r) === 0);
  const still = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.z - q.z) < 0.05;
  for (let i = 0; i < N; i++) {
    const p = { x: x0 + (i % cols) * CELL, z: z0 + Math.floor(i / cols) * CELL };
    if (still(p, resolveCollisions(p, arena, 0, 0))) open[i] = 1;
    else if (still(p, resolveCollisions(p, arena, 0, 9)) && !inLava(arena, p)) open[i] = 2; // only a barricade in the way: jumpable (never into lava)
    if (dk && onDeck(p) && still(p, resolveCollisions(p, arena, 1, 0))) open[N + i] = 1;
  }
  const out: Edge[][] = Array.from({ length: N * 2 }, () => []);
  const posOf = (n: number): Vec2 => {
    const i = n % N;
    return { x: x0 + (i % cols) * CELL, z: z0 + Math.floor(i / cols) * CELL };
  };
  // same level: the 8 neighbours (diagonals only when both sides are open, so corners are not cut)
  for (let lv = 0; lv < 2; lv++) {
    for (let i = 0; i < N; i++) {
      const a = lv * N + i;
      if (!open[a]) continue;
      const cx = i % cols, cz = Math.floor(i / cols);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
        const bn = lv * N + nz * cols + nx;
        if (!open[bn]) continue;
        if (dx && dz && (!open[lv * N + cz * cols + nx] || !open[lv * N + nz * cols + cx])) continue;
        const len = Math.hypot(dx, dz) * CELL;
        out[a].push({ to: bn, cost: open[bn] === 2 ? len + 1.5 : len, jump: open[bn] === 2 });
      }
    }
  }
  // level changes
  if (dk) {
    const R = PLAYER_RADIUS;
    const span = Math.ceil(HOP / CELL);
    for (let i = 0; i < N; i++) {
      const up = N + i;
      if (!open[up]) continue;
      const p = posOf(up);
      const h = heightAt(arena, p.x, p.z, 1);
      const onRamp = dk.ramps.some((r) => rectDist(p.x, p.z, r) === 0);
      const cx = i % cols, cz = Math.floor(i / cols);
      for (let dz = -span; dz <= span; dz++) for (let dx = -span; dx <= span; dx++) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
        const gi = nz * cols + nx;
        if (open[gi] !== 1) continue;
        const q = posOf(gi);
        const len = dist(p, q);
        if (len > HOP) continue;
        const clearOfDeck = pieces.every((r) => rectDist(q.x, q.z, r) >= R + 0.1);
        if (onRamp && h <= STEP_HEIGHT) {
          // the low end of a ramp: walk on and off, but only where the sim's own movement really carries a walker from
          // the ground onto the ramp and back (a pier or a ramp corner in the way stops it, and a route through there
          // would keep sending it into the wall)
          if (!walksBetween(arena, q, 0, p, 1)) continue;
          out[gi].push({ to: up, cost: len, jump: false });
          // and back off it, onto ground clear of the walkway (a ground cell touching the ramp is where a step puts you back on it)
          if (clearOfDeck && walksBetween(arena, p, 1, q, 0)) out[up].push({ to: gi, cost: len, jump: false });
        } else if (clearOfDeck) {
          // jump off the walkway (over a rail if there is one)
          out[up].push({ to: gi, cost: len + 2, jump: true });
          // and jump onto a ramp's lower part from the side
          if (onRamp && h <= JUMP_HEIGHT * 0.6) out[gi].push({ to: up, cost: len + 3, jump: true });
        }
      }
    }
  }
  const into: { from: number; cost: number }[][] = Array.from({ length: N * 2 }, () => []);
  out.forEach((es, a) => es.forEach((e) => into[e.to].push({ from: a, cost: e.cost })));
  g = { x0, z0, cols, rows, open, out, into, fields: new Map() };
  grids.set(arena, g);
  return g;
}

const cellPos = (g: Grid, n: number): Vec2 => {
  const i = n % (g.cols * g.rows);
  return { x: g.x0 + (i % g.cols) * CELL, z: g.z0 + Math.floor(i / g.cols) * CELL };
};

/** The open node nearest a point on a level (searching outwards a few cells; `wide` searches the whole level). */
function nodeNear(g: Grid, p: Vec2, lv: Level, wide = false): number {
  const N = g.cols * g.rows;
  const cx = Math.round((p.x - g.x0) / CELL), cz = Math.round((p.z - g.z0) / CELL);
  let best = -1, bestD = Infinity;
  const reach = wide ? Math.max(g.cols, g.rows) : 4;
  for (let r = 0; r <= reach; r++) {
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= g.cols || nz >= g.rows) continue;
      const n = lv * N + nz * g.cols + nx;
      if (g.open[n] !== 1) continue;
      const d = dist(p, cellPos(g, n));
      if (d < bestD) { bestD = d; best = n; }
    }
    if (best >= 0 && r >= 1) break;
  }
  return best;
}

/** Distance from every node to `goal` (walking the links backwards), cached per goal. */
function fieldTo(g: Grid, goal: number): Float64Array {
  let f = g.fields.get(goal);
  if (f) {
    g.fields.delete(goal); // most recently used goes last
    g.fields.set(goal, f);
    return f;
  }
  f = new Float64Array(g.open.length).fill(Infinity);
  f[goal] = 0;
  const heap: [number, number][] = [[0, goal]];
  const push = (d: number, n: number) => {
    heap.push([d, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, n] = pop();
    if (d > f[n]) continue;
    for (const e of g.into[n]) {
      const nd = d + e.cost;
      if (nd < f[e.from]) {
        f[e.from] = nd;
        push(nd, e.from);
      }
    }
  }
  g.fields.set(goal, f);
  if (g.fields.size > 64) g.fields.delete(g.fields.keys().next().value!);
  return f;
}

/** Can a unit walk straight from a to b on this level, every sample on an open cell (no jumps)? */
function straight(g: Grid, a: Vec2, b: Vec2, lv: Level): boolean {
  const N = g.cols * g.rows;
  const n = Math.max(1, Math.ceil(dist(a, b) / 0.5));
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    const cx = Math.round((x - g.x0) / CELL), cz = Math.round((z - g.z0) / CELL);
    if (cx < 0 || cz < 0 || cx >= g.cols || cz >= g.rows) return false;
    if (g.open[lv * N + cz * g.cols + cx] !== 1) return false;
  }
  return true;
}

/**
 * The next point a bot should walk to on its way from (from, fromLv) to (to, toLv), and whether to jump now (a rail to
 * clear, a barricade, the side of a ramp). Null when there is no route (the caller falls back to walking straight).
 */
export function navRoute(arena: ArenaDef, from: Vec2, fromLv: Level, to: Vec2, toLv: Level): { point: Vec2; jump: boolean } | null {
  const g = gridOf(arena);
  if (fromLv === toLv && straight(g, from, to, fromLv)) return { point: to, jump: false };
  const start = nodeNear(g, from, fromLv);
  const goal = nodeNear(g, to, toLv, toLv === 1);
  if (start < 0 || goal < 0) return null;
  const f = fieldTo(g, goal);
  if (!Number.isFinite(f[start])) return null;
  const N = g.cols * g.rows;
  let cur = start;
  let best: Vec2 = cellPos(g, start);
  for (let k = 0; k < 14 && cur !== goal; k++) {
    let e: Edge | null = null;
    let eBest = Infinity;
    for (const x of g.out[cur]) {
      const c = x.cost + f[x.to];
      if (c < eBest) { eBest = c; e = x; }
    }
    if (!e) break;
    const p = cellPos(g, e.to);
    const changesLevel = e.to >= N !== cur >= N;
    if (e.jump || changesLevel) {
      // the first step that needs a jump or a level change: head straight for it (walking there does the climb)
      if (k === 0) {
        if (e.jump && !changesLevel) {
          // a barricade: aim at the open cell on its far side, not into the barricade (pressed against it, a jump aimed at
          // its middle would come straight back down on this side)
          let land = e.to;
          for (let hop = 0; hop < 4 && g.open[land] === 2; hop++) {
            let nx: Edge | null = null;
            let nb = Infinity;
            for (const x of g.out[land]) if (x.cost + f[x.to] < nb) { nb = x.cost + f[x.to]; nx = x; }
            if (!nx) break;
            land = nx.to;
          }
          const q = cellPos(g, land);
          return { point: q, jump: dist(from, p) < 1.6 };
        }
        return { point: p, jump: e.jump && dist(from, p) < HOP + 0.1 };
      }
      return { point: best, jump: false };
    }
    if (!straight(g, from, p, fromLv)) return { point: k === 0 ? p : best, jump: false };
    best = p;
    cur = e.to;
  }
  return { point: cur === goal && straight(g, from, to, fromLv) ? to : best, jump: false };
}

/** The walkway spot nearest `to` from which `to` (on the ground) can be seen, for casters who like the high ground; null if none is near. */
export function highSpot(arena: ArenaDef, to: Vec2): Vec2 | null {
  if (!arena.deck) return null;
  const g = gridOf(arena);
  const n = nodeNear(g, to, 1, true);
  if (n < 0) return null;
  const p = cellPos(g, n);
  return hasLOS(p, to, arena, 1, 0) && dist(p, to) < 26 ? p : null;
}

/**
 * The nearest spot (by walking distance, ramps and jumps included) on either floor where `threat` cannot see a unit,
 * within `maxWalk` yards: behind a pillar, round a wall, under or on top of a deck. Null when there is none in reach.
 * Works on every arena (plain ones too: their grid is just the ground with pillars cut out).
 */
export function coverSpot(arena: ArenaDef, from: Vec2, fromLv: Level, threat: Vec2, threatLv: Level, maxWalk = 16, avoid?: Vec2, maxThreatDist = Infinity): { point: Vec2; level: Level; walk: number } | null {
  const g = gridOf(arena);
  const start = nodeNear(g, from, fromLv);
  if (start < 0) return null;
  const N = g.cols * g.rows;
  const best = new Map<number, number>([[start, 0]]);
  const queue: [number, number][] = [[0, start]];
  while (queue.length) {
    // a small frontier: a linear pick of the cheapest is fine for the few hundred cells within reach
    let k = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i][0] < queue[k][0]) k = i;
    const [d, n] = queue.splice(k, 1)[0];
    if (d > (best.get(n) ?? Infinity)) continue;
    const p = cellPos(g, n);
    const lv: Level = n >= N ? 1 : 0;
    // hidden, and not right next to the threat (cover is no use with the enemy standing in it)
    // hidden even a step off the exact spot (arriving is never exact), and not right next to the threat
    const hidden = (x: number, z: number) => !hasLOS({ x, z }, threat, arena, lv, threatLv);
    if (g.open[n] === 1 && dist(p, threat) > 4 && dist(p, threat) <= maxThreatDist && (!avoid || dist(p, avoid) > 3) && hidden(p.x, p.z) && hidden(p.x + 0.8, p.z) && hidden(p.x - 0.8, p.z) && hidden(p.x, p.z + 0.8) && hidden(p.x, p.z - 0.8)) {
      return { point: p, level: lv, walk: d };
    }
    for (const e of g.out[n]) {
      const nd = d + e.cost;
      if (nd > maxWalk || nd >= (best.get(e.to) ?? Infinity)) continue;
      best.set(e.to, nd);
      queue.push([nd, e.to]);
    }
  }
  return null;
}
export { walksBetween as __walks };
