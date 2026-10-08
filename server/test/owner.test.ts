import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Accounts, validateGif } from '../src/accounts';
import { MemoryStore } from '../src/store';
import { Lobby } from '../src/rooms';
import { cleanCustom, resolveCosmetics } from '@arena/shared';
import type { ClientMsg, ServerMsg } from '@arena/shared';

const CODE = 'sesame-code';
const setup = async () => {
  const a = new Accounts(new MemoryStore(), CODE);
  const toke = (await a.register('Toke', 'hunter22', '1.1.1.1', CODE)) as any;
  const bob = (await a.register('Bob', 'hunter22', '2.2.2.2')) as any;
  return { a, toke, bob };
};

describe('owner powers', () => {
  it('cleanCustom strips markup, caps length and validates colours', () => {
    const c = cleanCustom({ title: '<b>Lord</b> of  Nothing at all, truly long title here', color: '#FF00AA', color2: '#00ffcc', glow: 1 });
    assert.ok(c);
    assert.ok(!/[<>]/.test(c!.title));
    assert.ok(c!.title.length <= 24);
    assert.equal(c!.color, '#ff00aa');
    assert.equal(cleanCustom({ title: 'x', color: 'red' }), null);
    assert.equal(cleanCustom({ title: 'x', color: '#ffffff', color2: 'nope' }), null);
  });

  it('owner code unlock is required, rate limited, and only for the founder account', async () => {
    const { a, toke, bob } = await setup();
    assert.equal(await a.isOwnerSession(toke.token, toke.account), false);
    assert.equal((await a.ownerUnlock(bob.token, bob.account, CODE, '1.1.1.1')).ok, false);
    assert.equal((await a.ownerUnlock(toke.token, toke.account, 'wrong', '1.1.1.1')).ok, false);
    assert.equal((await a.ownerUnlock(toke.token, toke.account, CODE, '1.1.1.1')).ok, true);
    assert.equal(await a.isOwnerSession(toke.token, toke.account), true);
    await a.logout(toke.token);
    assert.equal(await a.isOwnerSession(toke.token, toke.account), false);
    for (let i = 0; i < 5; i++) await a.ownerUnlock(toke.token, toke.account, 'bad', '9.9.9.9');
    assert.match(((await a.ownerUnlock(toke.token, toke.account, CODE, '9.9.9.9')) as any).reason, /Too many/);
    // a server started without the code: the founder account (made earlier, with a code) cannot unlock anything
    const st = new MemoryStore();
    await new Accounts(st, CODE).register('Toke', 'hunter22', '3.3.3.3', CODE);
    const off = new Accounts(st);
    const t = (await off.login('Toke', 'hunter22', '3.3.3.3')) as any;
    assert.match(((await off.ownerUnlock(t.token, t.account, CODE, '3.3.3.3')) as any).reason, /ARENA_OWNER_CODE/);
  });

  it('custom style: only writers can set it; others keep what the owner gave them', async () => {
    const { a, toke, bob } = await setup();
    const custom = { title: 'Lord of Sparks', color: '#ff2bd6', color2: '#2bffd0', glow: true };
    const ok = await a.customize(toke.account, { title: '', emblem: 'swords', color: 'white', custom, useCustom: true }, true);
    assert.equal(resolveCosmetics(ok!.cosmetics).title, 'Lord of Sparks');
    assert.equal(resolveCosmetics(ok!.cosmetics).color2, '#2bffd0');
    // a normal player cannot write one
    const sneaky = await a.customize(bob.account, { title: '', emblem: 'swords', color: 'white', custom, useCustom: true }, false);
    assert.equal(sneaky?.cosmetics.custom, undefined);
    assert.notEqual(resolveCosmetics(sneaky!.cosmetics).title, 'Lord of Sparks');
    // the owner gives Bob one; Bob can toggle it but not rewrite it
    const r = await a.adminSet('Bob', { custom: { title: 'Toke\'s Friend', color: '#ffd23f', glow: false } });
    assert.ok(r.ok);
    assert.equal(resolveCosmetics(r.ok ? r.account.cosmetics : ({} as any)).title, "Toke's Friend");
    const toggled = await a.customize(r.ok ? r.account : bob.account, { title: '', emblem: 'swords', color: 'white', custom: { ...custom, title: 'HACKED' }, useCustom: false }, false);
    assert.equal(toggled?.cosmetics.custom?.title, "Toke's Friend");
    assert.equal(toggled?.cosmetics.useCustom, undefined);
  });

  it('grants open owner-only items for a friend, and revoking resets what was equipped', async () => {
    const { a, bob } = await setup();
    assert.equal(await a.customize(bob.account, { title: 'founder', emblem: 'swords', color: 'white' }), null);
    const g = await a.adminSet('Bob', { grants: ['title:founder', 'color:neon', 'gif'] });
    assert.ok(g.ok);
    const eq = await a.customize((g as any).account, { title: 'founder', emblem: 'swords', color: 'neon' });
    assert.equal(eq?.cosmetics.title, 'founder');
    const rv = await a.adminSet('Bob', { grants: ['gif'] });
    assert.equal((rv as any).account.cosmetics.title, '');
    assert.equal((rv as any).account.cosmetics.color, 'white');
    assert.equal((await a.adminSet('Bob', { grants: ['title:warlord'] })).ok, false, 'free/earned items are not grantable');
    assert.equal((await a.adminSet('Bob', { grants: ['bogus'] })).ok, false);
    assert.equal((await a.adminSet('Toke', { grants: ['gif'] })).ok, false, 'founder is not editable here');
  });

  it('password reset issues a temp password and kills old sessions', async () => {
    const { a, bob } = await setup();
    const r = (await a.adminSet('Bob', { resetPassword: true })) as any;
    assert.ok(r.ok && r.tempPassword);
    assert.equal((await a.resume(bob.token)).ok, false);
    assert.equal((await a.login('Bob', 'hunter22', '2.2.2.2')).ok, false);
    const l = await a.login('Bob', r.tempPassword, '2.2.2.2');
    assert.ok(l.ok);
    assert.ok((await a.resume((l as any).token)).ok);
  });

  it('GIF validation and storage', async () => {
    const { a, toke, bob } = await setup();
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([64, 0, 64, 0, 0, 0, 0]), Buffer.alloc(40)]);
    assert.equal(validateGif(gif), null);
    assert.ok(validateGif(Buffer.from('not a gif at all, sorry'))); 
    const big = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0, 4, 0, 4, 0, 0, 0]), Buffer.alloc(40)]);
    assert.match(validateGif(big)!, /256/);
    assert.match(validateGif(Buffer.alloc(300 * 1024))!, /too big/);
    assert.equal(a.canGif(bob.account, false), false);
    assert.equal(a.canGif(toke.account, true), true);
    const saved = await a.setAvatar(toke.account, gif);
    assert.ok(saved.avatar);
    assert.deepEqual(await a.getAvatar('TOKE'), gif);
    assert.equal(await a.getAvatar('../etc/passwd'), null);
    const cleared = await a.clearAvatar(saved);
    assert.equal(cleared.avatar, undefined);
    assert.equal(await a.getAvatar('toke'), null);
  });

  it('admin messages over the lobby: locked until the code is entered, then list and edit; friend sees changes live', async () => {
    const a = new Accounts(new MemoryStore(), CODE);
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 }, a);
    const mk = () => {
      const sent: ServerMsg[] = [];
      return { sent, send: (d: string) => sent.push(JSON.parse(d)), on() {}, close() {}, readyState: 1, OPEN: 1 } as any as { sent: ServerMsg[] };
    };
    const sT = mk(), sB = mk();
    const pT = lobby.connect(sT as any, '1.1.1.1'), pB = lobby.connect(sB as any, '2.2.2.2');
    const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(f(), 'timed out'); };
    lobby.handle(pT, { t: 'register', name: 'Toke', password: 'hunter22', ownerCode: CODE });
    lobby.handle(pB, { t: 'register', name: 'Bob', password: 'hunter22' });
    await until(() => sT.sent.some((m) => m.t === 'account') && sB.sent.some((m) => m.t === 'account'));
    lobby.handle(pT, { t: 'admin_list' });
    await until(() => sT.sent.some((m) => m.t === 'auth_error'));
    lobby.handle(pB, { t: 'owner_unlock', code: CODE });
    await until(() => sB.sent.some((m) => m.t === 'owner'));
    assert.equal((sB.sent.find((m) => m.t === 'owner') as any).ok, false);
    lobby.handle(pB, { t: 'admin_list' });
    await until(() => sB.sent.filter((m) => m.t === 'auth_error').length >= 1);
    lobby.handle(pT, { t: 'owner_unlock', code: CODE });
    await until(() => sT.sent.some((m) => m.t === 'owner'));
    lobby.handle(pT, { t: 'admin_list' });
    await until(() => sT.sent.some((m) => m.t === 'admin_accounts'));
    const rows = (sT.sent.find((m) => m.t === 'admin_accounts') as any).rows;
    assert.deepEqual(rows.map((r: any) => r.name).sort(), ['Bob', 'Toke']);
    assert.equal(rows.find((r: any) => r.name === 'Bob').online, true);
    const before = sB.sent.filter((m) => m.t === 'account').length;
    lobby.handle(pT, { t: 'admin_set', name: 'Bob', grants: ['title:founder'] });
    await until(() => sT.sent.some((m) => m.t === 'admin_result'));
    await until(() => sB.sent.filter((m) => m.t === 'account').length > before);
    assert.deepEqual((sB.sent.filter((m) => m.t === 'account').at(-1) as any).account.grants, ['title:founder']);
  });
});

describe('owner bot match', () => {
  it('only the owner can start one; everyone can watch it, it has the picked specs, and closes when nobody watches', async () => {
    const { a, toke, bob } = await setup();
    const lobby = new Lobby({ practicePrepMs: 100, queuePrepMs: 100 }, a);
    const sent: ServerMsg[] = [];
    const sentBob: ServerMsg[] = [];
    const mkP = (name: string, out: ServerMsg[], account: any) => ({ ws: { readyState: 1, send: (s: string) => out.push(JSON.parse(s)), bufferedAmount: 0 } as any, name, classId: 'mage', matches: 0, wins: 0, size: 1, ip: '1.1.1.1', mapPref: 'random', account, ownerOk: false } as any);
    const owner = mkP('Toke', sent, toke.account);
    const other = mkP('Bob', sentBob, bob.account);
    const msg = { t: 'bot_match', size: 2, teams: [[{ classId: 'warrior', spec: 'fury' }, { classId: 'priest' }], [{ classId: 'mage', spec: 'fire' }, { classId: 'rogue' }]], difficulty: 'hard', map: 'colosseum' } as ClientMsg;
    lobby.handle(other, msg);
    assert.equal(other.watching, undefined, 'not for anyone else');
    lobby.handle(owner, msg);
    assert.equal(owner.watching, undefined, 'not before the owner code is entered');
    owner.ownerOk = true;
    lobby.handle(owner, msg);
    const room = owner.watching;
    assert.ok(room, 'watching the bot match');
    assert.equal(room.arenaId, 'colosseum');
    assert.equal(room.watchable, true, 'listed in Watch live for everyone');
    const units = [...room.sim.units.values()] as any[];
    assert.equal(units.length, 4);
    assert.ok(units.every((u) => u.controller === 'bot'));
    assert.equal(units.find((u) => u.classId === 'warrior').spec, 'fury');
    assert.equal(units.find((u) => u.classId === 'mage').spec, 'fire');
    assert.ok(units.find((u) => u.classId === 'warrior').name.startsWith('Bot Rampager'), 'bots are named after their spec');
    assert.ok(sent.some((m) => m.t === 'spectating'));
    const builds = sent.find((m) => m.t === 'builds') as Extract<ServerMsg, { t: 'builds' }> | undefined;
    assert.ok(builds, 'the watcher gets everyone\u2019s build');
    assert.equal(builds!.units.length, 4);
    const fury = builds!.units.find((u) => u.classId === 'warrior')!;
    assert.equal(fury.spec, 'fury');
    assert.equal(fury.talents.length, 5, 'its talent picks, tier by tier');
    assert.ok(fury.bar.includes('bloodthirst'), 'and its bar');
    lobby.handle(owner, { t: 'leave' } as ClientMsg);
    assert.equal(owner.watching, undefined);
    assert.ok((room as any).closed, 'the room closes once nobody watches');
  });
});

describe('bot match message', () => {
  it('is parsed strictly', async () => {
    const { parseClientMsg } = await import('@arena/shared');
    const ok = { t: 'bot_match', size: 1, teams: [[{ classId: 'warrior', spec: 'arms' }], [{ classId: 'mage' }]], difficulty: 'normal', map: 'random' };
    assert.ok(parseClientMsg(JSON.stringify(ok)));
    assert.equal(parseClientMsg(JSON.stringify({ ...ok, teams: [[{ classId: 'warrior', spec: 'fire' }], [{ classId: 'mage' }]] })), null, 'a spec of another class');
    assert.equal(parseClientMsg(JSON.stringify({ ...ok, size: 2 })), null, 'sides must match the size');
    assert.equal(parseClientMsg(JSON.stringify({ ...ok, map: 'nowhere' })), null);
    assert.equal(parseClientMsg(JSON.stringify({ ...ok, difficulty: 'dummy' })), null);
  });
});

describe('owner follows a player', () => {
  it('is taken into each match the player starts (Play again too), and only the owner can follow', async () => {
    const { a, toke, bob } = await setup();
    const lobby = new Lobby({ practicePrepMs: 100, queuePrepMs: 100 }, a);
    const mkP = (name: string, out: ServerMsg[], account: any) => ({ ws: { readyState: 1, send: (s: string) => out.push(JSON.parse(s)), bufferedAmount: 0 } as any, name, classId: 'mage', matches: 0, wins: 0, size: 1, ip: '1.1.1.1', mapPref: 'random', account, ownerOk: false } as any);
    const sentO: ServerMsg[] = [];
    const owner = mkP('Toke', sentO, toke.account);
    const player = mkP('Bob', [], bob.account);
    (lobby as any).conns.add(owner);
    (lobby as any).conns.add(player);
    lobby.handle(player, { t: 'follow', name: 'Toke' } as ClientMsg);
    assert.equal(player.follow, undefined, 'not for players');
    owner.ownerOk = true;
    lobby.handle(owner, { t: 'follow', name: 'Bob' } as ClientMsg);
    assert.ok(sentO.some((m) => m.t === 'following' && m.name === 'Bob'));
    assert.equal(owner.watching, undefined, 'Bob is not in a match yet');
    lobby.handle(player, { t: 'join', name: 'Bob', classId: 'mage', mode: 'practice', difficulty: 'normal', size: 1 } as ClientMsg);
    const first = player.room;
    assert.ok(first);
    assert.equal(owner.watching, first, 'pulled into the match Bob starts');
    (first.sim as any).phase = 'ended';
    lobby.handle(player, { t: 'rematch', on: true } as ClientMsg);
    assert.ok(player.room && player.room !== first);
    assert.equal(owner.watching, player.room, 'and into the next one');
    lobby.handle(owner, { t: 'follow', name: null } as ClientMsg);
    assert.equal(owner.follow, undefined);
  });
});
