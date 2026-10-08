import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, AURAS } from '@arena/shared';
import { ABILITY_ICON, AURA_ICON } from '../src/icons';

function dupes(ids: string[], map: Record<string, string>): string[] {
  const seen = new Map<string, string>();
  const out: string[] = [];
  for (const id of ids) {
    const icon = map[id];
    if (!icon) continue;
    const other = seen.get(icon);
    if (other) out.push(`${id} and ${other} share ${icon}`);
    else seen.set(icon, id);
  }
  return out;
}

describe('icons', () => {
  const abilities = Object.values(ABILITIES).filter((a) => !a.retired).map((a) => a.id);
  const auras = Object.keys(AURAS);
  it('every non-retired ability has an icon of its own', () => {
    assert.deepEqual(abilities.filter((id) => !ABILITY_ICON[id]), []);
    assert.deepEqual(dupes(abilities, ABILITY_ICON), []);
  });
  it('every aura has an icon of its own', () => {
    assert.deepEqual(auras.filter((id) => !AURA_ICON[id]), []);
    assert.deepEqual(dupes(auras, AURA_ICON), []);
  });
  it('icons are not left over for things that no longer exist', () => {
    assert.deepEqual(Object.keys(AURA_ICON).filter((id) => !AURAS[id]), []);
    assert.deepEqual(Object.keys(ABILITY_ICON).filter((id) => !ABILITIES[id] || ABILITIES[id].retired), []);
  });
});
