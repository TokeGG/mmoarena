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
    for (const [id, a] of Object.entries(AURAS)) if (a.kind === 'buff') assert.ok(a.mods || a.instantFor || a.empower || a.maxStacks || a.hot || a.decoys || a.untargetable || a.invulnerable || a.blocksDebuffs || a.resetsCooldown || a.freeCooldownFor || a.flee, `${id} buff has mods`);
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
    assert.ok(ITEMS.length >= 130, 'cosmetics were doubled');
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
    assert.ok(own.length >= 25);
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
      assert.ok(itemsForSlot(slot.id).filter((i) => i.unlock).length >= 4, `${slot.id} has unlockables`);
      assert.ok(itemsForSlot(slot.id).filter((i) => !i.owner && !i.unlock).length >= 9, `${slot.id} keeps free looks`);
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
    assert.ok(Math.abs(sim.modsOf(war).damageDone - war.mods.damageDone * 1.3) < 1e-9);
    assert.ok(Math.abs(sim.modsOf(war).damageTaken - 1.15) < 1e-9);
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
      for (let i = 0; i < 60; i++) {
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
      for (let i = 0; i < 10; i++) sim.step(); // 500 ms: one tick in
      sim.queueInput(mage.id, { seq: 1, fwd: 1, strafe: 0, facing: mage.facing });
      let n = 0;
      for (let i = 0; i < 60; i++) {
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
  it('Shadow Mend heals 50% of missing health and Smoke Veil drops a cloud', () => {
    const sim = live();
    const r = add(sim, 'rogue', 0, 0, 0, build('combat', picks('rogue', 'combat', specTalents('rogue', 'combat')[0][2])));
    add(sim, 'warrior', 1, 30, 0);
    advance(sim, TICK);
    r.health = Math.round(r.maxHealth * 0.2);
    const missing = r.maxHealth - r.health;
    sim.useAbility(r.id, 'vanish');
    assert.ok(Math.abs(r.health - (r.maxHealth - missing * 0.5)) <= 2, `healed to ${r.health}`);
    assert.ok(sim.isStealthed(r), 'the heal does not undo stealth');
    const s2 = live();
    const r2 = add(s2, 'rogue', 0, 0, 0, build('combat', picks('rogue', 'combat', specTalents('rogue', 'combat')[0][0])));
    add(s2, 'warrior', 1, 30, 0);
    advance(s2, TICK);
    s2.useAbility(r2.id, 'vanish');
    assert.ok((s2 as any).zones.some((z: any) => z.smoke && z.team === r2.team), 'smoke cloud on the rogue');
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
    assert.deepEqual(own('arms'), ['execute', 'mortal_strike', 'slice_and_dice', 'whirlwind']);
    assert.deepEqual(own('fury'), ['bladestorm', 'bloodthirst', 'enraged_regeneration', 'slam']);
    assert.deepEqual(own('protection'), ['axe_throw', 'deep_cuts', 'not_going_anywhere', 'reel_in']);
    assert.equal(ABILITIES.whirlwind.name, 'Cleave');
    assert.equal(SPECS.warrior.find((s) => s.id === 'protection')!.name, 'Barbarian');
  });
  it('the two-hander reaches further than a sword', () => {
    assert.ok(autoForTest('warrior', 'fury')!.range > autoForTest('warrior', 'arms')!.range);
    const { sim, w, f } = war('fury', 4.2);
    assert.ok(sim.useAbility(w.id, 'slam', f.id).ok, 'Slam from 4.2 yards');
  });
  it('Hamstring slows but does no damage; Heroic Leap jumps to the spot on a 60 s cooldown', () => {
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
    assert.equal(ABILITIES.heroic_leap.cooldown, 60000);
  });
  it('Mortal Strike spends 30 rage, hits for a flat amount and does not refund rage from its own hit', () => {
    const hit = (rage: number) => {
      const { sim, w, f } = war('arms');
      w.resource = rage;
      const hp = f.health;
      assert.ok(sim.useAbility(w.id, 'mortal_strike', f.id).ok);
      advance(sim, TICK);
      return { dealt: hp - f.health, left: w.resource };
    };
    const lo = hit(30), hi = hit(100);
    assert.equal(lo.dealt, hi.dealt, 'same damage whatever the rage');
    assert.ok(Math.abs(hi.left - lo.left - 70) < 1, `rage left ${lo.left} / ${hi.left}`); // 70 more rage in, 70 more left: no refund from the hit
    const { sim, w, f } = war('arms');
    w.resource = 20;
    assert.ok(!sim.useAbility(w.id, 'mortal_strike', f.id).ok, 'needs 30 rage');
  });
  it('Cleave costs no rage, builds 15 and recasts every 2.5 s; Mortal Strike hits for about 400 and applies Mortal Wounds (-40% healing taken)', () => {
    assert.equal(ABILITIES.whirlwind.cost, 0);
    assert.equal(ABILITIES.whirlwind.cooldown, 2500);
    const { sim, w, f } = war('arms');
    w.resource = 0;
    f.maxHealth = f.health = 1e6;
    assert.ok(sim.useAbility(w.id, 'whirlwind').ok);
    advance(sim, TICK);
    assert.ok(w.resource >= 15, `rage ${w.resource}`);
    const priest = add(sim, 'priest', 0, 0, -3);
    priest.maxHealth = 3000; priest.health = 1000;
    w.resource = 30; w.cooldowns = {}; w.gcdEnd = 0;
    const hp = f.health;
    assert.ok(sim.useAbility(w.id, 'mortal_strike', f.id).ok);
    advance(sim, TICK);
    assert.ok(hp - f.health > 330 && hp - f.health < 560, `dealt ${hp - f.health}`);
    assert.ok(f.auras.some((x) => x.id === 'mortal_wounds'));
    const heal = (target: typeof f, amount: number) => { const h = target.health; sim.heal(priest, target, amount, 'flash_heal'); return target.health - h; };
    f.health = 1000;
    assert.equal(heal(f, 500), 300, '40% less healing on the wounded');
    assert.equal(heal(priest, 500), 500, 'others heal normally');
  });
  it('Slice and Dice is a 30 s cooldown that cuts for 50 every half second', () => {
    assert.equal(ABILITIES.slice_and_dice.cooldown, 30000);
    assert.equal(ABILITIES.slice_and_dice.effects.find((e) => e.type === 'damage')!.amount, 50);
    assert.equal(ABILITIES.slice_and_dice.castTime / ABILITIES.slice_and_dice.channel!.ticks, 500);
  });
  it('Slice and Dice lands a 50 cut every 0.5 s, the same 400 in all as before', () => {
    const { sim, w, f } = war('arms', 3);
    w.facing = Math.atan2(0, 1); w.lastInput = { ...w.lastInput, facing: w.facing };
    f.pos = { x: 0, z: 3 };
    const hits: number[] = [];
    const start = sim.time;
    assert.ok(sim.useAbility(w.id, 'slice_and_dice').ok);
    for (let t = 0; t < 4600; t += TICK) {
      const evs = advance(sim, TICK);
      for (const e of evs) if (e.t === 'damage' && e.src === w.id && e.tgt === f.id && e.ability === 'slice_and_dice') hits.push(sim.time - start);
    }
    assert.equal(hits.length, 8, `hits at ${hits.join(',')}`);
    for (let i = 1; i < hits.length; i++) assert.ok(Math.abs(hits[i] - hits[i - 1] - 500) <= TICK, `gap ${hits[i] - hits[i - 1]}`);
  });
  it('Slice and Dice stuns and cuts everything in the cone over 4 seconds, and nothing behind', () => {
    const { sim, w, f } = war('arms', 3);
    const behind = add(sim, 'mage', 1, 0, -3);
    w.facing = Math.atan2(0, 1); w.lastInput = { ...w.lastInput, facing: w.facing };
    f.pos = { x: 0, z: 3 };
    const hp = f.health, hb = behind.health;
    assert.ok(sim.useAbility(w.id, 'slice_and_dice').ok);
    advance(sim, TICK * 2);
    assert.ok(f.auras.some((a) => a.id === 'slice_stun'), 'stunned straight away');
    assert.ok(f.health < hp, 'first cut lands straight away');
    advance(sim, 1000);
    advance(sim, 4000);
    assert.ok(hp - f.health > 200, `dealt ${hp - f.health}`);
    assert.equal(behind.health, hb, 'untouched behind');
  });
  it('Bladestorm hits everything near you and can move while it spins', () => {
    const { sim, w, f } = war('fury', 3);
    const hp = f.health;
    assert.ok(sim.useAbility(w.id, 'bladestorm').ok);
    for (let i = 0; i < 5; i++) { sim.queueInput(w.id, { seq: i + 1, fwd: 0, strafe: 1, facing: w.facing }); advance(sim, TICK); }
    assert.ok(w.cast, 'still channelling while moving');
    advance(sim, 4500);
    assert.ok(hp - f.health > 150, `dealt ${hp - f.health}`);
  });
  it('Bloodthirst heals 3% and builds rage; Enraged Regeneration cuts damage by 30% and lifts the heal to 23%', () => {
    const { sim, w, f } = war('fury');
    w.health = Math.round(w.maxHealth * 0.5);
    const before = w.health;
    w.resource = 40;
    sim.useAbility(w.id, 'bloodthirst', f.id);
    advance(sim, TICK);
    assert.ok(Math.abs(w.health - before - Math.round(w.maxHealth * 0.03)) <= 2, `healed ${w.health - before}`);
    assert.ok(w.resource > 40 - 20, 'rage generated');
    assert.equal(ABILITIES.bloodthirst.cooldown, 4500);
    advance(sim, 5000);
    assert.ok(sim.useAbility(w.id, 'enraged_regeneration').ok);
    assert.ok(Math.abs(sim.modsOf(w).damageTaken - w.mods.damageTaken * 0.7) < 1e-9);
    const h2 = w.health;
    sim.useAbility(w.id, 'bloodthirst', f.id);
    advance(sim, TICK);
    assert.ok(Math.abs(w.health - h2 - Math.round(w.maxHealth * 0.23)) <= 2, `healed ${w.health - h2}`);
  });
  it('Deep Cuts stacks its bleed up to three times; Axe Throw reaches 10 yards and costs rage', () => {
    const { sim, w, f } = war('protection');
    assert.equal(ABILITIES.deep_cuts.cost, 0);
    for (let i = 0; i < 5; i++) { w.resource = 0; assert.ok(sim.useAbility(w.id, 'deep_cuts', f.id).ok); advance(sim, 100); assert.ok(w.resource >= 10, `rage ${w.resource}`); advance(sim, 4000); }
    const cuts = f.auras.find((a) => a.id === 'deep_cuts_bleed');
    assert.equal(cuts?.stacks, 3);
    const t1 = war('protection', 9.5);
    assert.ok(t1.sim.useAbility(t1.w.id, 'axe_throw', t1.f.id).ok, 'Axe Throw at 9.5 yards');
    assert.equal(ABILITIES.axe_throw.cost, 50);
    assert.equal(ABILITIES.axe_throw.cooldown, 2000);
    const t2 = war('protection', 12);
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
  it('Axe Throw hits for about 300', () => {
    const { sim, w, f } = war('protection', 8);
    f.maxHealth = f.health = 1e6;
    const hp = f.health;
    assert.ok(sim.useAbility(w.id, 'axe_throw', f.id).ok);
    advance(sim, TICK);
    const dealt = hp - f.health;
    assert.ok(dealt > 250 && dealt < 380, `dealt ${dealt}`);
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
