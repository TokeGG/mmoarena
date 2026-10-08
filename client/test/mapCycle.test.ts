import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARENAS } from '@arena/shared';
import { cycleArena } from '../src/mapCycle';

describe('cycleArena', () => {
  const ids = ['a', 'b', 'c'];
  it('steps forward and back, wrapping round', () => {
    assert.equal(cycleArena(ids, 'a', 1), 'b');
    assert.equal(cycleArena(ids, 'c', 1), 'a');
    assert.equal(cycleArena(ids, 'a', -1), 'c');
    assert.equal(cycleArena(ids, 'b', -1), 'a');
  });
  it('starts from an end when the current map is unknown', () => {
    assert.equal(cycleArena(ids, 'zzz', 1), 'a');
    assert.equal(cycleArena(ids, 'zzz', -1), 'c');
  });
  it('visits every real arena once and comes back', () => {
    const all = ARENAS.map((a) => a.id);
    const seen = new Set<string>();
    let cur = all[0];
    for (let i = 0; i < all.length; i++) { seen.add(cur); cur = cycleArena(all, cur, 1); }
    assert.equal(seen.size, all.length);
    assert.equal(cur, all[0]);
  });
});
