import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { CREDITS } from '../src/credits';
import { unpackModel } from '../src/modelPack';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('credits', () => {
  const md = read('../../CREDITS.md');
  it('CREDITS.md lists every entry of client/src/credits.ts (title, author, licence, link)', () => {
    assert.ok(CREDITS.length >= 5);
    for (const c of CREDITS) {
      assert.ok(md.includes(c.title.replace(/ \(.*$/, '')), `${c.id}: title`);
      if (c.author) assert.ok(md.includes(c.author), `${c.id}: author ${c.author}`);
      assert.ok(md.includes(c.license.replace(/^Supplied by the owner, /, '')) || md.toLowerCase().includes(c.license.toLowerCase()), `${c.id}: licence`);
      if (c.url) assert.ok(md.includes(c.url), `${c.id}: link`);
      if (c.licenseUrl) assert.ok(md.includes(c.licenseUrl), `${c.id}: licence link`);
    }
  });
  it('names the owner-requested authors and flags the entries whose source is open', () => {
    const by = (id: string) => CREDITS.find((c) => c.id === id)!;
    assert.equal(by('dual-sabers').author, 'Shadow Models 3D');
    assert.equal(by('greatsword').author, 'denisdezmand');
    assert.equal(by('tyra-polearm').author, 'zenkuri (https://sketchfab.com/zenkuri)');
    assert.match(by('gold-knight').license, /to be confirmed/);
    assert.match(by('brute').license, /to be confirmed/);
  });
  it('the README links to CREDITS.md', () => {
    assert.match(read('../../README.md'), /\[CREDITS\.md\]\(CREDITS\.md\)/);
  });
  it('every shipped model that names its source (asset.extras) is credited, with the same author and licence', () => {
    const root = fileURLToPath(new URL('../public/models', import.meta.url));
    const paks = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? paks(join(d, e.name)) : e.name.endsWith('.pak') ? [join(d, e.name)] : []));
    let checked = 0;
    for (const f of paks(root)) {
      const buf = Buffer.from(unpackModel(readFileSync(f)));
      const extras = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8')).asset?.extras ?? {};
      for (const e of (extras.credits ?? [extras]) as { source?: string; author?: string; license?: string }[]) {
        if (!e.source) continue;
        const c = CREDITS.find((x) => x.url === e.source);
        assert.ok(c, `${f}: ${e.source} has no entry in client/src/credits.ts`);
        const name = (a?: string | null) => (a ?? '').replace(/ \(https?:.*$/, '').toLowerCase();
        assert.equal(name(c.author), name(e.author), `${f}: author`);
        assert.ok(e.license?.startsWith(c.license.split(' ')[0]) || c.license.toLowerCase().includes((e.license ?? '').split(' ')[0].toLowerCase()), `${f}: licence ${e.license} vs ${c.license}`);
        checked++;
      }
    }
    assert.ok(checked >= 15, `only ${checked} credited sources found in the packs`);
  });
});
