import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABILITIES, ArenaSim, AURAS, CLASSES, CLASS_IDS, COSMETICS, ITEMS, SPECS, TUNING,
  barFor, canWear, cleanGear, compileMods, describeAbility, explainAbility, newMods, describeAura, describeMods, itemById, itemsForSlot, parseClientMsg,
  talentsFor, validateBuild, withAuraMods, TRINKET_TIER,
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
const specTalents = (cls: ClassId, spec: string) => talentsFor(cls, spec);
/** The swap talent that gives `to` to this spec. */
const swapTo = (cls: ClassId, spec: string, to: string) => specTalents(cls, spec).flat().find((t) => t.swap?.to === to)!;
const tierOf = (cls: ClassId, spec: string, t: { id: string }) => specTalents(cls, spec).findIndex((tier) => tier.some((x) => x.id === t.id));
/** A talents array with just this talent picked in its own tier. */
const picks = (cls: ClassId, spec: string, ...ts: { id: string }[]) => specTalents(cls, spec).map((tier) => ts.find((t) => tier.some((x) => x.id === t.id))?.id ?? '');
const build = (spec: string, talents: string[] = [], gear: Record<string, string> = {}): Build => ({ spec, talents, gear });

describe('content data is consistent', () => {
  it('every spec bar uses real abilities of its own class, with no duplicates and at most 8 slots', () => {
    for (const cls of CLASS_IDS) {
      assert.equal(SPECS[cls].length, 3, `${cls} has 3 specs`);
      for (const spec of SPECS[cls]) {
        assert.ok(spec.bar.length <= 8 && spec.bar.length >= 4, `${spec.id} bar size`);
        assert.equal(new Set(spec.bar).size, spec.bar.length, `${spec.id} duplicates`);
        for (const a of spec.bar) {
          assert.ok(ABILITIES[a], `${spec.id}: ${a} exists`);
          assert.equal(ABILITIES[a].class, cls, `${spec.id}: ${a} belongs to ${cls}`);
        }
      }
    }
  });

  it('every ability is on at least one spec bar, and every talent mod points at something real', () => {
    const used = new Set([...CLASS_IDS.flatMap((c) => SPECS[c].flatMap((s) => [...s.bar, ...specTalents(c, s.id).flat().map((t) => t.swap?.to ?? '')])), ...Object.values(ABILITIES).map((a) => a.stealthSwap ?? '')]);
    const trinkets = new Set(CLASS_IDS.flatMap((c) => SPECS[c].flatMap((s) => specTalents(c, s.id)[TRINKET_TIER]?.map((t) => t.trinket ?? '') ?? [])));
    for (const id of Object.keys(ABILITIES)) {
      const a = ABILITIES[id];
      if (a.retired) continue;
      assert.ok(used.has(id) || trinkets.has(id) || (a.class !== 'trinket' && CLASSES[a.class].bar.includes(id)), `${id} unreachable`);
    }
    const check = (m: any, where: string) => {
      for (const id of Object.keys(m?.ability ?? {})) assert.ok(ABILITIES[id], `${where}: ability ${id}`);
      for (const id of Object.keys(m?.auraDuration ?? {})) assert.ok(AURAS[id], `${where}: aura ${id}`);
    };
    for (const cls of CLASS_IDS) {
      for (const sp of SPECS[cls]) for (const t of specTalents(cls, sp.id).flat()) check(t.mods, t.id);
      for (const s of SPECS[cls]) check(s.mods, s.id);
    }
    for (const [id, a] of Object.entries(AURAS)) if (a.kind === 'buff') assert.ok(a.mods || a.instantFor || a.empower || a.maxStacks || a.hot || a.untargetable || a.noCast || a.invulnerable || a.blocksDebuffs || a.resetsCooldown || a.freeCooldownFor || a.flee, `${id} buff has mods`);
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

describe('cosmetics', () => {
  it('has a good number of items in every slot, each with a unique id and a valid colour', () => {
    assert.ok(ITEMS.length >= 110, 'cosmetics were doubled');
    assert.equal(new Set(ITEMS.map((i) => i.id)).size, ITEMS.length);
    for (const slot of COSMETICS.slots) assert.ok(itemsForSlot(slot.id).filter((i) => !i.owner).length >= 7, slot.id);
    for (const i of ITEMS) assert.match(i.color, /^#[0-9a-f]{6}$/i, i.id);
  });

  it('non-owner cosmetics validate, bad picks are rejected', () => {
    for (const i of ITEMS.filter((x) => !x.owner)) assert.equal(validateBuild('mage', build('frost', [], { [i.slot]: i.id })).ok, true, i.id);
    assert.equal(validateBuild('mage', build('frost', [], { head: 'cloak_azure' })).ok, false, 'wrong slot');
    assert.equal(validateBuild('mage', build('frost', [], { head: 'nope' })).ok, false);
    assert.equal(validateBuild('mage', build('frost', [], { hat: 'crown_gold' })).ok, false);
    assert.equal(validateBuild('mage', build('fire' + 'x')).ok, false);
    assert.equal(validateBuild('mage', build('frost', ['bogus'])).ok, false);
    assert.equal(validateBuild('mage', build('frost', ['', '', '', '', '', '', 'extra'])).ok, false);
    assert.equal(validateBuild('mage', build('frost', ['', '', specTalents('mage', 'fire')[2][0].id])).ok, false, 'a talent of another spec is invalid');
    assert.equal(validateBuild('mage', build('frost', [specTalents('mage', 'frost')[0][0].id, '', specTalents('mage', 'frost')[2][1].id])).ok, true);
  });

  it('owner-only cosmetics: a good number, rejected and stripped for everyone but the owner', () => {
    const own = ITEMS.filter((i) => i.owner);
    assert.ok(own.length >= 22);
    for (const i of own) {
      const gear = { [i.slot]: i.id };
      assert.equal(validateBuild('mage', build('frost', [], gear)).ok, false, i.id);
      assert.equal(validateBuild('mage', build('frost', [], gear), true).ok, true, i.id);
      assert.deepEqual(cleanGear(gear), {});
      assert.deepEqual(cleanGear(gear, true), gear);
    }
    // normal items keep the same look index no matter what owner items exist after them
    for (const slot of COSMETICS.slots) {
      const list = itemsForSlot(slot.id);
      const firstOwner = list.findIndex((i) => i.owner);
      if (firstOwner >= 0) assert.ok(list.slice(firstOwner).every((i) => i.owner), `${slot.id}: owner items come last`);
    }
  });

  it('flashy cosmetics unlock with matches played, and the owner skips the wait', () => {
    const locked = ITEMS.filter((i) => i.unlock);
    assert.ok(locked.length >= 30);
    for (const slot of COSMETICS.slots) {
      assert.ok(itemsForSlot(slot.id).filter((i) => i.unlock).length >= (slot.id === 'back' ? 2 : 4), `${slot.id} has unlockables`);
      assert.ok(itemsForSlot(slot.id).filter((i) => !i.owner && !i.unlock).length >= (slot.id === 'wings' ? 4 : slot.id === 'back' ? 6 : 9), `${slot.id} keeps free looks`);
    }
    for (const i of locked) {
      const gear = { [i.slot]: i.id };
      assert.equal(canWear(i, false, i.unlock! - 1), false, i.id);
      assert.equal(canWear(i, false, i.unlock!), true, i.id);
      assert.equal(validateBuild('mage', build('frost', [], gear), false, 0).ok, false, i.id);
      assert.equal(validateBuild('mage', build('frost', [], gear), false, i.unlock!).ok, true, i.id);
      assert.deepEqual(cleanGear(gear, false, 0), {});
      assert.deepEqual(cleanGear(gear, true, 0), gear);
    }
    const free = ITEMS.find((i) => !i.owner && !i.unlock)!;
    assert.deepEqual(cleanGear({ [free.slot]: free.id }, false, 0), { [free.slot]: free.id });
  });

  it('wings are their own slot: no shoulders, no wings on the back or head, a full tiered catalog', () => {
    assert.deepEqual(COSMETICS.slots.map((s) => s.id), ['head', 'wings', 'back', 'weapon', 'aura', 'tint', 'orbit']);
    assert.equal(ITEMS.filter((i) => i.slot === 'shoulders').length, 0);
    const wings = itemsForSlot('wings');
    assert.ok(wings.length >= 12, 'wings');
    assert.ok(wings.every((i) => i.desc && i.desc.length > 10), 'every wing item has a tooltip line');
    assert.ok(wings.filter((i) => !i.owner && !i.unlock).length >= 4 && wings.filter((i) => i.unlock).length >= 5 && wings.filter((i) => i.owner).length >= 3, 'free, unlockable and owner tiers');
    for (const i of ITEMS.filter((x) => x.slot === 'back' || x.slot === 'head')) assert.ok(!/wing|angel|phoenix|archon|bat|rift/.test(i.style), `${i.id} is not a wing`);
  });

  it('old saves keep working: wings from the back slot move to wings, shoulders and unknown slots are dropped', async () => {
    assert.deepEqual(cleanGear({ back: 'wings_angel', head: 'crown_gold' }), { wings: 'wings_angel', head: 'crown_gold' });
    assert.deepEqual(cleanGear({ head: 'wings_bat', shoulders: 'plates_gold', back: 'cloak_azure' }), { wings: 'wings_bat', back: 'cloak_azure' });
    assert.deepEqual(cleanGear({ shoulders: 'dragon_pauldrons', wings: 'wings_silver' }, true), {}, 'retired shoulder and circlet ids vanish');
    assert.deepEqual(cleanGear({ wings: 'wings_frost', back: 'wings_angel' }, true), { wings: 'wings_frost' }, 'an explicit wings pick wins over a migrated one');
    assert.deepEqual(cleanGear({ back: 'archon_wings' }), {}, 'locked for a non-owner, even after moving');
    assert.equal(validateBuild('mage', build('frost', [], { shoulders: 'plates_gold' })).ok, false, 'the strict check refuses a retired slot');
    // an old recording's gear still shows its wings
    const { gearLook } = await import('../src/index');
    assert.equal(gearLook({ back: 'wings_angel', shoulders: 'plates_gold' }), gearLook({ wings: 'wings_angel' }));
  });

  it('cleanGear drops anything that no longer exists', () => {
    assert.deepEqual(cleanGear({ head: 'crown_gold', back: 't1.head.fury', zzz: 'x' }), { head: 'crown_gold' });
    assert.deepEqual(cleanGear(undefined), {});
  });

  it('cosmetics change the look and never the combat numbers', () => {
    const gear = Object.fromEntries(COSMETICS.slots.map((s) => [s.id, itemsForSlot(s.id)[0].id]));
    const sim = live();
    const plain = add(sim, 'mage', 0, 0, 0, build('frost'));
    const dressed = add(sim, 'mage', 1, 5, 0, build('frost', [], gear));
    assert.equal(dressed.maxHealth, plain.maxHealth);
    assert.deepEqual(compileMods('mage', build('frost', [], gear)), compileMods('mage', build('frost')));
    assert.notEqual(dressed.look, plain.look, 'but it does show');
    assert.ok(itemById('crown_gold'));
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
          if (ABILITIES[ability].cpSpend) me.cp = 3;
          if (ABILITIES[ability].effects.some((e) => e.type === 'dispel')) sim.applyAura(foe, foe, 'pw_shield');
          if (ABILITIES[ability].requiresTargetCasting) foe.cast = { ability: 'frostbolt', target: me.id, start: 0, end: 99999 };
          if (ABILITIES[ability].maxTargetHealthPct) foe.health = Math.floor(foe.maxHealth * 0.1);
          if (ABILITIES[ability].minRange) foe.pos = { x: ABILITIES[ability].minRange! + 2, z: 0 };
          for (const x of ABILITIES[ability].requiresTargetAura ?? []) sim.applyAura(me, foe, x);
          const r = sim.useAbility(me.id, ability, ABILITIES[ability].target === 'ally_or_self' ? me.id : foe.id);
          assert.ok(r.ok, `${spec.id}/${ability}: ${(r as any).reason}`);
          assert.doesNotThrow(() => advance(sim, 4000));
        }
      }
    }
  });

  it('damage mods scale damage (same seed, same sequence)', () => {
    const run = (b?: Build) => {
      const sim = live(7);
      const w = add(sim, 'warrior', 0, 0, 0, b ?? build('arms'));
      const foe = add(sim, 'priest', 1, 2, 0);
      w.resource = 100;
      advance(sim, TICK);
      sim.useAbility(w.id, 'mortal_strike', foe.id);
      return advance(sim, 100).find((e) => e.t === 'damage') as Extract<SimEvent, { t: 'damage' }>;
    };
    const base = run();
    const dmgTalent = specTalents('warrior', 'arms').slice(0, 3).flat().find((t) => t.mods.damageDone)!;
    const boosted = run(build('arms', picks('warrior', 'arms', dmgTalent)));
    const want = (dmgTalent.mods.damageDone ?? 1);
    assert.ok(base && boosted);
    assert.ok(Math.abs(boosted.amount / base.amount - want) < 0.03, `${boosted.amount}/${base.amount} vs ${want}`);
  });

  it('damage taken mods reduce incoming damage', () => {
    const hit = (spec: string) => {
      const sim = live(5);
      const rogue = add(sim, 'rogue', 0, 0, 0);
      const war = add(sim, 'warrior', 1, 2, 0, build(spec));
      advance(sim, TICK);
      sim.useAbility(rogue.id, 'sinister_strike', war.id);
      return (advance(sim, 100).find((e) => e.t === 'damage') as any).amount as number;
    };
    const base = hit('fury');
    const tank = hit('protection');
    const want = compileMods('warrior', build('protection')).damageTaken / compileMods('warrior', build('fury')).damageTaken;
    assert.ok(Math.abs(tank / base - want) < 0.03, `${tank}/${base} vs ${want}`);
  });

  it('talents change cooldowns, charges and movement speed', () => {
    const cd = CLASS_IDS.flatMap((c) => SPECS[c].flatMap((sp) => specTalents(c, sp.id).flat().filter((t) => Object.values(t.mods.ability ?? {}).some((m) => m.cooldown)).map((t) => ({ c, sp: sp.id, t, id: Object.keys(t.mods.ability!).find((k) => t.mods.ability![k].cooldown)! }))))[0];
    if (cd) {
      const sim = live();
      const me = add(sim, cd.c, 0, 0, 0, build(cd.sp, picks(cd.c, cd.sp, cd.t)));
      add(sim, 'warrior', 1, 20, 0);
      advance(sim, TICK);
      assert.ok(Math.abs(compileMods(cd.c, build(cd.sp, picks(cd.c, cd.sp, cd.t))).ability[cd.id].cooldown! - cd.t.mods.ability![cd.id].cooldown!) < 1e-9);
      assert.ok(me.mods);
    }
    const speed = CLASS_IDS.flatMap((c) => SPECS[c].flatMap((sp) => specTalents(c, sp.id).slice(0, 3).flat().filter((t) => t.mods.moveSpeed).map((t) => ({ c, sp: sp.id, t }))))[0];
    if (speed) {
      const sim2 = live();
      const runner = add(sim2, speed.c, 0, 0, 0, build(speed.sp, picks(speed.c, speed.sp, speed.t)));
      advance(sim2, TICK);
      assert.ok(Math.abs(sim2.speedMult(runner) - compileMods(speed.c, build(speed.sp, picks(speed.c, speed.sp, speed.t))).moveSpeed) < 1e-9);
    }
  });

  it('every buff talent changes the numbers it says it changes', () => {
    for (const cls of CLASS_IDS) for (const sp of SPECS[cls]) {
      const base = compileMods(cls, build(sp.id));
      const tiers = specTalents(cls, sp.id);
      for (const t of tiers.slice(0, 3).flat()) {
        if (!Object.keys(t.mods).length) continue;
        const m = compileMods(cls, build(sp.id, tiers.map((tier) => (tier.includes(t) ? t.id : ''))));
        assert.notDeepEqual(m, base, `${t.id} changes nothing`);
        for (const [k, v] of Object.entries(t.mods)) if (k === 'maxCp') assert.equal(m.maxCp - base.maxCp, v); else if (typeof v === 'number') assert.ok(Math.abs((m as any)[k] / (base as any)[k] - v) < 1e-9, `${t.id}: ${k}`);
      }
    }
  });

  it('buff cooldowns apply while active and wear off', () => {
    const sim = live();
    const war = add(sim, 'warrior', 0, 0, 0, build('fury'));
    war.bar = [...war.bar.slice(0, 7), 'recklessness'];
    const abilityBefore = JSON.stringify(war.mods.ability);
    add(sim, 'mage', 1, 25, 0);
    advance(sim, TICK);
    assert.equal(sim.modsOf(war).damageDone, war.mods.damageDone);
    war.resource = 100;
    assert.ok(sim.useAbility(war.id, 'recklessness').ok);
    assert.ok(Math.abs(sim.modsOf(war).damageDone - war.mods.damageDone * AURAS.recklessness.mods!.damageDone!) < 1e-9);
    assert.equal(sim.modsOf(war).damageTaken, war.mods.damageTaken, 'no downside');
    assert.equal(sim.modsOf(war).rage, AURAS.recklessness.mods!.rage);
    advance(sim, AURAS.recklessness.duration + TICK * 2);
    assert.equal(sim.modsOf(war).damageDone, war.mods.damageDone);
    // base mods must never be mutated by buffs
    assert.equal(JSON.stringify(war.mods.ability), abilityBefore);
    assert.deepEqual(withAuraMods(war.mods, ['shield_wall', 'dispersion']).damageTaken, 0.6 * 0.1);
    assert.equal(war.mods.damageTaken, 1);
  });

  it('defensive cooldown cuts damage and rogue vanish works in combat', () => {
    const sim = live(9);
    const war = add(sim, 'warrior', 0, 0, 0, build('protection'));
    war.bar = [...war.bar.slice(0, 7), 'shield_wall'];
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
    const m: any = parseClientMsg(JSON.stringify({ t: 'join', name: 'A', classId: 'mage', mode: 'practice', build: { spec: 'fire', talents: ['spell_power', 5, 'x'.repeat(100)], gear: { head: 'crown_gold', bad: 7 } }, profile: 'abc' }));
    assert.ok(m);
    assert.equal(m.build.spec, 'fire');
    assert.deepEqual(m.build.talents, ['spell_power', '', '']);
    assert.deepEqual(m.build.gear, { head: 'crown_gold' });
    assert.equal(m.profile, 'abc');
    const none: any = parseClientMsg(JSON.stringify({ t: 'join', name: 'A', classId: 'mage', mode: 'practice' }));
    assert.equal(none.build, undefined);
  });
  it('rejects oversized or non-object builds', () => {
    const m: any = parseClientMsg(JSON.stringify({ t: 'join', name: 'A', classId: 'mage', mode: 'queue', build: 'nope', profile: 5 }));
    assert.equal(m.build, undefined);
    assert.equal(m.profile, undefined);
    const big: any = parseClientMsg(JSON.stringify({ t: 'join', name: 'A', classId: 'mage', mode: 'queue', build: { spec: 'frost', talents: new Array(50).fill('a'), gear: {} } }));
    assert.ok(big.build.talents.length <= 8);
  });
});

describe('channelled abilities', () => {
  it('arcane barrage fires its missiles over time, costs up front, and stops when you move', async () => {
    const { ArenaSim, ABILITIES } = await import('../src/index');
    const def = ABILITIES.arcane_missiles;
    assert.ok(def.channel && def.castTime > 0);
    const mk = () => {
      const sim = new ArenaSim({ prepMs: 0, seed: 7 });
      const mage = sim.addUnit({ name: 'm', classId: 'mage', team: 0, controller: 'player', build: { spec: 'arcane', talents: [], gear: {} } });
      const foe = sim.addUnit({ name: 'f', classId: 'warrior', team: 1, controller: 'dummy' });
      foe.pos = { x: mage.pos.x + 12, z: mage.pos.z };
      mage.facing = Math.PI / 2;
      for (let i = 0; i < 5; i++) sim.step();
      return { sim, mage, foe };
    };
    {
      const { sim, mage, foe } = mk();
      const mana = mage.resource;
      const hp = foe.health;
      assert.ok(sim.useAbility(mage.id, 'arcane_missiles', foe.id).ok);
      assert.equal(mage.resource, mana - def.cost, 'paid at the start');
      assert.equal(foe.health, hp, 'no damage on the first instant');
      const hits: number[] = [];
      for (let i = 0; i < Math.round(3000 / sim.tickMs); i++) {
        sim.step();
        for (const e of sim.drainEvents()) if (e.t === 'damage' && e.ability === 'arcane_missiles') hits.push(sim.time);
      }
      assert.equal(hits.length, def.channel!.ticks, 'one hit per tick');
      assert.ok(hits[hits.length - 1] - hits[0] >= 1400, 'spread across the channel');
      assert.equal(mage.cast, null);
    }
    {
      const { sim, mage, foe } = mk();
      sim.useAbility(mage.id, 'arcane_missiles', foe.id);
      for (let i = 0; i < Math.round(500 / sim.tickMs); i++) sim.step(); // 500 ms: one tick in
      sim.queueInput(mage.id, { seq: 1, fwd: 1, strafe: 0, facing: mage.facing });
      let n = 0;
      for (let i = 0; i < Math.round(3000 / sim.tickMs); i++) {
        sim.step();
        for (const e of sim.drainEvents()) if (e.t === 'damage' && e.ability === 'arcane_missiles') n++;
      }
      assert.ok(n < def.channel!.ticks, 'moving cancelled the volley');
    }
  });
});

describe('talent ability swaps', () => {
  const swaps = CLASS_IDS.flatMap((cls) => SPECS[cls].flatMap((sp) => specTalents(cls, sp.id).flatMap((tier, ti) => tier.filter((t) => t.swap).map((t) => ({ cls, spec: sp, ti, t })))));
  it('the class skill tier swaps skills (3 choices per spec), only in tier 5', () => {
    for (const cls of CLASS_IDS) for (const sp of SPECS[cls]) {
      const mine = swaps.filter((s) => s.spec.id === sp.id && s.cls === cls);
      assert.ok(mine.length >= 3, `${cls}/${sp.id}`);
      for (const s of mine) assert.equal(s.ti, 4, s.t.id);
    }
  });
  it('a swap changes exactly one slot, keeps the bar at the same length and is valid', () => {
    for (const { cls, spec, ti, t } of swaps) {
      const talents = ['', '', '', '', ''];
      talents[ti] = t.id;
      const b = build(spec.id, talents);
      assert.ok(validateBuild(cls, b, false, 0).ok, t.id);
      const bar = barFor(cls, b, []);
      assert.equal(bar.length, spec.bar.length);
      assert.ok(bar.filter((a, i) => a !== spec.bar[i]).length <= 1, `${t.id}/${spec.id}`);
      assert.equal(new Set(bar).size, bar.length);
      assert.ok(bar.includes(t.swap!.to) || t.swap!.stealth, `${t.id} brings ${t.swap!.to}`);
    }
  });
});

describe('cosmetic look', () => {
  const n = COSMETICS.slots.length;
  it('encodes one character per slot and decodes every item back', async () => {
    const { gearLook, parseLook } = await import('../src/index');
    assert.equal(gearLook(undefined), '-'.repeat(n));
    for (const item of ITEMS) {
      const look = gearLook({ [item.slot]: item.id });
      assert.equal(look.length, n);
      assert.equal(parseLook(look)[item.slot].id, item.id);
    }
    const all = gearLook(Object.fromEntries(COSMETICS.slots.map((s) => [s.id, itemsForSlot(s.id)[1].id])));
    assert.equal(Object.keys(parseLook(all)).length, n);
  });
  it('different cosmetics give different looks; wrong-slot items and junk show nothing', async () => {
    const { gearLook, parseLook } = await import('../src/index');
    assert.notEqual(gearLook({ head: 'crown_gold' }), gearLook({ head: 'halo_light' }));
    assert.equal(gearLook({ head: 'cloak_azure' }), '-'.repeat(n), 'an item in the wrong slot shows nothing');
    assert.deepEqual(parseLook('zz!!'), {}, 'a slot index past the list gives nothing');
    assert.deepEqual(parseLook(null), {});
  });
  it('units carry the look in snapshots', () => {
    const sim = live(2);
    const u = add(sim, 'warrior', 0, 0, 0, build('arms', [], { head: 'crown_gold', tint: 'dye_azure' }));
    const look = sim.snapshot().units.find((x) => x.id === u.id)!.look;
    assert.equal(look.length, n);
    assert.notEqual(look, '-'.repeat(n));
  });
});

describe('control across tiers', () => {
  it('every tier 5 pick, with any tier 4 trinket, gives a valid bar without duplicates', () => {
    for (const cls of CLASS_IDS) for (const spec of SPECS[cls]) {
      const tiers = specTalents(cls, spec.id);
      for (const t5 of tiers[4]) for (const t4 of tiers[3]) {
        const b = build(spec.id, ['', '', '', t4.id, t5.id]);
        assert.ok(validateBuild(cls, b, false, 0).ok, `${spec.id}: ${t4.id} + ${t5.id}`);
        const bar = barFor(cls, b, []);
        assert.equal(new Set(bar).size, bar.length);
      }
    }
  });
  it('every class can bring an interrupt', () => {
    const ints = (ids: string[]) => ids.filter((id) => ABILITIES[id].effects.some((e) => e.type === 'interrupt'));
    for (const cls of CLASS_IDS.filter((c) => c !== 'priest')) {
      const reachable = new Set<string>(SPECS[cls].flatMap((s) => [...s.bar, ...specTalents(cls, s.id).flat().flatMap((t) => (t.swap ? [t.swap.to] : []))]));
      assert.ok(ints([...reachable]).length >= 1, `${cls} interrupt`);
    }
  });
});

describe('warrior weapon specs', () => {
  const specBuild = (spec: string): Build => ({ spec, gear: {}, talents: [], ...({} as object) } as unknown as Build);
  it('each warrior spec has its own weapon and auto-attack', async () => {
    const { autoFor, weaponFor } = await import('../src/index');
    assert.equal(weaponFor('warrior', 'arms'), 'dual');
    assert.equal(weaponFor('warrior', 'fury'), 'twohand');
    assert.equal(weaponFor('warrior', 'protection'), 'polearm');
    const d = autoFor('warrior', 'arms')!, t = autoFor('warrior', 'fury')!, p = autoFor('warrior', 'protection')!;
    assert.ok(d.interval < t.interval, 'dual wield swings faster than a greatsword');
    assert.ok(t.damage > d.damage, 'greatsword hits harder per swing');
    assert.ok(p.range > d.range, 'polearm outreaches');
    assert.equal(autoFor('rogue', 'cutthroat')?.interval, CLASSES.rogue.auto?.interval);
  });
  it('polearm auto lands from beyond sword range', () => {
    const sim = live();
    const w = add(sim, 'warrior', 0, 0, 0, specBuild('protection'));
    const e = add(sim, 'priest', 1, 4.5, 0);
    advance(sim, TICK);
    sim.setTarget(w.id, e.id);
    sim.setAutoAttack(w.id, true);
    const hp = e.health;
    advance(sim, 3000);
    assert.ok(e.health < hp, 'polearm hit at 4.5 yd');
  });
});

describe('bots play every spec', () => {
  it('a bot of each spec lands damage on a dummy using its own bar', async () => {
    const { Bot, botBuild } = await import('../src/index');
    for (const cls of CLASS_IDS) {
      for (let i = 0; i < SPECS[cls].length; i++) {
        const sim = new ArenaSim({ seed: 3, prepMs: 0 });
        const u = sim.addUnit({ name: 'b', classId: cls, team: 0, controller: 'bot', build: botBuild(cls, i) });
        const d = sim.addUnit({ name: 'd', classId: 'warrior', team: 1, controller: 'dummy' });
        u.pos = { x: 0, z: 0 }; d.pos = { x: 6, z: 0 };
        const bot = new Bot(sim, u.id, 'hard', 7);
        let dealt = 0; // counted from events: a dummy that is killed stands up again at full health
        for (let t = 0; t < 20000; t += TICK) { bot.tick(); sim.step(); for (const e of sim.drainEvents()) if (e.t === 'damage' && e.src === u.id) dealt += e.amount + e.absorbed; }
        assert.ok(dealt > 0, `${cls}:${u.spec} bot did no damage`);
      }
    }
  });
});

describe('rogue rework', () => {
  const hit = (sim: ArenaSim, id: number, ability: string, foe: number) => {
    const evs: SimEvent[] = [];
    assert.ok(sim.useAbility(id, ability, foe).ok, ability);
    evs.push(...advance(sim, 100));
    return evs.filter((e) => e.t === 'damage' && (e as any).ability === ability) as any[];
  };
  it('Shadowstep adds three combo points', () => {
    const sim = live();
    const r = add(sim, 'rogue', 0, 0, 0, build('subtlety'));
    const f = add(sim, 'warrior', 1, 12, 0);
    advance(sim, TICK);
    assert.ok(sim.useAbility(r.id, 'shadowstep', f.id).ok);
    advance(sim, TICK);
    assert.equal(r.cp, 3);
  });
  it('Backstab hits twice as hard from behind', () => {
    const run = (facing: number) => {
      const sim = live(4);
      const r = add(sim, 'rogue', 0, 0, 0, build('subtlety'));
      const f = add(sim, 'warrior', 1, 2, 0);
      f.facing = facing; f.lastInput.facing = facing;
      advance(sim, TICK);
      return hit(sim, r.id, 'backstab', f.id)[0].amount as number;
    };
    const behind = run(Math.PI / 2), front = run(-Math.PI / 2);
    assert.ok(Math.abs(behind / front - 2) < 0.2, `${behind}/${front}`);
    assert.ok(!SPECS.rogue.find((s) => s.id === 'subtlety')!.bar.includes('sinister_strike'));
  });
  it('Vanish clears slows and roots', () => {
    const sim = live();
    const w = add(sim, 'warrior', 0, 0, 0);
    const r = add(sim, 'rogue', 1, 2, 0, build('combat'));
    advance(sim, TICK);
    sim.applyAura(w, r, 'hamstring_slow');
    assert.ok(sim.speedMult(r) < 1);
    assert.ok(sim.useAbility(r.id, 'vanish').ok);
    assert.equal(sim.speedMult(r), r.mods.moveSpeed);
  });
  it('Twin Vanish has two charges that recharge separately', () => {
    const sim = live();
    const r = add(sim, 'rogue', 0, 0, 0, build('combat', picks('rogue', 'combat', specTalents('rogue', 'combat')[0][1])));
    add(sim, 'warrior', 1, 30, 0);
    advance(sim, TICK);
    assert.ok(sim.useAbility(r.id, 'vanish').ok);
    advance(sim, 10000);
    assert.ok(sim.useAbility(r.id, 'vanish').ok, 'second charge');
    advance(sim, TICK);
    assert.ok(!sim.useAbility(r.id, 'vanish').ok, 'both spent');
    advance(sim, 110000); // first charge (120 s) back, second (130 s) not yet
    assert.ok(sim.useAbility(r.id, 'vanish').ok, 'first recharged on its own timer');
    advance(sim, TICK);
    assert.ok(!sim.useAbility(r.id, 'vanish').ok);
  });
  it('Shadow Mend heals 30% of missing health', () => {
    const sim = live();
    const r = add(sim, 'rogue', 0, 0, 0, build('combat', picks('rogue', 'combat', specTalents('rogue', 'combat')[0][2])));
    add(sim, 'warrior', 1, 30, 0);
    advance(sim, TICK);
    r.health = Math.round(r.maxHealth * 0.2);
    const missing = r.maxHealth - r.health;
    sim.useAbility(r.id, 'vanish');
    assert.ok(Math.abs(r.health - (r.maxHealth - missing * 0.7)) <= 2, `healed to ${r.health}`);
    assert.ok(sim.isStealthed(r), 'the heal does not undo stealth');
  });
  it('Protective Vanish: immune to damage and crowd control for 2 s, and it ends if you leave stealth; Vanish never drops smoke', () => {
    const mk = () => {
      const sim = live();
      const r = add(sim, 'rogue', 0, 0, 0, build('combat', picks('rogue', 'combat', specTalents('rogue', 'combat')[0][0])));
      const w = add(sim, 'warrior', 1, 2, 0);
      advance(sim, TICK);
      return { sim, r, w };
    };
    const a = mk();
    assert.equal(specTalents('rogue', 'combat')[0][0].name, 'Protective Vanish');
    assert.ok(a.sim.useAbility(a.r.id, 'vanish').ok);
    assert.ok(!(a.sim as any).zones.some((z: any) => z.smoke), 'no smoke');
    assert.ok(a.r.auras.some((x) => x.id === 'protective_vanish'), 'the buff is on');
    const hp = a.r.health;
    a.sim.dealDamage(a.w, a.r, 5000, 'physical', null);
    assert.equal(a.r.health, hp, 'no damage taken');
    assert.ok(a.sim.isStealthed(a.r), 'being hit while immune does not reveal you');
    assert.equal(a.sim.applyAura(a.w, a.r, 'cheap_shot_stun').applied, false, 'crowd control bounces off');
    advance(a.sim, 2100);
    assert.ok(!a.r.auras.some((x) => x.id === 'protective_vanish'), 'gone after 2 seconds');
    const b = mk();
    b.sim.useAbility(b.r.id, 'vanish');
    assert.ok(b.r.auras.some((x) => x.id === 'protective_vanish'));
    (b.sim as any).breakStealth(b.r);
    assert.ok(!b.r.auras.some((x) => x.id === 'protective_vanish'), 'leaving stealth ends it');
    const c = mk();
    c.sim.useAbility(c.r.id, 'vanish');
    c.sim.useAbility(c.r.id, 'sinister_strike', c.w.id);
    assert.ok(!c.r.auras.some((x) => x.id === 'protective_vanish'), 'attacking out of stealth ends it');
  });
  it('Sap works from 7 yards, keeps you in stealth and ends on any damage; Gouge turns your auto attack off', () => {
    const sim = live();
    const r = add(sim, 'rogue', 0, 0, 0, build('combat'));
    const w = add(sim, 'warrior', 1, 6.5, 0);
    advance(sim, TICK);
    r.bar = [...r.bar.slice(0, 5), 'sap', 'gouge', 'sinister_strike'];
    r.resource = r.resourceMax;
    sim.applyAura(r, r, 'stealth');
    assert.ok(sim.useAbility(r.id, 'sap', w.id).ok, 'sap from 6.5 yards');
    assert.ok(w.auras.some((x) => x.id === 'sap'));
    assert.ok(sim.isStealthed(r), 'still stealthed');
    assert.equal(r.autoAttack, false, 'sap starts no swinging');
    sim.dealDamage(null, w, 1, 'fire', 'burn', true); // a damage-over-time tick
    assert.ok(!w.auras.some((x) => x.id === 'sap'), 'any damage ends the sap');
    const s2 = live();
    const r2 = add(s2, 'rogue', 0, 0, 0, build('combat'));
    const w2 = add(s2, 'warrior', 1, 2, 0);
    advance(s2, TICK);
    r2.bar = [...r2.bar.slice(0, 5), 'sinister_strike', 'gouge', 'sinister_strike'];
    r2.resource = r2.resourceMax;
    r2.autoAttack = true;
    assert.ok(s2.useAbility(r2.id, 'gouge', w2.id).ok);
    assert.ok(w2.auras.some((x) => x.id === 'gouge'), 'gouged');
    assert.equal(r2.autoAttack, false, 'auto attack is off after a successful gouge');
  });
  it('class talents: energy, speed, and eight combo points that scale harder', () => {
    const t2 = specTalents('rogue', 'combat')[1];
    assert.ok(Math.abs(compileMods('rogue', build('combat', picks('rogue', 'combat', t2[0]))).regen - 1.2) < 1e-9);
    assert.ok(Math.abs(compileMods('rogue', build('combat', picks('rogue', 'combat', t2[1]))).moveSpeed / compileMods('rogue', build('combat')).moveSpeed - 1.1) < 1e-9);
    const sim = live();
    const r = add(sim, 'rogue', 0, 0, 0, build('combat', picks('rogue', 'combat', t2[2])));
    add(sim, 'warrior', 1, 2, 0);
    advance(sim, TICK);
    r.cp = 7;
    r.bar = [...r.bar.slice(0, 5), 'sinister_strike', 'sinister_strike', 'sinister_strike'];
    r.resource = 100;
    sim.setTarget(r.id, [...sim.units.values()].find((u) => u.team === 1)!.id);
    const res = sim.useAbility(r.id, 'sinister_strike');
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(r.cp, 8);
    r.resource = 100; advance(sim, 1500);
    assert.ok(sim.useAbility(r.id, 'sinister_strike').ok);
    assert.equal(r.cp, 8, 'capped at 8');
  });
  it('spec talents: cost, double points, slows, stacking bleed, Shadow Flicker', () => {
    const cost = (spec: string, ab: string, i: number) => {
      const sim = live();
      const r = add(sim, 'rogue', 0, 0, 0, build(spec, picks('rogue', spec, specTalents('rogue', spec)[2][i])));
      const f = add(sim, 'warrior', 1, 2, 0);
      advance(sim, TICK);
      r.resource = 100;
      sim.useAbility(r.id, ab, f.id);
      return { spent: 100 - r.resource, r, f, sim };
    };
    assert.equal(cost('assassination', 'mutilate', 0).spent, 45);
    assert.equal(cost('combat', 'sinister_strike', 0).spent, 36);
    assert.equal(cost('subtlety', 'backstab', 0).spent, 36);
    for (const [spec, ab] of [['assassination', 'mutilate'], ['combat', 'sinister_strike'], ['subtlety', 'backstab']] as const) {
      const c = cost(spec, ab, 2);
      assert.ok(c.f.auras.some((a) => a.id === 'rogue_slow'), `${spec} slow`);
      assert.ok(Math.abs(c.sim.speedMult(c.f) - 0.9) < 1e-9);
    }
    // Double Tap gives two points about half the time
    let twos = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const sim = live(seed);
      const r = add(sim, 'rogue', 0, 0, 0, build('combat', picks('rogue', 'combat', specTalents('rogue', 'combat')[2][1])));
      const f = add(sim, 'warrior', 1, 2, 0);
      advance(sim, TICK);
      sim.useAbility(r.id, 'sinister_strike', f.id);
      if (r.cp === 2) twos++;
    }
    assert.ok(twos > 10 && twos < 30, `double tap ${twos}/40`);
    // Festering Wounds: a second Mutilate adds 3 s instead of restarting
    const sim = live();
    const r = add(sim, 'rogue', 0, 0, 0, build('assassination', picks('rogue', 'assassination', specTalents('rogue', 'assassination')[2][1])));
    const f = add(sim, 'warrior', 1, 2, 0);
    advance(sim, TICK);
    r.resource = 100;
    sim.useAbility(r.id, 'mutilate', f.id);
    advance(sim, 2000);
    r.resource = 100;
    sim.useAbility(r.id, 'mutilate', f.id);
    const left = f.auras.find((a) => a.id === 'mutilate_bleed')!.expiresAt - sim.time;
    assert.ok(left > AURAS.mutilate_bleed.duration - 2000 + 2900, `left ${left}`);
    // Shadow Flicker lands you behind the target (always at 100% here)
    const s2 = live();
    const r2 = add(s2, 'rogue', 0, 0, 0, build('subtlety', picks('rogue', 'subtlety', specTalents('rogue', 'subtlety')[2][1])));
    r2.mods.ability.backstab.shadowProc = 1;
    const f2 = add(s2, 'warrior', 1, 2, 0);
    f2.facing = -Math.PI / 2; f2.lastInput.facing = f2.facing; // facing the rogue
    advance(s2, TICK);
    const dmg = hit(s2, r2.id, 'backstab', f2.id)[0].amount as number;
    assert.ok(r2.pos.x > f2.pos.x, 'ended up behind');
    assert.equal(r2.cp, 1, 'no combo points from the free step');
    assert.ok(dmg > 150, `backstab from behind ${dmg}`);
  });
});

describe('Shadowstep turns you round', () => {
  it('lands behind the target, faces it, and tells the client to turn the camera', () => {
    const sim = live();
    const r = add(sim, 'rogue', 0, 0, 0, build('subtlety'));
    const f = add(sim, 'warrior', 1, 12, 0);
    f.facing = -Math.PI / 2; f.lastInput.facing = f.facing; // looking back at the rogue
    advance(sim, TICK);
    assert.ok(sim.useAbility(r.id, 'shadowstep', f.id).ok);
    const evs = advance(sim, TICK);
    assert.ok(r.pos.x > f.pos.x, 'ended on the far side');
    const turn = evs.find((e) => e.t === 'turn') as Extract<SimEvent, { t: 'turn' }> | undefined;
    assert.ok(turn && turn.unit === r.id);
    assert.ok(Math.abs(Math.sin(turn!.facing) + 1) < 0.2, 'now facing back towards -x, at the target');
  });
});

describe('warrior rework', () => {
  const war = (spec: string, x = 2) => {
    const sim = live(3);
    const w = add(sim, 'warrior', 0, 0, 0, build(spec));
    const f = add(sim, 'priest', 1, x, 0);
    w.resource = 100;
    advance(sim, TICK);
    return { sim, w, f };
  };
  it('every spec shares Charge, Pummel, Hamstring and Heroic Leap, and has its own four', () => {
    for (const sp of SPECS.warrior) for (const a of ['charge', 'pummel', 'hamstring', 'heroic_leap']) assert.ok(sp.bar.includes(a), `${sp.id} ${a}`);
    const own = (id: string) => SPECS.warrior.find((s) => s.id === id)!.bar.filter((a) => !['charge', 'pummel', 'hamstring', 'heroic_leap'].includes(a)).sort();
    assert.deepEqual(own('arms'), ['execute', 'mortal_strike', 'slam', 'slice_and_dice']);
    assert.deepEqual(own('fury'), ['bladestorm', 'bloodthirst', 'recklessness', 'sweep']);
    assert.deepEqual(own('protection'), ['axe_throw', 'deep_cuts', 'not_going_anywhere', 'reel_in']);
    assert.ok(ABILITIES.whirlwind.retired, 'Cleave is off every bar');
    assert.equal(SPECS.warrior.find((s) => s.id === 'protection')!.name, 'Barbarian');
  });
  it('the two-hander reaches further than a sword', () => {
    assert.ok(autoForTest('warrior', 'fury')!.range > autoForTest('warrior', 'arms')!.range);
    const { sim, w, f } = war('fury', 4.2);
    const hp = f.health;
    assert.ok(sim.useAbility(w.id, 'bloodthirst').ok);
    advance(sim, TICK);
    assert.ok(f.health < hp, 'Bloodthirst reaches 4.2 yards');
    const near = war('arms', 4.2);
    assert.ok(near.f.health === near.f.maxHealth && near.sim.useAbility(near.w.id, 'slam', near.f.id).ok === false, 'a sword Slam does not');
  });
  it('Hamstring slows but does no damage; Heroic Leap jumps to the spot and goes on cooldown', () => {
    const { sim, w, f } = war('arms');
    assert.ok(!ABILITIES.hamstring.effects.some((e) => e.type === 'damage'), 'no damage effect');
    assert.ok(sim.useAbility(w.id, 'hamstring', f.id).ok);
    advance(sim, TICK);
    assert.ok(f.auras.some((a) => a.id === 'hamstring_slow'));
    f.pos = { x: 0, z: 19 };
    const hp = f.health;
    assert.ok(sim.useAbility(w.id, 'heroic_leap', null, { x: 0, z: 20 }).ok);
    advance(sim, 200);
    assert.ok(w.pos.z > 1 && w.pos.z < 19, `still in the air at ${w.pos.z}`);
    assert.ok(sim.snapshot().units.find((u) => u.id === w.id)!.y > 0.5, 'airborne');
    advance(sim, 1000);
    assert.ok(Math.abs(w.pos.z - 20) < 1, `landed at ${w.pos.z}`);
    assert.ok(f.health < hp, 'slam hurt the enemy at the landing spot');
    advance(sim, TICK);
    assert.ok(!sim.useAbility(w.id, 'heroic_leap', null, { x: 0, z: 5 }).ok);
    assert.ok(ABILITIES.heroic_leap.cooldown > 0);
  });
  it('Mortal Strike spends its rage cost, hits for a flat amount and does not refund rage from its own hit', () => {
    const hit = (rage: number) => {
      const { sim, w, f } = war('arms');
      w.resource = rage;
      const hp = f.health;
      assert.ok(sim.useAbility(w.id, 'mortal_strike', f.id).ok);
      advance(sim, TICK);
      return { dealt: hp - f.health, left: w.resource };
    };
    const lo = hit(ABILITIES.mortal_strike.cost), hi = hit(100);
    assert.equal(lo.dealt, hi.dealt, 'same damage whatever the rage');
    assert.ok(Math.abs(hi.left - lo.left - (100 - ABILITIES.mortal_strike.cost)) < 1, `rage left ${lo.left} / ${hi.left}`); // the extra rage put in is all still there: no refund from the hit
    const { sim, w, f } = war('arms');
    w.resource = ABILITIES.mortal_strike.cost - 1;
    assert.ok(!sim.useAbility(w.id, 'mortal_strike', f.id).ok, 'needs its rage cost');
  });
  it('Slam gives its listed rage; Mortal Strike hits for about its listed damage and applies Mortal Wounds (less healing taken)', () => {
    assert.ok(ABILITIES.slam.effects.some((e) => e.type === 'gain' && e.amount > 0), 'Slam gives rage');
    const { sim, w, f } = war('arms');
    f.maxHealth = f.health = 1e6;
    const priest = add(sim, 'priest', 0, 0, -3);
    priest.maxHealth = 3000; priest.health = 1000;
    w.resource = 30; w.cooldowns = {}; w.gcdEnd = 0;
    const hp = f.health;
    assert.ok(sim.useAbility(w.id, 'mortal_strike', f.id).ok);
    advance(sim, TICK);
    const msDmg = (ABILITIES.mortal_strike.effects.find((e) => e.type === 'damage') as { amount: number }).amount;
    assert.ok(hp - f.health > msDmg * 0.8 && hp - f.health < msDmg * 1.4, `dealt ${hp - f.health} vs listed ${msDmg}`);
    assert.ok(f.auras.some((x) => x.id === 'mortal_wounds'));
    const heal = (target: typeof f, amount: number) => { const h = target.health; sim.heal(priest, target, amount, 'flash_heal'); return target.health - h; };
    f.health = 1000;
    assert.equal(heal(f, 500), Math.round(500 * AURAS.mortal_wounds.mods!.healingTaken!), 'less healing on the wounded');
    assert.equal(heal(priest, 500), 500, 'others heal normally');
  });
  it('Slice and Dice is a channel with a cooldown that cuts once per tick', () => {
    assert.ok(ABILITIES.slice_and_dice.cooldown > 0);
    assert.ok(ABILITIES.slice_and_dice.effects.find((e) => e.type === 'damage')!.amount > 0);
    assert.ok(ABILITIES.slice_and_dice.castTime / ABILITIES.slice_and_dice.channel!.ticks > 0);
  });
  it('Slice and Dice lands one cut per channel tick, evenly spaced', () => {
    const { sim, w, f } = war('arms', 3);
    w.facing = Math.atan2(0, 1); w.lastInput = { ...w.lastInput, facing: w.facing };
    f.pos = { x: 0, z: 3 };
    const hits: number[] = [];
    const start = sim.time;
    assert.ok(sim.useAbility(w.id, 'slice_and_dice').ok);
    const sd = ABILITIES.slice_and_dice, gap = sd.castTime / sd.channel!.ticks;
    for (let t = 0; t < sd.castTime + 600; t += TICK) {
      const evs = advance(sim, TICK);
      for (const e of evs) if (e.t === 'damage' && e.src === w.id && e.tgt === f.id && e.ability === 'slice_and_dice') hits.push(sim.time - start);
    }
    assert.equal(hits.length, sd.channel!.ticks, `hits at ${hits.join(',')}`);
    for (let i = 1; i < hits.length; i++) assert.ok(Math.abs(hits[i] - hits[i - 1] - gap) <= TICK, `gap ${hits[i] - hits[i - 1]}`);
  });
  it('Slice and Dice stuns and cuts everything in the cone over its channel, and nothing behind', () => {
    const { sim, w, f } = war('arms', 3);
    const behind = add(sim, 'mage', 1, 0, -3);
    w.facing = Math.atan2(0, 1); w.lastInput = { ...w.lastInput, facing: w.facing };
    f.pos = { x: 0, z: 3 };
    const hp = f.health, hb = behind.health;
    assert.ok(sim.useAbility(w.id, 'slice_and_dice').ok);
    advance(sim, TICK * 2);
    assert.ok(f.auras.some((a) => a.id === 'slice_hold'), 'held straight away');
    assert.ok(f.health < hp, 'first cut lands straight away');
    const sd = ABILITIES.slice_and_dice;
    advance(sim, 1000);
    advance(sim, sd.castTime);
    const cut = (sd.effects.find((e) => e.type === 'damage') as { amount: number }).amount;
    assert.ok(hp - f.health > cut * sd.channel!.ticks * 0.5, `dealt ${hp - f.health}`);
    assert.equal(behind.health, hb, 'untouched behind');
  });
  it('Slice and Dice holds you and your targets in place for the whole channel, with no gaps', () => {
    const { sim, w, f } = war('arms', 3);
    f.pos = { x: 0, z: 3 };
    w.facing = 0;
    assert.ok(sim.useAbility(w.id, 'slice_and_dice').ok);
    const spot = { ...w.pos }, foe = { ...f.pos };
    for (let i = 0; i < ABILITIES.slice_and_dice.castTime / TICK - 4; i++) {
      sim.queueInput(w.id, { seq: i + 1, fwd: 1, strafe: 0, facing: 0 });
      sim.queueInput(f.id, { seq: i + 1, fwd: 1, strafe: 0, facing: 0 });
      advance(sim, TICK);
      assert.ok(w.cast, `still channelling at ${sim.time}`);
      assert.ok(f.auras.some((a) => a.id === 'slice_hold'), `target held at ${sim.time}`);
    }
    assert.deepEqual(w.pos, spot, 'the warrior never moved');
    assert.deepEqual(f.pos, foe, 'the target never moved');
  });
  it('Bladestorm hits everything near you and can move while it spins', () => {
    const { sim, w, f } = war('fury', 3);
    const hp = f.health;
    assert.ok(sim.useAbility(w.id, 'bladestorm').ok);
    for (let i = 0; i < 5; i++) { sim.queueInput(w.id, { seq: i + 1, fwd: 0, strafe: 1, facing: w.facing }); advance(sim, TICK); }
    assert.ok(w.cast, 'still channelling while moving');
    advance(sim, ABILITIES.bladestorm.castTime);
    const tick = (ABILITIES.bladestorm.effects.find((e) => e.type === 'damage') as { amount: number }).amount;
    assert.ok(hp - f.health > tick * 3, `dealt ${hp - f.health}`);
  });
  it('Bloodthirst hits every enemy around the warrior and heals its listed percent of maximum health per enemy hit', () => {
    const { sim, w, f } = war('fury', 2);
    const g = add(sim, 'mage', 1, 0, -3);
    const far = add(sim, 'mage', 1, 0, 9);
    const healPct = (ABILITIES.bloodthirst.effects.find((e) => e.type === 'healMax') as { pct: number }).pct;
    w.health = Math.round(w.maxHealth * 0.5);
    const before = w.health;
    const [hp, hpG, hpFar] = [f.health, g.health, far.health];
    w.resource = Math.max(ABILITIES.bloodthirst.cost, 40);
    assert.ok(sim.useAbility(w.id, 'bloodthirst').ok, 'needs no target');
    advance(sim, TICK);
    assert.ok(f.health < hp && g.health < hpG, 'both in reach, one in front and one behind');
    assert.equal(far.health, hpFar, 'the far one is not hit');
    assert.ok(Math.abs(w.health - before - 2 * Math.round(w.maxHealth * healPct)) <= 3, `healed ${w.health - before}`);
    assert.ok(ABILITIES.bloodthirst.cooldown > 0, 'Bloodthirst has a cooldown');
    assert.equal(ABILITIES.bloodthirst.target, 'aoe_enemy');
  });
  it('Sweep is a cone slice ahead that hits only what is in front, within its radius, and goes on cooldown', () => {
    const d = ABILITIES.sweep;
    assert.ok(d.coneDeg! > 0 && d.coneDeg! < 180 && d.cooldown > 0);
    const { sim, w, f } = war('fury', d.radius! - 0.5);
    w.facing = Math.PI / 2; // +x
    const behind = add(sim, 'mage', 1, -3, 0);
    const side = add(sim, 'mage', 1, 0, 3);
    const out = add(sim, 'mage', 1, d.radius! + 1, 0);
    const [h0, hb, hs, ho] = [f.health, behind.health, side.health, out.health];
    assert.ok(sim.useAbility(w.id, 'sweep').ok);
    advance(sim, TICK);
    assert.ok(h0 - f.health > (d.effects[0] as { amount: number }).amount * 0.6, `dealt ${h0 - f.health}`);
    assert.ok(behind.health === hb && side.health === hs && out.health === ho, 'behind, beside and past its radius are safe');
    advance(sim, TICK);
    assert.ok(!sim.useAbility(w.id, 'sweep').ok, 'on cooldown');
  });
  it('Recklessness multiplies damage and every rage gain by its aura numbers for its listed duration', () => {
    const gain = (reckless: boolean) => {
      const { sim, w, f } = war('fury', 2);
      const start = 10 + ABILITIES.bloodthirst.cost; // low enough that the doubled gain never hits the cap
      w.resource = start;
      if (reckless) assert.ok(sim.useAbility(w.id, 'recklessness').ok);
      assert.ok(sim.useAbility(w.id, 'bloodthirst').ok);
      advance(sim, TICK);
      return { rage: w.resource - (start - ABILITIES.bloodthirst.cost), dealt: f.maxHealth - f.health };
    };
    const rm = AURAS.recklessness.mods!;
    const a = gain(false), b = gain(true);
    assert.ok(AURAS.recklessness.duration > 0 && (rm.damageDone ?? 1) > 1 && (rm.rage ?? 1) > 1);
    assert.ok(b.rage > a.rage * (rm.rage! - 0.1), `rage ${a.rage} -> ${b.rage}`);
    assert.ok(b.dealt > a.dealt * (rm.damageDone! - 0.1), `damage ${a.dealt} -> ${b.dealt}`);
  });
  it('Enraged Regeneration lasts its listed duration and heals its listed multiple of the damage you deal, and does nothing once it ends', () => {
    const { sim, w, f } = war('arms', 2);
    const sim0 = sim;
    w.bar = [...w.bar.slice(0, 7), 'enraged_regeneration'];
    const er = AURAS.enraged_regeneration;
    const steal = er.mods?.lifesteal ?? 0;
    assert.ok(steal > 0 && er.duration > 0);
    w.maxHealth = 100000; w.health = 10000;
    f.maxHealth = f.health = 1e6;
    assert.ok(sim0.useAbility(w.id, 'enraged_regeneration').ok);
    const hp = f.health, mine = w.health;
    assert.ok(sim0.useAbility(w.id, 'mortal_strike', f.id).ok);
    advance(sim0, TICK);
    const dealt = hp - f.health;
    assert.ok(dealt > 300);
    assert.ok(Math.abs(w.health - mine - dealt * steal) <= 3, `dealt ${dealt}, healed ${w.health - mine}`);
    advance(sim0, er.duration + 500);
    const h2 = w.health, f2 = f.health;
    w.cooldowns = {}; w.gcdEnd = 0; w.resource = 100;
    sim0.useAbility(w.id, 'mortal_strike', f.id);
    advance(sim0, TICK);
    assert.ok(f.health < f2 && w.health <= h2, 'no healing after it ends');
  });
  it('Deep Cuts stacks its bleed up to three times; Axe Throw reaches its listed range and costs rage', () => {
    const { sim, w, f } = war('protection');
    for (let i = 0; i < 5; i++) { w.resource = 0; assert.ok(sim.useAbility(w.id, 'deep_cuts', f.id).ok); advance(sim, 100); assert.ok(w.resource >= 10, `rage ${w.resource}`); advance(sim, 4000); }
    const cuts = f.auras.find((a) => a.id === 'deep_cuts_bleed');
    assert.equal(cuts?.stacks, 3);
    const reach = ABILITIES.axe_throw.range;
    const t1 = war('protection', reach - 0.5);
    assert.ok(t1.sim.useAbility(t1.w.id, 'axe_throw', t1.f.id).ok, 'Axe Throw just inside its range');
    assert.ok(ABILITIES.axe_throw.cost > 0, 'Axe Throw costs rage');
    const t2 = war('protection', reach + 2);
    assert.ok(!t2.sim.useAbility(t2.w.id, 'axe_throw', t2.f.id).ok);
  });
  it('Reel In pulls everything in a 10 yard cone in front of you, and nothing behind or beyond', () => {
    const { sim, w, f } = war('protection', 2);
    const side = add(sim, 'mage', 1, 0, 9);
    const behind = add(sim, 'mage', 1, 0, -8);
    const far = add(sim, 'mage', 1, 0, 14);
    f.pos = { x: 4, z: 8 };
    w.facing = 0; w.lastInput = { ...w.lastInput, facing: 0 };
    assert.equal(ABILITIES.reel_in.target, 'aoe_enemy');
    assert.ok(sim.useAbility(w.id, 'reel_in').ok);
    advance(sim, TICK);
    const d = (u: { pos: { x: number; z: number } }) => Math.hypot(u.pos.x - w.pos.x, u.pos.z - w.pos.z);
    assert.ok(d(f) < 3 && d(side) < 3, 'both enemies in the cone were dragged in');
    assert.ok(d(behind) > 7 && d(far) > 12, 'the ones behind and beyond stayed put');
  });
  it('Axe Throw hits for about its listed damage', () => {
    const { sim, w, f } = war('protection', 8);
    f.maxHealth = f.health = 1e6;
    const hp = f.health;
    assert.ok(sim.useAbility(w.id, 'axe_throw', f.id).ok);
    advance(sim, TICK);
    const dealt = hp - f.health;
    const listed = (ABILITIES.axe_throw.effects.find((e) => e.type === 'damage') as { amount: number }).amount;
    assert.ok(dealt > listed * 0.8 && dealt < listed * 1.3, `dealt ${dealt} vs listed ${listed}`);
  });
  it('the banner traps enemies inside its circle and lets nobody out', () => {
    const { sim, w, f } = war('protection', 10);
    f.pos = { x: 10, z: 0 };
    assert.ok(sim.useAbility(w.id, 'not_going_anywhere', null, { x: 10, z: 0 }).ok);
    advance(sim, TICK * 2);
    // run for it
    for (let i = 0; i < 60; i++) { sim.queueInput(f.id, { seq: i + 1, fwd: 1, strafe: 0, facing: Math.PI / 2 }); advance(sim, TICK); }
    assert.ok(Math.hypot(f.pos.x - 10, f.pos.z - 0) <= 5.05, `escaped to ${f.pos.x},${f.pos.z}`);
    advance(sim, 9000);
    for (let i = 0; i < 40; i++) { sim.queueInput(f.id, { seq: 100 + i, fwd: 1, strafe: 0, facing: Math.PI / 2 }); advance(sim, TICK); }
    assert.ok(f.pos.x > 16, 'free once the banner is gone');
  });
});

import { autoFor as autoForTest } from '../src/index';

describe('detailed tooltips', () => {
  it('explainAbility shows how the numbers are worked out and names where bonuses come from', () => {
    const lance = ABILITIES.ice_lance;
    const lines = explainAbility(lance, newMods(), []);
    assert.ok(!lines.some((l) => l.startsWith('Damage:')), 'with no bonus the breakdown would only repeat the damage the short tooltip shows');
    assert.ok(lines.some((l) => l.includes('Fingers of Frost')), 'the Fingers bonus is explained');
    const boosted = explainAbility(lance, { ...newMods(), damageDone: 1.1 }, [{ label: 'Test Talent', mods: { damageDone: 1.1 } }]);
    assert.ok(boosted.some((l) => l.startsWith('Damage:') && l.includes('x1.1 Test Talent')), 'names what raised the damage');
    assert.ok(explainAbility(ABILITIES.polymorph, newMods(), []).some((l) => l.includes('Diminishing returns')));
    assert.ok(!explainAbility(ABILITIES.ice_lance, newMods(), []).join(' ').includes('Recklessness'), 'a warrior buff does not show on a mage spell');
  });
});
