import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { ICON_LIST, ICON_PACKS, iconExists, iconUrl, searchIcons, setCustomIcons } from '@arena/shared';
import { DROP_LIMITS, filterPaths, iconNameOf, isHiddenPath, mergeCustom, packNameProblem, parseCustomList, parseZipDirectory, suggestPackName, unzipImages } from '../src/iconCustom';
import { gridIcons, packChips } from '../src/iconEditLogic';

/** A tiny zip: each entry stored or deflated, then the central directory and the end record. */
function zip(files: { name: string; data: string; deflate?: boolean }[]): Uint8Array {
  const parts: Buffer[] = [];
  const dir: Buffer[] = [];
  let off = 0;
  for (const f of files) {
    const raw = Buffer.from(f.data);
    const body = f.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(f.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(f.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(f.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(off, 42);
    dir.push(Buffer.concat([ch, name]));
    parts.push(lh, name, body);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(dir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}

describe('custom icon packs: names', () => {
  it('validates a pack name: 2 to 24 of a-z, 0-9 and dashes, unique, not a built-in', () => {
    assert.equal(packNameProblem('my-pack', []), null);
    assert.equal(packNameProblem('a0', []), null);
    for (const bad of ['', 'a', 'x'.repeat(25), 'Upper', 'with space', 'under_score', '-lead', 'trail-', 'ünï']) assert.ok(packNameProblem(bad, []), bad);
    assert.match(packNameProblem('barbarian')!, /already/);
    assert.match(packNameProblem('taken', ['taken'])!, /already/);
  });
  it('suggests a name from a zip or folder name, made unique', () => {
    assert.equal(suggestPackName('My Icons (v2).zip', []), 'my-icons-v2');
    assert.equal(suggestPackName('Fire!!.ZIP', []), 'fire');
    assert.equal(suggestPackName('', []), 'my-icons');
    assert.equal(suggestPackName('x', []), 'my-icons');
    assert.equal(suggestPackName('mage', ['mage', 'mage-2']), 'mage-3');
    assert.equal(suggestPackName('barbarian'), 'barbarian-2', 'a built-in pack name is taken');
    assert.equal(suggestPackName('a-very-long-folder-name-that-goes-on', []).length <= 24, true);
    assert.equal(packNameProblem(suggestPackName('Ünïcode ✨.zip')), null);
  });
  it('names a picture from its file name', () => {
    assert.equal(iconNameOf('icons/fire_ball-2.png'), 'fire ball 2');
    assert.equal(iconNameOf('x.PNG'), 'x');
  });
});

describe('custom icon packs: which files count', () => {
  it('keeps images, skips hidden files, __MACOSX and non-images, and refuses nested zips', () => {
    const f = filterPaths(['a.png', 'b.JPG', 'c.jpeg', 'd.webp', 'e.gif', 'dir/', 'dir/f.png', '.hidden.png', 'dir/.DS_Store', '__MACOSX/a.png', '__MACOSX/._a.png', 'notes.txt', 'doc.pdf', 'inner.zip', 'sub/more.zip']);
    assert.deepEqual(f.keep, ['a.png', 'b.JPG', 'c.jpeg', 'd.webp', 'e.gif', 'dir/f.png']);
    assert.equal(f.nested, 2);
    assert.equal(f.skipped, 6);
    assert.equal(f.over, 0);
    assert.ok(isHiddenPath('x/.git/y.png') && !isHiddenPath('x/y.png'));
  });
  it('takes at most 400 images per drop', () => {
    const f = filterPaths(Array.from({ length: 450 }, (_, i) => `i${i}.png`));
    assert.equal(f.keep.length, DROP_LIMITS.images);
    assert.equal(f.over, 50);
  });
});

describe('custom icon packs: the zip reader', () => {
  const zipped = zip([
    { name: 'pack/', data: '' },
    { name: 'pack/one.png', data: 'ONE-bytes' },
    { name: 'pack/two.webp', data: 'two '.repeat(50), deflate: true },
    { name: 'pack/readme.txt', data: 'hi' },
    { name: '__MACOSX/pack/._one.png', data: 'junk' },
    { name: 'pack/.secret.png', data: 'hidden' },
    { name: 'pack/inner.zip', data: 'PK' },
  ]);
  it('reads the central directory', () => {
    const d = parseZipDirectory(zipped);
    assert.deepEqual(d.map((e) => e.name), ['pack/', 'pack/one.png', 'pack/two.webp', 'pack/readme.txt', '__MACOSX/pack/._one.png', 'pack/.secret.png', 'pack/inner.zip']);
    assert.deepEqual([d[1].method, d[1].size], [0, 9]);
    assert.deepEqual([d[2].method, d[2].size], [8, 200]);
  });
  it('unpacks stored and deflated images and reports what it left out', async () => {
    const r = await unzipImages(zipped);
    assert.deepEqual(r.pictures.map((p) => p.path), ['pack/one.png', 'pack/two.webp']);
    assert.equal(Buffer.from(r.pictures[0].bytes).toString(), 'ONE-bytes');
    assert.equal(Buffer.from(r.pictures[1].bytes).toString(), 'two '.repeat(50));
    assert.equal(r.nested, 1);
    assert.equal(r.skipped, 3);
  });
  it('stops at the size cap and refuses what is not a zip', async () => {
    const r = await unzipImages(zipped, { ...DROP_LIMITS, totalBytes: 100 });
    assert.deepEqual(r.pictures.map((p) => p.path), ['pack/one.png']);
    assert.equal(r.over, 1);
    assert.throws(() => parseZipDirectory(new Uint8Array(Buffer.from('this is not a zip file at all, just text'))), /not a zip/);
    const bad = Buffer.from(zipped);
    bad.writeUInt32LE(0x12345678, bad.readUInt32LE(bad.length - 6)); // wreck the first central header
    assert.throws(() => parseZipDirectory(new Uint8Array(bad)), /damaged/);
  });
  it('a deflated entry that says it is small but inflates big is refused', async () => {
    const z = zip([{ name: 'bomb.png', data: 'A'.repeat(100000), deflate: true }]);
    const view = new DataView(z.buffer, z.byteOffset);
    const cd = view.getUint32(z.length - 6, true);
    view.setUint32(cd + 24, 10, true); // the directory claims 10 bytes
    await assert.rejects(unzipImages(z), /bigger than it says/);
  });
});

describe('custom icon packs: merging into the library', () => {
  afterEach(() => setCustomIcons([], []));
  const list = {
    packs: [{ id: 'my-pack', name: 'My pack', count: 2, license: 'x' }],
    icons: [
      { id: 'my-pack/a', pack: 'my-pack', name: 'Fire ball', file: '/icons/my-pack/a.webp', tags: ['my-pack'] },
      { id: 'my-pack/b', pack: 'my-pack', name: 'Frost nova', file: '/icons/my-pack/b.webp', tags: [] },
    ],
  };
  it('puts the packs in the grid, the search and the chips', () => {
    const before = ICON_LIST.length;
    mergeCustom(list);
    assert.equal(ICON_LIST.length, before + 2);
    assert.ok(iconExists('my-pack/a'));
    assert.equal(iconUrl('my-pack/b'), '/icons/my-pack/b.webp');
    assert.deepEqual(searchIcons('frost nova', 'my-pack').map((i) => i.id), ['my-pack/b']);
    assert.deepEqual(gridIcons('', 'my-pack').map((i) => i.id), ['my-pack/a', 'my-pack/b']);
    const chip = packChips('').find((c) => c.id === 'my-pack')!;
    assert.equal(chip.count, 2);
    assert.ok(chip.custom && !chip.locked);
    assert.ok(!packChips('').filter((c) => c.id !== 'my-pack').some((c) => c.custom));
    // replacing the list replaces the custom packs, never the built-in ones
    mergeCustom({ packs: [], icons: [] });
    assert.equal(ICON_LIST.length, before);
    assert.ok(!iconExists('my-pack/a'));
    assert.ok(ICON_PACKS.some((p) => p.id === 'barbarian'));
  });
  it('ignores a pack that has a built-in id and icons of packs it does not know', () => {
    const before = ICON_LIST.length;
    mergeCustom(parseCustomList({ packs: [{ id: 'barbarian', name: 'Fake', count: 1 }, { id: 'ok-pack', name: 'Ok', count: 1 }, { id: 'Bad Id' }], icons: [{ id: 'barbarian/zz', pack: 'barbarian', name: 'x' }, { id: 'ok-pack/one', pack: 'ok-pack', name: 'One', file: 'http://evil.example/x.webp' }, { id: 'ok-pack/UP', pack: 'ok-pack' }, { id: 'other/one', pack: 'other' }, 7, null] }));
    assert.equal(ICON_LIST.length, before + 1);
    assert.equal(iconUrl('ok-pack/one'), '/icons/ok-pack/one.webp', 'the file path is always the server\'s own');
    assert.equal(ICON_PACKS.find((p) => p.id === 'barbarian')!.custom, undefined);
    assert.equal(ICON_PACKS.find((p) => p.id === 'barbarian')!.count, 40);
  });
  it('survives garbage from the server', () => {
    assert.deepEqual(parseCustomList(null), { packs: [], icons: [] });
    assert.deepEqual(parseCustomList({ packs: 'x', icons: 3 }), { packs: [], icons: [] });
  });
});
