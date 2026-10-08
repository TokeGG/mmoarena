import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLASS_IDS, SPECS, compileMods, describeAbility, ABILITIES, previewTalents, sharedTier, switchTalents, talentsFor } from '../src/index';

/** A spec's card shows only talents you can see picked; switching spec keeps what the card showed. */
describe('talents on another spec', () => {
  it('tiers I and II are shared by every spec, tier III belongs to one spec', () => {
    for (const c of CLASS_IDS) {
      assert.ok(sharedTier(c, 0) && sharedTier(c, 1), c);
      assert.ok(!sharedTier(c, 2), c);
    }
  });

  it('the preview never counts a talent that is not picked now', () => {
    // Warbringer picked in Arms; Fury's card must show only the shared tiers
    const now = ['warrior_t1a', 'warrior_t2a', 'warrior_arms_t3a', '', ''];
    const fury = previewTalents('warrior', now, 'fury');
    assert.equal(fury[0], 'warrior_t1a');
    assert.equal(fury[1], 'warrior_t2a');
    assert.equal(fury[2], '', 'a spec-only tier is never filled from memory');
    const mods = compileMods('warrior', { spec: 'fury', talents: fury, gear: {} });
    const plain = compileMods('warrior', { spec: 'fury', talents: [], gear: {} });
    assert.deepEqual(mods, compileMods('warrior', { spec: 'fury', talents: ['warrior_t1a', 'warrior_t2a'], gear: {} }));
    assert.notDeepEqual(mods, plain);
    // the Arms-only pick is not counted on Fury's skills
    assert.deepEqual(describeAbility(ABILITIES.hamstring, mods), describeAbility(ABILITIES.hamstring, compileMods('warrior', { spec: 'fury', talents: ['warrior_t1a', 'warrior_t2a'], gear: {} })));
  });

  it('switching keeps the shared picks you see (even "none") and brings back that spec\'s own tiers', () => {
    for (const c of CLASS_IDS) {
      for (const spec of SPECS[c]) {
        const tiers = talentsFor(c, spec.id);
        const saved = tiers.map((t, i) => (i === 0 ? t[1].id : t[0].id)); // remembered: a different tier I pick
        const now = ['', tiers[1][2].id]; // now: nothing in tier I, the third talent in tier II
        const got = switchTalents(c, now, spec.id, saved);
        assert.equal(got[0], '', `${c}/${spec.id}: tier I stays empty as shown`);
        assert.equal(got[1], tiers[1][2].id);
        for (let i = 2; i < tiers.length; i++) if (!sharedTier(c, i)) assert.equal(got[i], saved[i], `${c}/${spec.id} tier ${i + 1}`);
        assert.deepEqual(switchTalents(c, now, spec.id, null).slice(2), tiers.slice(2).map(() => ''));
      }
    }
  });
});
