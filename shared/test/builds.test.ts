import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABILITIES, ArenaSim, AURAS, CLASSES, CLASS_IDS, COSMETICS, ITEMS, SPECS, TUNING,
  barFor, cleanGear, compileMods, describeAbility, describeAura, describeMods, itemById, itemsForSlot, parseClientMsg,
  talentsFor, validateBuild, withAuraMods,
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
    for (const id of Object.keys(ABILITIES)) assert.ok(used.has(id) || CLASSES[ABILITIES[id].class].bar.includes(id), `${id} unreachable`);
    const check = (m: any, where: string) => {
      for (const id of Object.keys(m?.ability ?? {})) assert.ok(ABILITIES[id], `${where}: ability ${id}`);
      for (const id of Object.keys(m?.auraDuration ?? {})) assert.ok(AURAS[id], `${where}: aura ${id}`);
    };
    for (const cls of CLASS_IDS) {
      for (const sp of SPECS[cls]) for (const t of specTalents(cls, sp.id).flat()) check(t.mods, t.id);
      for (const s of SPECS[cls]) check(s.mods, s.id);
    }
    for (const [id, a] of Object.entries(AURAS)) if (a.kind === 'buff') assert.ok(a.mods || a.instantFor, `${id} buff has mods`);
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
    assert.equal(validateBuild('mage', build('frost', ['', '', '', '', '', '', 'extra'])).ok, false);
    assert.equal(validateBuild('mage', build('frost', [specTalents('mage', 'fire')[0][0].id])).ok, false, 'a talent of another spec is invalid');
    assert.equal(validateBuild('mage', build('frost', [specTalents('mage', 'frost')[0][0].id, '', specTalents('mage', 'frost')[2][1].id])).ok, true);
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
    const dmgTalent = specTalents('rogue', 'combat').slice(0, 3).flat().find((t) => t.mods.damageDone || t.mods.ability?.sinister_strike?.damage)!;
    const boosted = run(build('combat', picks('rogue', 'combat', dmgTalent)));
    const want = (dmgTalent.mods.damageDone ?? 1) * (dmgTalent.mods.ability?.sinister_strike?.damage ?? 1) * compileMods('rogue', build('combat')).damageDone;
    assert.ok(base && boosted);
    assert.ok(Math.abs(boosted.amount / base.amount - want) < 0.03, `${boosted.amount}/${base.amount} vs ${want}`);
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
    const tankTalent = specTalents('warrior', 'protection').slice(0, 3).flat().find((t) => t.mods.damageTaken)!;
    const tank = hit(build('protection', picks('warrior', 'protection', tankTalent)));
    const want = compileMods('warrior', build('protection', picks('warrior', 'protection', tankTalent))).damageTaken;
    assert.ok(Math.abs(tank / base - want) < 0.03, `${tank}/${base} vs ${want}`);
  });

  it('talents change cooldowns, charges and movement speed', () => {
    const blinkCd = specTalents('mage', 'frost').slice(0, 3).flat().find((t) => t.mods.ability?.blink?.cooldown)!;
    const sim = live();
    const mage = add(sim, 'mage', 0, 0, 0, build('frost', picks('mage', 'frost', blinkCd)));
    add(sim, 'warrior', 1, 20, 0);
    advance(sim, TICK);
    sim.useAbility(mage.id, 'blink');
    assert.equal(mage.cooldowns.blink - sim.time, Math.round(ABILITIES.blink.cooldown * blinkCd.mods.ability!.blink.cooldown!));
    const speed = Object.values({ a: 'warrior', b: 'mage', c: 'priest', d: 'rogue' }).flatMap((c) => SPECS[c as ClassId].flatMap((sp) => specTalents(c as ClassId, sp.id).slice(0, 3).flat().filter((t) => t.mods.moveSpeed).map((t) => ({ c: c as ClassId, sp: sp.id, t }))))[0];
    const sim2 = live();
    const runner = add(sim2, speed.c, 0, 0, 0, build(speed.sp, picks(speed.c, speed.sp, speed.t)));
    advance(sim2, TICK);
    assert.ok(Math.abs(sim2.speedMult(runner) - compileMods(speed.c, build(speed.sp, picks(speed.c, speed.sp, speed.t))).moveSpeed) < 1e-9);
  });

  it('every buff talent changes the numbers it says it changes', () => {
    for (const cls of CLASS_IDS) for (const sp of SPECS[cls]) {
      const base = compileMods(cls, build(sp.id));
      for (const t of specTalents(cls, sp.id).slice(0, 3).flat()) {
        const m = compileMods(cls, build(sp.id, ['', '', '', '', '', ''].map((_, i) => (specTalents(cls, sp.id)[i].includes(t) ? t.id : ''))));
        assert.notDeepEqual(m, base, `${t.id} changes nothing`);
        for (const [k, v] of Object.entries(t.mods)) if (typeof v === 'number') assert.ok(Math.abs((m as any)[k] / (base as any)[k] - v) < 1e-9, `${t.id}: ${k}`);
      }
    }
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
  it('every spec has nine swap talents', () => {
    for (const cls of CLASS_IDS) for (const sp of SPECS[cls]) assert.equal(swaps.filter((s) => s.spec.id === sp.id && s.cls === cls).length, 9, `${cls}/${sp.id}`);
  });
  it('a swap changes exactly one slot, keeps the bar at the same length and is valid', () => {
    for (const { cls, spec, ti, t } of swaps) {
      const talents = ['', '', '', '', '', ''];
      talents[ti] = t.id;
      const b = build(spec.id, talents);
      assert.ok(validateBuild(cls, b, 0).ok, t.id);
      const bar = barFor(cls, b, []);
      assert.equal(bar.length, spec.bar.length);
      assert.equal(bar.filter((a, i) => a !== spec.bar[i]).length, 1, `${t.id}/${spec.id}`);
      assert.equal(bar[spec.bar.indexOf(t.swap!.from)], t.swap!.to);
      assert.equal(new Set(bar).size, bar.length);
    }
  });
  it('every swapped-in ability can be cast and shows up in snapshots', () => {
    for (const { cls, spec, ti, t } of swaps) {
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
      if (def.requiresStealth) sim.applyAura(me, me, 'stealth');
      if (def.minRange) foe.pos = { x: def.minRange + 2, z: 0 };
      if (def.effects.some((e) => e.type === 'dispel')) sim.applyAura(foe, foe, 'pw_shield');
      assert.ok(me.bar.includes(to), t.id);
      assert.deepEqual(sim.snapshot().units.find((u) => u.id === me.id)!.bar, me.bar);
      assert.equal(sim.snapshot().units.find((u) => u.id === foe.id)!.bar, undefined, 'default bars are not sent');
      const r = sim.useAbility(me.id, to, def.target === 'ally_or_self' ? me.id : foe.id);
      assert.ok(r.ok, `${t.id}: ${(r as any).reason}`);
      assert.doesNotThrow(() => advance(sim, 4000));
      assert.ok(!sim.useAbility(me.id, t.swap!.from, foe.id).ok, 'the replaced ability is gone');
    }
  });
  it('the swapped-in crowd control does what it says', () => {
    const sim = live(7);
    const war = add(sim, 'warrior', 0, 0, 0, build('arms', ['', '', '', '', '', ''].map((_, i) => (i === tierOf('warrior', 'arms', swapTo('warrior', 'arms', 'shockwave')) ? swapTo('warrior', 'arms', 'shockwave').id : ''))));
    const foe = add(sim, 'mage', 1, 3, 0);
    war.resource = war.resourceMax;
    advance(sim, TICK * 2);
    assert.ok(sim.useAbility(war.id, 'shockwave', foe.id).ok);
    advance(sim, TICK * 2);
    assert.ok(foe.auras.some((a) => a.id === 'shockwave_stun'));
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
  it('swaps from the three swap tiers never fight over a slot', () => {
    for (const cls of CLASS_IDS) for (const spec of SPECS[cls]) {
      const [a, b, c] = specTalents(cls, spec.id).slice(3);
      for (const x of a) for (const y of b) for (const z of c) {
        const bar = barFor(cls, build(spec.id, ['', '', '', x.id, y.id, z.id]), []);
        assert.ok([x, y, z].every((t) => bar.includes(t.swap!.to)), `${spec.id}: ${x.id} + ${y.id} + ${z.id}`);
        assert.equal(new Set(bar).size, bar.length);
      }
    }
  });
  it('every class can bring a stun and an interrupt', () => {
    const stuns = (ids: string[]) => ids.filter((id) => ABILITIES[id].effects.some((e) => e.type === 'aura' && AURAS[e.aura]?.kind === 'stun'));
    const ints = (ids: string[]) => ids.filter((id) => ABILITIES[id].effects.some((e) => e.type === 'interrupt'));
    for (const cls of CLASS_IDS) {
      const reachable = new Set<string>(SPECS[cls].flatMap((s) => [...s.bar, ...specTalents(cls, s.id).flat().flatMap((t) => (t.swap ? [t.swap.to] : []))]));
      assert.ok(stuns([...reachable]).length >= 1, `${cls} stun`);
      assert.ok(ints([...reachable]).length >= 1, `${cls} interrupt`);
    }
  });
});
