import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Accounts } from '../src/accounts';
import { MemoryStore } from '../src/store';
import { Lobby } from '../src/rooms';
import { START_RATING } from '@arena/shared';
import type { ClientMsg, ServerMsg } from '@arena/shared';

const fresh = () => new Accounts(new MemoryStore());

describe('accounts', () => {
  it('registers, rejects duplicates (any case), logs in and resumes', async () => {
    const a = fresh();
    const r = await a.register('Toke', 'hunter22', '1.1.1.1');
    assert.ok(r.ok);
    assert.equal((await a.register('toke', 'other-pass', '1.1.1.1')).ok, false);
    const l = await a.login('TOKE', 'hunter22', '1.1.1.1');
    assert.ok(l.ok);
    const res = await a.resume((l as any).token);
    assert.ok(res.ok);
    assert.equal((res as any).account.name, 'Toke');
    assert.equal((await a.resume('nope-nope-nope')).ok, false);
    await a.logout((l as any).token);
    assert.equal((await a.resume((l as any).token)).ok, false);
  });

  it('never stores the password and rejects wrong ones; locks out after repeated failures', async () => {
    const store = new MemoryStore();
    const a = new Accounts(store);
    await a.register('Alice', 'correct-horse', '2.2.2.2');
    const raw = (await store.get('acct:alice'))!;
    assert.ok(!raw.includes('correct-horse'));
    assert.equal((await a.login('Alice', 'wrong-pass', '2.2.2.2')).ok, false);
    assert.equal((await a.login('Nobody', 'whatever1', '2.2.2.2')).ok, false);
    for (let i = 0; i < 6; i++) await a.login('Alice', 'bad-guess', '9.9.9.9');
    const locked = await a.login('Alice', 'correct-horse', '9.9.9.9');
    assert.equal(locked.ok, false);
    assert.match((locked as any).reason, /Too many/);
    assert.ok((await a.login('Alice', 'correct-horse', '2.2.2.2')).ok, 'other networks unaffected');
  });

  it('limits account creation per network', async () => {
    const a = fresh();
    for (let i = 0; i < 5; i++) assert.ok((await a.register(`user_${i}`, 'password1', '3.3.3.3')).ok);
    assert.equal((await a.register('user_5', 'password1', '3.3.3.3')).ok, false);
  });

  it('rated results move Elo, unrated only count matches, leaderboard sorts by rating', async () => {
    const a = fresh();
    await a.register('Win', 'password1', '4.4.4.4');
    await a.register('Lose', 'password1', '4.4.4.5');
    const w = (await a.recordMatch('Win', { won: true, rated: true, opponentAvg: START_RATING }))!;
    const l = (await a.recordMatch('Lose', { won: false, rated: true, opponentAvg: START_RATING }))!;
    assert.ok(w.rating > START_RATING && l.rating < START_RATING);
    assert.equal(w.rating - START_RATING, START_RATING - l.rating, 'even match is zero-sum');
    assert.equal(w.peak, w.rating);
    const u = (await a.recordMatch('Lose', { won: true, rated: false, opponentAvg: 2000 }))!;
    assert.equal(u.rating, l.rating, 'practice does not change rating');
    assert.equal(u.matches, 2);
    const rows = await a.leaderboard();
    assert.deepEqual(rows.map((r) => r.name), ['Win', 'Lose']);
  });

  it('cosmetics can only be chosen once unlocked', async () => {
    const a = fresh();
    const acc = ((await a.register('Dress', 'password1', '5.5.5.5')) as any).account;
    assert.equal(await a.customize(acc, { title: 'warlord', emblem: 'swords', color: 'white' }), null);
    const ok = await a.customize(acc, { title: 'initiate', emblem: 'shield', color: 'white' });
    assert.equal(ok?.cosmetics.emblem, 'shield');
    assert.equal(await a.customize(acc, { title: 'initiate', emblem: 'nonsense', color: 'white' }), null);
    acc.wins = 30;
    acc.matches = 40;
    await a.save(acc);
    const later = await a.customize(acc, { title: 'warlord', emblem: 'skull', color: 'gold' });
    assert.equal(later?.cosmetics.title, 'warlord');
  });
});

function fakeSocket() {
  const sent: ServerMsg[] = [];
  return { readyState: 1, sent, send(d: string) { sent.push(JSON.parse(d)); } } as any;
}
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), 'timed out');
};

describe('accounts in the lobby', () => {
  it('login gives the real name, progress comes from the account, a ranked queue match moves rating, leavers lose', async () => {
    const accounts = fresh();
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 }, accounts);
    const socks = [fakeSocket(), fakeSocket(), fakeSocket(), fakeSocket()];
    const players = socks.map((s) => lobby.connect(s, '7.7.7.7'));
    const names = ['Ann', 'Bob', 'Cy_', 'Dee'];
    for (let i = 0; i < 4; i++) {
      lobby.handle(players[i], { t: 'register', name: names[i], password: 'password1' } as ClientMsg);
      await until(() => socks[i].sent.some((m: ServerMsg) => m.t === 'account'));
    }
    const classes = ['warrior', 'mage', 'priest', 'rogue'] as const;
    for (let i = 0; i < 4; i++) lobby.handle(players[i], { t: 'join', name: 'ignored', classId: classes[i], mode: 'queue' });
    const room: any = players[0].room;
    assert.ok(room, 'four queued players form a match');
    const welcome = socks[0].sent.find((m: ServerMsg) => m.t === 'welcome');
    assert.ok(welcome);
    assert.equal(room.sim.units.get((welcome as any).unitId).name, 'Ann', 'display name is the account name');
    assert.ok(socks[1].sent.some((m: ServerMsg) => m.t === 'roster' && (m as any).players.length === 4));
    assert.ok(!socks[0].sent.some((m: ServerMsg) => m.t === 'profile'), 'no guest token for signed-in players');

    // Dee leaves a live ranked match: instant loss
    for (let i = 0; i < 3; i++) lobby.tick();
    lobby.disconnect(players[3]);
    await until(() => players[3].account!.rated === 1);
    assert.ok(players[3].account!.rating < START_RATING);

    // the other team (Cy_ + Dee were...): finish by eliminating team 1 so team 0 wins
    for (const u of room.sim.units.values()) if (u.team === 1) room.sim.forfeit(u.id);
    for (let i = 0; i < 3; i++) lobby.tick();
    assert.equal(room.sim.winner, 0);
    for (let i = 0; i < 3; i++) await until(() => socks[i].sent.filter((m: ServerMsg) => m.t === 'account').length >= 2);
    const ratingOf = (i: number) => (socks[i].sent.filter((m: ServerMsg) => m.t === 'account').at(-1) as any).account.rating as number;
    assert.ok(ratingOf(0) > START_RATING && ratingOf(1) > START_RATING, 'winning team gains');
    assert.ok(ratingOf(2) < START_RATING, 'losing team loses');
    assert.ok(!socks[0].sent.some((m: ServerMsg) => (m.t as string) === 'loot'), 'no loot drops any more');
    const lastAccount = socks[0].sent.filter((m: ServerMsg) => m.t === 'account').at(-1) as any;
    assert.equal(lastAccount.account.inventory, undefined);
    const top = await accounts.leaderboard();
    assert.equal(top.length, 4);
  });

  it('customize and leaderboard messages work; guests are told accounts need a login', async () => {
    const accounts = fresh();
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 }, accounts);
    const s = fakeSocket();
    const p = lobby.connect(s, '8.8.8.8');
    lobby.handle(p, { t: 'customize', cosmetics: { title: '', emblem: 'shield', color: 'white' } });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(!s.sent.some((m: ServerMsg) => m.t === 'account'), 'guests cannot customize');
    lobby.handle(p, { t: 'register', name: 'Zed', password: 'password1' });
    await until(() => s.sent.some((m: ServerMsg) => m.t === 'account'));
    lobby.handle(p, { t: 'customize', cosmetics: { title: 'initiate', emblem: 'shield', color: 'white' } });
    await until(() => s.sent.filter((m: ServerMsg) => m.t === 'account').length === 2);
    assert.equal((s.sent.filter((m: ServerMsg) => m.t === 'account').at(-1) as any).account.cosmetics.emblem, 'shield');
    lobby.handle(p, { t: 'leaderboard' });
    await until(() => s.sent.some((m: ServerMsg) => m.t === 'leaderboard'));
    lobby.handle(p, { t: 'logout' });
    await until(() => s.sent.some((m: ServerMsg) => m.t === 'logged_out'));
  });
});

describe('owner cosmetics and synced settings', () => {
  it('owner-only cosmetics work for Toke and are refused for everyone else', async () => {
    const a = fresh();
    const toke = (await a.register('Toke', 'hunter22', '3.3.3.3')) as any;
    const bob = (await a.register('Bob', 'hunter22', '4.4.4.4')) as any;
    const want = { title: 'founder', emblem: 'trident', color: 'neon' };
    const ok = await a.customize(toke.account, want);
    assert.deepEqual(ok?.cosmetics, want);
    assert.equal(await a.customize(bob.account, want), null);
    assert.equal(await a.customize(bob.account, { title: 'founder', emblem: 'swords', color: 'white' }), null);
  });

  it('reserved owner names need the owner code when one is configured', async () => {
    const a = new Accounts(new MemoryStore(), 'sesame');
    assert.equal((await a.register('Toke', 'hunter22', '5.5.5.5')).ok, false);
    assert.equal((await a.register('Toke', 'hunter22', '5.5.5.5', 'wrong')).ok, false);
    assert.ok((await a.register('Toke', 'hunter22', '5.5.5.5', 'sesame')).ok);
    assert.ok((await a.register('Other', 'hunter22', '5.5.5.5')).ok, 'ordinary names are unaffected');
  });

  it('saves settings on the account and returns them on login', async () => {
    const a = fresh();
    const r = (await a.register('Alice', 'hunter22', '6.6.6.6')) as any;
    await a.saveSettings(r.account, '{"arena.hud.v1":"{}"}');
    const l = (await a.login('Alice', 'hunter22', '6.6.6.6')) as any;
    assert.equal(l.account.settings, '{"arena.hud.v1":"{}"}');
  });
});

describe('old saves', () => {
  it('a stored loot inventory from before cosmetics is dropped when the account loads', async () => {
    const a = fresh();
    await a.register('Oldie', 'hunter22', '8.8.4.4');
    const rec = (await a.get('Oldie'))! as any;
    rec.inventory = ['L.rare.head.abcd12'];
    rec.pity = 5;
    await a.save(rec);
    const again = (await a.get('Oldie'))! as any;
    assert.equal(again.inventory, undefined);
    assert.equal(again.pity, undefined);
  });
});

describe('shared database', () => {
  it('two games with different prefixes on one store never see each other', async () => {
    const { PrefixedStore } = await import('../src/store');
    const raw = new MemoryStore();
    const wow = new Accounts(new PrefixedStore(raw, 'wowarena:'));
    const aim = new Accounts(new PrefixedStore(raw, 'aim:'));
    assert.ok((await wow.register('Toke', 'hunter22', '1.2.3.4')).ok);
    assert.ok((await aim.register('Toke', 'different1', '1.2.3.5')).ok, 'same name is free in the other game');
    assert.equal((await wow.login('Toke', 'different1', '1.2.3.4')).ok, false);
    assert.ok((await wow.login('Toke', 'hunter22', '1.2.3.4')).ok);
    assert.equal((await wow.leaderboard()).length, 1);
    assert.ok(await raw.get('wowarena:acct:toke'), 'keys are stored under the prefix');
    assert.equal(await raw.get('acct:toke'), null, 'nothing is written unprefixed');
  });
});
