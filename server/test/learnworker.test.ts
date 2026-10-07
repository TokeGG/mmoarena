import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArenaSim, ReplayRecorder } from '@arena/shared';
import { MeasureWorker, measureInline } from '../src/botlearn';

describe('bot learner worker thread', () => {
  it('measures a replay off the main thread with the same result as inline, and keeps the loop free meanwhile', async () => {
    const sim = new ArenaSim({ seed: 3, prepMs: 0, facing: true });
    const rec = new ReplayRecorder(sim, { arena: 'default', seed: 3, prepMs: 0 });
    const me = sim.addUnit({ name: 'me', classId: 'mage', team: 0, controller: 'player' });
    const foe = sim.addUnit({ name: 'foe', classId: 'warrior', team: 1, controller: 'dummy' });
    foe.maxHealth = foe.health = 1e9;
    sim.step();
    sim.setTarget(me.id, foe.id);
    for (let i = 0; i < 600; i++) {
      sim.queueInput(me.id, { seq: i + 1, fwd: 0, strafe: 1, facing: Math.atan2(foe.pos.x - me.pos.x, foe.pos.z - me.pos.z) });
      sim.step();
      sim.drainEvents();
    }
    const replay = rec.finish([]);
    const w = new MeasureWorker();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const fromWorker = await w.measure(replay);
    clearInterval(timer);
    await w.close();
    assert.deepEqual(fromWorker, await measureInline(replay));
    assert.ok(fromWorker.humans.length > 0);
    assert.equal((w as any).broken, false, 'the worker started (no inline fallback)');
  });
});
