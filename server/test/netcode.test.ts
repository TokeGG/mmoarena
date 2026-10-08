import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SnapMerger, TUNING, parseClientMsg } from '@arena/shared';
import type { ClientMsg, ServerMsg } from '@arena/shared';
import { Lobby } from '../src/rooms';
import { maxMsgsPerSec, parseTickMs, startTickLoop } from '../src/index';
import { TickMeter } from '../src/tickmeter';

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
    assert.deepEqual(out.at(-1), { t: 'pong', n: 7, load: 0 });
    lobby.handle(p, { t: 'join', name: 'Ann', classId: 'mage', mode: 'practice', difficulty: 'dummy', size: 1 } as ClientMsg);
    lobby.handle(p, { t: 'ping', n: 8 });
    assert.deepEqual(out.at(-1), { t: 'pong', n: 8, load: 0 });
    assert.ok(lobby.tickCost.avgMs >= 0);
  });
});

describe('input catch-up through the lobby', () => {
  it('a late burst of inputs is worked off by the room ticks (distances are checked in the sim tests)', () => {
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, tickMs: 50 });
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

describe('the loop and the settings at 16 ms', () => {
  it('a 16 ms loop plays one step per 16 ms, up to 150 ms of backlog (10 ticks) per callback, and drops the rest', () => {
    let t = 0;
    let n = 0;
    const loop = startTickLoop(() => n++, 16, undefined, () => t);
    t = 15;
    assert.equal(loop.step(), 0);
    t = 16;
    assert.equal(loop.step(), 1);
    t = 16 + 16 * 6 + 3; // 100 ms late: all six owed ticks at once
    assert.equal(loop.step(), 6);
    t += 1000;
    assert.equal(loop.step(), 10, 'a second behind: 10 ticks, the rest dropped');
    t += 15;
    assert.equal(loop.step(), 0, 'no backlog is owed');
    loop.stop();
  });

  it('ARENA_TICK_MS: whole numbers from 8 to 50, anything else falls back to 50 with a warning', () => {
    assert.deepEqual(parseTickMs(undefined, 50), { tickMs: 50 });
    assert.deepEqual(parseTickMs('', 50), { tickMs: 50 });
    assert.deepEqual(parseTickMs('16'), { tickMs: 16 });
    assert.deepEqual(parseTickMs('8'), { tickMs: 8 });
    for (const bad of ['7', '51', '16.5', 'fast', '-16', '0']) assert.ok(parseTickMs(bad, 50).warning, bad);
    assert.equal(parseTickMs('7', 50).tickMs, 50);
  });

  it('the socket limit allows a legitimate client at the tick rate (inputs plus actions) at every setting', () => {
    assert.equal(maxMsgsPerSec(50), 120);
    assert.ok(maxMsgsPerSec(16) >= 2 * 62.5 + 50);
    assert.ok(maxMsgsPerSec(8) >= 2 * 125 + 50);
  });

  it('a lobby at 16 ms tells its rooms, its clients and its status', () => {
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, tickMs: 16 });
    const { p, out } = fake(lobby);
    lobby.handle(p, { t: 'join', name: 'Ann', classId: 'mage', mode: 'practice', difficulty: 'dummy', size: 1 } as ClientMsg);
    assert.equal((out.find((m) => m.t === 'welcome') as any).tickMs, 16);
    assert.equal(p.room.sim.tickMs, 16);
    assert.equal(p.room.ticksIn(5000), 313, 'the spectator delay is five seconds');
    assert.equal(lobby.tickReport().ms, 16);
  });

  it('the tick meter reports load and late ticks, and warns once after ten busy seconds', () => {
    let now = 0;
    const m = new TickMeter(16, () => now);
    let warns = 0;
    // 12 s of ticks each costing 14 ms of a 16 ms step (load 0.875): the warning comes once, ten seconds in
    for (let k = 0; k < 12 * 62; k++) {
      now = k * 16;
      if (m.record(now, 14)) warns++;
    }
    const r = m.report();
    assert.equal(r.ms, 16);
    assert.ok(r.load > 0.85 && r.load < 0.9, `${r.load}`);
    assert.equal(r.late, 0);
    assert.equal(warns, 1);
    m.record(now + 16, 40); // one tick over its step
    m.record(now + 16 + 100, 1); // and one that started 100 ms after the last
    assert.equal(m.report().late, 2);
    assert.ok(m.report().worstMs >= 40);
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
