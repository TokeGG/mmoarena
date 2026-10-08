import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { CREDITS } from '../src/credits';

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
});
