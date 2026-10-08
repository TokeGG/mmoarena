import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Accounts, Limiter } from '../src/accounts';
import { MemoryStore } from '../src/store';
import { Lobby, QUEUE_BAN_MS } from '../src/rooms';
import type { Player } from '../src/rooms';
import { clientIp } from '../src/index';
import { START_RATING } from '@arena/shared';
import type { ClientMsg, ServerMsg } from '@arena/shared';

/** Regression tests for the 0.64 audit: ranked, matchmaking, accounts and server safety. */

const sock = () => {
  const sent: ServerMsg[] = [];
  return { readyState: 1, sent, send(d: string) { sent.push(JSON.parse(d)); } } as any;
};
const until = async (cond: () => boolean, what = 'timed out') => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), what);
};
const last = <T extends ServerMsg['t']>(s: any, t: T) => (s.sent as ServerMsg[]).filter((m) => m.t === t).at(-1) as Extract<ServerMsg, { t: T }> | undefined;

async function world(names: string[], cfg: { queuePrepMs?: number; practicePrepMs?: number } = {}, accounts = new Accounts(new MemoryStore())) {
  const lobby = new Lobby({ practicePrepMs: cfg.practicePrepMs ?? 0, queuePrepMs: cfg.queuePrepMs ?? 0, minCountedMatchMs: 0 }, accounts);
  const us = [] as { name: string; s: any; p: Player }[];
  for (const name of names) {
    const s = sock();
    const p = lobby.connect(s, `ip-${name}`);
    lobby.handle(p, { t: 'register', name, password: 'password1' } as ClientMsg);
    await until(() => s.sent.some((m: ServerMsg) => m.t === 'account'));
    us.push({ name, s, p });
  }
  /** A second window signed in to an existing account. */
  const window2 = async (name: string) => {
    const s = sock();
    const p = lobby.connect(s, `ip2-${name}`);
    lobby.handle(p, { t: 'login', name, password: 'password1' } as ClientMsg);
    await until(() => s.sent.some((m: ServerMsg) => m.t === 'account'));
    return { name, s, p };
  };
  const guest = () => {
    const s = sock();
    return { s, p: lobby.connect(s, 'guest-ip') };
  };
  return { accounts, lobby, us, window2, guest };
}
const queue = (l: Lobby, p: Player, size: 1 | 2 | 3 = 1, classId: 'mage' | 'warrior' | 'rogue' | 'priest' = 'mage') =>
  l.handle(p, { t: 'join', name: 'x', classId, mode: 'queue', size } as ClientMsg);

describe('0.64 ranked and matchmaking', () => {
  it('signing out in a ranked match is refused, and a leaver loses rating even if their session is gone', async () => {
    const { lobby, us, accounts } = await world(['Ann', 'Bob']);
    queue(lobby, us[0].p);
    queue(lobby, us[1].p);
    const room: any = us[0].p.room;
    assert.ok(room?.isRanked);
    lobby.tick();
    lobby.handle(us[0].p, { t: 'logout' } as ClientMsg);
    await until(() => !!last(us[0].s, 'auth_error'));
    assert.match(last(us[0].s, 'auth_error')!.reason, /Finish or leave/);
    assert.ok(us[0].p.account, 'still signed in');
    // even with the in-memory account gone (e.g. a reset elsewhere), the room charges the loss to the key it recorded
    us[0].p.account = undefined;
    lobby.disconnect(us[0].p);
    await until(() => (room as any).deltas.size > 0);
    const ann = await accounts.get('Ann');
    assert.equal(ann!.rated, 1);
    assert.ok(ann!.rating < START_RATING, 'the leaver lost rating');
  });

  it('guests play an unrated queue that never meets the ranked ladder', async () => {
    const { lobby, us, guest } = await world(['Ann']);
    const g1 = guest();
    lobby.handle(g1.p, { t: 'join', name: 'G', classId: 'mage', mode: 'queue', size: 1 } as ClientMsg);
    queue(lobby, us[0].p);
    assert.equal(g1.p.room, undefined, 'a guest is never paired with a ranked player');
    assert.equal(us[0].p.room, undefined);
    const g2 = guest();
    lobby.handle(g2.p, { t: 'join', name: 'H', classId: 'rogue', mode: 'queue', size: 1 } as ClientMsg);
    assert.ok(g1.p.room && g1.p.room === g2.p.room, 'two guests meet');
    assert.equal((g1.p.room as any).isRanked, false, 'and their match is unrated');
  });

  it('one account in two windows cannot queue against itself', async () => {
    const { lobby, us, window2 } = await world(['Ann']);
    const second = await window2('Ann');
    queue(lobby, us[0].p);
    queue(lobby, second.p);
    assert.equal(us[0].p.room, undefined, 'no match was made');
    assert.match(last(second.s, 'closed')!.reason, /another window/);
  });

  it('leaving during the countdown cancels the match, requeues the others first in line, and bans the leaver briefly', async () => {
    const { lobby, us } = await world(['Ann', 'Bob', 'Cy_', 'Dee'], { queuePrepMs: 60000 });
    for (const u of us) queue(lobby, u.p, 2);
    const room: any = us[0].p.room;
    assert.ok(room && room.sim.phase === 'prep');
    lobby.handle(us[3].p, { t: 'leave' } as ClientMsg);
    assert.ok(room.closed, 'the match is called off');
    for (const u of us.slice(0, 3)) {
      assert.equal(u.p.room, undefined);
      assert.match(last(u.s, 'closed')!.reason, /left before the start/);
      assert.equal(last(u.s, 'queued')!.needed, 4, 'back in the queue');
    }
    // the leaver cannot queue for a minute, and nobody lost rating
    queue(lobby, us[3].p, 2);
    assert.match(last(us[3].s, 'closed')!.reason, /queue again in \d+ s/);
    assert.ok(QUEUE_BAN_MS >= 30000);
    for (const u of us) assert.equal(u.p.account!.rated, 0);
  });

  it('Play again in a ranked match with someone gone puts you back in the queue instead of a short-handed rematch', async () => {
    const { lobby, us } = await world(['Ann', 'Bob']);
    queue(lobby, us[0].p);
    queue(lobby, us[1].p);
    const room: any = us[0].p.room;
    lobby.tick();
    for (const u of room.sim.units.values()) if (u.team === 1) room.sim.forfeit(u.id);
    lobby.tick();
    assert.equal(room.sim.phase, 'ended');
    lobby.handle(us[1].p, { t: 'leave' } as ClientMsg);
    lobby.handle(us[0].p, { t: 'rematch', on: true } as ClientMsg);
    assert.equal(us[0].p.room, undefined, 'no 1v0 rematch');
    assert.match(last(us[0].s, 'closed')!.reason, /Back in the ranked queue/);
    assert.ok(last(us[0].s, 'queued'));
  });

  it('a pending duel and another match cannot run at once', async () => {
    const { lobby, us } = await world(['Ann', 'Bob']);
    lobby.handle(us[0].p, { t: 'join', name: 'x', classId: 'mage', mode: 'duel', duelWith: 'Bob' } as ClientMsg);
    lobby.handle(us[0].p, { t: 'join', name: 'x', classId: 'mage', mode: 'practice', size: 1 } as ClientMsg);
    assert.equal(us[0].p.room, undefined, 'no practice while waiting for the duel');
    assert.match(last(us[0].s, 'closed')!.reason, /waiting for a duel/);
    lobby.handle(us[1].p, { t: 'join', name: 'x', classId: 'rogue', mode: 'duel', duelWith: 'Ann' } as ClientMsg);
    assert.ok(us[0].p.room && us[0].p.room === us[1].p.room, 'the duel starts');
  });

  it('spectators are told when the last player leaves the end screen', async () => {
    const { lobby, us } = await world(['Ann', 'Bob', 'Wat']);
    queue(lobby, us[0].p);
    queue(lobby, us[1].p);
    const room: any = us[0].p.room;
    lobby.tick();
    lobby.handle(us[2].p, { t: 'spectate', id: room.id } as ClientMsg);
    assert.equal(us[2].p.watching, room);
    for (const u of room.sim.units.values()) if (u.team === 1) room.sim.forfeit(u.id);
    lobby.tick();
    lobby.handle(us[0].p, { t: 'leave' } as ClientMsg);
    lobby.handle(us[1].p, { t: 'leave' } as ClientMsg);
    assert.equal(us[2].p.watching, undefined, 'no longer watching');
    assert.ok(last(us[2].s, 'closed'), 'and told the room closed');
  });

  it('a declined party invite does not leave a party of one behind', async () => {
    const { lobby, us } = await world(['Ann', 'Bob']);
    lobby.handle(us[0].p, { t: 'friend', op: 'add', name: 'Bob' });
    await until(() => (last(us[1].s, 'friends')?.requests ?? []).includes('Ann'));
    lobby.handle(us[1].p, { t: 'friend', op: 'accept', name: 'Ann' });
    await until(() => (last(us[0].s, 'friends')?.friends ?? []).some((f) => f.name === 'Bob'));
    lobby.handle(us[0].p, { t: 'invite', kind: 'party', name: 'Bob' });
    assert.ok(us[0].p.party);
    const inv = last(us[1].s, 'invite')!;
    lobby.handle(us[1].p, { t: 'invite_reply', id: inv.id, accept: false });
    assert.equal(us[0].p.party, undefined, 'the lonely party is gone');
    lobby.handle(us[0].p, { t: 'invite', kind: 'duel', name: 'Bob' });
    assert.match(last(us[0].s, 'notice')!.text, /Duel invite sent/, 'so duel invites work again');
  });
});

describe('0.64 hidden rogues', () => {
  it('a stealthed rogue\'s own casts and buffs are not sent to the enemy team', async () => {
    const { lobby, us } = await world(['Ann', 'Bob']);
    queue(lobby, us[0].p, 1, 'rogue');
    queue(lobby, us[1].p, 1, 'mage');
    const room: any = us[0].p.room;
    lobby.tick();
    const rogue = us[0].p.unitId!;
    const sim = room.sim;
    const r = sim.units.get(rogue);
    const foe = sim.units.get(us[1].p.unitId!);
    r.pos = { x: foe.pos.x + 30, z: foe.pos.z };
    sim.applyAura(r, r, 'stealth');
    const mark = us[1].s.sent.length;
    sim.applyAura(r, r, 'sprint');
    lobby.tick();
    const seen = us[1].s.sent.slice(mark).filter((m: ServerMsg) => m.t === 'snapshot').flatMap((m: any) => m.events);
    assert.ok(!seen.some((e: any) => e.t === 'aura' && e.tgt === rogue), 'the enemy did not see the hidden rogue sprint');
    const own = us[0].s.sent.slice(mark).filter((m: ServerMsg) => m.t === 'snapshot').flatMap((m: any) => m.events);
    assert.ok(own.some((e: any) => e.t === 'aura' && e.tgt === rogue && e.aura === 'sprint'), 'the rogue still sees it');
  });
});

describe('0.64 accounts and limits', () => {
  it('the leaderboard is cached and read in one batch', async () => {
    const store = new MemoryStore();
    const a = new Accounts(store);
    for (const n of ['Ann', 'Bob', 'Cy_']) await a.register(n, 'password1', `ip-${n}`);
    let gets = 0;
    let mgets = 0;
    const g = store.get.bind(store);
    const mg = store.mget.bind(store);
    store.get = (k) => (gets++, g(k));
    store.mget = (k) => (mgets++, mg(k));
    const rows = await Promise.all(Array.from({ length: 50 }, () => a.leaderboard(20)));
    assert.equal(rows[0].length, 3);
    assert.equal(mgets, 1, 'fifty requests, one batched read');
    assert.equal(gets, 0, 'no per-account reads');
    await a.leaderboard(20);
    assert.equal(mgets, 1, 'served from the cache');
  });

  it('a connection can only have a few account requests waiting; the rest are dropped, and none run after it closes', async () => {
    const { lobby, us, accounts } = await world(['Ann']);
    let calls = 0;
    const orig = accounts.leaderboard.bind(accounts);
    accounts.leaderboard = (n?: number) => (calls++, orig(n));
    for (let i = 0; i < 100; i++) lobby.handle(us[0].p, { t: 'leaderboard' } as ClientMsg);
    await until(() => (us[0].p.pending ?? 0) === 0);
    assert.ok(calls <= 8, `at most 8 ran (${calls})`);
    calls = 0;
    for (let i = 0; i < 5; i++) lobby.handle(us[0].p, { t: 'leaderboard' } as ClientMsg);
    lobby.disconnect(us[0].p);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(calls <= 1, 'work queued for a closed socket is skipped');
  });

  it('the client address is the last X-Forwarded-For hop (what the proxy saw), not whatever the client wrote first', () => {
    assert.equal(clientIp('1.2.3.4, 9.9.9.9', '10.0.0.1'), '9.9.9.9');
    assert.equal(clientIp('9.9.9.9', '10.0.0.1'), '9.9.9.9');
    assert.equal(clientIp(undefined, '10.0.0.1'), '10.0.0.1');
    assert.equal(clientIp(['1.1.1.1', '2.2.2.2'], undefined), '2.2.2.2');
  });

  it('failed logins are also limited per account name, whatever address they come from', async () => {
    const a = new Accounts(new MemoryStore());
    await a.register('Ann', 'password1', '1.1.1.1');
    let locked = false;
    for (let i = 0; i < 40 && !locked; i++) {
      const r = await a.login('Ann', 'wrongpass', `10.0.${i}.1`);
      locked = !r.ok && /Too many/.test(r.reason);
    }
    assert.ok(locked, 'one password tried from many addresses runs into the per-name limit');
  });

  it('rate-limit maps forget old entries', () => {
    const l = new Limiter(3, 50);
    for (let i = 0; i < 100; i++) l.allow(`k${i}`);
    assert.equal(l.size, 100);
    l.sweep(Date.now() + 1000, true);
    assert.equal(l.size, 0);
  });

  it('concurrent writes to one account are queued, so a friend request cannot erase a recorded win', async () => {
    const a = new Accounts(new MemoryStore());
    await a.register('Ann', 'password1', '1.1.1.1');
    await a.register('Bob', 'password1', '2.2.2.2');
    await Promise.all([
      a.recordMatch('Ann', { won: true, rated: true, opponentAvg: START_RATING }),
      a.friendOp('bob', 'add', 'Ann'),
      a.saveSettings((await a.get('Ann'))!, '{"arena.x":"1"}'),
      a.recordMatch('Ann', { won: true, rated: true, opponentAvg: START_RATING }),
    ]);
    const ann = (await a.get('Ann'))!;
    assert.equal(ann.wins, 2, 'both wins kept');
    assert.deepEqual(ann.requests, ['Bob'], 'and the request');
    assert.equal(ann.settings, '{"arena.x":"1"}', 'and the settings');
  });

  it('without an owner code nobody can take the founder name, and owner looks need the owner session', async () => {
    const off = new Accounts(new MemoryStore());
    assert.equal((await off.register('Toke', 'hunter22', '1.1.1.1')).ok, false);
    const on = new Accounts(new MemoryStore(), 'code');
    const t = (await on.register('Toke', 'hunter22', '1.1.1.1', 'code')) as any;
    const want = { title: 'founder', emblem: 'trident', color: 'neon' };
    assert.equal(await on.customize(t.account, want, false), null, 'the name alone is not enough');
    assert.deepEqual((await on.customize(t.account, want, true))?.cosmetics, want);
  });

  it('suggestions are limited per account and address, so reconnecting does not reset the limit', async () => {
    const accounts = new Accounts(new MemoryStore());
    const { Suggestions } = await import('../src/suggestions');
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 }, accounts, undefined, new Suggestions(new MemoryStore()));
    const s1 = sock();
    const p1 = lobby.connect(s1, '5.5.5.5');
    lobby.handle(p1, { t: 'register', name: 'Ann', password: 'password1' } as ClientMsg);
    await until(() => s1.sent.some((m: ServerMsg) => m.t === 'account'));
    lobby.handle(p1, { t: 'suggest', text: 'more maps' } as ClientMsg);
    await until(() => !!last(s1, 'suggest_ack'));
    assert.equal(last(s1, 'suggest_ack')!.ok, true);
    lobby.disconnect(p1);
    const s2 = sock();
    const p2 = lobby.connect(s2, '5.5.5.5');
    lobby.handle(p2, { t: 'login', name: 'Ann', password: 'password1' } as ClientMsg);
    await until(() => s2.sent.some((m: ServerMsg) => m.t === 'account'));
    lobby.handle(p2, { t: 'suggest', text: 'again' } as ClientMsg);
    assert.match(last(s2, 'suggest_ack')!.reason ?? '', /Slow down/);
  });
});

describe('0.64 replays', () => {
  it('every match keeps its replay (solo practice too, for the owner\'s match list); a replay too big to keep is announced', async () => {
    const accounts = new Accounts(new MemoryStore());
    const { us, lobby } = await world(['Ann', 'Bob'], {}, accounts);
    let saved = 0;
    const orig = accounts.saveReplay.bind(accounts);
    accounts.saveReplay = (id, gz) => (saved++, orig(id, gz));
    lobby.handle(us[0].p, { t: 'join', name: 'x', classId: 'mage', mode: 'practice', size: 1, difficulty: 'easy' } as ClientMsg);
    const prac: any = us[0].p.room;
    lobby.tick();
    for (const u of prac.sim.units.values()) if (u.controller !== 'player') prac.sim.forfeit(u.id);
    lobby.tick();
    await until(() => (last(us[0].s, 'account')?.account.matches ?? 0) >= 1);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(saved, 1, 'solo practice is stored too');
    const hist = await accounts.history('ann');
    assert.equal(hist[0]?.replay, true, 'and the history links it');
    assert.equal((await accounts.feed())[0]?.id, prac.id, 'and it is in the list of every match');

    // ranked: an oversized replay is not stored, and the players are told
    lobby.handle(us[0].p, { t: 'leave' } as ClientMsg);
    queue(lobby, us[0].p);
    queue(lobby, us[1].p);
    const room: any = us[0].p.room;
    assert.ok(room?.isRanked);
    lobby.tick();
    for (let i = 0; i < 200000; i++) room.sim.queueInput(us[0].p.unitId, { seq: i + 1, fwd: Math.random() * 2 - 1, strafe: Math.random() * 2 - 1, facing: Math.random() * 6 }); // a huge input log
    for (const u of room.sim.units.values()) if (u.team === 1) room.sim.forfeit(u.id);
    lobby.tick();
    await until(() => !!us[0].s.sent.find((m: ServerMsg) => m.t === 'notice' && /too long to keep a replay/.test(m.text)), 'players hear the replay was too big');
  });
});
