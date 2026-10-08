import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Recap } from '../src/recap';

const units = [
  { id: 1, name: 'Ann', team: 0 as const, classId: 'warrior' as const },
  { id: 2, name: 'Bob', team: 0 as const, classId: 'priest' as const },
  { id: 3, name: 'Cy', team: 1 as const, classId: 'mage' as const },
];
const dmg = (src: number, tgt: number, amount: number, ability: string | null = 'mortal_strike') => ({ t: 'damage' as const, src, tgt, amount, absorbed: 0, ability, school: 'physical' as const });

describe('Recap', () => {
  it('adds up damage, healing, kills, deaths and the biggest hit', () => {
    const r = new Recap();
    r.setUnits(units);
    r.add(dmg(1, 3, 300));
    r.add(dmg(1, 3, 900, 'execute'));
    r.add(dmg(3, 2, 200, null));
    r.add(dmg(0, 2, 50)); // environment: counted as taken only
    r.add({ t: 'heal', src: 2, tgt: 2, amount: 120, overheal: 40, ability: 'flash_heal' });
    r.add({ t: 'death', unit: 3, killer: 1 });
    r.add({ t: 'death', unit: 2, killer: null });
    const rows = r.rows();
    const by = (id: number) => rows.find((x) => x.id === id)!;
    assert.equal(by(1).damage, 1200);
    assert.equal(by(1).kills, 1);
    assert.deepEqual(by(1).best, { ability: 'execute', amount: 900 });
    assert.equal(by(3).taken, 1200);
    assert.equal(by(3).deaths, 1);
    assert.deepEqual(by(3).best, { ability: null, amount: 200 });
    assert.equal(by(2).taken, 250);
    assert.equal(by(2).healing, 120);
    assert.equal(by(2).deaths, 1);
    assert.equal(by(2).kills, 0);
    assert.equal(rows.length, 3);
  });

  it('picks exactly one MVP, the top scorer, and none when nothing happened', () => {
    const r = new Recap();
    r.setUnits(units);
    assert.ok(r.rows().every((x) => !x.mvp));
    r.add(dmg(1, 3, 500));
    r.add({ t: 'heal', src: 2, tgt: 1, amount: 100, overheal: 0, ability: 'flash_heal' });
    const rows = r.rows();
    assert.equal(rows.filter((x) => x.mvp).length, 1);
    assert.equal(rows[0].id, 1);
    assert.ok(rows[0].mvp);
  });

  it('ignores zero hits, self kills and resets', () => {
    const r = new Recap();
    r.setUnits(units);
    r.add(dmg(1, 3, 0));
    r.add({ t: 'death', unit: 1, killer: 1 });
    assert.equal(r.rows().find((x) => x.id === 1)!.kills, 0);
    assert.equal(r.rows().find((x) => x.id === 1)!.best, null);
    r.reset();
    assert.equal(r.rows().length, 0);
    assert.ok(r.empty);
  });
});
