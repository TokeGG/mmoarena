import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientMsg, ServerMsg } from '@arena/shared';
import { AiTune, parseChat, skillFields } from '../src/aitune';
import type { MessagesLike } from '../src/aitune';
import { Lobby } from '../src/rooms';
import { DevTools } from '../src/devtools';
import { DevRequests, requestText } from '../src/devrequests';
import { MemoryStore } from '../src/store';

type Answer = Record<string, unknown>;
const NO_REQUEST = { title: '', wants: '', current: '', proposed: '', acceptance: [], affects: [], needsCode: '' };
const ans = (a: Answer) => JSON.stringify({ kind: 'reply', text: '', questions: [], confident: false, changes: [], request: NO_REQUEST, ...a });
const idx = (id: string, re: RegExp) => skillFields(id).findIndex((f) => re.test(f.label));

/** A stand-in for the SDK: answers from a script, one answer per call, and keeps what it was sent. */
function fake(script: ((fields: { index: number; label: string }[]) => Answer)[], seen: any[] = []): MessagesLike {
  let n = 0;
  return {
    async create(params) {
      seen.push(params);
      const ctx = JSON.parse(String(params.system).split('Skill data:\n')[1]) as { fields: { index: number; label: string }[] };
      const a = script[Math.min(n++, script.length - 1)](ctx.fields);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: ans(a) }] } as any;
    },
  };
}

const mkP = (name: string, out: ServerMsg[], extra: any = {}) => ({ ws: { readyState: 1, send: (s: string) => out.push(JSON.parse(s)), bufferedAmount: 0 }, name, classId: 'mage', matches: 0, wins: 0, size: 1, ip: '1.1.1.1', mapPref: 'random', ...extra }) as any;
const dev = (name: string, out: ServerMsg[]) => mkP(name, out, { account: { name, key: name.toLowerCase(), grants: ['dev'] } });
const lastOf = <T extends ServerMsg['t']>(out: ServerMsg[], t: T) => [...out].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;
const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };
const send = (lobby: Lobby, p: any, m: unknown) => lobby.handle(p, m as ClientMsg);

describe('Ask Claude parsing', () => {
  const fields = skillFields('fireball');
  it('questions come back without changes', () => {
    const r = parseChat(ans({ kind: 'ask', text: 'Two things.', questions: ['How much?', 'Which spec?'], changes: [{ field: 0, value: 1 }] }), fields);
    assert.equal(r.kind, 'questions');
    assert.deepEqual(r.questions, ['How much?', 'Which spec?']);
    assert.deepEqual(r.patches, []);
  });

  it('changes are validated: bad fields, values and no-ops are dropped with the reason', () => {
    const cd = idx('fireball', /cooldown/i);
    const gcd = fields.findIndex((f) => f.kind === 'flag' && /gcd|global/i.test(f.label + f.path.join('.')));
    const school = fields.findIndex((f) => f.kind === 'choice' && f.path[0] === 'school');
    const r = parseChat(ans({ kind: 'change', text: 'Doing it.', confident: true, changes: [{ field: cd, value: 1500 }, { field: 9999, value: 1 }, { field: cd, value: 'x' }, { field: gcd, value: 5 }, { field: school, value: 'nonsense' }, { field: school, value: 'frost' }] }), fields);
    assert.equal(r.kind, 'changes');
    assert.deepEqual(r.patches.map((p) => [p.path.join('.'), p.value]).sort(), [['cooldown', 1500], ['school', 'frost']]);
    assert.equal(r.dropped.length, 4);
    assert.ok(r.dropped.some((d) => /does not exist/.test(d)) && r.dropped.some((d) => /not allowed/.test(d)));
    assert.equal(r.confident, false, 'a partly dropped answer never auto-applies');
    const none = parseChat(ans({ kind: 'change', text: 'x', changes: [{ field: 9999, value: 1 }] }), fields);
    assert.equal(none.ok, false);
    assert.match(none.text, /Nothing was changed/);
    assert.equal(parseChat('not json', fields).kind, 'error');
  });

  it('an incomplete change request goes back to asking', () => {
    const r = parseChat(ans({ kind: 'request', text: 'Needs code.', questions: ['What should it look like?'], request: { ...NO_REQUEST, title: 'T' } }), fields);
    assert.equal(r.kind, 'questions');
    const ok = parseChat(ans({ kind: 'request', text: 'Needs code.', request: { title: 'Fireball splits', wants: 'splits in two', current: 'one ball, 200 damage', proposed: 'two balls', acceptance: ['two balls fly'], affects: ['fireball'], needsCode: 'a new split effect' } }), fields);
    assert.equal(ok.kind, 'request');
  });
});

describe('Ask Claude chat', () => {
  it('is off without a key, defaults to sonnet, takes ARENA_AI_MODEL, keeps the thread and never sends secrets', async () => {
    assert.equal(new AiTune({}).enabled, false);
    assert.equal((await new AiTune({}).chat('a', 'fireball', undefined, 'more', [])).ok, false);
    const seen: any[] = [];
    const ai = new AiTune({ ANTHROPIC_API_KEY: 'sk-secret-key' }, fake([() => ({ kind: 'ask', text: 'Which?', questions: ['How much?'] }), () => ({ kind: 'reply', text: 'ok' })], seen));
    assert.equal(ai.modelName, 'claude-sonnet-5-5');
    assert.equal(new AiTune({ ARENA_AI_MODEL: 'claude-opus-5-5' }, fake([() => ({})])).modelName, 'claude-opus-5-5');
    const a1 = await ai.chat('a', 'fireball', undefined, 'make it better', []);
    assert.equal(a1.kind, 'questions');
    (ai as any).used.clear();
    await ai.chat('a', 'fireball', undefined, '20% more', []);
    assert.equal(seen[0].output_config.format.type, 'json_schema');
    assert.equal(seen[1].messages.length, 3, 'the second call carries the first exchange');
    assert.match(String(seen[1].messages[1].content), /How much\?/);
    assert.ok(!JSON.stringify(seen).includes('sk-secret-key'));
    assert.ok(JSON.stringify(seen[0].system).length < 40_000);
  });

  it('rate limits per dev and cuts long messages', async () => {
    const seen: any[] = [];
    const ai = new AiTune({}, fake([() => ({ kind: 'reply', text: 'ok' })], seen));
    assert.equal((await ai.chat('a', 'fireball', undefined, 'x'.repeat(5000), [])).ok, true);
    assert.equal(String(seen[0].messages.at(-1).content).length, 600);
    assert.match((await ai.chat('a', 'fireball', undefined, 'again', [])).text, /Slow down/);
    assert.equal((await ai.chat('b', 'fireball', undefined, 'other dev', [])).ok, true, 'another dev is not limited by it');
    (ai as any).used.set('c', Array.from({ length: 40 }, (_, i) => Date.now() - 4000 - i));
    assert.match((await ai.chat('c', 'fireball', undefined, 'z', [])).text, /Slow down/);
  });
});

async function world(script: Parameters<typeof fake>[0], env: Record<string, string> = {}, http?: typeof fetch) {
  const store = new MemoryStore();
  const posts: string[] = [];
  const devTools = new DevTools(store, {});
  const requests = new DevRequests(store, env, http, async (t) => (posts.push(t), true));
  const ai = new AiTune({}, fake(script));
  const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 }, undefined, undefined, undefined, devTools, undefined, ai, requests);
  const outD: ServerMsg[] = [], outO: ServerMsg[] = [], outN: ServerMsg[] = [], outE: ServerMsg[] = [];
  const devP = dev('Dee', outD), ownerP = mkP('Toke', outO, { ownerOk: true }), normal = mkP('Bob', outN), dev2 = dev('Eve', outE);
  for (const p of [devP, ownerP, normal, dev2]) (lobby as any).conns.add(p);
  return { lobby, ai, devP, ownerP, normal, dev2, outD, outO, outN, outE, posts, devTools, requests };
}

describe('Ask Claude in the game', () => {
  it('asks first: questions arrive, nothing is changed; then the change goes into the session and can be undone', async () => {
    const w = await world([
      () => ({ kind: 'ask', text: 'Before I touch it.', questions: ['Cooldown shorter by how much?'] }),
      (f) => ({ kind: 'change', text: 'Cooldown 8s -> 3s.', confident: true, changes: [{ field: f.find((x) => /cooldown/i.test(x.label))!.index, value: 3000 }] }),
    ]);
    send(w.lobby, w.devP, { t: 'dev_ai', ability: 'fireball', text: 'shorter cooldown' });
    await until(() => !!lastOf(w.outD, 'dev_chat'));
    const q = lastOf(w.outD, 'dev_chat')!.turn;
    assert.equal(q.kind, 'questions');
    assert.deepEqual(q.questions, ['Cooldown shorter by how much?']);
    assert.equal(w.devP.devSession, undefined, 'asking changes nothing');
    (w.ai as any).used.clear();
    send(w.lobby, w.devP, { t: 'dev_ai', ability: 'fireball', text: 'to 3 seconds' });
    await until(() => w.outD.filter((m) => m.t === 'dev_chat').length === 2);
    const c = lastOf(w.outD, 'dev_chat')!.turn;
    assert.equal(c.kind, 'changes');
    assert.equal(c.applied, true);
    assert.equal(c.changes![0].to, 3000);
    assert.equal(w.devP.devSession[0].value, 3000);
    send(w.lobby, w.devP, { t: 'dev_ai_undo', turn: c.id });
    await until(() => lastOf(w.outD, 'dev_chat')!.turn.applied === false);
    assert.deepEqual(w.devP.devSession, []);
    send(w.lobby, w.devP, { t: 'dev_ai_apply', turn: c.id });
    await until(() => lastOf(w.outD, 'dev_chat')!.turn.applied === true);
    assert.equal(w.devP.devSession[0].value, 3000);
  });

  it('an unsure answer waits for Apply', async () => {
    const w = await world([(f) => ({ kind: 'change', text: 'Maybe this.', confident: false, changes: [{ field: f.find((x) => /cooldown/i.test(x.label))!.index, value: 5000 }] })]);
    send(w.lobby, w.devP, { t: 'dev_ai', ability: 'fireball', text: 'tweak' });
    await until(() => !!lastOf(w.outD, 'dev_chat'));
    const t = lastOf(w.outD, 'dev_chat')!.turn;
    assert.equal(t.applied, false);
    assert.equal(w.devP.devSession, undefined);
    send(w.lobby, w.devP, { t: 'dev_ai_apply', turn: t.id });
    await until(() => lastOf(w.outD, 'dev_chat')!.turn.applied === true);
    assert.equal(w.devP.devSession[0].value, 5000);
  });

  it('in the Tuning tab the changes become a proposal, which Undo removes', async () => {
    const w = await world([(f) => ({ kind: 'change', text: 'Doing it.', confident: true, changes: [{ field: f.find((x) => /cooldown/i.test(x.label))!.index, value: 4000 }] })]);
    send(w.lobby, w.devP, { t: 'dev_ai', ability: 'fireball', text: 'cooldown 4s', propose: true });
    await until(() => !!lastOf(w.outD, 'dev_chat'));
    const t = lastOf(w.outD, 'dev_chat')!.turn;
    assert.equal(t.applied, true);
    assert.ok(t.proposalId);
    assert.equal(w.devP.devSession, undefined, 'no match numbers touched');
    assert.equal(w.devTools.proposals.length, 1);
    assert.equal(w.devTools.proposals[0].by, 'Dee');
    assert.equal(w.devTools.proposals[0].changes[0].to, 4000);
    assert.equal(w.devTools.proposals[0].patches[0].value, (t.patches ?? [])[0].value);
    send(w.lobby, w.devP, { t: 'dev_ai_undo', turn: t.id });
    await until(() => lastOf(w.outD, 'dev_chat')!.turn.applied === false);
    assert.equal(w.devTools.proposals[0].status, 'dismissed');
  });

  it('normal accounts are refused', async () => {
    const w = await world([() => ({ kind: 'reply', text: 'hi' })]);
    send(w.lobby, w.normal, { t: 'dev_ai', ability: 'fireball', text: 'hi' });
    send(w.lobby, w.normal, { t: 'dev_requests', op: 'list' });
    assert.equal(lastOf(w.outN, 'dev_result')?.ok, false);
    assert.equal(lastOf(w.outN, 'dev_chat'), undefined);
    assert.equal(lastOf(w.outN, 'dev_requests'), undefined);
  });
});

describe('change requests', () => {
  const REQ = { title: 'Fireball splits in two', wants: 'I want fireball to split in two on hit', current: 'One ball, 200 damage, 8s cooldown', proposed: 'Two balls of 100 damage', acceptance: ['Two balls fly after impact'], affects: ['fireball', 'shared/src/sim.ts'], needsCode: 'A new split effect type' };
  const filing = (f: any) => ({ kind: 'request', text: 'Splitting needs a code change.', confident: true, changes: [{ field: f.find((x: any) => /cooldown/i.test(x.label)).index, value: 6000 }], request: REQ });
  type Call = { url: string; method: string; body?: any };
  const ghHttp = (calls: Call[], refuse = false) =>
    (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: init?.method ?? 'GET', body });
      if (url.endsWith('/labels')) return new Response('{}', { status: 201 });
      if (refuse) return new Response(JSON.stringify({ message: 'Resource not accessible by personal access token' }), { status: 403 });
      return new Response(JSON.stringify({ html_url: 'https://github.com/TokeGG/mmoarena/issues/7', number: 7 }), { status: 201 });
    }) as typeof fetch;

  it('is stored and posted to Discord with the full spec and the tested numbers, a GitHub issue, and Claude is started on it', async () => {
    const calls: Call[] = [];
    const w = await world([filing], { GITHUB_TOKEN: 'tok' }, ghHttp(calls));
    send(w.lobby, w.devP, { t: 'dev_ai', ability: 'fireball', text: 'split it' });
    await until(() => !!lastOf(w.outD, 'dev_chat'));
    const t = lastOf(w.outD, 'dev_chat')!.turn;
    assert.equal(t.kind, 'request');
    assert.match(t.text, /code change/);
    assert.match(t.text, /saved it as a request for the owner/);
    assert.equal(t.request!.title, REQ.title);
    assert.equal(t.request!.issueUrl, 'https://github.com/TokeGG/mmoarena/issues/7');
    assert.deepEqual(calls.map((c) => c.url.replace(/.*mmoarena/, '')), ['/labels', '/issues'], 'the label is made if it is missing, and the issue opens with it on (one call, so one permission)');
    assert.deepEqual(calls[1].body.labels, ['dev-request'], 'the label that starts Claude on GitHub');
    assert.ok(w.requests.list[0].build, 'the request shows that Claude was asked');
    const row = w.requests.list[0];
    assert.equal(row.by, 'Dee');
    assert.equal(row.status, 'open');
    assert.equal(row.tested[0].to, 6000, 'the tested numbers ride along');
    const text = requestText(row);
    for (const part of ['Fireball splits in two', 'I want fireball to split', 'One ball, 200 damage', 'Two balls of 100 damage', 'Two balls fly', 'shared/src/sim.ts', 'A new split effect type', '6000', 'Requested by Dee']) assert.ok(text.includes(part), part);
    assert.equal(w.posts.length, 1);
    assert.match(w.posts[0], /Change request/);
  });

  it('ARENA_DEV_REQUEST_AUTOBUILD=0 keeps the label for the owner\'s Build button', async () => {
    const calls: Call[] = [];
    const w = await world([filing], { GITHUB_TOKEN: 'tok', ARENA_DEV_REQUEST_AUTOBUILD: '0' }, ghHttp(calls));
    send(w.lobby, w.devP, { t: 'dev_ai', ability: 'fireball', text: 'split it' });
    await until(() => !!lastOf(w.outD, 'dev_chat'));
    assert.deepEqual(calls.map((c) => c.url.replace(/.*mmoarena/, '')), ['/issues'], 'an issue and no label');
    assert.equal(w.requests.list[0].build, undefined);
  });

  it('opens an unlabelled GitHub issue, and a refused issue still keeps the request and says why', async () => {
    const calls: Call[] = [];
    const w = await world([], { GITHUB_TOKEN: 'tok', ARENA_DEV_REQUEST_ISSUES: '1', ARENA_DEV_REQUEST_AUTOBUILD: '0' }, ghHttp(calls));
    const r = await w.requests.file('Dee', 'Fireball', REQ as any, []);
    assert.equal(r.row!.issueUrl, 'https://github.com/TokeGG/mmoarena/issues/7');
    const issue = calls.find((c) => c.url.endsWith('/issues'))!;
    assert.equal(issue.body.labels, undefined);
    assert.match(issue.body.body, /Requested by Dee/);
    assert.match(issue.body.body, /Acceptance criteria/);

    const calls2: Call[] = [];
    const w2 = await world([filing], { GITHUB_TOKEN: 'tok', ARENA_DEV_REQUEST_ISSUES: '1' }, ghHttp(calls2, true));
    send(w2.lobby, w2.devP, { t: 'dev_ai', ability: 'fireball', text: 'split it' });
    await until(() => !!lastOf(w2.outD, 'dev_chat'));
    const t = lastOf(w2.outD, 'dev_chat')!.turn;
    assert.equal(t.kind, 'request');
    assert.match(t.request!.issueError!, /Issues/);
    assert.match(t.text, /could not be opened/);
    assert.equal(w2.requests.list.length, 1, 'the request is not lost');
    assert.equal(w2.posts.length, 1);
  });

  it('is bounded and rate limited', async () => {
    const w = await world([], {});
    for (let i = 0; i < 10; i++) assert.equal((await w.requests.file('Dee', 'Fireball', { ...REQ, title: `T${i}` } as any, [])).ok, true);
    assert.equal((await w.requests.file('Dee', 'Fireball', REQ as any, [])).ok, false, 'ten an hour per dev');
    for (let i = 0; i < 12; i++) await w.requests.file(`Dev${i}`, 'Fireball', REQ as any, []);
    (w.requests as any).rows = Array.from({ length: 150 }, (_, i) => ({ ...w.requests.list[0], id: `i${i}` }));
    await w.requests.file('Zed', 'Fireball', REQ as any, []);
    assert.equal(w.requests.list.length, 100);
    assert.equal(w.requests.list[0].by, 'Zed', 'newest first');
  });

  it('the owner sees all, marks done and deletes; a dev sees only their own and cannot delete', async () => {
    const w = await world([]);
    await w.requests.file('Dee', 'Fireball', REQ as any, []);
    await w.requests.file('Eve', 'Frost Nova', { ...REQ, title: 'Eve wants' } as any, []);
    send(w.lobby, w.devP, { t: 'dev_requests', op: 'list' });
    send(w.lobby, w.ownerP, { t: 'dev_requests', op: 'list' });
    assert.deepEqual(lastOf(w.outD, 'dev_requests')!.rows.map((r) => r.by), ['Dee']);
    assert.equal(lastOf(w.outO, 'dev_requests')!.rows.length, 2);
    const id = w.requests.list.find((r) => r.by === 'Dee')!.id;
    send(w.lobby, w.devP, { t: 'dev_requests', op: 'delete', id });
    send(w.lobby, w.devP, { t: 'dev_requests', op: 'done', id });
    await new Promise((r) => setTimeout(r, 30));
    assert.match(lastOf(w.outD, 'dev_result')!.text, /owner only/);
    assert.equal(w.requests.list.length, 2);
    assert.equal(w.requests.list.find((r) => r.id === id)!.status, 'open');
    send(w.lobby, w.ownerP, { t: 'dev_requests', op: 'done', id });
    await until(() => w.requests.list.find((r) => r.id === id)!.status === 'done');
    assert.equal(lastOf(w.outD, 'dev_requests')!.rows[0].status, 'done', 'the dev sees the status');
    send(w.lobby, w.ownerP, { t: 'dev_requests', op: 'delete', id });
    await until(() => w.requests.list.length === 1);
    assert.equal(w.requests.list[0].by, 'Eve');
  });

  it('survives a restart', async () => {
    const store = new MemoryStore();
    const a = new DevRequests(store);
    await a.file('Dee', 'Fireball', REQ as any, []);
    const b = new DevRequests(store);
    await b.whenReady();
    assert.equal(b.list.length, 1);
  });
});

describe('Ask Claude messages', () => {
  it('are parsed strictly', async () => {
    const { parseClientMsg } = await import('@arena/shared');
    const p = (m: unknown) => parseClientMsg(JSON.stringify(m));
    assert.deepEqual(p({ t: 'dev_ai', ability: 'fireball', text: ' hi ', propose: true }), { t: 'dev_ai', ability: 'fireball', text: 'hi', propose: true });
    assert.deepEqual(p({ t: 'dev_ai', ability: '', classId: 'mage', text: 'x' }), { t: 'dev_ai', ability: '', text: 'x', classId: 'mage' });
    assert.equal(p({ t: 'dev_ai', ability: 'nope', text: 'x' }), null);
    assert.equal(p({ t: 'dev_ai', ability: 'fireball', text: '  ' }), null);
    assert.equal(p({ t: 'dev_requests', op: 'delete' }), null, 'delete needs an id');
    assert.ok(p({ t: 'dev_requests', op: 'list' }));
    assert.equal(p({ t: 'dev_ai_undo', turn: '../x' }), null);
  });
});

describe('notes for the bots, read by Claude', () => {
  const reply = (obj: unknown): MessagesLike => ({ async create() { return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] } as any; } });
  it('turns what Claude read into brain moves, drops keys that do not exist, and keeps bugs apart', async () => {
    const ai = new AiTune({}, reply({
      effects: [
        { key: 'coverHp', dir: 'up', said: 'should hide sooner', classes: ['mage', 'nonsense'] },
        { key: 'notAKey', dir: 'up', said: 'x', classes: [] },
        { key: 'strafe', dir: 'sideways', said: 'x', classes: [] },
        { key: 'strafe', dir: 'down', said: 'stood still', classes: [] },
      ],
      bugs: ['the warrior got stuck on a pillar'],
      unplaced: ['the music'],
    }));
    const r = await ai.interpretNote('the mage should hide sooner and the warrior got stuck', ['mage', 'warrior']);
    assert.ok(r);
    assert.deepEqual(r!.effects.map((e) => [e.key, e.dir, e.classes]), [['coverHp', 1, ['mage']], ['strafe', -1, null]]);
    assert.deepEqual(r!.bugs, ['the warrior got stuck on a pillar']);
    assert.deepEqual(r!.unplaced, ['the music']);
  });
  it('is null when Ask Claude is off or cannot answer, so the phrase reading stands alone', async () => {
    assert.equal(await new AiTune({}).interpretNote('hide sooner', ['mage']), null);
    assert.equal(await new AiTune({}, { async create() { throw new Error('down'); } } as any).interpretNote('hide sooner', ['mage']), null);
  });
});
