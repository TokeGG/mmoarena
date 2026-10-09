import { navIdOf, pageOwns } from '../src/devPages';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { entryFor } from '@arena/shared';
import type { DataPatch, DevField } from '@arena/shared';
import { EditSet, patchKey, showValue } from '../src/devEdits';

const field = (page: 'specs' | 'options' | 'classes', id: string, path: string): DevField =>
  entryFor(page, id)!.groups.flatMap((g) => g.fields).find((f) => f.path.join('.') === path)!;

describe('what a dev has typed in the panel', () => {
  const pws = field('passives', 's:discipline', 'mods.ability.power_word_shield.heal');
  const gcd = field('options', 'game', 'gcdMs');
  const none = new Map<string, DataPatch>();

  it('a typed value shows as changed, goes into the patches, and a value equal to the file is the same as none', () => {
    const e = new EditSet();
    assert.equal(e.shown(pws, none), 1.5);
    assert.ok(!e.changed(pws, none));
    e.set(pws, 2, none);
    assert.equal(e.shown(pws, none), 2);
    assert.ok(e.changed(pws, none) && e.pending(pws));
    assert.deepEqual(e.patches([]).map((p) => p.value), [2]);
    e.set(pws, 1.5, none);
    assert.ok(!e.changed(pws, none) && !e.pending(pws));
    assert.deepEqual(e.patches([]), []);
  });

  it('a value already being tried can be put back: it leaves the patches that are sent', () => {
    const e = new EditSet();
    const tried: DataPatch[] = [patchOfField(gcd, 1500), patchOfField(pws, 3)];
    const testing = new Map(tried.map((p) => [patchKey(p), p]));
    assert.equal(e.shown(gcd, testing), 1500);
    assert.ok(e.changed(gcd, testing));
    e.set(gcd, gcd.base, testing);
    assert.equal(e.shown(gcd, testing), 1000);
    assert.deepEqual(e.patches(tried).map((p) => p.id), ['discipline'], 'only the Warden number is still sent');
    e.set(pws, 4, testing);
    assert.deepEqual(e.patches(tried).map((p) => p.value), [4], 'what was typed replaces what was being tried');
  });

  it('the Tuning tab cannot put proposals back from here', () => {
    const e = new EditSet();
    const tried = [patchOfField(gcd, 1500)];
    const testing = new Map(tried.map((p) => [patchKey(p), p]));
    e.set(gcd, gcd.base, testing, false);
    assert.equal(e.reverted.size, 0);
    assert.equal(e.patches(tried).length, 1);
  });

  it('the rows list every change as old -> new, typed ones first, and undo works on both kinds', () => {
    const e = new EditSet();
    const tried = [patchOfField(gcd, 1500)];
    const testing = new Map(tried.map((p) => [patchKey(p), p]));
    e.set(pws, 2, testing);
    const rows = e.rows(tried);
    assert.deepEqual(rows.map((r) => [r.owner, r.pending]), [['Warden', true], ['Game options', false]]);
    assert.equal(rows[0].fromText, '1.5 (+50%)');
    assert.equal(rows[0].toText, '2 (+100%)');
    assert.equal(rows[1].fromText, '1000 (1 s)');
    assert.equal(rows[1].toText, '1500 (1.5 s)');
    assert.match(rows[0].label, /shield strength/);
    e.undo(rows[0].key, testing);
    e.undo(rows[1].key, testing);
    assert.deepEqual(e.rows(tried), []);
    assert.equal(e.size, 1, 'the value being tried is marked as put back');
  });

  it('a page reset puts back typed and tried values on its files only', () => {
    const e = new EditSet();
    const regen = field('classes', 'mage', 'resource.regenPerSec');
    const tried = [patchOfField(gcd, 1500), patchOfField(regen, 40)];
    const testing = new Map(tried.map((p) => [patchKey(p), p]));
    e.set(pws, 2, testing);
    e.resetFiles(['tuning'], tried);
    assert.deepEqual(e.patches(tried).map((p) => p.file).sort(), ['classes', 'specs']);
    e.resetAll(tried);
    assert.deepEqual(e.patches(tried), []);
  });

  it('a value only different from the file because of a saved number is put back by saying the file value outright', () => {
    const e = new EditSet();
    const live = { ...gcd, value: 1300 };
    e.set(live, live.base, none);
    assert.deepEqual(e.patches([]).map((p) => p.value), [1000]);
  });

  it('values are worded for the lists', () => {
    assert.equal(showValue({ file: 'specs', id: 'discipline', path: ['mods', 'ability', 'penance', 'castWhileMoving'] }, 1), 'on');
    assert.equal(showValue({ file: 'tuning', id: 'game', path: ['cauterizeHealth'] }, 0.35), '0.35 (35%)');
  });
});

function patchOfField(f: DevField, value: number): DataPatch {
  return { file: f.file, id: f.id, path: f.path, value };
}

describe('which page owns a change', () => {
  it('stat bonuses, skill changes and Cauterize are Passives; the rest stays on its own page', () => {
    const mod = { file: 'specs', id: 'discipline', path: ['mods', 'ability', 'penance', 'castWhileMoving'], value: 1 } as const;
    assert.ok(pageOwns('passives', mod) && !pageOwns('specs', mod));
    const auto = { file: 'specs', id: 'fire', path: ['auto', 'damage'], value: 9 } as const;
    assert.ok(pageOwns('specs', auto) && !pageOwns('passives', auto));
    const caut = { file: 'tuning', id: 'game', path: ['cauterizeHealth'], value: 0.3 } as const;
    assert.ok(pageOwns('passives', caut) && !pageOwns('options', caut));
    assert.ok(pageOwns('options', { file: 'tuning', id: 'game', path: ['gcdMs'], value: 1200 }));
    assert.equal(navIdOf('passives', mod), 's:discipline');
    assert.equal(navIdOf('passives', { file: 'talents', id: 'x', path: ['mods', 'a'], value: 1 }), 't:x');
  });
});
