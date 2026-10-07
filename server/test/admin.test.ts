import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientMsg, ServerMsg } from '@arena/shared';
import { MemoryStore } from '../src/store';
import { Accounts } from '../src/accounts';
import { Lobby } from '../src/rooms';
import { AdminLog } from '../src/adminlog';
import { Suggestions } from '../src/suggestions';

const CODE = 'adm-code';
const tick = () => new Promise((r) => setTimeout(r, 20));
const mkP = (name: string, out: ServerMsg[], account: any) => {
  const ws = { readyState: 1, closed: false, send: (s: string) => out.push(JSON.parse(s)), close() { this.closed = true; }, bufferedAmount: 0 };
  return { ws, name, classId: 'mage', matches: 0, wins: 0, size: 1, ip: '9.9.9.9', mapPref: 'random', account, ownerOk: false } as any;
};
const last = <T extends ServerMsg['t']>(out: ServerMsg[], t: T) => [...out].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;

async function world() {
  const store = new MemoryStore();
  const a = new Accounts(store, CODE);
  const toke = (await a.register('Toke', 'hunter22', '1.1.1.1', CODE)) as any;
  const bob = (await a.register('Bob', 'hunter22', '2.2.2.2')) as any;
  const log = new AdminLog(store);
  const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 }, a, undefined, new Suggestions(store), undefined, log);
  const outO: ServerMsg[] = [];
  const outB: ServerMsg[] = [];
  const owner = mkP('Toke', outO, toke.account);
  const bobP = mkP('Bob', outB, bob.account);
  owner.ownerOk = true;
  for (const p of [owner, bobP]) (lobby as any).conns.add(p);
  return { a, lobby, owner, bobP, outO, outB, log, store };
}

describe('admin panel actions', () => {
  it('ban kicks the player and keeps them out (sign-in and saved sessions), unban lets them back', async () => {
    const { a, lobby, owner, bobP, outO, outB, log } = await world();
    const token = (await a.login('Bob', 'hunter22', '2.2.2.2') as any).token;
    lobby.handle(bobP, { t: 'admin_act', act: 'ban', name: 'Bob', minutes: 60, reason: 'cheating' } as ClientMsg);
    assert.ok(!(await a.adminModerate('Toke', 'ban', { by: 'x' })).ok, 'only the owner can, and never on the founder');
    lobby.handle(owner, { t: 'admin_act', act: 'ban', name: 'Bob', minutes: 60, reason: 'cheating' } as ClientMsg);
    await tick();
    assert.equal(bobP.ws.closed, true, 'disconnected');
    assert.match(last(outB, 'closed')!.reason, /banned until .*cheating/);
    const r = await a.login('Bob', 'hunter22', '2.2.2.2');
    assert.ok(!r.ok && /banned/.test(r.reason));
    const rs = await a.resume(token);
    assert.ok(!rs.ok && /banned/.test(rs.reason), 'a saved session says why');
    assert.ok(last(outO, 'admin_result')?.row?.banned);
    lobby.handle(owner, { t: 'admin_act', act: 'unban', name: 'Bob' } as ClientMsg);
    await tick();
    assert.ok((await a.login('Bob', 'hunter22', '2.2.2.2')).ok);
    const rows = await log.list();
    assert.deepEqual(rows.map((x) => x.action), ['unban', 'ban']);
    assert.equal(rows[1].detail, '60 min: cheating');
  });

  it('mute stops suggestions, invites and friend requests', async () => {
    const { lobby, owner, bobP, outB } = await world();
    lobby.handle(owner, { t: 'admin_act', act: 'mute', name: 'Bob', minutes: 0 } as ClientMsg);
    await tick();
    assert.ok(outB.some((m) => m.t === 'notice' && /muted/.test(m.text)));
    lobby.handle(bobP, { t: 'suggest', text: 'please buff mages' } as ClientMsg);
    assert.match(last(outB, 'suggest_ack')!.reason ?? '', /muted/);
    lobby.handle(bobP, { t: 'invite', kind: 'party', name: 'Toke' } as ClientMsg);
    assert.ok(outB.some((m) => m.t === 'notice' && /no invites/.test(m.text)));
  });

  it('rating, stats, notes and the match history', async () => {
    const { a, lobby, owner, outO } = await world();
    lobby.handle(owner, { t: 'admin_act', act: 'set_rating', name: 'Bob', value: 1750 } as ClientMsg);
    await tick();
    assert.equal((await a.get('Bob'))!.rating, 1750);
    lobby.handle(owner, { t: 'admin_act', act: 'note', name: 'Bob', text: 'watch for smurfing' } as ClientMsg);
    await tick();
    assert.equal(last(outO, 'admin_result')?.row?.note, 'watch for smurfing');
    lobby.handle(owner, { t: 'admin_act', act: 'reset_stats', name: 'Bob' } as ClientMsg);
    await tick();
    const b = (await a.get('Bob'))!;
    assert.equal(b.rating, 1000);
    assert.equal(b.matches, 0);
    lobby.handle(owner, { t: 'admin_act', act: 'history', name: 'Bob' } as ClientMsg);
    await tick();
    assert.deepEqual(last(outO, 'admin_history'), { t: 'admin_history', name: 'Bob', rows: [] });
  });

  it('maintenance mode stops new matches for everyone but the owner, and survives a restart', async () => {
    const { lobby, owner, bobP, outB, store, a } = await world();
    lobby.handle(owner, { t: 'admin_act', act: 'maintenance', on: true, text: 'Back in 10' } as ClientMsg);
    await tick();
    assert.ok(outB.some((m) => m.t === 'notice' && m.text.includes('Back in 10')));
    lobby.handle(bobP, { t: 'join', name: 'Bob', classId: 'mage', mode: 'practice', difficulty: 'normal', size: 1 } as ClientMsg);
    assert.equal(bobP.room, undefined);
    assert.equal(last(outB, 'closed')?.reason, 'Back in 10');
    lobby.handle(owner, { t: 'join', name: 'Toke', classId: 'mage', mode: 'practice', difficulty: 'normal', size: 1 } as ClientMsg);
    assert.ok(owner.room, 'the owner still can');
    const again = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 }, a, undefined, undefined, undefined, new AdminLog(store));
    await tick();
    assert.equal((again as any).maint, 'Back in 10');
  });

  it('the owner pauses any match from the panel; players are told', async () => {
    const { lobby, owner, bobP, outB, outO } = await world();
    lobby.handle(bobP, { t: 'join', name: 'Bob', classId: 'mage', mode: 'practice', difficulty: 'normal', size: 1 } as ClientMsg);
    const room = bobP.room;
    lobby.handle(bobP, { t: 'admin_act', act: 'pause_match', id: room.id, on: true } as ClientMsg);
    assert.equal(room.paused, false, 'players cannot');
    lobby.handle(owner, { t: 'admin_act', act: 'pause_match', id: room.id, on: true } as ClientMsg);
    await tick();
    assert.equal(room.paused, true);
    assert.ok(outB.some((m) => m.t === 'notice' && /paused/.test(m.text)));
    assert.equal(last(outO, 'admin_overview')?.rooms[0].paused, true);
  });
});
