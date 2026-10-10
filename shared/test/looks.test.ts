import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, LOOKS, LOOKS_ID, LOOK_CHOICES, NEUTRAL_LOOK, applyPatches, entryFor, isCustomLook, skillLook, validPatch } from '../src/index';

describe('skill looks', () => {
  it('every skill has a complete look in looks.json (run `npx tsx scripts/gen-looks.ts` after adding a skill)', () => {
    for (const id of Object.keys(ABILITIES)) {
      assert.ok(LOOKS[id], `${id} is missing from looks.json`);
      for (const k of Object.keys(NEUTRAL_LOOK)) assert.ok(k in LOOKS[id], `${id}.${k}`);
    }
    for (const id of Object.keys(LOOKS)) assert.ok(ABILITIES[id], `${id} in looks.json is not a skill`);
  });

  it("a skill's Animations page has its projectile and impact choices, and a dev can change and undo them", () => {
    const e = entryFor('animations', 'skill_frostbolt')!;
    const titles = e.groups.map((g) => g.title);
    assert.deepEqual(titles.slice(0, 2), ['How it flies', 'How it hits']);
    const form = e.groups[0].fields.find((f) => f.path[1] === 'form')!;
    assert.equal(form.kind, 'choice');
    assert.ok(form.options!.includes('comet') && form.optionLabels!.comet.includes('long tail'));
    const p = (key: string, value: string | number) => ({ file: 'looks' as const, id: LOOKS_ID, path: ['arcane_missiles', key], value });
    assert.ok(validPatch(p('form', 'comet')) && !validPatch(p('form', 'laser')) && !validPatch(p('size', 9)) && validPatch(p('size', 1.5)) && validPatch(p('color', 'violet')));
    assert.ok(!validPatch({ file: 'looks', id: LOOKS_ID, path: ['no_such_skill', 'form'], value: 'orb' }));
    assert.equal(isCustomLook(skillLook('arcane_missiles')), false);
    const undo = applyPatches([p('form', 'comet'), p('color', 'green'), p('size', 1.4)]);
    assert.deepEqual([skillLook('arcane_missiles').form, skillLook('arcane_missiles').color, skillLook('arcane_missiles').size], ['comet', 'green', 1.4]);
    assert.equal(isCustomLook(skillLook('arcane_missiles')), true);
    undo();
    assert.equal(isCustomLook(skillLook('arcane_missiles')), false);
    assert.ok(LOOK_CHOICES.trail.includes('frost'));
  });
});
