import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArenaSim, AURAS, CLASSES, TUNING, arenaById, parseClientMsg } from '../src/index';
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

describe('casting, interrupts and school lockouts', () => {
  it('interrupts a cast, locks only that school, and kick needs a casting target', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0);
    const rogue = add(sim, 'rogue', 1, 3, 0);
    advance(sim, TICK);
    mustFail(sim.useAbility(rogue.id, 'kick', mage.id), /not casting/);

    assert.ok(sim.useAbility(mage.id, 'fireball', rogue.id).ok);
    advance(sim, 500);
    assert.ok(mage.cast, 'mage should be mid-cast');
    // rogue is in melee range after closing the gap
    rogue.pos = { x: 1, z: 0 };
    const r = sim.useAbility(rogue.id, 'kick', mage.id);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(mage.cast, null);
    const ev = sim.drainEvents();
    assert.ok(ev.some((e) => e.t === 'interrupt' && e.school === 'fire'));

    advance(sim, TUNING.gcdMs);
    mustFail(sim.useAbility(mage.id, 'fireball', rogue.id), /fire school is locked out/);
    assert.ok(sim.useAbility(mage.id, 'frostbolt', rogue.id).ok, 'frost must still be castable');
  });

  it('cancels a cast when the caster moves', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0);
    const war = add(sim, 'warrior', 1, 10, 0);
    advance(sim, TICK);
    assert.ok(sim.useAbility(mage.id, 'fireball', war.id).ok);
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
    assert.equal(dur(), 4000);
    advance(sim, 4100);
    assert.equal(dur(), 2000);
    advance(sim, 2100);
    assert.equal(dur(), 1000);
    advance(sim, 1100);
    assert.equal(dur(), 'immune');
    advance(sim, TUNING.drResetMs + TICK);
    assert.equal(dur(), 4000, 'DR should have reset');
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

    assert.ok(sim.useAbility(mage.id, 'fireball', war.id).ok);
    sim.applyAura(war, mage, 'kidney_shot');
    assert.equal(mage.cast, null, 'stun cancels the cast');
    mustFail(sim.useAbility(mage.id, 'frostbolt', war.id), /incapacitated/);
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
    for (let i = 1; i <= 20; i++) {
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
    advance(sim, TICK);
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
    advance(sim, TICK * 3);
    assert.ok(war.pos.x > 3, 'running towards the target despite the input');
    const at = war.pos.x;
    sim.applyAura(rogue, war, 'cheap_shot_stun');
    advance(sim, TICK * 2);
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
    const rageAfterCast = war.resource;
    assert.ok(rageAfterCast > 0, 'rage from dealing damage');
    const hp = rogue.health;
    advance(sim, 2100);
    assert.ok(rogue.health < hp, 'auto-attack should land');
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
  it('enemies inside lose their target and cannot target; the caster team can, and leaving restores it', () => {
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
    assert.equal(foe.target, rogue.id);
    assert.ok(sim.useAbility(rogue.id, 'choke_bomb').ok);
    advance(sim, TICK * 2);
    assert.equal(foe.target, null, 'target taken away inside the cloud');
    assert.equal(far.target, rogue.id, 'outside the cloud nothing changes');
    mustFail(sim.setTarget(foe.id, rogue.id), /smoke/);
    mustFail(sim.useAbility(foe.id, 'mortal_strike', rogue.id), /smoke/);
    assert.ok(sim.setTarget(ally.id, foe.id).ok, 'the caster team is not affected');
    assert.ok(sim.snapshot().zones.some((z) => z.smoke), 'the cloud is in the snapshot');
    foe.pos = { x: 20, z: 0 };
    advance(sim, TICK * 2);
    assert.ok(sim.setTarget(foe.id, rogue.id).ok, 'can target again after leaving');
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
    assert.ok(!war.autoAttack, 'times out with no combat');
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
  it('blink works while stunned, polymorph is limited to one target and polymorphed units wander', () => {
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
    run(sim, 2000);
    assert.ok(Math.hypot(w2.pos.x - p0.x, w2.pos.z - p0.z) > 0.5, 'sheep wanders');
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
    const p = sim.addUnit({ name: 'p', classId: 'priest', team: 0, build: { spec: 'discipline', talents: ['', '', '', 'tal_penance', '', ''], gear: {} } });
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
    const p = sim.addUnit({ name: 'p', classId: 'priest', team: 0, build: { spec: 'discipline', talents: ['', '', '', 'tal_penance', '', ''], gear: {} } });
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
    run(sim, 2000);
    const z = sim.snapshot().zones.find((q: any) => q.ability === 'flamestrike');
    assert.ok(z && Math.abs(z.x - 12) < 0.1 && Math.abs(z.z - 3) < 0.1);
    m.cooldowns = {}; m.gcdEnd = 0; m.cast = null; m.pos = { x: -25, z: 0 };
    assert.ok(!sim.useAbility(m.id, 'flamestrike', null, { x: 80, z: 0 }).ok, 'out of range');
    assert.ok(!sim.useAbility(m.id, 'flamestrike').ok, 'needs a location');
  });
});

describe('facing rule', () => {
  it('casts and swings need the target inside a 90 degree cone in front of the player', () => {
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
    mustFail(sim.useAbility(m.id, 'frostbolt', w.id), /in front/);
    face(Math.atan2(10, 0));
    assert.ok(sim.useAbility(m.id, 'frostbolt', w.id).ok);
    advance(sim, 3000);
    m.cooldowns = {}; m.gcdEnd = 0;
    face(Math.atan2(10, 0) + 0.7);
    assert.ok(sim.useAbility(m.id, 'frostbolt', w.id).ok);
    advance(sim, 3000);
    m.cooldowns = {}; m.gcdEnd = 0;
    face(Math.atan2(10, 0) + 0.9);
    mustFail(sim.useAbility(m.id, 'frostbolt', w.id), /in front/);
  });
});
