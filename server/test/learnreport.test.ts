import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { ARENAS, ArenaSim, Bot, EMPTY_GRADED, ReplayRecorder, botBuild, brainFor, formatReport, parseClientMsg } from '@arena/shared';
import type { BotStudy, Nudge, ReplayData } from '@arena/shared';
import { MemoryStore } from '../src/store';
import { BotLearner, LEARN_INDEX_KEY, REPORTS_MAX, learnReplayKey } from '../src/botlearn';
import { Lobby } from '../src/rooms';

function botMatch(seed = 3): ReplayData {
  const arena = ARENAS[1];
  const sim = new ArenaSim({ seed, prepMs: 3000, arena });
  const rec = new ReplayRecorder(sim, { arena: arena.id, seed, prepMs: 3000 });
  const x = sim.addUnit({ name: 'Bot A', classId: 'warrior', team: 0, controller: 'bot', build: botBuild('warrior', seed) });
  const y = sim.addUnit({ name: 'Bot B', classId: 'mage', team: 1, controller: 'bot', build: botBuild('mage', seed + 9) });
  const drivers = [new Bot(sim, x.id, 'hard', 1), new Bot(sim, y.id, 'easy', 2)];
  for (let ms = 0; sim.phase !== 'ended' && ms < 150000; ms += 50) {
    for (const d of drivers) d.tick();
    sim.step();
    sim.drainEvents();
  }
  return rec.finish([]);
}

const facts = (mistakes: BotStudy['facts']['mistakes'] = {}): BotStudy['facts'] => ({ castsUnderThreat: 0, kicked: 0, juked: 0, kicksLanded: 0, diedWithDefensive: 0, burstDeaths: 0, bigCastsTaken: 0, zoneHits: 0, engagedSec: 60, kitedFrac: 0, pinnedFrac: 0, mistakes });
/** A measurer that returns a chosen study instead of playing the replay back. */
const stub = (bots: BotStudy[]) => async () => ({ humans: [], study: { bots, players: [] } });
const mageLoss = (lessons: BotStudy['lessons'], mistakes: BotStudy['facts']['mistakes'] = {}, nudges: Nudge[] = []): BotStudy => ({ unitId: 2, classId: 'mage', foes: ['warrior'], won: false, lessons, graded: { ...EMPTY_GRADED, sec: 60 }, people: { ...EMPTY_GRADED, sec: 60 }, nudges, facts: facts(mistakes) });
const nudge = (keys: Nudge['keys'], sign: 1 | -1 = 1, strength = 1): Nudge => ({ metric: 'standing still', why: 'stood still 70% of the fight, the people 20%', keys, sign, strength });

describe('the bot learner says what it learned', () => {
  it('names the numbers that moved, before and after, and keeps the report in the log', async () => {
    const replay = botMatch();
    const learner = new BotLearner(new MemoryStore(), () => 0.5, stub([mageLoss({ peelAt: { value: 1, weight: 120 }, trinketAt: { value: 1, weight: 120 } }, { stoodPinned: 6, lockedTrinket: 4 })]));
    const r = await learner.trainOn(replay, 'rep000000001');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const mage = r.report.classes.find((c) => c.classId === 'mage')!;
    const moved = Object.fromEntries(mage.moved.map((m) => [m.key, m]));
    assert.ok(moved.peelAt && moved.peelAt.after > moved.peelAt.before, JSON.stringify(mage.moved));
    assert.ok(moved.trinketAt.after > moved.trinketAt.before);
    assert.match(r.report.headline, /mage bots now .*peel melee away sooner/);
    assert.deepEqual(r.report.totals.map((t) => t.label).sort(), ['locked down with the trinket ready', 'stood still with melee on it and a push-off ready']);
    assert.equal(r.report.nothing, null);
    assert.match(formatReport(r.report).join('\n'), /6 stood still with melee on it/);
    assert.equal(learner.learnReports()[0].headline, r.report.headline);
    const k = learner.knowledge().find((c) => c.classId === 'mage')!;
    assert.equal(k.replays, 1);
    assert.ok(k.lastAt && k.diff.some((d) => d.key === 'peelAt'));
    assert.ok(k.mistakes.some((m) => m.count === 6));
    assert.deepEqual(learner.knowledge().find((c) => c.classId === 'rogue')!.diff, [], 'a class nothing taught is unchanged');
  });

  it('says honestly when nothing moved, and why', async () => {
    const replay = botMatch();
    const none = new BotLearner(new MemoryStore(), () => 0.5, stub([mageLoss({})]));
    const a = await none.trainOn(replay, 'rep000000002');
    assert.ok(a.ok && a.report.nothing && /the way the people did on every measure/.test(a.report.nothing), a.ok ? a.report.headline : '');
    assert.match(a.ok ? a.report.headline : '', /^Nothing to learn from this match:/);
    const short = new BotLearner(new MemoryStore(), () => 0.5, stub([{ ...mageLoss({}), facts: { ...facts(), engagedSec: 3 } }]));
    const b = await short.trainOn(replay, 'rep000000003');
    assert.ok(b.ok && /too short/.test(b.report.nothing ?? ''));
    const thin = new BotLearner(new MemoryStore(), () => 0.5, stub([mageLoss({}, { castNoLos: 1 })]));
    const c = await thin.trainOn(replay, 'rep000000004');
    assert.ok(c.ok && c.report.nothing !== null, 'a single mistake with no graded difference moves nothing, and says why');
    const nobody = new BotLearner(new MemoryStore(), () => 0.5, stub([]));
    const d = await nobody.trainOn(replay, 'rep000000005');
    assert.ok(d.ok && /no bot fought a person/.test(d.report.nothing ?? ''));
  });

  it('more mistakes and more passes move a number further, one replay is bounded, and the drift from the shipped brain is capped', async () => {
    const replay = botMatch();
    const lesson = { peelAt: { value: 1, weight: 140 } };
    const after = async (passes: number) => {
      const l = new BotLearner(new MemoryStore(), () => 0.5, stub([mageLoss(lesson)]));
      await l.trainOn(replay, 'rep00000000a', { passes });
      return l.knowledge().find((c) => c.classId === 'mage')!.learned.peelAt;
    };
    const p1 = await after(1);
    const p3 = await after(3);
    assert.ok(p3 > p1, `1 pass ${p1}, 3 passes ${p3}`);
    const shipped = brainFor('mage').peelAt;
    assert.ok(p1 - shipped <= 0.2 + 1e-9, 'a single replay moves a number at most a fifth of its range');
    // many replays in a row: still within 60% of the range of what shipped
    const l = new BotLearner(new MemoryStore(), () => 0.5, stub([mageLoss({ peelAt: { value: 1, weight: 1000 } })]));
    for (let i = 0; i < 12; i++) await l.trainOn(replay, `rep0000000b${i}`, { passes: 5 });
    assert.ok(l.knowledge().find((c) => c.classId === 'mage')!.learned.peelAt - shipped <= 0.6 + 1e-9);
  });

  it('every fight teaches something: graded nudges move a number even when no mistake was found, with the reason, and never say the bots already play it', async () => {
    const replay = botMatch();
    const l = new BotLearner(new MemoryStore(), () => 0.5, stub([mageLoss({}, {}, [nudge(['mobility', 'strafe'])])]));
    const r = await l.trainOn(replay, 'rep0000000c1');
    assert.ok(r.ok);
    if (!r.ok) return;
    const mage = r.report.classes.find((c) => c.classId === 'mage')!;
    assert.equal(mage.moved.length, 1);
    assert.ok(['mobility', 'strafe'].includes(mage.moved[0].key), 'the first number on the list that is not at its bound');
    assert.ok(mage.moved[0].after > mage.moved[0].before);
    assert.match(mage.moved[0].why ?? '', /standing still: stood still 70%/);
    assert.equal(r.report.nothing, null);
    const text = formatReport(r.report).join('\n');
    assert.match(text, /\[(mobility|strafe) \d\.\d\d -> \d\.\d\d\]/);
    assert.match(text, /because standing still/);
    assert.doesNotMatch(text, /already play/i);
    // a win counts half as much
    const key = mage.moved[0].key;
    const w = new BotLearner(new MemoryStore(), () => 0.5, stub([{ ...mageLoss({}, {}, [nudge([key as 'mobility'])]), won: true }]));
    const rw = await w.trainOn(replay, 'rep0000000c2');
    const step = (x: Awaited<ReturnType<BotLearner['trainOn']>>) => (x.ok ? x.report.classes[0].moved[0].after - x.report.classes[0].moved[0].before : 0);
    assert.ok(Math.abs(step(rw) - step(r) / 2) < 1e-6, `win ${step(rw)} loss ${step(r)}`);
  });

  it('a real replay always teaches something: every studied bot class moves at least one number, with a reason', async () => {
    let moved = 0;
    for (const seed of [3, 4, 5]) {
      const l = new BotLearner(new MemoryStore(), () => 0.5);
      const r = await l.trainOn(botMatch(seed), `rep00000d${seed}00`);
      assert.ok(r.ok);
      if (!r.ok) continue;
      assert.ok(r.report.bots.length >= 1);
      for (const c of r.report.classes) {
        assert.ok(c.moved.length >= 1, `${c.classId}: ${r.report.headline}`);
        assert.ok(c.moved.every((m) => m.why));
        moved++;
      }
      assert.equal(r.report.nothing, null);
      assert.doesNotMatch(formatReport(r.report).join('\n'), /already play/i);
    }
    assert.ok(moved >= 3);
  });

  it('a number at its limit is widened or the next number moves, and it says so', async () => {
    const replay = botMatch();
    const l = new BotLearner(new MemoryStore(), () => 0.5, stub([mageLoss({}, {}, [nudge(['mobility', 'strafe'], 1, 1)])]));
    const first = brainFor('mage').mobility;
    let widened = false;
    for (let i = 0; i < 40; i++) {
      const r = await l.trainOn(replay, `rep0000001${String(i).padStart(2, '0')}`, { passes: 3 });
      assert.ok(r.ok);
      if (r.ok && r.report.classes[0].notes?.some((n) => /widened/.test(n))) widened = true;
      if (r.ok) assert.ok(r.report.classes[0].moved.length >= 1 || r.report.classes[0].notes?.length, 'never stalls silently');
    }
    const k = l.knowledge().find((c) => c.classId === 'mage')!.learned;
    assert.ok(k.mobility > first || k.strafe > brainFor('mage').strafe, 'one of the two numbers on the list moved up');
    assert.ok(k.mobility <= 1 && k.strafe <= 1);
    void widened;
  });

  it('keeps the last 50 reports, and survives a restart', async () => {
    const store = new MemoryStore();
    const replay = botMatch();
    const l = new BotLearner(store, () => 0.5, stub([mageLoss({})]));
    for (let i = 0; i < REPORTS_MAX + 5; i++) await l.trainOn(replay, `rep000001${String(i).padStart(2, '0')}`);
    await l.flush();
    assert.equal(l.learnReports().length, REPORTS_MAX);
    const again = new BotLearner(store, () => 0.5);
    await again.whenReady();
    assert.equal(again.learnReports().length, REPORTS_MAX);
  });

  it('resets every class to the shipped brain', async () => {
    const replay = botMatch();
    const l = new BotLearner(new MemoryStore(), () => 0.5, stub([mageLoss({ peelAt: { value: 1, weight: 140 } }, { stoodPinned: 5 })]));
    await l.trainOn(replay, 'rep000000099');
    assert.ok(l.knowledge().find((c) => c.classId === 'mage')!.diff.length);
    await l.resetBrain();
    const k = l.knowledge().find((c) => c.classId === 'mage')!;
    assert.deepEqual(k.diff, []);
    assert.equal(k.replays, 0);
    assert.equal(l.learnReports().length, 0);
    assert.equal(l.outplayLessons().mage, undefined);
  });

  it('trains on every archived replay, skipping (and counting) the ones from another version', async () => {
    const store = new MemoryStore();
    const replay = botMatch();
    const l = new BotLearner(store, () => 0.5, stub([mageLoss({ peelAt: { value: 1, weight: 140 } }, { stoodPinned: 5 })]));
    await l.trainOn(replay, 'arc000000001');
    await l.flush();
    const old = { ...replay, hash: 'old' };
    await store.set(learnReplayKey('arc000000002'), zlib.gzipSync(JSON.stringify(old)).toString('base64'));
    const index = JSON.parse((await store.get(LEARN_INDEX_KEY))!);
    index.push({ id: 'arc000000002', at: 1, bots: ['warrior'], humans: [], humansWon: null });
    await store.set(LEARN_INDEX_KEY, JSON.stringify(index));
    const seen: { done: number; total: number; skipped: number }[] = [];
    const report = await l.trainArchive((p) => seen.push({ ...p }));
    assert.equal(seen.at(-1)?.total, 2);
    assert.equal(report.skipped, 1);
    assert.equal(report.replaysRead, 1);
    assert.match(report.headline, /1 replay read, 1 skipped/);
    assert.equal(l.learnReports()[0].id, report.id, 'one report for the whole batch');
  });

  it('the owner can reach it from the admin panel: knowledge, passes, train-all and reset', async () => {
    assert.ok(parseClientMsg(JSON.stringify({ t: 'admin_act', act: 'train_all' })));
    assert.ok(parseClientMsg(JSON.stringify({ t: 'admin_act', act: 'bot_knowledge' })));
    assert.ok(parseClientMsg(JSON.stringify({ t: 'admin_act', act: 'bot_reset' })));
    assert.ok(parseClientMsg(JSON.stringify({ t: 'admin_act', act: 'train_passes', id: 'abcdef123456', value: 3 })));
    assert.equal(parseClientMsg(JSON.stringify({ t: 'admin_act', act: 'train_passes', id: 'abcdef123456', value: 9 })), null);
    assert.equal(parseClientMsg(JSON.stringify({ t: 'admin_act', act: 'train_passes', value: 2 })), null);
    const store = new MemoryStore();
    const learner = new BotLearner(store, () => 0.5, stub([mageLoss({ peelAt: { value: 1, weight: 140 } }, { stoodPinned: 5 })]));
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 }, undefined, learner);
    const out: any[] = [];
    const owner = { ws: { readyState: 1, send: (s: string) => out.push(JSON.parse(s)), bufferedAmount: 0 }, name: 'Toke', classId: 'mage', matches: 0, wins: 0, size: 1, ip: '1.1.1.1', mapPref: 'random', ownerOk: true, account: { name: 'Toke', key: 'toke' } } as any;
    (lobby as any).conns.add(owner);
    const r = await lobby.trainOnReplay('Toke', zlib.gzipSync(JSON.stringify(botMatch())), 'abcdef123456', { passes: 2 });
    assert.equal(r.ok, true, r.text);
    assert.match(r.text, /mage bots now .*peel melee/);
    const status = out.filter((m) => m.t === 'train_status').at(-1);
    assert.ok(status.jobs[0].report.classes.find((c: any) => c.classId === 'mage').moved.length, 'the queue row carries the report');
    assert.ok(out.some((m) => m.t === 'bot_knowledge' && m.classes.length === 4));
    const all = await lobby.trainOnArchive('Toke');
    assert.equal(all.ok, true, all.text);
    assert.ok(out.filter((m) => m.t === 'train_status').at(-1).jobs.some((j: any) => j.id === 'all-archived' && j.state === 'done' && j.progress.total >= 1));
  });
});
