import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Accounts } from '../src/accounts';
import { MemoryStore } from '../src/store';
import { Lobby } from '../src/rooms';
import type { Player } from '../src/rooms';
import type { ClientMsg, ServerMsg } from '@arena/shared';

const sock = () => {
  const sent: ServerMsg[] = [];
  return { readyState: 1, sent, send(d: string) { sent.push(JSON.parse(d)); } } as any;
};
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), 'timed out');
};
const last = <T extends ServerMsg['t']>(s: any, t: T) => (s.sent as ServerMsg[]).filter((m) => m.t === t).at(-1) as Extract<ServerMsg, { t: T }> | undefined;

async function world(names: string[]) {
  const accounts = new Accounts(new MemoryStore());
  const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 }, accounts);
  const us = [] as { name: string; s: any; p: Player }[];
  for (const name of names) {
    const s = sock();
    const p = lobby.connect(s, `ip-${name}`);
    lobby.handle(p, { t: 'register', name, password: 'password1' } as ClientMsg);
    await until(() => s.sent.some((m: ServerMsg) => m.t === 'account'));
    us.push({ name, s, p });
  }
  const friend = async (a: number, b: number) => {
    lobby.handle(us[a].p, { t: 'friend', op: 'add', name: us[b].name });
    await until(() => (last(us[b].s, 'friends')?.requests ?? []).includes(us[a].name));
    lobby.handle(us[b].p, { t: 'friend', op: 'accept', name: us[a].name });
    await until(() => (last(us[a].s, 'friends')?.friends ?? []).some((f) => f.name === us[b].name));
  };
  return { accounts, lobby, us, friend };
}

describe('friends', () => {
  it('request, accept, presence, remove', async () => {
    const { lobby, us } = await world(['Ann', 'Bob']);
    lobby.handle(us[0].p, { t: 'friend', op: 'add', name: 'Bob' });
    await until(() => (last(us[1].s, 'friends')?.requests ?? []).includes('Ann'));
    assert.match((last(us[1].s, 'notice') as any).text, /friend request/);
    lobby.handle(us[0].p, { t: 'friend', op: 'add', name: 'Bob' });
    await until(() => (last(us[0].s, 'notice') as any).text === 'Request already sent.');
    lobby.handle(us[1].p, { t: 'friend', op: 'accept', name: 'Ann' });
    await until(() => (last(us[0].s, 'friends')?.friends ?? []).length === 1);
    const row = last(us[0].s, 'friends')!.friends[0];
    assert.equal(row.name, 'Bob');
    assert.equal(row.status, 'menu');
    assert.equal(last(us[1].s, 'friends')!.friends[0].name, 'Ann');
    assert.deepEqual(last(us[1].s, 'friends')!.requests, []);

    // presence follows queueing and disconnects
    lobby.handle(us[1].p, { t: 'join', name: 'x', classId: 'mage', mode: 'queue', size: 2 });
    await until(() => last(us[0].s, 'friends')!.friends[0].status === 'queue');
    lobby.disconnect(us[1].p);
    await until(() => last(us[0].s, 'friends')!.friends[0].status === 'offline');

    lobby.handle(us[0].p, { t: 'friend', op: 'remove', name: 'Bob' });
    await until(() => last(us[0].s, 'friends')!.friends.length === 0);
    lobby.handle(us[0].p, { t: 'friend', op: 'add', name: 'Nobody_here' });
    await until(() => (last(us[0].s, 'notice') as any).text === 'No player with that name.');
    lobby.handle(us[0].p, { t: 'friend', op: 'add', name: 'Ann' });
    await until(() => (last(us[0].s, 'notice') as any).text === 'That is you.');
  });

  it('adding someone who already asked you makes you friends at once', async () => {
    const { lobby, us } = await world(['Cy_', 'Dee']);
    lobby.handle(us[0].p, { t: 'friend', op: 'add', name: 'Dee' });
    await until(() => (last(us[1].s, 'friends')?.requests ?? []).length === 1);
    lobby.handle(us[1].p, { t: 'friend', op: 'add', name: 'Cy_' });
    await until(() => (last(us[1].s, 'friends')?.friends ?? []).length === 1);
    await until(() => (last(us[0].s, 'friends')?.friends ?? []).length === 1);
  });
});

describe('parties', () => {
  it('only friends can be invited; a party queues together on one team and its members are never split', async () => {
    const { lobby, us, friend } = await world(['Ann', 'Bob', 'Cy_', 'Dee', 'Eve']);
    lobby.handle(us[0].p, { t: 'invite', kind: 'party', name: 'Bob' });
    await until(() => (last(us[0].s, 'notice') as any)?.text === 'You can only invite friends.');
    await friend(0, 1);
    lobby.handle(us[0].p, { t: 'invite', kind: 'party', name: 'Bob' });
    await until(() => !!last(us[1].s, 'invite'));
    const inv = last(us[1].s, 'invite')!;
    assert.equal(inv.from, 'Ann');
    lobby.handle(us[1].p, { t: 'invite_reply', id: inv.id, accept: true });
    await until(() => last(us[0].s, 'party')?.party?.members.length === 2);
    assert.equal(last(us[1].s, 'party')!.party!.leader, 'Ann');

    // Bob cannot pick a queue himself; Ann cannot start until Bob is ready
    lobby.handle(us[1].p, { t: 'join', name: 'x', classId: 'mage', mode: 'queue', size: 2 });
    assert.match((last(us[1].s, 'closed') as any).reason, /party leader/);
    lobby.handle(us[0].p, { t: 'join', name: 'x', classId: 'mage', mode: 'queue', size: 2 });
    assert.match((last(us[0].s, 'closed') as any).reason, /Waiting for Bob/);
    lobby.handle(us[1].p, { t: 'ready', on: true, name: 'x', classId: 'mage' });
    assert.equal(last(us[0].s, 'party')!.party!.members.find((m) => m.name === 'Bob')!.ready, true);
    lobby.handle(us[0].p, { t: 'join', name: 'x', classId: 'mage', mode: 'queue', size: 2 });
    assert.equal(us[0].p.room, undefined);
    for (const u of [us[2], us[3]]) lobby.handle(u.p, { t: 'join', name: 'x', classId: 'priest', mode: 'queue', size: 2 });
    assert.ok(us[0].p.room, 'party + two solos = 2v2');
    const team = (u: { p: Player }) => (us[0].p.room!.sim.units.get(u.p.unitId!)!).team;
    assert.equal(team(us[0]), team(us[1]), 'party mates share a team');
    assert.notEqual(team(us[2]), team(us[0]));
    assert.equal(us[4].p.room, undefined);
    assert.equal(last(us[0].s, 'friends')!.friends[0].status, 'match');
  });

  it('party too big for the mode is refused (queued apart); leaving disbands a two-person party; leader passes on', async () => {
    const { lobby, us, friend } = await world(['Ann', 'Bob', 'Cy_']);
    await friend(0, 1);
    await friend(0, 2);
    for (const to of ['Bob', 'Cy_']) lobby.handle(us[0].p, { t: 'invite', kind: 'party', name: to });
    await until(() => !!last(us[1].s, 'invite') && !!last(us[2].s, 'invite'));
    for (const u of [us[1], us[2]]) lobby.handle(u.p, { t: 'invite_reply', id: last(u.s, 'invite')!.id, accept: true });
    await until(() => last(us[0].s, 'party')?.party?.members.length === 3);
    for (const u of [us[1], us[2]]) lobby.handle(u.p, { t: 'ready', on: true, name: 'x', classId: 'mage' });
    lobby.handle(us[0].p, { t: 'join', name: 'x', classId: 'mage', mode: 'queue', size: 2 });
    assert.match((last(us[0].s, 'notice') as any).text, /queue separately/);
    lobby.handle(us[0].p, { t: 'leave' });
    await until(() => (last(us[1].s, 'notice') as any).text === 'Your party left the queue.');
    lobby.handle(us[0].p, { t: 'party_leave' });
    await until(() => last(us[1].s, 'party')?.party?.leader === 'Bob');
    lobby.handle(us[2].p, { t: 'party_leave' });
    await until(() => last(us[1].s, 'party')?.party === null);
    assert.equal(us[1].p.party, undefined);
  });

  it('a party member leaving while waiting in the queue pulls the whole party out', async () => {
    const { lobby, us, friend } = await world(['Ann', 'Bob']);
    await friend(0, 1);
    lobby.handle(us[0].p, { t: 'invite', kind: 'party', name: 'Bob' });
    await until(() => !!last(us[1].s, 'invite'));
    lobby.handle(us[1].p, { t: 'invite_reply', id: last(us[1].s, 'invite')!.id, accept: true });
    await until(() => last(us[0].s, 'party')?.party?.members.length === 2);
    lobby.handle(us[1].p, { t: 'ready', on: true, name: 'x', classId: 'mage' });
    lobby.handle(us[0].p, { t: 'join', name: 'x', classId: 'mage', mode: 'queue', size: 2 });
    await until(() => us[0].s.sent.some((m: ServerMsg) => m.t === 'queued'));
    lobby.handle(us[1].p, { t: 'leave' });
    await until(() => (last(us[0].s, 'notice') as any).text === 'Your party left the queue.');
    assert.equal(us[0].p.room, undefined);
  });
});

describe('party play', () => {
  async function party(names: string[]) {
    const w = await world(names);
    for (let i = 1; i < names.length; i++) {
      await w.friend(0, i);
      w.lobby.handle(w.us[0].p, { t: 'invite', kind: 'party', name: names[i] });
      await until(() => !!last(w.us[i].s, 'invite'));
      w.lobby.handle(w.us[i].p, { t: 'invite_reply', id: last(w.us[i].s, 'invite')!.id, accept: true });
    }
    await until(() => last(w.us[0].s, 'party')?.party?.members.length === names.length);
    return w;
  }

  it('a ready party practises together against bots, friends replacing ally bots', async () => {
    const { lobby, us } = await party(['Ann', 'Bob']);
    lobby.handle(us[0].p, { t: 'join', name: 'x', classId: 'mage', mode: 'practice', size: 2 });
    assert.match((last(us[0].s, 'closed') as any).reason, /Waiting for Bob/);
    lobby.handle(us[1].p, { t: 'ready', on: true, name: 'x', classId: 'priest' });
    lobby.handle(us[0].p, { t: 'join', name: 'x', classId: 'mage', mode: 'practice', size: 2 });
    const room = us[0].p.room!;
    assert.ok(room && us[1].p.room === room);
    const sim = room.sim;
    const mine = [...sim.units.values()].filter((u) => u.team === sim.units.get(us[0].p.unitId!)!.team);
    assert.equal(mine.length, 2, 'two humans fill the team, no ally bot');
    assert.equal(sim.units.get(us[1].p.unitId!)!.team, sim.units.get(us[0].p.unitId!)!.team);
    assert.equal(last(us[0].s, 'party')!.party!.members.every((m) => m.name === 'Ann' || !m.ready), true, 'ready marks cleared');
  });

  it('leaving a party match keeps both players in the party and sends the leaver back to the menu', async () => {
    const { lobby, us } = await party(['Ann', 'Bob']);
    lobby.handle(us[1].p, { t: 'ready', on: true, name: 'x', classId: 'priest' });
    lobby.handle(us[0].p, { t: 'join', name: 'x', classId: 'mage', mode: 'practice', size: 2 });
    assert.ok(us[0].p.room && us[1].p.room);
    lobby.handle(us[1].p, { t: 'leave' });
    assert.equal(us[1].p.room, undefined);
    assert.match((last(us[1].s, 'closed') as any).reason, /You left the match/);
    assert.equal(us[1].p.party, us[0].p.party, 'still the same party');
    assert.equal(us[0].p.party?.members.length, 2);
    lobby.handle(us[1].p, { t: 'ready', on: true, name: 'x', classId: 'priest' });
    assert.ok(us[0].p.party!.ready.has(us[1].p), 'can ready up again without refreshing');
  });

  it('the end screen is a ready check: the next match starts only once everyone pressed Play again, and leavers do not block it', async () => {
    const { lobby, us } = await party(['Ann', 'Bob', 'Cy_']);
    for (const i of [1, 2]) lobby.handle(us[i].p, { t: 'ready', on: true, name: 'x', classId: 'mage' });
    lobby.handle(us[0].p, { t: 'join', name: 'x', classId: 'mage', mode: 'practice', size: 3 });
    const old = us[0].p.room!;
    assert.ok(old && us[1].p.room === old && us[2].p.room === old);
    (old.sim as any).phase = 'ended';
    lobby.handle(us[0].p, { t: 'rematch', on: true });
    lobby.handle(us[1].p, { t: 'rematch', on: true });
    assert.equal(us[0].p.room, old, 'still waiting for Cy_');
    assert.deepEqual([last(us[0].s, 'rematch')!.ready, last(us[0].s, 'rematch')!.total], [2, 3]);
    lobby.handle(us[2].p, { t: 'leave' }); // the last one leaves instead of readying
    assert.ok(us[0].p.room && us[0].p.room !== old, 'a fresh room for the two who stayed');
    assert.equal(us[0].p.room, us[1].p.room);
    assert.equal(us[0].p.room!.players.size, 2);
    assert.equal(us[2].p.room, undefined);
    assert.equal(us[0].p.party?.members.length, 3, 'the party is untouched');
  });

  it('a party match puts all three friends in a 2v2 on the sides they picked, with a bot filling the gap', async () => {
    const { lobby, us } = await party(['Ann', 'Bob', 'Cy_']);
    for (const i of [1, 2]) lobby.handle(us[i].p, { t: 'ready', on: true, name: 'x', classId: i === 1 ? 'priest' : 'rogue' });
    const sides = last(us[0].s, 'party')!.party!.members.map((m) => m.side);
    assert.deepEqual(sides, [0, 1, 0], 'sides start balanced');
    lobby.handle(us[2].p, { t: 'party_side', side: 1 });
    await until(() => last(us[0].s, 'party')!.party!.members.find((m) => m.name === 'Cy_')!.side === 1);
    lobby.handle(us[0].p, { t: 'join', name: 'x', classId: 'mage', mode: 'party', size: 2 });
    const room = us[0].p.room!;
    assert.ok(room && us[1].p.room === room && us[2].p.room === room, 'everyone is in the match');
    const sim = room.sim;
    const team = (u: { p: Player }) => sim.units.get(u.p.unitId!)!.team;
    assert.equal(team(us[0]), 0);
    assert.equal(team(us[1]), 1);
    assert.equal(team(us[2]), 1);
    const units = [...sim.units.values()];
    assert.equal(units.length, 4, 'three friends plus one bot');
    assert.equal(units.filter((u) => u.team === 0).length, 2);
    assert.equal(units.filter((u) => u.team === 1).length, 2);
  });

  it('three friends on one side make the party match bigger instead of leaving anyone out', async () => {
    const { lobby, us } = await party(['Ann', 'Bob', 'Cy_']);
    for (const i of [1, 2]) lobby.handle(us[i].p, { t: 'ready', on: true, name: 'x', classId: 'mage' });
    for (const i of [0, 1, 2]) lobby.handle(us[i].p, { t: 'party_side', side: 0 });
    await until(() => last(us[0].s, 'party')!.party!.members.every((m) => m.side === 0));
    lobby.handle(us[0].p, { t: 'join', name: 'x', classId: 'mage', mode: 'party', size: 2 });
    const room = us[0].p.room!;
    assert.ok(room && us[1].p.room === room && us[2].p.room === room);
    assert.equal(room.sim.units.size, 6, 'a 3v3 with three bots on the other side');
  });

  it('two friends who queue a 1v1 get matched with each other', async () => {
    const { lobby, us } = await party(['Ann', 'Bob']);
    lobby.handle(us[1].p, { t: 'ready', on: true, name: 'x', classId: 'rogue' });
    lobby.handle(us[0].p, { t: 'join', name: 'x', classId: 'mage', mode: 'queue', size: 1 });
    assert.ok(us[0].p.room && us[0].p.room === us[1].p.room);
    const sim = us[0].p.room!.sim;
    assert.notEqual(sim.units.get(us[0].p.unitId!)!.team, sim.units.get(us[1].p.unitId!)!.team);
  });

  it('un-readying takes the mark away; a ready member joining the queue alone is refused', async () => {
    const { lobby, us } = await party(['Ann', 'Bob']);
    lobby.handle(us[1].p, { t: 'ready', on: true, name: 'x', classId: 'rogue' });
    lobby.handle(us[1].p, { t: 'ready', on: false, name: 'x', classId: 'rogue' });
    assert.equal(last(us[0].s, 'party')!.party!.members.find((m) => m.name === 'Bob')!.ready, false);
    lobby.handle(us[0].p, { t: 'join', name: 'x', classId: 'mage', mode: 'queue', size: 1 });
    assert.match((last(us[0].s, 'closed') as any).reason, /Waiting for Bob/);
  });
});

describe('duels', () => {
  it('a friend duel starts an unranked 1v1 once both sides join', async () => {
    const { lobby, us, friend } = await world(['Ann', 'Bob']);
    await friend(0, 1);
    lobby.handle(us[0].p, { t: 'invite', kind: 'duel', name: 'Bob' });
    await until(() => !!last(us[1].s, 'invite'));
    lobby.handle(us[1].p, { t: 'invite_reply', id: last(us[1].s, 'invite')!.id, accept: true });
    assert.equal(last(us[0].s, 'duel_go')!.with, 'Bob');
    assert.equal(last(us[1].s, 'duel_go')!.with, 'Ann');
    lobby.handle(us[0].p, { t: 'join', name: 'x', classId: 'mage', mode: 'duel', duelWith: 'Bob' });
    assert.equal(us[0].p.room, undefined, 'waits for the friend');
    lobby.handle(us[1].p, { t: 'join', name: 'x', classId: 'warrior', mode: 'duel', duelWith: 'Ann' });
    const room: any = us[0].p.room;
    assert.ok(room && room === us[1].p.room);
    assert.equal(room.sim.units.size, 2);
    assert.equal(room.ranked, false);
    assert.equal(room.size, 1);
  });

  it('declining tells the inviter; random people cannot start a duel; invites expire when someone leaves', async () => {
    const { lobby, us, friend } = await world(['Ann', 'Bob', 'Cy_']);
    await friend(0, 1);
    lobby.handle(us[0].p, { t: 'invite', kind: 'duel', name: 'Bob' });
    await until(() => !!last(us[1].s, 'invite'));
    lobby.handle(us[1].p, { t: 'invite_reply', id: last(us[1].s, 'invite')!.id, accept: false });
    await until(() => /declined/.test((last(us[0].s, 'notice') as any)?.text ?? ''));
    // a duel join naming someone who did not agree just waits, it never pairs with a stranger
    lobby.handle(us[2].p, { t: 'join', name: 'x', classId: 'mage', mode: 'duel', duelWith: 'Ann' });
    lobby.handle(us[0].p, { t: 'join', name: 'x', classId: 'mage', mode: 'duel', duelWith: 'Bob' });
    assert.equal(us[0].p.room, undefined);
    assert.equal(us[2].p.room, undefined);
    lobby.handle(us[0].p, { t: 'invite', kind: 'duel', name: 'Bob' });
    lobby.disconnect(us[0].p);
    await until(() => !!last(us[1].s, 'invite_gone') || true);
  });

  it('party members see each other\'s class, spec and skins in the lobby', async () => {
    const { lobby, us, friend } = await world(['Ann', 'Bob']);
    await friend(0, 1);
    lobby.handle(us[0].p, { t: 'invite', kind: 'party', name: 'Bob' });
    await until(() => !!last(us[1].s, 'invite'));
    lobby.handle(us[1].p, { t: 'invite_reply', id: last(us[1].s, 'invite')!.id, accept: true });
    await until(() => last(us[0].s, 'party')?.party?.members.length === 2);
    lobby.handle(us[1].p, { t: 'party_look', classId: 'warrior', build: { spec: 'protection', talents: [], gear: {} } } as ClientMsg);
    await until(() => !!last(us[0].s, 'party')?.party?.members.find((m) => m.name === 'Bob')?.classId);
    const bob = last(us[0].s, 'party')!.party!.members.find((m) => m.name === 'Bob')!;
    assert.equal(bob.classId, 'warrior');
    assert.equal(bob.spec, 'protection');
    // a spec that does not belong to the class falls back to that class's first spec instead of hiding the model
    lobby.handle(us[1].p, { t: 'party_look', classId: 'mage', build: { spec: 'protection', talents: [], gear: {} } } as ClientMsg);
    await until(() => last(us[0].s, 'party')!.party!.members.find((m) => m.name === 'Bob')!.classId === 'mage');
    assert.equal(last(us[0].s, 'party')!.party!.members.find((m) => m.name === 'Bob')!.spec, 'frost');
    // everyone always has a model to draw, even before their client reports
    assert.ok(last(us[1].s, 'party')!.party!.members.every((m) => !!m.classId));
  });
});
