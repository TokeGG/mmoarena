import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARENAS, CLASS_IDS, SPECS, TIME_DAYS, parseClientMsg } from '@arena/shared';
import type { ClientMsg, ServerMsg } from '@arena/shared';
import { MemoryStore } from '../src/store';
import { Accounts } from '../src/accounts';
import { Lobby } from '../src/rooms';
import { PlayTime, cleanRecord, dayKey } from '../src/playtime';

const CODE = 'pt-owner-code';
const T0 = Date.UTC(2026, 9, 9, 13, 0, 0);

const last = <T extends ServerMsg['t']>(out: ServerMsg[], t: T) => [...out].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;

async function world(store = new MemoryStore(), clock = { t: T0 }) {
  const accounts = new Accounts(store, CODE);
  const reg = async (n: string, code?: string) => {
    const r = (await accounts.register(n, 'hunter22', `9.9.9.${n.length}`, code)) as any;
    return r.ok ? r.account : (await accounts.get(n))!;
  };
  const time = new PlayTime(store, () => clock.t);
  const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0, now: () => clock.t }, accounts, undefined, undefined, undefined, undefined, undefined, time);
  const outs = new Map<string, ServerMsg[]>();
  const connect = (name: string, account?: any, ownerOk = false) => {
    const out: ServerMsg[] = [];
    outs.set(name, out);
    const ws = { readyState: 1, send: (s: string) => out.push(JSON.parse(s)), close() {} };
    const p = lobby.connect(ws as any, '1.2.3.4');
    p.since = clock.t;
    p.activeAt = clock.t;
    if (account) p.account = account;
    p.ownerOk = ownerOk;
    p.name = name;
    return { p, out };
  };
  /** Advance the fake clock by `sec` seconds in 1 s steps, running the lobby each time. */
  const run = (sec: number) => {
    for (let i = 0; i < sec; i++) {
      clock.t += 1000;
      lobby.tick();
    }
  };
  const settle = async () => {
    await time.settle();
    await new Promise((r) => setTimeout(r, 5));
    await time.settle();
  };
  return { store, accounts, time, lobby, clock, connect, run, reg, settle, outs };
}

const handle = (lobby: Lobby, p: any, m: unknown) => lobby.handle(p, m as ClientMsg);
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

describe('play time accounting', () => {
  it('counts the menu, the first/last seen and one session', async () => {
    const w = await world();
    const a = await w.reg('Alice');
    w.connect('Alice', a);
    w.run(1); // the account record loads on the first sample
    await w.settle();
    w.run(10);
    const r = (await w.time.player('Alice'))!;
    assert.equal(r.cat.menu, 10000);
    assert.equal(r.total, 10000);
    assert.equal(r.sessions, 1);
    assert.equal(r.first, T0 + 1000);
    assert.equal(r.last, T0 + 11000);
    assert.equal(sum(r.cls), 0, 'the menu has no class');
  });

  it('practice alone: class, spec, arena and mode are broken down', async () => {
    const w = await world();
    const a = await w.reg('Alice');
    const { p } = w.connect('Alice', a);
    w.run(1);
    await w.settle();
    handle(w.lobby, p, { t: 'join', name: 'Alice', classId: 'mage', mode: 'practice', size: 2 });
    assert.ok(p.room, 'in a practice match');
    w.run(30);
    const r = (await w.time.player('Alice'))!;
    assert.equal(r.cat.practice, 30000);
    assert.equal(r.cls.mage, 30000);
    const specs = Object.keys(r.spec);
    assert.equal(specs.length, 1);
    assert.ok(specs[0].startsWith('mage:'));
    assert.equal(sum(r.map), 30000);
    assert.ok(Object.keys(r.map).every((k) => ARENAS.some((x) => x.id === k)));
    assert.deepEqual(r.mode, { '2v2': 30000 });
  });

  it('1v1 and 3v3 are told apart', async () => {
    const w = await world();
    const a = await w.reg('Alice');
    const { p } = w.connect('Alice', a);
    w.run(1);
    await w.settle();
    handle(w.lobby, p, { t: 'join', name: 'Alice', classId: 'rogue', mode: 'practice', size: 1 });
    w.run(5);
    handle(w.lobby, p, { t: 'leave' });
    handle(w.lobby, p, { t: 'join', name: 'Alice', classId: 'priest', mode: 'practice', size: 3 });
    w.run(7);
    const r = (await w.time.player('Alice'))!;
    assert.equal(r.mode['1v1'], 5000);
    assert.equal(r.mode['3v3'], 7000);
    assert.equal(r.cls.rogue, 5000);
    assert.equal(r.cls.priest, 7000);
  });

  it('queue, ranked, duel, party, dev test and spectating each get their own category', async () => {
    const w = await world();
    const a = await w.reg('Alice');
    const b = await w.reg('Bobby');
    const c = await w.reg('Carol');
    const A = w.connect('Alice', a).p;
    const B = w.connect('Bobby', b).p;
    const C = w.connect('Carol', c).p;
    w.run(1);
    await w.settle();
    // waiting in the ranked queue
    handle(w.lobby, A, { t: 'join', name: 'Alice', classId: 'warrior', mode: 'queue', size: 1 });
    w.run(4);
    // a second player makes the match: ranked
    handle(w.lobby, B, { t: 'join', name: 'Bobby', classId: 'mage', mode: 'queue', size: 1 });
    assert.ok(A.room?.isRanked);
    w.run(10);
    // Carol watches it
    handle(w.lobby, C, { t: 'spectate', id: A.room!.id });
    assert.ok(C.watching, 'spectating');
    w.run(6);
    // the owner changed numbers in the match: it is a dev test from now on
    A.room!.devTest = true;
    w.run(3);
    A.room!.devTest = false;
    // the same match is not ranked time for the friends who then duel
    handle(w.lobby, A, { t: 'leave' });
    handle(w.lobby, B, { t: 'leave' });
    handle(w.lobby, A, { t: 'join', name: 'Alice', classId: 'warrior', mode: 'duel', size: 1, duelWith: 'Bobby' });
    w.run(2); // waiting for the friend
    handle(w.lobby, B, { t: 'join', name: 'Bobby', classId: 'mage', mode: 'duel', size: 1, duelWith: 'Alice' });
    assert.ok(A.room?.duel);
    w.run(9);
    A.room!.duel = false; // two people and no bots in a non-ranked, non-duel room: friends together
    w.run(5);
    const ra = (await w.time.player('Alice'))!;
    assert.equal(ra.cat.queue, 4000 + 2000);
    assert.equal(ra.cat.ranked, 10000 + 6000);
    assert.equal(ra.cat.dev, 3000);
    assert.equal(ra.cat.duel, 9000);
    assert.equal(ra.cat.party, 5000);
    assert.equal(ra.cls.warrior, ra.cat.ranked + ra.cat.dev + ra.cat.duel + ra.cat.party);
    assert.deepEqual(ra.mode, { '1v1': ra.cat.ranked + ra.cat.dev + ra.cat.duel + ra.cat.party });
    const rb = (await w.time.player('Bobby'))!;
    assert.equal(rb.cls.mage, rb.cat.ranked + rb.cat.dev + rb.cat.duel + rb.cat.party);
    const rc = (await w.time.player('Carol'))!;
    assert.ok(rc.cat.spectate >= 6000);
    assert.equal(sum(rc.cls), 0, 'a spectator has no class');
    // everything adds up
    for (const r of [ra, rb, rc]) assert.equal(sum(r.cat), r.total);
  });

  it('a menu with no input for 5 minutes stops counting; any input starts it again', async () => {
    const w = await world();
    const a = await w.reg('Alice');
    const { p } = w.connect('Alice', a);
    w.run(1);
    await w.settle();
    w.run(299);
    handle(w.lobby, p, { t: 'ping', n: 1 } as any); // pings are background noise, not input
    w.run(120);
    let r = (await w.time.player('Alice'))!;
    assert.ok(r.cat.menu >= 296000 && r.cat.menu <= 301000, `about 5 minutes counted, got ${r.cat.menu}`);
    assert.ok(r.idle >= 119000, 'the rest is kept as idle time');
    const before = r.total;
    handle(w.lobby, p, { t: 'leaderboard' });
    w.run(10);
    r = (await w.time.player('Alice'))!;
    assert.equal(r.total - before, 10000);
  });

  it('time in a match counts even without any input', async () => {
    const w = await world();
    const a = await w.reg('Alice');
    const { p } = w.connect('Alice', a);
    w.run(1);
    await w.settle();
    handle(w.lobby, p, { t: 'join', name: 'Alice', classId: 'mage', mode: 'practice', size: 1 });
    w.run(600);
    const r = (await w.time.player('Alice'))!;
    assert.ok(r.cat.practice >= 599000, 'ten minutes of match time');
    assert.equal(r.idle, 0);
  });

  it('two windows of one account count once', async () => {
    const w = await world();
    const a = await w.reg('Alice');
    w.connect('Alice', a);
    w.connect('Alice', a);
    w.run(1);
    await w.settle();
    w.run(10);
    const r = (await w.time.player('Alice'))!;
    assert.equal(r.total, 10000);
    assert.equal(r.sessions, 1);
  });

  it('writes on disconnect and a second session counts; the record survives a restart', async () => {
    const store = new MemoryStore();
    const clock = { t: T0 };
    {
      const w = await world(store, clock);
      const a = await w.reg('Alice');
      const { p } = w.connect('Alice', a);
      w.run(1);
      await w.settle();
      w.run(20);
      w.lobby.disconnect(p); // not a minute yet, but the last connection is gone
      await w.settle();
      const raw = JSON.parse((await store.get('pt:alice'))!);
      assert.equal(raw.total, 20000, 'written at once on disconnect');
      assert.equal(raw.sessions, 1);
    }
    // the server restarts: new objects, same store
    clock.t += 3600_000;
    const w2 = await world(store, clock);
    const a2 = await w2.reg('Alice');
    const { p: p2 } = w2.connect('Alice', a2);
    w2.run(1);
    await w2.settle();
    w2.run(5);
    const r = (await w2.time.player('Alice'))!;
    assert.equal(r.sessions, 2);
    assert.equal(r.total, 25000);
    assert.equal(r.first, T0 + 1000, 'first seen is kept');
    w2.lobby.disconnect(p2);
    await w2.settle();
    const ov = await w2.time.overview(new Set());
    assert.equal(ov.rows[0].name, 'Alice');
    assert.equal(ov.rows[0].total, 25000);
    assert.equal(ov.global.sessions, 2, 'the server totals survive too');
  });

  it('writes at most once a minute while connected', async () => {
    const store = new MemoryStore();
    let sets = 0;
    const set = store.set.bind(store);
    store.set = async (k, v, e) => {
      if (k.startsWith('pt:') && k !== 'pt:rank') sets++;
      return set(k, v, e);
    };
    const w = await world(store);
    const a = await w.reg('Alice');
    w.connect('Alice', a);
    w.run(1);
    await w.settle();
    sets = 0;
    w.run(50);
    await w.settle();
    assert.equal(sets, 0, 'nothing in the first minute');
    w.run(70);
    await w.settle();
    assert.ok(sets >= 2 && sets <= 4, `a couple of writes in two minutes, got ${sets}`);
  });

  it('guests are one bucket: totals and categories, nothing stored per guest', async () => {
    const w = await world();
    w.connect('Visitor');
    w.connect('Wanderer');
    w.run(1);
    w.run(10);
    handle(w.lobby, [...(w.lobby as any).conns][0], { t: 'join', name: 'Visitor', classId: 'mage', mode: 'practice', size: 1 });
    w.run(5);
    await w.settle();
    const ov = await w.time.overview(new Set());
    assert.equal(ov.rows.length, 0, 'no guest in the table');
    assert.equal(ov.global.guests.sessions, 2);
    assert.equal(ov.global.guests.total, 10000 * 2 + 5000 * 2 - 0);
    assert.equal(ov.global.guests.cat.practice, 5000);
    assert.equal(ov.global.guests.cat.menu, 10000 + 5000 + 10000);
    const keys = [...(((w.store as any).kv as Map<string, unknown>).keys())];
    assert.ok(keys.every((k) => !/visitor|wanderer/i.test(k)), 'no per-guest key');
    assert.equal(await w.time.player('Visitor'), null);
  });

  it('server-wide: categories, classes and the hour of the day (UTC)', async () => {
    const w = await world();
    const a = await w.reg('Alice');
    const { p } = w.connect('Alice', a);
    w.run(1);
    await w.settle();
    handle(w.lobby, p, { t: 'join', name: 'Alice', classId: 'rogue', mode: 'practice', size: 2 });
    w.run(20);
    const { global } = await w.time.overview(new Set(['alice']));
    assert.equal(global.cat.practice, 20000);
    assert.equal(global.cls.rogue, 20000);
    assert.equal(global.hours[13], 20000, 'all of it in the 13:00 hour');
    assert.equal(global.hours.reduce((x, y) => x + y, 0), global.total);
    assert.equal(global.hours.length, 24);
  });
});

describe('play time bounds', () => {
  it('keeps only the last 30 days per account', async () => {
    const store = new MemoryStore();
    const clock = { t: T0 };
    const time = new PlayTime(store, () => clock.t);
    const s = [{ key: 'alice', name: 'Alice', cat: 'menu' as const, active: true }];
    time.tick(s, clock.t);
    await time.settle();
    for (let d = 0; d < 45; d++) {
      clock.t += 86400_000;
      time.tick(s, clock.t); // the step is capped at 30 s whatever the gap
    }
    const r = (await time.player('Alice'))!;
    assert.equal(Object.keys(r.days).length, TIME_DAYS);
    assert.equal(r.days[dayKey(clock.t)], 30000);
    assert.ok(!r.days[dayKey(T0)], 'the oldest days are gone');
  });

  it('a stall in the server is not counted as hours of play', async () => {
    const clock = { t: T0 };
    const time = new PlayTime(new MemoryStore(), () => clock.t);
    const s = [{ key: 'alice', name: 'Alice', cat: 'menu' as const, active: true }];
    time.tick(s, clock.t);
    await time.settle();
    clock.t += 3600_000;
    time.tick(s, clock.t);
    assert.ok((await time.player('Alice'))!.total <= 30000);
  });

  it('a damaged or hostile stored record is cut down to a small, valid one', () => {
    const junk: Record<string, number> = {};
    for (let i = 0; i < 5000; i++) junk[`k${i}`] = 5;
    const days: Record<string, number> = {};
    for (let i = 0; i < 400; i++) days[String(20200101 + i)] = 1000;
    const r = cleanRecord({ total: -5, sessions: 'x', first: NaN, cat: { menu: 1e30, evil: 5 }, cls: { ...junk, mage: 5 }, spec: junk, map: junk, mode: { ...junk, '2v2': 3 }, days }, T0);
    assert.equal(r.total, 0);
    assert.equal(r.sessions, 0);
    assert.equal(r.first, T0);
    assert.ok(r.cat.menu <= 1e12);
    assert.deepEqual(r.cls, { mage: 5 });
    assert.deepEqual(r.spec, {});
    assert.deepEqual(r.map, {});
    assert.deepEqual(r.mode, { '2v2': 3 });
    assert.equal(Object.keys(r.days).length, TIME_DAYS);
    assert.ok(JSON.stringify(r).length < 3000);
    // and the largest legal record stays small: every class, spec, arena, mode and 30 days
    const full = cleanRecord({
      cls: Object.fromEntries(CLASS_IDS.map((c) => [c, 1e9])),
      spec: Object.fromEntries(CLASS_IDS.flatMap((c) => SPECS[c].map((s) => [`${c}:${s.id}`, 1e9]))),
      map: Object.fromEntries(ARENAS.map((a) => [a.id, 1e9])),
      days: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [String(20260101 + i), 1e9])),
    }, T0);
    assert.ok(JSON.stringify(full).length < 4000);
  });

  it('the table lists at most 500 accounts', async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 520; i++) {
      await store.set(`pt:p${i}`, JSON.stringify({ total: 1000 + i }));
      await store.zadd('pt:rank', i, `P${i}`);
    }
    const time = new PlayTime(store, () => T0);
    const ov = await time.overview(new Set());
    assert.equal(ov.rows.length, 500);
    assert.equal(ov.rows[0].name, 'P519');
  });
});

describe('play time is for the owner only', () => {
  async function seeded() {
    const w = await world();
    const toke = await w.reg('Toke', CODE);
    const dee = await w.reg('Dee');
    const bob = await w.reg('Bob');
    const granted = await w.accounts.adminSet('Dee', { grants: ['dev'] } as any);
    assert.ok(granted.ok);
    const owner = w.connect('Toke', toke, true);
    const dev = w.connect('Dee', granted.ok ? granted.account : dee);
    const normal = w.connect('Bob', bob);
    const guest = w.connect('Visitor');
    w.run(1);
    await w.settle();
    w.run(5);
    return { w, owner, dev, normal, guest };
  }

  it('the owner gets the table and one player; a dev, a normal account and a guest get nothing', async () => {
    const { w, owner, dev, normal, guest } = await seeded();
    for (const who of [owner, dev, normal, guest]) {
      handle(w.lobby, who.p, { t: 'admin_act', act: 'time' });
      handle(w.lobby, who.p, { t: 'admin_act', act: 'time', name: 'Bob' });
    }
    await w.settle();
    await new Promise((r) => setTimeout(r, 20));
    const all = last(owner.out, 'admin_time')!;
    assert.ok(all, 'the owner gets the overview');
    assert.ok(all.rows.some((r) => r.name === 'Bob' && r.total >= 5000 && r.online));
    assert.ok(all.global.guests.total >= 5000);
    const one = last(owner.out, 'admin_time_player')!;
    assert.equal(one.name, 'Bob');
    assert.ok(one.rec && one.rec.total >= 5000);
    for (const who of [dev, normal, guest]) {
      assert.ok(!last(who.out, 'admin_time') && !last(who.out, 'admin_time_player'), 'no data leaks');
    }
    const refused = last(dev.out, 'dev_result')!;
    assert.ok(refused && !refused.ok && /owner/i.test(refused.text), 'the dev is told it is the owner’s');
    // nothing about address or place in what the owner gets
    assert.ok(!/1\.2\.3\.4|"ip"|"where"/.test(JSON.stringify(all) + JSON.stringify(one)));
  });

  it('the unlocked-owner flag matters, not the name', async () => {
    const { w } = await seeded();
    const toke = await w.accounts.get('Toke');
    const locked = w.connect('Toke2', toke); // owner account, code not entered this session
    handle(w.lobby, locked.p, { t: 'admin_act', act: 'time' });
    await w.settle();
    assert.ok(!last(locked.out, 'admin_time'));
  });

  it('the message is validated', () => {
    assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'admin_act', act: 'time' })), { t: 'admin_act', act: 'time' });
    assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'admin_act', act: 'time', name: 'Bob' })), { t: 'admin_act', act: 'time', name: 'Bob' });
    assert.equal(parseClientMsg(JSON.stringify({ t: 'admin_act', act: 'time', name: '../x y' })), null);
    assert.equal(parseClientMsg(JSON.stringify({ t: 'admin_act', act: 'times' })), null);
  });
});
