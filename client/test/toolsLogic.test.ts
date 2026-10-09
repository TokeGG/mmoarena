import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminTabAccess, devAccess, f2Decision, loadTab, otherTab, parseTab, pickTab, saveTab, visibleTabs } from '../src/toolsLogic';

const guest = null;
const player = { role: 'player', grants: [] as string[] };
const dev = { role: 'player', grants: ['dev'] };
const ownerLocked = { role: 'owner', ownerOk: false, grants: [] as string[] };
const owner = { role: 'owner', ownerOk: true, grants: [] as string[] };

test('which tabs an account sees', () => {
  assert.deepEqual(visibleTabs(guest), []);
  assert.deepEqual(visibleTabs(player), []);
  assert.deepEqual(visibleTabs(dev), ['dev', 'admin']);
  assert.deepEqual(visibleTabs(owner), ['dev', 'admin']);
  // the owner before entering the code: only the Admin tab (it shows the unlock form)
  assert.deepEqual(visibleTabs(ownerLocked), ['admin']);
  assert.equal(devAccess(ownerLocked), false);
  assert.equal(adminTabAccess(ownerLocked), true);
  assert.equal(devAccess(dev), true);
});

test('the tab shown: asked, else remembered, else the first', () => {
  const both = visibleTabs(owner);
  assert.equal(pickTab(both, 'admin', 'dev'), 'admin');
  assert.equal(pickTab(both, null, 'admin'), 'admin');
  assert.equal(pickTab(both, undefined, null), 'dev');
  assert.equal(pickTab(['admin'], 'dev', 'dev'), 'admin'); // a tab the account cannot see is never picked
  assert.equal(pickTab([], 'dev', 'dev'), null);
});

test('remembered tab survives a bad or missing store', () => {
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  assert.equal(loadTab(store), null);
  saveTab('admin', store);
  assert.equal(loadTab(store), 'admin');
  mem.set('arena.tools.tab', 'nonsense');
  assert.equal(loadTab(store), null);
  assert.equal(parseTab('dev'), 'dev');
  assert.equal(parseTab(3), null);
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(loadTab(broken), null);
  assert.doesNotThrow(() => saveTab('dev', broken));
});

test('other tab', () => {
  assert.equal(otherTab(['dev', 'admin'], 'dev'), 'admin');
  assert.equal(otherTab(['dev', 'admin'], 'admin'), 'dev');
  assert.equal(otherTab(['admin'], 'admin'), 'admin');
});

test('F2 opens and closes, Shift+F2 switches', () => {
  const v = visibleTabs(owner);
  assert.deepEqual(f2Decision({ visible: [], open: false, tab: null, shift: false }), { kind: 'ignore' }); // normal players: the key does nothing
  assert.deepEqual(f2Decision({ visible: v, open: false, tab: null, shift: false }), { kind: 'open', tab: 'dev' });
  assert.deepEqual(f2Decision({ visible: v, open: false, tab: 'admin', shift: false }), { kind: 'open', tab: 'admin' }); // the remembered tab
  assert.deepEqual(f2Decision({ visible: v, open: true, tab: 'admin', shift: false }), { kind: 'close' });
  assert.deepEqual(f2Decision({ visible: v, open: true, tab: 'dev', shift: true }), { kind: 'switch', tab: 'admin' });
  assert.deepEqual(f2Decision({ visible: v, open: true, tab: 'admin', shift: true }), { kind: 'switch', tab: 'dev' });
  assert.deepEqual(f2Decision({ visible: v, open: false, tab: 'dev', shift: true }), { kind: 'open', tab: 'admin' });
  assert.deepEqual(f2Decision({ visible: ['admin'], open: true, tab: 'admin', shift: true }), { kind: 'ignore' });
  assert.deepEqual(f2Decision({ visible: ['admin'], open: false, tab: 'dev', shift: false }), { kind: 'open', tab: 'admin' }); // remembered tab no longer visible
});
