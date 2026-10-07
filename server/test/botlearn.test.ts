import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store';
import { BotLearner } from '../src/botlearn';

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
});
