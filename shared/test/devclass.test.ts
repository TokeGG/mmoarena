import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArenaSim, CLASSES, SPECS, TALENTS, applyPatches, currentValue, tunableNumbers, validPatch, skillInfo } from '../src/index';

describe('dev tuning of classes, specs and talents', () => {
  it('a class, a spec and a talent number can be patched, in every copy of the talent, and put back', () => {
    const copies = Object.values(TALENTS.warrior).flatMap((t) => t.flat()).filter((t) => t.id === 'warrior_t2b');
    assert.ok(copies.length >= 3);
    const hp = CLASSES.warrior.maxHealth;
    const undo = applyPatches([
      { file: 'classes', id: 'warrior', path: ['maxHealth'], value: 5000 },
      { file: 'specs', id: 'arms', path: ['auto', 'damage'], value: 99 },
      { file: 'talents', id: 'warrior_t2b', path: ['mods', 'maxHealth'], value: 1.5 },
    ]);
    assert.equal(CLASSES.warrior.maxHealth, 5000);
    assert.equal(SPECS.warrior.find((s) => s.id === 'arms')!.auto!.damage, 99);
    assert.ok(copies.every((t) => (t.mods as { maxHealth: number }).maxHealth === 1.5));
    undo();
    assert.equal(CLASSES.warrior.maxHealth, hp);
    assert.notEqual(SPECS.warrior.find((s) => s.id === 'arms')!.auto!.damage, 99);
    assert.ok(copies.every((t) => (t.mods as { maxHealth: number }).maxHealth !== 1.5));
  });

  it('only numbers can be patched, never the bar or ids', () => {
    assert.ok(!validPatch({ file: 'classes', id: 'warrior', path: ['bar', 0], value: 1 }));
    assert.ok(!validPatch({ file: 'specs', id: 'arms', path: ['bar', 0], value: 1 }));
    assert.ok(!validPatch({ file: 'specs', id: 'nope', path: ['auto', 'damage'], value: 1 }));
    assert.equal(currentValue({ file: 'classes', id: 'mage', path: ['resource', 'max'] }), CLASSES.mage.resource.max);
    assert.ok(tunableNumbers('classes', 'rogue').length >= 4);
    assert.ok(tunableNumbers('talents', 'warrior_t2b').length >= 1);
  });

  it('refreshMods works every unit out again after a class or talent number changed', () => {
    const sim = new ArenaSim({ seed: 1, prepMs: 0 });
    const u = sim.addUnit({ name: 'w', classId: 'warrior', team: 0 });
    const was = u.maxHealth;
    const undo = applyPatches([{ file: 'classes', id: 'warrior', path: ['maxHealth'], value: CLASSES.warrior.maxHealth * 2 }]);
    sim.refreshMods();
    undo();
    assert.equal(u.maxHealth, was * 2);
    assert.equal(u.health, was * 2, 'full health stays full');
    sim.refreshMods();
    assert.equal(u.maxHealth, was);
  });

  it('a talent or spec that changes a skill lists its numbers for that skill', () => {
    const info = skillInfo('frostbolt');
    const withFields = info.modifiers.filter((m) => m.fields.length);
    assert.ok(withFields.length > 0);
    assert.ok(withFields.every((m) => m.fields.every((f) => f.file === 'talents' || f.file === 'specs' || f.file === 'auras')));
  });
});
