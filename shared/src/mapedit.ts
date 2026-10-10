import { ARENAS } from './data';
import { ArenaSim } from './sim';
import { Bot } from './bot';
import { inLava, onRaised, resolveCollisions } from './geometry';
import { navRoute } from './nav';
import type { ArenaDef, Rect, Vec2 } from './types';

/**
 * Custom maps (the owner's map editor). `cleanCustomArena` turns whatever came in (a browser, the store) into a clean
 * ArenaDef or says in plain words what is wrong; `checkReach` walks the map the way bots do. The server runs both before
 * it keeps a map, the editor runs the first on every edit. Custom maps never change the built-in content hash.
 */

export const MAP_LIMITS = {
  /** At most this many custom maps are kept. */
  maps: 40,
  minSpan: 28,
  maxSpan: 100,
  minDepth: 20,
  maxDepth: 80,
  pillars: 24,
  walls: 24,
  lows: 24,
  flats: 12,
  ramps: 12,
  piers: 12,
  spawnsPerTeam: 3,
  pillarR: [0.6, 6] as const,
  rectMin: 0.5,
  rectMax: 70,
  deckHeight: [1.5, 5] as const,
  rampLength: [3, 16] as const,
  rampWidth: 2,
  nameMax: 40,
  descMax: 300,
};

/** The art themes the client dresses an arena with (the first is the default). */
export const ARENA_THEMES = ['colosseum', 'ruins', 'frost', 'cinder', 'forge', 'sandstone'] as const;
export const CUSTOM_ID_RE = /^[a-z][a-z0-9-]{2,23}$/;

export interface MapCheck {
  /** The cleaned map (numbers rounded, unknown fields dropped, route points worked out), or null when it cannot be read at all. It can be set while `problems` is not empty (geometry problems): only a map with no problems may be kept. */
  arena: ArenaDef | null;
  /** Reasons the map cannot be saved. */
  problems: string[];
  /** Things worth a look that do not stop saving. */
  warnings: string[];
}

const round = (v: number) => Math.round(v * 100) / 100;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A readable one-line text: markup and control characters out. */
export const cleanMapText = (s: unknown, max: number): string => String(s ?? '').replace(/[<>&"`\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

/** A starting point for a new map: an open field with three start spots per team. */
export function blankArena(id = 'my-map', name = 'My map'): ArenaDef {
  return {
    id,
    name,
    theme: 'colosseum',
    desc: '',
    bounds: { minX: -30, maxX: 30, minZ: -20, maxZ: 20 },
    pillars: [{ x: -8, z: -6, r: 2 }, { x: 8, z: 6, r: 2 }],
    spawns: [[{ x: -24, z: -3 }, { x: -24, z: 3 }, { x: -26, z: 0 }], [{ x: 24, z: 3 }, { x: 24, z: -3 }, { x: 26, z: 0 }]],
    spawnFacing: [Math.PI / 2, -Math.PI / 2],
    gateX: 20,
  };
}

/** A copy of any arena to start from (deep, so editing it never touches the built-in). */
export const copyArena = (a: ArenaDef, id: string, name: string): ArenaDef => ({ ...(JSON.parse(JSON.stringify(a)) as ArenaDef), id, name, randomPool: undefined });

/**
 * Check and clean a custom map. `others` are the other custom maps (their ids and names are taken). Everything the sim
 * would trip over is a problem: a non-number, a spawn inside a wall, a ramp that leads nowhere, a piece outside the bounds.
 */
export function cleanCustomArena(raw: unknown, others: readonly ArenaDef[] = []): MapCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  const fail = (): MapCheck => ({ arena: null, problems, warnings });
  if (!isObj(raw)) {
    problems.push('The map is not an object.');
    return fail();
  }
  const L = MAP_LIMITS;
  const num = (v: unknown, what: string, lo: number, hi: number): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      problems.push(`${what} is not a number.`);
      return 0;
    }
    if (v < lo || v > hi) problems.push(`${what} must be between ${lo} and ${hi} (it is ${round(v)}).`);
    return round(v);
  };

  // --- id, name, theme, text
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!CUSTOM_ID_RE.test(id)) problems.push('The id needs 3 to 24 characters: a-z, 0-9 and dashes, starting with a letter.');
  else if (id === 'random') problems.push('"random" is reserved. Pick another id.');
  else if (ARENAS.some((a) => a.id === id)) problems.push(`The id "${id}" is a built-in map.`);
  else if (others.some((a) => a.id === id)) problems.push(`Another custom map already uses the id "${id}".`);
  const name = cleanMapText(raw.name, L.nameMax);
  if (name.length < 3) problems.push('The name needs at least 3 characters.');
  else if (ARENAS.some((a) => a.name.toLowerCase() === name.toLowerCase()) || others.some((a) => a.id !== id && a.name.toLowerCase() === name.toLowerCase())) problems.push(`The name "${name}" is taken: names are the labels in the pickers.`);
  const theme = typeof raw.theme === 'string' && (ARENA_THEMES as readonly string[]).includes(raw.theme) ? raw.theme : null;
  if (!theme) problems.push(`The theme must be one of: ${ARENA_THEMES.join(', ')}.`);
  const desc = cleanMapText(raw.desc, L.descMax);

  // --- bounds
  const rb = isObj(raw.bounds) ? raw.bounds : {};
  if (!isObj(raw.bounds)) problems.push('The bounds are missing.');
  const bounds = { minX: num(rb.minX, 'minX', -60, -10), maxX: num(rb.maxX, 'maxX', 10, 60), minZ: num(rb.minZ, 'minZ', -45, -8), maxZ: num(rb.maxZ, 'maxZ', 8, 45) };
  const spanX = bounds.maxX - bounds.minX, spanZ = bounds.maxZ - bounds.minZ;
  if (spanX < L.minSpan || spanX > L.maxSpan) problems.push(`The map must be ${L.minSpan} to ${L.maxSpan} yards long (it is ${round(spanX)}).`);
  if (spanZ < L.minDepth || spanZ > L.maxDepth) problems.push(`The map must be ${L.minDepth} to ${L.maxDepth} yards wide (it is ${round(spanZ)}).`);
  const inside = (x: number, z: number, m = 0) => x >= bounds.minX + m && x <= bounds.maxX - m && z >= bounds.minZ + m && z <= bounds.maxZ - m;
  const gateMax = Math.min(-bounds.minX, bounds.maxX) - 2;
  const gateX = num(raw.gateX, 'The start gate (gateX)', 4, Math.max(4, gateMax));

  // --- spawns
  const spawns: Vec2[][] = [[], []];
  if (!Array.isArray(raw.spawns) || raw.spawns.length !== 2) problems.push('There must be spawns for both teams.');
  else
    for (const team of [0, 1]) {
      const list = raw.spawns[team];
      if (!Array.isArray(list) || list.length !== L.spawnsPerTeam) {
        problems.push(`Team ${team + 1} needs exactly ${L.spawnsPerTeam} start spots.`);
        continue;
      }
      list.forEach((s: unknown, i: number) => {
        const o = isObj(s) ? s : {};
        const p = { x: num(o.x, `Team ${team + 1} spawn ${i + 1} x`, -200, 200), z: num(o.z, `Team ${team + 1} spawn ${i + 1} z`, -200, 200) };
        spawns[team].push(p);
        if (!inside(p.x, p.z, 1.2)) problems.push(`Team ${team + 1} spawn ${i + 1} is outside the map (keep 1.2 yards from the edge).`);
        else if (team === 0 ? p.x > -gateX : p.x < gateX) problems.push(`Team ${team + 1} spawn ${i + 1} must be behind its start gate (${team === 0 ? 'x at most -' : 'x at least '}${gateX}).`);
      });
    }
  const facing = Array.isArray(raw.spawnFacing) && raw.spawnFacing.length === 2 ? [0, 1].map((i) => num((raw.spawnFacing as unknown[])[i], `Spawn facing ${i + 1}`, -7, 7)) : (problems.push('spawnFacing needs two angles (one per team).'), [Math.PI / 2, -Math.PI / 2]);

  // --- shapes
  const rect = (v: unknown, what: string): Rect | null => {
    if (!isObj(v)) {
      problems.push(`${what} is not a box.`);
      return null;
    }
    const r = { x0: num(v.x0, `${what} x0`, -200, 200), x1: num(v.x1, `${what} x1`, -200, 200), z0: num(v.z0, `${what} z0`, -200, 200), z1: num(v.z1, `${what} z1`, -200, 200) };
    if (r.x0 > r.x1) [r.x0, r.x1] = [r.x1, r.x0];
    if (r.z0 > r.z1) [r.z0, r.z1] = [r.z1, r.z0];
    if (r.x1 - r.x0 < L.rectMin || r.z1 - r.z0 < L.rectMin) problems.push(`${what} is too small (at least ${L.rectMin} yards each way).`);
    else if (r.x1 - r.x0 > L.rectMax || r.z1 - r.z0 > L.rectMax) problems.push(`${what} is too big (at most ${L.rectMax} yards each way).`);
    else if (r.x0 < bounds.minX - 1e-6 || r.x1 > bounds.maxX + 1e-6 || r.z0 < bounds.minZ - 1e-6 || r.z1 > bounds.maxZ + 1e-6) problems.push(`${what} reaches outside the map.`);
    return r;
  };
  const list = (v: unknown, what: string, max: number): unknown[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      problems.push(`${what} is not a list.`);
      return [];
    }
    if (v.length > max) {
      problems.push(`Too many ${what} (${v.length}, at most ${max}).`);
      return [];
    }
    return v;
  };
  const rects = (v: unknown, what: string, max: number): Rect[] => list(v, what, max).flatMap((x, i) => { const r = rect(x, `${what} ${i + 1}`); return r ? [r] : []; });

  const pillars = list(raw.pillars, 'pillars', L.pillars).flatMap((v, i) => {
    const o = isObj(v) ? v : {};
    const what = `Pillar ${i + 1}`;
    const p = { x: num(o.x, `${what} x`, -200, 200), z: num(o.z, `${what} z`, -200, 200), r: num(o.r, `${what} radius`, L.pillarR[0], L.pillarR[1]) };
    if (!inside(p.x - p.r, p.z - p.r) || !inside(p.x + p.r, p.z + p.r)) problems.push(`${what} reaches outside the map.`);
    return [p];
  });
  const walls = rects(raw.walls, 'Wall', L.walls);
  const lowRaw = list(raw.lows, 'low walls', L.lows);
  const lows = lowRaw.flatMap((v, i) => {
    const r = rect(v, `Low wall ${i + 1}`);
    return r ? [{ ...r, ...(isObj(v) && v.lava === true ? { lava: true as const } : {}) }] : [];
  });

  let deck: ArenaDef['deck'];
  if (raw.deck !== undefined && raw.deck !== null) {
    if (!isObj(raw.deck)) problems.push('The walkway (deck) is not an object.');
    else {
      const d = raw.deck;
      const height = num(d.height, 'The walkway height', L.deckHeight[0], L.deckHeight[1]);
      const flats = rects(d.flats, 'Walkway flat', L.flats);
      const ramps = list(d.ramps, 'ramps', L.ramps).flatMap((v, i) => {
        const r = rect(v, `Ramp ${i + 1}`);
        const rise = isObj(v) ? v.rise : undefined;
        if (!r) return [];
        if (rise !== '+x' && rise !== '-x' && rise !== '+z' && rise !== '-z') {
          problems.push(`Ramp ${i + 1} needs a rise of +x, -x, +z or -z.`);
          return [];
        }
        return [{ ...r, rise: rise as '+x' | '-x' | '+z' | '-z' }];
      });
      const piers = d.piers === undefined ? undefined : rects(d.piers, 'Pier', L.piers);
      deck = { height, flats, ramps, ...(piers ? { piers } : {}) };
      if (!flats.length && ramps.length) problems.push('Ramps need a walkway flat at the top.');
      ramps.forEach((r, i) => {
        const along = r.rise === '+x' || r.rise === '-x' ? 'x' : 'z';
        const len = along === 'x' ? r.x1 - r.x0 : r.z1 - r.z0;
        const wide = along === 'x' ? r.z1 - r.z0 : r.x1 - r.x0;
        if (len < L.rampLength[0] || len > L.rampLength[1]) problems.push(`Ramp ${i + 1} must be ${L.rampLength[0]} to ${L.rampLength[1]} yards long in its climbing direction (it is ${round(len)}).`);
        if (wide < L.rampWidth) problems.push(`Ramp ${i + 1} must be at least ${L.rampWidth} yards wide.`);
        // the high end must meet a flat
        const top = r.rise === '+x' ? r.x1 : r.rise === '-x' ? r.x0 : r.rise === '+z' ? r.z1 : r.z0;
        const meets = flats.some((f) => {
          if (along === 'x') return Math.abs((r.rise === '+x' ? f.x0 : f.x1) - top) <= 0.15 && Math.min(f.z1, r.z1) - Math.max(f.z0, r.z0) >= 1.5;
          return Math.abs((r.rise === '+z' ? f.z0 : f.z1) - top) <= 0.15 && Math.min(f.x1, r.x1) - Math.max(f.x0, r.x0) >= 1.5;
        });
        if (!meets) problems.push(`Ramp ${i + 1} does not connect: its high end (${r.rise}) must touch a walkway flat for at least 1.5 yards.`);
      });
    }
  }

  if (problems.length) return fail();

  const base: ArenaDef = {
    id,
    name,
    theme: theme!,
    desc,
    bounds,
    pillars,
    spawns,
    spawnFacing: facing,
    gateX,
    ...(deck ? { deck } : {}),
    ...(lows.length ? { lows } : {}),
    ...(walls.length ? { walls } : {}),
  };
  base.nav = autoNav(base);
  const arena = base;

  // --- spawns and solids
  const free = (p: Vec2) => {
    const r = resolveCollisions(p, arena);
    return Math.hypot(r.x - p.x, r.z - p.z) < 1e-6;
  };
  spawns.forEach((side, team) => side.forEach((p, i) => {
    if (!free(p)) problems.push(`Team ${team + 1} spawn ${i + 1} is inside a pillar, wall, ramp, pier or barricade.`);
    else if (inLava(arena, p)) problems.push(`Team ${team + 1} spawn ${i + 1} is in lava.`);
  }));
  spawns[0].forEach((a, i) => spawns[0].forEach((b, j) => { if (j > i && Math.hypot(a.x - b.x, a.z - b.z) < 1.5) problems.push(`Team 1 spawns ${i + 1} and ${j + 1} are on top of each other.`); }));
  spawns[1].forEach((a, i) => spawns[1].forEach((b, j) => { if (j > i && Math.hypot(a.x - b.x, a.z - b.z) < 1.5) problems.push(`Team 2 spawns ${i + 1} and ${j + 1} are on top of each other.`); }));

  // --- walkway pieces are not built over pillars and walls (they would hide under the deck)
  if (deck) {
    const under: Rect[] = [...deck.flats, ...deck.ramps];
    for (const p of pillars) for (const r of under) {
      const dx = Math.max(r.x0 - p.x, 0, p.x - r.x1), dz = Math.max(r.z0 - p.z, 0, p.z - r.z1);
      if (Math.hypot(dx, dz) <= p.r + 0.4) problems.push(`The pillar at (${p.x}, ${p.z}) stands under a walkway or ramp. Move it.`);
    }
    for (const w of walls) for (const r of under) if (!(w.x1 <= r.x0 || w.x0 >= r.x1 || w.z1 <= r.z0 || w.z0 >= r.z1)) problems.push(`The wall at (${w.x0}, ${w.z0}) is under a walkway or ramp. Move it.`);
    for (const f of deck.flats) {
      const touches = (r: Rect) => !(r.x1 < f.x0 - 0.05 || r.x0 > f.x1 + 0.05 || r.z1 < f.z0 - 0.05 || r.z0 > f.z1 + 0.05);
      if (!deck.ramps.some(touches) && !deck.flats.some((g) => g !== f && touches(g))) warnings.push(`The walkway flat at (${f.x0}, ${f.z0}) has no ramp: it can only be reached by jumping from a ledge.`);
    }
    if (deck.piers) for (const pr of deck.piers) if (!deck.flats.some((f) => !(pr.x1 <= f.x0 || pr.x0 >= f.x1 || pr.z1 <= f.z0 || pr.z0 >= f.z1))) warnings.push(`The pier at (${pr.x0}, ${pr.z0}) holds up nothing.`);
  }
  // --- cover
  if (pillars.length + walls.length + (lows.length ? 1 : 0) + (deck ? 1 : 0) === 0) warnings.push('There is no cover at all: nobody can break line of sight.');
  for (const lo of lows) if (lo.lava && spawns.flat().some((s) => s.x > lo.x0 - 3 && s.x < lo.x1 + 3 && s.z > lo.z0 - 3 && s.z < lo.z1 + 3)) warnings.push('A lava pit is right next to a start spot.');
  if (!desc) warnings.push('There is no description.');
  const sym = spawns[0].every((s, i) => spawns[1][i] && Math.abs(s.x + spawns[1][i].x) < 0.05 && Math.abs(s.z + spawns[1][i].z) < 0.05);
  if (!sym) warnings.push('The start spots are not point-symmetric between the teams (that is fine, but one side may be favoured).');
  return { arena, problems, warnings };
}

/**
 * Walking waypoints for bots on maps with walls (the walkable links are worked out from the walls): a point diagonally
 * off each wall corner, kept when it stands free. Maps with only pillars, barricades or a walkway need none.
 */
export function autoNav(a: ArenaDef): Vec2[] {
  const out: Vec2[] = [];
  const M = 1.7;
  const free = (p: Vec2) => {
    const r = resolveCollisions(p, a);
    return Math.hypot(r.x - p.x, r.z - p.z) < 1e-6 && !onRaised(a, p.x, p.z) && !inLava(a, p);
  };
  for (const w of a.walls ?? [])
    for (const [cx, cz, sx, sz] of [[w.x0, w.z0, -1, -1], [w.x1, w.z0, 1, -1], [w.x0, w.z1, -1, 1], [w.x1, w.z1, 1, 1]] as const) {
      const p = { x: round(cx + sx * M), z: round(cz + sz * M) };
      if (free(p) && !out.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 1)) out.push(p);
    }
  return out.slice(0, 96);
}

/**
 * Can both teams walk everywhere? The same check the built-in maps pass: from a spawn of each team there is a route to every
 * standing spot on a two-yard grid (coarser on big maps), on the ground and up on the walkway, and to the middle of every
 * flat and ramp. Returns plain-language problems (empty: fine). It takes a moment on a big map, so the editor runs it on demand.
 */
export function checkReach(a: ArenaDef): string[] {
  const out: string[] = [];
  const b = a.bounds;
  const step = Math.max(2, Math.sqrt(((b.maxX - b.minX) * (b.maxZ - b.minZ)) / 350));
  const free = (p: Vec2) => {
    const r = resolveCollisions(p, a);
    return Math.hypot(r.x - p.x, r.z - p.z) < 1e-6;
  };
  const bad: string[] = [];
  let checked = 0;
  for (let x = b.minX + 1.5; x < b.maxX; x += step)
    for (let z = b.minZ + 1.5; z < b.maxZ; z += step) {
      const p = { x, z };
      const lv = onRaised(a, x, z) && free(p) ? 1 : 0;
      if (lv === 0 && (!free(p) || inLava(a, p))) continue;
      checked++;
      for (const team of [0, 1]) if (!navRoute(a, a.spawns[team][0], 0, p, lv as 0 | 1)) bad.push(`(${round(x)}, ${round(z)})${lv ? ' up on the walkway' : ''} from team ${team + 1}`);
    }
  if (checked < 60) out.push('There is hardly any open ground to stand on.');
  if (bad.length) out.push(`${bad.length} spot${bad.length === 1 ? '' : 's'} cannot be walked to, for example ${bad.slice(0, 3).join('; ')}. Open a path (a pillar or wall may seal a pocket off, or a walkway has no ramp).`);
  if (a.deck) {
    for (const f of [...a.deck.flats, ...a.deck.ramps]) {
      const mid = { x: (f.x0 + f.x1) / 2, z: (f.z0 + f.z1) / 2 };
      for (const team of [0, 1]) if (!navRoute(a, a.spawns[team][0], 0, mid, 1)) out.push(`Team ${team + 1} cannot reach the walkway piece at (${round(mid.x)}, ${round(mid.z)}).`);
    }
  }
  for (const team of [0, 1]) for (const s of a.spawns[team]) if (!navRoute(a, s, 0, a.spawns[1 - team][0], 0)) out.push(`Team ${team + 1}'s spawn at (${s.x}, ${s.z}) has no route to the other team.`);
  return [...new Set(out)];
}

/**
 * Let two bots fight on the map (1v1, hard, at the production tick) and report whether it finished and nobody stood
 * stuck. The test bench for "do bots cope with this map". `seconds` caps the simulated time.
 */
export function botSmoke(a: ArenaDef, opts: { seed?: number; seconds?: number; tickMs?: number } = {}): { finished: boolean; stuck: boolean; seconds: number } {
  const sim = new ArenaSim({ prepMs: 0, seed: opts.seed ?? 5, arena: a, tickMs: opts.tickMs ?? 16 });
  const units = [sim.addUnit({ name: 'b0', classId: 'mage', team: 0, controller: 'bot' }), sim.addUnit({ name: 'b1', classId: 'rogue', team: 1, controller: 'bot' })];
  const bots = units.map((u, i) => new Bot(sim, u.id, 'hard', i + 1));
  const perSecond = Math.round(1000 / sim.tickMs);
  const ticks = Math.round(((opts.seconds ?? 300) * 1000) / sim.tickMs);
  const last = units.map((u) => ({ ...u.pos }));
  const idle = units.map(() => 0);
  let stuck = false;
  let t = 0;
  for (; t < ticks && sim.winner === null; t++) {
    for (const bt of bots) bt.tick();
    sim.step();
    if (t % perSecond === perSecond - 1)
      units.forEach((u, i) => {
        const moved = Math.hypot(u.pos.x - last[i].x, u.pos.z - last[i].z);
        last[i] = { ...u.pos };
        idle[i] = u.alive && moved < 0.05 && !u.cast ? idle[i] + 1 : 0;
        if (idle[i] > 25) stuck = true;
      });
  }
  return { finished: sim.winner !== null, stuck, seconds: Math.round((t * sim.tickMs) / 1000) };
}

/** Which custom id to suggest for a name: lowercase words with dashes, never a built-in id or one taken. */
export function suggestMapId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 20) || 'my-map';
  const ok = (s: string) => CUSTOM_ID_RE.test(s) && !taken.includes(s) && !ARENAS.some((a) => a.id === s) && s !== 'random';
  if (ok(base)) return base;
  for (let i = 2; i < 100; i++) if (ok(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now() % 100000}`;
}
