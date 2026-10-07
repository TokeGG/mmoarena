import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
const { LOOK_OPTIONS, hpFill, hpText, look, resetLook, setLook } = await import('../src/hudLook');
const { Keybinds } = await import('../src/keybinds');

describe('HUD look options', () => {
  it('every option has a valid default and ignores unknown values', () => {
    resetLook();
    for (const o of LOOK_OPTIONS) assert.ok(o.choices.some(([v]) => v === look[o.id]), o.id);
    setLook('bar', 'nope');
    setLook('nope', 'x');
    assert.equal(look.bar, 'smooth');
    setLook('bar', 'segmented');
    assert.equal(look.bar, 'segmented');
    assert.ok(JSON.parse(store.get('arena.hud.look.v1')!).bar === 'segmented');
    resetLook();
    assert.equal(look.bar, 'smooth');
  });

  it('health text follows the option', () => {
    resetLook();
    assert.equal(hpText(750, 1000), '750 / 1000');
    assert.equal(hpText(750, 1000, 100), '750 / 1000 (+100)');
    setLook('hpText', 'percent');
    assert.equal(hpText(750, 1000), '75%');
    setLook('hpText', 'both');
    assert.equal(hpText(750, 1000), '750 / 1000 · 75%');
    setLook('hpText', 'none');
    assert.equal(hpText(750, 1000), '');
    resetLook();
  });

  it('health colour follows the option', () => {
    resetLook();
    assert.ok(hpFill(false, 1, '#69ccf0').includes('#58d37a'));
    assert.ok(hpFill(true, 1, '#69ccf0').includes('#e0523f'));
    setLook('hpColor', 'class');
    assert.ok(hpFill(false, 0.5, '#69ccf0').includes('#69ccf0'));
    setLook('hpColor', 'health');
    assert.ok(hpFill(false, 1, '#69ccf0').includes('hsl(120'));
    assert.ok(hpFill(false, 0, '#69ccf0').includes('hsl(0'));
    resetLook();
  });
});

describe('detailed tooltips key', () => {
  it('is bound to Alt by default and can be held and rebound', () => {
    store.clear();
    const k = new Keybinds();
    assert.equal(k.isHeld('detail', new Set(['AltLeft'])), true);
    assert.equal(k.isHeld('detail', new Set(['AltRight'])), true);
    assert.equal(k.isHeld('detail', new Set(['KeyW'])), false);
    k.set('detail', 0, 'ControlLeft');
    assert.equal(k.isHeld('detail', new Set(['ControlLeft'])), true);
    assert.equal(k.isHeld('detail', new Set(['AltLeft'])), false);
  });
});
