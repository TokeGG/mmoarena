import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARENAS, ArenaSim, Bot, TUNING, arenaById, blinkDestination, deckPiers, hasLOS, inLava, onRaised, resolveCollisions } from '../src/index';
import { navRoute } from '../src/nav';
import type { ArenaDef } from '../src/index';

const NEW = ['cinder', 'forge', 'sandstone'];
const free = (a: ArenaDef, p: { x: number; z: number }) => {
  const r = resolveCollisions(p, a);
  return Math.hypot(r.x - p.x, r.z - p.z) < 1e-6;
};
const BASES = ['colosseum', 'ruins', 'frost', 'serpent', 'overlook', 'ring', 'terraces', 'cinder', 'forge', 'sandstone'];
const OPTIONS = ['', '-b', '-c'] as const;
const LETTER = { '': 'A', '-b': 'B', '-c': 'C' } as const;
type Rect = { x0: number; x1: number; z0: number; z1: number };
const twin = (r: Rect): Rect => ({ x0: -r.x1, x1: -r.x0, z0: -r.z1, z1: -r.z0 });
const same = (p: Rect, q: Rect) => ['x0', 'x1', 'z0', 'z1'].every((k) => Math.abs((p as never)[k] - (q as never)[k]) < 1e-6);
/** Pillars and standalone cover walls: what is left to break line of sight with (half walls are gone from every layout). */
const cover = (a: ArenaDef) => a.pillars.length + (a.walls?.length ?? 0);

describe('the three model arenas (cinder, forge, sandstone)', () => {
  it('are in the list with a name, a description and the random pool', () => {
    for (const id of NEW) {
      const a = ARENAS.find((x) => x.id === id)!;
      assert.ok(a, id);
      assert.ok(a.name.length > 3 && a.desc.length > 60, `${id}: name and description`);
      assert.notEqual(a.randomPool, false);
      assert.equal(a.theme, id);
    }
  });

  it('keep a good set of cover in option A: pillars, rock walls or blocks, and a raised plinth or ledge, all inside the bounds', () => {
    for (const id of NEW) {
      const a = arenaById(id);
      assert.ok(a.pillars.length >= 5, `${id}: pillars`);
      assert.ok((a.walls?.length ?? 0) >= 4, `${id}: walls`);
      assert.ok(a.deck && a.deck.flats.length >= 1, `${id}: high ground`);
    }
    for (const a of ARENAS) {
      const b = a.bounds;
      for (const w of [...(a.walls ?? []), ...(a.lows ?? [])]) {
        assert.ok(w.x0 < w.x1 && w.z0 < w.z1 && w.x0 >= b.minX && w.x1 <= b.maxX && w.z0 >= b.minZ && w.z1 <= b.maxZ, `${a.id}: solid inside bounds`);
      }
      for (let i = 0; i < a.pillars.length; i++)
        for (let j = i + 1; j < a.pillars.length; j++) {
          const p = a.pillars[i], q = a.pillars[j];
          assert.ok(Math.hypot(p.x - q.x, p.z - q.z) > p.r + q.r + 1.6, `${a.id}: pillars ${i}/${j} leave a gap`);
        }
    }
  });

  it('are blocked and open as drawn: spawns and route points stand free, solids stop Blink', () => {
    for (const a of ARENAS) {
      for (const p of [...a.spawns[0], ...a.spawns[1], ...(a.nav ?? [])]) assert.ok(free(a, p), `${a.id}: (${p.x}, ${p.z}) is free`);
    }
    for (const id of NEW) {
      const a = arenaById(id);
      const w = a.walls![0];
      const from = { x: (w.x0 + w.x1) / 2, z: w.z0 - 6 };
      const end = blinkDestination(from, 0, 14, a);
      assert.ok(end.z < w.z0 + 0.01 || !free(a, { x: from.x, z: from.z }) || Math.abs(end.z - from.z) < 14, `${id}: a wall stops Blink`);
    }
  });

  it('every arena has a walkable route between the two start yards', () => {
    for (const a of ARENAS) {
      for (const s of a.spawns[0]) {
        const r = navRoute(a, s, 0, a.spawns[1][0], 0);
        assert.ok(r, `${a.id}: route from (${s.x}, ${s.z})`);
      }
    }
  });
});

describe('map layout options (A Lighter, B Open, C Arena: test layouts of every arena)', () => {
  it('every map has three selectable options with unique ids, a letter in its name and a description', () => {
    assert.equal(ARENAS.length, BASES.length * 3);
    assert.equal(new Set(ARENAS.map((a) => a.id)).size, ARENAS.length);
    assert.equal(new Set(ARENAS.map((a) => a.name)).size, ARENAS.length, 'names are unique labels for the pickers');
    for (const base of BASES) {
      const a = arenaById(base);
      assert.equal(a.id, base, `${base} stays the id of option A (saved choices keep working)`);
      for (const o of OPTIONS) {
        const x = arenaById(base + o);
        assert.equal(x.id, base + o);
        assert.equal(x.theme, a.theme, `${x.id}: same art theme`);
        assert.ok(x.name.startsWith(a.name.split(' · ')[0]) && x.name.includes(` · ${LETTER[o]} (`), `${x.id}: label "${x.name}"`);
        assert.ok(x.desc.length > 60 && !/barricade|sandbag|snowdrift/i.test(x.desc), `${x.id}: description`);
        assert.notEqual(x.randomPool, false, `${x.id}: in the random pool`);
        assert.deepEqual(x.bounds, a.bounds);
        assert.deepEqual(x.spawns, a.spawns);
        assert.deepEqual(x.deck!.flats, a.deck!.flats, `${x.id}: same walkway`);
        assert.deepEqual(x.deck!.ramps, a.deck!.ramps);
      }
    }
  });

  it('no layout has a half wall (a low barricade) and no walkway has a pier or pillar under it, except a solid plinth', () => {
    for (const a of ARENAS) {
      for (const r of a.lows ?? []) assert.ok(r.lava, `${a.id}: only lava basins stay low`);
      const piers = deckPiers(a);
      const plinth = a.deck!.flats.length === 1 && piers.length === 1 && same(piers[0], a.deck!.flats[0]);
      assert.ok(piers.length === 0 || plinth, `${a.id}: nothing holds the walkway up but a solid plinth`);
      const under = [...a.deck!.flats, ...a.deck!.ramps];
      for (const p of a.pillars) for (const r of under) {
        const dx = Math.max(r.x0 - p.x, 0, p.x - r.x1), dz = Math.max(r.z0 - p.z, 0, p.z - r.z1);
        assert.ok(Math.hypot(dx, dz) > p.r + 0.4, `${a.id}: pillar (${p.x}, ${p.z}) is not under a walkway or ramp`);
      }
      for (const w of a.walls ?? []) for (const r of under) {
        assert.ok(w.x1 <= r.x0 || w.x0 >= r.x1 || w.z1 <= r.z0 || w.z0 >= r.z1, `${a.id}: a wall is not under a walkway or ramp`);
      }
    }
  });

  it('cover shrinks from A to B to C (C has at most 4 pillars, option A keeps the map recognisable)', () => {
    for (const base of BASES) {
      const [a, b, c] = OPTIONS.map((o) => arenaById(base + o));
      assert.ok(a.pillars.length > b.pillars.length && b.pillars.length > c.pillars.length, `${base}: pillars ${a.pillars.length} > ${b.pillars.length} > ${c.pillars.length}`);
      assert.ok(cover(a) > cover(b) && cover(b) > cover(c), `${base}: cover ${cover(a)} > ${cover(b)} > ${cover(c)}`);
      assert.ok(c.pillars.length <= 4 && (c.walls?.length ?? 0) <= 1, `${base}: C is the open one`);
      assert.ok(cover(a) <= 12, `${base}: A is lighter than before`);
    }
  });

  it('each layout is point-symmetric between the two teams: spawns, pillars, walls, lava, walkway pieces', () => {
    for (const a of ARENAS) {
      for (const i of [0, 1, 2]) {
        const s = a.spawns[0][i], t = a.spawns[1][i];
        assert.ok(Math.abs(s.x + t.x) < 1e-6 && Math.abs(s.z + t.z) < 1e-6, `${a.id}: spawn ${i} mirrored`);
      }
      for (const p of a.pillars) assert.ok(a.pillars.some((q) => Math.abs(q.x + p.x) < 1e-6 && Math.abs(q.z + p.z) < 1e-6 && q.r === p.r), `${a.id}: pillar (${p.x}, ${p.z}) has a twin`);
      for (const list of [a.walls ?? [], a.lows ?? [], a.deck!.flats, a.deck!.ramps])
        for (const r of list) assert.ok(list.some((q) => same(q, twin(r))), `${a.id}: a solid or walkway piece has a twin`);
    }
  });

  it('every standing spot is reachable on foot from both start yards, on the ground and up on the walkway', () => {
    for (const a of ARENAS) {
      const b = a.bounds;
      let checked = 0;
      for (let x = b.minX + 1.5; x < b.maxX; x += 2)
        for (let z = b.minZ + 1.5; z < b.maxZ; z += 2) {
          const p = { x, z };
          const lv = onRaised(a, x, z) && free(a, { ...p }) ? 1 : 0;
          const spot = lv === 1 ? p : p;
          if (lv === 0 && !free(a, spot)) continue; // inside a pillar, a wall, a ramp or a lava basin
          if (lv === 0 && inLava(a, spot)) continue;
          for (const team of [0, 1]) assert.ok(navRoute(a, a.spawns[team][0], 0, spot, lv as 0 | 1), `${a.id}: (${x}, ${z}) level ${lv} from team ${team}`);
          checked++;
        }
      assert.ok(checked > 150, `${a.id}: checked ${checked} spots`);
      // and the walkway: a spawn finds a route to the middle of every flat and ramp
      for (const f of [...a.deck!.flats, ...a.deck!.ramps]) {
        const mid = { x: (f.x0 + f.x1) / 2, z: (f.z0 + f.z1) / 2 };
        for (const team of [0, 1]) assert.ok(navRoute(a, a.spawns[team][0], 0, mid, 1), `${a.id}: team ${team} reaches the walkway at (${mid.x}, ${mid.z})`);
      }
    }
  });

  it('there is more open sight than before: the ground below every walkway is clear', () => {
    for (const a of ARENAS) {
      for (const f of a.deck!.flats) {
        if (deckPiers(a).length) continue; // a solid plinth
        const y = (f.z0 + f.z1) / 2;
        const x0 = f.x0 + 1.5, x1 = f.x1 - 1.5;
        if (x1 > x0 && f.x1 < a.bounds.maxX - 0.1 && f.z1 < a.bounds.maxZ - 0.1) assert.equal(hasLOS({ x: x0, z: y }, { x: x1, z: y }, a), true, `${a.id}: sight runs under the walkway`);
      }
    }
  });
});

describe('bots on every arena', () => {
  for (const a of ARENAS) {
    it(`${a.id}: bot duel and a 2v2 finish and nobody sits stuck`, () => {
      // 1v1 mage against rogue always ends; the 2v2 has to keep moving and finish too
      for (const [seed, size] of [[5, 1], [5, 2], [9, 2], [14, 1]] as const) {
        const sim = new ArenaSim({ prepMs: 0, seed, arena: a, tickMs: 16 });
        const units: ReturnType<ArenaSim['addUnit']>[] = [];
        const classes = size === 1 ? [['mage'], ['rogue']] : [['warrior', 'priest'], ['rogue', 'mage']];
        for (let t = 0; t < 2; t++) for (let k = 0; k < size; k++) units.push(sim.addUnit({ name: `b${t}${k}`, classId: classes[t][k] as any, team: t as 0 | 1, controller: 'bot' }));
        const bots = units.map((u, i) => new Bot(sim, u.id, 'hard', i + 1));
        const last = units.map((u) => ({ ...u.pos }));
        const idle = units.map(() => 0);
        const travelled = units.map(() => 0);
        const aliveSecs = units.map(() => 0); // someone who fell early had no time to cover ground
        let maxIdle = 0;
        const ticks = Math.round(360000 / sim.tickMs); // a healer outlasting a mage can take five minutes; the game's own cap is ten
        const perSecond = Math.round(1000 / sim.tickMs);
        let t = 0;
        for (; t < ticks && sim.winner === null; t++) {
          for (const b of bots) b.tick();
          sim.step();
          if (t % perSecond === perSecond - 1) {
            units.forEach((u, i) => {
              const moved = Math.hypot(u.pos.x - last[i].x, u.pos.z - last[i].z);
              last[i] = { ...u.pos };
              travelled[i] += moved;
              if (u.alive) aliveSecs[i]++;
              // stuck: alive, free to act and not casting, but not moving for a long time (healers and casters may hold still on purpose)
              if (u.alive && u.classId !== 'priest' && moved < 0.05 && !u.cast) idle[i]++;
              else idle[i] = 0;
              maxIdle = Math.max(maxIdle, idle[i]);
            });
          }
        }
        assert.ok(sim.winner !== null, `${a.id}: the match finished within 6 minutes (t=${t})`);
        assert.ok(travelled.every((d, i) => units[i].classId === 'priest' || aliveSecs[i] < 60 || d > 30), `${a.id} ${size}v${size}: every bot covered ground (${travelled.map((d) => Math.round(d)).join(', ')})`);
        assert.ok(maxIdle < 12, `${a.id} ${size}v${size}: nobody stood still for ${maxIdle} s`);
      }
    });
  }
});
