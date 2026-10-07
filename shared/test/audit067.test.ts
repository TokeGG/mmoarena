import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABILITIES, ArenaSim, AURAS, Bot, CLASS_IDS, SPECS, TUNING, arenaById, botBuild, brainFor, clampBrain, compileMods, freshenPopulation, isRotationAbility,
  newPopulation, rotationDamage, rotationFor, talentsFor, withAuraMods,
} from '../src/index';
import type { Brain, ClassId, SimEvent, TeamId, Unit } from '../src/index';
import { navRoute } from '../src/nav';

/** Regression tests for the 0.67 audit (bots and balance) and the bot behaviour asked for alongside it. */

const TICK = TUNING.tickMs;
const SPEC: Record<ClassId, string> = { warrior: 'arms', mage: 'frost', priest: 'discipline', rogue: 'assassination' };
const unit = (sim: ArenaSim, classId: ClassId, team: TeamId, x: number, z: number, controller: 'bot' | 'dummy' | 'player' = 'bot', spec = SPEC[classId]): Unit => {
  const u = sim.addUnit({ name: `${classId}${team}`, classId, team, controller, build: { spec, talents: [], gear: {} } });
  u.pos = { x, z };
  return u;
};
const play = (sim: ArenaSim, bots: Bot[], ms: number, onEvents?: (e: SimEvent[]) => void) => {
  for (let t = 0; t < ms; t += TICK) {
    for (const b of bots) b.tick();
    sim.step();
    const ev = sim.drainEvents();
    onEvents?.(ev);
  }
};
const brain = (cls: ClassId, b: Partial<Brain>): Brain => ({ ...brainFor(cls), ...b });

describe('0.67 balance', () => {
  it('Exsanguinate sets bleeds to x3 and using it again does not compound', () => {
    const sim = new ArenaSim({ seed: 1, prepMs: 0 });
    const r = unit(sim, 'rogue', 0, 0, 0, 'player');
    const foe = unit(sim, 'warrior', 1, 0, 2, 'dummy');
    foe.maxHealth = foe.health = 1e6;
    r.bar = [...r.bar.slice(0, 6), 'garrote', 'exsanguinate'];
    sim.step();
    assert.ok(sim.useAbility(r.id, 'garrote', foe.id).ok);
    for (let i = 0; i < 2; i++) {
      r.cooldowns = {}; r.gcdEnd = 0; r.resource = r.resourceMax; r.cp = 3;
      assert.ok(sim.useAbility(r.id, 'exsanguinate', foe.id).ok);
    }
    assert.equal(foe.auras.find((a) => a.id === 'garrote_bleed')!.dotMult, 3);
  });

  it('Charge\'s stun has its own diminishing returns; Slice and Dice\'s stun is in the stun group', () => {
    assert.equal(AURAS.charge_stun.dr, 'charge');
    assert.equal(AURAS.slice_stun.dr, 'stun');
    const sim = new ArenaSim({ seed: 2, prepMs: 0 });
    const w = unit(sim, 'warrior', 0, 0, 0, 'player');
    const t = unit(sim, 'mage', 1, 2, 0, 'dummy');
    sim.step();
    sim.applyAura(w, t, 'charge_stun');
    t.auras = [];
    const ks = sim.applyAura(w, t, 'kidney_shot');
    assert.ok(ks.applied && ks.dr === 1, 'a Kidney Shot right after a Charge is still full length');
  });

  it('Holy Nova reaches 12 yards; Ice Barrier absorbs 25% of max health', () => {
    assert.equal(ABILITIES.holy_nova.radius, 12);
    assert.equal(AURAS.ice_barrier.absorbPct, 0.25);
  });

  it('friendly spells need no facing: a shield on the ally behind you works', () => {
    const sim = new ArenaSim({ seed: 3, prepMs: 0, facing: true });
    const p = unit(sim, 'priest', 0, 0, 0, 'player');
    const ally = unit(sim, 'warrior', 0, 0, -6, 'dummy');
    const foe = unit(sim, 'mage', 1, 0, -12, 'dummy');
    sim.step();
    p.facing = 0; // looking at +z, both are behind
    p.lastInput = { ...p.lastInput, facing: 0 };
    assert.ok(sim.useAbility(p.id, 'power_word_shield', ally.id).ok);
    assert.ok(ally.auras.some((a) => a.kind === 'absorb'), 'shielded at once, not held for facing');
    p.gcdEnd = 0;
    sim.useAbility(p.id, 'smite', foe.id);
    assert.equal(p.cast, null, 'an enemy behind you still needs facing');
  });

  it('the same debuff from two sources counts once', () => {
    const base = compileMods('priest', { spec: 'holy', talents: [], gear: {} });
    assert.equal(withAuraMods(base, ['mortal_wounds', 'mortal_wounds']).healingTaken, 0.6);
    assert.ok(Math.abs(withAuraMods(base, ['power_infusion', 'power_infusion']).damageDone - base.damageDone * 1.2) < 1e-9);
  });

  it('no tier I talent buffs only a skill that a later tier of that spec always removes', () => {
    for (const cls of CLASS_IDS) for (const sp of SPECS[cls]) {
      const tiers = talentsFor(cls, sp.id);
      const alwaysGone = new Set<string>();
      for (const tier of tiers.slice(3)) {
        const froms = new Set(tier.map((t) => t.swap?.from));
        if (froms.size === 1 && [...froms][0]) alwaysGone.add([...froms][0]!);
      }
      for (const t of tiers[0]) {
        const touched = [...Object.keys(t.mods?.ability ?? {}), ...Object.keys(t.mods?.auraDuration ?? {}).map((a) => Object.keys(ABILITIES).find((id) => ABILITIES[id].effects.some((e) => e.type === 'aura' && e.aura === a)) ?? a)];
        assert.ok(touched.some((id) => !alwaysGone.has(id)), `${sp.id}: ${t.id} only touches ${touched.join(', ')}, which a later tier replaces`);
      }
    }
  });
});

describe('0.67 bots: builds, brains and rotations', () => {
  it('bots take talents, so tier IV-VI swaps show up on bot bars', () => {
    const swapped = new Set<string>();
    for (const cls of CLASS_IDS) for (let s = 0; s < 60; s++) {
      const b = botBuild(cls, s);
      assert.equal(b.talents.length, 6);
      const tiers = talentsFor(cls, b.spec);
      b.talents.forEach((id, i) => { const t = tiers[i].find((x) => x.id === id); if (t?.swap) swapped.add(t.swap.to); });
    }
    assert.ok(swapped.size >= 30, `many different swaps in play (${swapped.size})`);
  });

  it('a stored brain from an older version is completed from the trained baseline, not left with holes', () => {
    const pop = newPopulation('mage', Math.random);
    const old = pop.variants[0].brain as Partial<Brain>;
    delete old.preShield;
    delete old.dodge;
    delete old.jukeChance;
    freshenPopulation(pop);
    const b = pop.variants[0].brain;
    assert.equal(b.preShield, brainFor('mage').preShield);
    assert.equal(b.dodge, brainFor('mage').dodge);
    assert.equal(typeof b.jukeChance, 'number');
    assert.equal(clampBrain({ dodge: 0.2 }, brainFor('rogue')).defHp, brainFor('rogue').defHp);
  });

  it('learned rotations deal at least as much as the bar order, and never hold crowd control or finishers', () => {
    for (const cls of CLASS_IDS) for (const sp of SPECS[cls]) {
      const order = rotationFor(cls, sp.id, sp.bar);
      assert.ok(order, `${cls}:${sp.id} has a learned rotation`);
      for (const id of order!) assert.ok(isRotationAbility(id), `${id} is filler`);
      const build = { spec: sp.id, talents: [], gear: {} };
      const plain = sp.bar.filter(isRotationAbility);
      assert.ok(rotationDamage(cls, build, order!, 20) >= rotationDamage(cls, build, plain, 20) * 0.97, `${cls}:${sp.id}`);
    }
  });

  it('every ability on a bot\'s bar gets used in bot matches, talent swaps included', () => {
    const onBar = new Set<string>();
    const cast = new Set<string>();
    let seed = 1;
    for (let m = 0; m < 70; m++) {
      const size = 1 + (m % 3);
      const sim = new ArenaSim({ seed: m + 1, prepMs: 1000 });
      const bots: Bot[] = [];
      for (const team of [0, 1] as TeamId[]) for (let i = 0; i < size; i++) {
        const cls = CLASS_IDS[(m * 7 + i * 3 + team) % 4];
        const u = sim.addUnit({ name: cls, classId: cls, team, controller: 'bot', build: botBuild(cls, seed++) });
        for (const a of u.bar) onBar.add(a);
        bots.push(new Bot(sim, u.id, 'hard', seed * 13));
      }
      while (sim.phase !== 'ended' && sim.time < 120000) {
        for (const b of bots) b.tick();
        sim.step();
        for (const e of sim.drainEvents()) if (e.t === 'cast_start' || e.t === 'cast') cast.add(e.ability);
      }
    }
    const never = [...onBar].filter((a) => !cast.has(a));
    assert.deepEqual(never, [], `never cast: ${never.join(', ')}`);
  });
});

describe('0.67 bots: interrupts and jukes', () => {
  it('a caster fakes a cast when an enemy kick is ready and in reach, then stops it', () => {
    const sim = new ArenaSim({ seed: 4, prepMs: 0 });
    const m = unit(sim, 'mage', 0, 0, 0);
    const r = unit(sim, 'rogue', 1, 2.5, 0, 'dummy');
    r.maxHealth = r.health = 1e6;
    sim.step();
    const bot = new Bot(sim, m.id, 'hard', 3, brain('mage', { jukeChance: 1, jukeAt: 0.4, preShield: 0.5 }));
    m.cooldowns.frost_nova = m.cooldowns.blink = m.cooldowns.deep_freeze = m.cooldowns.ice_lance = 1e9;
    let faked = false;
    play(sim, [bot], 4000, (ev) => { if (ev.some((e) => e.t === 'cast_fail' && e.unit === m.id && e.reason === 'cancelled')) faked = true; });
    assert.ok(faked, 'the mage started a cast and stopped it itself');
  });

  it('an interrupter waits into the cast (kickAt), and waits longer for someone who has faked before', () => {
    const run = (kickAt: number, jukes: number) => {
      const sim = new ArenaSim({ seed: 5, prepMs: 0 });
      const r = unit(sim, 'rogue', 0, 0, 0);
      const m = unit(sim, 'mage', 1, 2, 0, 'player');
      sim.step();
      r.cooldowns.kidney_shot = 1e9;
      const bot = new Bot(sim, r.id, 'hard', 9, brain('rogue', { kickAt }));
      if (jukes) (bot as any).jukers.set(m.id, jukes);
      assert.ok(sim.useAbility(m.id, 'polymorph', r.id).ok);
      const start = sim.time;
      let at = -1;
      play(sim, [bot], 2000, (ev) => { if (at < 0 && ev.some((e) => e.t === 'interrupt' && e.src === r.id)) at = sim.time - start; });
      return at;
    };
    const early = run(0, 0);
    const late = run(0.7, 0);
    const wary = run(0.3, 3);
    const plain = run(0.3, 0);
    assert.ok(early > 0 && late > 0, `both kicked (${early}, ${late})`);
    assert.ok(late > early + 500, `waited into the cast (${early} vs ${late})`);
    assert.ok(wary > plain, `a known faker is waited out longer (${plain} vs ${wary})`);
  });

  it('a bot notices a faked cast and remembers the faker', () => {
    const sim = new ArenaSim({ seed: 6, prepMs: 0 });
    const r = unit(sim, 'rogue', 0, 0, 0);
    const m = unit(sim, 'mage', 1, 2, 0, 'player');
    sim.step();
    const bot = new Bot(sim, r.id, 'hard', 9, brain('rogue', { kickAt: 0.85 }));
    r.cooldowns.kick = 1e9; // it cannot kick this time; it just watches
    assert.ok(sim.useAbility(m.id, 'frostbolt', r.id).ok);
    play(sim, [bot], 300);
    sim.stopCast(m.id);
    play(sim, [bot], 200);
    assert.equal((bot as any).jukers.get(m.id), 1);
  });
});

describe('0.67 bots: line of sight and movement', () => {
  it('a bot targeted by a Polymorph steps behind a pillar so the cast fails', () => {
    const arena = arenaById('colosseum');
    const sim = new ArenaSim({ seed: 7, prepMs: 0, arena });
    const pil = arena.pillars[0];
    const w = unit(sim, 'warrior', 0, pil.x + pil.r + 2.5, pil.z - 3);
    const m = unit(sim, 'mage', 1, pil.x + pil.r + 20, pil.z - 3, 'player');
    sim.step();
    const bot = new Bot(sim, w.id, 'hard', 4, brain('warrior', { losUse: 1 }));
    w.cooldowns.charge = w.cooldowns.heroic_leap = 1e9; // no charging in: the only way out is the pillar
    assert.ok(sim.useAbility(m.id, 'polymorph', w.id).ok);
    let failed = false;
    play(sim, [bot], 2200, (ev) => { if (ev.some((e) => e.t === 'cast_fail' && e.unit === m.id && /sight/.test(e.reason))) failed = true; });
    assert.ok(failed, 'the Polymorph lost its target behind the pillar');
    assert.ok(!w.auras.some((a) => a.id === 'polymorph'));
  });

  it('a melee bot under an enemy up on a walkway takes the ramp instead of waiting below', () => {
    const arena = arenaById('colosseum');
    const sim = new ArenaSim({ seed: 8, prepMs: 0, arena });
    const w = unit(sim, 'warrior', 0, 0, 10);
    const t = unit(sim, 'mage', 1, 0, 17, 'dummy');
    t.level = 1;
    t.maxHealth = t.health = 1e6;
    sim.step();
    const bot = new Bot(sim, w.id, 'hard', 5);
    w.cooldowns.charge = w.cooldowns.heroic_leap = 1e9; // walk, do not leap
    let up = false;
    play(sim, [bot], 15000, () => { if (w.level === 1) up = true; });
    assert.ok(up, 'it climbed onto the walkway');
    assert.ok(t.health < t.maxHealth, 'and hit the target up there');
  });

  it('a route over a barricade aims at the far side, not into the barricade', () => {
    const arena = [...['overlook', 'ruins', 'frost', 'serpent', 'ring', 'terraces', 'colosseum']].map(arenaById).find((a) => a.lows?.length)!;
    const low = arena.lows![0];
    const horizontal = low.x1 - low.x0 > low.z1 - low.z0;
    const mid = { x: (low.x0 + low.x1) / 2, z: (low.z0 + low.z1) / 2 };
    const from = horizontal ? { x: mid.x, z: low.z0 - 1.2 } : { x: low.x0 - 1.2, z: mid.z };
    const to = horizontal ? { x: mid.x, z: low.z1 + 6 } : { x: low.x1 + 6, z: mid.z };
    const r = navRoute(arena, from, 0, to, 0);
    assert.ok(r);
    const inside = r!.point.x > low.x0 - 0.5 && r!.point.x < low.x1 + 0.5 && r!.point.z > low.z0 - 0.5 && r!.point.z < low.z1 + 0.5;
    assert.ok(!inside || !r!.jump, `the jump aims past the barricade (${JSON.stringify(r)})`);
  });

  it('a Shadow priest with a partner fights instead of hanging back like a healer', () => {
    const sim = new ArenaSim({ seed: 9, prepMs: 0 });
    const p = unit(sim, 'priest', 0, -10, 0, 'bot', 'shadow');
    const mate = unit(sim, 'warrior', 0, -12, 3, 'dummy');
    const foe = unit(sim, 'warrior', 1, 14, 0, 'dummy');
    foe.maxHealth = foe.health = 1e6;
    void mate;
    sim.step();
    const bot = new Bot(sim, p.id, 'hard', 6);
    play(sim, [bot], 20000);
    assert.ok(foe.maxHealth - foe.health > 1500, `shadow damage dealt: ${foe.maxHealth - foe.health}`);
  });

  it('a priest does not spend Dispersion on a mere root at full health', () => {
    const sim = new ArenaSim({ seed: 10, prepMs: 0 });
    const p = unit(sim, 'priest', 0, 0, 0, 'bot', 'shadow');
    const m = unit(sim, 'mage', 1, 12, 0, 'dummy');
    sim.step();
    sim.applyAura(m, p, 'frost_nova_root');
    const bot = new Bot(sim, p.id, 'hard', 6);
    play(sim, [bot], 1500);
    assert.ok(!p.auras.some((a) => a.id === 'dispersion'));
  });

  it('bots keep moving between casts (no standing still at range) and still do not spin', () => {
    const sim = new ArenaSim({ seed: 11, prepMs: 0 });
    // a melee fighter has no casts to stand still for: it should circle and step all the time
    const m = unit(sim, 'rogue', 0, -10, 0);
    const foe = unit(sim, 'warrior', 1, 12, 0, 'dummy');
    foe.maxHealth = foe.health = 1e6;
    sim.step();
    const bot = new Bot(sim, m.id, 'hard', 2, brain('rogue', { mobility: 1, strafe: 0.8 }));
    let idleTicks = 0, ticks = 0;
    let last = { ...m.pos };
    play(sim, [bot], 15000, () => {
      const d = Math.hypot(m.pos.x - last.x, m.pos.z - last.z);
      if (!m.cast) {
        if (d < 1e-3) idleTicks++;
        ticks++;
      }
      last = { ...m.pos };
    });
    assert.ok(ticks > 0 && idleTicks / ticks < 0.35, `rarely stands still while not casting (${(idleTicks / ticks).toFixed(2)} of ${ticks})`);
  });

  it('easy bots are clearly weaker than hard ones', () => {
    let hard = 0;
    for (let s = 1; s <= 6; s++) {
      const sim = new ArenaSim({ seed: s, prepMs: 1000 });
      const a = sim.addUnit({ name: 'h', classId: 'rogue', team: 0, controller: 'bot', build: botBuild('rogue', s, false) });
      const b = sim.addUnit({ name: 'e', classId: 'rogue', team: 1, controller: 'bot', build: botBuild('rogue', s, false) });
      const bots = [new Bot(sim, a.id, 'hard', s), new Bot(sim, b.id, 'easy', s + 50)];
      while (sim.phase !== 'ended' && sim.time < 150000) { for (const x of bots) x.tick(); sim.step(); sim.drainEvents(); }
      if (sim.winner === 0) hard++;
    }
    assert.ok(hard >= 5, `hard beat easy ${hard} of 6`);
  });
});

describe('global cooldown on a stopped cast', () => {
  it('moving out of a cast gives the global cooldown back; an interrupt does not', () => {
    const sim = new ArenaSim({ seed: 12, prepMs: 0 });
    const m = sim.addUnit({ name: 'm', classId: 'mage', team: 0, controller: 'player', build: { spec: 'frost', talents: [], gear: {} } });
    const w = sim.addUnit({ name: 'w', classId: 'warrior', team: 1, controller: 'dummy' });
    m.pos = { x: 0, z: 0 };
    w.pos = { x: 20, z: 0 };
    sim.step();
    assert.ok(sim.useAbility(m.id, 'frostbolt', w.id).ok);
    assert.ok(m.gcdEnd > sim.time);
    sim.queueInput(m.id, { seq: 1, fwd: 1, strafe: 0, facing: Math.PI / 2 });
    sim.step();
    assert.equal(m.cast, null, 'moving stopped the cast');
    assert.ok(m.gcdEnd <= sim.time, 'and the global cooldown is free again');
    assert.ok(sim.useAbility(m.id, 'ice_lance', w.id).ok, 'an instant goes off at once');

    m.gcdEnd = 0;
    m.pos = { x: 0, z: 0 };
    sim.queueInput(m.id, { seq: 2, fwd: 0, strafe: 0, facing: Math.PI / 2 });
    sim.step();
    assert.ok(sim.useAbility(m.id, 'frostbolt', w.id).ok);
    const r = sim.addUnit({ name: 'r', classId: 'rogue', team: 1, controller: 'player', build: { spec: 'assassination', talents: [], gear: {} } });
    r.pos = { x: 1, z: 0 };
    assert.ok(sim.useAbility(r.id, 'kick', m.id).ok);
    assert.ok(m.gcdEnd > sim.time, 'kicked: the global cooldown stays');
  });
});

describe('Slice and Dice and diminishing returns', () => {
  it('holds its target for the whole channel; diminishing returns shorten the hold as one block', () => {
    const sim = new ArenaSim({ seed: 13, prepMs: 0 });
    const w = sim.addUnit({ name: 'w', classId: 'warrior', team: 0, controller: 'player', build: { spec: 'arms', talents: [], gear: {} } });
    const t = sim.addUnit({ name: 't', classId: 'rogue', team: 1, controller: 'player', build: { spec: 'assassination', talents: [], gear: {} } });
    t.maxHealth = t.health = 1e6;
    w.pos = { x: 0, z: 0 };
    sim.step();
    let seq = 1;
    /** Spin once with the target trying to walk away and swing; returns how long (ms) it was held from the start. */
    const spin = () => {
      t.pos = { x: 0, z: 2.5 };
      w.facing = 0;
      w.lastInput = { ...w.lastInput, facing: 0 };
      w.resource = 100; w.cooldowns = {}; w.gcdEnd = 0;
      assert.ok(sim.useAbility(w.id, 'slice_and_dice').ok);
      const start = sim.time;
      let heldUntil = start;
      let swung = false;
      for (let i = 0; i < 100 && w.cast; i++) {
        sim.queueInput(w.id, { seq, fwd: 0, strafe: 0, facing: 0 });
        sim.queueInput(t.id, { seq: seq++, fwd: 0, strafe: 1, facing: Math.PI });
        if (!sim.canAct(t)) heldUntil = sim.time;
        else if (sim.useAbility(t.id, 'mutilate', w.id).ok) swung = true;
        sim.step();
        sim.drainEvents();
      }
      return { held: heldUntil - start, swung, moved: Math.hypot(t.pos.x, t.pos.z - 2.5) };
    };
    const first = spin();
    assert.ok(first.held >= 3900, `held for the whole first channel (${first.held} ms)`);
    assert.ok(!first.swung, 'could not swing back');
    assert.ok(first.moved < 0.01, 'could not walk out');
    assert.equal(t.dr.stun!.count, 1, 'and it counts as one step');
    const second = spin();
    assert.ok(second.held >= 1800 && second.held <= 2300, `the second cast holds about half as long, in one piece (${second.held} ms)`);
  });
});
