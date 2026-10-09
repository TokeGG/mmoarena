import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, ArenaSim, AURAS, CLASSES, SPECS, TALENTS, TUNING, arenaById, parseClientMsg, talentsFor } from '../src/index';
import type { ClassId, SimEvent, TeamId, Unit } from '../src/index';

const TICK = TUNING.tickMs;

/** A live match (no prep phase) with the first step already taken. */
function live(seed = 1) {
  const sim = new ArenaSim({ seed, prepMs: 0 });
  return sim;
}
function add(sim: ArenaSim, classId: ClassId, team: TeamId, x: number, z: number, gearMult = 1): Unit {
  const u = sim.addUnit({ name: `${classId}${team}`, classId, team, gearMult });
  u.pos = { x, z };
  return u;
}
function advance(sim: ArenaSim, ms: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let t = 0; t < ms; t += TICK) {
    sim.step();
    out.push(...sim.drainEvents());
  }
  return out;
}
function mustFail(r: { ok: boolean; reason?: string }, reason: RegExp) {
  assert.equal(r.ok, false, 'expected failure');
  assert.match((r as { reason: string }).reason, reason);
}

describe('global cooldown and resources', () => {
  it('blocks a second GCD ability until 1.5s has passed', () => {
    const sim = live();
    const rogue = add(sim, 'rogue', 0, 0, 0);
    const war = add(sim, 'warrior', 1, 2, 0);
    advance(sim, TICK);
    assert.ok(sim.useAbility(rogue.id, 'sinister_strike', war.id).ok);
    mustFail(sim.useAbility(rogue.id, 'kidney_shot', war.id), /global cooldown/);
    advance(sim, TUNING.gcdMs);
    assert.ok(sim.useAbility(rogue.id, 'kidney_shot', war.id).ok);
  });

  it('refuses abilities you cannot afford', () => {
    const sim = live();
    const war = add(sim, 'warrior', 0, 0, 0);
    const rogue = add(sim, 'rogue', 1, 2, 0);
    advance(sim, TICK);
    mustFail(sim.useAbility(war.id, 'mortal_strike', rogue.id), /not enough rage/);
  });
});

describe('dev test cooldown switches', () => {
  it('reset clears every cooldown at once; off stops new ones from starting', () => {
    const sim = live();
    const rogue = add(sim, 'rogue', 0, 0, 0);
    const war = add(sim, 'warrior', 1, 2, 0);
    advance(sim, TICK);
    assert.ok(sim.useAbility(rogue.id, 'kick', war.id).ok);
    assert.ok((rogue.cooldowns.kick ?? 0) > sim.time);
    sim.resetCooldowns();
    assert.deepEqual(rogue.cooldowns, {});
    sim.noCooldowns = true;
    advance(sim, TUNING.gcdMs);
    assert.ok(sim.useAbility(rogue.id, 'kick', war.id).ok);
    assert.ok((rogue.cooldowns.kick ?? 0) <= sim.time, 'no cooldown started');
    advance(sim, TUNING.gcdMs);
    assert.ok(sim.useAbility(rogue.id, 'kick', war.id).ok, 'and it can be used again at once');
  });
});

describe('dev test quick resets', () => {
  it('health, resources, buffs, spawns and revive work on the whole match', () => {
    const sim = live();
    const rogue = add(sim, 'rogue', 0, 5, 5);
    const war = add(sim, 'warrior', 1, -5, 5);
    advance(sim, TICK);
    rogue.health = 10;
    rogue.resource = 0;
    sim.devReset('health');
    sim.devReset('resources');
    assert.equal(rogue.health, rogue.maxHealth);
    assert.equal(rogue.resource, rogue.resourceMax);
    war.auras.push({ id: 'hamstring', until: sim.time + 9000, stacks: 1, src: rogue.id } as any);
    war.dr = { stun: { count: 2, resetAt: sim.time + 9000 } } as any;
    sim.devReset('auras');
    assert.equal(war.auras.length, 0);
    assert.deepEqual(war.dr, {});
    sim.devReset('positions');
    assert.notDeepEqual(rogue.pos, { x: 5, z: 5 });
    war.alive = false;
    war.health = 0;
    sim.devReset('revive');
    assert.ok(war.alive && war.health === war.maxHealth);
  });
});

describe('casting, interrupts and school lockouts', () => {
  it('interrupts a cast, locks only that school, and kick on an idle target just misses', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0);
    const rogue = add(sim, 'rogue', 1, 3, 0);
    advance(sim, TICK);
    rogue.pos = { x: 1, z: 0 };
    assert.ok(sim.useAbility(rogue.id, 'kick', mage.id).ok, 'kick on an idle mage is allowed');
    assert.ok(advance(sim, TICK).some((e) => e.t === 'miss'), 'and misses');
    rogue.cooldowns = {};
    rogue.gcdEnd = 0;
    rogue.pos = { x: 3, z: 0 };

    assert.ok(sim.useAbility(mage.id, 'frostbolt', rogue.id).ok);
    advance(sim, 500);
    assert.ok(mage.cast, 'mage should be mid-cast');
    // rogue is in melee range after closing the gap
    rogue.pos = { x: 1, z: 0 };
    const r = sim.useAbility(rogue.id, 'kick', mage.id);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(mage.cast, null);
    const ev = sim.drainEvents();
    assert.ok(ev.some((e) => e.t === 'interrupt' && e.school === 'frost'));

    advance(sim, TUNING.gcdMs);
    mustFail(sim.useAbility(mage.id, 'frostbolt', rogue.id), /frost school is locked out/);
    assert.ok(sim.useAbility(mage.id, 'fireball', rogue.id).ok, 'fire must still be castable');
  });

  it('cancels a cast when the caster moves', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0);
    const war = add(sim, 'warrior', 1, 10, 0);
    advance(sim, TICK);
    assert.ok(sim.useAbility(mage.id, 'frostbolt', war.id).ok);
    sim.queueInput(mage.id, { seq: 1, fwd: 1, strafe: 0, facing: 0 });
    const ev = advance(sim, TICK);
    assert.equal(mage.cast, null);
    assert.ok(ev.some((e) => e.t === 'cast_fail' && e.reason === 'moved'));
  });

  it('completes a cast and deals damage', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0);
    const war = add(sim, 'warrior', 1, 10, 0);
    advance(sim, TICK);
    assert.ok(sim.useAbility(mage.id, 'frostbolt', war.id).ok);
    advance(sim, 1500 + TICK);
    assert.ok(war.health < war.maxHealth);
    assert.ok(war.auras.some((a) => a.id === 'frostbolt_slow'));
  });
});

describe('line of sight', () => {
  it('blocks casts through a pillar and allows them around it', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, -14, -7);
    const war = add(sim, 'warrior', 1, -6, -7); // pillar at (-10,-7) r=2.2 sits between them
    advance(sim, TICK);
    mustFail(sim.useAbility(mage.id, 'frostbolt', war.id), /line of sight/);
    war.pos = { x: -6, z: 0 };
    assert.ok(sim.useAbility(mage.id, 'frostbolt', war.id).ok);
  });
});

describe('crowd control and diminishing returns', () => {
  it('gives 100% / 50% / 25% / immune, and resets 18s after the CC ends', () => {
    const sim = live();
    const rogue = add(sim, 'rogue', 0, 0, 0);
    const tgt = add(sim, 'warrior', 1, 2, 0);
    advance(sim, TICK);
    const dur = () => {
      const r = sim.applyAura(rogue, tgt, 'kidney_shot');
      return r.applied ? r.duration : 'immune';
    };
    assert.equal(dur(), 2000);
    advance(sim, 2100);
    assert.equal(dur(), 1000);
    advance(sim, 1100);
    assert.equal(dur(), 500);
    advance(sim, 600);
    assert.equal(dur(), 'immune');
    advance(sim, TUNING.drResetMs + TICK);
    assert.equal(dur(), 2000, 'DR should have reset');
  });

  it('tracks each category separately', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0);
    const tgt = add(sim, 'warrior', 1, 5, 0);
    advance(sim, TICK);
    const a = sim.applyAura(mage, tgt, 'polymorph');
    const b = sim.applyAura(mage, tgt, 'frost_nova_root');
    assert.ok(a.applied && a.duration === 8000);
    assert.ok(b.applied && b.duration === 6000);
  });

  it('polymorph breaks on damage; stuns stop movement and casting', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0);
    const war = add(sim, 'warrior', 1, 5, 0);
    advance(sim, TICK);
    sim.applyAura(mage, war, 'polymorph');
    assert.equal(sim.speedMult(war), 0);
    sim.dealDamage(mage, war, 1, 'frost', null);
    assert.ok(!war.auras.some((a) => a.id === 'polymorph'));

    assert.ok(sim.useAbility(mage.id, 'frostbolt', war.id).ok);
    sim.applyAura(war, mage, 'kidney_shot');
    assert.equal(mage.cast, null, 'stun cancels the cast');
    mustFail(sim.useAbility(mage.id, 'fireball', war.id), /incapacitated/);
  });

  it('dispel removes crowd control from allies and shields from enemies', () => {
    const sim = live();
    const priest = add(sim, 'priest', 0, 0, 0);
    const mageAlly = add(sim, 'mage', 0, 3, 0);
    const enemy = add(sim, 'mage', 1, 10, 0);
    advance(sim, TICK);
    sim.applyAura(enemy, mageAlly, 'polymorph');
    assert.ok(sim.useAbility(priest.id, 'dispel_magic', mageAlly.id).ok);
    assert.ok(!mageAlly.auras.some((a) => a.id === 'polymorph'));

    advance(sim, 8100);
    mustFail(sim.useAbility(priest.id, 'dispel_magic', enemy.id), /nothing to dispel/);
    sim.applyAura(enemy, enemy, 'pw_shield');
    assert.ok(sim.useAbility(priest.id, 'dispel_magic', enemy.id).ok);
    assert.ok(!enemy.auras.some((a) => a.id === 'pw_shield'));
  });
});

describe('absorbs', () => {
  it('shield soaks damage then expires', () => {
    const sim = live();
    const priest = add(sim, 'priest', 0, 0, 0);
    const enemy = add(sim, 'rogue', 1, 3, 0);
    advance(sim, TICK);
    assert.ok(sim.useAbility(priest.id, 'power_word_shield', priest.id).ok);
    const absorb = AURAS.pw_shield.absorb!;
    const hit = absorb - 50;
    const full = priest.health;
    sim.dealDamage(enemy, priest, hit, 'physical', null);
    assert.equal(priest.health, full, 'first hit is fully absorbed');
    sim.dealDamage(enemy, priest, hit, 'physical', null);
    assert.equal(priest.health, full - (hit - 50), 'second hit only gets the 50 absorb left');
    assert.ok(!priest.auras.some((a) => a.kind === 'absorb'));
  });
});

describe('stealth', () => {
  it('hides stealthed enemies beyond detect range and untargetable until close', () => {
    const sim = live();
    const rogue = add(sim, 'rogue', 0, -20, 0);
    const mage = add(sim, 'mage', 1, 15, 0);
    advance(sim, TICK);
    assert.ok(sim.useAbility(rogue.id, 'stealth').ok);
    assert.ok(!sim.snapshot(1).units.some((u) => u.id === rogue.id), 'hidden from enemy team');
    assert.ok(sim.snapshot(0).units.some((u) => u.id === rogue.id), 'own team always sees it');
    mustFail(sim.useAbility(mage.id, 'frostbolt', rogue.id), /not visible/);
    rogue.pos = { x: 10, z: 0 };
    assert.ok(!sim.snapshot(1).units.some((u) => u.id === rogue.id), 'still hidden beyond 2 yards');
    rogue.pos = { x: 17, z: 0 };
    assert.ok(sim.snapshot(1).units.some((u) => u.id === rogue.id), 'revealed within 2 yards');
  });

  it('sinister strike and mutilate turn into cheap shot while stealthed, and only then', () => {
    for (const base of ['sinister_strike', 'mutilate']) {
      const sim = live();
      const rogue = add(sim, 'rogue', 0, 0, 0);
      const mage = add(sim, 'mage', 1, 2, 0);
      rogue.bar = ['stealth', base, 'kidney_shot', 'kick', 'sprint'];
      advance(sim, TICK);
      mustFail(sim.useAbility(rogue.id, 'cheap_shot', mage.id), /requires stealth/);
      assert.ok(sim.useAbility(rogue.id, 'stealth').ok);
      assert.ok(sim.useAbility(rogue.id, 'cheap_shot', mage.id).ok, `${base} slot opens with Cheap Shot`);
      assert.ok(mage.auras.some((a) => a.id === 'cheap_shot_stun'));
    }
    const sim = live();
    const rogue = add(sim, 'rogue', 0, 0, 0);
    const mage = add(sim, 'mage', 1, 2, 0);
    rogue.bar = ['stealth', 'kidney_shot', 'kick', 'sprint'];
    advance(sim, TICK);
    sim.useAbility(rogue.id, 'stealth');
    mustFail(sim.useAbility(rogue.id, 'cheap_shot', mage.id), /unknown ability/);
  });

  it('damage over time does not break fear, but direct damage does', () => {
    const sim = live();
    const priest = add(sim, 'priest', 0, 0, 0);
    const mage = add(sim, 'mage', 1, 2, 0);
    advance(sim, TICK);
    sim.applyAura(priest, mage, 'psychic_scream');
    assert.ok(mage.auras.some((x) => x.id === 'psychic_scream'));
    sim.applyAura(priest, mage, 'creeping_rot');
    const hp = mage.health;
    advance(sim, 4000);
    assert.ok(mage.health < hp, 'the rot ticked');
    assert.ok(mage.auras.some((x) => x.id === 'psychic_scream'), 'fear survived the ticks');
    sim.dealDamage(priest, mage, 20, 'holy', null);
    assert.ok(!mage.auras.some((x) => x.id === 'psychic_scream'), 'a direct hit breaks it');
  });

  it('Devouring Plague\'s initial hit does not break fear', () => {
    const sim = live();
    const priest = add(sim, 'priest', 0, 0, 0);
    const mage = add(sim, 'mage', 1, 2, 0);
    priest.bar = [...priest.bar.slice(0, 7), 'plague_bloom'];
    advance(sim, TICK);
    priest.facing = Math.PI / 2; priest.lastInput = { ...priest.lastInput, facing: Math.PI / 2 };
    sim.applyAura(priest, mage, 'psychic_scream');
    const hp = mage.health;
    assert.ok(sim.useAbility(priest.id, 'plague_bloom', mage.id).ok);
    assert.ok(mage.health < hp, 'the hit landed');
    assert.ok(mage.auras.some((x) => x.id === 'psychic_scream'), 'fear survived the opening hit');
  });

  it('Ice Barrier absorbs 25% of max health', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0);
    advance(sim, TICK);
    sim.applyAura(mage, mage, 'ice_barrier');
    const a = mage.auras.find((x) => x.id === 'ice_barrier')!;
    assert.ok(Math.abs(a.absorbLeft - mage.maxHealth * 0.25 * mage.gearMult * sim.modsOf(mage).healingDone) < 1, `got ${a.absorbLeft}`);
  });

  it('Dragon\'s Breath disorients and Blink cannot be used through it', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0);
    const foe = add(sim, 'mage', 1, 2, 0);
    advance(sim, TICK);
    sim.applyAura(mage, foe, 'dragons_breath');
    assert.equal(foe.auras.find((x) => x.id === 'dragons_breath')!.kind, 'fear');
    foe.bar = [...foe.bar.slice(0, 7), 'blink'];
    mustFail(sim.useAbility(foe.id, 'blink', foe.id), /disoriented/);
    assert.ok(foe.auras.some((x) => x.id === 'dragons_breath'), 'still disoriented');
  });

  it('Flamestrike can be placed behind you', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0);
    mage.bar = [...mage.bar.slice(0, 7), 'flamestrike'];
    const foe = add(sim, 'warrior', 1, 0, -10);
    advance(sim, TICK);
    mage.facing = 0; mage.lastInput = { ...mage.lastInput, facing: 0 }; // facing +z, spot is at -z
    const r = sim.useAbility(mage.id, 'flamestrike', null, { x: 0, z: -10 });
    assert.ok(r.ok, JSON.stringify(r));
    advance(sim, 4000);
    assert.ok(foe.health < foe.maxHealth, 'the strike landed behind the caster');
  });

  it('Pyromancy cauterizes a killing blow once: 35% health left, then it is on a long cooldown', () => {
    const sim = live();
    const m = sim.addUnit({ name: 'm', classId: 'mage', team: 0, build: { spec: 'fire', talents: [], gear: {} } });
    const w = add(sim, 'warrior', 1, 0, 3);
    m.pos = { x: 0, z: 0 };
    advance(sim, TICK);
    sim.dealDamage(w, m, 1e6, 'physical', null);
    assert.ok(m.alive, 'survived the killing blow');
    assert.equal(m.health, Math.round(m.maxHealth * TUNING.cauterizeHealth));
    assert.ok(m.auras.some((x) => x.id === 'cauterized'));
    sim.dealDamage(w, m, 1e6, 'physical', null);
    assert.ok(!m.alive, 'the second one kills: it is on cooldown');
    // other specs never get it
    const f = sim.addUnit({ name: 'f', classId: 'mage', team: 0, build: { spec: 'frost', talents: [], gear: {} } });
    sim.dealDamage(w, f, 1e6, 'physical', null);
    assert.ok(!f.alive);
  });

  it('specs carry no stat bonuses, and walking backwards is 75% speed', () => {
    for (const specs of Object.values(SPECS)) for (const sp of specs) {
      const { ability: _a, auraDuration: _d, ...stat } = sp.mods as Record<string, unknown>;
      assert.deepEqual(stat, {}, `${sp.id} has a flat stat bonus`);
    }
    const sim = live();
    const a = add(sim, 'warrior', 0, 0, 0);
    advance(sim, TICK);
    const run = (fwd: number) => {
      a.pos = { x: 0, z: 0 };
      sim.queueInput(a.id, { seq: Math.random() * 1e6 | 0, fwd, strafe: 0, facing: 0 });
      advance(sim, 1000);
      return Math.abs(a.pos.z);
    };
    const f = run(1), b = run(-1);
    assert.ok(Math.abs(b / f - 0.75) < 0.03, `back ${b} vs forward ${f}`);
  });

  it('Counterspell cannot be locked out, ignores facing, and still lands a moment after the cast finished', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0);
    const foe = add(sim, 'mage', 1, 0, 10);
    advance(sim, TICK);
    mage.lockouts.arcane = sim.time + 4000; // locked out of arcane (what an interrupt does)
    mage.facing = Math.PI; mage.lastInput = { ...mage.lastInput, facing: Math.PI }; // back turned to the foe
    assert.ok(sim.useAbility(foe.id, 'frostbolt', mage.id).ok);
    assert.ok(sim.useAbility(mage.id, 'counterspell', foe.id).ok, 'works while locked out and facing away');
    assert.ok((foe.lockouts.frost ?? 0) > sim.time, 'frost locked out');
    // late: the frostbolt lands, then the press arrives within the grace window
    mage.cooldowns = {};
    foe.lockouts = {}; foe.gcdEnd = 0; foe.resource = foe.resourceMax; foe.cooldowns = {};
    assert.ok(sim.useAbility(foe.id, 'frostbolt', mage.id).ok);
    advance(sim, 1550);
    assert.equal(foe.cast, null, 'the cast just landed');
    assert.ok(sim.useAbility(mage.id, 'counterspell', foe.id).ok, 'a late press still counts');
    assert.ok((foe.lockouts.frost ?? 0) > sim.time, 'and still locks frost out');
    advance(sim, 600);
    mage.cooldowns = {};
    assert.ok(sim.useAbility(mage.id, 'counterspell', foe.id).ok, 'too late is no longer refused: it is castable, but whiffs');
    assert.ok(advance(sim, TICK).some((e) => e.t === 'miss'), 'too late is too late: it misses');
  });

  it('counterspell works in the middle of your own cast and stops that cast', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0);
    const foe = add(sim, 'mage', 1, 0, 10);
    advance(sim, TICK);
    assert.ok(sim.useAbility(foe.id, 'frostbolt', mage.id).ok);
    assert.ok(sim.useAbility(mage.id, 'frostbolt', foe.id).ok);
    assert.ok(sim.useAbility(mage.id, 'counterspell', foe.id).ok, 'interrupt while casting');
    assert.equal(mage.cast, null, 'own cast is stopped by using another skill');
    assert.equal(foe.cast, null);
  });

  it('frost nova and deep freeze put Shatter on the target: the next frost hit does 400% more and uses it up', () => {
    for (const ab of ['frost_nova', 'deep_freeze']) {
      const sim = live();
      const mage = sim.addUnit({ name: 'm', classId: 'mage', team: 0, build: { spec: 'frost', talents: [], gear: {} } });
      mage.pos = { x: 0, z: 0 };
      const foe = add(sim, 'warrior', 1, 0, 4);
      foe.maxHealth = foe.health = 1e6;
      advance(sim, TICK);
      const cast = (id: string, wait = 2500) => { mage.cooldowns = {}; mage.gcdEnd = 0; mage.resource = mage.resourceMax; const h = foe.health; assert.ok(sim.useAbility(mage.id, id, foe.id).ok, id); advance(sim, wait); return h - foe.health; };
      const plain = cast('frostbolt');
      for (const a of [...foe.auras]) if (a.id !== 'shatter') sim.removeAura(foe, a, 'test'); // a lucky Fingers of Frost proc would muddy the comparison
      if (ab === 'deep_freeze') sim.applyAura(mage, foe, 'fingers_of_frost');
      cast(ab, 500); // instants: the 4 s Shatter must still be up when the next bolt (1.5 s) lands, whatever the tick length rounds to
      for (const a of [...foe.auras]) if (a.id === 'deep_freeze_stun') sim.removeAura(foe, a, 'test');
      if (ab === 'frost_nova') foe.auras = foe.auras.filter((x) => x.id !== 'frost_nova_root');
      if (!foe.auras.some((x) => x.id === 'shatter')) sim.applyAura(mage, foe, 'shatter');
      const empowered = cast('frostbolt');
      assert.ok(empowered > plain * 4.2, `${ab}: ${empowered} vs ${plain}`);
      assert.ok(!foe.auras.some((x) => x.id === 'shatter'), 'spent by the hit');
    }
  });

  it('Fingers of Frost: frostbolt can apply it; Ice Lance on it hits like Shatter and uses it; Deep Freeze needs Fingers or Shatter', () => {
    const sim = live(5);
    const mage = sim.addUnit({ name: 'm', classId: 'mage', team: 0, build: { spec: 'frost', talents: [], gear: {} } });
    mage.pos = { x: 0, z: 0 };
    const foe = add(sim, 'warrior', 1, 0, 4);
    foe.maxHealth = foe.health = 1e6;
    advance(sim, TICK);
    const go = (id: string) => { mage.cooldowns = {}; mage.gcdEnd = 0; mage.resource = mage.resourceMax; return sim.useAbility(mage.id, id, foe.id); };
    const r = go('deep_freeze');
    assert.ok(!r.ok && /Fingers of Frost or Shatter/.test((r as { reason: string }).reason), JSON.stringify(r));
    const lance = () => { const h = foe.health; assert.ok(go('ice_lance').ok); advance(sim, TICK); return h - foe.health; };
    const plain = lance();
    sim.applyAura(mage, foe, 'fingers_of_frost');
    const boosted = lance();
    assert.ok(boosted > plain * 4.2, `${boosted} vs ${plain}`);
    assert.ok(!foe.auras.some((x) => x.id === 'fingers_of_frost'), 'used up');
    sim.applyAura(mage, foe, 'fingers_of_frost');
    assert.ok(go('deep_freeze').ok, 'castable on Fingers of Frost');
    // procs: 15% of frostbolts over many casts
    let procs = 0;
    for (let i = 0; i < 80; i++) { for (const a of [...foe.auras]) sim.removeAura(foe, a, 'test'); go('frostbolt'); advance(sim, 1600); if (foe.auras.some((x) => x.id === 'fingers_of_frost')) procs++; }
    assert.ok(procs > 4 && procs < 25, `procs ${procs}/80`);
  });

  it('Fingers of Frost stacks to two and each Ice Lance uses one; Deep Freeze stuns for 4 s and Frost Nova roots and shatters for 6 s', () => {
    const sim = live(5);
    const mage = sim.addUnit({ name: 'm', classId: 'mage', team: 0, build: { spec: 'frost', talents: [], gear: {} } });
    const foe = add(sim, 'warrior', 1, 0, 6);
    foe.maxHealth = foe.health = 1e7;
    advance(sim, TICK);
    for (let i = 0; i < 3; i++) sim.applyAura(mage, foe, 'fingers_of_frost');
    assert.equal(foe.auras.find((x) => x.id === 'fingers_of_frost')!.stacks, 2, 'caps at two');
    const lance = () => { mage.cooldowns = {}; mage.gcdEnd = 0; mage.resource = mage.resourceMax; assert.ok(sim.useAbility(mage.id, 'ice_lance', foe.id).ok); advance(sim, TICK); };
    lance();
    assert.equal(foe.auras.find((x) => x.id === 'fingers_of_frost')?.stacks, 1);
    lance();
    assert.ok(!foe.auras.some((x) => x.id === 'fingers_of_frost'));
    sim.applyAura(mage, foe, 'fingers_of_frost');
    mage.cooldowns = {}; mage.gcdEnd = 0; mage.resource = mage.resourceMax;
    assert.ok(sim.useAbility(mage.id, 'deep_freeze', foe.id).ok);
    const left = (id: string) => foe.auras.find((x) => x.id === id)!.expiresAt - sim.time;
    assert.ok(Math.abs(left('deep_freeze_stun') - 4000) < 120, `stun ${left('deep_freeze_stun')}`);
    assert.ok(Math.abs(left('shatter') - 4000) < 120, `shatter ${left('shatter')}`);
    for (const x of [...foe.auras]) sim.removeAura(foe, x, 'test');
    mage.cooldowns = {}; mage.gcdEnd = 0; mage.resource = mage.resourceMax;
    mage.pos = { x: 0, z: 0 }; foe.pos = { x: 0, z: 5 };
    assert.ok(sim.useAbility(mage.id, 'frost_nova').ok);
    assert.ok(Math.abs(left('shatter') - 6000) < 120, `nova shatter ${left('shatter')}`);
    assert.equal(foe.auras.find((x) => x.id === 'fingers_of_frost')?.stacks, 1, 'Frost Nova leaves a stack of Fingers of Frost');
    assert.ok(Math.abs(left('frost_nova_root') - 6000 * 1.15) < 150 || Math.abs(left('frost_nova_root') - 6000) < 150, `root ${left('frost_nova_root')}`);
  });

  it('Shatter and Frost Nova roots break on damage, except Shatter while Deep Freeze holds', () => {
    const sim = live();
    const mage = sim.addUnit({ name: 'm', classId: 'mage', team: 0, build: { spec: 'frost', talents: [], gear: {} } });
    const foe = add(sim, 'warrior', 1, 0, 4);
    foe.maxHealth = foe.health = 1e6;
    advance(sim, TICK);
    sim.applyAura(mage, foe, 'frost_nova_root');
    sim.applyAura(mage, foe, 'shatter');
    sim.dealDamage(mage, foe, 50, 'fire', null);
    assert.ok(!foe.auras.some((x) => x.id === 'frost_nova_root' || x.id === 'shatter'), 'both gone');
    sim.applyAura(mage, foe, 'deep_freeze_stun');
    sim.applyAura(mage, foe, 'shatter');
    sim.dealDamage(mage, foe, 50, 'fire', null);
    assert.ok(foe.auras.some((x) => x.id === 'shatter'), 'held while stunned');
  });

  it('snapshots report the shield left on a unit and it shrinks as it soaks', () => {
    const sim = live();
    const priest = add(sim, 'priest', 0, 0, 0);
    const foe = add(sim, 'warrior', 1, 5, 0);
    advance(sim, TICK);
    const absorbOf = () => sim.snapshot().units.find((x) => x.id === priest.id)!.absorb;
    assert.equal(absorbOf(), undefined);
    sim.applyAura(priest, priest, 'pw_shield');
    const full = absorbOf()!;
    assert.ok(full > 0);
    sim.dealDamage(foe, priest, 50, 'physical', null);
    assert.ok(absorbOf()! < full, 'shield shrank');
  });

  it('scorch is a short cast you can move through, and may make the next pyroblast instant', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0);
    mage.bar = [...mage.bar.slice(0, 7), 'scorch'];
    const foe = add(sim, 'warrior', 1, 0, 10);
    foe.maxHealth = foe.health = 1e6;
    advance(sim, TICK);
    assert.ok(sim.useAbility(mage.id, 'scorch', foe.id).ok);
    assert.ok(mage.cast && mage.cast.end - mage.cast.start === ABILITIES.scorch.castTime);
    sim.queueInput(mage.id, { seq: 1, fwd: 1, strafe: 0, facing: 0 });
    advance(sim, ABILITIES.scorch.castTime / 2);
    assert.equal(mage.cast?.ability, 'scorch', 'moving does not cancel it');
    advance(sim, ABILITIES.scorch.castTime / 2 + 2 * TICK);
    assert.equal(mage.cast, null);
    assert.ok(foe.health < 1e6, 'it landed');
    // the listed share of casts grant Hot Streak
    const pStreak = (ABILITIES.scorch.effects.find((e) => e.type === 'aura' && e.aura === 'hot_streak') as { chance: number }).chance;
    let procs = 0;
    for (let i = 0; i < 300; i++) {
      mage.resource = mage.resourceMax;
      mage.auras = mage.auras.filter((x) => x.id !== 'hot_streak');
      foe.auras = []; // Singed stacks would pop into Hot Streak on their own; this counts only the direct chance
      mage.cooldowns = {};
      mage.gcdEnd = 0;
      mage.pos = { x: 0, z: 0 };
      mage.facing = 0;
      if (!sim.useAbility(mage.id, 'scorch', foe.id).ok) { advance(sim, 100); continue; }
      advance(sim, ABILITIES.scorch.castTime + 100);
      if (mage.auras.some((x) => x.id === 'hot_streak')) procs++;
    }
    assert.ok(procs >= 300 * pStreak * 0.6 && procs <= 300 * pStreak * 1.45, `procs ${procs}/300 (chance ${pStreak})`);
  });

  it('Dragon\'s Breath no longer grants Hot Streak', () => {
    assert.ok(!ABILITIES.dragons_breath.effects.some((e) => e.type === 'aura' && e.aura === 'hot_streak'));
  });

  it('Flamestrike always grants Hot Streak when its opening hit lands on an enemy, and never when it hits nothing', () => {
    for (const hit of [true, false]) {
      const sim = live(4);
      const mage = add(sim, 'mage', 0, 0, 0);
      mage.bar = [...mage.bar.slice(0, 7), 'flamestrike'];
      const foe = add(sim, 'warrior', 1, 0, 6);
      foe.maxHealth = foe.health = 1e9;
      advance(sim, TICK);
      assert.ok(sim.useAbility(mage.id, 'flamestrike', null, { x: hit ? 0 : 25, z: hit ? 6 : 6 }).ok);
      advance(sim, 3300);
      assert.equal(mage.auras.some((x) => x.id === 'hot_streak'), hit);
    }
  });

  it('Arcane Missiles can add Arcane Charge on each missile; Arcane Power lasts 15 s and cuts cast times by 30%', () => {
    const sim = live(6);
    const mage = sim.addUnit({ name: 'm', classId: 'mage', team: 0, build: { spec: 'arcane', talents: [], gear: {} } });
    const foe = add(sim, 'warrior', 1, 0, 8);
    foe.maxHealth = foe.health = 1e9;
    advance(sim, TICK);
    let stacks = 0;
    for (let i = 0; i < 20; i++) {
      mage.auras = mage.auras.filter((x) => x.id !== 'arcane_charge'); mage.cooldowns = {}; mage.gcdEnd = 0; mage.resource = mage.resourceMax; mage.pos = { x: 0, z: 0 };
      assert.ok(sim.useAbility(mage.id, 'arcane_missiles', foe.id).ok);
      advance(sim, 2300);
      stacks += mage.auras.find((x) => x.id === 'arcane_charge')?.stacks ?? 0;
    }
    assert.ok(stacks >= 15 && stacks <= 50, `${stacks} charges over 20 volleys (5 missiles x 30% = 30 expected)`);
    sim.applyAura(mage, mage, 'arcane_power');
    const ap = mage.auras.find((x) => x.id === 'arcane_power')!;
    assert.equal(ap.expiresAt - sim.time, 15000);
    mage.cooldowns = {}; mage.gcdEnd = 0; mage.auras = mage.auras.filter((x) => x.id !== 'arcane_charge');
    assert.ok(sim.useAbility(mage.id, 'arcane_blast', foe.id).ok);
    assert.equal(mage.cast!.end - mage.cast!.start, Math.round(ABILITIES.arcane_blast.castTime * 0.7));
  });

  it('Pummel and Kick can also be used on a target that is not casting: they miss and are spent', () => {
    for (const [cls, ab] of [['warrior', 'pummel'], ['rogue', 'kick']] as const) {
      const sim = live(8);
      const me = add(sim, cls, 0, 0, 0);
      const foe = add(sim, 'mage', 1, 0, 2);
      me.facing = 0; me.lastInput = { ...me.lastInput, facing: 0 };
      me.resource = me.resourceMax;
      advance(sim, TICK);
      assert.ok(!ABILITIES[ab].requiresTargetCasting, ab);
      assert.ok(sim.useAbility(me.id, ab, foe.id).ok, `${ab} castable on an idle target`);
      assert.ok(advance(sim, TICK).some((e) => e.t === 'miss' && e.src === me.id), `${ab} missed`);
      assert.ok(!sim.useAbility(me.id, ab, foe.id).ok, `${ab} is on cooldown`);
    }
  });

  it('Counterspell can be cast with nothing to interrupt: it misses and goes on cooldown; it still works while locked out', () => {
    const sim = live(2);
    const mage = add(sim, 'mage', 0, 0, 0);
    const foe = add(sim, 'warrior', 1, 0, 8);
    advance(sim, TICK);
    assert.ok(!ABILITIES.counterspell.requiresTargetCasting);
    assert.ok(sim.useAbility(mage.id, 'counterspell', foe.id).ok, 'castable on an idle target');
    const evs = advance(sim, TICK);
    assert.ok(evs.some((e) => e.t === 'miss' && e.src === mage.id), 'whiffed');
    assert.ok(!evs.some((e) => e.t === 'interrupt'));
    assert.ok(!sim.useAbility(mage.id, 'counterspell', foe.id).ok, 'spent: on cooldown');
    mage.cooldowns = {};
    mage.lockouts.arcane = sim.time + 4000;
    assert.ok(sim.useAbility(mage.id, 'counterspell', foe.id).ok, 'a lockout does not stop it');
  });

  it('Mind Flay slows its target by 30% while it channels, and the priest abilities have their new names', () => {
    assert.equal(AURAS.mind_flay_slow.slowPct, 30);
    assert.ok(ABILITIES.mind_flay.effects.some((e) => e.type === 'aura' && e.aura === 'mind_flay_slow'));
    assert.equal(ABILITIES.shadow_word_death.name, 'Shadow Word: Pain');
    assert.equal(ABILITIES.plague_bloom.name, 'Devouring Plague');
    assert.equal(AURAS.creeping_rot.name, 'Shadow Word: Pain');
    assert.equal(AURAS.plague_bloom.name, 'Devouring Plague');
    const sim = live(3);
    const pr = sim.addUnit({ name: 'p', classId: 'priest', team: 0, build: { spec: 'shadow', talents: [], gear: {} } });
    const foe = add(sim, 'warrior', 1, 0, 8);
    foe.maxHealth = foe.health = 1e6;
    advance(sim, TICK);
    assert.ok(sim.useAbility(pr.id, 'mind_flay', foe.id).ok);
    advance(sim, 1200);
    assert.ok(foe.auras.some((x) => x.id === 'mind_flay_slow'), 'slowed mid-channel');
  });

  it('hot streak makes the next pyroblast instant and is used up', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0);
    mage.bar = [...mage.bar.slice(0, 7), 'pyroblast'];
    const foe = add(sim, 'warrior', 1, 0, 10);
    advance(sim, TICK);
    assert.ok(sim.useAbility(mage.id, 'pyroblast', foe.id).ok);
    assert.ok(mage.cast, 'normally a 3 s cast');
    sim.cancelCast(mage, 'test');
    mage.gcdEnd = 0;
    sim.applyAura(mage, mage, 'hot_streak');
    const hp = foe.health;
    const r2 = sim.useAbility(mage.id, 'pyroblast', foe.id);
    assert.ok(r2.ok, JSON.stringify(r2));
    assert.equal(mage.cast, null, 'instant');
    assert.ok(foe.health < hp, 'hit at once');
    assert.ok(!mage.auras.some((x) => x.id === 'hot_streak'), 'used up');
  });

  it('a fully cast Pyroblast hits for its listed damage and no longer grants Hot Streak', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0);
    mage.bar = [...mage.bar.slice(0, 7), 'pyroblast'];
    const foe = add(sim, 'warrior', 1, 0, 10);
    foe.health = foe.maxHealth = 5000;
    advance(sim, TICK);
    assert.ok(sim.useAbility(mage.id, 'pyroblast', foe.id).ok);
    advance(sim, ABILITIES.pyroblast.castTime + 200);
    assert.ok(!mage.auras.some((x) => x.id === 'hot_streak'), 'a full cast gives no Hot Streak');
    const hits = foe.maxHealth - foe.health;
    const listed = (ABILITIES.pyroblast.effects.find((e) => e.type === 'damage') as { amount: number }).amount;
    const v = TUNING.damageVariance;
    const lo = listed * (1 - v) - 1;
    assert.ok(hits >= lo && hits <= listed * (1 + v) * 1.3, `first hit ${hits} vs listed ${listed}`);
  });

  it('Fireball gives 2 Singed stacks; the hit that would take them past the limit pops them into Hot Streak for the caster', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0);
    mage.bar = [...mage.bar.slice(0, 7), 'fireball'];
    const foe = add(sim, 'warrior', 1, 0, 10);
    foe.maxHealth = foe.health = 1e9;
    advance(sim, TICK);
    const max = AURAS.singed.maxStacks!;
    const singed = () => foe.auras.find((x) => x.id === 'singed');
    const hot = () => mage.auras.some((x) => x.id === 'hot_streak');
    const fire = () => { mage.cooldowns = {}; mage.gcdEnd = 0; mage.resource = mage.resourceMax; mage.auras = mage.auras.filter((x) => x.id !== 'hot_streak'); assert.ok(sim.useAbility(mage.id, 'fireball', foe.id).ok); advance(sim, 2000); };
    fire();
    assert.equal(singed()?.stacks, 2);
    assert.ok(Math.abs((singed()!.expiresAt - sim.time) - AURAS.singed.duration) <= 2000 + TICK * 2, 'lasts its full duration');
    let n = 1;
    while (singed() && (singed()!.stacks ?? 0) + 2 <= max) { fire(); n++; assert.ok(n < 10); }
    fire();
    assert.equal(singed()?.stacks ?? 0, 0, 'all stacks removed');
    assert.ok(hot(), 'Hot Streak on the caster');
    assert.ok(!foe.auras.some((x) => x.id === 'hot_streak'));
    fire();
    assert.equal(singed()?.stacks, 2, 'starts over');
  });

  it('Singed falls off after its duration and Pyroblast never gives Hot Streak', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0);
    mage.bar = [...mage.bar.slice(0, 7), 'fireball'];
    const foe = add(sim, 'warrior', 1, 0, 10);
    foe.maxHealth = foe.health = 1e9;
    advance(sim, TICK);
    assert.ok(sim.useAbility(mage.id, 'fireball', foe.id).ok);
    advance(sim, AURAS.singed.duration + 2200);
    assert.ok(!foe.auras.some((x) => x.id === 'singed'));
    assert.ok(!ABILITIES.pyroblast.effects.some((e) => e.type === 'aura'), 'Pyroblast has no aura effect');
  });

  it("dragon's breath is a 14 yd, 80 degree cone that disorients for 4 s", () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0);
    mage.bar = [...mage.bar.slice(0, 7), 'dragons_breath'];
    const inFront = add(sim, 'warrior', 1, 0, 12);
    const edge = add(sim, 'warrior', 1, 4, 10); // ~22 degrees off, inside the cone
    const wide = add(sim, 'warrior', 1, 9, 8); // ~48 degrees off, outside the 40 degree half-angle
    const behind = add(sim, 'warrior', 1, 0, -5);
    const far = add(sim, 'warrior', 1, 0, 15); // beyond 14 yd
    advance(sim, TICK);
    mage.facing = 0; // facing +z
    const r = sim.useAbility(mage.id, 'dragons_breath', mage.id);
    assert.ok(r.ok, JSON.stringify(r));
    const stunned = (u: Unit) => u.auras.some((a) => a.id === 'dragons_breath');
    assert.ok(stunned(inFront) && stunned(edge), 'enemies in the cone are disoriented');
    assert.ok(!stunned(wide) && !stunned(behind) && !stunned(far), 'outside the cone or range is untouched');
    const aura = inFront.auras.find((a) => a.id === 'dragons_breath')!;
    assert.ok(Math.abs(aura.expiresAt - sim.time - 4000) <= 100, `disorient lasts about 4 s, got ${aura.expiresAt - sim.time} ms`);
  });

  it('execute spends its listed rage, hits for its listed damage and only works on targets below its health threshold', () => {
    const sim = live();
    const war = add(sim, 'warrior', 0, 0, 0);
    war.bar = [...war.bar.slice(0, 7), 'execute'];
    const foe = add(sim, 'warrior', 1, 1.5, 0);
    const ex = ABILITIES.execute;
    const pct = ex.maxTargetHealthPct!;
    const below = Math.floor(foe.maxHealth * (pct - 1) / 100);
    const re = new RegExp(`below ${pct}% health`);
    war.facing = Math.PI / 2; // face the target (+x)
    advance(sim, TICK);
    war.facing = Math.PI / 2;
    war.resource = 100;
    mustFail(sim.useAbility(war.id, 'execute', foe.id), re);
    foe.health = below;
    if (ex.cost > 0) {
      war.resource = ex.cost - 1;
      mustFail(sim.useAbility(war.id, 'execute', foe.id), /not enough rage/);
    }
    war.resource = 100;
    foe.health = Math.floor(foe.maxHealth * pct / 100); // exactly at the threshold is not below it
    mustFail(sim.useAbility(war.id, 'execute', foe.id), re);
    foe.health = below;
    const hp = foe.health;
    const r = sim.useAbility(war.id, 'execute', foe.id);
    assert.ok(r.ok, JSON.stringify(r));
    const dealt = hp - foe.health;
    const listed = (ex.effects.find((e) => e.type === 'damage') as { amount: number }).amount;
    const v = TUNING.damageVariance;
    assert.ok(dealt >= listed * (1 - v) - 1 && dealt <= listed * (1 + v) + 1, `dealt ${dealt}`);
  });

  it('global cooldown is 1 s for every class', () => {
    for (const [cls, ms] of [['mage', 1000], ['priest', 1000], ['warrior', 1000], ['rogue', 1000]] as const) {
      const sim = live();
      const u = add(sim, cls, 0, 0, 0);
      const foe = add(sim, 'warrior', 1, 2, 0);
      advance(sim, TICK);
      const ab = u.bar.find((id) => { const d = ABILITIES[id]; return d.gcd && d.castTime === 0 && !d.requiresStealth && !d.requiresTargetCasting && !d.maxTargetHealthPct && !d.outOfCombatOnly && (d.target === 'self' || d.target === 'aoe_enemy' || d.target === 'enemy') && !d.effects.some((e) => e.type === 'charge' || e.type === 'dashToTarget'); });
      assert.ok(ab, `${cls} has an instant gcd skill`);
      u.resource = u.resourceMax;
      u.facing = Math.PI / 2;
      assert.ok(sim.useAbility(u.id, ab, foe.id).ok, `${cls} ${ab}`);
      assert.equal(u.gcdEnd - sim.time, ms, cls);
    }
  });

  it('arcane blast stacks Arcane Charge to 5 and arcane barrage spends them for +75% damage each', () => {
    const sim = live();
    const mage = sim.addUnit({ name: 'm', classId: 'mage', team: 0, build: { spec: 'arcane', talents: [], gear: {} } });
    mage.pos = { x: 0, z: 0 };
    const foe = add(sim, 'warrior', 1, 0, 4);
    foe.maxHealth = foe.health = 1e6;
    advance(sim, TICK);
    const go = (id: string) => { mage.cooldowns = {}; mage.gcdEnd = 0; mage.resource = mage.resourceMax; const h = foe.health; assert.ok(sim.useAbility(mage.id, id, foe.id).ok, id); advance(sim, 3000); return h - foe.health; };
    const stacks = () => mage.auras.find((x) => x.id === 'arcane_charge')?.stacks ?? 0;
    const bare = go('arcane_barrage');
    for (let i = 1; i <= 7; i++) { go('arcane_blast'); assert.equal(stacks(), Math.min(5, i), `after blast ${i}`); }
    const full = go('arcane_barrage');
    assert.ok(full > bare * 4.4 && full < bare * 5.1, `${full} vs ${bare}`);
    assert.equal(stacks(), 0, 'barrage spends the stacks');
    const snapStacks = (() => { go('arcane_blast'); go('arcane_blast'); return sim.snapshot().units.find((u) => u.id === mage.id)!.auras.find((x) => x.id === 'arcane_charge')?.stacks; })();
    assert.equal(snapStacks, 2, 'snapshots carry stacks');
  });

  it('combo points: Mutilate and Sinister Strike earn them, payoffs scale with them and spend them, and they never decay', () => {
    const sim = live();
    const rg = sim.addUnit({ name: 'r', classId: 'rogue', team: 0, build: { spec: 'assassination', talents: [], gear: {} } });
    rg.pos = { x: 0, z: 0 };
    const foe = add(sim, 'warrior', 1, 0, 2);
    foe.maxHealth = foe.health = 1e6;
    advance(sim, TICK);
    const go = (id: string) => { rg.cooldowns = {}; rg.gcdEnd = 0; rg.resource = rg.resourceMax; const h = foe.health; const r = sim.useAbility(rg.id, id, foe.id); assert.ok(r.ok, id); advance(sim, 1200); return h - foe.health; };
    rg.bar = [...rg.bar.slice(0, 5), 'eviscerate', 'sinister_strike', 'exsanguinate'];
    assert.ok(!sim.useAbility(rg.id, 'eviscerate', foe.id).ok, 'needs combo points');
    go('mutilate'); assert.equal(rg.cp, 1);
    go('sinister_strike'); assert.equal(rg.cp, 2);
    for (let i = 0; i < 6; i++) go('sinister_strike');
    assert.equal(rg.cp, 5, 'capped at 5');
    const wp = (id: string) => { rg.cooldowns = {}; rg.gcdEnd = 0; rg.resource = rg.resourceMax; const h = foe.health; assert.ok(sim.useAbility(rg.id, id, foe.id).ok, id); advance(sim, 6500); return h - foe.health; };
    const five = wp('eviscerate');
    assert.equal(rg.cp, 0, 'spent');
    go('sinister_strike');
    const one = wp('eviscerate');
    assert.ok(five > one, `payoff grows with combo points: ${five} vs ${one}`);
    go('sinister_strike'); assert.equal(rg.cp, 1);
    rg.autoAttack = false;
    foe.pos = { x: 0, z: 80 };
    advance(sim, 30000);
    assert.equal(rg.cp, 1, 'combo points stay');
    // Kidney Shot: 2.8 s on 1 point up to 6 s on 5 (and never longer)
    for (const [cp, secs] of [[1, 2.8], [3, 4.4], [5, 6], [8, 6]] as const) {
      foe.pos = { x: 0, z: 2 };
      foe.auras = []; foe.dr = {}; rg.cooldowns = {}; rg.gcdEnd = 0; rg.resource = rg.resourceMax; rg.cp = cp;
      assert.ok(sim.useAbility(rg.id, 'kidney_shot', foe.id).ok, `${cp} cp`);
      const st = foe.auras.find((x) => x.id === 'kidney_shot')!;
      assert.equal(Math.round((st.expiresAt - sim.time) / 100) / 10, secs, `${cp} cp stun`);
      assert.equal(rg.cp, 0);
    }
  });

  it('Weak Point (eviscerate): a debuff of one second and one tick per combo point, up to 5 s, that silences and disarms and deals the old hit per point', () => {
    const sim = live();
    const rg = sim.addUnit({ name: 'r', classId: 'rogue', team: 0, build: { spec: 'assassination', talents: [], gear: {} } });
    rg.pos = { x: 0, z: 0 };
    const foe = add(sim, 'mage', 1, 0, 2);
    foe.maxHealth = foe.health = 1e6;
    foe.gearMult = 1; rg.gearMult = 1;
    rg.bar = [...rg.bar.slice(0, 5), 'eviscerate'];
    advance(sim, TICK);
    assert.equal(ABILITIES.eviscerate.name, 'Weak Point');
    const hits: number[] = [];
    const run = (cp: number) => {
      foe.auras = []; foe.health = 1e6; rg.cooldowns = {}; rg.gcdEnd = 0; rg.resource = rg.resourceMax; rg.cp = cp; sim.drainEvents();
      assert.ok(sim.useAbility(rg.id, 'eviscerate', foe.id).ok);
      const a = foe.auras.find((x) => x.id === 'weak_point')!;
      assert.ok(a, 'debuff applied');
      assert.equal(foe.health, 1e6, 'no instant damage');
      rg.autoAttack = false;
      const left = Math.round((a.expiresAt - sim.time) / 1000);
      const ticks = advance(sim, 6500).filter((e) => e.t === 'damage' && e.ability === 'eviscerate');
      return { left, ticks: ticks.length, total: ticks.reduce((n, e) => n + (e.t === 'damage' ? e.amount : 0), 0), cp: rg.cp, gone: !foe.auras.some((x) => x.id === 'weak_point') };
    };
    for (const cp of [1, 3, 5]) {
      const r = run(cp);
      hits.push(r.total);
      assert.equal(r.left, cp, `${cp} cp lasts ${cp} s`);
      assert.equal(r.ticks, cp, `${cp} ticks, one per second`);
      assert.equal(r.cp, 0);
      assert.ok(r.gone);
    }
    assert.ok(Math.abs(hits[1] / hits[0] - 3) < 0.3 && Math.abs(hits[2] / hits[0] - 5) < 0.5, `scales with points: ${hits}`);
    // past five points the debuff stops at 5 s with the damage squeezed into those five ticks
    const six = run(8);
    assert.equal(six.left, 5); assert.equal(six.ticks, 5);
    assert.ok(Math.abs(six.total / hits[0] - 8) < 0.8, `8 points deal 8x: ${six.total} vs ${hits[0]}`);
    // silence stops spells, disarm stops physical abilities and auto attacks
    foe.auras = []; rg.cp = 3; rg.cooldowns = {}; rg.gcdEnd = 0; rg.resource = rg.resourceMax;
    sim.useAbility(rg.id, 'eviscerate', foe.id);
    foe.cooldowns = {}; foe.gcdEnd = 0; foe.resource = foe.resourceMax;
    const r1 = sim.useAbility(foe.id, 'frostbolt', rg.id);
    assert.ok(!r1.ok && /silenced/.test(String((r1 as { reason?: string }).reason)), 'cannot cast spells');
    foe.cast = null;
    const phys = Object.keys(ABILITIES).find((id) => ABILITIES[id].school === 'physical' && ABILITIES[id].class === 'mage');
    if (phys) assert.ok(!sim.useAbility(foe.id, phys, rg.id).ok);
    const war = sim.addUnit({ name: 'w', classId: 'warrior', team: 1, build: { spec: 'arms', talents: [], gear: {} } });
    war.pos = { x: 0, z: 2 };
    war.auras.push({ id: 'weak_point', kind: 'dot', sourceId: rg.id, expiresAt: sim.time + 3000, absorbLeft: 0 });
    war.autoAttack = true; war.target = rg.id; war.nextSwing = 0;
    const before = rg.health;
    advance(sim, 2500);
    assert.equal(rg.health, before, 'a disarmed warrior does not auto attack');
  });

  it('Warden passive: Power Word: Shield is 50% stronger and Penance keeps channelling while moving; other priests get neither', () => {
    const shield = (spec: string) => {
      const sim = live();
      const pr = sim.addUnit({ name: 'p', classId: 'priest', team: 0, build: { spec, talents: [], gear: {} } });
      pr.pos = { x: 0, z: 0 }; pr.gearMult = 1;
      add(sim, 'warrior', 1, 0, 40);
      advance(sim, TICK);
      pr.resource = pr.resourceMax;
      assert.ok(sim.useAbility(pr.id, 'power_word_shield', pr.id).ok);
      return { sim, pr, absorb: pr.auras.find((a) => a.id === 'pw_shield')!.absorbLeft };
    };
    const w = shield('discipline'), l = shield('holy');
    assert.equal(l.absorb, AURAS.pw_shield.absorb);
    assert.equal(w.absorb, Math.round(AURAS.pw_shield.absorb! * 1.5));
    const penance = (spec: string) => {
      const sim = live();
      const pr = sim.addUnit({ name: 'p', classId: 'priest', team: 0, build: { spec, talents: [], gear: {} } });
      pr.pos = { x: 0, z: 0 };
      const foe = add(sim, 'warrior', 1, 0, 6);
      foe.maxHealth = foe.health = 1e6;
      pr.bar = [...pr.bar.slice(0, 7), 'penance'];
      advance(sim, TICK);
      assert.ok(sim.useAbility(pr.id, 'penance', foe.id).ok);
      sim.queueInput(pr.id, { seq: 1, fwd: 0, strafe: 1, facing: 0 });
      const ev = advance(sim, 600);
      return { moved: Math.abs(pr.pos.x) > 0.5, channelling: !!pr.cast, hits: ev.filter((e) => e.t === 'damage' && e.ability === 'penance').length };
    };
    const a = penance('discipline');
    assert.ok(a.moved && a.channelling && a.hits >= 1, `warden ${JSON.stringify(a)}`);
    const b = penance('holy');
    assert.ok(b.moved && !b.channelling, 'others are stopped by moving');
  });

  it('Shadow Might adds 10% healing as well as damage', () => {
    const t = Object.values(TALENTS.priest).flat(2).find((x) => x.id === 'priest_t2c')!;
    assert.equal(t.mods?.damageDone, 1.1);
    assert.equal(t.mods?.healingDone, 1.1);
    assert.match(t.desc, /damage and healing/);
  });

  it('exsanguinate adds damage from the target\'s bleeds and then triples them; adrenaline rush lasts longer per combo point', () => {
    const sim = live();
    const rg = sim.addUnit({ name: 'r', classId: 'rogue', team: 0, build: { spec: 'assassination', talents: [], gear: {} } });
    rg.pos = { x: 0, z: 0 };
    const foe = add(sim, 'warrior', 1, 0, 2);
    foe.maxHealth = foe.health = 1e6;
    advance(sim, TICK);
    rg.bar = [...rg.bar.slice(0, 5), 'adrenaline_rush', 'garrote', 'exsanguinate'];
    const burst = () => { rg.cooldowns = {}; rg.gcdEnd = 0; rg.resource = rg.resourceMax; rg.cp = 3; const h = foe.health; assert.ok(sim.useAbility(rg.id, 'exsanguinate', foe.id).ok); advance(sim, TICK * 2); return h - foe.health; };
    const none = burst();
    rg.cooldowns = {}; rg.gcdEnd = 0; rg.resource = rg.resourceMax;
    assert.ok(sim.useAbility(rg.id, 'garrote', foe.id).ok);
    advance(sim, TICK);
    const bled = foe.auras.find((x) => x.id === 'garrote_bleed')!;
    assert.ok(bled);
    const withBleed = burst();
    assert.ok(withBleed > none + 100, `${withBleed} vs ${none}`);
    assert.equal(foe.auras.find((x) => x.id === 'garrote_bleed')!.dotMult, 3, 'bleeds tripled');
    for (const cp of [1, 5]) {
      rg.cooldowns = {}; rg.gcdEnd = 0; rg.cp = cp; rg.auras = rg.auras.filter((x) => x.id !== 'adrenaline_rush');
      assert.ok(sim.useAbility(rg.id, 'adrenaline_rush', null).ok);
      const a = rg.auras.find((x) => x.id === 'adrenaline_rush')!;
      assert.equal(Math.round((a.expiresAt - sim.time) / 100) / 10, 4 + 1.5 * cp, `${cp} CP`);
      assert.equal(rg.cp, 0);
    }
  });

  it('mage bars: frost has deep freeze, fire has dragons breath, arcane has missiles, barrage and its own explosion', () => {
    const bars = Object.fromEntries(SPECS.mage.map((s) => [s.id, s.bar]));
    assert.ok(bars.frost.includes('deep_freeze') && !bars.frost.includes('blizzard'));
    assert.ok(bars.fire.includes('dragons_breath') && !bars.fire.includes('frost_nova'));
    assert.ok(['arcane_missiles', 'arcane_barrage', 'arcane_explosion'].every((x) => bars.arcane.includes(x)) && !bars.arcane.includes('ice_barrier') && !bars.arcane.includes('frost_nova'));
    assert.equal(ABILITIES.arcane_missiles.channel?.ticks, 5);
    assert.equal(ABILITIES.arcane_barrage.castTime, 0);
  });

  it('while dispersed you cannot use any ability', () => {
    const sim = live();
    const priest = sim.addUnit({ name: 'p', classId: 'priest', team: 0, build: { spec: 'shadow', talents: [], gear: {} } });
    priest.pos = { x: 0, z: 0 };
    const foe = add(sim, 'warrior', 1, 0, 5);
    advance(sim, TICK);
    priest.bar = [...priest.bar.slice(0, 6), 'dispersion', 'flash_heal'];
    assert.ok(sim.useAbility(priest.id, 'dispersion', null).ok);
    priest.gcdEnd = 0;
    for (const ab of ['flash_heal', 'power_word_shield', 'dispersion']) assert.ok(!sim.useAbility(priest.id, ab, priest.id).ok, ab);
    advance(sim, 6500);
    priest.gcdEnd = 0; priest.resource = priest.resourceMax;
    assert.ok(sim.useAbility(priest.id, 'flash_heal', priest.id).ok, 'back to normal afterwards');
    void foe;
  });

  it('dispersion works while stunned, feared or silenced and frees you from roots and slows', () => {
    const sim = live();
    const priest = sim.addUnit({ name: 'p', classId: 'priest', team: 0, build: { spec: 'shadow', talents: [], gear: {} } });
    priest.pos = { x: 0, z: 0 };
    priest.bar = [...priest.bar.slice(0, 7), 'dispersion'];
    const foe = add(sim, 'warrior', 1, 0, 3);
    advance(sim, TICK);
    for (const aura of ['kidney_shot', 'psychic_scream']) {
      priest.auras = []; priest.cooldowns = {}; priest.gcdEnd = 0; priest.lockouts = { shadow: sim.time + 5000 };
      sim.applyAura(foe, priest, aura);
      sim.applyAura(foe, priest, 'frost_nova_root');
      sim.applyAura(foe, priest, 'frostbolt_slow');
      assert.ok(priest.auras.some((a) => a.kind === 'stun' || a.kind === 'fear'), `${aura} landed`);
      assert.ok(sim.useAbility(priest.id, 'dispersion', null).ok, `usable under ${aura} and a shadow lockout`);
      assert.ok(!priest.auras.some((a) => a.kind === 'root' || a.kind === 'slow'), 'roots and slows cleared');
      assert.ok(priest.auras.some((a) => a.id === 'dispersion'));
    }
    priest.auras = []; priest.cooldowns = {};
    sim.applyAura(foe, priest, 'polymorph');
    assert.ok(!sim.useAbility(priest.id, 'dispersion', null).ok, 'still not usable as a sheep');
  });

  it('holy nova reaches 12 yards, healing allies more than it hurts enemies; mind flay is a damage channel; penance is no longer a talent', () => {
    const sim = live();
    const priest = sim.addUnit({ name: 'p', classId: 'priest', team: 0, build: { spec: 'holy', talents: [], gear: {} } });
    priest.pos = { x: 0, z: 0 };
    const ally = add(sim, 'warrior', 0, 10, 0);
    const foe = add(sim, 'mage', 1, 0, 11);
    const far = add(sim, 'mage', 1, 0, -30);
    ally.health = ally.maxHealth - 400;
    foe.maxHealth = foe.health = 5000;
    priest.resource = priest.resourceMax;
    advance(sim, TICK);
    assert.ok(priest.bar.includes('holy_nova') && !priest.bar.includes('pain_suppression'));
    const ah = ally.health, fh = foe.health;
    assert.ok(sim.useAbility(priest.id, 'holy_nova').ok);
    advance(sim, TICK);
    const healed = ally.health - ah, hurt = fh - foe.health;
    assert.ok(healed > 0 && hurt > 0 && healed > hurt, `healed ${healed} hurt ${hurt}`);
    assert.equal(far.health, far.maxHealth, 'out of its 12 yards');

    const sim2 = live();
    const shadow = sim2.addUnit({ name: 's', classId: 'priest', team: 0, build: { spec: 'shadow', talents: [], gear: {} } });
    shadow.pos = { x: 0, z: 0 };
    const foe2 = add(sim2, 'warrior', 1, 0, 10);
    foe2.maxHealth = foe2.health = 5000;
    advance(sim2, TICK);
    assert.ok(!shadow.bar.includes('smite') && shadow.bar.includes('mind_flay'));
    assert.ok(sim2.useAbility(shadow.id, 'mind_flay', foe2.id).ok);
    advance(sim2, 1200);
    const mid = foe2.maxHealth - foe2.health;
    assert.ok(mid > 0 && mid < 270, 'ticks over time');
    advance(sim2, 2500);
    assert.ok(foe2.maxHealth - foe2.health >= 200, 'channel completes');
    for (const sp of SPECS.priest) assert.ok(!talentsFor('priest', sp.id).flat().some((t) => t.swap?.to === 'penance'), `penance talent on ${sp.id}`);
    assert.ok(SPECS.priest[0].bar.includes('penance') && !SPECS.priest[0].bar.includes('greater_heal'));
  });

  it('twin rift lets blink be cast twice per cooldown, then it is on cooldown', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0);
    add(sim, 'warrior', 1, 30, 0);
    mage.mods.ability['blink'] = { charges: 1 };
    advance(sim, TICK);
    assert.ok(sim.useAbility(mage.id, 'blink').ok);
    assert.ok(sim.useAbility(mage.id, 'blink').ok, 'second blink');
    mustFail(sim.useAbility(mage.id, 'blink'), /cooldown/);
  });

  it('blink grants its talent buffs afterwards', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0);
    add(sim, 'warrior', 1, 30, 0);
    mage.mods.ability['blink'] = { after: ['blink_speed', 'blink_haste'] };
    advance(sim, TICK);
    assert.ok(sim.useAbility(mage.id, 'blink').ok);
    assert.ok(mage.auras.some((x) => x.id === 'blink_speed') && mage.auras.some((x) => x.id === 'blink_haste'));
  });

  it('cheap shot needs stealth, stuns, and breaks stealth', () => {
    const sim = live();
    const rogue = add(sim, 'rogue', 0, 0, 0);
    const mage = add(sim, 'mage', 1, 2, 0);
    advance(sim, TICK);
    mustFail(sim.useAbility(rogue.id, 'cheap_shot', mage.id), /requires stealth/);
    assert.ok(sim.useAbility(rogue.id, 'stealth').ok);
    assert.ok(sim.useAbility(rogue.id, 'cheap_shot', mage.id).ok);
    assert.ok(mage.auras.some((a) => a.id === 'cheap_shot_stun'));
    assert.ok(!sim.isStealthed(rogue));
  });

  it('auto-attack is held while stealthed unless the target is within 2 yards', () => {
    const sim = live();
    const rogue = add(sim, 'rogue', 0, 0, 0);
    const mage = add(sim, 'mage', 1, 3, 0);
    advance(sim, TICK);
    assert.ok(sim.useAbility(rogue.id, 'stealth').ok);
    sim.setTarget(rogue.id, mage.id);
    sim.setAutoAttack(rogue.id, true);
    const hp = mage.health;
    advance(sim, 2500);
    assert.equal(mage.health, hp, 'no swings from stealth at 3 yards');
    assert.ok(sim.isStealthed(rogue), 'stealth is not broken by the pending auto-attack');
    mage.pos = { x: 2, z: 0 };
    advance(sim, 2500);
    assert.ok(mage.health < hp, 'swings land once the target is within 2 yards');
    assert.ok(!sim.isStealthed(rogue), 'and the swing breaks stealth');
  });

  it('cannot stealth while in combat', () => {
    const sim = live();
    const rogue = add(sim, 'rogue', 0, 0, 0);
    const war = add(sim, 'warrior', 1, 2, 0);
    advance(sim, TICK);
    sim.dealDamage(war, rogue, 10, 'physical', null);
    mustFail(sim.useAbility(rogue.id, 'stealth'), /in combat/);
  });
});

describe('movement', () => {
  it('walls and pillars stop you', () => {
    const sim = live();
    const war = add(sim, 'warrior', 0, -10, -3);
    add(sim, 'rogue', 1, 20, 0);
    for (let i = 1; i <= 60; i++) {
      sim.queueInput(war.id, { seq: i, fwd: 1, strafe: 0, facing: Math.PI }); // toward -z, into the pillar
      sim.step();
    }
    const dz = Math.hypot(war.pos.x + 10, war.pos.z + 7);
    assert.ok(dz >= 2.2 + 0.6 - 1e-6, `unit is inside the pillar (distance ${dz})`);
  });

  it('server applies speed: 7 yards/second', () => {
    const sim = live();
    const war = add(sim, 'warrior', 0, -25, 10);
    add(sim, 'rogue', 1, 25, 10);
    const start = war.pos.x;
    for (let i = 1; i <= 1000 / sim.tickMs; i++) {
      sim.queueInput(war.id, { seq: i, fwd: 1, strafe: 0, facing: Math.PI / 2 });
      sim.step();
    }
    assert.ok(Math.abs(war.pos.x - start - 7) < 0.1, `moved ${war.pos.x - start}`);
  });

  it('prep phase holds teams behind the gate', () => {
    const sim = new ArenaSim({ prepMs: 5000 });
    const war = sim.addUnit({ name: 'w', classId: 'warrior', team: 0 });
    for (let i = 1; i <= 90; i++) {
      sim.queueInput(war.id, { seq: i, fwd: 1, strafe: 0, facing: Math.PI / 2 });
      sim.step();
    }
    assert.equal(sim.phase, 'prep');
    assert.ok(war.pos.x <= -20 + 1e-6, `crossed the gate: x=${war.pos.x}`);
    assert.ok(war.pos.x >= -20 - 1e-6, 'should be pressed against the gate');
  });

  it('blink stops before a pillar', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, -16, -7);
    add(sim, 'rogue', 1, 20, 0);
    mage.facing = Math.PI / 2; // toward +x, into the pillar at x=-10
    advance(sim, TICK);
    assert.ok(sim.useAbility(mage.id, 'blink').ok);
    assert.ok(mage.pos.x < -10 - 2.2, `blinked into the pillar: x=${mage.pos.x}`);
    assert.ok(mage.pos.x > -16);
  });

  it('charge closes the gap, and refuses when too close', () => {
    const sim = live();
    const war = add(sim, 'warrior', 0, 0, 0);
    const rogue = add(sim, 'rogue', 1, 20, 0);
    advance(sim, TICK);
    assert.ok(sim.useAbility(war.id, 'charge', rogue.id).ok);
    assert.ok(war.pos.x < 1, 'a charge is a run, not a teleport');
    advance(sim, 50);
    assert.ok(war.pos.x > 1 && war.pos.x < 3, `first step ${war.pos.x}`);
    assert.equal(sim.snapshot().units.find((u) => u.id === war.id)!.controlled, true, 'steering is off while charging');
    advance(sim, 1000);
    assert.ok(Math.abs(war.pos.x - 18) < 0.2, `arrived at ${war.pos.x}`);
    assert.equal(war.charge, null);
    advance(sim, 16000);
    mustFail(sim.useAbility(war.id, 'charge', rogue.id), /too close/);
  });

  it('charge stuns the target on cast, and being hit stops the charge', () => {
    const sim = live();
    const war = add(sim, 'warrior', 0, 0, 0);
    const rogue = add(sim, 'rogue', 1, 20, 0);
    const mage = add(sim, 'mage', 1, 30, 10);
    advance(sim, TICK);
    assert.ok(sim.useAbility(war.id, 'charge', rogue.id).ok);
    assert.ok(rogue.auras.some((a) => a.id === 'charge_stun'), 'target stunned the moment Charge is cast');
    advance(sim, TICK * 3);
    assert.ok(war.charge, 'still charging');
    const at = war.pos.x;
    sim.dealDamage(mage, war, 20, 'frost', 'frostbolt');
    assert.equal(war.charge, null, 'a hit ends the charge');
    advance(sim, TICK * 3);
    assert.ok(Math.abs(war.pos.x - at) < 0.2, 'stopped where it was hit');
    assert.ok(!rogue.auras.some((a) => a.id === 'charge_stun'), 'the target is freed when the charge is broken');
  });

  it('on landing the warrior hits the target and the stun ends', () => {
    const sim = live();
    const war = add(sim, 'warrior', 0, 0, 0);
    const rogue = add(sim, 'rogue', 1, 20, 0);
    advance(sim, TICK);
    const hp = rogue.health;
    assert.ok(sim.useAbility(war.id, 'charge', rogue.id).ok);
    advance(sim, 400);
    assert.ok(rogue.auras.some((a) => a.id === 'charge_stun'), 'stunned while the warrior runs in');
    assert.equal(rogue.health, hp, 'no damage before landing');
    advance(sim, 1000);
    assert.equal(war.charge, null);
    assert.ok(!rogue.auras.some((a) => a.id === 'charge_stun'), 'stun is over when he lands');
    assert.ok(rogue.health < hp, 'the landing hits');
  });

  it('movement input is ignored during a charge, and a stun stops it where it is', () => {
    const sim = live();
    const war = add(sim, 'warrior', 0, 0, 0);
    const rogue = add(sim, 'rogue', 1, 20, 0);
    const mage = add(sim, 'mage', 1, 30, 10);
    advance(sim, TICK);
    sim.useAbility(war.id, 'charge', rogue.id);
    sim.queueInput(war.id, { seq: 1, fwd: -1, strafe: 0, facing: Math.PI * 1.5 });
    advance(sim, 150);
    assert.ok(war.pos.x > 3, 'running towards the target despite the input');
    const at = war.pos.x;
    sim.applyAura(rogue, war, 'cheap_shot_stun');
    advance(sim, 100);
    assert.ok(Math.abs(war.pos.x - at) < 2, 'stunned mid-charge');
    assert.equal(war.charge, null);
    void mage;
  });
});

describe('melee and auto-attack', () => {
  it('melee abilities start auto-attack, and warriors build rage from hits', () => {
    const sim = live();
    const war = add(sim, 'warrior', 0, 0, 0);
    const rogue = add(sim, 'rogue', 1, 2, 0);
    advance(sim, TICK);
    war.resource = 30;
    assert.ok(sim.useAbility(war.id, 'mortal_strike', rogue.id).ok);
    assert.ok(war.autoAttack);
    assert.equal(war.resource, 0, 'a rage spender does not refund rage from its own hit');
    const hp = rogue.health;
    advance(sim, 2100);
    assert.ok(rogue.health < hp, 'auto-attack should land');
    assert.ok(war.resource > 0, 'auto-attack hits build rage');
  });
});

describe('vanish', () => {
  it('cleanses debuffs, drops combat, makes enemies lose their target, and stealths you', () => {
    const sim = new ArenaSim({ seed: 1, prepMs: 0 });
    const r = sim.addUnit({ name: 'r', classId: 'rogue', team: 0 });
    const w = sim.addUnit({ name: 'w', classId: 'warrior', team: 1 });
    r.pos = { x: 0, z: 0 }; w.pos = { x: 2, z: 0 };
    advance(sim, 100);
    r.bar = [...r.bar, 'vanish'];
    sim.setTarget(w.id, r.id);
    sim.dealDamage(w, r, 100, 'physical', 'test');
    sim.applyAura(w, r, 'hamstring_slow');
    sim.applyAura(w, r, 'frost_nova_root');
    assert.ok(r.auras.length >= 2);
    mustFail(sim.useAbility(r.id, 'stealth'), /in combat/);
    assert.ok(sim.useAbility(r.id, 'vanish').ok);
    assert.ok(!r.auras.some((a) => a.kind === 'slow' || a.kind === 'root'), 'debuffs removed');
    assert.ok(sim.isStealthed(r), 'stealthed');
    assert.equal(w.target, null, 'the enemy lost its target');
    assert.ok(sim.time - r.lastCombatAt > 5000, 'out of combat');
  });
});

describe('crowd control that breaks on damage', () => {
  it('blind, psychic scream and intimidating shout all end when the victim is hurt', () => {
    for (const aura of ['blind', 'psychic_scream', 'intimidating_shout']) {
      const sim = new ArenaSim({ seed: 1, prepMs: 0 });
      const a = sim.addUnit({ name: 'a', classId: 'rogue', team: 0 });
      const w = sim.addUnit({ name: 'w', classId: 'warrior', team: 1 });
      a.pos = { x: 0, z: 0 }; w.pos = { x: 5, z: 0 };
      advance(sim, 100);
      sim.applyAura(a, w, aura);
      assert.ok(w.auras.some((x) => x.id === aura), `${aura} applied`);
      sim.dealDamage(a, w, 40, 'physical', 'test');
      assert.ok(!w.auras.some((x) => x.id === aura), `${aura} broke on damage`);
    }
  });
});

describe('smoke bomb', () => {
  it('its edge blocks sight both ways; enemies inside the same cloud see and fight each other; allies are unaffected', () => {
    const sim = live();
    const rogue = add(sim, 'rogue', 0, 0, 0);
    const ally = add(sim, 'mage', 0, 2, 0);
    const foe = add(sim, 'warrior', 1, 3, 0);
    const far = add(sim, 'mage', 1, 30, 0);
    rogue.bar = [...rogue.bar, 'choke_bomb']; // normally learned through a talent
    foe.resource = 50;
    advance(sim, TICK);
    sim.setTarget(foe.id, rogue.id);
    sim.setTarget(far.id, rogue.id);
    sim.setTarget(rogue.id, far.id);
    assert.ok(sim.useAbility(rogue.id, 'choke_bomb').ok);
    advance(sim, TICK * 2);
    assert.equal(foe.target, rogue.id, 'inside the cloud with the rogue: the target stays');
    assert.ok(sim.useAbility(foe.id, 'mortal_strike', rogue.id).ok, 'and it can be hit inside the cloud');
    assert.ok(sim.setTarget(rogue.id, foe.id).ok, 'the rogue sees the warrior in the cloud with it');
    assert.equal(far.target, null, 'from outside, the rogue inside is lost from sight');
    mustFail(sim.setTarget(far.id, rogue.id), /not visible/);
    mustFail(sim.setTarget(far.id, ally.id), /not visible/); // anyone inside is hidden from outside
    mustFail(sim.setTarget(rogue.id, far.id), /not visible/); // and from inside, nobody outside can be seen
    assert.ok(sim.setTarget(far.id, foe.id).ok, 'an ally is never hidden by smoke');
    assert.ok(sim.snapshot().zones.some((z) => z.smoke), 'the cloud is in the snapshot');
    foe.pos = { x: 20, z: 0 };
    advance(sim, TICK * 2);
    assert.equal(foe.target, null, 'stepping out of the cloud loses the rogue inside');
    mustFail(sim.setTarget(foe.id, rogue.id), /not visible/);
    mustFail(sim.setTarget(rogue.id, foe.id), /not visible/);
    rogue.pos = { x: 12, z: 0 };
    advance(sim, TICK);
    assert.ok(sim.setTarget(foe.id, rogue.id).ok, 'once the rogue steps out it can be targeted again');
    advance(sim, 7000);
    assert.ok(!sim.snapshot().zones.some((z) => z.smoke), 'the cloud fades');
  });
});

describe('auto-attack lifecycle', () => {
  it('stops when the target is cleared and after leaving combat, but gets time to start', () => {
    const sim = live();
    const war = add(sim, 'warrior', 0, 0, 0);
    const rogue = add(sim, 'rogue', 1, 40, 0);
    advance(sim, TICK);
    sim.setTarget(war.id, rogue.id);
    sim.setAutoAttack(war.id, true);
    advance(sim, 4000);
    assert.ok(war.autoAttack, 'a fresh auto-attack is not cancelled for being out of combat straight away');
    advance(sim, 2000);
    assert.ok(war.autoAttack, 'stays on while an enemy is still targeted');
    sim.setAutoAttack(war.id, true);
    sim.setTarget(war.id, null);
    assert.ok(!war.autoAttack, 'clearing the target turns it off');
  });
});

describe('auto-attack setting', () => {
  it('when disabled, auto-attack never starts, even from a melee ability', () => {
    const sim = live();
    const war = add(sim, 'warrior', 0, 0, 0);
    const rogue = add(sim, 'rogue', 1, 2, 0);
    advance(sim, TICK);
    sim.setAutoDisabled(war.id, true);
    sim.setAutoAttack(war.id, true);
    assert.ok(!war.autoAttack);
    war.resource = 30;
    assert.ok(sim.useAbility(war.id, 'mortal_strike', rogue.id).ok);
    assert.ok(!war.autoAttack);
    const hp = rogue.health;
    advance(sim, 2500);
    assert.equal(rogue.health, hp, 'only the ability damage, no swings');
    sim.setAutoDisabled(war.id, false);
    sim.setAutoAttack(war.id, true);
    assert.ok(war.autoAttack);
  });
});

describe('gear cap and match flow', () => {
  it('caps the gear multiplier at 1.15', () => {
    const sim = live();
    const war = add(sim, 'warrior', 0, 0, 0, 5);
    assert.equal(war.gearMult, TUNING.gearCap);
    assert.equal(war.maxHealth, Math.round(CLASSES.warrior.maxHealth * TUNING.gearCap));
    const low = add(sim, 'mage', 1, 5, 0, 0.1);
    assert.equal(low.gearMult, 1, 'gear never reduces stats below base');
  });

  it('ends the match when a team is wiped, and a forfeit counts as a death', () => {
    const sim = live();
    const a1 = add(sim, 'warrior', 0, -20, 0);
    const b1 = add(sim, 'mage', 1, 20, 0);
    const b2 = add(sim, 'priest', 1, 20, 3);
    advance(sim, TICK);
    assert.equal(sim.phase, 'live');
    sim.dealDamage(a1, b1, 1e6, 'physical', null);
    assert.equal(sim.phase, 'live');
    sim.forfeit(b2.id);
    const ev = advance(sim, TICK);
    assert.equal(sim.phase, 'ended');
    assert.equal(sim.winner, 0);
    assert.ok(ev.some((e) => e.t === 'phase' && e.phase === 'ended' && e.winner === 0));
    mustFail(sim.useAbility(a1.id, 'hamstring', b1.id), /over/);
  });

  it('is deterministic for a given seed', () => {
    const run = () => {
      const sim = new ArenaSim({ seed: 42, prepMs: 0 });
      const m = add(sim, 'mage', 0, 0, 0);
      const w = add(sim, 'warrior', 1, 10, 0);
      advance(sim, TICK);
      sim.useAbility(m.id, 'frostbolt', w.id);
      advance(sim, 1600);
      sim.useAbility(m.id, 'polymorph', w.id);
      advance(sim, 2000);
      return JSON.stringify([sim.snapshot(), sim.drainEvents()]);
    };
    assert.equal(run(), run());
  });
});

describe('protocol validation', () => {
  it('rejects malformed and hostile messages', () => {
    assert.equal(parseClientMsg('not json'), null);
    assert.equal(parseClientMsg('{"t":"input","seq":"x","fwd":1,"strafe":0,"facing":0}'), null);
    assert.equal(parseClientMsg('{"t":"input","seq":1,"fwd":null,"strafe":0,"facing":0}'), null);
    assert.equal(parseClientMsg('{"t":"join","name":"a","classId":"__proto__","mode":"practice"}'), null);
    assert.equal(parseClientMsg('{"t":"join","name":"a","classId":"mage","mode":"god"}'), null);
    assert.equal(parseClientMsg('{"t":"nope"}'), null);
    const j = parseClientMsg('{"t":"join","name":"  <b>Ev</b>il  ","classId":"mage","mode":"queue"}');
    assert.ok(j && j.t === 'join' && !/[<>]/.test(j.name));
  });

  it('sanitizes practice options', () => {
    const j = parseClientMsg(
      '{"t":"join","name":"a","classId":"mage","mode":"practice","foes":["rogue","hax","priest","mage"],"ally":"toString","difficulty":"godlike"}',
    );
    assert.ok(j && j.t === 'join');
    assert.deepEqual(j.foes, ['rogue', 'priest', 'mage'], 'invalid classes dropped, at most three foes');
    const sized = parseClientMsg('{"t":"join","name":"a","classId":"mage","mode":"queue","size":3,"allies":["priest","x","mage","rogue"]}');
    assert.ok(sized && sized.t === 'join');
    assert.equal(sized.size, 3);
    assert.deepEqual(sized.allies, ['priest', 'mage'], 'at most two allies');
    const badSize = parseClientMsg('{"t":"join","name":"a","classId":"mage","mode":"queue","size":9}');
    assert.ok(badSize && badSize.t === 'join' && badSize.size === undefined);
    assert.equal(j.ally, null, 'invalid ally means no ally');
    assert.equal(j.difficulty, undefined, 'unknown difficulty ignored');
    const bare = parseClientMsg('{"t":"join","name":"a","classId":"mage","mode":"practice"}');
    assert.ok(bare && bare.t === 'join' && bare.ally === undefined && bare.foes === undefined);
  });
});

describe('v0.23 combat rules', () => {
  const T = TUNING.tickMs;
  const run = (sim: ArenaSim, ms: number) => { for (let t = 0; t < ms; t += T) { sim.step(); sim.drainEvents(); } };
  it('auto-attacks do not hit through a pillar', () => {
    const arena = arenaById('colosseum');
    const sim = new ArenaSim({ seed: 1, prepMs: 0, arena });
    const p = arena.pillars[0];
    const w = sim.addUnit({ name: 'w', classId: 'warrior', team: 0 });
    const m = sim.addUnit({ name: 'm', classId: 'mage', team: 1 });
    // stand the two on opposite sides of the pillar, within melee reach of each other's centre line
    w.pos = { x: p.x - p.r - 0.6, z: p.z };
    m.pos = { x: p.x + p.r + 0.6, z: p.z };
    run(sim, 100);
    sim.setTarget(w.id, m.id);
    sim.setAutoAttack(w.id, true);
    w.nextSwing = 0;
    const hp = m.health;
    run(sim, 6000);
    assert.equal(m.health, hp);
  });
  it('starting another spell cancels the cast in progress, but a failed attempt does not', () => {
    const sim = new ArenaSim({ seed: 2, prepMs: 0 });
    const a = sim.addUnit({ name: 'a', classId: 'mage', team: 0 });
    const b = sim.addUnit({ name: 'b', classId: 'warrior', team: 1 });
    a.pos = { x: 0, z: 0 }; b.pos = { x: 10, z: 0 };
    run(sim, 100);
    assert.ok(sim.useAbility(a.id, 'polymorph', b.id).ok);
    run(sim, 1600); // past the global cooldown, mid-cast
    assert.ok(a.cast?.ability === 'polymorph');
    const r = sim.useAbility(a.id, 'frostbolt', b.id);
    assert.ok(r.ok);
    assert.equal(a.cast?.ability, 'frostbolt');
  });
  it('blink works while stunned, polymorph is limited to one target, and a sheep stands still, turns, heals and cannot blink', () => {
    const sim = new ArenaSim({ seed: 3, prepMs: 0 });
    const mage = sim.addUnit({ name: 'm', classId: 'mage', team: 0 });
    const w1 = sim.addUnit({ name: 'w1', classId: 'warrior', team: 1 });
    const w2 = sim.addUnit({ name: 'w2', classId: 'warrior', team: 1 });
    mage.pos = { x: 0, z: 0 }; w1.pos = { x: 6, z: 0 }; w2.pos = { x: -6, z: 0 };
    run(sim, 100);
    sim.applyAura(w1, mage, 'cheap_shot_stun');
    const before = { ...mage.pos };
    assert.ok(sim.useAbility(mage.id, 'blink').ok, 'blink while stunned');
    assert.ok(Math.hypot(mage.pos.x - before.x, mage.pos.z - before.z) > 5);
    assert.ok(!mage.auras.some((a) => a.kind === 'stun'), 'blink breaks the stun');
    mage.auras = [];
    sim.applyAura(mage, w1, 'polymorph');
    sim.applyAura(mage, w2, 'polymorph');
    assert.ok(!w1.auras.some((x) => x.id === 'polymorph'), 'first target freed');
    assert.ok(w2.auras.some((x) => x.id === 'polymorph'));
    const p0 = { ...w2.pos };
    w2.health = Math.floor(w2.maxHealth / 2);
    const h0 = w2.health;
    sim.queueInput(w2.id, { seq: 1, fwd: 1, strafe: 0, facing: 2 });
    run(sim, 2000);
    assert.ok(Math.hypot(w2.pos.x - p0.x, w2.pos.z - p0.z) < 0.01, 'sheep stands still');
    assert.ok(w2.health > h0, 'sheep heals a little');
    assert.ok(w2.health - h0 >= w2.maxHealth * 0.15, `healed ${(w2.health - h0) / w2.maxHealth} of max in 2 s`);
    assert.equal(w2.facing, 2, 'sheep can turn');
    mage.auras = [];
    const blinker = sim.addUnit({ name: 'b', classId: 'mage', team: 1 });
    blinker.pos = { x: 0, z: 8 };
    run(sim, 100);
    sim.applyAura(mage, blinker, 'polymorph');
    assert.ok(!sim.useAbility(blinker.id, 'blink').ok, 'no blink while polymorphed');
  });
});

describe('v0.24 damage over time, penance and ground spells', () => {
  const T = TUNING.tickMs;
  const run = (sim: ArenaSim, ms: number) => { for (let t = 0; t < ms; t += T) { sim.step(); sim.drainEvents(); } };
  const shadow = { spec: 'shadow', talents: [] as string[], gear: {} };
  it('creeping rot has no cooldown and ticks damage for its whole duration', () => {
    const sim = new ArenaSim({ seed: 4, prepMs: 0 });
    const p = sim.addUnit({ name: 'p', classId: 'priest', team: 0, build: shadow });
    const w = sim.addUnit({ name: 'w', classId: 'warrior', team: 1 });
    p.pos = { x: 0, z: 0 }; w.pos = { x: 10, z: 0 };
    run(sim, 100);
    const hp = w.health;
    assert.ok(sim.useAbility(p.id, 'shadow_word_death', w.id).ok);
    assert.equal(p.cooldowns.shadow_word_death ?? 0, 0, 'no cooldown');
    run(sim, 5100);
    const mid = hp - w.health;
    assert.ok(mid > 100 && mid < 250, `ticking, got ${mid}`);
    run(sim, 8000);
    const total = hp - w.health;
    assert.ok(total > 250 && total < 380, `ten ticks in total, got ${total}`);
    assert.ok(!w.auras.some((a) => a.id === 'creeping_rot'));
  });
  it('blightbloom is a bigger dot on a cooldown', () => {
    const sim = new ArenaSim({ seed: 5, prepMs: 0 });
    const p = sim.addUnit({ name: 'p', classId: 'priest', team: 0, build: shadow });
    const w = sim.addUnit({ name: 'w', classId: 'warrior', team: 1 });
    p.pos = { x: 0, z: 0 }; w.pos = { x: 10, z: 0 };
    run(sim, 100);
    assert.ok(sim.useAbility(p.id, 'plague_bloom', w.id).ok);
    assert.ok((p.cooldowns.plague_bloom ?? 0) > sim.time);
    run(sim, 11000);
    assert.ok(w.maxHealth - w.health > 330);
  });
  it('sacred lash heals a friend and hurts a foe', () => {
    const sim = new ArenaSim({ seed: 6, prepMs: 0 });
    const p = sim.addUnit({ name: 'p', classId: 'priest', team: 0, build: { spec: 'discipline', talents: [], gear: {} } });
    const ally = sim.addUnit({ name: 'a', classId: 'warrior', team: 0 });
    const foe = sim.addUnit({ name: 'f', classId: 'warrior', team: 1 });
    p.pos = { x: 0, z: 0 }; ally.pos = { x: 5, z: 0 }; foe.pos = { x: -5, z: 0 };
    ally.health = 1000;
    run(sim, 100);
    assert.ok(sim.useAbility(p.id, 'penance', ally.id).ok);
    run(sim, 2000);
    assert.ok(ally.health > 1100 && foe.health === foe.maxHealth, 'ally healed, foe untouched');
    p.cooldowns = {}; p.gcdEnd = 0;
    assert.ok(sim.useAbility(p.id, 'penance', foe.id).ok);
    run(sim, 2000);
    assert.ok(foe.health < foe.maxHealth - 100, 'foe damaged');
  });
  it('a channel keeps working when the target moves behind a pillar', () => {
    const arena = arenaById('colosseum');
    const sim = new ArenaSim({ seed: 8, prepMs: 0, arena });
    const pil = arena.pillars[0];
    const p = sim.addUnit({ name: 'p', classId: 'priest', team: 0, build: { spec: 'discipline', talents: [], gear: {} } });
    const ally = sim.addUnit({ name: 'a', classId: 'warrior', team: 0 });
    const foe = sim.addUnit({ name: 'f', classId: 'warrior', team: 1 });
    foe.pos = { x: 25, z: 15 };
    p.pos = { x: pil.x - pil.r - 3, z: pil.z + 8 };
    ally.pos = { x: pil.x - pil.r - 3, z: pil.z + 12 };
    ally.health = 1000;
    run(sim, 100);
    const r = sim.useAbility(p.id, 'penance', ally.id);
    assert.ok(r.ok, (r as any).reason);
    run(sim, 400);
    ally.pos = { x: pil.x + pil.r + 0.6, z: pil.z };
    p.pos = { x: pil.x - pil.r - 0.6, z: pil.z };
    run(sim, 2000);
    assert.ok(ally.health > 1150, `all three ticks landed through the pillar (${ally.health})`);
  });
  it('a ground spell lands where it is aimed, within range and line of sight', () => {
    const arena = arenaById('colosseum');
    const sim = new ArenaSim({ seed: 7, prepMs: 0, arena });
    const m = sim.addUnit({ name: 'm', classId: 'mage', team: 0, build: { spec: 'fire', talents: [], gear: {} } });
    const w = sim.addUnit({ name: 'w', classId: 'warrior', team: 1 });
    m.pos = { x: 0, z: 0 }; w.pos = { x: 20, z: 0 };
    run(sim, 100);
    const r = sim.useAbility(m.id, 'flamestrike', null, { x: 12, z: 3 });
    assert.ok(r.ok, (r as any).reason);
    run(sim, 3200);
    const z = sim.snapshot().zones.find((q: any) => q.ability === 'flamestrike');
    assert.ok(z && Math.abs(z.x - 12) < 0.1 && Math.abs(z.z - 3) < 0.1);
    m.cooldowns = {}; m.gcdEnd = 0; m.cast = null; m.pos = { x: -25, z: 0 };
    assert.ok(!sim.useAbility(m.id, 'flamestrike', null, { x: 80, z: 0 }).ok, 'out of range');
    assert.ok(!sim.useAbility(m.id, 'flamestrike').ok, 'needs a location');
  });
});

describe('lag compensation', () => {
  it('judges range against where the target stood on the caster\'s screen, within a cap, and replays reproduce it', () => {
    const make = () => {
      const sim = new ArenaSim({ seed: 3, prepMs: 0 });
      const m = sim.addUnit({ name: 'm', classId: 'mage', team: 0, controller: 'bot' });
      const w = sim.addUnit({ name: 'w', classId: 'warrior', team: 1, controller: 'dummy' });
      m.pos = { x: 0, z: 0 };
      for (let i = 0; i < 400 / sim.tickMs; i++) { w.pos = { x: 28, z: 0 }; sim.step(); }
      w.pos = { x: 33, z: 0 }; // it has since stepped out of reach (frostbolt reaches 30 plus a 1.5 allowance)
      sim.step();
      return { sim, m, w };
    };
    let { sim, m, w } = make();
    assert.ok(!sim.useAbility(m.id, 'frostbolt', w.id).ok, 'no compensation: out of range');
    ({ sim, m, w } = make());
    assert.ok(sim.useAbility(m.id, 'frostbolt', w.id, null, 150).ok, 'saw it in range 150 ms ago');
    ({ sim, m, w } = make());
    assert.ok(!sim.useAbility(m.id, 'frostbolt', w.id, null, 0).ok);
    ({ sim, m, w } = make());
    w.pos = { x: 60, z: 0 };
    for (let i = 0; i < 400 / sim.tickMs; i++) { sim.step(); }
    assert.ok(!sim.useAbility(m.id, 'frostbolt', w.id, null, 10000).ok, 'the rewind is capped, so a very old view cannot hit a far target');
  });
});

describe('movement speed', () => {
  it('stealth no longer slows you and a feared unit stumbles at a fraction of run speed', () => {
    const run = (setup: (sim: ArenaSim, u: any) => void) => {
      const sim = new ArenaSim({ seed: 3, prepMs: 0 });
      const u = sim.addUnit({ name: 'r', classId: 'rogue', team: 0 });
      sim.addUnit({ name: 'e', classId: 'warrior', team: 1, controller: 'dummy' }).pos = { x: 60, z: 60 };
      u.pos = { x: 0, z: 0 };
      sim.step();
      setup(sim, u);
      const from = { ...u.pos };
      for (let i = 0; i < 1000 / sim.tickMs; i++) { sim.queueInput(u.id, { seq: i + 1, fwd: 1, strafe: 0, facing: 0 }); sim.step(); }
      return Math.hypot(u.pos.x - from.x, u.pos.z - from.z);
    };
    const plain = run(() => {});
    const hidden = run((sim, u) => sim.applyAura(u, u, 'stealth'));
    assert.ok(Math.abs(hidden - plain) < 0.01, `${hidden} vs ${plain}`);
    const feared = run((sim, u) => { const f = sim.units.get(2)!; sim.applyAura(f, u, 'psychic_scream'); });
    assert.ok(feared < plain * 0.45, `feared ${feared} vs ${plain}`);
  });
});

describe('facing rule', () => {
  it('casts and swings need the target inside a 180 degree half-circle in front of the player', () => {
    const sim = new ArenaSim({ seed: 3, prepMs: 0, facing: true });
    const m = sim.addUnit({ name: 'm', classId: 'mage', team: 0 });
    const w = sim.addUnit({ name: 'w', classId: 'warrior', team: 1 });
    let seq = 0;
    const face = (a: number) => {
      sim.queueInput(m.id, { seq: ++seq, fwd: 0, strafe: 0, facing: a });
      advance(sim, 100);
    };
    m.pos = { x: 0, z: 0 };
    w.pos = { x: 10, z: 0 }; // due +x
    advance(sim, 100);
    face(Math.atan2(1, 0) + Math.PI);
    const missed = () => {
      assert.ok(sim.useAbility(m.id, 'frostbolt', w.id).ok, 'held for the lag grace');
      assert.equal(m.cast, null, 'not casting while held');
      const ev = advance(sim, TUNING.castGraceMs + 100);
      assert.ok(ev.some((e: any) => e.t === 'cast_fail' && /in front/.test(e.reason)), 'fails once the grace is over');
      assert.equal(m.cast, null);
      assert.equal(ev.some((e: any) => e.t === 'cast_start'), false);
    };
    missed();
    face(Math.atan2(10, 0));
    assert.ok(sim.useAbility(m.id, 'frostbolt', w.id).ok);
    advance(sim, 3000);
    m.cooldowns = {}; m.gcdEnd = 0;
    face(Math.atan2(10, 0) + 1.4);
    assert.ok(sim.useAbility(m.id, 'frostbolt', w.id).ok);
    advance(sim, 3000);
    m.cooldowns = {}; m.gcdEnd = 0;
    face(Math.atan2(10, 0) + 1.7);
    missed();
  });

  it('a cast that only misses on range or facing is held briefly and lands if the target comes back in reach', () => {
    const sim = new ArenaSim({ seed: 3, prepMs: 0, facing: true });
    const m = sim.addUnit({ name: 'm', classId: 'mage', team: 0 });
    const w = sim.addUnit({ name: 'w', classId: 'warrior', team: 1 });
    m.pos = { x: 0, z: 0 };
    m.facing = Math.atan2(1, 0);
    w.pos = { x: 33, z: 0 }; // frostbolt reaches 30 (+1.5 allowance)
    advance(sim, 100);
    assert.ok(sim.useAbility(m.id, 'frostbolt', w.id).ok);
    assert.equal(m.cast, null);
    w.pos = { x: 28, z: 0 }; // it steps back into reach during the grace window
    advance(sim, TICK * 2);
    assert.equal((m.cast as { ability: string } | null)?.ability, 'frostbolt', 'the held cast started once in reach');
    // a later press replaces a held cast and bots are never held
    const bot = sim.addUnit({ name: 'b', classId: 'mage', team: 0, controller: 'bot' });
    bot.pos = { x: 0, z: 5 };
    w.pos = { x: 60, z: 0 };
    assert.ok(!sim.useAbility(bot.id, 'frostbolt', w.id).ok, 'bots get an immediate failure');
  });
});

describe('training dummies', () => {
  it('stand up again at full health and never end the match', () => {
    const sim = live();
    const war = add(sim, 'warrior', 0, 0, 0);
    const d = sim.addUnit({ name: 'Dummy', classId: 'warrior', team: 1, controller: 'dummy' });
    d.pos = { x: 2, z: 0 };
    const home = { ...d.home! };
    advance(sim, TICK);
    d.health = 0;
    d.alive = false;
    (sim as unknown as { die(u: Unit, k: number | null): void }).die(d, war.id);
    d.alive = false;
    assert.ok(d.respawnAt !== undefined, 'respawn scheduled');
    const evs = advance(sim, 3000);
    assert.ok(d.alive, 'dummy is back');
    assert.equal(d.health, d.maxHealth);
    assert.deepEqual(d.pos, home);
    assert.ok(evs.some((e) => e.t === 'respawn' && e.unit === d.id));
    assert.equal(sim.phase, 'live', 'match keeps going');
  });

  it('a player dying still ends the match', () => {
    const sim = live();
    const war = add(sim, 'warrior', 0, 0, 0);
    sim.addUnit({ name: 'Dummy', classId: 'warrior', team: 1, controller: 'dummy' });
    advance(sim, TICK);
    (sim as unknown as { die(u: Unit, k: number | null): void }).die(war, null);
    advance(sim, TICK * 2);
    assert.equal(sim.phase, 'ended');
  });
});

describe('auto-attack persistence', () => {
  it('stays on past the out-of-combat timer while an enemy is targeted, and still expires without one', () => {
    const sim = live();
    const war = add(sim, 'warrior', 0, 0, 0);
    const foe = add(sim, 'warrior', 1, 25, 0);
    advance(sim, TICK);
    sim.setTarget(war.id, foe.id);
    sim.setAutoAttack(war.id, true);
    assert.ok(war.autoAttack);
    advance(sim, TUNING.outOfCombatMs + 2000);
    assert.ok(war.autoAttack, 'kept while targeting an enemy');
    sim.setTarget(war.id, null);
    sim.setAutoAttack(war.id, true);
    advance(sim, TUNING.outOfCombatMs + 2000);
    assert.equal(war.autoAttack, false);
  });
});

describe('dampening', () => {
  const mk = (classes: [string, string | null][]) => {
    const sim = new ArenaSim({ seed: 1, prepMs: 0 });
    classes.forEach(([c, spec], i) => { const u = sim.addUnit({ name: 'u' + i, classId: c as any, team: (i % 2) as 0 | 1, controller: 'dummy' }); if (spec) u.spec = spec; });
    sim.step();
    return sim;
  };
  const advanceMs = (sim: ArenaSim, ms: number) => { for (let t = 0; t < ms; t += TUNING.tickMs) sim.step(); };
  it('starts late, grows slowly and is capped, in a match with a healer', () => {
    const sim = mk([['priest', 'holy'], ['warrior', 'arms']]);
    advanceMs(sim, TUNING.dampenStartMs - 2000);
    assert.equal(sim.dampening(), 0, 'nothing before it starts');
    assert.equal((sim.snapshot() as { damp?: number }).damp, undefined);
    advanceMs(sim, 12000);
    const d = sim.dampening();
    assert.ok(d > 0 && d < 0.1, `a gentle start: ${d}`);
    assert.equal((sim.snapshot() as { damp?: number }).damp, Math.round(d * 100) / 100);
    advanceMs(sim, 600000);
    assert.equal(sim.dampening(), TUNING.dampenMax, 'capped');
  });
  it('is off in a match without a healer', () => {
    const sim = mk([['warrior', 'arms'], ['mage', 'fire']]);
    advanceMs(sim, TUNING.dampenStartMs + 60000);
    assert.equal(sim.dampening(), 0);
  });
  it('weakens heals and new shields by its amount', () => {
    const sim = mk([['priest', 'holy'], ['warrior', 'arms']]);
    const p = [...sim.units.values()][0];
    p.maxHealth = p.health = 1e6;
    p.health = 1;
    const fresh = sim.heal(p, p, 10000, 'flash_heal');
    advanceMs(sim, TUNING.dampenStartMs + 60000);
    const d = sim.dampening();
    assert.ok(d > 0.1);
    p.health = 1;
    const weak = sim.heal(p, p, 10000, 'flash_heal');
    assert.ok(Math.abs(weak - fresh * (1 - d)) <= 2, `${weak} vs ${fresh} * ${1 - d}`);
  });
});
