import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABILITIES, ArenaSim, AURAS, CLASSES, CLASS_IDS, GEAR, ITEMS, SPECS, TALENTS, TUNING,
  barFor, bestGear, compileMods, describeAbility, describeAura, describeMods, gearMods, gearStats, itemById, parseClientMsg,
  statBonuses, validateBuild, withAuraMods,
} from '../src/index';
import type { Build, ClassId, SimEvent, TeamId, Unit } from '../src/index';

const TICK = TUNING.tickMs;
function add(sim: ArenaSim, classId: ClassId, team: TeamId, x: number, z: number, build?: Build): Unit {
  const u = sim.addUnit({ name: `${classId}${team}`, classId, team, build });
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
const live = (seed = 1) => new ArenaSim({ seed, prepMs: 0 });
const build = (spec: string, talents: string[] = [], gear: Record<string, string> = {}): Build => ({ spec, talents, gear });

describe('content data is consistent', () => {
  it('every spec bar uses real abilities of its own class, with no duplicates and at most 6 slots', () => {
    for (const cls of CLASS_IDS) {
      assert.equal(SPECS[cls].length, 3, `${cls} has 3 specs`);
      for (const spec of SPECS[cls]) {
        assert.ok(spec.bar.length <= 6 && spec.bar.length >= 4, `${spec.id} bar size`);
        assert.equal(new Set(spec.bar).size, spec.bar.length, `${spec.id} duplicates`);
        for (const a of spec.bar) {
          assert.ok(ABILITIES[a], `${spec.id}: ${a} exists`);
          assert.equal(ABILITIES[a].class, cls, `${spec.id}: ${a} belongs to ${cls}`);
        }
      }
    }
  });

  it('every ability is on at least one spec bar, and every talent mod points at something real', () => {
    const used = new Set(CLASS_IDS.flatMap((c) => SPECS[c].flatMap((s) => s.bar)));
    for (const id of Object.keys(ABILITIES)) assert.ok(used.has(id) || CLASSES[ABILITIES[id].class].bar.includes(id), `${id} unreachable`);
    const check = (m: any, where: string) => {
      for (const id of Object.keys(m?.ability ?? {})) assert.ok(ABILITIES[id], `${where}: ability ${id}`);
      for (const id of Object.keys(m?.auraDuration ?? {})) assert.ok(AURAS[id], `${where}: aura ${id}`);
    };
    for (const cls of CLASS_IDS) {
      assert.equal(TALENTS[cls].length, 3, `${cls} has 3 talent tiers`);
      const ids = new Set<string>();
      TALENTS[cls].forEach((tier, i) => {
        assert.equal(tier.length, 3, `${cls} tier ${i} has 3 choices`);
        for (const t of tier) {
          assert.ok(!ids.has(t.id), `duplicate talent ${t.id}`);
          ids.add(t.id);
          check(t.mods, t.id);
        }
      });
      for (const s of SPECS[cls]) check(s.mods, s.id);
    }
    for (const [id, a] of Object.entries(AURAS)) if (a.kind === 'buff') assert.ok(a.mods, `${id} buff has mods`);
  });

  it('descriptions never contain NaN or undefined', () => {
    for (const def of Object.values(ABILITIES)) {
      const d = describeAbility(def);
      const text = [d.name, ...d.stats, ...d.lines, ...d.notes].join(' | ');
      assert.doesNotMatch(text, /NaN|undefined|null/, def.id);
      assert.ok(d.lines.length > 0, `${def.id} has a description line`);
    }
    for (const id of Object.keys(AURAS)) assert.doesNotMatch(describeAura(id), /NaN|undefined/, id);
    assert.deepEqual(describeMods({ damageDone: 1.06, damageTaken: 0.94 }), ['+6% damage dealt', '−6% damage taken']);
  });
});

describe('gear', () => {
  it('generates the full catalog and gates tiers by matches played', () => {
    assert.equal(ITEMS.length, GEAR.tiers.length * GEAR.slots.length * GEAR.flavors.length);
    assert.equal(validateBuild('mage', build('frost', [], { head: 't1.head.fury' }), 0).ok, true);
    const locked = validateBuild('mage', build('frost', [], { head: 't4.head.fury' }), 0);
    assert.equal(locked.ok, false);
    assert.equal(validateBuild('mage', build('frost', [], { head: 't4.head.fury' }), GEAR.tiers[3].unlockMatches).ok, true);
  });

  it('rejects wrong-slot, unknown and malformed picks', () => {
    assert.equal(validateBuild('mage', build('frost', [], { head: 't1.legs.fury' }), 99).ok, false);
    assert.equal(validateBuild('mage', build('frost', [], { head: 'nope' }), 99).ok, false);
    assert.equal(validateBuild('mage', build('frost', [], { hat: 't1.head.fury' }), 99).ok, false);
    assert.equal(validateBuild('mage', build('fire' + 'x'), 99).ok, false);
    assert.equal(validateBuild('mage', build('frost', ['bogus']), 99).ok, false);
    assert.equal(validateBuild('mage', build('frost', ['spell_power', 'improved_blink', 'blazing_speed', 'extra']), 99).ok, false);
    assert.equal(validateBuild('mage', build('frost', ['spell_power', '', 'blazing_speed']), 99).ok, true);
  });

  it('stat bonuses are capped, and best gear never beats the cap or the catch-up gap budget', () => {
    const cap = (TUNING.gearCap - 1) * 100;
    for (const flavor of GEAR.flavors) {
      const full = bestGear(flavor.id, 999);
      const b = statBonuses(gearStats(full));
      for (const v of Object.values(b)) assert.ok(v <= cap + 1e-9);
    }
    const huge = statBonuses({ power: 9999, vitality: 9999, haste: 9999, resilience: 9999 });
    for (const v of Object.values(huge)) assert.equal(v, cap);
    // a fresh player in the starter tier is within ~6% power of a fully geared one
    const fresh = statBonuses(gearStats(bestGear('fury', 0))).power;
    const maxed = statBonuses(gearStats(bestGear('fury', 999))).power;
    assert.ok(maxed - fresh < 6, `gap ${maxed - fresh}`);
    assert.ok(maxed > fresh);
  });

  it('gear stats become combat numbers: vitality health, haste cast time, power damage', () => {
    const gear = bestGear('fury', 999);
    const sim = live();
    const plain = add(sim, 'mage', 0, 0, 0);
    const geared = add(sim, 'mage', 1, 5, 0, build('frost', [], gear));
    assert.ok(geared.maxHealth > plain.maxHealth);
    const mods = compileMods('mage', build('frost', [], gear));
    assert.ok(mods.castTime < 1 && mods.damageDone > 1);
    assert.deepEqual(gearMods({}).damageDone, 1);
    assert.ok(itemById('t1.head.fury'));
  });
});

describe('specs and talents in the sim', () => {
  it('the spec decides your ability bar', () => {
    const sim = live();
    const fire = add(sim, 'mage', 0, 0, 0, build('fire'));
    const foe = add(sim, 'warrior', 1, 10, 0);
    advance(sim, TICK);
    const r = sim.useAbility(fire.id, 'frostbolt', foe.id);
    assert.equal(r.ok, false);
    assert.match((r as any).reason, /unknown ability/);
    assert.ok(sim.useAbility(fire.id, 'pyroblast', foe.id).ok);
    assert.deepEqual(barFor('mage', build('fire'), []), SPECS.mage[1].bar);
  });

  it('every ability on every spec bar can be used without errors', () => {
    for (const cls of CLASS_IDS) {
      for (const spec of SPECS[cls]) {
        for (const ability of spec.bar) {
          const sim = live(3);
          const me = add(sim, cls, 0, 0, 0, build(spec.id));
          const foe = add(sim, 'warrior', 1, ABILITIES[ability].range > 0 ? Math.min(4, ABILITIES[ability].range) : 3, 0);
          const ally = add(sim, 'priest', 0, 1, 1);
          void ally;
          me.resource = me.resourceMax;
          advance(sim, TICK * 2);
          if (ABILITIES[ability].requiresStealth) sim.applyAura(me, me, 'stealth');
          if (ABILITIES[ability].effects.some((e) => e.type === 'dispel')) sim.applyAura(foe, foe, 'pw_shield');
          if (ABILITIES[ability].requiresTargetCasting) foe.cast = { ability: 'frostbolt', target: me.id, start: 0, end: 99999 };
          if (ABILITIES[ability].minRange) foe.pos = { x: ABILITIES[ability].minRange! + 2, z: 0 };
          const r = sim.useAbility(me.id, ability, ABILITIES[ability].target === 'ally_or_self' ? me.id : foe.id);
          assert.ok(r.ok, `${spec.id}/${ability}: ${(r as any).reason}`);
          assert.doesNotThrow(() => advance(sim, 4000));
        }
      }
    }
  });

  it('damage mods scale damage and healing mods scale heals (same seed, same sequence)', () => {
    const run = (b?: Build) => {
      const sim = live(7);
      const rogue = add(sim, 'rogue', 0, 0, 0, b);
      const foe = add(sim, 'warrior', 1, 2, 0);
      advance(sim, TICK);
      sim.useAbility(rogue.id, 'sinister_strike', foe.id);
      return advance(sim, 100).find((e) => e.t === 'damage') as Extract<SimEvent, { t: 'damage' }>;
    };
    const base = run();
    const boosted = run(build('combat', ['deadly_poisons']));
    assert.ok(base && boosted);
    assert.ok(Math.abs(boosted.amount / base.amount - 1.06) < 0.02, `${boosted.amount}/${base.amount}`);
  });

  it('damage taken mods reduce incoming damage', () => {
    const hit = (b?: Build) => {
      const sim = live(5);
      const rogue = add(sim, 'rogue', 0, 0, 0);
      const war = add(sim, 'warrior', 1, 2, 0, b);
      advance(sim, TICK);
      sim.useAbility(rogue.id, 'sinister_strike', war.id);
      return (advance(sim, 100).find((e) => e.t === 'damage') as any).amount as number;
    };
    const base = hit();
    const tank = hit(build('protection', ['iron_will']));
    assert.ok(Math.abs(tank / base - 0.92 * 0.94) < 0.03, `${tank}/${base}`);
  });

  it('talents change cooldowns, cast times and movement speed', () => {
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0, build('frost', ['mana_flow', 'improved_blink', 'blazing_speed']));
    add(sim, 'warrior', 1, 20, 0);
    advance(sim, TICK);
    sim.useAbility(mage.id, 'blink');
    assert.equal(mage.cooldowns.blink - sim.time, Math.round(ABILITIES.blink.cooldown * 0.7));
    assert.ok(Math.abs(sim.speedMult(mage) - 1.08) < 1e-9);

    const sim2 = live();
    const priest = add(sim2, 'priest', 0, 0, 0, build('holy', ['inner_peace', 'improved_shield', 'swift_prayer']));
    const foe = add(sim2, 'warrior', 1, 8, 0);
    advance(sim2, TICK);
    sim2.useAbility(priest.id, 'greater_heal', priest.id);
    assert.ok(priest.cast);
    assert.equal(priest.cast!.end - priest.cast!.start, Math.round(ABILITIES.greater_heal.castTime * 0.93));
    void foe;
  });

  it('buff cooldowns apply while active and wear off', () => {
    const sim = live();
    const war = add(sim, 'warrior', 0, 0, 0, build('arms'));
    add(sim, 'mage', 1, 25, 0);
    advance(sim, TICK);
    assert.equal(sim.modsOf(war).damageDone, war.mods.damageDone);
    war.resource = 100;
    assert.ok(sim.useAbility(war.id, 'recklessness').ok);
    assert.ok(Math.abs(sim.modsOf(war).damageDone - war.mods.damageDone * 1.3) < 1e-9);
    assert.ok(Math.abs(sim.modsOf(war).damageTaken - 1.15) < 1e-9);
    advance(sim, AURAS.recklessness.duration + TICK * 2);
    assert.equal(sim.modsOf(war).damageDone, war.mods.damageDone);
    // base mods must never be mutated by buffs
    assert.ok(Object.keys(war.mods.ability).length === 0);
    assert.deepEqual(withAuraMods(war.mods, ['shield_wall', 'dispersion']).damageTaken, 0.6 * 0.4);
    assert.equal(war.mods.damageTaken, 1);
  });

  it('defensive cooldown cuts damage and rogue vanish works in combat', () => {
    const sim = live(9);
    const war = add(sim, 'warrior', 0, 0, 0, build('protection'));
    const rogue = add(sim, 'rogue', 1, 2, 0, build('assassination'));
    advance(sim, TICK);
    rogue.lastCombatAt = sim.time;
    assert.ok(sim.useAbility(rogue.id, 'vanish').ok);
    assert.ok(sim.isStealthed(rogue));
    assert.ok(sim.useAbility(war.id, 'shield_wall').ok);
    assert.ok(war.auras.some((a) => a.id === 'shield_wall'));
  });

  it('bots and dummies keep the classic bar and neutral mods', () => {
    const sim = live();
    const bot = sim.addUnit({ name: 'b', classId: 'mage', team: 0, controller: 'bot' });
    assert.deepEqual(bot.bar, CLASSES.mage.bar);
    assert.equal(bot.mods.damageDone, 1);
    assert.equal(bot.spec, null);
  });
});

describe('protocol carries a build', () => {
  it('accepts a well-formed build and strips junk', () => {
    const m: any = parseClientMsg(JSON.stringify({ t: 'join', name: 'A', classId: 'mage', mode: 'practice', build: { spec: 'fire', talents: ['spell_power', 5, 'x'.repeat(100)], gear: { head: 't1.head.fury', bad: 7 } }, profile: 'abc' }));
    assert.ok(m);
    assert.equal(m.build.spec, 'fire');
    assert.deepEqual(m.build.talents, ['spell_power', '', '']);
    assert.deepEqual(m.build.gear, { head: 't1.head.fury' });
    assert.equal(m.profile, 'abc');
    const none: any = parseClientMsg(JSON.stringify({ t: 'join', name: 'A', classId: 'mage', mode: 'practice' }));
    assert.equal(none.build, undefined);
  });
  it('rejects oversized or non-object builds', () => {
    const m: any = parseClientMsg(JSON.stringify({ t: 'join', name: 'A', classId: 'mage', mode: 'queue', build: 'nope', profile: 5 }));
    assert.equal(m.build, undefined);
    assert.equal(m.profile, undefined);
    const big: any = parseClientMsg(JSON.stringify({ t: 'join', name: 'A', classId: 'mage', mode: 'queue', build: { spec: 'frost', talents: new Array(50).fill('a'), gear: {} } }));
    assert.ok(big.build.talents.length <= 3);
  });
});
