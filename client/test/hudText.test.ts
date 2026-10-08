import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
const { LOOK_OPTIONS, look, resetLook, setLook } = await import('../src/hudLook');
const { ErrorGate, REPEAT_MS, CONTROL_AUTO, TEXT_COLORS, ERROR_AUTO, controlColor, errorColor, errorDurationMs, textVars } = await import('../src/hudText');
const { HUD_ELEMENTS, parseLayout } = await import('../src/hudLayout');

describe('error and stun text layout', () => {
  it('both are movable HUD elements', () => {
    assert.ok(HUD_ELEMENTS.includes('err') && HUD_ELEMENTS.includes('ccstate'));
  });

  it('saved positions for them are kept, clamped and sanitised', () => {
    const l = parseLayout({ err: { fx: 0.1, fy: -0.2, s: 1.2, w: 300, h: 40 }, ccstate: { fx: 9, fy: 0, s: 5 }, bogus: { fx: 0, fy: 0, s: 1 } }, HUD_ELEMENTS, 1000, 500);
    assert.deepEqual(l.err, { fx: 0.1, fy: -0.2, s: 1.2, w: 300, h: 40 });
    assert.deepEqual(l.ccstate, { fx: 1, fy: 0, s: 1.6 });
    assert.equal('bogus' in l, false);
    assert.deepEqual(parseLayout({ err: { fx: 'x', fy: 0, s: 1 }, ccstate: null }, HUD_ELEMENTS, 1000, 500), {});
    assert.deepEqual(parseLayout('junk', HUD_ELEMENTS, 1, 1), {});
    assert.deepEqual(parseLayout([1], HUD_ELEMENTS, 1, 1), {});
    assert.deepEqual(parseLayout({ err: { dx: 100, dy: 50, s: 0.1 } }, HUD_ELEMENTS, 1000, 500).err, { fx: 0.1, fy: 0.1, s: 0.6 });
  });
});

describe('error and stun text style options', () => {
  it('defaults are bigger, bold, red-orange with an outline', () => {
    resetLook();
    const v = textVars(look);
    assert.equal(v['--err-size'], '20px');
    assert.equal(v['--err-weight'], '800');
    assert.equal(v['--err-color'], ERROR_AUTO);
    assert.match(v['--err-shadow'], /#000/);
    assert.equal(v['--err-bg'], 'transparent');
    assert.equal(v['--cc-size'], '30px');
    assert.equal(errorDurationMs(look.errTime), 1800);
  });

  it('every new option has a valid default; bad values are ignored and persist through the look storage', () => {
    resetLook();
    for (const o of LOOK_OPTIONS.filter((x) => x.group === 'Error text' || x.group === 'Stun text')) assert.ok(o.choices.some(([v]) => v === look[o.id]), o.id);
    setLook('errColor', 'chartreuse');
    assert.equal(look.errColor, 'auto');
    setLook('errColor', 'yellow');
    setLook('errSize', 'xl');
    setLook('errPlate', 'pill');
    const v = textVars(look);
    assert.equal(v['--err-color'], TEXT_COLORS.yellow);
    assert.equal(v['--err-size'], '30px');
    assert.match(v['--err-bg'], /rgba/);
    assert.equal(JSON.parse(store.get('arena.hud.look.v1')!).errColor, 'yellow');
    resetLook();
    assert.equal(look.errColor, 'auto');
    assert.equal(look.errSize, 'lg');
  });

  it('unknown stored values fall back to the defaults', () => {
    const v = textVars({ errSize: 'x', errColor: 'x', errOutline: 'x', ccSize: 'x', ccOutline: 'x' });
    assert.equal(v['--err-size'], '20px');
    assert.equal(v['--err-color'], ERROR_AUTO);
    assert.match(v['--err-shadow'], /#000/);
    assert.equal(v['--cc-size'], '30px');
  });

  it('error colour: auto is the warm red, swatches override', () => {
    assert.equal(errorColor('auto'), ERROR_AUTO);
    assert.equal(errorColor('cyan'), TEXT_COLORS.cyan);
    assert.equal(errorColor('nope'), ERROR_AUTO);
  });

  it('control colour: auto follows the aura kind when there is no plate, swatches override', () => {
    assert.equal(controlColor('auto', 'stun', true), '', 'white on the coloured plate');
    assert.equal(controlColor('auto', 'stun', false), CONTROL_AUTO.stun);
    assert.equal(controlColor('auto', 'fear', false), CONTROL_AUTO.fear);
    assert.equal(controlColor('auto', 'sheep', false), CONTROL_AUTO.sheep);
    assert.equal(controlColor('auto', 'lock', false), CONTROL_AUTO.lock);
    assert.equal(controlColor('auto', '', false), '');
    assert.equal(controlColor('magenta', 'stun', true), TEXT_COLORS.magenta);
  });

  it('the visible time is clamped to 0.8 - 3 s', () => {
    assert.equal(errorDurationMs('0.8'), 800);
    assert.equal(errorDurationMs(0.1), 800);
    assert.equal(errorDurationMs('99'), 3000);
    assert.equal(errorDurationMs(2.4), 2400);
    assert.equal(errorDurationMs('abc'), 1800);
    assert.equal(errorDurationMs(undefined), 1800);
    assert.equal(errorDurationMs(NaN), 1800);
  });
});

describe('error repeat suppression', () => {
  it('drops the same message within 300 ms, not a different one or a later one', () => {
    let t = 1000;
    const g = new ErrorGate(() => t);
    assert.equal(g.accept('Out of range'), true);
    t += 100;
    assert.equal(g.accept('Out of range'), false);
    t += 100;
    assert.equal(g.accept('Out of range'), false);
    assert.equal(g.accept('No line of sight'), true);
    assert.equal(g.accept('Out of range'), true, 'a different message in between resets it');
    t += REPEAT_MS;
    assert.equal(g.accept('Out of range'), true);
  });

  it('can be turned off', () => {
    let t = 0;
    const g = new ErrorGate(() => t);
    assert.equal(g.accept('x', false), true);
    assert.equal(g.accept('x', false), true);
  });
});
