import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARENAS, ArenaSim, Bot, DEFAULT_BRAIN, ReplayRecorder, botBuild, evolve, forcedStudy, lessonBrain, newPopulation, studyMatch } from '../src/index';
import type { ClassId, Difficulty, ReplayData } from '../src/index';

/** A match where the "person" is a hard bot steering a player unit: its commands are recorded as a person's. */
function match(person: ClassId, bot: ClassId, seed = 3, difficulty: Difficulty = 'easy'): ReplayData {
  const arena = ARENAS[1];
  const sim = new ArenaSim({ seed, prepMs: 3000, arena });
  const rec = new ReplayRecorder(sim, { arena: arena.id, seed, prepMs: 3000 });
  const p = sim.addUnit({ name: 'P', classId: person, team: 0, controller: 'player', build: botBuild(person, seed) });
  const b = sim.addUnit({ name: 'B', classId: bot, team: 1, controller: 'bot', build: botBuild(bot, seed + 9) });
  const drivers = [new Bot(sim, p.id, 'hard', 1), new Bot(sim, b.id, difficulty, 2)];
  for (let ms = 0; sim.phase !== 'ended' && ms < 150000; ms += 50) {
    for (const d of drivers) d.tick();
    sim.step();
    sim.drainEvents();
  }
  return rec.finish([]);
}

/** Bots against bots (an owner's bot match). */
function botMatch(a: ClassId, b: ClassId, seed = 5): ReplayData {
  const arena = ARENAS[1];
  const sim = new ArenaSim({ seed, prepMs: 3000, arena });
  const rec = new ReplayRecorder(sim, { arena: arena.id, seed, prepMs: 3000 });
  const x = sim.addUnit({ name: 'Bot A', classId: a, team: 0, controller: 'bot', build: botBuild(a, seed) });
  const y = sim.addUnit({ name: 'Bot B', classId: b, team: 1, controller: 'bot', build: botBuild(b, seed + 9) });
  const drivers = [new Bot(sim, x.id, 'hard', 1), new Bot(sim, y.id, 'easy', 2)];
  for (let ms = 0; sim.phase !== 'ended' && ms < 150000; ms += 50) {
    for (const d of drivers) d.tick();
    sim.step();
    sim.drainEvents();
  }
  return rec.finish([]);
}

describe('training on a bot match the owner picked', () => {
  it('the losing bot learns from the winning bot; a bot match with no winner teaches nothing', () => {
    const r = botMatch('warrior', 'priest');
    assert.ok(r.winner === 0 || r.winner === 1, 'the match has a winner');
    assert.deepEqual(studyMatch(r).bots, [], 'without being picked, a bot match teaches nothing');
    const opts = forcedStudy(r);
    assert.deepEqual(opts, { teachers: r.winner });
    const st = studyMatch(r, opts!);
    assert.equal(st.bots.length, 1, 'only the loser is the student');
    assert.equal(st.bots[0].won, false);
    assert.equal(forcedStudy({ ...r, winner: 'draw' }), null);
    assert.deepEqual(forcedStudy(match('warrior', 'priest')), {}, 'a match with people studies as always');
  });
});

describe('learning how people beat the bots', () => {
  it('reads a bot loss to a person: who it fought, that it lost, and lessons within bounds', () => {
    const st = studyMatch(match('warrior', 'priest'));
    assert.equal(st.bots.length, 1);
    const b = st.bots[0];
    assert.equal(b.classId, 'priest');
    assert.deepEqual(b.foes, ['warrior']);
    assert.ok(b.facts.engagedSec > 0);
    for (const [k, m] of Object.entries(b.lessons)) assert.ok(m!.weight > 0 && Number.isFinite(m!.value), k);
    assert.equal(st.players.length, 1);
    assert.equal(st.players[0].classId, 'warrior');
  });

  it('a warrior who kicks the bot priest teaches it when people kick, and the person\'s kick timing is measured', () => {
    // the easy bot priest casts into a hard warrior's Pummel: kicks land on it
    let seen = false;
    for (const seed of [3, 4, 5, 6]) {
      const st = studyMatch(match('warrior', 'priest', seed));
      if (!st.bots[0].facts.kicked) continue;
      seen = true;
      assert.ok(st.bots[0].lessons.jukeAt, 'when it gets kicked it learns to stop a fake before that point');
      assert.ok(st.players[0].sample.kickAt, 'and how far into a cast the person kicks');
      const at = st.players[0].sample.kickAt!.value;
      assert.ok(at >= 0 && at <= 0.85);
    }
    assert.ok(seen, 'some seed has the warrior kicking the priest');
  });

  it('nothing to learn without both people and bots, or for a bot on the people\'s side', () => {
    const sim = new ArenaSim({ seed: 1, prepMs: 0 });
    const rec = new ReplayRecorder(sim, { arena: ARENAS[0].id, seed: 1, prepMs: 0 });
    sim.addUnit({ name: 'P', classId: 'mage', team: 0, controller: 'player' });
    sim.addUnit({ name: 'B', classId: 'rogue', team: 0, controller: 'bot' });
    sim.addUnit({ name: 'D', classId: 'warrior', team: 1, controller: 'dummy' });
    for (let i = 0; i < 40; i++) sim.step();
    assert.deepEqual(studyMatch(rec.finish([])).bots, []);
  });

  it('lessons only push the way they point, and never past the bounds', () => {
    const base = { ...DEFAULT_BRAIN, defHp: 0.6, losUse: 0.2, jukeAt: 0.5 };
    const b = lessonBrain(base, { defHp: { value: 0.5, weight: 300 }, losUse: { value: 0.9, weight: 300 }, jukeAt: { value: 0.3, weight: 300 }, dodge: { value: 5, weight: 300 } });
    assert.equal(b.defHp, 0.6, 'already defending earlier than the lesson asks: left alone');
    assert.ok(b.losUse > 0.7, 'took long casts in the open: uses pillars more');
    assert.ok(b.jukeAt < 0.4, 'got kicked early: stops its fakes earlier');
    assert.ok(b.dodge <= 1);
    assert.deepEqual(lessonBrain(base, { losUse: { value: 0.9, weight: 10 } }), base, 'too little evidence changes nothing');
  });

  it('a new variant is bred towards the lessons', () => {
    let rng = 7;
    const r = () => ((rng = (rng * 16807) % 2147483647) / 2147483647);
    const pop = newPopulation('mage', r);
    for (const v of pop.variants) v.brain = { ...v.brain, losUse: 0.1 };
    evolve(pop, r, { losUse: { value: 1, weight: 300 } });
    const child = pop.variants.find((v) => v.id.startsWith('g1'))!;
    assert.ok(child.brain.losUse > 0.3, `child losUse ${child.brain.losUse}`);
  });
});
