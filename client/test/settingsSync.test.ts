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
const { SettingsSync, snapshotSettings, parseSettings, serialize, mergeSettings } = await import('../src/settingsSync');

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

  it('keeps edits the server never received instead of rolling them back on refresh', () => {
    const sent: string[] = [];
    let reloads = 0;
    const sync = new SettingsSync((d) => sent.push(d), () => reloads++);
    store.set('arena.build.v1.rogue', 'old');
    assert.equal(sync.onServer(serialize({ 'arena.build.v1.rogue': 'old' })), 'same');
    store.set('arena.build.v1.rogue', 'new talents'); // picked, then refreshed before the upload went out
    const again = new SettingsSync((d) => sent.push(d), () => reloads++);
    assert.equal(again.onServer(serialize({ 'arena.build.v1.rogue': 'old' })), 'uploaded');
    assert.equal(reloads, 0);
    assert.equal(store.get('arena.build.v1.rogue'), 'new talents');
  });

  it('a device that uploaded once does not overwrite what another device changed since', () => {
    const sent: string[] = [];
    let reloads = 0;
    const laptop = new SettingsSync((d) => sent.push(d), () => reloads++);
    store.set('arena.keys', 'R=reset');
    store.set('arena.hud.v1', 'big');
    laptop.onServer('', 'ann'); // first upload from this browser
    const server = sent.at(-1)!;
    // the desktop changes the keybinds and uploads them
    const desktop = { ...JSON.parse(server), 'arena.keys': 'R=renew' };
    // back on the laptop, with the old keybinds still in storage: the desktop's change is taken, nothing is sent over it
    sent.length = 0;
    const again = new SettingsSync((d) => sent.push(d), () => reloads++);
    assert.equal(again.onServer(serialize(desktop), 'ann'), 'reload');
    assert.equal(store.get('arena.keys'), 'R=renew');
    assert.equal(sent.length, 0, 'the old keybinds were not uploaded over the new ones');
  });

  it('changes on both devices are merged setting by setting', () => {
    const base = { 'arena.a': '1', 'arena.b': '1', 'arena.c': '1' };
    const local = { 'arena.a': '2', 'arena.b': '1', 'arena.c': '1' }; // a changed here
    const theirs = { 'arena.a': '1', 'arena.b': '3' }; // b changed, c removed elsewhere
    assert.deepEqual(mergeSettings(base, local, theirs), { 'arena.a': '2', 'arena.b': '3' });
  });

  it('two accounts on one browser keep separate bases', () => {
    const sent: string[] = [];
    const sync = new SettingsSync((d) => sent.push(d), () => {});
    store.set('arena.x', 'ann');
    sync.onServer(serialize({ 'arena.x': 'ann' }), 'ann');
    assert.ok(store.has('arena.syncBase.ann'));
    sync.onServer(serialize({ 'arena.x': 'ann' }), 'bob');
    assert.ok(store.has('arena.syncBase.bob'));
    assert.ok(!Object.keys(snapshotSettings()).some((k) => k.startsWith('arena.syncBase')), 'bases are never synced');
  });

  it('an upload that could not be sent is not counted as synced', () => {
    let online = false;
    const sent: string[] = [];
    const sync = new SettingsSync((d) => (online ? (sent.push(d), true) : false), () => {});
    store.set('arena.a', '1');
    sync.onServer(serialize({ 'arena.a': '1' }), 'ann');
    store.set('arena.a', '2');
    sync.flush();
    assert.equal(sent.length, 0);
    online = true;
    sync.flush();
    assert.equal(sent.length, 1, 'retried once the connection is back');
  });
});

describe('seen tours follow the account', () => {
  const K = 'arena.tours.v1';
  it('is synced like every arena.* key and survives parsing', () => {
    store.clear();
    store.set(K, '{"menu":5}');
    assert.deepEqual(snapshotSettings(), { [K]: '{"menu":5}' });
    assert.deepEqual(parseSettings(JSON.stringify({ [K]: '{"menu":5}' })), { [K]: '{"menu":5}' });
  });

  it('merges the lists of two devices: a tour seen on either stays seen', () => {
    const base = { [K]: '{"menu":1}' };
    const local = { [K]: '{"menu":1,"hud":9}' };
    const theirs = { [K]: '{"menu":1,"build":4}' };
    const both = JSON.parse(mergeSettings(base, local, theirs)[K]);
    assert.equal(both.hud, 9);
    assert.equal(both.build, 4);
    // a first sync on this browser: tours seen here as a guest are kept next to the account's
    const first = mergeSettings(null, { [K]: '{"watch":2}' }, { [K]: '{"menu":3}' });
    assert.deepEqual(JSON.parse(first[K]), { menu: 3, watch: 2 });
    // changed only on the other device: taken as it is
    assert.equal(mergeSettings(base, base, theirs)[K], theirs[K]);
  });
});
