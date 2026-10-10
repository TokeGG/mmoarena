import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SimEvent } from '@arena/shared';
const { DpsMeter } = await import('../src/dpsMeter');

const dmg = (src: number, tgt: number, amount: number): SimEvent => ({ t: 'damage', src, tgt, amount, ability: 'fireball', crit: false } as unknown as SimEvent);
const heal = (src: number, tgt: number, amount: number): SimEvent => ({ t: 'heal', src, tgt, amount, overheal: 0, ability: 'flash_heal' } as unknown as SimEvent);
const units = [{ id: 1, name: 'Ann', team: 0 as const }, { id: 2, name: 'Bo', team: 1 as const }, { id: 3, name: 'Cy', team: 0 as const }];

describe('the DPS meter', () => {
  it('ranks by damage dealt and gives per-second numbers over the last ten seconds', () => {
    const m = new DpsMeter(null);
    m.feed([dmg(1, 2, 300), dmg(2, 1, 100)], 1000);
    m.feed([dmg(1, 2, 300)], 3000);
    m.feed([dmg(2, 1, 50)], 5000);
    const rows = m.rows(units);
    assert.deepEqual(rows.map((r) => r.name), ['Ann', 'Bo']);
    assert.equal(rows[0].dealt, 600);
    assert.equal(Math.round(rows[0].dps), Math.round(600 / 4), 'the span runs from the first hit in the window to now');
    assert.equal(rows[1].taken, 600);
  });
  it('counts healing separately and leaves out units that did nothing', () => {
    const m = new DpsMeter(null);
    m.feed([heal(3, 1, 400), dmg(1, 2, 100)], 2000);
    const rows = m.rows(units);
    assert.deepEqual(rows.map((r) => [r.name, r.dealt, r.healed]), [['Ann', 100, 0], ['Cy', 0, 400]]);
    assert.ok(!rows.some((r) => r.name === 'Bo'), 'Bo only took damage');
  });
  it('forgets hits older than ten seconds for the per-second number but keeps the totals, and a reset starts afresh', () => {
    const m = new DpsMeter(null);
    m.feed([dmg(1, 2, 1000)], 1000);
    m.feed([dmg(1, 2, 100)], 20000);
    const r = m.rows(units)[0];
    assert.equal(r.dealt, 1100);
    assert.ok(r.dps <= 100, `the old hit is out of the window (${r.dps})`);
    m.reset();
    assert.deepEqual(m.rows(units), []);
  });
});
