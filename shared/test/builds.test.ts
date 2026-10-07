import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABILITIES, ArenaSim, AURAS, CLASSES, CLASS_IDS, COSMETICS, ITEMS, SPECS, TALENTS, TUNING,
  barFor, cleanGear, compileMods, describeAbility, describeAura, describeMods, itemById, itemsForSlot, parseClientMsg,
  validateBuild, withAuraMods,
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
    const used = new Set([...CLASS_IDS.flatMap((c) => SPECS[c].flatMap((s) => s.bar)), ...CLASS_IDS.flatMap((c) => TALENTS[c].flat().map((t) => t.swap?.to ?? '')), ...Object.values(ABILITIES).map((a) => a.stealthSwap ?? '')]);
    for (const id of Object.keys(ABILITIES)) assert.ok(used.has(id) || CLASSES[ABILITIES[id].class].bar.includes(id), `${id} unreachable`);
    const check = (m: any, where: string) => {
      for (const id of Object.keys(m?.ability ?? {})) assert.ok(ABILITIES[id], `${where}: ability ${id}`);
      for (const id of Object.keys(m?.auraDuration ?? {})) assert.ok(AURAS[id], `${where}: aura ${id}`);
    };
    for (const cls of CLASS_IDS) {
      assert.equal(TALENTS[cls].length, 6, `${cls} has 6 talent tiers`);
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
      for (const t of TALENTS[cls].flat()) {
        if (!t.swap) continue;
        assert.equal(ABILITIES[t.swap.to]?.class, cls, `${t.id}: swap target belongs to the class`);
        for (const sp of SPECS[cls]) {
          const from = t.swap.replaces[sp.id];
          assert.ok(from && sp.bar.includes(from), `${t.id}: ${sp.id} must name an ability on its bar`);
          assert.ok(!sp.bar.includes(t.swap.to), `${t.id}: ${sp.id} already has ${t.swap.to}`);
        }
      }
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

describe('cosmetics', () => {
  it('has a good number of items in every slot, each with a unique id and a valid colour', () => {
    assert.ok(ITEMS.length >= 50);
    assert.equal(new Set(ITEMS.map((i) => i.id)).size, ITEMS.length);
    for (const slot of COSMETICS.slots) assert.ok(itemsForSlot(slot.id).filter((i) => !i.owner).length >= 7, slot.id);
    for (const i of ITEMS) assert.match(i.color, /^#[0-9a-f]{6}$/i, i.id);
  });

  it('every cosmetic is free for everyone (no unlocks), and bad picks are rejected', () => {
    for (const i of ITEMS.filter((x) => !x.owner)) assert.equal(validateBuild('mage', build('frost', [], { [i.slot]: i.id })).ok, true, i.id);
    assert.equal(validateBuild('mage', build('frost', [], { head: 'cloak_azure' })).ok, false, 'wrong slot');
    assert.equal(validateBuild('mage', build('frost', [], { head: 'nope' })).ok, false);
    assert.equal(validateBuild('mage', build('frost', [], { hat: 'crown_gold' })).ok, false);
    assert.equal(validateBuild('mage', build('fire' + 'x')).ok, false);
    assert.equal(validateBuild('mage', build('frost', ['bogus'])).ok, false);
    assert.equal(validateBuild('mage', build('frost', ['spell_power', 'improved_blink', 'blazing_speed', 'extra'])).ok, false);
    assert.equal(validateBuild('mage', build('frost', ['spell_power', '', 'blazing_speed'])).ok, true);
  });

  it('owner-only cosmetics: a good number, rejected and stripped for everyone but the owner', () => {
    const own = ITEMS.filter((i) => i.owner);
    assert.ok(own.length >= 8);
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
    const def = ABILITIES.arcane_barrage;
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
      assert.ok(sim.useAbility(mage.id, 'arcane_barrage', foe.id).ok);
      assert.equal(mage.resource, mana - def.cost, 'paid at the start');
      assert.equal(foe.health, hp, 'no damage on the first instant');
      const hits: number[] = [];
      for (let i = 0; i < 60; i++) {
        sim.step();
        for (const e of sim.drainEvents()) if (e.t === 'damage' && e.ability === 'arcane_barrage') hits.push(sim.time);
      }
      assert.equal(hits.length, def.channel!.ticks, 'one hit per tick');
      assert.ok(hits[hits.length - 1] - hits[0] >= 1400, 'spread across the channel');
      assert.equal(mage.cast, null);
    }
    {
      const { sim, mage, foe } = mk();
      sim.useAbility(mage.id, 'arcane_barrage', foe.id);
      for (let i = 0; i < 10; i++) sim.step(); // 500 ms: one tick in
      sim.queueInput(mage.id, { seq: 1, fwd: 1, strafe: 0, facing: mage.facing });
      let n = 0;
      for (let i = 0; i < 60; i++) {
        sim.step();
        for (const e of sim.drainEvents()) if (e.t === 'damage' && e.ability === 'arcane_barrage') n++;
      }
      assert.ok(n < def.channel!.ticks, 'moving cancelled the volley');
    }
  });
});

describe('talent ability swaps', () => {
  const swaps = CLASS_IDS.flatMap((cls) => TALENTS[cls].flatMap((tier, ti) => tier.filter((t) => t.swap).map((t) => ({ cls, ti, t }))));
  it('there are swap talents for every class', () => {
    for (const cls of CLASS_IDS) assert.equal(swaps.filter((s) => s.cls === cls).length, cls === 'mage' ? 2 : 5, cls); // mage tier 4 is the Blink tier, with no swaps
  });
  it('a swap changes exactly one slot, keeps the bar at the same length and is valid', () => {
    for (const { cls, ti, t } of swaps) {
      for (const spec of SPECS[cls]) {
        const talents = ['', '', '', '', '', ''];
        talents[ti] = t.id;
        const b = build(spec.id, talents);
        assert.ok(validateBuild(cls, b, 0).ok, t.id);
        const bar = barFor(cls, b, []);
        assert.equal(bar.length, spec.bar.length);
        assert.equal(bar.filter((a, i) => a !== spec.bar[i]).length, 1, `${t.id}/${spec.id}`);
        assert.ok(ABILITIES[t.swap!.replaces[spec.id]], 'replaced ability exists');
        assert.equal(bar[spec.bar.indexOf(t.swap!.replaces[spec.id])], t.swap!.to);
        assert.equal(new Set(bar).size, bar.length);
      }
    }
  });
  it('every swapped-in ability can be cast and shows up in snapshots', () => {
    for (const { cls, ti, t } of swaps) {
      const spec = SPECS[cls][0];
      const talents = ['', '', '', '', '', ''];
      talents[ti] = t.id;
      const sim = live(5);
      const me = add(sim, cls, 0, 0, 0, build(spec.id, talents));
      const to = t.swap!.to;
      const def = ABILITIES[to];
      const foe = add(sim, 'warrior', 1, def.range > 0 ? Math.min(4, def.range) : 3, 0);
      me.resource = me.resourceMax;
      advance(sim, TICK * 2);
      if (def.requiresTargetCasting) foe.cast = { ability: 'frostbolt', target: me.id, start: 0, end: 99999 };
      assert.ok(me.bar.includes(to), t.id);
      assert.deepEqual(sim.snapshot().units.find((u) => u.id === me.id)!.bar, me.bar);
      assert.equal(sim.snapshot().units.find((u) => u.id === foe.id)!.bar, undefined, 'default bars are not sent');
      const r = sim.useAbility(me.id, to, def.target === 'ally_or_self' ? me.id : foe.id);
      assert.ok(r.ok, `${t.id}: ${(r as any).reason}`);
      assert.doesNotThrow(() => advance(sim, 4000));
      assert.ok(!sim.useAbility(me.id, spec.bar.find((a) => !me.bar.includes(a))!, foe.id).ok, 'the replaced ability is gone');
    }
  });
  it('the new crowd control and buffs do what they say', () => {
    const sim = live(7);
    const war = add(sim, 'warrior', 0, 0, 0, build('arms', ['', '', '', 'tal_shockwave', '', '']));
    const foe = add(sim, 'mage', 1, 3, 0);
    war.resource = war.resourceMax;
    advance(sim, TICK * 2);
    assert.ok(sim.useAbility(war.id, 'shockwave', foe.id).ok);
    advance(sim, TICK * 2);
    assert.ok(foe.auras.some((a) => a.id === 'shockwave_stun'));
    const sim2 = live(8);
    const rg = add(sim2, 'rogue', 0, 0, 0, build('combat', ['', '', '', 'tal_cripple', '', '']));
    const f2 = add(sim2, 'warrior', 1, 2, 0);
    rg.resource = rg.resourceMax;
    advance(sim2, TICK * 2);
    assert.ok(sim2.useAbility(rg.id, 'crippling_strike', f2.id).ok);
    advance(sim2, TICK * 2);
    assert.ok(f2.auras.some((a) => a.id === 'crippling_slow'));
    assert.ok(f2.health < f2.maxHealth);
  });
  it('capstone talents change the right numbers', () => {
    const m = compileMods('rogue', build('assassination', ['', '', '', '', '', 'tal_r_stun']));
    assert.ok(Math.abs(m.auraDuration.blind - 1.15) < 1e-9);
    const w = compileMods('warrior', build('arms', ['', '', '', '', '', 'tal_w_rage']));
    assert.ok(w.ability.mortal_strike.damage! > 1.1);
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

describe('control and swaps across tiers', () => {
  it('two swaps from different tiers never fight over the same slot', () => {
    for (const cls of CLASS_IDS) {
      const swapTalents = TALENTS[cls].map((tier, ti) => tier.filter((t) => t.swap).map((t) => ({ ti, t }))).filter((x) => x.length);
      if (swapTalents.length < 2) continue;
      for (const spec of SPECS[cls]) {
        for (const a of swapTalents[0]) for (const b of swapTalents[1]) {
          const talents = ['', '', '', '', '', ''];
          talents[a.ti] = a.t.id;
          talents[b.ti] = b.t.id;
          const bar = barFor(cls, build(spec.id, talents), []);
          assert.ok(bar.includes(a.t.swap!.to) && bar.includes(b.t.swap!.to), `${spec.id}: ${a.t.id} + ${b.t.id}`);
          assert.equal(new Set(bar).size, bar.length);
        }
      }
    }
  });
  it('every class can bring a stun and an interrupt', () => {
    const stuns = (ids: string[]) => ids.filter((id) => ABILITIES[id].effects.some((e) => e.type === 'aura' && AURAS[e.aura]?.kind === 'stun'));
    const ints = (ids: string[]) => ids.filter((id) => ABILITIES[id].effects.some((e) => e.type === 'interrupt'));
    for (const cls of CLASS_IDS) {
      const reachable = new Set<string>([...SPECS[cls].flatMap((s) => s.bar), ...TALENTS[cls].flat().flatMap((t) => (t.swap ? [t.swap.to] : []))]);
      assert.ok(stuns([...reachable]).length >= 1, `${cls} stun`);
      assert.ok(ints([...reachable]).length >= 1, `${cls} interrupt`);
    }
  });
});
