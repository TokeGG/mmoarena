import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ABILITIES, PATCHES, parseClientMsg } from '@arena/shared';
import type { ClientMsg, ServerMsg } from '@arena/shared';
import { MemoryStore } from '../src/store';
import { Accounts } from '../src/accounts';
import { Lobby } from '../src/rooms';
import { landingRoute } from './githubLanding';
import { DevTools, nextPatchVersion, patchJsonText } from '../src/devtools';
import type { CheckRun } from './githubLanding';

const CODE = 'dev-code';
const mkP = (name: string, out: ServerMsg[], account: any) => ({ ws: { readyState: 1, send: (s: string) => out.push(JSON.parse(s)), bufferedAmount: 0 } as any, name, classId: 'mage', matches: 0, wins: 0, size: 1, ip: '1.1.1.1', mapPref: 'random', account, ownerOk: false } as any);
const last = <T extends ServerMsg['t']>(out: ServerMsg[], t: T) => [...out].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;

async function world(http?: typeof fetch, landing?: string) {
  const store = new MemoryStore();
  const a = new Accounts(store, CODE);
  const toke = (await a.register('Toke', 'hunter22', '1.1.1.1', CODE)) as any;
  const dee = (await a.register('Dee', 'hunter22', '2.2.2.2')) as any;
  const bob = (await a.register('Bob', 'hunter22', '3.3.3.3')) as any;
  const dev = new DevTools(store, { GITHUB_TOKEN: http ? 'tok' : undefined, ...(landing ? { ARENA_DEV_LANDING: landing } : {}) }, http);
  const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 }, a, undefined, undefined, dev);
  const outD: ServerMsg[] = [];
  const outB: ServerMsg[] = [];
  const outO: ServerMsg[] = [];
  const devP = mkP('Dee', outD, { ...dee.account, grants: ['dev'] });
  const bobP = mkP('Bob', outB, bob.account);
  const owner = mkP('Toke', outO, toke.account);
  for (const p of [devP, bobP, owner]) (lobby as any).conns.add(p);
  return { lobby, dev, devP, bobP, owner, outD, outB, outO, store };
}

describe('dev commits to GitHub', () => {
  type Call = { url: string; method: string; body?: any };
  /** A fake GitHub: the repository's real files, one tree and one commit, and a branch pointer. */
  const mkHttp = (calls: Call[], opts: { refFails?: number; readError?: string; checks?: CheckRun[] } = {}) => {
    let refFails = opts.refFails ?? 0;
    return (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body });
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      const landed = landingRoute(url, method, ok, opts.checks);
      if (landed) return landed;
      if (url.includes('/git/ref/heads/')) return ok({ object: { sha: 'head' + calls.length } });
      if (url.includes('/git/commits/')) return ok({ tree: { sha: 'tree1' } });
      if (url.endsWith('/git/trees')) return ok({ sha: 'tree2' });
      if (url.endsWith('/git/commits') && method === 'POST') return ok({ sha: 'abc123', html_url: 'https://github.com/TokeGG/mmoarena/commit/abc123' });
      if (url.includes('/git/refs/heads/') && method === 'PATCH') {
        if (refFails-- > 0) return new Response(JSON.stringify({ message: 'Update is not a fast forward' }), { status: 422 });
        return ok({});
      }
      const m = /\/contents\/([^?]+)/.exec(url);
      if (m && method === 'GET') {
        if (opts.readError) return new Response(JSON.stringify({ message: opts.readError }), { status: 403 });
        return ok({ content: fs.readFileSync(new URL('../../' + m[1], import.meta.url)).toString('base64'), sha: 'f' });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
  };
  const tree = (calls: Call[]) => (calls.find((c) => c.url.endsWith('/git/trees'))!.body.tree as { path: string; content: string }[]);

  it('on the pull request route a dev commits numbers as ONE commit that is also a patch: notes entry, version, README, SIM_REVISION', async () => {
    const calls: Call[] = [];
    const { lobby, devP, outD } = await world(mkHttp(calls), 'pr');
    lobby.handle(devP, { t: 'dev_commit', patches: [{ file: 'abilities', id: 'fireball', path: ['cooldown'], value: 7000 }], note: 'feels better' } as ClientMsg);
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(calls.some((c) => c.url.endsWith('/git/refs') && c.method === 'POST'), 'the commit gets its own branch');
    assert.ok(calls.some((c) => c.url.endsWith('/pulls') && c.method === 'POST'), 'a pull request checks it');
    assert.ok(calls.some((c) => c.url.endsWith('/pulls/7/merge') && c.method === 'PUT'), 'and it merges once the checks pass');
    assert.ok(!calls.some((c) => c.url.includes('/git/refs/heads/main') && c.method === 'PATCH'), 'main is never moved directly');
    assert.equal(calls.filter((c) => c.url.endsWith('/git/commits') && c.method === 'POST').length, 1, 'one commit');
    const files = tree(calls);
    const paths = files.map((f) => f.path).filter((x) => x !== 'shared/data/rotations.json').sort(); // the bots' re-learned damage orders may come along
    assert.deepEqual(paths, ['README.md', 'client/package.json', 'package.json', 'shared/data/abilities.json', 'shared/data/patches.json', 'shared/src/replay.ts']);
    const patches = JSON.parse(files.find((f) => f.path === 'shared/data/patches.json')!.content) as { version: string; title: string; changes: string[]; at: string }[];
    const prev = JSON.parse(fs.readFileSync(new URL('../../shared/data/patches.json', import.meta.url), 'utf8')) as { version: string }[];
    const [a, b, c] = prev[0].version.split('.').map(Number);
    const next = `${a}.${b}.${c + 1}`;
    assert.equal(patches[0].version, next);
    assert.equal(patches[1].version, prev[0].version, 'the old entries stay');
    assert.match(patches[0].changes[0], /^Fireball: cooldown [\d.]+ s to 7 s\.$/);
    assert.equal((patches[0] as { by?: string }).by, 'Dee', 'the patch note says who pushed it');
    assert.match(patches[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(JSON.parse(files.find((f) => f.path === 'package.json')!.content).version, next);
    assert.equal(JSON.parse(files.find((f) => f.path === 'client/package.json')!.content).version, next);
    assert.ok(files.find((f) => f.path === 'README.md')!.content.startsWith(`# WoW-style Arena · v${next}`));
    const rev = /SIM_REVISION = (\d+)/.exec(fs.readFileSync(new URL('../../shared/src/replay.ts', import.meta.url), 'utf8'))![1];
    assert.match(files.find((f) => f.path === 'shared/src/replay.ts')!.content, new RegExp(`SIM_REVISION = ${Number(rev) + 1}\\b`));
    assert.equal(calls.find((c) => c.url.endsWith('/git/commits') && c.method === 'POST')!.body.message.includes('Dee'), true);
    const res = last(outD, 'dev_result')!;
    assert.equal(res.ok, true);
    assert.match(res.text, new RegExp(`patch ${next.replace(/\./g, '\\.')}`));
    assert.match(String((res as any).url), /pull\/7/);
    // the dev can see it: the commit is listed, and it is live once the server runs that version
    const listed = last(outD, 'dev_commits')!;
    assert.equal(listed.rows[0].version, next);
    assert.equal(listed.rows[0].by, 'Dee');
    assert.equal(listed.running, PATCHES[0].version, 'the server still runs the old patch: deploying');
    assert.notEqual(listed.running, next);
    lobby.handle(devP, { t: 'dev_commits' } as ClientMsg);
    assert.equal(last(outD, 'dev_commits')!.rows.length, 1);
    // the notes are fit for players
    assert.ok(!/\b(owner|admin|debug|dev|devs|pull request)\b/i.test(patches[0].changes.join(' ')));
  });

  it('the patch line reads in seconds for times and names the thing that changed', async () => {
    const calls: Call[] = [];
    const { dev } = await world(mkHttp(calls));
    const r = await dev.commitToBase([
      { file: 'abilities', id: 'fireball', path: ['effects', '0', 'amount'], value: 999 },
      { file: 'abilities', id: 'fireball', path: ['castTime'], value: 1234 },
    ], 'Dee');
    assert.equal(r.applied, 2);
    const patches = JSON.parse(tree(calls).find((f) => f.path === 'shared/data/patches.json')!.content) as { changes: string[] }[];
    assert.ok(patches[0].changes.some((l) => /^Fireball: damage \d+ to 999\.$/.test(l)), patches[0].changes.join(' | '));
    assert.ok(patches[0].changes.some((l) => /^Fireball: cast time [\d.]+ s to 1\.23 s\.$/.test(l)), patches[0].changes.join(' | '));
  });

  it('a dev commits the ticked proposals from the admin panel the same way, and they show as committed', async () => {
    const calls: Call[] = [];
    const { lobby, devP, outD, dev } = await world(mkHttp(calls));
    lobby.handle(devP, { t: 'dev_save', patches: [{ file: 'abilities', id: 'fireball', path: ['cooldown'], value: 7000 }], note: 'feels better' } as ClientMsg);
    await new Promise((r) => setTimeout(r, 30));
    const id = dev.proposals[0].id;
    lobby.handle(devP, { t: 'admin_proposals', op: 'commit', ids: [id], note: 'ship it' } as ClientMsg);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(calls.filter((c) => c.url.endsWith('/git/commits') && c.method === 'POST').length, 1);
    assert.ok(tree(calls).some((f) => f.path === 'shared/data/patches.json'));
    assert.equal(dev.proposals.find((r) => r.id === id)!.status, 'committed');
    assert.equal(last(outD, 'dev_result')?.ok, true);
  });

  it('only devs can; a normal account, a guest, and nonsense numbers are refused', async () => {
    const calls: Call[] = [];
    const { lobby, bobP, devP, outB, outD } = await world(mkHttp(calls));
    lobby.handle(bobP, { t: 'dev_commit', patches: [{ file: 'abilities', id: 'fireball', path: ['cooldown'], value: 7000 }] } as ClientMsg);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(last(outB, 'dev_result')?.ok, false);
    assert.equal(calls.length, 0, 'nothing reaches GitHub');
    assert.equal(parseClientMsg(JSON.stringify({ t: 'dev_commit', patches: [{ file: 'server', id: 'x', path: ['a'], value: 1 }] })), null, 'only the data files');
    lobby.handle(devP, { t: 'dev_commit', patches: [] } as ClientMsg);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(last(outD, 'dev_result')?.ok, false);
    assert.equal(calls.length, 0);
  });

  it('a number that no longer exists in the files is left out and reported, the rest is committed; all stale means nothing is committed', async () => {
    const calls: Call[] = [];
    const { dev } = await world(mkHttp(calls));
    const r = await dev.commitToBase([
      { file: 'abilities', id: 'fireball', path: ['cooldown'], value: 7001 },
      { file: 'abilities', id: 'removed_skill_from_old_patch', path: ['cooldown'], value: 5 },
    ], 'Dee');
    assert.equal(r.applied, 1);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0], /no longer in the data files/);
    const before = calls.length;
    await assert.rejects(dev.commitToBase([{ file: 'abilities', id: 'removed_skill_from_old_patch', path: ['cooldown'], value: 5 }], 'Dee'), /Nothing was committed/);
    assert.ok(!calls.slice(before).some((c) => c.url.endsWith('/git/commits') && c.method === 'POST'), 'no commit for nothing');
  });

  it('by default a dev commit lands straight on main as one commit, with no branch and no pull request', async () => {
    const calls: Call[] = [];
    const { lobby, devP, outD } = await world(mkHttp(calls));
    lobby.handle(devP, { t: 'dev_commit', patches: [{ file: 'abilities', id: 'fireball', path: ['cooldown'], value: 7000 }] } as ClientMsg);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(calls.filter((c) => c.url.endsWith('/git/commits') && c.method === 'POST').length, 1, 'one commit');
    assert.ok(calls.some((c) => c.url.includes('/git/refs/heads/main') && c.method === 'PATCH'), 'main moves to it');
    assert.ok(!calls.some((c) => c.url.endsWith('/pulls') || (c.url.endsWith('/git/refs') && c.method === 'POST')), 'no branch, no pull request');
    const res = last(outD, 'dev_result')!;
    assert.equal(res.ok, true);
    assert.match(String((res as any).url), /commit\/abc123/);
  });

  it('if GitHub refuses the push to main, nothing is created: no branch, no pull request, and the dev is told', async () => {
    const calls: Call[] = [];
    const { lobby, devP, outD } = await world(mkHttp(calls, { refFails: 1 }));
    lobby.handle(devP, { t: 'dev_commit', patches: [{ file: 'abilities', id: 'fireball', path: ['cooldown'], value: 7000 }] } as ClientMsg);
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(!calls.some((c) => c.url.endsWith('/pulls') || (c.url.endsWith('/git/refs') && c.method === 'POST')), 'no pull request and no branch');
    assert.equal(last(outD, 'dev_result')!.ok, false);
  });

  it('a failing check keeps the commit off main and names the check to the dev', async () => {
    const calls: Call[] = [];
    const { lobby, devP, outD } = await world(mkHttp(calls, { checks: [{ name: 'check', status: 'completed', conclusion: 'failure' }] }), 'pr');
    lobby.handle(devP, { t: 'dev_commit', patches: [{ file: 'abilities', id: 'fireball', path: ['cooldown'], value: 7000 }] } as ClientMsg);
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(!calls.some((c) => c.url.endsWith('/pulls/7/merge')), 'not merged');
    const res = last(outD, 'dev_result')!;
    assert.equal(res.ok, false);
    assert.match(res.text, /check \(failure\)/);
    assert.match(res.text, /pull\/7/);
  });

  it('a protected main branch or a token without write access is explained in plain words', async () => {
    const mk = (message: string) => (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/git/ref/heads/')) return new Response(JSON.stringify({ object: { sha: 'h' } }), { status: 200 });
      if (url.includes('/git/commits/')) return new Response(JSON.stringify({ tree: { sha: 't' } }), { status: 200 });
      if (url.includes('/contents/') && method === 'GET') return new Response(JSON.stringify({ content: fs.readFileSync(new URL('../../' + /\/contents\/([^?]+)/.exec(url)![1], import.meta.url)).toString('base64') }), { status: 200 });
      return new Response(JSON.stringify({ message }), { status: 403 });
    }) as typeof fetch;
    for (const [message, want] of [['Protected branch update failed for refs/heads/main', /protected/], ['Resource not accessible by personal access token', /Contents/]] as const) {
      const { lobby, devP, outD } = await world(mk(message));
      lobby.handle(devP, { t: 'dev_commit', patches: [{ file: 'abilities', id: 'fireball', path: ['cooldown'], value: 7000 }] } as ClientMsg);
      await new Promise((r) => setTimeout(r, 60));
      const res = last(outD, 'dev_result')!;
      assert.equal(res.ok, false);
      assert.match(res.text, want);
    }
  });

  it('without a GitHub token it says so and commits nothing', async () => {
    const { lobby, devP, outD } = await world();
    lobby.handle(devP, { t: 'dev_commit', patches: [{ file: 'abilities', id: 'fireball', path: ['cooldown'], value: 7000 }] } as ClientMsg);
    await new Promise((r) => setTimeout(r, 30));
    const res = last(outD, 'dev_result')!;
    assert.equal(res.ok, false);
    assert.match(res.text, /GITHUB_TOKEN/);
  });
});

describe('dev tools', () => {
  it('a dev pauses their own match against bots and tries numbers that hold only in it', async () => {
    const { lobby, devP, bobP, outD, outB } = await world();
    const fireball = ABILITIES.fireball.effects.find((e) => e.type === 'damage') as { amount: number };
    const base = fireball.amount;
    lobby.handle(devP, { t: 'join', name: 'Dee', classId: 'mage', mode: 'practice', difficulty: 'normal', size: 1 } as ClientMsg);
    lobby.handle(bobP, { t: 'join', name: 'Bob', classId: 'mage', mode: 'practice', difficulty: 'normal', size: 1 } as ClientMsg);
    const room = devP.room;
    assert.ok(room && bobP.room && bobP.room !== room);
    // not for someone without the tag
    lobby.handle(bobP, { t: 'dev_pause', on: true } as ClientMsg);
    assert.equal(bobP.room.paused, false);
    assert.equal(last(outB, 'dev_result')?.ok, false);
    // pause: time stops in the dev's match only
    lobby.handle(devP, { t: 'dev_pause', on: true } as ClientMsg);
    assert.equal(room.paused, true);
    const t0 = room.sim.time;
    const tb = bobP.room.sim.time;
    for (let i = 0; i < 20; i++) lobby.tick();
    assert.equal(room.sim.time, t0, 'frozen');
    assert.ok(bobP.room.sim.time > tb, 'other matches run on');
    assert.ok(outD.some((m) => m.t === 'snapshot' && m.snap.paused), 'the dev sees it paused');
    // test numbers: only inside that room's tick, put back after
    const patch = parseClientMsg(JSON.stringify({ t: 'dev_patch', patches: [{ file: 'abilities', id: 'fireball', path: ['effects', 0, 'amount'], value: 999 }] })) as ClientMsg;
    assert.ok(patch, 'a valid patch parses');
    lobby.handle(devP, patch);
    assert.deepEqual(last(outD, 'dev_state')?.patches.map((p) => p.value), [999]);
    let seen = 0;
    const was = room.sim.step.bind(room.sim);
    room.sim.step = () => { seen = fireball.amount; return was(); };
    lobby.handle(devP, { t: 'dev_pause', on: false } as ClientMsg);
    lobby.tick();
    assert.equal(seen, 999, 'the dev match runs on the test number');
    assert.equal(fireball.amount, base, 'and it is put back for everyone else');
    assert.equal(room.devTest, true, 'the match no longer counts');
  });

  it('numbers kept for the session go into every match the dev starts (never ranked), until cleared', async () => {
    const { lobby, devP, bobP, outD, outB } = await world();
    const keep = [{ file: 'abilities' as const, id: 'fireball', path: ['cooldown'], value: 4321 }];
    lobby.handle(bobP, { t: 'dev_session', patches: keep } as ClientMsg);
    assert.equal(bobP.devSession, undefined, 'not without the dev tag');
    assert.equal(last(outB, 'dev_result')?.ok, false);
    lobby.handle(devP, parseClientMsg(JSON.stringify({ t: 'dev_session', patches: keep }))!);
    assert.deepEqual(last(outD, 'dev_session')?.patches, keep);
    lobby.handle(devP, { t: 'join', name: 'Dee', classId: 'mage', mode: 'practice', difficulty: 'normal', size: 1 } as ClientMsg);
    const first = devP.room;
    assert.deepEqual(first.devPatches, keep, 'the first match has them');
    assert.equal(first.devTest, true);
    assert.deepEqual(last(outD, 'dev_state')?.patches, keep, 'and the dev’s client is told');
    lobby.handle(devP, { t: 'leave' } as ClientMsg);
    lobby.handle(devP, { t: 'join', name: 'Dee', classId: 'mage', mode: 'practice', difficulty: 'normal', size: 1 } as ClientMsg);
    assert.notEqual(devP.room, first);
    assert.deepEqual(devP.room.devPatches, keep, 'so does the next one');
    lobby.handle(devP, { t: 'leave' } as ClientMsg);
    lobby.handle(devP, { t: 'dev_session', patches: [] } as ClientMsg);
    lobby.handle(devP, { t: 'join', name: 'Dee', classId: 'mage', mode: 'practice', difficulty: 'normal', size: 1 } as ClientMsg);
    assert.deepEqual(devP.room.devPatches, [], 'cleared: real numbers again');
    assert.equal(devP.room.devTest, false);
  });

  it('bad patches are refused at the door', () => {
    const bad = [
      { file: 'abilities', id: 'fireball', path: ['__proto__', 'x'], value: 1 },
      { file: 'abilities', id: 'fireball', path: ['school'], value: 1 },
      { file: 'abilities', id: 'nope', path: ['cooldown'], value: 1 },
      { file: 'abilities', id: 'fireball', path: ['cooldown'], value: 1e12 },
      { file: 'other', id: 'fireball', path: ['cooldown'], value: 1 },
    ];
    for (const p of bad) assert.equal(parseClientMsg(JSON.stringify({ t: 'dev_patch', patches: [p] })), null, JSON.stringify(p));
  });

  it('saving only sends a proposal to the owner; the owner makes proposals live or opens one pull request for all', async () => {
    const calls: { url: string; method: string; body?: any }[] = [];
    const abilitiesText = fs.readFileSync(new URL('../../shared/data/abilities.json', import.meta.url), 'utf8');
    let pushed = '';
    const http = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: init?.method ?? 'GET', body });
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.includes('/git/ref/heads/')) return ok({ object: { sha: 'abc' } });
      if (url.endsWith('/git/refs')) return ok({});
      if (url.includes('/contents/') && (init?.method ?? 'GET') === 'GET') return ok({ content: Buffer.from(abilitiesText).toString('base64'), sha: 'f1' });
      if (url.includes('/contents/')) { pushed = Buffer.from(body.content, 'base64').toString('utf8'); return ok({}); }
      if (url.endsWith('/pulls')) return ok({ html_url: 'https://github.com/TokeGG/mmoarena/pull/99' });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const { lobby, devP, bobP, outD, outB, dev, store } = await world(http);
    const before = ABILITIES.fireball.cooldown;
    try {
      lobby.handle(devP, { t: 'dev_save', patches: [{ file: 'abilities', id: 'fireball', path: ['cooldown'], value: 7000 }], note: 'feels better' } as ClientMsg);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(ABILITIES.fireball.cooldown, before, 'nothing goes live');
      assert.equal(last(outB, 'overrides'), undefined, 'nobody is told of live numbers');
      assert.ok(last(outD, 'dev_result')?.ok);
      assert.equal(calls.length, 0, 'no pull request yet');
      assert.equal(dev.proposals.length, 1);
      assert.equal(dev.proposals[0].changes[0].to, 7000);
      assert.equal(dev.proposals[0].changes[0].from, before);
      lobby.handle(devP, { t: 'dev_save', patches: [{ file: 'abilities', id: 'frostbolt', path: ['castTime'], value: 900 }] } as ClientMsg);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(dev.proposals.length, 2, 'proposals stack');
      const owner = [...(lobby as any).conns].find((q: any) => q.name === 'Toke');
      const outO: ServerMsg[] = [];
      owner.ws.send = (x: string) => outO.push(JSON.parse(x));
      lobby.handle(owner, { t: 'admin_proposals', op: 'pr' } as ClientMsg);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(calls.length, 0, 'not without the owner code');
      owner.ownerOk = true;
      lobby.handle(owner, { t: 'admin_proposals', op: 'list' } as ClientMsg);
      assert.equal((last(outO, 'proposals') as any).rows.length, 2);
      lobby.handle(owner, parseClientMsg(JSON.stringify({ t: 'admin_proposals', op: 'pr', note: 'together' }))!);
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(calls.filter((c) => c.url.endsWith('/pulls')).length, 1, 'one pull request for both');
      assert.ok(last(outO, 'dev_result')?.url?.endsWith('/pull/99'));
      const a = JSON.parse(pushed).find((x: any) => x.id === 'fireball');
      assert.equal(a.cooldown, 7000);
      assert.ok(dev.proposals.every((r) => r.status === 'pr'));
      assert.equal(ABILITIES.fireball.cooldown, before, 'a pull request does not make them live');
      // a new proposal can be made live by the owner
      lobby.handle(devP, { t: 'dev_save', patches: [{ file: 'abilities', id: 'fireball', path: ['cooldown'], value: 6500 }] } as ClientMsg);
      await new Promise((r) => setTimeout(r, 30));
      lobby.handle(owner, { t: 'admin_proposals', op: 'live' } as ClientMsg);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(ABILITIES.fireball.cooldown, 6500);
      assert.deepEqual(last(outB, 'overrides')?.patches.map((p) => p.value), [6500], 'every client is told when it goes live');
      // a restart loads the overrides and the proposals again
      await dev.clear();
      assert.equal(ABILITIES.fireball.cooldown, before, 'clearing puts the file number back');
      const again = new DevTools(store, {});
      await again.whenReady();
      assert.equal(again.proposals.length, 3);
    } finally {
      ABILITIES.fireball.cooldown = before;
    }
  });

  it('the owner sees every match, announces, and ends one', async () => {
    const { lobby, devP, bobP, owner, outO, outB } = await world();
    lobby.handle(bobP, { t: 'join', name: 'Bob', classId: 'mage', mode: 'practice', difficulty: 'normal', size: 1 } as ClientMsg);
    lobby.handle(devP, { t: 'admin_overview' } as ClientMsg);
    assert.equal(last(outO, 'admin_overview'), undefined);
    owner.ownerOk = true;
    lobby.handle(owner, { t: 'admin_overview' } as ClientMsg);
    const o = last(outO, 'admin_overview')!;
    assert.equal(o.rooms.length, 1);
    assert.equal(o.rooms[0].kind, 'practice');
    lobby.handle(owner, { t: 'admin_announce', text: 'Server restart in 5 minutes' } as ClientMsg);
    const ann = last(outB, 'announce');
    assert.ok(ann && ann.text === 'Server restart in 5 minutes' && ann.by === 'Toke', 'everyone online gets the banner');
    const late: ServerMsg[] = [];
    lobby.connect({ readyState: 1, send: (s: string) => late.push(JSON.parse(s)), on() {}, close() {}, OPEN: 1 } as any, '9.9.9.9');
    assert.ok(late.some((m) => m.t === 'announce'), 'and so does someone coming online just after');
    const room = bobP.room;
    lobby.handle(owner, { t: 'admin_end', id: room.id } as ClientMsg);
    assert.equal(room.closed, true);
  });

  it('patched data files keep their formatting', () => {
    const t = fs.readFileSync(new URL('../../shared/data/auras.json', import.meta.url), 'utf8');
    const out = patchJsonText(t, 'auras', [{ file: 'auras', id: 'polymorph', path: ['duration'], value: 7000 }]);
    const diff = out.split('\n').filter((l, i) => l !== t.split('\n')[i]);
    assert.deepEqual(diff.map((l) => l.trim()), ['"duration": 7000,']);
  });
});

describe('dev tools with other people in the match', () => {
  it('a dev tries numbers in a match with a friend: both play on them and the friend is told; never in ranked', async () => {
    const { lobby, devP, bobP, outB } = await world();
    const room: any = (lobby as any).makeRoom(0, true, false, 'colosseum');
    (lobby as any).rooms.add(room);
    room.addPlayer(devP, 0);
    room.addPlayer(bobP, 1);
    lobby.handle(devP, { t: 'dev_patch', patches: [{ file: 'abilities', id: 'fireball', path: ['cooldown'], value: 1234 }] } as ClientMsg);
    assert.deepEqual(room.devPatches.map((p: any) => p.value), [1234], 'applied in the shared match');
    assert.deepEqual(last(outB, 'dev_state')?.patches.map((p) => p.value), [1234], 'the friend gets the same numbers');
    assert.ok(outB.some((m) => m.t === 'notice' && m.text.includes('Dee is testing')), 'and is told who changed them');
    lobby.handle(devP, { t: 'dev_pause', on: true } as ClientMsg);
    assert.equal(room.paused, true);
    assert.ok(outB.some((m) => m.t === 'dev_state' && m.paused));
    // ranked: refused when the owner took Tune-any-match away; allowed (and it stops counting) otherwise
    const ranked: any = (lobby as any).makeRoom(0, true, true, 'colosseum');
    const outD2: ServerMsg[] = [];
    const dev2 = mkP('Dee', outD2, { ...devP.account, grants: ['dev', 'deny:tuneany'] });
    ranked.addPlayer(dev2, 0);
    lobby.handle(dev2, { t: 'dev_patch', patches: [{ file: 'abilities', id: 'fireball', path: ['cooldown'], value: 1 }] } as ClientMsg);
    assert.deepEqual(ranked.devPatches, []);
    assert.equal(last(outD2, 'dev_result')?.text, 'Not in ranked matches.');
    const outD3: ServerMsg[] = [];
    const dev3 = mkP('Dee', outD3, { ...devP.account, grants: ['dev'] });
    const ranked2: any = (lobby as any).makeRoom(0, true, true, 'colosseum');
    ranked2.addPlayer(dev3, 0);
    lobby.handle(dev3, { t: 'dev_patch', patches: [{ file: 'abilities', id: 'fireball', path: ['cooldown'], value: 1 }] } as ClientMsg);
    assert.deepEqual(ranked2.devPatches.map((p: any) => p.value), [1], 'a dev can tune any match, ranked too');
    assert.equal(ranked2.devTest, true, 'and it stops counting');
  });
});

describe('owner tuning a watched match', () => {
  it('the owner can pause and change numbers in any match they watch, ranked too, and it stops counting', async () => {
    const { lobby, devP, bobP, owner, outO, outB } = await world();
    const ranked: any = (lobby as any).makeRoom(0, true, true, 'colosseum');
    (lobby as any).rooms.add(ranked);
    ranked.addPlayer(devP, 0);
    ranked.addPlayer(bobP, 1);
    owner.ownerOk = true;
    ranked.addSpectator(owner);
    lobby.handle(owner, { t: 'dev_pause', on: true } as ClientMsg);
    assert.equal(ranked.paused, true);
    assert.equal(ranked.devTest, true, 'a touched ranked match no longer counts');
    lobby.handle(owner, { t: 'dev_patch', patches: [{ file: 'abilities', id: 'fireball', path: ['cooldown'], value: 2000 }] } as ClientMsg);
    assert.deepEqual(ranked.devPatches.map((p: any) => p.value), [2000]);
    assert.ok(outB.some((m) => m.t === 'notice' && /for rating/.test(m.text)), 'players are told it no longer counts for rating');
    for (let i = 0; i < 6; i++) lobby.tick();
    assert.ok(outO.some((m) => m.t === 'snapshot' && m.snap.paused), 'the watching owner sees it paused');
  });
});

describe('redeploy on Render from the dev panel', () => {
  const mk = (env: Record<string, string>, http: typeof fetch) => {
    const store = new MemoryStore();
    return new DevTools(store, env, http);
  };
  it('starts a deploy through the deploy hook, at most one every two minutes', async () => {
    const calls: string[] = [];
    const dev = mk({ RENDER_DEPLOY_HOOK_URL: 'https://api.render.com/deploy/srv-abc?key=k' }, (async (url: string) => { calls.push(String(url)); return new Response('{}', { status: 200 }); }) as typeof fetch);
    assert.equal(dev.canRedeploy, true);
    assert.match(await dev.redeploy(), /Deploy started/);
    assert.equal(calls.length, 1);
    await assert.rejects(dev.redeploy(), /Try again in/);
    assert.equal(calls.length, 1, 'no second request');
  });
  it('says how to set it up when there is no hook, and refuses addresses that are not Render', async () => {
    await assert.rejects(mk({}, (async () => new Response('{}')) as typeof fetch).redeploy(), /RENDER_DEPLOY_HOOK_URL/);
    await assert.rejects(mk({ RENDER_DEPLOY_HOOK_URL: 'https://evil.example.com/hook' }, (async () => new Response('{}')) as typeof fetch).redeploy(), /deploy hook/);
    await assert.rejects(mk({ RENDER_DEPLOY_HOOK_URL: 'http://api.render.com/deploy/x' }, (async () => new Response('{}')) as typeof fetch).redeploy(), /https/);
  });
  it('a refused deploy does not start the two-minute wait', async () => {
    let n = 0;
    const dev = mk({ RENDER_DEPLOY_HOOK_URL: 'https://api.render.com/deploy/srv-abc?key=k' }, (async () => (n++ === 0 ? new Response('no', { status: 401 }) : new Response('{}', { status: 200 }))) as typeof fetch);
    await assert.rejects(dev.redeploy(), /refused/);
    assert.match(await dev.redeploy(), /Deploy started/);
  });
  it('only devs can press it, and it is logged', async () => {
    const calls: string[] = [];
    const store = new MemoryStore();
    const a = new Accounts(store, CODE);
    const dee = (await a.register('Dee', 'hunter22', '2.2.2.2')) as any;
    const bob = (await a.register('Bob', 'hunter22', '3.3.3.3')) as any;
    const dev = new DevTools(store, { RENDER_DEPLOY_HOOK_URL: 'https://api.render.com/deploy/srv-abc?key=k' }, (async (url: string) => { calls.push(String(url)); return new Response('{}', { status: 200 }); }) as typeof fetch);
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 }, a, undefined, undefined, dev);
    const outD: ServerMsg[] = [];
    const outB: ServerMsg[] = [];
    const devP = mkP('Dee', outD, { ...dee.account, grants: ['dev'] });
    const bobP = mkP('Bob', outB, bob.account);
    for (const p of [devP, bobP]) (lobby as any).conns.add(p);
    lobby.handle(bobP, { t: 'dev_redeploy' } as ClientMsg);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls.length, 0);
    assert.equal(last(outB, 'dev_result')?.ok, false);
    lobby.handle(devP, { t: 'dev_redeploy' } as ClientMsg);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls.length, 1);
    assert.equal(last(outD, 'dev_result')?.ok, true);
  });
});

describe('patch versions from dev commits', () => {
  it('only the last number goes up, never the minor or major one', () => {
    assert.equal(nextPatchVersion('0.69.7'), '0.69.8');
    assert.equal(nextPatchVersion('0.69.9'), '0.69.10');
    assert.equal(nextPatchVersion('0.70.0'), '0.70.1');
    assert.equal(nextPatchVersion('0.99.99'), '0.99.100');
  });
  it('a bot or guest asking for the commit list gets nothing', async () => {
    const { lobby, bobP, outB } = await world();
    lobby.handle(bobP, { t: 'dev_commits' } as ClientMsg);
    assert.equal(last(outB, 'dev_commits'), undefined);
  });
  it('the list survives a restart', async () => {
    const calls: { url: string; method: string; body?: any }[] = [];
    void calls;
    const store = new MemoryStore();
    const a = new DevTools(store, {});
    await a.whenReady();
    await (a as any).recordCommit({ version: '0.69.8', by: 'Dee', at: 1, lines: ['Fireball: cooldown 8 s to 7 s.'] });
    const b = new DevTools(store, {});
    await b.whenReady();
    assert.equal(b.commits[0].version, '0.69.8');
  });
});

import { DevRequests } from '../src/devrequests';
describe('building a request with Claude on GitHub', () => {
  it('opens an issue without the label, then labels it on build, and finds the pull request', async () => {
    const calls: { path: string; method: string; body: any }[] = [];
    const http = (async (url: string, init: any = {}) => {
      const path = String(url).replace('https://api.github.com/repos/TokeGG/mmoarena', '');
      calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
      const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b });
      if (path === '/issues' && init.method === 'POST') return ok({ html_url: 'https://github.com/x/y/issues/7', number: 7 });
      if (path.startsWith('/pulls')) return ok([{ html_url: 'https://github.com/x/y/pull/9', number: 9, state: 'open', merged_at: null, body: 'Closes #7', head: { ref: 'claude/issue-7-thing' } }]);
      return ok({});
    }) as any;
    const reqs = new DevRequests(new MemoryStore(), { GITHUB_TOKEN: 't', ARENA_DEV_REQUEST_AUTOBUILD: '0' }, http);
    const draft = { title: 'Bigger fireball', wants: 'w', current: 'c', proposed: 'p', acceptance: ['a'], affects: ['fireball'], needsCode: 'n' };
    const { row } = await reqs.file('Dee', 'Fireball', draft as any, []);
    assert.equal(row!.issueNumber, 7);
    assert.ok(!calls.find((c) => c.path === '/issues')!.body.labels, 'no label yet: Claude does not start by itself');
    const r = await reqs.build(row!.id, 'Toke');
    assert.equal(r.ok, true);
    assert.ok(calls.some((c) => c.path === '/issues/7/labels' && c.body.labels[0] === 'dev-request'));
    assert.equal((await reqs.build(row!.id, 'Toke')).ok, false, 'only once');
    assert.equal(await reqs.checkPr(row!.id), true);
    const saved = reqs.visible('Toke', true)[0];
    assert.equal(saved.prNumber, 9);
    assert.equal(saved.prState, 'open');
  });
});

describe('merging the pull request Claude opened', () => {
  it('merges only an open pull request whose checks all passed', async () => {
    let checks: any[] = [{ name: 'build', status: 'completed', conclusion: 'success' }];
    let merged = 0;
    const http = (async (url: string, init: any = {}) => {
      const path = String(url).replace('https://api.github.com/repos/TokeGG/mmoarena', '');
      const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b });
      if (path === '/issues' && init.method === 'POST') return ok({ html_url: 'u', number: 7 });
      if (path.startsWith('/pulls?')) return ok([{ html_url: 'p', number: 9, state: 'open', merged_at: null, body: 'Closes #7', head: { ref: 'claude/issue-7' } }]);
      if (path === '/pulls/9') return ok({ state: 'open', merged: false, mergeable: true, head: { sha: 'abc' } });
      if (path.startsWith('/commits/abc/check-runs')) return ok({ check_runs: checks });
      if (path === '/pulls/9/merge') { merged++; return ok({ merged: true }); }
      return ok({});
    }) as any;
    const reqs = new DevRequests(new MemoryStore(), { GITHUB_TOKEN: 't' }, http);
    const { row } = await reqs.file('Dee', 'Fireball', { title: 't', wants: 'w', current: 'c', proposed: 'p', acceptance: [], affects: [], needsCode: 'n' } as any, []);
    assert.equal((await reqs.merge(row!.id)).ok, false, 'no pull request yet');
    await reqs.checkPr(row!.id);
    checks = [{ name: 'build', status: 'in_progress', conclusion: null }];
    const early = await reqs.merge(row!.id);
    assert.equal(early.ok, false);
    assert.match(early.text, /checks have not all passed/);
    assert.equal(merged, 0);
    checks = [{ name: 'build', status: 'completed', conclusion: 'success' }];
    const done = await reqs.merge(row!.id);
    assert.equal(done.ok, true);
    assert.equal(merged, 1);
    assert.equal(reqs.visible('Toke', true)[0].status, 'done');
  });
});

describe('the owner sees every change', () => {
  it('the owner gets the commit list of main, a dev and a player do not', async () => {
    const http = (async (url: string) => {
      if (url.includes('/commits?')) return new Response(JSON.stringify([{ sha: 'abcdef123456', html_url: 'https://github.com/x/y/commit/abcdef1', commit: { message: 'Hidden tweak\n\nonly the owner reads this', author: { name: 'Twizz', date: '2026-10-10T08:00:00Z' } } }]), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const { lobby, devP, bobP, owner, outD, outB, outO } = await world(http);
    owner.ownerOk = true;
    lobby.handle(owner, { t: 'owner_log' } as ClientMsg);
    await new Promise((r) => setTimeout(r, 40));
    const got = last(outO, 'owner_log')!;
    assert.equal(got.rows[0].title, 'Hidden tweak');
    assert.equal(got.rows[0].by, 'Twizz');
    assert.match(got.rows[0].body, /only the owner/);
    for (const [p, out] of [[devP, outD], [bobP, outB]] as const) {
      lobby.handle(p, { t: 'owner_log' } as ClientMsg);
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(last(out, 'owner_log')!.rows, []);
      assert.match(String(last(out, 'owner_log')!.error), /owner/);
    }
  });
});

describe('the bots learn a patch', () => {
  it('a balance commit brings the bots\' re-learned damage orders in the same commit, and says so', async () => {
    const calls: { url: string; method: string; body?: any }[] = [];
    const http = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.includes('/git/ref/heads/')) return ok({ object: { sha: 'h' } });
      if (url.includes('/git/commits/')) return ok({ tree: { sha: 't' } });
      if (url.endsWith('/git/trees')) return ok({ sha: 't2' });
      if (url.endsWith('/git/commits') && method === 'POST') return ok({ sha: 'abc123' });
      if (url.includes('/git/refs/heads/') && method === 'PATCH') return ok({});
      const m = /\/contents\/([^?]+)/.exec(url);
      if (m && method === 'GET') return ok({ content: fs.readFileSync(new URL('../../' + m[1], import.meta.url)).toString('base64') });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const { lobby, devP } = await world(http);
    // Fireball much slower: the mage's best order moves
    lobby.handle(devP, { t: 'dev_commit', patches: [{ file: 'abilities', id: 'fireball', path: ['castTime'], value: 6000 }, { file: 'abilities', id: 'frostbolt', path: ['castTime'], value: 300 }] } as ClientMsg);
    await new Promise((r) => setTimeout(r, 4000));
    const tree = calls.find((c) => c.url.endsWith('/git/trees'))?.body.tree as { path: string; content: string }[] | undefined;
    assert.ok(tree, 'a commit was made');
    const rot = tree!.find((f) => f.path === 'shared/data/rotations.json');
    assert.ok(rot, 'the rotations file is part of it');
    assert.ok(JSON.parse(rot!.content)['mage:fire'], 'and still a full table');
    const notes = JSON.parse(tree!.find((f) => f.path === 'shared/data/patches.json')!.content)[0].changes as string[];
    assert.ok(notes.some((l) => /bots adjusted/.test(l)));
  });
});
