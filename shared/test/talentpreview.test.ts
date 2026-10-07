import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLASS_IDS, SPECS, compileMods, describeAbility, ABILITIES, previewTalents, sharedTier, switchTalents, talentsFor } from '../src/index';

/** A spec's card shows only talents you can see picked; switching spec keeps what the card showed. */
describe('talents on another spec', () => {
  it('tiers I and II are shared by every spec, the rest belong to one spec', () => {
    for (const c of CLASS_IDS) {
      assert.ok(sharedTier(c, 0) && sharedTier(c, 1), c);
      assert.ok(!sharedTier(c, 2), c);
    }
  });

  it('the preview never counts a talent that is not picked now', () => {
    // Warbringer with Leaping Strides; Rampager remembered Crippling Technique from last time
    const now = ['warrior_t1a', 'warrior_t2a', 'warrior_arms_t3a', '', '', ''];
    const fury = previewTalents('warrior', now, 'fury');
    assert.equal(fury[0], 'warrior_t1a');
    assert.equal(fury[1], 'warrior_t2a');
    assert.ok(fury.slice(2).every((t) => t === ''), 'a spec-only tier is never filled from memory');
    const mods = compileMods('warrior', { spec: 'fury', talents: fury, gear: {} });
    const plain = compileMods('warrior', { spec: 'fury', talents: [], gear: {} });
    // Crippling Technique (tier I, not picked) must not lengthen Hamstring's slow or speed up Pummel
    assert.deepEqual(describeAbility(ABILITIES.hamstring, mods), describeAbility(ABILITIES.hamstring, plain));
    assert.deepEqual(describeAbility(ABILITIES.pummel, mods), describeAbility(ABILITIES.pummel, plain));
    // Leaping Strides (picked) does show on Heroic Leap and Charge
    assert.notDeepEqual(describeAbility(ABILITIES.charge, mods), describeAbility(ABILITIES.charge, plain));
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
        for (let i = 2; i < tiers.length; i++) assert.equal(got[i], saved[i], `${c}/${spec.id} tier ${i + 1}`);
        assert.deepEqual(switchTalents(c, now, spec.id, null).slice(2), tiers.slice(2).map(() => ''));
      }
    }
  });
});
