import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emptyCats } from '@arena/shared';
import type { TimeRow } from '@arena/shared';
import { colValue, lastDays, sortRows, span, topBars } from '../src/timeUi';

const row = (name: string, o: Partial<ReturnType<typeof emptyCats>>, last = 0): TimeRow => {
  const cat = { ...emptyCats(), ...o };
  return { name, total: Object.values(cat).reduce((a, b) => a + b, 0), last, online: false, cat };
};

describe('play time view helpers', () => {
  it('writes durations the way a person reads them', () => {
    assert.equal(span(40_000), '40 s');
    assert.equal(span(12 * 60_000), '12 min');
    assert.equal(span(3 * 3600_000 + 5 * 60_000), '3 h 05 min');
    assert.equal(span(250 * 3600_000), '250 h');
  });

  it('columns fold the categories: menu includes the queue, party includes duels', () => {
    const r = row('A', { menu: 1, queue: 2, party: 3, duel: 4, ranked: 5 });
    assert.equal(colValue(r, 'menu'), 3);
    assert.equal(colValue(r, 'party'), 7);
    assert.equal(colValue(r, 'ranked'), 5);
    assert.equal(colValue(r, 'total'), 15);
  });

  it('sorts by the chosen column, biggest first, ties by total', () => {
    const rows = [row('A', { ranked: 5, menu: 1 }), row('B', { ranked: 9 }), row('C', { ranked: 5, menu: 10 })];
    assert.deepEqual(sortRows(rows, 'ranked').map((r) => r.name), ['B', 'C', 'A']);
    assert.deepEqual(sortRows(rows, 'total').map((r) => r.name), ['C', 'B', 'A']);
  });

  it('bars: biggest first, capped, empty entries left out', () => {
    const bars = topBars({ mage: 5, rogue: 9, priest: 0, warrior: 1 }, (k) => k.toUpperCase(), 3);
    assert.deepEqual(bars.map((b) => b.label), ['ROGUE', 'MAGE', 'WARRIOR']);
  });

  it('thirty days ending today, zero for days without play', () => {
    const now = Date.UTC(2026, 9, 9, 12);
    const d = lastDays({ '20261009': 5, '20260909': 7, '20260901': 9 }, 30, now);
    assert.equal(d.length, 30);
    assert.equal(d.at(-1)!.key, '20261009');
    assert.equal(d.at(-1)!.ms, 5);
    assert.equal(d[0].key, '20260910');
    assert.equal(d.reduce((a, b) => a + b.ms, 0), 5, 'older days fall off');
  });
});
