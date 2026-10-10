import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArenaSim, TUNING, arenaById, dist, jumpHeight, stepMovementL, JUMP_MS, canStartJump } from '../src/index';
import type { ArenaDef } from '../src/index';

/**
 * Jumping onto, over and off the walkway deck's ledges (rails, ramp sides) must be smooth: a unit never pops further in one
 * tick than it can run, and the result does not depend on the length of a tick (the server runs 16 ms, the default is 50).
 */
const TICKS = [16, 50];
const SPEED = TUNING.runSpeed;

/** Walk a unit with one input per tick (jumping at `jumpMs`), returning its end state and the longest single step. */
function walk(arena: ArenaDef, tickMs: number, x: number, z: number, lv: 0 | 1, facing: number, jumpMs: number | null, ms = 2500) {
  const sim = new ArenaSim({ seed: 1, prepMs: 0, arena, tickMs });
  const u = sim.addUnit({ name: 'a', classId: 'warrior', team: 0, controller: 'dummy' });
  const f = sim.addUnit({ name: 'f', classId: 'warrior', team: 1, controller: 'dummy' });
  sim.step();
  const U = sim.units.get(u.id)!;
  sim.units.get(f.id)!.pos = { x: arena.bounds.maxX - 1, z: arena.bounds.maxZ - 1 };
  U.pos = { x, z };
  U.level = lv;
  let prev = { ...U.pos };
  let maxStep = 0;
  const n = Math.round(ms / tickMs);
  const jt = jumpMs === null ? -1 : Math.round(jumpMs / tickMs);
  for (let t = 0; t < n; t++) {
    sim.queueInput(u.id, { seq: t + 1, fwd: 1, strafe: 0, facing, jump: t === jt ? true : undefined });
    sim.step();
    maxStep = Math.max(maxStep, dist(prev, U.pos));
    prev = { ...U.pos };
  }
  return { pos: { ...U.pos }, level: U.level as number, maxStep };
}

describe('ledges', () => {
  for (const tickMs of TICKS) {
    const limit = SPEED * (tickMs / 1000) + 1e-6;

    it(`landing on a deck rail does not pop the unit back or forward (${tickMs} ms)`, () => {
      const arena = arenaById('overlook'); // flat x -6..6, rail along its +x edge
      for (let jm = 0; jm <= 900; jm += 10) {
        const r = walk(arena, tickMs, 0, 0, 1, Math.PI / 2, jm);
        assert.ok(r.maxStep <= limit, `jump at ${jm} ms popped ${r.maxStep.toFixed(2)} yd in one tick (limit ${limit.toFixed(2)})`);
      }
    });

    it(`jumping over the rail from the deck lands on the ground, whatever the timing (${tickMs} ms)`, () => {
      const arena = arenaById('overlook');
      // a jump started 300..500 ms into the walk clears the rail; the unit ends on the ground beyond the deck
      for (let jm = 330; jm <= 500; jm += 10) {
        const r = walk(arena, tickMs, 0, 0, 1, Math.PI / 2, jm);
        assert.equal(r.level, 0, `jump at ${jm} ms`);
        assert.ok(r.pos.x > 7, `jump at ${jm} ms ended at x=${r.pos.x.toFixed(2)}`);
      }
    });

    it(`stepping onto a ramp's low side does not shove the unit (${tickMs} ms)`, () => {
      const arena = arenaById('overlook'); // ramp x -2.5..2.5, z -13..-5, foot at z=-13, rail starts where the slope passes the step height
      for (let z = -12.9; z <= -11.1; z += 0.1) {
        for (const lead of [0, 0.1, -0.1]) {
          const r = walk(arena, tickMs, -8, z, 0, Math.PI / 2 + lead, null, 1800);
          assert.ok(r.maxStep <= limit + 0.005, `from z=${z.toFixed(1)} lead ${lead}: popped ${r.maxStep.toFixed(2)} yd in one tick (limit ${limit.toFixed(2)})`);
        }
      }
    });

    it(`a unit that came down inside a rail is eased out, never carried along it (${tickMs} ms)`, () => {
      const arena = arenaById('overlook'); // the ramp z -13..-5, x -2.5..2.5: its +x side has a rail from about z=-12 up
      let pos = { x: 2.8, z: -9 }; // inside the rail's reach (it stands at x 2.5..2.9)
      let level: 0 | 1 = 1;
      let worst = 0;
      for (let t = 0; t < Math.round(1500 / tickMs); t++) {
        const r = stepMovementL(pos, level, { fwd: 1, strafe: 0, facing: 0 }, SPEED, tickMs / 1000, arena, 0); // walking along the rail (toward +z)
        worst = Math.max(worst, dist(pos, r.pos));
        pos = r.pos;
        level = r.level;
      }
      assert.ok(worst <= SPEED * (tickMs / 1000) + 1e-6, `moved ${worst.toFixed(2)} in one tick`);
      assert.ok(level === 0 || pos.x > 3.4, `still riding the rail at x=${pos.x.toFixed(2)}`);
    });

    it(`the same walk and jump gives the same outcome at any tick length (${tickMs} ms)`, () => {
      // jumping down off the deck's edge near a ramp's side: ends on the ground at both tick lengths
      const arena = arenaById('frost');
      const a = walk(arena, tickMs, 0, 0, 1, Math.PI / 2, 350);
      assert.equal(a.level, 0);
      assert.ok(a.pos.x > 3);
    });
  }

  it('the jump arc and the gap between jumps are in whole ticks at both tick lengths', () => {
    assert.equal(jumpHeight(0), 0);
    assert.equal(jumpHeight(JUMP_MS), 0);
    for (const tickMs of TICKS) {
      const ticks = Math.ceil((JUMP_MS + 40) / tickMs); // the first input a jump can follow the last one with
      assert.ok(canStartJump(ticks * tickMs) && !canStartJump((ticks - 1) * tickMs), `${tickMs} ms`);
    }
  });
});
