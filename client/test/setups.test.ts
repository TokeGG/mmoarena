import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};
const { setups } = await import('../src/setups');

describe('setup profiles', () => {
  beforeEach(() => store.clear());

  it('saves, switches and restores settings', () => {
    store.set('arena.name', 'Toke');
    store.set('arena.keybinds.v1', '{"a":1}');
    setups.save('Main');
    store.set('arena.name', 'Other');
    store.set('arena.extra', 'x');
    setups.save('Alt');
    assert.deepEqual(setups.names(), ['Alt', 'Main']);
    assert.ok(setups.load('Main'));
    assert.equal(store.get('arena.name'), 'Toke');
    assert.equal(store.get('arena.extra'), undefined, 'keys not in the profile are cleared');
    assert.equal(setups.active(), 'Main');
  });

  it('autosave keeps the active profile current', () => {
    store.set('arena.name', 'A');
    setups.save('Main');
    store.set('arena.name', 'B');
    setups.autosave();
    store.set('arena.name', 'C');
    setups.load('Main');
    assert.equal(store.get('arena.name'), 'B');
  });

  it('export/import round-trips and rejects junk', () => {
    store.set('arena.name', 'Tøke ✓');
    store.set('arena.hud.v1', '{"x":1}');
    const code = setups.exportCode();
    const parsed = setups.parseCode(code);
    assert.equal(typeof parsed, 'object');
    assert.equal((parsed as Record<string, string>)['arena.name'], 'Tøke ✓');
    assert.equal(typeof setups.parseCode('hello'), 'string');
    assert.equal(typeof setups.parseCode('ARENA1.@@@'), 'string');
    const evil = 'ARENA1.' + btoa(JSON.stringify({ 'other.key': 'x', 'arena.setups.v1': 'x', 'arena.ok': 'y' }));
    const p2 = setups.parseCode(evil) as Record<string, string>;
    assert.deepEqual(Object.keys(p2), ['arena.ok']);
  });

  it('never lowers match progress when loading a profile', () => {
    store.set('arena.profile.v1', JSON.stringify({ token: 't1', matches: 2, wins: 1 }));
    setups.save('Old');
    store.set('arena.profile.v1', JSON.stringify({ token: 't9', matches: 9, wins: 4 }));
    setups.load('Old');
    assert.equal(JSON.parse(store.get('arena.profile.v1')!).matches, 9);
  });
});
