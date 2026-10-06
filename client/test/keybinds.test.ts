import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};
const { Keybinds, keyLabel, comboOf, splitCombo } = await import('../src/keybinds');

describe('keybinds', () => {
  beforeEach(() => store.clear());

  it('has WoW-style defaults', () => {
    const k = new Keybinds();
    assert.equal(k.actionFor('KeyW'), 'forward');
    assert.equal(k.actionFor('ArrowUp'), 'forward');
    assert.equal(k.actionFor('Digit3'), 'slot3');
    assert.equal(k.actionFor('Tab'), 'nextTarget');
    assert.equal(k.label('forward'), 'W / ↑');
  });

  it('rebinding persists and the old key stops working', () => {
    const k = new Keybinds();
    k.set('slot1', 0, 'KeyF');
    assert.equal(k.actionFor('KeyF'), 'slot1');
    assert.equal(k.actionFor('Digit1'), null);
    const again = new Keybinds();
    assert.equal(again.actionFor('KeyF'), 'slot1');
  });

  it('taking a key that is in use moves it and reports who lost it', () => {
    const k = new Keybinds();
    const lost = k.set('slot2', 0, 'KeyW');
    assert.equal(lost, 'forward');
    assert.equal(k.actionFor('KeyW'), 'slot2');
    assert.deepEqual(k.codes('forward'), ['ArrowUp']);
  });

  it('Escape cannot be bound, and clearing works', () => {
    const k = new Keybinds();
    k.set('slot1', 0, 'Escape');
    assert.equal(k.actionFor('Escape'), null);
    assert.equal(k.get('slot1', 0), 'Digit1');
    k.set('slot1', 0, '');
    assert.deepEqual(k.codes('slot1'), []);
  });

  it('reset restores defaults; corrupt storage falls back to defaults', () => {
    const k = new Keybinds();
    k.set('slot1', 0, 'KeyF');
    k.reset();
    assert.equal(k.actionFor('Digit1'), 'slot1');
    store.set('arena.keybinds.v1', '{{{');
    assert.equal(new Keybinds().actionFor('KeyW'), 'forward');
    store.set('arena.keybinds.v1', JSON.stringify({ slot1: ['Escape', ''] }));
    assert.equal(new Keybinds().actionFor('Digit1'), 'slot1');
  });

  it('builds combos with modifiers in a fixed order', () => {
    assert.equal(comboOf({ code: 'Digit1', shiftKey: true }), 'Shift+Digit1');
    assert.equal(comboOf({ code: 'KeyQ', shiftKey: true, ctrlKey: true, altKey: true }), 'Ctrl+Alt+Shift+KeyQ');
    assert.equal(comboOf({ code: 'KeyQ' }), 'KeyQ');
    assert.equal(comboOf({ code: 'ShiftLeft', shiftKey: true }), 'ShiftLeft');
    assert.deepEqual(splitCombo('Ctrl+Shift+Digit2'), { mods: ['Ctrl', 'Shift'], code: 'Digit2' });
    assert.equal(keyLabel('Shift+Digit1'), 'Shift+1');
    assert.equal(keyLabel('Ctrl+Alt+KeyQ'), 'Ctrl+Alt+Q');
  });

  it('Shift+1 and 1 are separate bindings', () => {
    const k = new Keybinds();
    k.set('slot1', 1, 'Shift+Digit1');
    k.set('slot2', 0, 'Shift+Digit2');
    assert.equal(k.actionForEvent({ code: 'Digit1', shiftKey: true }), 'slot1');
    assert.equal(k.actionForEvent({ code: 'Digit1' }), 'slot1');
    assert.equal(k.actionForEvent({ code: 'Digit2', shiftKey: true }), 'slot2');
    assert.equal(k.actionForEvent({ code: 'Digit2' }), null);
    // a plain binding with no exact combo still fires under a modifier (Shift+Tab, Shift+W)
    assert.equal(k.actionForEvent({ code: 'Tab', shiftKey: true }), 'nextTarget');
    // combos with a different modifier do not match
    assert.equal(k.actionForEvent({ code: 'Digit2', ctrlKey: true }), null);
    // a bare modifier press never resolves through the plain-key fallback
    assert.equal(k.actionForEvent({ code: 'ShiftLeft', shiftKey: true }), null);
  });

  it('exact combo wins over the plain key', () => {
    const k = new Keybinds();
    k.set('slot5', 0, 'Shift+Digit1');
    assert.equal(k.actionForEvent({ code: 'Digit1', shiftKey: true }), 'slot5');
    assert.equal(k.actionForEvent({ code: 'Digit1' }), 'slot1');
  });

  it('combos persist, can be stolen, and held checks need the modifier', () => {
    const k = new Keybinds();
    k.set('slot3', 0, 'Shift+KeyF');
    assert.equal(new Keybinds().get('slot3', 0), 'Shift+KeyF');
    assert.equal(k.set('slot4', 0, 'Shift+KeyF'), 'slot3');
    k.set('forward', 0, 'Ctrl+KeyW');
    assert.equal(k.isHeld('forward', new Set(['KeyW'])), false); // plain W was replaced by Ctrl+W
    assert.equal(k.isHeld('forward', new Set(['KeyW', 'ControlLeft'])), true);
    assert.equal(k.isHeld('forward', new Set(['ArrowUp'])), true);
  });

  it('isHeld: plain bindings ignore modifiers, combos require them', () => {
    const k = new Keybinds();
    assert.equal(k.isHeld('forward', new Set(['KeyW', 'ShiftLeft'])), true);
    k.set('strafeLeft', 0, 'Shift+KeyZ');
    assert.equal(k.isHeld('strafeLeft', new Set(['KeyZ'])), false);
    assert.equal(k.isHeld('strafeLeft', new Set(['KeyZ', 'ShiftRight'])), true);
  });

  it('Escape stays reserved with modifiers; corrupt combos fall back', () => {
    const k = new Keybinds();
    k.set('slot1', 0, 'Shift+Escape');
    assert.equal(k.get('slot1', 0), 'Digit1');
    store.set('arena.keybinds.v1', JSON.stringify({ slot1: ['Shift+Escape', ''], slot2: ['Bogus+Digit2', ''], slot3: ['Shift+Digit9', ''] }));
    const b = new Keybinds();
    assert.equal(b.get('slot1', 0), 'Digit1');
    assert.equal(b.get('slot2', 0), 'Digit2');
    assert.equal(b.get('slot3', 0), 'Shift+Digit9');
  });

  it('labels keys readably', () => {
    assert.equal(keyLabel('KeyQ'), 'Q');
    assert.equal(keyLabel('Digit5'), '5');
    assert.equal(keyLabel(''), '—');
  });
});
