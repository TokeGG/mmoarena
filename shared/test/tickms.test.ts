import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ABILITIES, ARENAS, ArenaSim, AURAS, Bot, CLASS_IDS, ReplayRecorder, ReplayRunner, TUNING, botBuild, contentHash } from '../src/index';
import type { ClassId, SimEvent } from '../src/index';

/** The sim runs at any tick length: rules are in milliseconds, so what a tick is only decides how finely they are applied. Explicit `tickMs`, never TUNING, so the tests mean the same whatever the suite runs at. */

const mk = (tickMs: number, seed = 3) => new ArenaSim({ tickMs, seed, prepMs: 0 });
const add = (sim: ArenaSim, classId: ClassId, team: 0 | 1, x: number, z: number, controller: 'player' | 'dummy' = 'player', spec?: string) => {
  const u = sim.addUnit({ name: classId + team, classId, team, controller, ...(spec ? { build: { spec, talents: [], gear: {} } } : {}) });
  u.pos = { x, z };
  return u;
};
function runFor(sim: ArenaSim, ms: number, each?: () => void, ev?: (e: SimEvent, t: number) => void): void {
  const n = Math.round(ms / sim.tickMs);
  for (let i = 0; i < n; i++) {
    each?.();
    sim.step();
    for (const e of sim.drainEvents()) ev?.(e, sim.time);
  }
}

describe('tick length is an option of the sim', () => {
  it('defaults to TUNING.tickMs and keeps the real number it was given', () => {
    assert.equal(new ArenaSim({}).tickMs, TUNING.tickMs);
    assert.equal(new ArenaSim({ tickMs: 16 }).tickMs, 16);
    const s = new ArenaSim({ tickMs: 16 });
    s.step();
    s.step();
    assert.equal(s.time, 32);
    assert.equal(s.tickNo, 2);
  });

  it('input queue and history limits are in milliseconds: the same at 50 ms as before, proportional at 16 ms', () => {
    const a = new ArenaSim({ tickMs: 50 }).limits;
    assert.deepEqual(a, { queue: 5, repeat: 3, catchDepth: 2, catchMax: 2, credit: 5, history: 12 });
    const b = new ArenaSim({ tickMs: 16 }).limits;
    assert.ok(b.queue * 16 >= 250 && b.queue * 16 < 250 + 16);
    assert.ok(b.repeat * 16 >= 150 && b.repeat * 16 < 150 + 16);
    assert.ok(b.history * 16 >= 600, 'history covers 300 ms of rewind and the oldest view time accepted');
  });
});

describe('rules take as long as their data says, at 16 ms as at 50 ms', () => {
  for (const T of [50, 16]) {
    it(`at ${T} ms: casts, stuns, channels, bleeds, GCD and swings are within one tick of the data`, () => {
      // Frostbolt press -> damage
      {
        const sim = mk(T); const m = add(sim, 'mage', 0, 0, 0); const w = add(sim, 'warrior', 1, 12, 0, 'dummy');
        sim.step(); sim.drainEvents();
        assert.ok(sim.useAbility(m.id, 'frostbolt', w.id).ok);
        const t0 = sim.time; let hit = NaN;
        runFor(sim, 3000, undefined, (e, t) => { if (e.t === 'damage' && e.ability === 'frostbolt' && Number.isNaN(hit)) hit = t - t0; });
        const cast = ABILITIES.frostbolt.castTime;
        assert.ok(hit >= cast && hit <= cast + 2 * T, `frostbolt ${hit} vs ${cast}`);
      }
      // a back-to-back chain of eight casts
      {
        const sim = mk(T); const m = add(sim, 'mage', 0, 0, 0); const w = add(sim, 'warrior', 1, 12, 0, 'dummy');
        m.resource = m.resourceMax = 1e6; w.health = w.maxHealth = 1e9;
        sim.step(); sim.drainEvents();
        let n = 0, at8 = NaN;
        runFor(sim, 14000, () => { sim.useAbility(m.id, 'frostbolt', w.id); }, (e, t) => { if (e.t === 'damage' && e.ability === 'frostbolt' && ++n === 8) at8 = t; });
        const ideal = 8 * ABILITIES.frostbolt.castTime;
        assert.ok(at8 >= ideal && at8 <= ideal + 8 * T, `chain ${at8} vs ${ideal}`);
      }
      // 12 instants on a 1000 ms GCD
      {
        const sim = mk(T); const r = add(sim, 'rogue', 0, 0, 0); const w = add(sim, 'warrior', 1, 1.5, 0, 'dummy');
        r.resource = r.resourceMax = 1e6; w.health = w.maxHealth = 1e9;
        sim.step(); sim.drainEvents();
        let n = 0;
        runFor(sim, 12000, () => { sim.useAbility(r.id, 'sinister_strike', w.id); }, (e) => { if (e.t === 'damage' && e.ability === 'sinister_strike') n++; });
        assert.ok(n >= 11 && n <= 12, `${n} strikes in 12 s`);
      }
      // Mind Flay: every tick fires, the last one at the end of the channel
      {
        const sim = mk(T); const p = add(sim, 'priest', 0, 0, 0, 'player', 'shadow'); const w = add(sim, 'warrior', 1, 10, 0, 'dummy');
        w.health = w.maxHealth = 1e9;
        sim.step(); sim.drainEvents();
        sim.useAbility(p.id, 'mind_flay', w.id);
        const t0 = sim.time; let n = 0, last = 0;
        runFor(sim, 4000, undefined, (e, t) => { if (e.t === 'damage' && e.ability === 'mind_flay') { n++; last = t - t0; } });
        assert.equal(n, ABILITIES.mind_flay.channel!.ticks);
        const total = ABILITIES.mind_flay.castTime;
        assert.ok(Math.abs(last - total) <= T, `last tick at ${last} vs ${total}`);
      }
      // Garrote: the opening hit plus every bleed tick, none lost to rounding
      {
        const sim = mk(T); const r = add(sim, 'rogue', 0, 0, 0, 'player', 'assassination'); const w = add(sim, 'warrior', 1, 1.5, 0, 'dummy');
        w.health = w.maxHealth = 1e9;
        sim.step(); sim.drainEvents();
        sim.useAbility(r.id, 'garrote', w.id);
        let n = 0;
        runFor(sim, 9500, undefined, (e) => { if (e.t === 'damage' && e.ability === 'garrote') n++; });
        const bleed = AURAS.garrote_bleed;
        assert.equal(n, 1 + Math.floor(bleed.duration / bleed.dot!.interval), 'every bleed tick lands, the last one included');
      }
      // Kidney Shot stun ends when the data says (to the tick)
      {
        const sim = mk(T); const r = add(sim, 'rogue', 0, 0, 0); const w = add(sim, 'warrior', 1, 1.5, 0, 'dummy');
        r.cp = 3;
        sim.step(); sim.drainEvents();
        sim.useAbility(r.id, 'kidney_shot', w.id);
        const p0 = sim.time;
        const aura = w.auras.find((a) => a.id === 'kidney_shot')!;
        const want = aura.expiresAt - p0;
        let gone = NaN;
        runFor(sim, 7000, undefined, (e, t) => { if (e.t === 'aura_removed' && e.aura === 'kidney_shot') gone = t - p0; });
        assert.ok(gone >= want && gone <= want + T, `stun ${gone} vs ${want}`);
      }
      // auto attacks: one per interval
      {
        const sim = mk(T); const w = add(sim, 'warrior', 0, 0, 0); const d = add(sim, 'warrior', 1, 1.5, 0, 'dummy');
        d.health = d.maxHealth = 1e9;
        sim.step(); sim.drainEvents();
        sim.setTarget(w.id, d.id); sim.setAutoAttack(w.id, true);
        let n = 0;
        runFor(sim, 20000, () => { w.lastCombatAt = sim.time; }, (e) => { if (e.t === 'damage' && e.src === w.id && e.ability === null) n++; });
        assert.ok(n >= 9 && n <= 11, `${n} swings in 20 s`);
      }
      // mana regeneration per second does not depend on the step
      {
        const sim = mk(T); const m = add(sim, 'mage', 0, 0, 0); add(sim, 'warrior', 1, 20, 0, 'dummy');
        sim.step(); sim.drainEvents();
        m.resource = 0;
        runFor(sim, 10000);
        assert.ok(Math.abs(m.resource - 240) < 1, `${m.resource} mana in 10 s`);
      }
    });

    it(`at ${T} ms: running covers runSpeed yards per second and a cooldown ends on time`, () => {
      const sim = mk(T); const w = add(sim, 'warrior', 0, -20, 0); add(sim, 'warrior', 1, 20, 0, 'dummy');
      sim.step(); sim.drainEvents();
      const x0 = w.pos.x; let seq = 0;
      const t0 = sim.time;
      runFor(sim, 5000, () => sim.queueInput(w.id, { seq: ++seq, fwd: 1, strafe: 0, facing: Math.PI / 2 }));
      const want = ((sim.time - t0) / 1000) * TUNING.runSpeed;
      assert.ok(Math.abs(Math.hypot(w.pos.x - x0, w.pos.z) - want) < 0.001, `ran ${Math.hypot(w.pos.x - x0, w.pos.z)} of ${want}`);
    });
  }
});

describe('input queue and catch-up in milliseconds', () => {
  for (const T of [50, 16]) {
    it(`at ${T} ms: a one-second stall is worked off, the client is never ahead of the clock`, () => {
      const sim = mk(T); const u = add(sim, 'mage', 0, 0, 0); add(sim, 'mage', 1, 40, 40);
      sim.step();
      u.pos = { x: 0, z: 0 };
      let seq = 0;
      const send = () => sim.queueInput(u.id, { seq: ++seq, fwd: 1, strafe: 0, facing: 0 });
      const ticks = Math.round(2000 / T);
      for (let i = 0; i < ticks; i++) { send(); sim.step(); }
      const stall = Math.round(250 / T);
      for (let i = 0; i < stall; i++) sim.step(); // 250 ms of silence
      for (let i = 0; i < stall; i++) send(); // the late inputs arrive together
      for (let i = 0; i < ticks; i++) { send(); sim.step(); }
      assert.ok(u.inputQueue.length <= sim.limits.catchDepth, `queue ${u.inputQueue.length}`);
      const played = ticks * 2 + stall; // ticks the clock ran with a unit moving
      assert.ok(Math.hypot(u.pos.x, u.pos.z) <= played * TUNING.runSpeed * (T / 1000) + 1e-6, 'never more than the clock ran');
    });
  }

  it('a legitimate 16 ms client (62.5 inputs/s) never overflows the queue in steady play', () => {
    const sim = mk(16); const u = add(sim, 'mage', 0, 0, 0); add(sim, 'mage', 1, 40, 40);
    sim.step();
    let seq = 0;
    for (let i = 0; i < 625; i++) {
      sim.queueInput(u.id, { seq: ++seq, fwd: 0, strafe: 0, facing: 0 });
      sim.step();
      assert.ok(u.inputQueue.length <= 1);
    }
    assert.equal(u.lastSeq, seq);
  });
});

describe('lag compensation history covers the rewind at any tick length', () => {
  for (const T of [50, 16, 8]) {
    it(`at ${T} ms: a target that ran away 300 ms ago is judged where it stood then`, () => {
      const sim = mk(T); const m = add(sim, 'mage', 0, 0, 0); const w = add(sim, 'warrior', 1, 5, 0, 'dummy');
      sim.step(); sim.drainEvents();
      // the target stands 5 yd away for a second, then is moved 20 yd away; 300 ms later a cast that was aimed 300 ms ago must still be in range
      runFor(sim, 1000);
      w.pos = { x: 25, z: 0 };
      runFor(sim, 300);
      const vt = sim.time - 300;
      const r = sim.useAbility(m.id, 'frostbolt', w.id, null, sim.time - vt);
      assert.ok(r.ok, `rewound cast: ${(r as { reason?: string }).reason}`);
    });
  }
});

describe('replays record the tick length', () => {
  function play(tickMs: number, seed: number) {
    const sim = new ArenaSim({ tickMs, seed, prepMs: 1000, arena: ARENAS[0], facing: true });
    const rec = new ReplayRecorder(sim, { arena: ARENAS[0].id, seed, prepMs: 1000 });
    const bots: Bot[] = [];
    const ids = CLASS_IDS as ClassId[];
    for (let i = 0; i < 4; i++) {
      const classId = ids[(seed + i) % ids.length];
      const u = sim.addUnit({ name: `b${i}`, classId, team: (i % 2) as 0 | 1, controller: 'bot', build: botBuild(classId, i + seed) });
      bots.push(new Bot(sim, u.id, 'hard', 50 + i));
    }
    for (let t = 0; t < 40000 && sim.phase !== 'ended'; t += tickMs) {
      for (const b of bots) b.tick();
      sim.step();
      sim.drainEvents();
    }
    return { sim, data: rec.finish([]) };
  }
  const state = (sim: ArenaSim) => JSON.stringify([...sim.units.values()].map((u) => [u.pos, u.health, u.resource, u.cooldowns]));

  it('a match recorded at 16 ms re-simulates identically, whatever the server runs now', () => {
    const { sim, data } = play(16, 4);
    assert.equal(data.tickMs, TUNING.tickMs === 16 ? undefined : 16);
    assert.equal(data.hash, contentHash(16));
    assert.notEqual(contentHash(16), contentHash(20));
    assert.notEqual(contentHash(16), contentHash(50), 'the tick length is part of the hash');
    const runner = new ReplayRunner(data);
    assert.equal(runner.tickMs, 16);
    while (!runner.done) runner.step();
    assert.equal(runner.sim.time, sim.time);
    assert.equal(state(runner.sim), state(sim));
  });

  it('a match recorded at the default length carries no tickMs and plays as before', () => {
    const { sim, data } = play(TUNING.tickMs, 5);
    assert.equal(data.tickMs, undefined);
    assert.equal(data.hash, contentHash());
    const runner = new ReplayRunner(data);
    while (!runner.done) runner.step();
    assert.equal(state(runner.sim), state(sim));
  });
});

describe('bots at 16 ms', () => {
  it('a hard bot plays on a clock in milliseconds, at both lengths', () => {
    for (const T of [50, 16]) {
      const sim = new ArenaSim({ tickMs: T, seed: 2, prepMs: 0 });
      const a = sim.addUnit({ name: 'a', classId: 'mage', team: 0, controller: 'bot', build: botBuild('mage', 1) });
      sim.addUnit({ name: 'd', classId: 'warrior', team: 1, controller: 'dummy' }).pos = { x: 12, z: 0 };
      a.pos = { x: 0, z: 0 };
      const bot = new Bot(sim, a.id, 'hard', 9);
      sim.step();
      let hits = 0;
      for (let t = 0; t < 20000; t += T) { bot.tick(); sim.step(); hits += sim.drainEvents().filter((e) => e.t === 'damage' && e.src === a.id).length; }
      assert.ok(hits > 5, `the bot plays at ${T} ms (${hits} hits)`);
    }
  });
});

/** 50 ms outcomes must not have moved: digests captured from the code before the sim got a tick option (event logs and end state of six full bot matches). */
describe('50 ms outcomes are unchanged', () => {
  const GOLDEN: [number, string, number, number | string | null, string][] = [
    [1, 'ruins', 84150, 1, 'fae27d32e287'],
    [2, 'frost', 68500, 1, 'debda9775089'],
    [3, 'serpent', 45450, 1, '5920c38f12d5'],
  ];
  for (const [seed, arenaId, time, winner, digest] of GOLDEN) {
    it(`bot match ${seed} on ${arenaId}`, () => {
      const arena = ARENAS.find((a) => a.id === arenaId)!;
      const sim = new ArenaSim({ tickMs: 50, seed, prepMs: 3000, arena, facing: true });
      const bots: Bot[] = [];
      const ids = CLASS_IDS as string[];
      for (let i = 0; i < 6; i++) {
        const classId = ids[(seed + i * 2) % ids.length] as ClassId;
        const u = sim.addUnit({ name: 'b' + i, classId, team: (i % 2) as 0 | 1, controller: 'bot', build: botBuild(classId, seed * 10 + i) });
        bots.push(new Bot(sim, u.id, 'hard', seed * 100 + i));
      }
      const h = crypto.createHash('sha1');
      for (let t = 0; t < 120000 && sim.phase !== 'ended'; t += 50) {
        for (const b of bots) b.tick();
        sim.step();
        h.update(JSON.stringify(sim.drainEvents()));
      }
      h.update(JSON.stringify([...sim.units.values()].map((u) => [u.pos, u.health, u.resource])));
      assert.deepEqual([sim.time, sim.winner, h.digest('hex').slice(0, 12)], [time, winner, digest]);
    });
  }
});

describe('full bot matches at 16 ms', () => {
  for (const id of ['colosseum', 'forge', 'overlook']) {
    it(`${id}: a 2v2 finishes and nobody sits stuck`, () => {
      const arena = ARENAS.find((a) => a.id === id)!;
      const sim = new ArenaSim({ tickMs: 16, prepMs: 0, seed: 5, arena });
      const classes = [['warrior', 'priest'], ['rogue', 'mage']] as const;
      const units = [0, 1].flatMap((t) => classes[t].map((c, k) => sim.addUnit({ name: `b${t}${k}`, classId: c, team: t as 0 | 1, controller: 'bot' })));
      const bots = units.map((u, i) => new Bot(sim, u.id, 'hard', i + 1));
      const last = units.map((u) => ({ ...u.pos }));
      let maxIdle = 0;
      const idle = units.map(() => 0);
      const travelled = units.map(() => 0);
      for (let t = 0; t < 240000 / 16 && sim.winner === null; t++) {
        for (const b of bots) b.tick();
        sim.step();
        if (t % 63 === 62) {
          units.forEach((u, i) => {
            const moved = Math.hypot(u.pos.x - last[i].x, u.pos.z - last[i].z);
            last[i] = { ...u.pos };
            travelled[i] += moved;
            idle[i] = u.alive && u.classId !== 'priest' && moved < 0.05 && !u.cast ? idle[i] + 1 : 0;
            maxIdle = Math.max(maxIdle, idle[i]);
          });
        }
      }
      assert.ok(sim.winner !== null, `${id}: finished within 4 minutes`);
      assert.ok(maxIdle < 12, `${id}: nobody stood still for ${maxIdle} s`);
      assert.ok(travelled.every((d, i) => units[i].classId === 'priest' || d > 40), `${id}: every bot covered ground`);
    });
  }
});
