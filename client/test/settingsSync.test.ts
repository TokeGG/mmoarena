import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
const session = new Map<string, string>();
const mk = (m: Map<string, string>) => ({
  getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => void m.set(k, v),
  removeItem: (k: string) => void m.delete(k),
  key: (i: number) => [...m.keys()][i] ?? null,
  get length() {
    return m.size;
  },
});
(globalThis as any).localStorage = mk(store);
(globalThis as any).sessionStorage = mk(session);
(globalThis as any).window = { addEventListener() {}, setInterval: () => 0, clearInterval() {} };
(globalThis as any).document = { addEventListener() {}, visibilityState: 'visible' };
const { SettingsSync, snapshotSettings, parseSettings, serialize } = await import('../src/settingsSync');

describe('settings sync', () => {
  beforeEach(() => {
    store.clear();
    session.clear();
  });

  it('never snapshots credentials, guest progress or the name', () => {
    store.set('arena.session.v1', 'secret');
    store.set('arena.profile.v1', '{}');
    store.set('arena.name', 'x');
    store.set('arena.hud.v1', '{"a":1}');
    store.set('other', 'y');
    assert.deepEqual(snapshotSettings(), { 'arena.hud.v1': '{"a":1}' });
  });

  it('parseSettings drops foreign and excluded keys', () => {
    const s = parseSettings(JSON.stringify({ 'arena.a': '1', evil: '2', 'arena.session.v1': 'tok', 'arena.n': 5 }));
    assert.deepEqual(s, { 'arena.a': '1' });
    assert.equal(parseSettings('not json'), null);
    assert.equal(parseSettings(''), null);
  });

  it('uploads local settings when the account has none, applies the account copy once otherwise', () => {
    const sent: string[] = [];
    let reloads = 0;
    const sync = new SettingsSync((d) => sent.push(d), () => reloads++);
    store.set('arena.hud.v1', 'mine');
    assert.equal(sync.onServer(''), 'uploaded');
    assert.equal(sent.length, 1);

    const theirs = serialize({ 'arena.hud.v1': 'cloud', 'arena.keys': 'k' });
    assert.equal(sync.onServer(theirs), 'reload');
    assert.equal(reloads, 1);
    assert.equal(store.get('arena.hud.v1'), 'cloud');
    assert.equal(sync.onServer(theirs), 'same');

    // a startup rewrite makes the copies differ right after a reload: keep local instead of looping
    store.set('arena.extra', 'x');
    assert.equal(sync.onServer(theirs), 'uploaded');
    assert.equal(reloads, 1);
  });

  it('flush uploads only changes', () => {
    const sent: string[] = [];
    const sync = new SettingsSync((d) => sent.push(d), () => {});
    store.set('arena.a', '1');
    sync.onServer(serialize({ 'arena.a': '1' }));
    sync.flush();
    assert.equal(sent.length, 0);
    store.set('arena.a', '2');
    sync.flush();
    assert.equal(sent.length, 1);
  });
});
