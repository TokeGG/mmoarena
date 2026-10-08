import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArenaSim, TUNING } from '../src/index';
import type { Unit } from '../src/index';

const STEP = TUNING.runSpeed * (TUNING.tickMs / 1000);

function setup() {
  const sim = new ArenaSim({ seed: 1, prepMs: 0 });
  const u: Unit = sim.addUnit({ name: 'a', classId: 'mage', team: 0 });
  sim.addUnit({ name: 'b', classId: 'mage', team: 1 }).pos = { x: 40, z: 40 };
  u.pos = { x: 0, z: 0 };
  sim.step(); // leave the first, empty tick behind
  u.pos = { x: 0, z: 0 };
  u.owed = 0;
  u.catchUp = 0;
  return { sim, u };
}
let seq = 0;
const run = (sim: ArenaSim, u: Unit) => sim.queueInput(u.id, { seq: ++seq, fwd: 1, strafe: 0, facing: 0 });
const travelled = (u: Unit) => Math.hypot(u.pos.x, u.pos.z);

describe('input catch-up', () => {
  it('a short stall (the unit kept running on the repeated input) is matched by skipping the late inputs, not moving again', () => {
    const { sim, u } = setup();
    for (let i = 0; i < 4; i++) { run(sim, u); sim.step(); } // running
    const before = travelled(u);
    for (let i = 0; i < 3; i++) sim.step(); // 3 ticks without news: the last input is repeated
    for (let i = 0; i < 4; i++) run(sim, u); // and the 4 inputs that were delayed arrive together
    sim.step();
    // 3 repeated ticks + 1 consumed input moved the unit; the 3 skipped inputs did not
    assert.ok(Math.abs(travelled(u) - before - 4 * STEP) < 1e-6, `${(travelled(u) - before) / STEP} ticks of movement`);
    assert.ok(u.inputQueue.length <= 2, `depth ${u.inputQueue.length}`);
    assert.equal(u.lastSeq, seq - u.inputQueue.length);
  });

  it('one input per tick: nothing is consumed early and the distance is exactly the ticks played', () => {
    const { sim, u } = setup();
    for (let i = 0; i < 20; i++) {
      run(sim, u);
      sim.step();
      assert.equal(u.inputQueue.length, 0);
    }
    assert.ok(Math.abs(travelled(u) - 20 * STEP) < 1e-6, `${travelled(u)} vs ${20 * STEP}`);
  });

  it('a stall followed by a burst drains the queue instead of keeping it for the rest of the match', () => {
    const { sim, u } = setup();
    for (let i = 0; i < 6; i++) { run(sim, u); sim.step(); }
    for (let i = 0; i < 9; i++) sim.step(); // 9 ticks with nothing arriving: 3 repeated, then standing still (credit builds)
    for (let i = 0; i < 5; i++) run(sim, u); // the burst (queue cap 5)
    assert.equal(u.inputQueue.length, 5);
    const lastSeq = seq;
    sim.step();
    assert.ok(u.inputQueue.length <= 2, `depth ${u.inputQueue.length}`);
    assert.ok(u.lastSeq >= lastSeq - 2);
    // and it stays drained with steady 1-per-tick traffic
    for (let i = 0; i < 20; i++) { run(sim, u); sim.step(); assert.ok(u.inputQueue.length <= 3); }
  });

  it('without a stall (no credit) a backlog is not sped up', () => {
    const { sim, u } = setup();
    for (let i = 0; i < 3; i++) run(sim, u);
    sim.step();
    assert.equal(u.inputQueue.length, 2);
  });

  it('a client flooding 3 inputs per tick moves no more than the ticks that passed', () => {
    const { sim, u } = setup();
    const N = 60;
    for (let i = 0; i < N; i++) {
      for (let k = 0; k < 3; k++) run(sim, u);
      sim.step();
    }
    assert.ok(u.inputQueue.length <= 5);
    assert.ok(travelled(u) <= N * STEP + 1e-6, `${travelled(u)} > ${N * STEP}`);
  });

  it('a client that stalls to bank credit never gets more than the elapsed time back', () => {
    const { sim, u } = setup();
    let ticks = 0;
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < 8; i++) { sim.step(); ticks++; } // stand still
      for (let i = 0; i < 5; i++) run(sim, u);
      for (let i = 0; i < 6; i++) { run(sim, u); run(sim, u); sim.step(); ticks++; }
    }
    assert.ok(travelled(u) <= ticks * STEP + 1e-6);
    // each stall repeated its last input for 3 ticks at most before standing still
    assert.ok(u.catchUp! <= 5);
  });

  it('catch-up is deterministic: the same inputs give the same position', () => {
    const play = () => {
      const { sim, u } = setup();
      seq = 0;
      for (let i = 0; i < 12; i++) sim.step();
      for (let i = 0; i < 5; i++) run(sim, u);
      for (let i = 0; i < 5; i++) { sim.step(); run(sim, u); }
      return [u.pos.x, u.pos.z, u.lastSeq];
    };
    assert.deepEqual(play(), play());
  });
});
