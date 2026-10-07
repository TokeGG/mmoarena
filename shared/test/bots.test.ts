import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArenaSim, Bot, TUNING } from '../src/index';
import type { ClassId, Difficulty, SimEvent, TeamId, Unit } from '../src/index';

const TICK = TUNING.tickMs;

function mk(prepMs = 0) {
  return { sim: new ArenaSim({ seed: 7, prepMs }), bots: [] as Bot[] };
}
type Ctx = ReturnType<typeof mk>;
function bot(ctx: Ctx, classId: ClassId, team: TeamId, x: number, z: number, diff: Difficulty = 'hard'): Unit {
  const u = ctx.sim.addUnit({ name: `${classId}${team}`, classId, team, controller: 'bot' });
  u.pos = { x, z };
  ctx.bots.push(new Bot(ctx.sim, u.id, diff, 100 + u.id));
  return u;
}
function dummy(ctx: Ctx, classId: ClassId, team: TeamId, x: number, z: number): Unit {
  const u = ctx.sim.addUnit({ name: `dummy-${classId}`, classId, team, controller: 'dummy' });
  u.pos = { x, z };
  return u;
}
function run(ctx: Ctx, ms: number, stopWhen?: () => boolean): SimEvent[] {
  const out: SimEvent[] = [];
  // With no prep phase, flip to live before any bot acts so none of them opens from stealth.
  if (ctx.sim.tickNo === 0 && ctx.sim.prepEndsAt === 0) {
    ctx.sim.step();
    ctx.sim.drainEvents();
  }
  for (let t = 0; t < ms; t += TICK) {
    for (const b of ctx.bots) b.tick();
    ctx.sim.step();
    out.push(...ctx.sim.drainEvents());
    if (stopWhen?.()) break;
  }
  return out;
}

describe('bots play by the same rules as humans', () => {
  it('a rogue bot kicks an enemy cast', () => {
    const ctx = mk();
    const rogue = bot(ctx, 'rogue', 0, 0, 0);
    const mage = dummy(ctx, 'mage', 1, 2, 0);
    rogue.cooldowns.kidney_shot = 1e9; // otherwise the bot (rightly) stuns the caster instead of kicking
    ctx.sim.step(); // go live without letting the bot act yet, so the cast starts first
    ctx.sim.drainEvents();
    assert.ok(ctx.sim.useAbility(mage.id, 'frostbolt', rogue.id).ok);
    const ev = run(ctx, 1200);
    assert.ok(ev.some((e) => e.t === 'interrupt' && e.src === rogue.id && e.tgt === mage.id), 'kick should land mid-cast');
  });

  it('a mage bot counterspells a healer mid-cast', () => {
    const ctx = mk();
    const mage = bot(ctx, 'mage', 0, -8, 0);
    const priest = dummy(ctx, 'priest', 1, 8, 0);
    const ally = dummy(ctx, 'warrior', 1, 9, 2);
    ally.health = Math.round(ally.maxHealth * 0.3);
    run(ctx, TICK);
    assert.ok(ctx.sim.useAbility(priest.id, 'flash_heal', ally.id).ok);
    const ev = run(ctx, 1000);
    assert.ok(ev.some((e) => e.t === 'interrupt' && e.src === mage.id && e.ability === 'flash_heal'));
  });

  it('a priest bot dispels crowd control off its partner', () => {
    const ctx = mk();
    const priest = bot(ctx, 'priest', 0, 0, 0);
    const mageAlly = dummy(ctx, 'mage', 0, 4, 0);
    const foe = dummy(ctx, 'mage', 1, 20, 0);
    run(ctx, TICK);
    ctx.sim.applyAura(foe, mageAlly, 'polymorph');
    const ev = run(ctx, 1500);
    assert.ok(ev.some((e) => e.t === 'dispel' && e.src === priest.id && e.aura === 'polymorph'));
  });

  it('a priest bot heals a hurt partner and shields before big damage', () => {
    const ctx = mk();
    const priest = bot(ctx, 'priest', 0, 0, 0);
    const ally = dummy(ctx, 'warrior', 0, 4, 0);
    dummy(ctx, 'rogue', 1, 25, 0);
    run(ctx, TICK);
    ally.health = Math.round(ally.maxHealth * 0.4);
    const ev = run(ctx, 4500); // shield first (1.5s GCD), then a 1.5s Flash Heal cast
    assert.ok(ev.some((e) => e.t === 'heal' && e.src === priest.id && e.tgt === ally.id));
    assert.ok(ev.some((e) => e.t === 'cast' && e.ability === 'power_word_shield'));
  });

  it('a warrior bot paths around a pillar and gets to melee', () => {
    const ctx = mk();
    const war = bot(ctx, 'warrior', 0, -14, -7);
    const foe = dummy(ctx, 'rogue', 1, -6, -7); // pillar at (-10,-7) blocks the straight line
    run(ctx, 20000, () => foe.health < foe.maxHealth);
    assert.ok(foe.health < foe.maxHealth, `warrior never reached the target (at ${war.pos.x.toFixed(1)},${war.pos.z.toFixed(1)})`);
  });

  it('a mage bot walks around a pillar to get line of sight', () => {
    const ctx = mk();
    bot(ctx, 'mage', 0, -14, -7);
    const foe = dummy(ctx, 'warrior', 1, -6, -7);
    run(ctx, 10000, () => foe.health < foe.maxHealth);
    assert.ok(foe.health < foe.maxHealth, 'mage should have found a angle and cast');
  });

  it('a priest bot on its own moves and casts at its enemy instead of standing still', () => {
    const ctx = mk();
    const priest = bot(ctx, 'priest', 0, -10, 0);
    const foe = dummy(ctx, 'warrior', 1, 12, 0);
    const start = { ...priest.pos };
    let travelled = 0;
    let last = { ...priest.pos };
    const ev = run(ctx, 12000, () => {
      travelled += Math.hypot(priest.pos.x - last.x, priest.pos.z - last.z);
      last = { ...priest.pos };
      return false;
    });
    assert.ok(travelled > 2, `priest moved ${travelled.toFixed(1)} yards`);
    assert.ok(ev.some((e) => e.t === 'cast' && e.unit === priest.id && e.ability === 'smite'), 'a lone priest smites');
    assert.ok(foe.health < foe.maxHealth);
    void start;
  });

  it('only stealth and shield are used before the gates open', () => {
    const ctx = mk(3000);
    bot(ctx, 'rogue', 0, -24, 0);
    bot(ctx, 'priest', 0, -24, 3);
    bot(ctx, 'mage', 1, 24, 0);
    bot(ctx, 'warrior', 1, 24, 3);
    const ev = run(ctx, 2900);
    const casts = ev.filter((e) => e.t === 'cast');
    assert.ok(casts.length > 0);
    for (const c of casts) assert.ok(c.t === 'cast' && ['stealth', 'power_word_shield'].includes(c.ability), `unexpected prep cast ${c.t === 'cast' ? c.ability : ''}`);
  });
});

describe('bot matches', () => {
  const comps: [ClassId[], ClassId[]][] = [
    [['warrior', 'rogue'], ['mage', 'mage']],
    [['mage', 'priest'], ['rogue', 'rogue']],
    [['warrior', 'priest'], ['rogue', 'mage']],
  ];

  function match(a: ClassId[], b: ClassId[], seed: number) {
    const ctx = { sim: new ArenaSim({ seed, prepMs: 3000 }), bots: [] as Bot[] };
    [a, b].forEach((comp, team) => {
      for (const classId of comp) {
        const u = ctx.sim.addUnit({ name: classId, classId, team: team as TeamId, controller: 'bot' });
        ctx.bots.push(new Bot(ctx.sim, u.id, 'normal', seed * 31 + u.id));
      }
    });
    const events = run(ctx, 400000, () => ctx.sim.phase === 'ended');
    return { ctx, events };
  }

  it('finish with a winner and only walk out of a cast to reach cover', () => {
    for (const [a, b] of comps) {
      for (const seed of [1, 2, 3]) {
        const { ctx, events } = match(a, b, seed);
        assert.equal(ctx.sim.phase, 'ended', `${a}+${b} seed ${seed} did not finish`);
        assert.notEqual(ctx.sim.winner, 'draw', `${a} vs ${b} seed ${seed} was a draw`);
        const walked = events.filter((e) => e.t === 'cast_fail' && e.reason === 'moved');
        assert.ok(walked.length <= 8, `${a} vs ${b} seed ${seed}: ${walked.length} casts walked out of (only a hurt bot running for cover may do that)`);
      }
    }
  });

  it('are deterministic for a given seed', () => {
    const snap = () => {
      const { ctx } = match(['mage', 'priest'], ['warrior', 'rogue'], 5);
      return JSON.stringify([ctx.sim.snapshot(), ctx.sim.winner]);
    };
    assert.equal(snap(), snap());
  });
});

describe('bot movement (v0.24)', () => {
  it('a hurt bot ducks behind a pillar out of its enemy\'s sight', async () => {
    const { hasLOS } = await import('../src/index');
    const ctx = mk();
    const mage = bot(ctx, 'mage', 0, -14, 0);
    const foe = dummy(ctx, 'warrior', 1, -2, 0);
    mage.health = Math.round(mage.maxHealth * 0.3);
    let hidden = false;
    run(ctx, 6000, () => {
      if (!hasLOS(mage.pos, foe.pos, ctx.sim.arena)) hidden = true;
      return hidden;
    });
    assert.ok(hidden, 'broke line of sight');
  });
  it('a bot in melee range keeps moving instead of standing still', () => {
    const ctx = mk();
    const w = bot(ctx, 'warrior', 0, 0, 0);
    dummy(ctx, 'mage', 1, 2.5, 0);
    run(ctx, 1500);
    const p0 = { ...w.pos };
    run(ctx, 1000);
    assert.ok(Math.hypot(w.pos.x - p0.x, w.pos.z - p0.z) > 0.3);
  });
});
