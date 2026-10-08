import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, ArenaSim, AURAS, TUNING, barFor, stealthSwapsFor, talentsFor, trinketFor, validateBuild } from '../src/index';
import type { Build, ClassId, SimEvent, TeamId, Unit } from '../src/index';

const TICK = TUNING.tickMs;
const live = (seed = 1) => new ArenaSim({ seed, prepMs: 0 });
function advance(sim: ArenaSim, ms: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let t = 0; t < ms; t += TICK) {
    sim.step();
    out.push(...sim.drainEvents());
  }
  return out;
}
/** A unit with a build: `picks` maps a tier index to a talent id. */
function unit(sim: ArenaSim, classId: ClassId, team: TeamId, x: number, z: number, spec: string, picks: Record<number, string> = {}, replace?: Record<string, string>): Unit {
  const talents = ['', '', '', '', ''];
  for (const [i, id] of Object.entries(picks)) talents[Number(i)] = id;
  const build: Build = { spec, talents, gear: {}, ...(replace ? { replace } : {}) };
  const u = sim.addUnit({ name: `${classId}${team}`, classId, team, build });
  u.pos = { x, z };
  return u;
}
const ok = (r: { ok: boolean; reason?: string }) => assert.ok(r.ok, (r as { reason?: string }).reason);

describe('the five-tier talent tree', () => {
  it('every spec has five tiers of three, the trinket in tier four and a class pick in tier five', () => {
    for (const cls of ['warrior', 'mage', 'priest', 'rogue'] as ClassId[]) {
      for (const spec of Object.keys({ warrior: { arms: 1, fury: 1, protection: 1 }, mage: { frost: 1, fire: 1, arcane: 1 }, priest: { discipline: 1, holy: 1, shadow: 1 }, rogue: { assassination: 1, combat: 1, subtlety: 1 } }[cls])) {
        const tiers = talentsFor(cls, spec);
        assert.equal(tiers.length, 5, `${cls} ${spec}`);
        for (const t of tiers) assert.equal(t.length, 3);
        assert.deepEqual(tiers[3].map((t) => t.trinket), ['trinket_cleanse', 'trinket_shield', 'trinket_heal']);
        assert.ok(tiers[4].every((t) => t.swap), 'tier five swaps a skill');
      }
    }
  });

  it('the Duelist starts with Gouge in place of Evasion; Sap rides on the Kidney Shot button', () => {
    const duel = unit(live(), 'rogue', 0, 0, 0, 'combat');
    assert.ok(duel.bar.includes('gouge') && !duel.bar.includes('evasion'));
    const b: Build = { spec: 'assassination', talents: ['', '', '', '', 'rogue_t5c'], gear: {} };
    assert.deepEqual(stealthSwapsFor('rogue', b), { kidney_shot: 'sap' });
    assert.ok(barFor('rogue', b, []).includes('kidney_shot'), 'the button stays Kidney Shot out of stealth');
  });

  it('a swap that can replace two skills lets you choose, and rejects any other', () => {
    const base: Build = { spec: 'frost', talents: ['', '', '', '', 'mage_t5c'], gear: {} };
    assert.ok(barFor('mage', base, []).includes('counterspell') && !barFor('mage', base, []).includes('polymorph'), 'Polymorph is given up unless you say otherwise');
    const chosen: Build = { ...base, replace: { mage_t5c: 'counterspell' } };
    assert.ok(barFor('mage', chosen, []).includes('polymorph') && !barFor('mage', chosen, []).includes('counterspell'));
    assert.ok(validateBuild('mage', chosen).ok);
    assert.equal(validateBuild('mage', { ...base, replace: { mage_t5c: 'blink' } }).ok, false);
    assert.equal(validateBuild('mage', { ...base, talents: ['', '', '', '', ''], replace: { mage_t5c: 'counterspell' } }).ok, false, 'only for a talent you picked');
  });

  it('priest tier five replaces Desperate Prayer, or Power Word: Shield on a Gloomweaver', () => {
    const w: Build = { spec: 'discipline', talents: ['', '', '', '', 'priest_discipline_t5a'], gear: {} };
    const bar = barFor('priest', w, []);
    assert.ok(bar.includes('leap_of_faith') && !bar.includes('desperate_prayer') && bar.includes('power_word_shield'));
    const g: Build = { spec: 'shadow', talents: ['', '', '', '', 'priest_shadow_t5c'], gear: {} };
    const gb = barFor('priest', g, []);
    assert.ok(gb.includes('ascend') && !gb.includes('power_word_shield'));
  });
});

describe('trinkets', () => {
  it('cleanse, shield and heal work from the side button, even while stunned and mid-cast', () => {
    const sim = live();
    const mage = unit(sim, 'mage', 0, 0, 0, 'frost', { 3: 'trinket_cleanse' });
    const foe = unit(sim, 'warrior', 1, 4, 0, 'arms');
    assert.equal(trinketFor('mage', { spec: 'frost', talents: ['', '', '', 'trinket_cleanse'], gear: {} }), 'trinket_cleanse');
    advance(sim, TICK);
    ok(sim.useAbility(mage.id, 'frostbolt', foe.id));
    assert.ok(mage.cast);
    sim.applyAura(foe, mage, 'cheap_shot_stun'); // stunned (and the cast stops)
    assert.ok(mage.auras.some((a) => a.kind === 'stun'));
    ok(sim.useAbility(mage.id, 'trinket_cleanse'));
    assert.ok(!mage.auras.some((a) => a.kind === 'stun'), 'the stun is gone');
    assert.ok((mage.cooldowns.trinket_cleanse ?? 0) > sim.time, '60 s cooldown');

    const w = unit(sim, 'warrior', 0, 0, 5, 'arms', { 3: 'trinket_shield' });
    ok(sim.useAbility(w.id, 'trinket_shield'));
    assert.equal(w.auras.find((a) => a.id === 'trinket_shield')?.absorbLeft, Math.round(w.maxHealth * 0.2 * w.gearMult));
    const p = unit(sim, 'priest', 0, 0, -5, 'holy', { 3: 'trinket_heal' });
    p.health = 1000;
    ok(sim.useAbility(p.id, 'trinket_heal'));
    assert.equal(p.health, 1000 + Math.round(p.maxHealth * 0.25));
  });

  it('a trinket you did not pick cannot be used', () => {
    const sim = live();
    const m = unit(sim, 'mage', 0, 0, 0, 'frost');
    unit(sim, 'warrior', 1, 5, 0, 'arms');
    advance(sim, TICK);
    assert.equal(sim.useAbility(m.id, 'trinket_heal').ok, false);
  });
});

describe('mage tier one: Blink', () => {
  it('Twin Blink gives two charges that recharge on their own, with the count in the snapshot', () => {
    const sim = live();
    const m = unit(sim, 'mage', 0, 0, 0, 'frost', { 0: 'mage_t1a' });
    unit(sim, 'warrior', 1, 30, 0, 'arms');
    advance(sim, TICK);
    assert.equal(sim.snapshot().units.find((u) => u.id === m.id)!.charges?.blink, 2);
    ok(sim.useAbility(m.id, 'blink'));
    advance(sim, TICK);
    assert.equal(sim.snapshot().units.find((u) => u.id === m.id)!.charges?.blink, 1);
    advance(sim, 3000);
    ok(sim.useAbility(m.id, 'blink'));
    assert.equal(sim.useAbility(m.id, 'blink').ok, false, 'both spent');
    advance(sim, 12200);
    assert.equal(sim.snapshot().units.find((u) => u.id === m.id)!.charges?.blink, 1, 'the first is back after its own 15 s, the second is not');
    ok(sim.useAbility(m.id, 'blink'));
  });

  it('without the talent, Blink stops a cast; with Blink and Cast the spell keeps casting', () => {
    for (const talent of ['', 'mage_t1b']) {
      const sim = live();
      const m = unit(sim, 'mage', 0, 0, 0, 'frost', talent ? { 0: talent } : {});
      const foe = unit(sim, 'warrior', 1, 10, 0, 'arms');
      advance(sim, TICK);
      m.facing = -Math.PI / 2; // blink away from the foe
      ok(sim.useAbility(m.id, 'frostbolt', foe.id));
      advance(sim, TICK);
      assert.ok(m.cast);
      const from = m.pos.x;
      ok(sim.useAbility(m.id, 'blink'));
      advance(sim, TICK);
      assert.ok(Math.abs(m.pos.x - from) > 5, 'it blinked');
      assert.equal(!!m.cast, talent === 'mage_t1b', talent ? 'the cast goes on' : 'the cast stopped');
    }
  });

  it('Frozen Departure freezes enemies near where you stood', () => {
    const sim = live();
    const m = unit(sim, 'mage', 0, 0, 0, 'frost', { 0: 'mage_t1c' });
    const near = unit(sim, 'warrior', 1, 3, 0, 'arms');
    const far = unit(sim, 'warrior', 1, 40, 0, 'arms');
    advance(sim, TICK);
    m.facing = -Math.PI / 2;
    ok(sim.useAbility(m.id, 'blink'));
    advance(sim, TICK);
    assert.ok(near.auras.some((a) => a.id === 'frost_nova_root'), 'rooted by the nova');
    assert.ok(!far.auras.some((a) => a.id === 'frost_nova_root'));
    assert.ok(!(m.cooldowns.frost_nova > sim.time), 'the free nova does not use the real Frost Nova');
  });
});

describe('warrior tier one: Charge', () => {
  it('Pinning Charge roots the target for 2 seconds once you arrive', () => {
    const sim = live();
    const w = unit(sim, 'warrior', 0, 0, 0, 'arms', { 0: 'warrior_t1a' });
    const foe = unit(sim, 'mage', 1, 15, 0, 'frost');
    advance(sim, TICK);
    w.facing = Math.PI / 2;
    ok(sim.useAbility(w.id, 'charge', foe.id));
    for (let i = 0; i < 80 && w.charge; i++) advance(sim, TICK);
    advance(sim, TICK);
    assert.ok(foe.auras.some((a) => a.id === 'charge_root'), JSON.stringify(foe.auras.map((a) => a.id)));
    advance(sim, 2200);
    assert.ok(!foe.auras.some((a) => a.id === 'charge_root'));
  });

  it('Long Charge reaches 10 yards further', () => {
    const sim = live();
    const w = unit(sim, 'warrior', 0, 0, 0, 'arms', { 0: 'warrior_t1b' });
    const foe = unit(sim, 'mage', 1, 33, 0, 'frost');
    advance(sim, TICK);
    w.facing = Math.PI / 2;
    ok(sim.useAbility(w.id, 'charge', foe.id));
    const plain = unit(live(), 'warrior', 0, 0, 0, 'arms');
    assert.ok(ABILITIES.charge.range < 33 && ABILITIES.charge.range + 10 >= 33 && plain);
  });

  it('Intercept: Charge on an ally rushes to them and gives 20% less damage; on yourself you stay put', () => {
    const sim = live();
    const w = unit(sim, 'warrior', 0, 0, 0, 'arms', { 0: 'warrior_t1c' });
    const ally = unit(sim, 'priest', 0, 18, 0, 'holy');
    unit(sim, 'mage', 1, 40, 10, 'frost');
    advance(sim, TICK);
    w.facing = Math.PI / 2;
    ok(sim.useAbility(w.id, 'charge', ally.id));
    for (let i = 0; i < 80 && w.charge; i++) advance(sim, TICK);
    assert.ok(Math.hypot(w.pos.x - ally.pos.x, w.pos.z - ally.pos.z) < 2.2, 'arrived beside the ally');
    assert.ok(ally.auras.some((a) => a.id === 'intercept_guard'));
    assert.ok(!ally.auras.some((a) => a.id === 'charge_stun'), 'no stun on a friend');
    advance(sim, 15000);
    const at = { ...w.pos };
    ok(sim.useAbility(w.id, 'charge', w.id));
    advance(sim, 300);
    assert.deepEqual(w.pos, at);
    assert.ok(w.auras.some((a) => a.id === 'intercept_guard'), 'the guard is on you');
  });

  it('without Intercept, Charge refuses an ally', () => {
    const sim = live();
    const w = unit(sim, 'warrior', 0, 0, 0, 'arms');
    const ally = unit(sim, 'priest', 0, 18, 0, 'holy');
    unit(sim, 'mage', 1, 40, 10, 'frost');
    advance(sim, TICK);
    assert.equal(sim.useAbility(w.id, 'charge', ally.id).ok, false);
  });
});

describe('priest tier one: Psychic Scream', () => {
  const screamed = (pick: string) => {
    const sim = live();
    const p = unit(sim, 'priest', 0, 0, 0, 'holy', { 0: pick });
    const foe = unit(sim, 'warrior', 1, 4, 0, 'arms');
    advance(sim, TICK);
    ok(sim.useAbility(p.id, 'psychic_scream'));
    advance(sim, TICK);
    return { sim, p, foe };
  };
  it('Lingering Scream lasts 2 seconds longer', () => {
    const base = screamed('');
    const long = screamed('priest_t1a');
    const left = (r: { sim: ArenaSim; foe: Unit }) => r.foe.auras.find((a) => a.id === 'psychic_scream')!.expiresAt - r.sim.time;
    assert.ok(Math.abs(left(long) - left(base) - 2000) < 150, `${left(long)} vs ${left(base)}`);
  });
  it('Paralyzing Scream stuns in place with a 45 s cooldown', () => {
    const { sim, p, foe } = screamed('priest_t1b');
    assert.ok(foe.auras.some((a) => a.id === 'psychic_stun'));
    assert.ok(!foe.auras.some((a) => a.id === 'psychic_scream'));
    const x = foe.pos.x;
    advance(sim, 500);
    assert.equal(foe.pos.x, x, 'did not move');
    assert.ok(Math.abs(p.cooldowns.psychic_scream - sim.time - 45000) < 1200);
  });
  it('Fleeing Scream makes them run away from the priest', () => {
    const { sim, p, foe } = screamed('priest_t1c');
    const d0 = Math.hypot(foe.pos.x - p.pos.x, foe.pos.z - p.pos.z);
    advance(sim, 2000);
    const d1 = Math.hypot(foe.pos.x - p.pos.x, foe.pos.z - p.pos.z);
    assert.ok(d1 > d0 + 4, `${d0} -> ${d1}`);
  });
});

describe('tier two', () => {
  it('each pick does what it says', () => {
    const sim = live();
    const base = unit(sim, 'mage', 0, 0, 0, 'frost');
    const hp = unit(sim, 'mage', 0, 0, 0, 'frost', { 1: 'mage_t2b' });
    assert.equal(hp.maxHealth, Math.round(base.maxHealth * 1.1));
    const fast = unit(sim, 'mage', 0, 0, 0, 'frost', { 1: 'mage_t2a' });
    assert.ok(fast.mods.castTime < 0.92 && fast.mods.gcd < 0.92);
    const w = unit(sim, 'warrior', 0, 0, 0, 'arms', { 1: 'warrior_t2a' });
    assert.ok(Math.abs(w.mods.autoSpeed - 1 / 1.2) < 1e-9);
    const p = unit(sim, 'priest', 0, 0, 0, 'holy', { 1: 'priest_t2b' });
    assert.equal(p.mods.healingDone, 1.1);
  });
});

describe('tier three', () => {
  const hits = (sim: ArenaSim, n: number, cast: () => void, check: () => boolean) => {
    let c = 0;
    for (let i = 0; i < n; i++) {
      cast();
      if (check()) c++;
      advance(sim, 100);
    }
    return c;
  };
  it('Frostbolt, Fireball and Arcane Blast procs happen', () => {
    // Searing Touch: some Fireballs light the target
    const sim = live(5);
    const m = unit(sim, 'mage', 0, 0, 0, 'fire', { 2: 'mage_fire_t3c' });
    const foe = unit(sim, 'warrior', 1, 10, 0, 'arms');
    advance(sim, TICK);
    m.facing = Math.PI / 2;
    let burned = 0;
    for (let i = 0; i < 80; i++) {
      m.cooldowns.fireball = 0;
      m.gcdEnd = 0;
      m.resource = 500;
      foe.health = foe.maxHealth;
      sim.useAbility(m.id, 'fireball', foe.id);
      advance(sim, TICK);
      if (foe.auras.some((a) => a.id === 'burn')) { burned++; foe.auras = []; }
    }
    assert.ok(burned > 2 && burned < 25, `burned ${burned} of 80`);

    // Surge of Power: free Arcane Power for 8 s
    const sim2 = live(7);
    const a = unit(sim2, 'mage', 0, 0, 0, 'arcane', { 2: 'mage_arcane_t3b' });
    const f2 = unit(sim2, 'warrior', 1, 10, 0, 'arms');
    advance(sim2, TICK);
    a.facing = Math.PI / 2;
    let powered = 0;
    for (let i = 0; i < 80; i++) {
      a.gcdEnd = 0;
      a.resource = 500;
      f2.health = f2.maxHealth;
      sim2.useAbility(a.id, 'arcane_blast', f2.id);
      advance(sim2, 2000);
      const p = a.auras.find((x) => x.id === 'arcane_power');
      if (p) { powered++; assert.ok(p.expiresAt - sim2.time <= 8000, 'for 8 seconds'); a.auras = a.auras.filter((x) => x.id !== 'arcane_power'); }
    }
    assert.ok(powered > 2 && powered < 25, `powered ${powered} of 80`);
    assert.ok(hits);
  });

  it('Cleave and Bloodthirst can Hamstring and earn more rage', () => {
    const sim = live(3);
    const w = unit(sim, 'warrior', 0, 0, 0, 'fury', { 2: 'warrior_fury_t3b' });
    const foe = unit(sim, 'warrior', 1, 2, 0, 'arms');
    advance(sim, TICK);
    w.facing = Math.PI / 2;
    let slowed = 0;
    for (let i = 0; i < 60; i++) {
      w.cooldowns.bloodthirst = 0;
      w.gcdEnd = 0;
      w.resource = 100;
      foe.health = foe.maxHealth;
      sim.useAbility(w.id, 'bloodthirst', foe.id);
      advance(sim, TICK);
      if (foe.auras.some((a) => a.id === 'hamstring_slow')) { slowed++; foe.auras = []; }
    }
    assert.ok(slowed > 8 && slowed < 30, `hamstrung ${slowed} of 60 (30%)`);

    const sim2 = live();
    const w2 = unit(sim2, 'warrior', 0, 0, 0, 'fury', { 2: 'warrior_fury_t3c' });
    const w3 = unit(sim2, 'warrior', 0, 0, 0, 'fury');
    const t = unit(sim2, 'warrior', 1, 2, 0, 'arms');
    advance(sim2, TICK);
    for (const x of [w2, w3]) { x.resource = 50; x.facing = Math.PI / 2; x.lastCombatAt = sim2.time; }
    sim2.useAbility(w2.id, 'bloodthirst', t.id);
    sim2.useAbility(w3.id, 'bloodthirst', t.id);
    const gained = (x: Unit) => x.resource - (50 - ABILITIES.bloodthirst.cost);
    assert.ok(gained(w2) > gained(w3) + 3, `${gained(w2)} vs ${gained(w3)}`);
  });

  it('Penance: a barrier, and Rapid Penance ticks ten times in 2.5 seconds', () => {
    const sim = live();
    const p = unit(sim, 'priest', 0, 0, 0, 'discipline', { 2: 'priest_discipline_t3b' });
    const ally = unit(sim, 'warrior', 0, 3, 0, 'arms');
    unit(sim, 'mage', 1, 40, 0, 'frost');
    advance(sim, TICK);
    ally.health = 500;
    ok(sim.useAbility(p.id, 'penance', ally.id));
    advance(sim, 1800);
    const b = ally.auras.find((a) => a.id === 'penance_barrier');
    assert.ok(b && b.absorbLeft > 0, 'barrier from the healing');

    const sim2 = live();
    const p2 = unit(sim2, 'priest', 0, 0, 0, 'discipline', { 2: 'priest_discipline_t3c' });
    const a2 = unit(sim2, 'warrior', 0, 3, 0, 'arms');
    unit(sim2, 'mage', 1, 40, 0, 'frost');
    advance(sim2, TICK);
    a2.health = 500;
    ok(sim2.useAbility(p2.id, 'penance', a2.id));
    assert.equal(p2.cast!.ticks, 10);
    assert.ok(Math.abs(p2.cast!.end - p2.cast!.start - 2500) < 60);
    const events = advance(sim2, 2700).filter((e) => e.t === 'heal' && e.src === p2.id);
    assert.equal(events.length, 10);
  });

  it('Greater Heal mirrors to the other side and leaves Renew; Mind Blast can leave Plague Ready', () => {
    const sim = live();
    const p = unit(sim, 'priest', 0, 0, 0, 'holy', { 2: 'priest_holy_t3b' });
    const ally = unit(sim, 'warrior', 0, 5, 0, 'arms');
    unit(sim, 'mage', 1, 40, 0, 'frost');
    advance(sim, TICK);
    p.health = 1000;
    ally.health = 1000;
    ok(sim.useAbility(p.id, 'greater_heal', ally.id));
    advance(sim, 3000);
    assert.ok(p.health > 1000, 'you were healed too');
    const before = ally.health;
    ok(sim.useAbility(p.id, 'greater_heal', p.id));
    advance(sim, 3000);
    assert.ok(ally.health > before, 'and the ally when you heal yourself');

    const sim2 = live();
    const h = unit(sim2, 'priest', 0, 0, 0, 'holy', { 2: 'priest_holy_t3c' });
    const a2 = unit(sim2, 'warrior', 0, 5, 0, 'arms');
    unit(sim2, 'mage', 1, 40, 0, 'frost');
    advance(sim2, TICK);
    a2.health = 1000;
    ok(sim2.useAbility(h.id, 'greater_heal', a2.id));
    advance(sim2, 3000);
    assert.ok(a2.auras.some((a) => a.id === 'renew'));

    const sim3 = live(9);
    const g = unit(sim3, 'priest', 0, 0, 0, 'shadow', { 2: 'priest_shadow_t3b' });
    const foe = unit(sim3, 'warrior', 1, 8, 0, 'arms');
    advance(sim3, TICK);
    g.facing = Math.PI / 2;
    let ready = 0;
    for (let i = 0; i < 100 && !ready; i++) {
      g.cooldowns.mind_blast = 0;
      g.gcdEnd = 0;
      g.resource = 500;
      g.cooldowns.plague_bloom = sim3.time + 99999;
      foe.health = foe.maxHealth;
      sim3.useAbility(g.id, 'mind_blast', foe.id);
      advance(sim3, 1700);
      if (g.auras.some((a) => a.id === 'plague_ready')) ready++;
    }
    assert.ok(ready, 'a proc happened');
    assert.equal(g.cooldowns.plague_bloom, 0, 'Devouring Plague is off cooldown');
    ok(sim3.useAbility(g.id, 'plague_bloom', foe.id));
    assert.ok(!g.auras.some((a) => a.id === 'plague_ready'), 'the buff is used up');
    assert.ok(!((g.cooldowns.plague_bloom ?? 0) > sim3.time), 'and the cast started no cooldown');
  });
});

describe('tier five skills', () => {
  it('Dragon Roar hits a cone; Battle Banner buffs allies in the circle; Rune of Power buffs only you', () => {
    const sim = live();
    const w = unit(sim, 'warrior', 0, 0, 0, 'arms', { 4: 'warrior_t5b' });
    const front = unit(sim, 'mage', 1, 6, 0, 'frost');
    const behind = unit(sim, 'mage', 1, -6, 0, 'frost');
    advance(sim, TICK);
    w.facing = Math.PI / 2;
    w.resource = 100;
    ok(sim.useAbility(w.id, 'dragon_roar'));
    assert.ok(front.health < front.maxHealth && behind.health === behind.maxHealth);

    const sim2 = live();
    const b = unit(sim2, 'warrior', 0, 0, 0, 'arms', { 4: 'warrior_t5c' });
    const ally = unit(sim2, 'priest', 0, 3, 0, 'holy');
    const far = unit(sim2, 'priest', 0, 30, 0, 'holy');
    unit(sim2, 'mage', 1, 60, 0, 'frost');
    advance(sim2, TICK);
    b.resource = 100;
    ok(sim2.useAbility(b.id, 'battle_banner', null, { x: 3, z: 0 }));
    advance(sim2, 500);
    assert.ok(b.auras.some((a) => a.id === 'banner_buff') && ally.auras.some((a) => a.id === 'banner_buff'));
    assert.ok(!far.auras.some((a) => a.id === 'banner_buff'));
    advance(sim2, 13000);
    assert.ok(!ally.auras.some((a) => a.id === 'banner_buff'), 'gone when the banner is');

    const sim3 = live();
    const m = unit(sim3, 'mage', 0, 0, 0, 'frost', { 4: 'mage_t5c' });
    const mate = unit(sim3, 'priest', 0, 2, 0, 'holy');
    unit(sim3, 'mage', 1, 60, 0, 'frost');
    advance(sim3, TICK);
    ok(sim3.useAbility(m.id, 'rune_of_power'));
    advance(sim3, 500);
    assert.ok(m.auras.some((a) => a.id === 'rune_of_power') && !mate.auras.some((a) => a.id === 'rune_of_power'));
  });

  it('Mirror Image drops targets and wastes some hits; Evocation heals', () => {
    const sim = live(2);
    const m = unit(sim, 'mage', 0, 0, 0, 'frost', { 4: 'mage_t5a' });
    const foe = unit(sim, 'warrior', 1, 2, 0, 'arms');
    advance(sim, TICK);
    foe.target = m.id;
    foe.autoAttack = true;
    ok(sim.useAbility(m.id, 'mirror_image'));
    assert.equal(foe.target, null, 'the enemy lost its target');
    let wasted = 0;
    for (let i = 0; i < 200; i++) {
      const before = m.health;
      sim.dealDamage(foe, m, 10, 'physical', 'mortal_strike');
      if (m.health === before) wasted++;
      m.health = m.maxHealth;
    }
    assert.ok(wasted > 70 && wasted < 130, `${wasted} of 200 hit an image`);

    const sim2 = live();
    const e = unit(sim2, 'mage', 0, 0, 0, 'frost', { 4: 'mage_t5b' });
    unit(sim2, 'warrior', 1, 40, 0, 'arms');
    advance(sim2, TICK);
    e.health = 1000;
    ok(sim2.useAbility(e.id, 'evocation'));
    advance(sim2, 3000);
    assert.ok(e.health > 1000 + e.maxHealth * 0.04, `${e.health}`);
  });

  it('Leap of Faith pulls an ally; Purifying Light cleanses allies and blocks debuffs; Ascend makes you untouchable', () => {
    const sim = live();
    const p = unit(sim, 'priest', 0, 0, 0, 'holy', { 4: 'priest_holy_t5a' });
    const ally = unit(sim, 'warrior', 0, 30, 0, 'arms');
    const foe = unit(sim, 'mage', 1, 50, 0, 'frost');
    advance(sim, TICK);
    ok(sim.useAbility(p.id, 'leap_of_faith', ally.id));
    assert.ok(Math.hypot(ally.pos.x - p.pos.x, ally.pos.z - p.pos.z) < 3);

    const sim2 = live();
    const q = unit(sim2, 'priest', 0, 0, 0, 'holy', { 4: 'priest_holy_t5b' });
    const a = unit(sim2, 'warrior', 0, 4, 0, 'arms');
    const e = unit(sim2, 'mage', 1, 6, 0, 'frost');
    advance(sim2, TICK);
    sim2.applyAura(e, a, 'frostbolt_slow');
    sim2.applyAura(e, a, 'plague_bloom');
    sim2.applyAura(e, e, 'frostbolt_slow');
    ok(sim2.useAbility(q.id, 'purifying_light'));
    assert.ok(!a.auras.some((x) => AURAS[x.id].harmful && AURAS[x.id].dispellable), 'cleansed');
    assert.ok(e.auras.some((x) => x.id === 'frostbolt_slow'), 'enemies keep theirs');
    assert.equal(sim2.applyAura(e, a, 'plague_bloom').applied, false, 'new harmful effects are kept off');
    advance(sim2, 4200);
    assert.equal(sim2.applyAura(e, a, 'plague_bloom').applied, true, 'until it wears off');

    const sim3 = live();
    const s = unit(sim3, 'priest', 0, 0, 0, 'shadow', { 4: 'priest_shadow_t5c' });
    const f = unit(sim3, 'warrior', 1, 3, 0, 'arms');
    advance(sim3, TICK);
    f.target = s.id;
    ok(sim3.useAbility(s.id, 'ascend'));
    assert.equal(f.target, null);
    const hp = s.health;
    sim3.dealDamage(f, s, 500, 'physical', 'mortal_strike');
    assert.equal(s.health, hp, 'untouched');
    assert.equal(sim3.canSee(f, s), false, 'and cannot be seen');
    assert.equal(sim3.useAbility(s.id, 'smite', f.id).ok, false, 'but cannot act either');
    assert.ok(foe);
  });

  it('Gouge incapacitates; Blind strips damage over time and fears; Sap only works from stealth', () => {
    const sim = live();
    const r = unit(sim, 'rogue', 0, 0, 0, 'combat');
    const foe = unit(sim, 'warrior', 1, 2, 0, 'arms');
    advance(sim, TICK);
    r.facing = Math.PI / 2;
    r.resource = 100;
    ok(sim.useAbility(r.id, 'gouge', foe.id));
    assert.ok(foe.auras.some((a) => a.id === 'gouge'));
    sim.dealDamage(r, foe, 10, 'physical', 'sinister_strike');
    assert.ok(!foe.auras.some((a) => a.id === 'gouge'), 'damage breaks it');

    const sim2 = live();
    const b = unit(sim2, 'rogue', 0, 0, 0, 'assassination', { 4: 'rogue_t5a' });
    const victim = unit(sim2, 'priest', 1, 3, 0, 'shadow');
    const caster = unit(sim2, 'mage', 0, 0, 5, 'frost');
    advance(sim2, TICK);
    sim2.applyAura(caster, victim, 'plague_bloom');
    sim2.applyAura(caster, victim, 'psychic_scream');
    b.facing = Math.PI / 2;
    b.resource = 100;
    ok(sim2.useAbility(b.id, 'blind', victim.id));
    assert.ok(!victim.auras.some((a) => a.kind === 'dot' || a.kind === 'fear'), 'dots and fears are gone');
    assert.ok(victim.auras.some((a) => a.id === 'blind'));

    const sim3 = live();
    const sapper = unit(sim3, 'rogue', 0, 0, 0, 'assassination', { 4: 'rogue_t5c' });
    const t = unit(sim3, 'mage', 1, 2, 0, 'frost');
    advance(sim3, TICK);
    sapper.facing = Math.PI / 2;
    sapper.resource = 100;
    assert.equal(sim3.useAbility(sapper.id, 'sap', t.id).ok, false, 'not in the open');
    sim3.applyAura(sapper, sapper, 'stealth');
    ok(sim3.useAbility(sapper.id, 'sap', t.id));
    assert.ok(t.auras.some((a) => a.id === 'sap'));
  });
});
