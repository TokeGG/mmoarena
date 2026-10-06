import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { Accounts } from '../src/accounts';
import { MemoryStore } from '../src/store';
import { Lobby } from '../src/rooms';
import { ReplayRunner, contentHash } from '@arena/shared';
import type { ClientMsg, ReplayData, ServerMsg } from '@arena/shared';

const sock = () => {
  const sent: ServerMsg[] = [];
  return { readyState: 1, sent, send(d: string) { sent.push(JSON.parse(d)); } } as any;
};
const until = async (cond: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(await cond(), 'timed out');
};

describe('history, replays and spectating', () => {
  it('a ranked 1v1 is recorded for both players, replays exactly, and can be watched 5 s late', async () => {
    const accounts = new Accounts(new MemoryStore());
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 }, accounts);
    const names = ['Ann', 'Bob'];
    const socks = names.map(() => sock());
    const players = socks.map((s) => lobby.connect(s, '7.7.7.7'));
    for (let i = 0; i < 2; i++) {
      lobby.handle(players[i], { t: 'register', name: names[i], password: 'password1' } as ClientMsg);
      await until(() => socks[i].sent.some((m: ServerMsg) => m.t === 'account'));
    }
    lobby.handle(players[0], { t: 'join', name: 'x', classId: 'mage', mode: 'queue', size: 1 });
    lobby.handle(players[1], { t: 'join', name: 'x', classId: 'warrior', mode: 'queue', size: 1 });
    const room: any = players[0].room;
    assert.ok(room);

    // a spectator can see the match listed, and gets frames only after the delay
    const ss = sock();
    const spec = lobby.connect(ss, '9.9.9.9');
    lobby.handle(spec, { t: 'live' });
    const live = ss.sent.find((m: ServerMsg) => m.t === 'live') as any;
    assert.equal(live.rows.length, 1);
    assert.equal(live.rows[0].size, 1);
    lobby.handle(spec, { t: 'spectate', id: live.rows[0].id });
    assert.ok(ss.sent.some((m: ServerMsg) => m.t === 'spectating'));
    for (let i = 0; i < 99; i++) lobby.tick();
    assert.equal(ss.sent.filter((m: ServerMsg) => m.t === 'snapshot').length, 0, 'nothing before the delay');
    for (let i = 0; i < 5; i++) lobby.tick();
    const frames = ss.sent.filter((m: ServerMsg) => m.t === 'snapshot') as any[];
    assert.ok(frames.length >= 1);
    assert.equal(frames[0].snap.units.length, 2, 'spectators see everyone');

    // some play, then one team wins
    const [u0, u1] = [players[0].unitId!, players[1].unitId!];
    for (let i = 0; i < 60; i++) {
      room.sim.queueInput(u0, { seq: i, fwd: 1, strafe: 0, facing: 0.5 + i / 100 });
      lobby.tick();
    }
    room.sim.useAbility(u0, 'fireball', u1);
    for (let i = 0; i < 40; i++) lobby.tick();
    room.sim.forfeit(u1);
    for (let i = 0; i < 3; i++) lobby.tick();
    assert.equal(room.sim.phase, 'ended');

    await until(async () => (await accounts.history('ann')).length === 1 && (await accounts.history('bob')).length === 1);
    const rec = (await accounts.history('ann'))[0];
    assert.equal(rec.size, 1);
    assert.equal(rec.ranked, true);
    assert.equal(rec.replay, true);
    assert.equal(rec.winner, room.sim.units.get(u0).team);
    assert.deepEqual(rec.players.map((p) => p.name).sort(), ['Ann', 'Bob']);
    const winnerRow = rec.players.find((p) => p.name === 'Ann')!;
    const loserRow = rec.players.find((p) => p.name === 'Bob')!;
    assert.ok(winnerRow.delta! > 0 && loserRow.delta! < 0);

    // history over the socket
    lobby.handle(players[0], { t: 'history' });
    await until(() => socks[0].sent.some((m: ServerMsg) => m.t === 'history'));
    assert.equal((socks[0].sent.find((m: ServerMsg) => m.t === 'history') as any).rows[0].id, rec.id);

    // the stored replay re-runs to the same end state
    const gz = await accounts.getReplay(rec.id);
    assert.ok(gz);
    const data = JSON.parse(zlib.gunzipSync(gz!).toString()) as ReplayData;
    assert.equal(data.hash, contentHash());
    const run = new ReplayRunner(data);
    run.seek(data.ticks);
    assert.equal(run.sim.winner, room.sim.winner);
    for (const [id, u] of room.sim.units) {
      const r = run.sim.units.get(id)!;
      assert.equal(r.health, u.health, `unit ${id} health`);
      assert.equal(r.alive, u.alive);
    }
    assert.equal(await accounts.getReplay('../../etc'), null);
  });

  it('bot practice is recorded for the signed-in player', async () => {
    const accounts = new Accounts(new MemoryStore());
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 }, accounts);
    const s = sock();
    const p = lobby.connect(s, '1.2.3.4');
    lobby.handle(p, { t: 'register', name: 'Solo', password: 'password1' } as ClientMsg);
    await until(() => s.sent.some((m: ServerMsg) => m.t === 'account'));
    lobby.handle(p, { t: 'join', name: 'x', classId: 'mage', mode: 'practice', size: 1, difficulty: 'normal' });
    const room: any = p.room;
    assert.ok(room);
    for (const u of room.sim.units.values()) if (u.controller !== 'player') room.sim.forfeit(u.id);
    for (let i = 0; i < 4; i++) lobby.tick();
    await until(async () => (await accounts.history('solo')).length === 1);
    const rec = (await accounts.history('solo'))[0];
    assert.equal(rec.ranked, false);
    assert.equal(rec.players.filter((x) => x.human).length, 1);
    assert.equal(rec.winner, 0);
  });
});
