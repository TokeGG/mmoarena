import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SimEvent } from '@arena/shared';
const { DpsMeter } = await import('../src/dpsMeter');

const dmg = (src: number, tgt: number, amount: number, absorbed = 0): SimEvent => ({ t: 'damage', src, tgt, amount, absorbed, ability: 'fireball', school: 'fire' } as unknown as SimEvent);
const heal = (src: number, tgt: number, amount: number, overheal = 0): SimEvent => ({ t: 'heal', src, tgt, amount, overheal, ability: 'flash_heal' } as unknown as SimEvent);
const units = [{ id: 1, name: 'Ann', team: 0 as const }, { id: 2, name: 'Bo', team: 1 as const }, { id: 3, name: 'Cy', team: 0 as const }];

describe('the DPS meter', () => {
  it('ranks by damage dealt and gives per-second numbers over the last ten seconds', () => {
    const m = new DpsMeter(null);
    m.feed([dmg(1, 2, 300), dmg(2, 1, 100)], 1000);
    m.feed([dmg(1, 2, 300)], 3000);
    m.feed([dmg(2, 1, 50)], 5000);
    const rows = m.rows(units);
    assert.deepEqual(rows.map((r) => r.name), ['Ann', 'Bo']);
    assert.equal(rows[0].value, 600);
    assert.equal(Math.round(rows[0].rate!), Math.round(600 / 4), 'the span runs from the first hit in the window to now');
    assert.equal(rows[1].tally.taken, 600);
  });
  it('counts healing separately and leaves out units that did nothing', () => {
    const m = new DpsMeter(null);
    m.feed([heal(3, 1, 400), dmg(1, 2, 100)], 2000);
    assert.deepEqual(m.rows(units).map((r) => [r.name, r.value]), [['Ann', 100]]);
    assert.deepEqual(m.rows(units, { metric: 'healing' }).map((r) => [r.name, r.value]), [['Cy', 400]]);
    assert.ok(!m.rows(units).some((r) => r.name === 'Bo'), 'Bo only took damage');
  });
  it('forgets hits older than ten seconds for the per-second number but keeps the totals, and a reset starts afresh', () => {
    const m = new DpsMeter(null);
    m.feed([dmg(1, 2, 1000)], 1000);
    m.feed([dmg(1, 2, 100)], 20000);
    const r = m.rows(units)[0];
    assert.equal(r.value, 1100);
    assert.ok(r.rate! <= 100, `the old hit is out of the window (${r.rate})`);
    m.reset();
    assert.deepEqual(m.rows(units), []);
  });
});

describe('what the meter shows', () => {
  const m = () => {
    const x = new DpsMeter(null);
    x.feed([
      dmg(1, 2, 500, 120), dmg(2, 1, 300), heal(3, 1, 400, 250), heal(3, 3, 100),
      { t: 'interrupt', src: 2, tgt: 1, ability: 'kick', school: 'physical', lockout: 3000 } as unknown as SimEvent,
      { t: 'interrupt', src: 2, tgt: 3, ability: 'kick', school: 'physical', lockout: 3000 } as unknown as SimEvent,
      { t: 'dispel', src: 3, tgt: 1, aura: 'renew' } as unknown as SimEvent,
      { t: 'aura', src: 2, tgt: 1, aura: 'kidney_shot', expiresAt: 5000, dr: 1 } as unknown as SimEvent,
      { t: 'aura', src: 2, tgt: 1, aura: 'kidney_shot', expiresAt: 5000, dr: 0 } as unknown as SimEvent, // immune: not a stun landed
      { t: 'aura', src: 1, tgt: 1, aura: 'kidney_shot', expiresAt: 5000, dr: 1 } as unknown as SimEvent, // on yourself: not crowd control
      { t: 'cast', unit: 1, ability: 'fireball', target: 2 } as unknown as SimEvent,
      { t: 'cast', unit: 1, ability: 'fireball', target: 2 } as unknown as SimEvent,
      { t: 'death', unit: 3, killer: 2 } as unknown as SimEvent,
    ], 2000);
    return x;
  };
  const names = (rows: { name: string; value: number }[]) => rows.map((r) => `${r.name}:${r.value}`);

  it('has a view for each thing that matters in a match', () => {
    const x = m();
    assert.deepEqual(names(x.rows(units, { metric: 'damage' })), ['Ann:500', 'Bo:300']);
    assert.deepEqual(names(x.rows(units, { metric: 'healing' })), ['Cy:500']);
    assert.deepEqual(names(x.rows(units, { metric: 'taken' })), ['Bo:500', 'Ann:300']);
    assert.deepEqual(names(x.rows(units, { metric: 'overheal' })), ['Cy:250']);
    assert.deepEqual(names(x.rows(units, { metric: 'absorbed' })), ['Bo:120']);
    assert.deepEqual(names(x.rows(units, { metric: 'interrupts' })), ['Bo:2']);
    assert.deepEqual(names(x.rows(units, { metric: 'dispels' })), ['Cy:1']);
    assert.deepEqual(names(x.rows(units, { metric: 'cc' })), ['Bo:1']);
    assert.deepEqual(names(x.rows(units, { metric: 'kills' })), ['Bo:1']);
    assert.deepEqual(names(x.rows(units, { metric: 'deaths' })), ['Cy:1']);
    assert.deepEqual(names(x.rows(units, { metric: 'casts' })), ['Ann:2']);
  });

  it('shows everyone, your team or the enemy team, and only as many rows as asked', () => {
    const x = m();
    assert.deepEqual(names(x.rows(units, { metric: 'taken', who: 'mine', friendly: 0 })), ['Ann:300']);
    assert.deepEqual(names(x.rows(units, { metric: 'taken', who: 'foes', friendly: 0 })), ['Bo:500']);
    assert.equal(x.rows(units, { metric: 'taken', rows: 1 }).length, 1);
  });

  it('only damage, healing and damage taken have a per-second number', () => {
    const x = m();
    assert.notEqual(x.rows(units, { metric: 'damage' })[0].rate, null);
    assert.equal(x.rows(units, { metric: 'kills' })[0].rate, null);
  });
});

describe('the DPS meter with more than one list', () => {
  it('draws a block per thing shown, stacked, each with its own rows', () => {
    type N = { cls: string; text: string; kids: N[] };
    const mk = (cls = ''): N & Record<string, unknown> => {
      const n: N & Record<string, unknown> = { cls, text: '', kids: [], style: {}, title: '', addEventListener() {}, append(...k: N[]) { n.kids.push(...k); } };
      Object.defineProperty(n, 'className', { get: () => n.cls, set: (v: string) => { n.cls = v; } });
      Object.defineProperty(n, 'textContent', { get: () => n.text, set: (v: string) => { n.text = v; } });
      Object.defineProperty(n, 'childNodes', { get: () => n.kids });
      return n;
    };
    (globalThis as any).document = { createElement: () => mk(), createDocumentFragment: () => mk('frag') };
    const root = mk('root') as any;
    root.replaceChildren = (frag: N) => { root.kids = frag ? [...frag.kids] : []; };
    const m = new DpsMeter(root);
    m.feed([dmg(1, 2, 300), heal(3, 1, 400)], 2000);
    m.paint(units, 1, { metric: 'damage', also: ['healing', 'damage'], rows: 5, friendly: 0 });
    const heads = root.kids.filter((k: N) => k.cls === 'dm-head').map((k: N) => k.text);
    assert.deepEqual(heads, ['Damage done', 'Healing done'], 'two blocks, and a repeat is not drawn twice');
    assert.equal(root.kids.filter((k: N) => k.cls.startsWith('dm-row')).length, 2, 'a row under each');
    delete (globalThis as any).document;
  });
});
