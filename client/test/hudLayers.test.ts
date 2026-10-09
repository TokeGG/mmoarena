import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { layerLayout, layerSlot, packHudDefault, parseHudDefault, HUD_IDS, HUD_DEFAULT_MAX_CHARS } from '@arena/shared';
import { sameLayout, sourceOf, tagText, viewLayout, whereText } from '../src/hudLayers';

const P = { fx: 0.1, fy: 0.1, s: 1 };
const D = { fx: 0.3, fy: -0.2, s: 1.2 };
const none = new Set<string>();

describe("HUD layers: personal over the owner's default over the built-in spot", () => {
  it('layerSlot picks personal first, then the default, then nothing', () => {
    assert.deepEqual(layerSlot('builds', { builds: P }, { builds: D }), { slot: P, from: 'personal' });
    assert.deepEqual(layerSlot('builds', {}, { builds: D }), { slot: D, from: 'default' });
    assert.deepEqual(layerSlot('builds', {}, null), { slot: null, from: 'builtin' });
    assert.deepEqual(layerSlot('builds', { announce: P }, { announce: D }), { slot: null, from: 'builtin' });
  });

  it("layerLayout keeps the player's moves and follows the default for everything else", () => {
    assert.deepEqual(layerLayout({ builds: P }, { builds: D, announce: D }), { builds: P, announce: D });
    // the owner changes the default later: the moved element stays, the unmoved one follows
    assert.deepEqual(layerLayout({ builds: P }, { builds: D, announce: { ...D, fx: 0.5 } }), { builds: P, announce: { ...D, fx: 0.5 } });
    // the default is removed: only the player's own moves remain
    assert.deepEqual(layerLayout({ builds: P }, null), { builds: P });
  });

  it('sourceOf says where an element comes from, per edit mode', () => {
    const l = { saved: { builds: P }, def: { builds: D, announce: D }, draft: { announce: D }, touched: none };
    assert.equal(sourceOf('me', 'builds', l), 'own');
    assert.equal(sourceOf('me', 'announce', l), 'default');
    assert.equal(sourceOf('me', 'damp', l), 'builtin');
    assert.equal(sourceOf('me', 'damp', { ...l, touched: new Set(['damp']) }), 'own', 'just moved counts');
    // "everyone" mode only knows the draft
    assert.equal(sourceOf('all', 'builds', l), 'builtin');
    assert.equal(sourceOf('all', 'announce', l), 'own');
  });

  it('what is on screen: the draft for the owner editing everyone, else the layered layout', () => {
    const l = { saved: { builds: P }, def: { announce: D }, draft: { damp: D } };
    assert.deepEqual(viewLayout('all', l), { damp: D });
    assert.deepEqual(viewLayout('me', l), { builds: P, announce: D });
  });

  it('tags and texts: a diamond only while following the default in "just me" mode', () => {
    assert.equal(tagText('Builds panel', 'me', 'default'), 'Builds panel ◆ default');
    assert.equal(tagText('Builds panel', 'me', 'own'), 'Builds panel');
    assert.equal(tagText('Builds panel', 'all', 'default'), 'Builds panel');
    assert.match(whereText('me', 'default'), /following the owner/);
    assert.match(whereText('me', 'own'), /your own/);
    assert.match(whereText('all', 'own'), /default layout/);
  });

  it('sameLayout ignores key order and notices any difference', () => {
    assert.ok(sameLayout({ a: P, b: D }, { b: D, a: P }));
    assert.ok(!sameLayout({ a: P }, { a: D }));
    assert.ok(!sameLayout({ a: P }, {}));
  });
});

describe('the default layout is validated with the same bounds as a personal one', () => {
  it('keeps known elements, clamps values, drops the rest, and refuses an empty result', () => {
    assert.deepEqual(parseHudDefault({ builds: { fx: 3, fy: -3, s: 0.1, w: 1, h: 99999 }, nope: { fx: 0, fy: 0, s: 1 }, announce: { fx: 'x', fy: 0, s: 1 } }), { builds: { fx: 1, fy: -1, s: 0.6, w: 40, h: 1400 } });
    assert.equal(parseHudDefault({}), null);
    assert.equal(parseHudDefault(null), null);
    assert.equal(parseHudDefault([1, 2]), null);
    assert.equal(parseHudDefault({ builds: { dx: 10, dy: 10, s: 1 } }), null, 'pixel layouts are not accepted for the default');
  });

  it('a layout with every element stays under the cap, and packing is stable', () => {
    const all = Object.fromEntries(HUD_IDS.map((id) => [id, { fx: -0.123456789, fy: 0.987654321, s: 1.55, w: 1999, h: 1399 }]));
    const packed = packHudDefault(parseHudDefault(all)!)!;
    assert.ok(packed.length < HUD_DEFAULT_MAX_CHARS);
    assert.deepEqual(Object.keys(JSON.parse(packed)), [...HUD_IDS]);
    assert.equal(packHudDefault({}), null);
  });
});
