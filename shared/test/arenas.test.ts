import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARENAS, ArenaSim, arenaById, hasLOS } from '../src/index';

describe('arenas', () => {
  it('has unique ids and valid layouts', () => {
    assert.ok(ARENAS.length >= 3);
    assert.equal(new Set(ARENAS.map((a) => a.id)).size, ARENAS.length);
    for (const a of ARENAS) {
      const b = a.bounds;
      for (const p of a.pillars) {
        assert.ok(p.x - p.r > b.minX && p.x + p.r < b.maxX && p.z - p.r > b.minZ && p.z + p.r < b.maxZ, `${a.id}: pillar inside bounds`);
      }
      for (let i = 0; i < a.pillars.length; i++)
        for (let j = i + 1; j < a.pillars.length; j++) {
          const p = a.pillars[i];
          const q = a.pillars[j];
          assert.ok(Math.hypot(p.x - q.x, p.z - q.z) > p.r + q.r + 1.6, `${a.id}: pillars ${i}/${j} leave a gap to walk through`);
        }
      for (const team of [0, 1]) {
        assert.ok(a.spawns[team].length >= 3);
        for (const s of a.spawns[team]) {
          assert.ok(Math.abs(s.x) > a.gateX, `${a.id}: spawn behind own gate`);
          assert.ok(s.x > b.minX && s.x < b.maxX && s.z > b.minZ && s.z < b.maxZ);
          for (const p of a.pillars) assert.ok(Math.hypot(p.x - s.x, p.z - s.z) > p.r + 1.5, `${a.id}: spawn clear of pillars`);
        }
      }
    }
  });

  it('every arena runs a match and blocks line of sight through its pillars', () => {
    for (const a of ARENAS) {
      const sim = new ArenaSim({ prepMs: 1000, seed: 3, arena: arenaById(a.id) });
      sim.addUnit({ name: 'A', classId: 'mage', team: 0, controller: 'player' });
      sim.addUnit({ name: 'B', classId: 'warrior', team: 1, controller: 'player' });
      for (let i = 0; i < 40; i++) sim.step();
      assert.equal(sim.arena.id, a.id);
      const p = a.pillars[0];
      assert.equal(hasLOS({ x: p.x - p.r - 2, z: p.z }, { x: p.x + p.r + 2, z: p.z }, a), false, `${a.id}: pillar blocks sight`);
    }
  });

  it('unknown ids fall back to the default arena', () => {
    assert.equal(arenaById('nope').id, ARENAS[0].id);
  });
});
