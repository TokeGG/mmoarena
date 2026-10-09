import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ICONS, ICON_LIST, applyPatches, fileIconIdFor, iconIdFor } from '@arena/shared';
import type { DataPatch } from '@arena/shared';
import { EditSet, patchKey } from '../src/devEdits';
import { chooseIcon, chosenIcon, gridIcons, iconChanged, iconOffered, iconPick, iconTarget, packChips, previewOf, putBackIcon } from '../src/iconEditLogic';
import { setIconPreview, shownIconId, emojiFor } from '../src/iconArt';

const none = new Map<string, DataPatch>();
const priv = ICON_LIST.find((i) => i.pack.startsWith('steadykeel'))!;

describe('the Icon edit page: the grid', () => {
  it('filters by search and by pack, and counts for the chips', () => {
    assert.equal(gridIcons('', '').length, ICON_LIST.filter((i) => !i.pack.startsWith('steadykeel')).length, 'private packs are hidden until the server has them');
    assert.equal(gridIcons('barbarian', '').length, 40);
    assert.equal(gridIcons('', 'frostmage').length, 25);
    assert.equal(gridIcons('barbarian', 'frostmage').length, 0);
    const chips = packChips('barbarian');
    assert.equal(chips[0].id, '');
    assert.equal(chips[0].count, 40);
    assert.equal(chips.find((c) => c.id === 'barbarian')!.count, 40);
    assert.equal(chips.find((c) => c.id === 'firemage')!.count, 0);
  });

  it('shows a private pack only when the server has its icons, and marks its chip with a lock', () => {
    assert.ok(!iconOffered(priv, null));
    assert.ok(!iconOffered(priv, new Set()));
    assert.ok(iconOffered(priv, new Set([priv.id])));
    assert.ok(!packChips('', null).some((c) => c.locked));
    const withIt = packChips('', new Set([priv.id]));
    assert.ok(withIt.find((c) => c.id === priv.pack)!.locked);
    assert.deepEqual(gridIcons('', priv.pack, new Set([priv.id])).map((i) => i.id), [priv.id]);
    assert.equal(withIt[0].count, gridIcons('', '', new Set([priv.id])).length);
  });
});

describe('the Icon edit page: picking', () => {
  it('a navigation id names a skill or a buff', () => {
    assert.deepEqual(iconTarget('a:fireball'), { kind: 'ability', id: 'fireball' });
    assert.deepEqual(iconTarget('u:polymorph'), { kind: 'aura', id: 'polymorph' });
    assert.equal(iconTarget('fireball'), null);
    assert.deepEqual(iconPick('a:fireball', 'icons151/icon-9'), { file: 'icons', id: 'fireball', path: ['ability'], value: 'icons151/icon-9' });
    assert.equal(iconPick('a:fireball', 'nope/nope'), null);
  });

  it('a pick is a pending change, picking the default is putting it back, and the screen follows before anything is sent', () => {
    const set = new EditSet();
    const def = fileIconIdFor('ability', 'fireball')!;
    assert.equal(chosenIcon(set, 'a:fireball', none), def);
    assert.ok(chooseIcon(set, 'a:fireball', 'icons151/icon-9', none));
    assert.ok(!chooseIcon(set, 'a:fireball', 'nope/nope', none));
    assert.equal(chosenIcon(set, 'a:fireball', none), 'icons151/icon-9');
    assert.ok(iconChanged(set, 'a:fireball', none));
    assert.deepEqual([...set.edits.values()], [{ file: 'icons', id: 'fireball', path: ['ability'], value: 'icons151/icon-9' }]);
    const rows = set.rows([]);
    assert.equal(rows[0].owner, 'Fireball');
    assert.equal(rows[0].label, 'Icon');
    assert.equal(rows[0].toText, 'icons151/icon-9');
    assert.equal(rows[0].fromText, def);
    // on screen at once
    assert.deepEqual([...previewOf(set)], [['ability:fireball', 'icons151/icon-9']]);
    setIconPreview(previewOf(set));
    assert.equal(shownIconId('ability', 'fireball'), 'icons151/icon-9');
    putBackIcon(set, 'a:fireball', none);
    assert.equal(set.edits.size, 0);
    assert.ok(!iconChanged(set, 'a:fireball', none));
    setIconPreview(previewOf(set));
    assert.equal(shownIconId('ability', 'fireball'), def);
    assert.ok(emojiFor('ability', 'fireball'));
  });

  it('putting back an icon that is being tried (or saved for everyone) shows the file icon again', () => {
    const tried: DataPatch = { file: 'icons', id: 'fireball', path: ['ability'], value: 'icons151/icon-9' };
    const undo = applyPatches([tried]);
    const testing = new Map([[patchKey(tried), tried]]);
    const set = new EditSet();
    assert.equal(chosenIcon(set, 'a:fireball', testing), 'icons151/icon-9');
    putBackIcon(set, 'a:fireball', testing);
    assert.ok(set.reverted.has(patchKey(tried)));
    assert.equal(chosenIcon(set, 'a:fireball', testing), fileIconIdFor('ability', 'fireball'));
    assert.deepEqual([...previewOf(set)], [['ability:fireball', fileIconIdFor('ability', 'fireball')]]);
    // what is sent: the tried change is dropped
    assert.deepEqual(set.patches([tried]), []);
    undo();
    assert.equal(iconIdFor('ability', 'fireball'), ICONS.abilities.fireball);
  });

  it('a buff picks its own icon apart from the skill that applies it', () => {
    const set = new EditSet();
    assert.ok(chooseIcon(set, 'u:frost_nova_root', 'icons151/icon-9', none));
    assert.deepEqual([...set.edits.keys()], ['icons:frost_nova_root:aura']);
    assert.equal(set.rows([])[0].owner, 'Frost Nova (debuff)');
    assert.equal(chosenIcon(set, 'a:frost_nova', none), fileIconIdFor('ability', 'frost_nova'), 'the skill itself is not touched');
  });
});
