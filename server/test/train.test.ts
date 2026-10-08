import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { ARENAS, ArenaSim, Bot, ReplayRecorder, botBuild, forcedStudy, parseClientMsg } from '@arena/shared';
import type { ReplayData } from '@arena/shared';
import { MemoryStore } from '../src/store';
import { BotLearner } from '../src/botlearn';
import { AdminLog } from '../src/adminlog';
import { Lobby } from '../src/rooms';

function botMatch(seed = 3): ReplayData {
  const arena = ARENAS[1];
  const sim = new ArenaSim({ seed, prepMs: 3000, arena });
  const rec = new ReplayRecorder(sim, { arena: arena.id, seed, prepMs: 3000 });
  const x = sim.addUnit({ name: 'Bot A', classId: 'warrior', team: 0, controller: 'bot', build: botBuild('warrior', seed) });
  const y = sim.addUnit({ name: 'Bot B', classId: 'priest', team: 1, controller: 'bot', build: botBuild('priest', seed + 9) });
  const drivers = [new Bot(sim, x.id, 'hard', 1), new Bot(sim, y.id, 'easy', 2)];
  for (let ms = 0; sim.phase !== 'ended' && ms < 150000; ms += 50) {
    for (const d of drivers) d.tick();
    sim.step();
    sim.drainEvents();
  }
  return rec.finish([]);
}

describe('owner trains the bots on a replay', () => {
  it('a bot match (gzipped or plain) is learned from, kept for study and logged; junk and old versions are refused', async () => {
    const store = new MemoryStore();
    const learner = new BotLearner(store, () => 0.5);
    const log = new AdminLog(store);
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 }, undefined, learner, undefined, undefined, log);
    const replay = botMatch();
    const gz = zlib.gzipSync(JSON.stringify(replay));
    const r = await lobby.trainOnReplay('Toke', gz, 'abcdef123456');
    assert.equal(r.ok, true, r.text);
    const index = await learner.archived();
    assert.equal(index[0]?.id, 'abcdef123456', 'kept for offline study');
    assert.equal(index[0]?.forced, true);
    const plain = await lobby.trainOnReplay('Toke', Buffer.from(JSON.stringify(replay)), 'up0000000001');
    assert.equal(plain.ok, true, plain.text);
    assert.equal((await lobby.trainOnReplay('Toke', Buffer.from('not a replay'), 'up0000000002')).ok, false);
    assert.equal((await lobby.trainOnReplay('Toke', Buffer.from(JSON.stringify({ ...replay, hash: 'old' })), 'up0000000003')).ok, false);
    assert.equal((await lobby.trainOnReplay('Toke', Buffer.from(JSON.stringify({ ...replay, winner: 'draw' })), 'up0000000004')).ok, false, 'a bot match nobody won teaches nothing');
    const rows = await log.list();
    assert.ok(rows.some((x) => x.action === 'train bots on replay' && x.target === 'abcdef123456'));
  });

  it('without bot learning on the server it says so', async () => {
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 });
    const r = await lobby.trainOnReplay('Toke', Buffer.from('{}'), 'x');
    assert.equal(r.ok, false);
  });
});

function playerMatch(seed = 4): ReplayData {
  const arena = ARENAS[1];
  const sim = new ArenaSim({ seed, prepMs: 3000, arena });
  const rec = new ReplayRecorder(sim, { arena: arena.id, seed, prepMs: 3000 });
  // two "people" (player-controlled units steered by bots so the match plays out)
  const x = sim.addUnit({ name: 'Ann', classId: 'rogue', team: 0, controller: 'player', build: botBuild('rogue', seed) });
  const y = sim.addUnit({ name: 'Bob', classId: 'mage', team: 1, controller: 'player', build: botBuild('mage', seed + 9) });
  const drivers = [new Bot(sim, x.id, 'hard', 1), new Bot(sim, y.id, 'easy', 2)];
  for (let ms = 0; sim.phase !== 'ended' && ms < 150000; ms += 50) {
    for (const d of drivers) d.tick();
    sim.step();
    sim.drainEvents();
  }
  return rec.finish([]);
}

describe('bots learn from player matches', () => {
  it('a people-only match teaches the losing class through the winners, and people’s habits are studied', async () => {
    let replay = playerMatch(4);
    for (let seed = 5; seed < 12 && replay.winner !== 0 && replay.winner !== 1; seed++) replay = playerMatch(seed);
    assert.ok(replay.winner === 0 || replay.winner === 1, 'someone won');
    assert.deepEqual(forcedStudy(replay), { teachers: replay.winner });
    const learner = new BotLearner(new MemoryStore(), () => 0.5);
    const r = await learner.trainOn(replay, 'pvp000000001');
    assert.equal(r.ok, true);
    if (r.ok) assert.ok(r.lessons + r.habits > 0, JSON.stringify(r));
    const index = await learner.archived();
    assert.equal(index[0]?.id, 'pvp000000001', 'kept for offline study');
    assert.equal(index[0]?.bots.length, 0);
    assert.deepEqual(forcedStudy({ ...replay, winner: 'draw' }), {}, 'a draw still teaches people’s habits');
  });

  it('the owner’s switch: train on every match, logged', async () => {
    const store = new MemoryStore();
    const log = new AdminLog(store);
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 }, undefined, new BotLearner(store, () => 0.5), undefined, undefined, log);
    const out: any[] = [];
    const p = { ws: { readyState: 1, send: (s: string) => out.push(JSON.parse(s)), bufferedAmount: 0 }, name: 'Toke', classId: 'mage', matches: 0, wins: 0, size: 1, ip: '1.1.1.1', mapPref: 'random', ownerOk: true, account: { name: 'Toke', key: 'toke' } } as any;
    (lobby as any).conns.add(p);
    lobby.handle(p, parseClientMsg(JSON.stringify({ t: 'admin_act', act: 'autotrain', on: true }))!);
    for (let i = 0; i < 50 && !out.some((m) => m.t === 'admin_overview'); i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(out.find((m) => m.t === 'admin_overview').autoTrain, true);
    assert.equal(await log.autoTrain(), true, 'kept over restarts');
    const again = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 }, undefined, undefined, undefined, undefined, log);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal((again as any).autoTrain, true);
  });
});
