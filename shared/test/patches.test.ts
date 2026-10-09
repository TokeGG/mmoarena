import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PATCHES } from '../src/index';

describe('patch notes', () => {
  it('the newest entry is the current version, and entries are well formed, newest first', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(PATCHES[0].version, pkg.version, 'add a patch note for this version to shared/data/patches.json');
    assert.ok(PATCHES[0].at, 'the newest patch says when it went out (at, in UTC)');
    const key = (v: string) => v.split('.').map(Number);
    for (let i = 0; i < PATCHES.length; i++) {
      const p = PATCHES[i];
      assert.match(p.version, /^\d+\.\d+\.\d+$/);
      assert.match(p.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(p.at === undefined || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(p.at), `${p.version}: at is a UTC time like 2026-10-07T21:24:05Z`);
      assert.ok(p.by === undefined || (typeof p.by === 'string' && p.by.trim().length > 0 && p.by.length <= 40), `${p.version}: by is a short name`);
      assert.ok(p.title && p.changes.length > 0 && p.changes.every((c) => c.trim()), `${p.version} needs a title and changes`);
      if (i > 0) {
        const [a, b] = [key(PATCHES[i - 1].version), key(p.version)];
        assert.ok(a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2]))), `${p.version} out of order`);
      }
    }
  });
});

describe('patch notes are for players', () => {
  it('never mention the owner, admin or debug tools, or anything only they can use', () => {
    const bad = /\b(owner|owners|founder|founders|admin|admins|debug|dev tools?|devs?|F2)\b|pull request|bot battle/i;
    for (const p of PATCHES) {
      assert.ok(p.changes.length > 0, `${p.version} has changes`);
      for (const c of [p.title, ...p.changes]) assert.doesNotMatch(c, bad, `${p.version}: ${c.slice(0, 80)}`);
    }
  });
});
