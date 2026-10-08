import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store';
import { BotLearner, LEARN_INDEX_KEY } from '../src/botlearn';
import { startServer } from '../src/index';
import { gunzipSync } from 'node:zlib';
import { ARENAS, ArenaSim, Bot, ReplayRecorder, botBuild } from '@arena/shared';
import type { ClassId, ReplayData } from '@arena/shared';

/** A person (a hard bot steering a player unit) against an easy bot. */
function botMatch(person: ClassId, bot: ClassId, seed: number): ReplayData {
  const sim = new ArenaSim({ seed, prepMs: 3000, arena: ARENAS[1] });
  const rec = new ReplayRecorder(sim, { arena: ARENAS[1].id, seed, prepMs: 3000 });
  const p = sim.addUnit({ name: 'P', classId: person, team: 0, controller: 'player', build: botBuild(person, seed) });
  const b = sim.addUnit({ name: 'B', classId: bot, team: 1, controller: 'bot', build: botBuild(bot, seed + 9) });
  const drivers = [new Bot(sim, p.id, 'hard', 1), new Bot(sim, b.id, 'easy', 2)];
  for (let ms = 0; sim.phase !== 'ended' && ms < 150000; ms += 50) {
    for (const d of drivers) d.tick();
    sim.step();
    sim.drainEvents();
  }
  return rec.finish([]);
}

describe('bot learner', () => {
  it('hands out brains, records results and survives a restart', async () => {
    const store = new MemoryStore();
    const a = new BotLearner(store);
    await a.whenReady();
    const pick = a.pick('rogue')!;
    assert.ok(pick.brain && pick.variantId);
    for (let i = 0; i < 5; i++) a.report('rogue', pick.variantId, true);
    await new Promise((r) => setTimeout(r, 20));
    const s = a.summary().rogue.variants.find((v) => v.id === pick.variantId)!;
    assert.equal(s.games, 5);
    const b = new BotLearner(store);
    await b.whenReady();
    assert.equal(b.summary().rogue.variants.find((v) => v.id === pick.variantId)?.games, 5, 'loaded from the store');
  });
  it('a corrupt record just starts fresh', async () => {
    const store = new MemoryStore();
    await store.set('botlearn:mage', '{nope');
    const l = new BotLearner(store);
    await l.whenReady();
    assert.ok(l.pick('mage'));
  });

  it('learns from a replay: a human variant joins the population and the style survives a restart', async () => {
    const sim = new ArenaSim({ seed: 11, prepMs: 0, facing: true });
    const rec = new ReplayRecorder(sim, { arena: 'default', seed: 11, prepMs: 0 });
    const me = sim.addUnit({ name: 'me', classId: 'mage', team: 0, controller: 'player' });
    const foe = sim.addUnit({ name: 'foe', classId: 'warrior', team: 1, controller: 'dummy' });
    foe.maxHealth = foe.health = 1e9;
    sim.step();
    sim.setTarget(me.id, foe.id);
    for (let i = 0; i < 800; i++) {
      const d = Math.hypot(foe.pos.x - me.pos.x, foe.pos.z - me.pos.z);
      sim.queueInput(me.id, { seq: i + 1, fwd: d > 20.5 ? 1 : d < 19.5 ? -1 : 0, strafe: 1, facing: Math.atan2(foe.pos.x - me.pos.x, foe.pos.z - me.pos.z) });
      sim.step();
      sim.drainEvents();
    }
    const store = new MemoryStore();
    const l = new BotLearner(store);
    await l.whenReady();
    await l.learnFrom(rec.finish([]));
    assert.ok(l.summary().mage.variants.some((v) => v.id === 'human'));
    assert.ok((l.humanStyles().mage?.strafe?.value ?? 0) > 0.5);
    await new Promise((r) => setTimeout(r, 20));
    const again = new BotLearner(store);
    await again.whenReady();
    assert.ok((again.humanStyles().mage?.strafe?.weight ?? 0) > 10, 'style reloaded');
    assert.ok(again.summary().mage.variants.some((v) => v.id === 'human'));
  });

  it('keeps replays of people against bots for study, learns a lesson variant, and counts real results by class', async () => {
    const store = new MemoryStore();
    const l = new BotLearner(store);
    await l.whenReady();
    for (const seed of [3, 4, 5]) await l.learnFrom(botMatch('warrior', 'priest', seed), `abc12${seed}`);
    await l.flush();
    const index = await l.archived();
    assert.deepEqual(index.map((e) => e.id), ['abc125', 'abc124', 'abc123'], 'newest first');
    assert.deepEqual(index[0].bots, ['priest']);
    assert.deepEqual(index[0].humans, ['warrior']);
    const gz = await l.archivedReplay('abc124');
    assert.ok(gz);
    assert.equal((JSON.parse(gunzipSync(gz!).toString()) as ReplayData).seed, 4, 'the replay itself comes back');
    assert.ok(Object.keys(l.outplayLessons().priest ?? {}).length > 0, 'the priest bots learned something from losing');
    assert.ok(l.summary().priest.variants.some((v) => v.id === 'lesson'), 'a lesson variant competes in the population');
    // a solo match against a dummy is not kept
    const sim = new ArenaSim({ seed: 1, prepMs: 0 });
    const rec = new ReplayRecorder(sim, { arena: ARENAS[0].id, seed: 1, prepMs: 0 });
    sim.addUnit({ name: 'P', classId: 'mage', team: 0, controller: 'player' });
    sim.addUnit({ name: 'D', classId: 'warrior', team: 1, controller: 'dummy' });
    sim.step();
    await l.learnFrom(rec.finish([]), 'abc999');
    await l.flush();
    assert.equal((await l.archived()).length, 3);

    const pick = l.pick('priest')!;
    l.report('priest', pick.variantId, false, 0.1, ['warrior'], 'hard');
    l.report('priest', pick.variantId, true, 0.9, ['warrior', 'mage'], 'hard');
    assert.deepEqual(l.results()['priest>warrior:hard'], { w: 1, g: 2 });
    assert.equal(l.summary().priest.vsPeople['warrior:hard'].botWinRate, 0.5);
    await l.flush();
    await new Promise((r) => setTimeout(r, 10));
    const again = new BotLearner(store);
    await again.whenReady();
    assert.deepEqual(again.results()['priest>mage:hard'], { w: 1, g: 1 }, 'the ledger survives a restart');
    assert.ok(Object.keys(again.outplayLessons().priest ?? {}).length > 0, 'and so do the lessons');
    assert.ok(await store.get(LEARN_INDEX_KEY));
  });

  it('the study export is for the owner only', async () => {
    const prev = process.env.ARENA_OWNER_CODE;
    process.env.ARENA_OWNER_CODE = 'study-code';
    const srv = await startServer({ port: 0, host: '127.0.0.1', staticDir: '/nonexistent', accountStore: new MemoryStore() });
    try {
      const url = `http://127.0.0.1:${srv.port}/api/botlearn/export`;
      assert.equal((await fetch(url)).status, 403);
      assert.equal((await fetch(url, { headers: { 'x-owner-code': 'wrong-code' } })).status, 403);
      const ok = await fetch(url, { headers: { 'x-owner-code': 'study-code' } });
      assert.equal(ok.status, 200);
      const body = (await ok.json()) as { index: unknown[]; ledger: object };
      assert.ok(Array.isArray(body.index) && typeof body.ledger === 'object');
      assert.equal((await fetch(`http://127.0.0.1:${srv.port}/api/botlearn/replay/nope00`, { headers: { 'x-owner-code': 'study-code' } })).status, 404);
      // uploading a replay to train on needs the owner's signed-in session
      const up = `http://127.0.0.1:${srv.port}/api/botlearn/upload`;
      assert.equal((await fetch(up, { method: 'POST', body: '{}' })).status, 401);
      assert.equal((await fetch(up, { method: 'POST', body: '{}', headers: { authorization: 'Bearer not-a-real-session-token' } })).status, 403);
    } finally {
      await srv.close();
      if (prev === undefined) delete process.env.ARENA_OWNER_CODE;
      else process.env.ARENA_OWNER_CODE = prev;
    }
  });
});
