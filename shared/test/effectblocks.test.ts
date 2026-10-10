import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, ArenaSim, applyPatches, describeAbility, entityProblems, entityText } from '../src/index';
import type { DataPatch } from '../src/index';

const withEffects = (id: string, add: Record<string, unknown>[]): DataPatch => {
  const o = JSON.parse(entityText('abilities', id)!);
  o.effects.push(...add);
  return { file: 'abilities', id, path: ['$entity'], value: JSON.stringify(o, null, 2) };
};
function duel() {
  const sim = new ArenaSim({ seed: 9, prepMs: 0, tickMs: 16 });
  const w = sim.addUnit({ name: 'w', classId: 'warrior', team: 0, controller: 'dummy', build: { spec: 'arms', talents: [], gear: {} } });
  const e = sim.addUnit({ name: 'e', classId: 'mage', team: 1, controller: 'dummy' });
  w.pos = { x: 0, z: 0 }; e.pos = { x: 0, z: 2 };
  w.maxHealth = w.health = 1e6; e.maxHealth = e.health = 1e6;
  w.resource = 100;
  sim.step();
  return { sim, w, e };
}

describe('plain building blocks for skills: shield, damage reduction, knockback', () => {
  it('the editor accepts them', () => {
    const p = withEffects('mortal_strike', [{ type: 'shield', amount: 300, duration: 8000, self: true }, { type: 'reduction', pct: 0.2, duration: 4000, self: true }, { type: 'knockback', distance: 8 }]);
    assert.deepEqual(entityProblems('abilities', 'mortal_strike', p.value as string), []);
  });
  it('a shield on a damage skill lands on you and soaks hits', () => {
    const undo = applyPatches([withEffects('mortal_strike', [{ type: 'shield', amount: 300, duration: 8000, self: true }])]);
    try {
      const { sim, w, e } = duel();
      assert.ok(sim.useAbility(w.id, 'mortal_strike', e.id).ok);
      sim.step();
      const sh = w.auras.find((a) => a.id === 'shield');
      assert.ok(sh && sh.absorbLeft > 0, 'shielded');
      assert.ok(!e.auras.some((a) => a.id === 'shield'), 'not on the enemy');
      const hp = w.health;
      sim.dealDamage(e, w, 100, 'physical', null);
      assert.equal(w.health, hp, 'the shield soaked it');
    } finally { undo(); }
  });
  it('damage reduction takes its share off what you take, for its time only', () => {
    const undo = applyPatches([withEffects('mortal_strike', [{ type: 'reduction', pct: 0.5, duration: 1000, self: true }])]);
    try {
      const { sim, w, e } = duel();
      assert.ok(sim.useAbility(w.id, 'mortal_strike', e.id).ok);
      sim.step();
      const hp = w.health;
      sim.dealDamage(e, w, 1000, 'physical', null);
      assert.ok(hp - w.health <= 520 && hp - w.health >= 480, `took ${hp - w.health}`);
      for (let t = 0; t < 80; t++) sim.step();
      const hp2 = w.health;
      sim.dealDamage(e, w, 1000, 'physical', null);
      assert.ok(hp2 - w.health >= 990, 'full damage again');
    } finally { undo(); }
  });
  it('knockback throws the target away from you', () => {
    const undo = applyPatches([withEffects('mortal_strike', [{ type: 'knockback', distance: 6 }])]);
    try {
      const { sim, w, e } = duel();
      assert.ok(sim.useAbility(w.id, 'mortal_strike', e.id).ok);
      sim.step();
      assert.ok(e.leap, 'thrown in an arc, not pushed');
      let high = 0;
      for (let t = 0; t < 40; t++) { sim.step(); high = Math.max(high, sim.snapshot(0).units.find((u) => u.id === e.id)!.y); }
      assert.ok(high > 0.5, `it rose into the air on the way (${high})`);
      for (let t = 0; t < 60; t++) sim.step();
      assert.equal(e.leap, null, 'and came down');
      assert.ok(Math.hypot(e.pos.x - w.pos.x, e.pos.z - w.pos.z) > 6, `now ${Math.hypot(e.pos.x - w.pos.x, e.pos.z - w.pos.z).toFixed(1)} yd away`);
    } finally { undo(); }
  });
  it('the skill text says what they do', () => {
    const undo = applyPatches([withEffects('mortal_strike', [{ type: 'shield', amount: 300, duration: 8000, self: true }, { type: 'knockback', distance: 6 }])]);
    try {
      const text = JSON.stringify(describeAbility(ABILITIES.mortal_strike));
      assert.match(text, /Shields you for 300/);
      assert.match(text, /Throws the target 6 yards/);
    } finally { undo(); }
  });
});
