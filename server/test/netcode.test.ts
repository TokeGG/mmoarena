import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SnapMerger, TUNING, parseClientMsg } from '@arena/shared';
import type { ClientMsg, ServerMsg } from '@arena/shared';
import { Lobby } from '../src/rooms';
import { startTickLoop } from '../src/index';

function fake(lobby: Lobby, name = 'Ann') {
  const out: ServerMsg[] = [];
  const p = { ws: { readyState: 1, send: (s: string) => out.push(JSON.parse(s)), bufferedAmount: 0 }, name, classId: 'mage', matches: 0, wins: 0, size: 1, ip: '1.1.1.1', mapPref: 'random' } as any;
  (lobby as any).conns.add(p);
  return { p, out };
}

describe('ping and pong', () => {
  it('the server validates and echoes a ping at once, in the menu and in a match', () => {
    assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'ping', n: 12345.5 })), { t: 'ping', n: 12345.5 });
    assert.equal(parseClientMsg(JSON.stringify({ t: 'ping' })), null);
    assert.equal(parseClientMsg(JSON.stringify({ t: 'ping', n: 'x' })), null);
    assert.equal(parseClientMsg(JSON.stringify({ t: 'ping', n: 1e300 })), null);
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 });
    const { p, out } = fake(lobby);
    lobby.handle(p, { t: 'ping', n: 7 });
    assert.deepEqual(out.at(-1), { t: 'pong', n: 7 });
    lobby.handle(p, { t: 'join', name: 'Ann', classId: 'mage', mode: 'practice', difficulty: 'dummy', size: 1 } as ClientMsg);
    lobby.handle(p, { t: 'ping', n: 8 });
    assert.deepEqual(out.at(-1), { t: 'pong', n: 8 });
    assert.ok(lobby.tickCost.avgMs >= 0);
  });
});

describe('input catch-up through the lobby', () => {
  it('a late burst of inputs is worked off by the room ticks (distances are checked in the sim tests)', () => {
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 });
    const { p } = fake(lobby);
    lobby.handle(p, { t: 'join', name: 'Ann', classId: 'mage', mode: 'practice', difficulty: 'dummy', size: 1 } as ClientMsg);
    const room = p.room;
    const u = room.sim.units.get(p.unitId);
    for (let i = 0; i < 8; i++) lobby.tick(); // let the room settle (prep is 0)
    u.pos = { x: 0, z: 0 };
    const start = { ...u.pos };
    let seq = 0;
    let ticks = 0;
    // 3 ticks of normal play, 10 of silence, then a burst of 5 and one per tick again
    for (let i = 0; i < 3; i++) { lobby.handle(p, { t: 'input', seq: ++seq, fwd: 1, strafe: 0, facing: 0 }); lobby.tick(); ticks++; }
    for (let i = 0; i < 10; i++) { lobby.tick(); ticks++; }
    for (let i = 0; i < 5; i++) lobby.handle(p, { t: 'input', seq: ++seq, fwd: 1, strafe: 0, facing: 0 });
    for (let i = 0; i < 6; i++) { lobby.tick(); ticks++; lobby.handle(p, { t: 'input', seq: ++seq, fwd: 1, strafe: 0, facing: 0 }); }
    assert.ok(u.inputQueue.length <= 2, `queue ${u.inputQueue.length}`);
    assert.ok(u.lastSeq >= seq - 2, 'the client is acknowledged up to its last inputs');
    assert.ok(ticks > 0 && start.x === 0 && TUNING.runSpeed > 0);
  });
});

describe('startTickLoop', () => {
  it('plays a fixed step per elapsed step, at most 3 per callback, and drops a longer backlog', async () => {
    let t = 0;
    let n = 0;
    const loop = startTickLoop(() => n++, 50, 3, () => t);
    t = 49;
    assert.equal(loop.step(), 0);
    t = 50;
    assert.equal(loop.step(), 1);
    t = 200; // 150 ms late: exactly 3 ticks
    assert.equal(loop.step(), 3);
    t = 1200; // a full second: 3 ticks, the rest is dropped
    assert.equal(loop.step(), 3);
    t = 1249;
    assert.equal(loop.step(), 0, 'backlog was dropped, not owed');
    t = 1250;
    assert.equal(loop.step(), 1);
    loop.stop();
    assert.equal(n, 8);
  });
});

describe('lighter snapshots through the lobby', () => {
  it('the first frame carries every identity, later frames only state, and the client rebuilds full units', () => {
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 });
    const { p, out } = fake(lobby);
    lobby.handle(p, { t: 'join', name: 'Ann', classId: 'mage', mode: 'practice', difficulty: 'dummy', size: 2 } as ClientMsg);
    for (let i = 0; i < 6; i++) lobby.tick();
    const frames = out.filter((m) => m.t === 'snapshot') as Extract<ServerMsg, { t: 'snapshot' }>[];
    assert.ok(frames.length >= 5);
    assert.equal(frames[0].info?.length, frames[0].snap.units.length, 'identity of everyone in the first frame');
    for (const f of frames.slice(1)) {
      assert.equal(f.info, undefined);
      assert.ok(f.snap.units.every((u) => !('name' in u)), 'no identity per tick');
    }
    const merger = new SnapMerger();
    const merged = frames.map((f) => merger.merge(f.snap, f.info));
    assert.ok(merged.every((s) => s.units.length === frames[0].snap.units.length && s.units.every((u) => typeof u.name === 'string' && u.classId)));
    assert.ok(merged.at(-1)!.units.some((u) => u.name === 'Ann'));
  });
});
