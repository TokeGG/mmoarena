import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store';
import { BotLearner } from '../src/botlearn';
import { ArenaSim, ReplayRecorder } from '@arena/shared';

describe('bot learner', () => {
  it('hands out brains, records results and survives a restart', async () => {
    const store = new MemoryStore();
    const a = new BotLearner(store);
    await a.whenReady();
    const pick = a.pick('rogue')!;
    assert.ok(pick.brain && pick.variantId);
    for (let i = 0; i < 5; i++) a.report('rogue', pick.variantId, true);
    await new Promise((r) => setTimeout(r, 20));
    const s = a.summary().rogue.variants.find((v) => v.id === pick.variantId)!;
    assert.equal(s.games, 5);
    const b = new BotLearner(store);
    await b.whenReady();
    assert.equal(b.summary().rogue.variants.find((v) => v.id === pick.variantId)?.games, 5, 'loaded from the store');
  });
  it('a corrupt record just starts fresh', async () => {
    const store = new MemoryStore();
    await store.set('botlearn:mage', '{nope');
    const l = new BotLearner(store);
    await l.whenReady();
    assert.ok(l.pick('mage'));
  });

  it('learns from a replay: a human variant joins the population and the style survives a restart', async () => {
    const sim = new ArenaSim({ seed: 11, prepMs: 0, facing: true });
    const rec = new ReplayRecorder(sim, { arena: 'default', seed: 11, prepMs: 0 });
    const me = sim.addUnit({ name: 'me', classId: 'mage', team: 0, controller: 'player' });
    const foe = sim.addUnit({ name: 'foe', classId: 'warrior', team: 1, controller: 'dummy' });
    foe.maxHealth = foe.health = 1e9;
    sim.step();
    sim.setTarget(me.id, foe.id);
    for (let i = 0; i < 800; i++) {
      const d = Math.hypot(foe.pos.x - me.pos.x, foe.pos.z - me.pos.z);
      sim.queueInput(me.id, { seq: i + 1, fwd: d > 20.5 ? 1 : d < 19.5 ? -1 : 0, strafe: 1, facing: Math.atan2(foe.pos.x - me.pos.x, foe.pos.z - me.pos.z) });
      sim.step();
      sim.drainEvents();
    }
    const store = new MemoryStore();
    const l = new BotLearner(store);
    await l.whenReady();
    l.learnFrom(rec.finish([]));
    assert.ok(l.summary().mage.variants.some((v) => v.id === 'human'));
    assert.ok((l.humanStyles().mage?.strafe?.value ?? 0) > 0.5);
    await new Promise((r) => setTimeout(r, 20));
    const again = new BotLearner(store);
    await again.whenReady();
    assert.ok((again.humanStyles().mage?.strafe?.weight ?? 0) > 10, 'style reloaded');
    assert.ok(again.summary().mage.variants.some((v) => v.id === 'human'));
  });
});
