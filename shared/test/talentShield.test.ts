import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { modGroups } from '../src/index';

describe('a talent that changes a skill shows what else it could change on that skill', () => {
  it('Greater Greater Heal offers the barrier on its heal, without picking the skill again', () => {
    const groups = modGroups('talents', 'priest_holy_t3a');
    const more = groups.find((g) => g.id === 'skillmore:greater_heal');
    assert.ok(more, 'there is an "Also change Greater Heal" group');
    assert.ok(more!.fields.some((f) => f.path.join('.') === 'mods.ability.greater_heal.shieldPct'), 'with the share of the healing given as a barrier');
    assert.ok(!more!.fields.some((f) => f.path.join('.') === 'mods.ability.greater_heal.heal'), 'and not what the talent already changes');
  });
});
