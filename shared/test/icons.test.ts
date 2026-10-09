import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ABILITIES, AURAS, CLASSES, DEV_PAGES, ICONLIB, ICONS, ICON_LIST, ICON_PACKS, SPECS, applyPatches, auraSource, contentHash, currentValue, entryFor, fileDefault, fileIconIdFor, iconIdFor, iconPatch, iconUrl, isPrivateIcon, navFor, nameOf, packCounts, plainPath, resolveIcon, searchIcons, validPatch } from '../src/index';
import type { DataPatch } from '../src/index';

const publicDir = new URL('../../client/public', import.meta.url).pathname;
const live = Object.values(ABILITIES).filter((a) => !a.retired);

describe('the icon library and the default icons', () => {
  it('every icon of the manifest is unique, belongs to a pack, and its file is in client/public (private packs are served by the server, not stored)', () => {
    assert.equal(new Set(ICON_LIST.map((i) => i.id)).size, ICON_LIST.length);
    for (const i of ICON_LIST) {
      assert.ok(ICON_PACKS.some((p) => p.id === i.pack), i.id);
      assert.equal(i.file, `/icons/${i.id}.webp`);
      if (!isPrivateIcon(i.id)) assert.ok(fs.existsSync(`${publicDir}${i.file}`), `${i.id} has no file`);
    }
    for (const p of ICON_PACKS) assert.equal(ICON_LIST.filter((i) => i.pack === p.id).length, p.count, p.id);
    assert.ok(ICON_PACKS.filter((p) => p.private).length >= 1, 'the licence-restricted pack is marked private');
  });

  it('every ability that can appear on a bar has an icon of the library, a public one, and no two abilities of a spec share it', () => {
    for (const a of live) {
      const id = ICONS.abilities[a.id];
      assert.ok(id, `${a.id} has no icon`);
      assert.ok(ICON_LIST.some((i) => i.id === id), `${a.id}: ${id} is not in the library`);
      assert.ok(!isPrivateIcon(id), `${a.id} must not use a private pack by default`);
      assert.ok(fs.existsSync(`${publicDir}${iconUrl(id)}`), `${a.id}: file of ${id}`);
    }
    for (const [cls, specs] of Object.entries(SPECS)) {
      for (const s of specs) {
        const bar = [...new Set([...s.bar, ...CLASSES[cls as keyof typeof CLASSES].bar])];
        const icons = bar.map((a) => ICONS.abilities[a]);
        assert.equal(new Set(icons).size, icons.length, `${s.id} repeats an icon`);
      }
    }
    assert.equal(new Set(live.map((a) => ICONS.abilities[a.id])).size, live.length, 'abilities do not share icons');
  });

  it('every buff wears an icon (its own, else its skill\'s) and nothing is left over for things that are gone', () => {
    for (const id of Object.keys(AURAS)) {
      const icon = iconIdFor('aura', id);
      assert.ok(icon && ICON_LIST.some((i) => i.id === icon), `aura ${id}`);
      assert.ok(!isPrivateIcon(icon), id);
    }
    assert.deepEqual(Object.keys(ICONS.abilities).filter((id) => !ABILITIES[id] || ABILITIES[id].retired), []);
    assert.deepEqual(Object.keys(ICONS.auras).filter((id) => !AURAS[id]), []);
  });

  it('a buff with no icon of its own wears the icon of the skill that applies it', () => {
    assert.equal(auraSource('frost_nova_root'), 'frost_nova');
    assert.equal(iconIdFor('aura', 'frost_nova_root'), ICONS.abilities.frost_nova);
    assert.equal(iconIdFor('aura', 'polymorph'), ICONS.abilities.polymorph);
    // its own entry wins
    assert.equal(resolveIcon({ abilities: { frost_nova: 'icons151/icon-1' }, auras: { frost_nova_root: 'icons151/icon-2' } }, 'aura', 'frost_nova_root'), 'icons151/icon-2');
    assert.equal(resolveIcon({ abilities: { frost_nova: 'icons151/icon-1' }, auras: {} }, 'aura', 'frost_nova_root'), 'icons151/icon-1');
    assert.equal(resolveIcon({ abilities: {}, auras: {} }, 'ability', 'frost_nova'), null);
    assert.equal(resolveIcon({ abilities: {}, auras: {} }, 'ability', 'constructor'), null);
  });
});

describe('searching the library', () => {
  it('matches names, packs and tags, all words together, and narrows to one pack', () => {
    assert.equal(searchIcons('').length, ICON_LIST.length);
    assert.ok(searchIcons('barbarian', 'barbarian').every((i) => i.pack === 'barbarian') && searchIcons('barbarian', 'barbarian').length === 40);
    assert.ok(searchIcons('fire bolt').some((i) => i.id.startsWith('spellset/fire-bolt')));
    assert.equal(searchIcons('zzzz nothing').length, 0);
    assert.ok(searchIcons('icon 12', 'icons151').every((i) => i.pack === 'icons151'));
    assert.ok(searchIcons('revive', 'spellset').length >= 2);
    assert.equal(searchIcons('revive', 'barbarian').length, 0);
    // tags: the framed round icons are grouped by school
    assert.ok(searchIcons('arcane').some((i) => i.pack.startsWith('steadykeel')));
  });

  it('counts the matches of each pack for the chips', () => {
    const all = packCounts('');
    assert.equal(all.reduce((n, c) => n + c.count, 0), ICON_LIST.length);
    assert.equal(packCounts('barbarian').find((c) => c.pack.id === 'barbarian')!.count, 40);
    assert.equal(packCounts('barbarian').find((c) => c.pack.id === 'firemage')!.count, 0);
  });
});

describe('icons are patched like any other value, and stay visual', () => {
  const p: DataPatch = iconPatch('a:fireball', 'frostmage/frost-mage-5');
  const was = ICONS.abilities.fireball;

  it('a patch names a skill or buff that exists and an icon of the library, and nothing else', () => {
    assert.deepEqual(p, { file: 'icons', id: 'fireball', path: ['ability'], value: 'frostmage/frost-mage-5' });
    assert.ok(validPatch(p));
    assert.ok(validPatch(iconPatch('u:polymorph', 'icons151/icon-1')));
    assert.ok(!validPatch({ ...p, value: 'nowhere/none' }), 'an icon the library lacks');
    assert.ok(!validPatch({ ...p, value: 3 }));
    assert.ok(!validPatch({ ...p, id: 'not_a_skill' }));
    assert.ok(!validPatch({ ...p, id: '__proto__' }));
    assert.ok(!validPatch({ ...p, path: ['aura'] }), 'fireball is not a buff');
    assert.ok(!validPatch({ ...p, path: ['icon'] }));
    assert.ok(!validPatch({ ...p, path: ['ability', 'x'] }));
  });

  it('is live at once, is put back, and never touches the simulation hash', () => {
    const hash = contentHash();
    assert.equal(currentValue(p), was);
    const undo = applyPatches([p, iconPatch('u:frost_nova_root', 'icons151/icon-9')]);
    assert.equal(iconIdFor('ability', 'fireball'), 'frostmage/frost-mage-5');
    assert.equal(iconIdFor('aura', 'frost_nova_root'), 'icons151/icon-9', 'a buff gets an entry of its own');
    assert.equal(contentHash(), hash, 'icons.json is not part of the content hash');
    assert.equal(fileDefault(p), was, 'the file value stays what the file says');
    assert.equal(fileIconIdFor('ability', 'fireball'), was);
    undo();
    assert.equal(iconIdFor('ability', 'fireball'), was);
    assert.equal(iconIdFor('aura', 'frost_nova_root'), ICONS.abilities.frost_nova);
    assert.ok(!Object.hasOwn(ICONS.auras, 'frost_nova_root'), 'the entry made for the buff is removed again');
  });

  it('has words for the changes list', () => {
    assert.equal(nameOf('icons', 'fireball', ['ability']), 'Fireball');
    assert.equal(nameOf('icons', 'polymorph', ['aura']), 'Polymorph (debuff)');
    assert.equal(plainPath('icons', 'fireball', ['ability']).label, 'Icon');
  });
});

describe('the Icon edit page', () => {
  it('is on the page row, in its own step, labelled Icon edit', () => {
    const page = DEV_PAGES.find((x) => x.id === 'icons')!;
    assert.equal(page.label, 'Icon edit');
    assert.equal(page.step, 'Look');
  });

  it('lists every skill that can appear on a bar and every buff and debuff, each opening an entry', () => {
    const ids: string[] = [];
    const walk = (g: ReturnType<typeof navFor>[number]) => {
      g.entries.forEach((e) => ids.push(e.id));
      g.groups?.forEach(walk);
    };
    navFor('icons').forEach(walk);
    for (const a of live) assert.ok(ids.includes(`a:${a.id}`), `skill ${a.id} is not on the page`);
    for (const id of Object.keys(AURAS)) assert.ok(ids.includes(`u:${id}`), `buff ${id} is not on the page`);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.ok(entryFor('icons', id), id);
    assert.equal(entryFor('icons', 'a:nope'), null);
    assert.equal(entryFor('icons', 'fireball'), null);
  });

  it('every ability and buff of the manifest picker has a patch that is valid', () => {
    for (const a of live) assert.ok(validPatch(iconPatch(`a:${a.id}`, ICON_LIST[0].id)), a.id);
    for (const id of Object.keys(AURAS)) assert.ok(validPatch(iconPatch(`u:${id}`, ICON_LIST[0].id)), id);
    assert.ok(ICONLIB.packs.length >= 7);
  });
});
