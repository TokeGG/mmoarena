import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { ARENAS, ArenaSim, Bot, ReplayRecorder, botBuild } from '@arena/shared';
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
