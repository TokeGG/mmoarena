import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};
const { Keybinds, keyLabel } = await import('../src/keybinds');

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

  it('labels keys readably', () => {
    assert.equal(keyLabel('KeyQ'), 'Q');
    assert.equal(keyLabel('Digit5'), '5');
    assert.equal(keyLabel(''), '—');
  });
});
