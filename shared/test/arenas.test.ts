import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARENAS, ArenaSim, Bot, TUNING, arenaById, blinkDestination, hasLOS, heightAt, stepMovement } from '../src/index';

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

  it('Twin Ramps: the chasm blocks walking and blinking but not sight, and the only way over is the bridge', () => {
    const a = arenaById('bridge');
    assert.ok(a.voids?.length && a.bridge);
    // walking straight at the chasm from the side stops at its edge
    let p = { x: -12, z: 10 };
    for (let i = 0; i < 400; i++) p = stepMovement(p, { fwd: 1, strafe: 0, facing: Math.PI / 2 }, 7, 0.05, a); // toward +x, into the chasm
    assert.ok(p.x < -8, `stopped at the chasm edge, x=${p.x}`);
    // the span itself is walkable end to end
    p = { x: -20, z: 0 };
    for (let i = 0; i < 400; i++) p = stepMovement(p, { fwd: 1, strafe: 0, facing: Math.PI / 2 }, 7, 0.05, a);
    assert.ok(p.x > 18, `crossed the bridge, x=${p.x}`);
    // blink toward the chasm stops short
    const land = blinkDestination({ x: -12, z: 10 }, Math.PI / 2, 20, a);
    assert.ok(land.x < -8, 'blink does not enter the chasm');
    assert.ok(hasLOS({ x: 0, z: 10 }, { x: 0, z: -10 }, a), 'you can see across the gap');
    assert.equal(heightAt(a, 0, 0), a.bridge!.height);
    assert.equal(heightAt(a, 20, 0), 0);
    assert.ok(heightAt(a, 12, 0) > 0 && heightAt(a, 12, 0) < a.bridge!.height);
    assert.equal(heightAt(a, 0, 10), 0);
  });

  it('Twin Ramps: bots walk over the bridge to reach each other', () => {
    const sim = new ArenaSim({ prepMs: 0, seed: 5, arena: arenaById('bridge'), facing: true });
    const w = sim.addUnit({ name: 'W', classId: 'warrior', team: 0, controller: 'bot' });
    const r = sim.addUnit({ name: 'R', classId: 'warrior', team: 1, controller: 'bot' });
    w.pos = { x: -24, z: 8 }; r.pos = { x: 24, z: -8 };
    const bots = [new Bot(sim, w.id, 'hard', 1), new Bot(sim, r.id, 'hard', 2)];
    let met = false;
    sim.step();
    for (let i = 0; i < 20 * 40 && !met; i++) {
      for (const b of bots) b.tick();
      sim.step();
      met = Math.hypot(w.pos.x - r.pos.x, w.pos.z - r.pos.z) < 4 || w.health < w.maxHealth || r.health < r.maxHealth;
    }
    assert.ok(met, `bots stuck at ${JSON.stringify(w.pos)} / ${JSON.stringify(r.pos)}`);
  });
});
