import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EMBLEMS, NAME_COLORS, TITLES, isUnlocked, validateCosmetics } from '../src/accounts';

const fresh = { matches: 0, wins: 0, peak: 1000 };

describe('titles, icons and name colours', () => {
  it('ids are unique within each list', () => {
    for (const list of [TITLES, EMBLEMS, NAME_COLORS]) assert.equal(new Set(list.map((d) => d.id)).size, list.length);
  });
  it('every colour is a hex value and every icon has a glyph', () => {
    for (const c of NAME_COLORS) assert.match(c.value ?? '', /^#[0-9a-f]{6}$/i);
    for (const e of EMBLEMS) assert.ok(e.value);
  });
  it('the owner account has everything open, a new player only the free ones', () => {
    for (const [list, kind] of [[TITLES, 'title'], [EMBLEMS, 'emblem'], [NAME_COLORS, 'color']] as const) {
      for (const d of list) {
        assert.ok(isUnlocked(d, { ...fresh, name: 'Toke' }, kind), `owner: ${kind} ${d.id}`);
        assert.equal(isUnlocked(d, { ...fresh, name: 'Someone' }, kind), d.unlock.kind === 'free', `new player: ${kind} ${d.id}`);
      }
    }
  });
  it('the owner can pick a rating-gated title the stats alone would not allow', () => {
    assert.ok(validateCosmetics({ title: 'grandmaster', emblem: 'galaxy', color: 'diamond' }, { ...fresh, name: 'Toke' }));
    assert.equal(validateCosmetics({ title: 'grandmaster', emblem: 'galaxy', color: 'diamond' }, { ...fresh, name: 'Someone' }), null);
  });
  it('there are plenty to grind for', () => {
    assert.ok(TITLES.filter((t) => t.unlock.kind !== 'free' && t.unlock.kind !== 'owner').length >= 18);
    assert.ok(EMBLEMS.filter((t) => t.unlock.kind !== 'free' && t.unlock.kind !== 'owner').length >= 20);
    assert.ok(NAME_COLORS.filter((t) => t.unlock.kind !== 'free' && t.unlock.kind !== 'owner').length >= 18);
  });
});
