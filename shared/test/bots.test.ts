import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, ArenaSim, Bot, DEFAULT_BRAIN, MARKS, TUNING, clampBrain, hasLOS, newPopulation, recordResult } from '../src/index';
import type { ClassId, Difficulty, SimEvent, TeamId, Unit } from '../src/index';

const TICK = 16;

function mk(prepMs = 0) {
  return { sim: new ArenaSim({ seed: 7, prepMs, tickMs: 16 }), bots: [] as Bot[] };
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

  it('bots do not spin: facing changes slowly in every class pairing', () => {
    const classes: ClassId[] = ['warrior', 'mage', 'priest', 'rogue'];
    for (const a of classes) {
      for (const b of ['warrior', 'mage', 'rogue'] as ClassId[]) {
        const ctx = mk();
        const ua = bot(ctx, a, 0, -10, 0);
        bot(ctx, b, 1, 10, 0);
        ctx.sim.step();
        ctx.sim.drainEvents();
        let last = ua.facing;
        let turned = 0;
        const secs = 20;
        for (let t = 0; t < secs * 1000 && ctx.sim.phase !== 'ended'; t += TICK) {
          for (const x of ctx.bots) x.tick();
          ctx.sim.step();
          let dA = Math.abs(ua.facing - last) % (Math.PI * 2);
          if (dA > Math.PI) dA = Math.PI * 2 - dA;
          turned += dA;
          last = ua.facing;
        }
        assert.ok(turned / secs < 2.5, `${a} vs ${b} turned ${(turned / secs).toFixed(2)} rad/s`);
      }
    }
  });

  it('a kiting bot does not back into a wall: it slides along it or turns', () => {
    const ctx = mk();
    const b = ctx.sim.arena.bounds;
    const mage = bot(ctx, 'mage', 0, b.minX + 1.2, 0);
    mage.facing = Math.PI / 2; // facing +x, so backing up means running into the west wall
    const out = (ctx.bots[0] as any).wallGuard(mage, { facing: mage.facing, fwd: -1, strafe: 0, guard: true });
    assert.ok(!(out.fwd < 0 && out.strafe === 0), `kept backing into the wall: ${JSON.stringify(out)}`);
  });

  it('a mage bot counterspells a healer mid-cast', () => {
    const ctx = mk();
    const mage = bot(ctx, 'mage', 0, -8, 0);
    const priest = dummy(ctx, 'priest', 1, 8, 0);
    const ally = dummy(ctx, 'warrior', 1, 9, 2);
    ally.health = Math.round(ally.maxHealth * 0.3);
    run(ctx, TICK);
    assert.ok(ctx.sim.useAbility(priest.id, 'flash_heal', ally.id).ok);
    // it may wait into the cast (kickAt, against fakes), but the heal never lands
    const ev = run(ctx, 1600);
    assert.ok(ev.some((e) => e.t === 'interrupt' && e.src === mage.id && e.ability === 'flash_heal'));
    assert.ok(!ev.some((e) => e.t === 'heal' && e.ability === 'flash_heal'), 'kicked before it landed');
  });

  it('a caster bot stops a cast once its target ducks out of sight, instead of finishing it into a pillar', () => {
    const ctx = mk();
    const mage = bot(ctx, 'mage', 0, -10, -16); // pillar at (-10, -7): the target hides straight behind it
    const foe = dummy(ctx, 'priest', 1, -16, -7);
    foe.maxHealth = foe.health = 1e6;
    const evs: SimEvent[] = [];
    // wait for a cast with a cast time to start on the foe
    evs.push(...run(ctx, 6000, () => !!mage.cast && (ABILITIES[mage.cast.ability]?.castTime ?? 0) > 0 && !ABILITIES[mage.cast.ability]?.channel));
    assert.ok(mage.cast, 'the mage started a cast');
    const ability = mage.cast!.ability;
    foe.pos = { x: -10, z: 1 }; // now behind the pillar from where the mage stands
    assert.ok(!hasLOS(mage.pos, foe.pos, ctx.sim.arena), 'hidden behind the pillar');
    const after = run(ctx, 1500);
    assert.ok(after.some((e) => e.t === 'cast_fail' && e.unit === mage.id && e.ability === ability && e.reason === 'cancelled'), 'it stopped the cast itself');
    assert.ok(!after.some((e) => e.t === 'cast_fail' && e.unit === mage.id && e.reason === 'no line of sight'), 'not finished into the pillar');
  });

  it('a bot runs out of an enemy Bladestorm instead of standing in it', () => {
    const ctx = mk();
    const r = bot(ctx, 'rogue', 0, 0, 0);
    const w = ctx.sim.addUnit({ name: 'w', classId: 'warrior', team: 1, controller: 'player', build: { spec: 'fury', talents: [], gear: {} } as never });
    w.pos = { x: 2, z: 0 };
    run(ctx, 1000);
    w.resource = 100;
    w.gcdEnd = 0;
    const res = ctx.sim.useAbility(w.id, 'bladestorm');
    assert.ok(res.ok, (res as { reason?: string }).reason);
    run(ctx, 1500);
    assert.ok(Math.hypot(r.pos.x - w.pos.x, r.pos.z - w.pos.z) > 7, `still in the spin at ${Math.hypot(r.pos.x - w.pos.x, r.pos.z - w.pos.z).toFixed(1)}`);
  });

  it('a spell cast on the move keeps the bot moving: a Bladestorming warrior chases its target', () => {
    const ctx = mk();
    const w = ctx.sim.addUnit({ name: 'w', classId: 'warrior', team: 0, controller: 'bot', build: { spec: 'fury', talents: [], gear: {} } as never });
    w.pos = { x: 0, z: 0 };
    ctx.bots.push(new Bot(ctx.sim, w.id, 'hard', 5));
    const foe = dummy(ctx, 'mage', 1, 2.5, 0);
    foe.maxHealth = foe.health = 1e6;
    run(ctx, TICK);
    w.resource = 100;
    w.gcdEnd = 0;
    assert.ok(ctx.sim.useAbility(w.id, 'bladestorm').ok);
    foe.pos = { x: 9, z: 0 }; // steps away mid-spin
    const from = { ...w.pos };
    run(ctx, 1200);
    assert.ok(w.cast?.ability === 'bladestorm', 'still spinning');
    assert.ok(Math.hypot(w.pos.x - from.x, w.pos.z - from.z) > 2.5, `followed it while spinning (moved ${Math.hypot(w.pos.x - from.x, w.pos.z - from.z).toFixed(1)})`);
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
    mage.health = Math.round(mage.maxHealth * 0.12);
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

describe('bots look after their lives', () => {
  it('a bot steps out of an enemy Flamestrike instead of standing in it', () => {
    const ctx = mk();
    const war = bot(ctx, 'priest', 0, 0, 0);
    ctx.bots[0] = new Bot(ctx.sim, war.id, 'hard', 100 + war.id, { ...DEFAULT_BRAIN, dodge: 0.7 }); // the behaviour under test, whatever training settled on
    const mage = ctx.sim.addUnit({ name: 'enemy mage', classId: 'mage', team: 1, controller: 'player' });
    mage.pos = { x: 0, z: 12 };
    mage.bar = ['flamestrike', ...mage.bar.slice(1)];
    ctx.sim.step();
    ctx.sim.drainEvents();
    mage.facing = Math.PI;
    const z = { x: war.pos.x, z: war.pos.z };
    const cast = ctx.sim.useAbility(mage.id, 'flamestrike', null, z);
    assert.ok(cast.ok, JSON.stringify(cast));
    run(ctx, 6000);
    const hz = ctx.sim.hazardsFor(0)[0];
    assert.ok(!hz || Math.hypot(war.pos.x - hz.x, war.pos.z - hz.z) >= hz.r, 'out of the zone');
  });

  it('a mage keeps Ice Barrier up as soon as enemies are around when its brain says so', () => {
    const ctx = mk();
    const brain = { ...DEFAULT_BRAIN, preShield: 1 };
    const m = ctx.sim.addUnit({ name: 'm', classId: 'mage', team: 0, controller: 'bot', build: { spec: 'frost', talents: [], gear: {} } });
    m.pos = { x: -10, z: 0 };
    ctx.bots.push(new Bot(ctx.sim, m.id, 'hard', 5, brain));
    dummy(ctx, 'warrior', 1, 10, 0);
    const ev = run(ctx, 3000);
    assert.ok(ev.some((e) => e.t === 'cast' && e.unit === m.id && e.ability === 'ice_barrier'), 'barrier at full health');
    assert.ok(m.auras.some((a) => a.id === 'ice_barrier') || m.health < m.maxHealth);
  });

  it('brains carry the new survival traits, clamped, and a fractional score counts in the learning record', () => {
    const b = clampBrain({ dodge: 5, preShield: -2 });
    assert.equal(b.dodge, 1);
    assert.equal(b.preShield, 0.5);
    assert.ok(clampBrain(undefined).dodge > 0);
    const rng = () => 0.5;
    const pop = newPopulation('mage', rng);
    const v = pop.variants[0];
    recordResult(pop, v.id, false, rng, 0.4);
    assert.ok(Math.abs(v.wins - 0.4) < 1e-9 && v.games === 1);
    recordResult(pop, v.id, true, rng, 0.9);
    assert.ok(Math.abs(v.wins - 1.3) < 1e-9);
  });
});


describe('bots follow the raid marks', () => {
  const setup = () => {
    const ctx = mk();
    const w = bot(ctx, 'warrior', 0, 0, 0);
    const near = dummy(ctx, 'mage', 1, 8, 0);
    const far = dummy(ctx, 'rogue', 1, 20, 0);
    return { ctx, w, near, far };
  };
  const targetOf = (ctx: Ctx, id: number) => ctx.sim.units.get(id)!.target;

  it('a skull on someone makes the DPS go for them, even when someone else is closer', () => {
    const { ctx, w, near, far } = setup();
    run(ctx, 1500);
    assert.equal(targetOf(ctx, w.id), near.id, 'with no mark it takes the nearer one');
    ctx.sim.raidMarks.set(0, new Map([[far.id, MARKS.findIndex((m) => m.id === 'skull') + 1]]));
    run(ctx, 600);
    assert.equal(targetOf(ctx, w.id), far.id, 'the skull is followed within a moment, not after the usual retarget delay');
  });

  it('a skull that moves to someone else is followed again, and a cross is the second choice', () => {
    const { ctx, w, near, far } = setup();
    const skull = MARKS.findIndex((m) => m.id === 'skull') + 1;
    const cross = MARKS.findIndex((m) => m.id === 'cross') + 1;
    ctx.sim.raidMarks.set(0, new Map([[far.id, skull]]));
    run(ctx, 1500);
    assert.equal(targetOf(ctx, w.id), far.id);
    ctx.sim.raidMarks.set(0, new Map([[near.id, skull]]));
    run(ctx, 600);
    assert.equal(targetOf(ctx, w.id), near.id);
    // the skull is dead: the cross is next
    near.health = 0;
    near.alive = false;
    ctx.sim.raidMarks.set(0, new Map([[far.id, cross]]));
    run(ctx, 3000);
    assert.equal(targetOf(ctx, w.id), far.id);
  });

  it('marks on the other team\'s bots are not followed', () => {
    const { ctx, w, near, far } = setup();
    ctx.sim.raidMarks.set(1, new Map([[far.id, MARKS.findIndex((m) => m.id === 'skull') + 1]]));
    run(ctx, 1500);
    assert.equal(targetOf(ctx, w.id), near.id);
  });
});
