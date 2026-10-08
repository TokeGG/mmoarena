import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CURSORS, DEFAULT_CURSOR, isUnlocked, unlockText } from '../src/accounts';

const fresh = { matches: 0, wins: 0, peak: 1000 };
const KINDS = ['free', 'owner', 'matches', 'wins', 'peak'];

describe('cursor list', () => {
  it('ids are unique and every unlock rule is a known kind with a sensible number', () => {
    assert.equal(new Set(CURSORS.map((c) => c.id)).size, CURSORS.length);
    for (const c of CURSORS) {
      assert.ok(c.name.length > 0 && KINDS.includes(c.unlock.kind), c.id);
      if (c.unlock.kind === 'matches' || c.unlock.kind === 'wins' || c.unlock.kind === 'peak') assert.ok(c.unlock.n > 0, c.id);
      assert.ok(unlockText(c).length > 0);
    }
  });
  it('has the default gauntlet and every described style', () => {
    assert.ok(CURSORS.some((c) => c.id === DEFAULT_CURSOR && c.unlock.kind === 'free'));
    for (const id of ['wand', 'dagger', 'ember', 'frost', 'void', 'crown', 'claw', 'star', 'pixel', 'dot']) assert.ok(CURSORS.some((c) => c.id === id), id);
    assert.ok(CURSORS.filter((c) => c.unlock.kind !== 'owner').length >= 8);
  });
  it('free ones are open to everybody, earned ones follow the stats, the owner has all of them', () => {
    const byId = (id: string) => CURSORS.find((c) => c.id === id)!;
    assert.ok(isUnlocked(byId('wand'), fresh, 'cursor') && isUnlocked(byId('dot'), fresh, 'cursor'));
    assert.ok(!isUnlocked(byId('ember'), fresh, 'cursor'));
    assert.ok(isUnlocked(byId('ember'), { ...fresh, wins: 5 }, 'cursor'));
    assert.ok(!isUnlocked(byId('claw'), { ...fresh, matches: 24 }, 'cursor') && isUnlocked(byId('claw'), { ...fresh, matches: 25 }, 'cursor'));
    assert.ok(!isUnlocked(byId('void'), fresh, 'cursor') && isUnlocked(byId('void'), { ...fresh, peak: 1300 }, 'cursor'));
    assert.ok(!isUnlocked(byId('star'), { matches: 999, wins: 999, peak: 3000, name: 'Someone' }, 'cursor'));
    for (const c of CURSORS) assert.ok(isUnlocked(c, { ...fresh, name: 'Toke' }, 'cursor'), c.id);
  });
});
