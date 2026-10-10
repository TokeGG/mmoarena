import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
const { LOOK_OPTIONS } = await import('../src/hudLook');
const { LOOK_SECTIONS, groupsOf, optionsOfSection, searchLook, sectionOfOption } = await import('../src/lookSections');

describe('Look window sections', () => {
  it('has the five sections in a fixed order', () => {
    assert.deepEqual(LOOK_SECTIONS.map((s) => s.id), ['character', 'name', 'cursor', 'hud', 'effects']);
  });

  it('puts every HUD look option in exactly one section, and none is lost', () => {
    const hud = optionsOfSection('hud', LOOK_OPTIONS);
    const fx = optionsOfSection('effects', LOOK_OPTIONS);
    // the old single-profile nameplate dropdowns are replaced by the nameplate editor, so they are in no section
    const old = LOOK_OPTIONS.filter((o) => o.group === 'Nameplates');
    assert.ok(old.length > 0);
    assert.equal(hud.length + fx.length + old.length, LOOK_OPTIONS.length);
    assert.equal(new Set([...hud, ...fx].map((o) => o.id)).size, LOOK_OPTIONS.length - old.length);
    for (const o of LOOK_OPTIONS) assert.ok(['hud', 'effects'].includes(sectionOfOption(o)), o.id);
    assert.ok(fx.every((o) => ['Error text', 'Stun text', 'Network stats'].includes(o.group ?? '')));
    assert.ok(!hud.some((o) => o.group === 'Nameplates'), 'nameplates have their own editor');
    assert.ok(!optionsOfSection('character', LOOK_OPTIONS).length && !optionsOfSection('cursor', LOOK_OPTIONS).length);
  });

  it('groups options under their headings, keeping the order', () => {
    const groups = groupsOf(optionsOfSection('hud', LOOK_OPTIONS));
    assert.equal(groups[0].group, '');
    assert.deepEqual(groups.map((g) => g.group).slice(1, 4), ['Kill feed', 'DPS meter', 'Health bars']);
    assert.equal(groups.reduce((n, g) => n + g.options.length, 0), optionsOfSection('hud', LOOK_OPTIONS).length);
  });

  it('search finds sections by name and keyword, and options by label', () => {
    assert.deepEqual(searchLook('', LOOK_OPTIONS), { sections: [], options: [] });
    assert.deepEqual(searchLook('cursor', LOOK_OPTIONS).sections.map((s) => s.id), ['cursor']);
    assert.ok(searchLook('title', LOOK_OPTIONS).sections.some((s) => s.id === 'name'));
    assert.ok(searchLook('emblem', LOOK_OPTIONS).sections.some((s) => s.id === 'name'));
    const plates = searchLook('nameplate width', LOOK_OPTIONS);
    assert.deepEqual(plates.options.map((o) => o.id), [], 'nameplate options are in the editor now');
    assert.ok(searchLook('stun', LOOK_OPTIONS).options.every((o) => /stun/i.test(`${o.label} ${o.group} ${o.id} ${o.choices.map((c) => c[1])}`)));
    assert.deepEqual(searchLook('zzzz', LOOK_OPTIONS), { sections: [], options: [] });
  });

  it('search is case and punctuation tolerant and needs every word', () => {
    assert.ok(searchLook('  HEALTH   Bar-Height ', LOOK_OPTIONS).options.some((o) => o.id === 'barHeight'));
    assert.equal(searchLook('health zzzz', LOOK_OPTIONS).options.length, 0);
  });

  it('extra words (gear names) only count for the character section', () => {
    assert.deepEqual(searchLook('halo', LOOK_OPTIONS, ['Halo', 'Crown']).sections.map((s) => s.id), ['character']);
    assert.equal(searchLook('halo', LOOK_OPTIONS).sections.length, 0);
  });
});
