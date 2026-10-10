import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CodeWriter, applyEdits } from '../src/codegen';
import type { DevRequestRow } from '@arena/shared';

const row: DevRequestRow = { id: 'abc123', by: 'owner', at: 0, scope: 'Warrior', title: 'Retreat range', wants: 'w', current: 'c', proposed: 'p', acceptance: ['a'], affects: ['shared/src/bot.ts'], needsCode: 'bot behaviour', tested: [], status: 'open' };

describe('code written in the game', () => {
  it('applies an edit only where its text is found exactly once', () => {
    const files = { 'shared/src/a.ts': 'one\ntwo\ntwo\n' };
    const r = applyEdits(files, [
      { path: 'shared/src/a.ts', find: 'one', replace: 'ONE' },
      { path: 'shared/src/a.ts', find: 'two', replace: 'x' },
      { path: 'shared/src/a.ts', find: 'nope', replace: 'x' },
      { path: 'shared/src/b.ts', find: 'one', replace: 'x' },
    ]);
    assert.equal(r.out['shared/src/a.ts'], 'ONE\ntwo\ntwo\n');
    assert.equal(r.dropped.length, 3);
  });

  it('reads the files Claude picks, writes its edits to a branch and opens a pull request; other paths are refused', async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const file = (t: string) => ({ encoding: 'base64', content: Buffer.from(t).toString('base64'), size: t.length, sha: 'filesha' });
    const http = (async (url: string, init: RequestInit = {}) => {
      const path = url.replace('https://api.github.com/repos/TokeGG/mmoarena', '');
      const method = init.method ?? 'GET';
      calls.push({ url: path, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b });
      if (path === '') return ok({ default_branch: 'main' });
      if (path.startsWith('/git/trees/')) return ok({ tree: [{ path: 'shared/src/bot.ts', type: 'blob', size: 40 }, { path: 'package.json', type: 'blob', size: 10 }] });
      if (path.startsWith('/contents/CLAUDE.md')) return ok(file('rules'));
      if (path.startsWith('/contents/shared/src/bot.ts') && method === 'GET') return calls.some((c) => c.method === 'POST' && c.url === '/git/refs') ? ok({ sha: 'filesha' }) : ok(file('const retreat = 1;\n'));
      if (path.startsWith('/git/ref/heads/main')) return ok({ object: { sha: 'headsha' } });
      if (path === '/git/refs') return ok({});
      if (path.startsWith('/contents/') && method === 'PUT') return ok({});
      if (path === '/pulls') return ok({ html_url: 'https://github.com/TokeGG/mmoarena/pull/9', number: 9 });
      return { ok: false, status: 404, json: async () => ({ message: 'not found' }) };
    }) as unknown as typeof fetch;
    let n = 0;
    const messages = {
      create: async () => {
        n++;
        const out = n === 1
          ? { files: ['shared/src/bot.ts', 'package.json'], plan: 'edit bot' }
          : { summary: 'Retreat limit', edits: [{ path: 'shared/src/bot.ts', find: 'const retreat = 1;', replace: 'const retreat = 2;' }, { path: 'package.json', find: '1', replace: '2' }], files: [{ path: 'shared/test/retreat.test.ts', content: '// test\n' }, { path: '.github/workflows/x.yml', content: 'bad' }] };
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out) }] };
      },
    };
    const w = new CodeWriter({ GITHUB_TOKEN: 't' }, messages as never, http);
    assert.equal(w.enabled, true);
    const r = await w.write(row, 'owner');
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.ok) return;
    assert.equal(r.prNumber, 9);
    assert.deepEqual(r.files.sort(), ['shared/src/bot.ts', 'shared/test/retreat.test.ts']);
    const puts = calls.filter((c) => c.method === 'PUT');
    assert.equal(puts.length, 2);
    assert.equal(Buffer.from((puts.find((c) => c.url.includes('bot.ts'))!.body as { content: string }).content, 'base64').toString(), 'const retreat = 2;\n');
    assert.ok(puts.every((c) => (c.body as { branch: string }).branch === 'game-code/abc123'));
  });

  it('says plainly when the game has no key or token', async () => {
    const w = new CodeWriter({});
    const r = await w.write(row, 'owner');
    assert.equal(r.ok, false);
  });
});
