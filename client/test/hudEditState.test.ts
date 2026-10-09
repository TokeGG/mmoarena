import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
const { EDIT_IDLE, EDIT_BODY_CLASSES, openEditor, closeEditor, gameInputEnabled, leavesEditor } = await import('../src/hudEditState');
const { HUD_ELEMENTS, parseLayout } = await import('../src/hudLayout');
const { LOOK_OPTIONS, look, resetLook, setLook } = await import('../src/hudLook');
const { textVars, NET_AUTO, TEXT_COLORS } = await import('../src/hudText');

describe('HUD editor open / close state', () => {
  it('open turns the game keys off, close turns them back on and clears every editor class', () => {
    const s = openEditor(EDIT_IDLE, false);
    assert.equal(s.editing, true);
    assert.equal(gameInputEnabled(s), false);
    const c = closeEditor(s, false);
    assert.equal(c.state.editing, false);
    assert.equal(gameInputEnabled(c.state), true);
    assert.equal(c.restoreMenu, false);
    assert.deepEqual([...EDIT_BODY_CLASSES], ['hud-edit', 'hud-demo']);
  });

  it('Escape leaves the editor whatever has the focus, never twice, never on auto-repeat', () => {
    const s = openEditor(EDIT_IDLE, false);
    assert.equal(leavesEditor(s, 'Escape'), true);
    assert.equal(leavesEditor(s, 'Escape', true), false);
    assert.equal(leavesEditor(s, 'KeyA'), false);
    assert.equal(leavesEditor(closeEditor(s, false).state, 'Escape'), false, 'closed: Escape belongs to the menu again');
  });

  it('opened over the main menu, closing brings the menu back unless a match started', () => {
    const s = openEditor(EDIT_IDLE, true);
    assert.equal(closeEditor(s, false).restoreMenu, true);
    assert.equal(closeEditor(s, true).restoreMenu, false);
    assert.equal(closeEditor(EDIT_IDLE, false).restoreMenu, false);
  });
});

describe('network stats, sound button and dev button are HUD elements', () => {
  it('are registered in the editor', () => {
    for (const id of ['netstats', 'mute-btn', 'devbtn']) assert.ok(HUD_ELEMENTS.includes(id), id);
    assert.equal(new Set(HUD_ELEMENTS).size, HUD_ELEMENTS.length);
  });

  it('their saved positions are clamped and sanitised like the others', () => {
    const l = parseLayout({ netstats: { fx: -3, fy: 0.2, s: 9, w: 5, h: 5000 }, 'mute-btn': { fx: 0.1, fy: 0.1, s: 1 }, devbtn: { fx: 'a', fy: 0, s: 1 } }, HUD_ELEMENTS, 1000, 500);
    assert.deepEqual(l.netstats, { fx: -1, fy: 0.2, s: 1.6, w: 40, h: 1400 });
    assert.deepEqual(l['mute-btn'], { fx: 0.1, fy: 0.1, s: 1 });
    assert.equal('devbtn' in l, false);
  });

  it('look options for the readout have valid defaults, ignore bad values and reset', () => {
    resetLook();
    const opts = LOOK_OPTIONS.filter((o) => o.group === 'Network stats');
    assert.deepEqual(opts.map((o) => o.id), ['netSize', 'netColor', 'netPlate']);
    for (const o of opts) assert.ok(o.choices.some(([v]) => v === look[o.id]), o.id);
    assert.equal(textVars(look)['--net-size'], '11px');
    assert.equal(textVars(look)['--net-color'], NET_AUTO);
    setLook('netSize', 'huge');
    assert.equal(look.netSize, 'md');
    setLook('netSize', 'lg');
    setLook('netColor', 'cyan');
    setLook('netPlate', 'none');
    const v = textVars(look);
    assert.equal(v['--net-size'], '14px');
    assert.equal(v['--net-color'], TEXT_COLORS.cyan);
    assert.equal(v['--net-bg'], 'transparent');
    resetLook();
    assert.equal(look.netSize, 'md');
    assert.equal(look.netPlate, 'plate');
  });
});
