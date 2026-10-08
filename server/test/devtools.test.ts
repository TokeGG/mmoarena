import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ABILITIES, parseClientMsg } from '@arena/shared';
import type { ClientMsg, ServerMsg } from '@arena/shared';
import { MemoryStore } from '../src/store';
import { Accounts } from '../src/accounts';
import { Lobby } from '../src/rooms';
import { DevTools, patchJsonText } from '../src/devtools';

const CODE = 'dev-code';
const mkP = (name: string, out: ServerMsg[], account: any) => ({ ws: { readyState: 1, send: (s: string) => out.push(JSON.parse(s)), bufferedAmount: 0 } as any, name, classId: 'mage', matches: 0, wins: 0, size: 1, ip: '1.1.1.1', mapPref: 'random', account, ownerOk: false } as any);
const last = <T extends ServerMsg['t']>(out: ServerMsg[], t: T) => [...out].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;

async function world(http?: typeof fetch) {
  const store = new MemoryStore();
  const a = new Accounts(store, CODE);
  const toke = (await a.register('Toke', 'hunter22', '1.1.1.1', CODE)) as any;
  const dee = (await a.register('Dee', 'hunter22', '2.2.2.2')) as any;
  const bob = (await a.register('Bob', 'hunter22', '3.3.3.3')) as any;
  const dev = new DevTools(store, { GITHUB_TOKEN: http ? 'tok' : undefined }, http);
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

  it('saving makes the numbers live for everyone, keeps them over a restart, and opens a pull request', async () => {
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
      assert.equal(ABILITIES.fireball.cooldown, 7000, 'live on the server');
      assert.deepEqual(last(outB, 'overrides')?.patches.map((p) => p.value), [7000], 'every client is told');
      const res = last(outD, 'dev_result');
      assert.ok(res?.ok && res.url?.endsWith('/pull/99'), JSON.stringify(res));
      assert.ok(calls.some((c) => c.url.endsWith('/pulls') && c.body.base === 'main'));
      // the pull request only changes that number
      const a = JSON.parse(pushed).find((x: any) => x.id === 'fireball');
      assert.equal(a.cooldown, 7000);
      assert.equal(pushed.replace('"cooldown": 7000', `"cooldown": ${before}`), abilitiesText.replace(/("id": "fireball"[\s\S]*?"cooldown": )\d+/, `$1${before}`));
      // the owner can open another pull request with every live change from the admin panel
      const { owner, outO } = await (async () => ({ owner: (lobby as any).conns && [...(lobby as any).conns].find((q: any) => q.name === 'Toke'), outO: [] as ServerMsg[] }))();
      owner.ws.send = (x: string) => outO.push(JSON.parse(x));
      lobby.handle(owner, { t: 'overrides_pr' } as ClientMsg);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(calls.filter((c) => c.url.endsWith('/pulls')).length, 1, 'not without the owner code');
      owner.ownerOk = true;
      lobby.handle(owner, parseClientMsg(JSON.stringify({ t: 'overrides_pr', note: 'all live numbers' }))!);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(calls.filter((c) => c.url.endsWith('/pulls')).length, 2);
      assert.ok(last(outO, 'dev_result')?.url?.endsWith('/pull/99'));
      // a restart loads the overrides again
      await dev.clear();
      assert.equal(ABILITIES.fireball.cooldown, before, 'clearing puts the file number back');
      await store.set('devoverrides', JSON.stringify([{ file: 'abilities', id: 'fireball', path: ['cooldown'], value: 6500 }]));
      const again = new DevTools(store, {});
      await again.whenReady();
      assert.equal(ABILITIES.fireball.cooldown, 6500);
      await again.clear();
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
    assert.ok(outB.some((m) => m.t === 'notice' && m.text.includes('paused')));
    // ranked: refused
    const ranked: any = (lobby as any).makeRoom(0, true, true, 'colosseum');
    const outD2: ServerMsg[] = [];
    const dev2 = mkP('Dee', outD2, { ...devP.account });
    ranked.addPlayer(dev2, 0);
    lobby.handle(dev2, { t: 'dev_patch', patches: [{ file: 'abilities', id: 'fireball', path: ['cooldown'], value: 1 }] } as ClientMsg);
    assert.deepEqual(ranked.devPatches, []);
    assert.equal(last(outD2, 'dev_result')?.text, 'Not in ranked matches.');
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
