import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, skillInfo, tunables, tunableNumbers } from '../src/index';

describe('dev panel skill info', () => {
  it('shows every aura tied to a skill, where it comes from and what it does', () => {
    const fs = skillInfo('flamestrike');
    assert.equal(fs.sections[0].kind, 'ability');
    assert.ok(fs.sections[0].fields.length > 0);
    const hot = fs.sections.find((s) => s.id === 'hot_streak');
    assert.ok(hot, 'the proc it grants on hit is listed');
    assert.match(hot!.link, /opening hit/);
    assert.ok(hot!.from.includes('Flamestrike'), 'and Flamestrike is named as a source');
    assert.ok(hot!.does.join(' ').length > 0, 'with what it does');
    const ms = skillInfo('mortal_strike');
    const wounds = ms.sections.find((s) => s.kind === 'aura');
    assert.ok(wounds && wounds.link.includes('on the target'));
    assert.ok(wounds!.fields.some((f) => f.file === 'auras'));
  });

  it('lists the talents that change a skill once, with every spec that has them', () => {
    const b = skillInfo('blink');
    const names = b.modifiers.map((m) => m.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(b.modifiers.some((m) => m.where.includes(',')), 'the same talent in several specs is one line');
    const leap = skillInfo('leap_of_faith');
    assert.ok(leap.sections[0].from.length > 0, 'a talent that swaps it in is a source');
  });

  it('the flat tunables list keeps the ability first, then its auras', () => {
    for (const id of Object.keys(ABILITIES)) {
      const t = tunables(id);
      assert.deepEqual(t.slice(0, tunableNumbers('abilities', id).length), tunableNumbers('abilities', id), id);
    }
  });
});
