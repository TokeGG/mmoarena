import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARENAS, ArenaSim, Bot, TUNING, arenaById, blinkDestination, hasLOS, resolveCollisions } from '../src/index';
import { navRoute } from '../src/nav';
import type { ArenaDef } from '../src/index';

const NEW = ['cinder', 'forge', 'sandstone'];
const free = (a: ArenaDef, p: { x: number; z: number }) => {
  const r = resolveCollisions(p, a);
  return Math.hypot(r.x - p.x, r.z - p.z) < 1e-6;
};

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

  it('have plenty of cover: pillars, walls, lows and a raised plinth or ledge, all inside the bounds', () => {
    for (const id of NEW) {
      const a = arenaById(id);
      const b = a.bounds;
      assert.ok(a.pillars.length >= 5, `${id}: pillars`);
      assert.ok((a.walls?.length ?? 0) >= 6, `${id}: walls`);
      assert.ok((a.lows?.length ?? 0) >= 6, `${id}: lows`);
      assert.ok(a.deck && a.deck.flats.length >= 1, `${id}: high ground`);
      for (const w of [...(a.walls ?? []), ...(a.lows ?? [])]) {
        assert.ok(w.x0 < w.x1 && w.z0 < w.z1 && w.x0 >= b.minX && w.x1 <= b.maxX && w.z0 >= b.minZ && w.z1 <= b.maxZ, `${id}: solid inside bounds`);
      }
      for (let i = 0; i < a.pillars.length; i++)
        for (let j = i + 1; j < a.pillars.length; j++) {
          const p = a.pillars[i], q = a.pillars[j];
          assert.ok(Math.hypot(p.x - q.x, p.z - q.z) > p.r + q.r + 1.6, `${id}: pillars ${i}/${j} leave a gap`);
        }
    }
  });

  it('are fair: mirrored across both axes (pillars) and no spawn sees another team spawn', () => {
    for (const id of NEW) {
      const a = arenaById(id);
      for (const p of a.pillars) {
        const m = a.pillars.find((q) => Math.abs(q.x + p.x) < 1e-6 && Math.abs(q.z + p.z) < 1e-6 && q.r === p.r);
        assert.ok(m, `${id}: pillar (${p.x}, ${p.z}) has a point-symmetric twin`);
      }
      for (const s0 of a.spawns[0]) for (const s1 of a.spawns[1]) assert.equal(hasLOS(s0, s1, a), false, `${id}: spawns hidden from each other`);
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

describe('bots on every arena', () => {
  for (const a of ARENAS) {
    it(`${a.id}: bot duel and a 2v2 finish and nobody sits stuck`, () => {
      // 1v1 mage against rogue always ends; the 2v2 has to keep moving and finish too
      for (const [seed, size] of [[5, 1], [5, 2]] as const) {
        const sim = new ArenaSim({ prepMs: 0, seed, arena: a });
        const units: ReturnType<ArenaSim['addUnit']>[] = [];
        const classes = size === 1 ? [['mage'], ['rogue']] : [['warrior', 'priest'], ['rogue', 'mage']];
        for (let t = 0; t < 2; t++) for (let k = 0; k < size; k++) units.push(sim.addUnit({ name: `b${t}${k}`, classId: classes[t][k] as any, team: t as 0 | 1, controller: 'bot' }));
        const bots = units.map((u, i) => new Bot(sim, u.id, 'hard', i + 1));
        const last = units.map((u) => ({ ...u.pos }));
        const idle = units.map(() => 0);
        const travelled = units.map(() => 0);
        let maxIdle = 0;
        const ticks = Math.round(240000 / TUNING.tickMs);
        let t = 0;
        for (; t < ticks && sim.winner === null; t++) {
          for (const b of bots) b.tick();
          sim.step();
          if (t % 20 === 19) {
            units.forEach((u, i) => {
              const moved = Math.hypot(u.pos.x - last[i].x, u.pos.z - last[i].z);
              last[i] = { ...u.pos };
              travelled[i] += moved;
              // stuck: alive, free to act and not casting, but not moving for a long time (healers and casters may hold still on purpose)
              if (u.alive && u.classId !== 'priest' && moved < 0.05 && !u.cast) idle[i]++;
              else idle[i] = 0;
              maxIdle = Math.max(maxIdle, idle[i]);
            });
          }
        }
        assert.ok(sim.winner !== null, `${a.id}: the match finished within 4 minutes (t=${t})`);
        assert.ok(travelled.every((d, i) => units[i].classId === 'priest' || d > 40), `${a.id} ${size}v${size}: every bot covered ground (${travelled.map((d) => Math.round(d)).join(', ')})`);
        assert.ok(maxIdle < 12, `${a.id} ${size}v${size}: nobody stood still for ${maxIdle} s`);
      }
    });
  }
});
