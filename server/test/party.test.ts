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

type U = { name: string; s: any; p: Player };

/** A lobby with named, friended players; the first is the party leader. */
async function party(names: string[], join = names.length) {
  const accounts = new Accounts(new MemoryStore());
  const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 }, accounts);
  const us: U[] = [];
  for (const name of names) {
    const s = sock();
    const p = lobby.connect(s, `ip-${name}`);
    lobby.handle(p, { t: 'register', name, password: 'password1' } as ClientMsg);
    await until(() => s.sent.some((m: ServerMsg) => m.t === 'account'));
    us.push({ name, s, p });
  }
  const invite = async (i: number) => {
    lobby.handle(us[0].p, { t: 'friend', op: 'add', name: us[i].name });
    await until(() => (last(us[i].s, 'friends')?.requests ?? []).includes(us[0].name));
    lobby.handle(us[i].p, { t: 'friend', op: 'accept', name: us[0].name });
    await until(() => (last(us[0].s, 'friends')?.friends ?? []).some((f) => f.name === us[i].name));
    const before = us[i].s.sent.filter((m: ServerMsg) => m.t === 'invite').length;
    lobby.handle(us[0].p, { t: 'invite', kind: 'party', name: us[i].name });
    await until(() => us[i].s.sent.filter((m: ServerMsg) => m.t === 'invite').length > before);
    lobby.handle(us[i].p, { t: 'invite_reply', id: last(us[i].s, 'invite')!.id, accept: true });
  };
  for (let i = 1; i < join; i++) await invite(i);
  if (join > 1) await until(() => last(us[0].s, 'party')?.party?.members.length === join);
  const info = (u = us[0]) => last(u.s, 'party')!.party!;
  const ready = (u: U, on = true) => lobby.handle(u.p, { t: 'ready', on, name: 'x', classId: 'mage' });
  const start = (mode: 'queue' | 'practice' | 'party', size: 1 | 2 | 3 = 2) => lobby.handle(us[0].p, { t: 'join', name: 'x', classId: 'mage', mode, size });
  const readyOf = (n: string) => info().members.find((m) => m.name === n)!.ready;
  return { lobby, us, info, ready, start, readyOf, invite, accounts };
}

describe('party sides', () => {
  it('members join the leader team until it is full, then the other team', async () => {
    const w = await party(['Ann', 'Bob', 'Cy_', 'Dee', 'Eve', 'Fay']);
    const sides = w.info().members.map((m) => [m.name, m.side]);
    assert.deepEqual(sides, [['Ann', 0], ['Bob', 0], ['Cy_', 0], ['Dee', 1], ['Eve', 1], ['Fay', 1]]);
  });

  it('a leader who moved to team 2 keeps the new members with them', async () => {
    const w = await party(['Ann', 'Bob', 'Cy_', 'Dee'], 2);
    w.lobby.handle(w.us[0].p, { t: 'party_side', side: 1 });
    assert.equal(w.info().members[0].side, 1);
    await w.invite(2);
    await w.invite(3);
    await until(() => w.info().members.length === 4);
    assert.deepEqual(w.info().members.map((m) => m.side), [1, 0, 1, 1], 'Bob stays where he was; later joiners follow the leader');
  });

  it('a side that is full sends the next member to the other one, and a manual switch respects the cap', async () => {
    const w = await party(['Ann', 'Bob', 'Cy_', 'Dee', 'Eve']);
    assert.deepEqual(w.info().members.map((m) => m.side), [0, 0, 0, 1, 1]);
    w.lobby.handle(w.us[3].p, { t: 'party_side', side: 0 });
    assert.match((last(w.us[3].s, 'notice') as any).text, /already has 3/);
    assert.equal(w.info().members[3].side, 1);
  });
});

describe('party ready check', () => {
  it('the leader cannot start until every member is ready and is told who is missing', async () => {
    const w = await party(['Ann', 'Bob', 'Cy_', 'Dee']);
    w.ready(w.us[1]);
    w.start('practice');
    assert.equal(w.us[0].p.room, undefined);
    assert.match((last(w.us[0].s, 'closed') as any).reason, /^Waiting for Cy_, Dee to ready up \(2\/4\)\.$/);
    w.ready(w.us[2]);
    w.start('queue');
    assert.match((last(w.us[0].s, 'closed') as any).reason, /Waiting for Dee to ready up \(3\/4\)/);
    assert.ok(!w.us.some((u) => u.s.sent.some((m: ServerMsg) => m.t === 'queued')), 'nothing was queued');
    w.ready(w.us[3]);
    w.start('party', 3);
    assert.ok(w.us.every((u) => u.p.room === w.us[0].p.room && u.p.room), 'then everyone starts together');
  });

  it('the leader is ready only as a derived value and cannot toggle', async () => {
    const w = await party(['Ann', 'Bob']);
    w.ready(w.us[0], false);
    assert.equal(w.readyOf('Ann'), true);
    assert.equal(w.us[0].p.party!.ready.has(w.us[0].p), false);
  });

  it('un-readying before the leader starts stops the start; double presses do not toggle', async () => {
    const w = await party(['Ann', 'Bob']);
    w.ready(w.us[1]);
    w.ready(w.us[1]);
    assert.equal(w.readyOf('Bob'), true);
    w.ready(w.us[1], false);
    w.start('queue');
    assert.equal(w.us[0].p.room, undefined);
    assert.ok(!w.us[0].s.sent.some((m: ServerMsg) => m.t === 'queued'));
    assert.match((last(w.us[0].s, 'closed') as any).reason, /Waiting for Bob/);
  });

  it('a double press of the leader start does not queue the party twice', async () => {
    const w = await party(['Ann', 'Bob']);
    w.ready(w.us[1]);
    w.start('queue');
    w.start('queue');
    const q = (w.lobby as any).queue as any[];
    assert.equal(q.length, 1);
    assert.equal(q[0].members.length, 2);
  });

  it('a member who goes to the queue or a match is not counted as ready (regression: ghost ready)', async () => {
    const w = await party(['Ann', 'Bob']);
    w.ready(w.us[1]);
    w.start('queue');
    // the mark was spent by the queue entry; pressing Ready now is refused AND the client is told the truth
    const before = w.us[1].s.sent.filter((m: ServerMsg) => m.t === 'party').length;
    w.ready(w.us[1]);
    assert.ok(w.us[1].s.sent.filter((m: ServerMsg) => m.t === 'party').length > before, 'the party is sent again so the button resyncs');
    assert.equal(w.readyOf('Bob'), false);
    assert.match((last(w.us[1].s, 'notice') as any).text, /queue/);
  });

  it('a member who started watching after readying blocks the start', async () => {
    const w = await party(['Ann', 'Bob']);
    w.ready(w.us[1]);
    w.us[1].p.watching = {} as any;
    w.start('practice');
    assert.equal(w.us[0].p.room, undefined);
    assert.match((last(w.us[0].s, 'closed') as any).reason, /Waiting for Bob/);
    w.us[1].p.watching = undefined;
  });

  it('ready marks are cleared when the queue is cancelled, a match starts, someone joins, leaves or is removed', async () => {
    const w = await party(['Ann', 'Bob', 'Cy_', 'Dee'], 3);
    w.ready(w.us[1]);
    w.ready(w.us[2]);
    w.start('queue', 3);
    await until(() => w.us[0].s.sent.some((m: ServerMsg) => m.t === 'queued'));
    assert.equal(w.readyOf('Bob'), false, 'spent by the queue');
    w.ready(w.us[1]);
    w.ready(w.us[2]);
    assert.equal(w.readyOf('Bob'), false, 'cannot ready while queued');
    w.lobby.handle(w.us[0].p, { t: 'leave' }); // cancel the queue
    assert.equal(w.info().members.every((m) => m.name === 'Ann' || !m.ready), true);
    assert.equal((w.lobby as any).queue.length, 0);

    w.ready(w.us[1]);
    await w.invite(3);
    await until(() => w.info().members.length === 4);
    assert.equal(w.readyOf('Bob'), false, 'a new member restarts the check');

    w.ready(w.us[1]);
    w.lobby.handle(w.us[0].p, { t: 'party_kick', name: 'Dee' });
    assert.equal(w.readyOf('Bob'), false, 'a removed member restarts the check');
    assert.equal(w.us[3].p.party, undefined);
    assert.equal(last(w.us[3].s, 'party')!.party, null);

    w.ready(w.us[1]);
    w.lobby.handle(w.us[2].p, { t: 'party_leave' });
    assert.equal(w.readyOf('Bob'), false, 'a leaver restarts the check');
  });

  it('the match start spends the marks, and nobody is ready again when they come back', async () => {
    const w = await party(['Ann', 'Bob']);
    w.ready(w.us[1]);
    w.start('practice');
    assert.ok(w.us[1].p.room);
    assert.equal(w.readyOf('Bob'), false);
    w.lobby.handle(w.us[1].p, { t: 'leave' });
    w.lobby.handle(w.us[0].p, { t: 'leave' });
    assert.equal(w.readyOf('Bob'), false);
    w.start('practice');
    assert.equal(w.us[0].p.room, undefined, 'a second start needs a fresh ready');
  });

  it('a member disconnecting while the party is queued cancels the queue cleanly and the party survives', async () => {
    const w = await party(['Ann', 'Bob', 'Cy_']);
    w.ready(w.us[1]);
    w.ready(w.us[2]);
    w.start('queue', 3);
    await until(() => w.us[0].s.sent.some((m: ServerMsg) => m.t === 'queued'));
    w.lobby.disconnect(w.us[2].p);
    assert.equal((w.lobby as any).queue.length, 0, 'no ghost queue entry');
    assert.match((last(w.us[0].s, 'notice') as any).text, /left the queue/);
    assert.equal(w.info().members.length, 2);
    assert.equal(w.readyOf('Bob'), false);
  });

  it('the leader leaving hands the party on instead of ending it', async () => {
    const w = await party(['Ann', 'Bob', 'Cy_']);
    w.lobby.handle(w.us[0].p, { t: 'party_leave' });
    assert.equal(w.info(w.us[1]).leader, 'Bob');
    assert.match((last(w.us[1].s, 'notice') as any).text, /party leader now/);
    assert.equal(w.us[0].p.party, undefined);
  });
});

describe('party invites', () => {
  it('say why an invite cannot go out', async () => {
    const w = await party(['Ann', 'Bob', 'Cy_', 'Dee'], 2);
    // Cy_ already sits in another party (Dee leads it)
    const accounts = w.accounts;
    void accounts;
    await w.invite(2);
    w.lobby.handle(w.us[0].p, { t: 'invite', kind: 'party', name: 'Bob' });
    assert.match((last(w.us[0].s, 'notice') as any).text, /already in your party/);
    // a friend in the queue is named as such
    w.lobby.handle(w.us[3].p, { t: 'friend', op: 'add', name: 'Ann' });
    await until(() => (last(w.us[0].s, 'friends')?.requests ?? []).includes('Dee'));
    w.lobby.handle(w.us[0].p, { t: 'friend', op: 'accept', name: 'Dee' });
    await until(() => (last(w.us[0].s, 'friends')?.friends ?? []).some((f) => f.name === 'Dee'));
    w.lobby.handle(w.us[3].p, { t: 'join', name: 'x', classId: 'mage', mode: 'queue', size: 2 });
    w.lobby.handle(w.us[0].p, { t: 'invite', kind: 'party', name: 'Dee' });
    assert.match((last(w.us[0].s, 'notice') as any).text, /Dee is in the queue/);
  });
});
