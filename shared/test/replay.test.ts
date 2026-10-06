import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArenaSim, Bot, ReplayRecorder, ReplayRunner, arenaById, contentHash } from '../src';

function playMatch(seed: number) {
  const arena = arenaById('colosseum');
  const sim = new ArenaSim({ seed, prepMs: 1000, arena });
  const rec = new ReplayRecorder(sim, { arena: arena.id, seed, prepMs: 1000 });
  const a = sim.addUnit({ name: 'A', classId: 'mage', team: 0, controller: 'bot' });
  const b = sim.addUnit({ name: 'B', classId: 'warrior', team: 1, controller: 'bot' });
  const c = sim.addUnit({ name: 'C', classId: 'priest', team: 0, controller: 'bot' });
  const bots = [a, b, c].map((u, i) => new Bot(sim, u.id, 'hard', seed + i));
  const trace: string[] = [];
  for (let i = 0; i < 20 * 40 && sim.phase !== 'ended'; i++) {
    for (const bot of bots) bot.tick();
    // a human-like input with an awkward unrounded facing, plus a jump
    if (i % 7 === 0) sim.queueInput(a.id, { seq: i, fwd: 0.7071067, strafe: -0.333333, facing: 1.2345678901, jump: i % 140 === 0 });
    sim.step();
    sim.drainEvents();
    if (i % 20 === 0) trace.push(JSON.stringify(sim.snapshot().units.map((u) => [u.x, u.z, u.health, u.resource])));
  }
  return { sim, data: rec.finish([]), trace };
}

describe('replays', () => {
  it('re-running a recording reproduces the match exactly', () => {
    const { sim, data, trace } = playMatch(7);
    assert.ok(data.cmds.length > 100);
    const run = new ReplayRunner(data);
    const again: string[] = [];
    for (let i = 0; i < data.ticks; i++) {
      run.step();
      if (i % 20 === 0) again.push(JSON.stringify(run.sim.snapshot().units.map((u) => [u.x, u.z, u.health, u.resource])));
    }
    assert.ok(run.done);
    assert.deepEqual(again.slice(0, trace.length), trace);
    assert.equal(run.sim.winner, sim.winner);
    assert.equal(JSON.stringify(run.snapshot()), JSON.stringify(sim.snapshot()));
  });

  it('seeking backwards and forwards lands on the same state', () => {
    const { data } = playMatch(11);
    const run = new ReplayRunner(data);
    run.seek(400);
    const at400 = JSON.stringify(run.snapshot());
    run.seek(900);
    run.seek(400);
    assert.equal(JSON.stringify(run.snapshot()), at400);
  });

  it('the recording survives a JSON round trip and has a content hash', () => {
    const { data } = playMatch(3);
    const copy = JSON.parse(JSON.stringify(data));
    const run = new ReplayRunner(copy);
    run.seek(copy.ticks);
    assert.equal(run.sim.winner, data.winner);
    assert.match(contentHash(), /^\d+\.[a-z0-9]+$/);
    assert.equal(copy.hash, contentHash());
  });
});
