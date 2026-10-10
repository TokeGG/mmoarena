import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { applySkinTo, optionsFor, resetSkin, setSkin, skin, skinChanged, skinValue } = await import('../src/hudSkin');

const stub = () => {
  const style: Record<string, string> = {};
  const attrs: Record<string, string> = {};
  const classes = new Set<string>();
  return { style: { setProperty: (k: string, v: string) => { if (v === '') delete style[k]; else style[k] = v; }, removeProperty: (k: string) => { delete style[k]; } }, setAttribute: (k: string, v: string) => { attrs[k] = v; }, removeAttribute: (k: string) => { delete attrs[k]; }, classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) }, _style: style, _attrs: attrs, _classes: classes } as any;
};

describe('HUD element skins', () => {
  it('only known options and choices are kept, and default means nothing is stored', () => {
    setSkin('party', 'bg', 'glass');
    setSkin('party', 'bg', 'nonsense');
    setSkin('party', 'nope', 'x');
    assert.equal(skinValue('party', 'bg'), 'glass');
    assert.equal(skinChanged('party'), true);
    setSkin('party', 'bg', 'default');
    assert.equal(skinChanged('party'), false);
    assert.deepEqual(skin, {});
  });
  it('every element has the common options, and the party and the Ready / Leave buttons have their own', () => {
    assert.ok(optionsFor('log').some((o) => o.id === 'opacity'));
    assert.ok(optionsFor('party').some((o) => o.id === 'layout'));
    assert.ok(optionsFor('endchoice').some((o) => o.id === 'btn'));
    assert.ok(!optionsFor('log').some((o) => o.id === 'layout'));
  });
  it('a skin becomes inline styles and attributes, and resetting clears them', () => {
    setSkin('endchoice', 'opacity', '60');
    setSkin('endchoice', 'bg', 'glass');
    setSkin('endchoice', 'radius', 'pill');
    setSkin('endchoice', 'btn', 'outline');
    setSkin('endchoice', 'show', 'hide');
    const e = stub();
    applySkinTo(e, 'endchoice');
    assert.equal(e._style.opacity, '0.6');
    assert.match(e._style.background, /^rgba\(/);
    assert.equal(e._style['border-radius'], '999px');
    assert.equal(e._attrs['data-hs-btn'], 'outline');
    assert.ok(e._classes.has('hs-hidden'));
    resetSkin('endchoice');
    const f = stub();
    applySkinTo(f, 'endchoice');
    assert.deepEqual(f._style, {});
    assert.deepEqual(f._attrs, {});
    assert.ok(!f._classes.has('hs-hidden'));
  });
});
