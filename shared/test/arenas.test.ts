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

describe('jumping', () => {
  it('is cosmetic: height follows the curve, ground position is untouched, and it needs a fresh request', async () => {
    const { ArenaSim, JUMP_HEIGHT, JUMP_MS, jumpHeight, TUNING } = await import('../src/index');
    assert.equal(jumpHeight(0), 0);
    assert.equal(jumpHeight(JUMP_MS), 0);
    assert.ok(Math.abs(jumpHeight(JUMP_MS / 2) - JUMP_HEIGHT) < 1e-9);

    const sim = new ArenaSim({ prepMs: 0, seed: 1 });
    const u = sim.addUnit({ name: 'J', classId: 'rogue', team: 0, controller: 'player' });
    sim.addUnit({ name: 'T', classId: 'warrior', team: 1, controller: 'dummy' });
    const at = () => sim.snapshot().units.find((x) => x.id === u.id)!;
    for (let i = 0; i < 3; i++) sim.step();
    const x0 = at().x;
    sim.queueInput(u.id, { seq: 1, fwd: 0, strafe: 0, facing: u.facing, jump: true });
    sim.step();
    let peak = 0;
    const ticks = Math.ceil(JUMP_MS / TUNING.tickMs) + 2;
    for (let i = 0; i < ticks; i++) {
      peak = Math.max(peak, at().y);
      sim.step();
    }
    assert.ok(peak > JUMP_HEIGHT * 0.9, `peaked at ${peak}`);
    assert.equal(at().y, 0, 'landed');
    assert.equal(at().x, x0, 'no ground movement from jumping');
    // the late-packet repeat of the same input must not start another jump
    for (let i = 0; i < 6; i++) sim.step();
    assert.equal(at().y, 0);
  });

  it('cannot jump while stunned or dead', async () => {
    const { ArenaSim } = await import('../src/index');
    const sim = new ArenaSim({ prepMs: 0, seed: 2 });
    const u = sim.addUnit({ name: 'J', classId: 'rogue', team: 0, controller: 'player' });
    sim.addUnit({ name: 'T', classId: 'warrior', team: 1, controller: 'dummy' });
    for (let i = 0; i < 3; i++) sim.step();
    u.alive = false;
    sim.queueInput(u.id, { seq: 1, fwd: 0, strafe: 0, facing: 0, jump: true });
    for (let i = 0; i < 4; i++) sim.step();
    assert.equal(sim.snapshot().units.find((x) => x.id === u.id)!.y, 0);
  });
});
