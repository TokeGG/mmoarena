import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WIKI_PATH, wikiMarkdown } from '../../scripts/gen-wiki';

describe('WIKI.md', () => {
  const fresh = wikiMarkdown();

  it('is up to date with the game data and tooltip text', () => {
    const onDisk = fs.existsSync(WIKI_PATH) ? fs.readFileSync(WIKI_PATH, 'utf8') : '';
    assert.ok(onDisk === fresh, 'WIKI.md is out of date: run `npx tsx scripts/gen-wiki.ts` and commit WIKI.md');
  });

  it('every link inside the wiki points at an anchor that exists', () => {
    const anchors = new Set([...fresh.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]));
    const broken = [...fresh.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]).filter((a) => !anchors.has(a));
    assert.deepEqual([...new Set(broken)], []);
  });
});
