import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, ArenaSim, AURAS, CLASSES, SPECS, TUNING, barFor, talentsFor, validateBuild } from '../src/index';
import type { AbilityDef, Build, ClassId, SimEvent } from '../src/index';

const TICK = TUNING.tickMs;
const classIds = Object.keys(CLASSES) as ClassId[];

/** Every spec's bar once each talent swap that applies to it is in. */
function reachableFor(cid: ClassId, specId: string): Set<string> {
  const sp = SPECS[cid].find((s) => s.id === specId)!;
  const out = new Set(sp.bar);
  for (const a of sp.bar) if (ABILITIES[a]?.stealthSwap) out.add(ABILITIES[a].stealthSwap!); // slots that turn into another ability in stealth
  for (const tier of talentsFor(cid, specId)) for (const t of tier) { if (t.swap) out.add(t.swap.to); if (t.trinket) out.add(t.trinket); }
  return out;
}

describe('skills and talents audit: data', () => {
  it('every spec bar has 8 distinct abilities of its own class', () => {
    for (const cid of classIds) for (const sp of SPECS[cid]) {
      assert.equal(sp.bar.length, 8, sp.id);
      assert.equal(new Set(sp.bar).size, 8, `${sp.id} has a duplicate`);
      for (const a of sp.bar) assert.equal(ABILITIES[a]?.class, cid, `${sp.id}: ${a}`);
    }
  });

  it('every ability is on some bar or granted by a talent (or retired); every aura it uses exists', () => {
    const seen = new Set<string>();
    for (const cid of classIds) for (const sp of SPECS[cid]) reachableFor(cid, sp.id).forEach((a) => seen.add(a));
    // a skill another one casts for free (Frost Nova from Blink, Hamstring from a strike) is reachable through it
    const nested = new Set<string>();
    const walk = (e: unknown): void => { if (Array.isArray(e)) e.forEach(walk); else if (e && typeof e === 'object') { const o = e as Record<string, unknown>; if (o.type === 'cast') nested.add(o.ability as string); Object.values(o).forEach(walk); } };
    walk(Object.values(ABILITIES));
    for (const cid of classIds) for (const sp of SPECS[cid]) walk(talentsFor(cid, sp.id));
    for (const [id, a] of Object.entries(ABILITIES)) {
      if (a.retired) assert.ok(!seen.has(id), `${id} is retired but still reachable`);
      else assert.ok(seen.has(id) || nested.has(id), `${id} is unreachable (mark it retired or give it a talent)`);
      for (const e of a.effects) if (e.type === 'aura') assert.ok(AURAS[e.aura], `${id}: aura ${e.aura}`);
    }
    for (const [id, au] of Object.entries(AURAS)) if (au.dot) assert.ok(ABILITIES[au.dot.ability], `${id} dot ability`);
  });

  it('every spec has five tiers: skill mod, shared choice, spec choice, trinket, class skill; every build combination is valid with a full distinct bar', () => {
    for (const cid of classIds) {
      for (const sp of SPECS[cid]) {
        const tiers = talentsFor(cid, sp.id);
        assert.equal(tiers.length, 5, `${sp.id} has 5 tiers`);
        const ids = new Set<string>();
        tiers.forEach((tier, ti) => {
          assert.equal(tier.length, 3, `${sp.id} tier ${ti + 1} has 3 options`);
          for (const t of tier) {
            assert.ok(t.name && t.desc && t.icon, t.id);
            assert.ok(!ids.has(t.id), `duplicate talent id ${t.id} in ${sp.id}`);
            ids.add(t.id);
            for (const ab of Object.keys(t.mods?.ability ?? {})) { assert.equal(ABILITIES[ab]?.class, cid, `${t.id}: ${ab}`); assert.ok(sp.bar.includes(ab), `${t.id}: ${ab} must be on the ${sp.id} bar`); }
            for (const au of Object.keys(t.mods?.auraDuration ?? {})) assert.ok(AURAS[au], `${t.id}: ${au}`);
            if (ti < 3) assert.ok(!t.swap && !t.trinket && Object.keys(t.mods ?? {}).length > 0, `${t.id}: tiers 1-3 are buffs`);
            else if (ti === 3) assert.ok(t.trinket && ABILITIES[t.trinket]?.class === 'trinket' && !t.swap && Object.keys(t.mods ?? {}).length === 0, `${t.id}: tier 4 is a trinket`);
            else {
              assert.ok(t.swap && !t.trinket && Object.keys(t.mods ?? {}).length === 0, `${t.id}: tier 5 is a class skill`);
              assert.ok(sp.bar.includes(t.swap!.from), `${t.id}: replaces something on the bar`);
              for (const alt of t.swap!.alt ?? []) assert.ok(sp.bar.includes(alt), `${t.id}: can also replace ${alt}, which must be on the bar`);
              assert.ok(!sp.bar.includes(t.swap!.to) && ABILITIES[t.swap!.to]?.class === cid, `${t.id}: swap target is a new ability of the class`);
            }
          }
        });
        assert.deepEqual(tiers[3].map((t) => t.trinket), ['trinket_cleanse', 'trinket_shield', 'trinket_heal'], `${sp.id}: every spec offers the three trinkets`);
        // every combination of the trinket and the class skill (and each way of choosing what it replaces) is valid with a full distinct bar
        for (const tr of tiers[3]) for (const c of tiers[4]) for (const from of [c.swap!.from, ...(c.swap!.alt ?? [])]) {
          const build: Build = { spec: sp.id, talents: ['', '', '', tr.id, c.id], gear: {}, ...(c.swap!.alt ? { replace: { [c.id]: from } } : {}) };
          assert.ok(validateBuild(cid, build, false, 99).ok, `${tr.id} ${c.id}`);
          const bar = barFor(cid, build, []);
          assert.equal(bar.length, 8);
          assert.equal(new Set(bar).size, 8, `${tr.id} ${c.id} ${from}`);
        }
      }
    }
  });

  it('tier I is the same three talents for every spec of a class, and only touches abilities all three specs share', () => {
    for (const cid of classIds) {
      const first = talentsFor(cid, SPECS[cid][0].id)[0];
      for (const sp of SPECS[cid]) assert.deepEqual(talentsFor(cid, sp.id)[0], first, `${cid}/${sp.id}`);
      for (const t of first) {
        for (const ab of Object.keys(t.mods.ability ?? {})) for (const sp of SPECS[cid]) assert.ok(sp.bar.includes(ab), `${t.id}: ${ab} is not on ${sp.id}`);
        assert.equal(t.mods.damageDone ?? 1, 1, `${t.id}: only ability modifiers`);
      }
    }
  });

  it('rows 1-3: shared skill modifiers, shared stat modifiers, then spec modifiers of its own abilities', () => {
    for (const cid of classIds) {
      const first = talentsFor(cid, SPECS[cid][0].id);
      for (const sp of SPECS[cid]) {
        const tiers = talentsFor(cid, sp.id);
        assert.deepEqual(tiers[1], first[1], `${cid}/${sp.id}: row 2 is the same for every spec`);
        for (const t of tiers[1]) {
          const m = t.mods ?? {};
          assert.ok(!m.ability && !m.auraDuration && !m.auraExtend, `${t.id}: row 2 is stat modifiers only`);
          assert.ok(Object.keys(m).length > 0, t.id);
        }
        for (const t of tiers[2]) assert.ok(Object.keys(t.mods?.ability ?? {}).length + Object.keys(t.mods?.auraDuration ?? {}).length > 0, `${t.id}: row 3 modifies this spec's abilities`);
      }
    }
  });

  it('no buff talent is dead for its spec (its abilities or auras are on that spec)', () => {
    for (const cid of classIds) for (const sp of SPECS[cid]) {
      const can = reachableFor(cid, sp.id);
      for (const t of talentsFor(cid, sp.id).slice(0, 3).flat()) {
        const m = t.mods ?? {};
        const general = Object.keys(m).some((k) => k !== 'ability' && k !== 'auraDuration');
        const ab = Object.entries(m.ability ?? {}).some(([id, mod]) => {
          const d = ABILITIES[id];
          if (!can.has(id)) return false;
          const dot = Object.values(AURAS).some((a) => a.dot?.ability === id) || d.effects.some((e) => e.type === 'aura' && !!AURAS[e.aura]?.dot);
          return (!!mod.damage && (d.effects.some((e) => e.type === 'damage' || e.type === 'zone') || dot)) ||
            (!!mod.heal && d.effects.some((e) => e.type === 'heal')) || (!!mod.cooldown && d.cooldown > 0) || (!!mod.castTime && d.castTime > 0) || (!!mod.range && d.range > 0) || !!mod.charges || !!mod.after?.length || !!mod.extra?.length || !!mod.stored || !!mod.cost || !!mod.cpChance || !!mod.shadowProc || !!mod.castDuring || !!mod.allyOk || !!mod.before?.length || !!mod.landing?.length || !!mod.gain || !!mod.ticks || !!mod.swapAura || !!mod.shieldPct || !!mod.echo;
        });
        const au = Object.keys(m.auraDuration ?? {}).some((aid) => [...can].some((a) => ABILITIES[a].effects.some((e) => e.type === 'aura' && e.aura === aid)));
        assert.ok(general || ab || au, `${t.id} is dead on ${sp.id}`);
      }
    }
  });

  it('every spec has a damage or heal skill that works without stealth', () => {
    for (const cid of classIds) for (const sp of SPECS[cid]) {
      const ok = sp.bar.some((id) => { const a = ABILITIES[id]; return !a.requiresStealth && a.effects.some((e) => e.type === 'damage' || e.type === 'heal' || e.type === 'zone'); });
      assert.ok(ok, `${sp.id} has nothing to cast`);
    }
  });
});

/** Cast one ability in a fresh sim and report what it did. */
function trial(a: AbilityDef, useAlly = false) {
  const needsCast = a.requiresTargetCasting || a.effects.some((e) => e.type === 'interrupt'); // an interrupt needs something to interrupt
  const sim = new ArenaSim({ seed: 7, prepMs: 0 });
  // a trinket belongs to no class: any class can carry it
  const cls: ClassId = a.class === 'trinket' ? 'warrior' : a.class;
  const specs = SPECS[cls];
  let spec = specs.find((s) => s.bar.includes(a.id)) ?? specs.find((s) => s.bar.some((b) => ABILITIES[b]?.stealthSwap === a.id));
  let talents: string[] = [];
  if (!spec) {
    for (const s of specs) talentsFor(cls, s.id).forEach((tier, ti) => tier.forEach((t) => {
      if (!spec && (t.swap?.to === a.id || t.trinket === a.id)) { spec = s; talents = new Array(ti).fill(''); talents[ti] = t.id; }
    }));
  }
  const c = sim.addUnit({ name: 'c', classId: cls, team: 0, build: { spec: spec!.id, talents, gear: {} } });
  const f = sim.addUnit({ name: 'f', classId: cls === 'warrior' || needsCast ? 'mage' : 'warrior', team: 1 });
  const al = sim.addUnit({ name: 'al', classId: 'priest', team: 0 });
  c.pos = { x: 0, z: 0 };
  f.pos = { x: 0, z: Math.max((a.minRange ?? 0) + 1.5, Math.min(a.range * 0.5, 4)) };
  al.pos = { x: 0, z: -3 };
  al.health = Math.floor(al.maxHealth / 2);
  c.health = Math.floor(c.maxHealth * 0.6);
  c.resource = c.resourceMax;
  const ev: SimEvent[] = [];
  const step = (ms: number) => { for (let t = 0; t < ms; t += TICK) { sim.step(); ev.push(...sim.drainEvents()); } };
  step(TICK * 2);
  if (a.requiresStealth) sim.applyAura(c, c, 'stealth');
  if (a.cpSpend) { c.cp = 3; sim.applyAura(c, f, 'garrote_bleed'); }
  if (a.maxTargetHealthPct) f.health = Math.floor((f.maxHealth * a.maxTargetHealthPct) / 200); // finishers need a weakened target
  if (needsCast) { f.resource = 999; assert.ok(sim.useAbility(f.id, 'frostbolt', c.id).ok); }
  if (a.effects.some((e) => e.type === 'dispel' && e.only === 'ally')) {
    sim.applyAura(f, al, 'plague_bloom'); // an area dispel for allies needs an ally with something harmful on it
  } else if (a.effects.some((e) => e.type === 'dispel')) {
    const buff = Object.keys(AURAS).find((k) => AURAS[k].dispellable && !AURAS[k].harmful)!;
    sim.applyAura(f, f, buff);
  }
  if (a.requiresTargetAura) sim.applyAura(c, f, a.requiresTargetAura[0]);
  if (a.coneDeg) { c.facing = Math.atan2(f.pos.x - c.pos.x, f.pos.z - c.pos.z); c.lastInput = { ...c.lastInput, facing: c.facing }; } // cone abilities only hit what the caster faces
  const target = useAlly ? al.id : a.target === 'self' || a.target === 'ground' ? null : f.id;
  const start = { ...c.pos };
  const r = sim.useAbility(c.id, a.id, target, a.target === 'ground' ? { x: f.pos.x, z: f.pos.z } : null);
  step(a.castTime + 4500);
  const sum = (t: 'damage' | 'heal') => ev.filter((e: any) => e.t === t && e.src === c.id).reduce((s, e: any) => s + e.amount + (e.absorbed ?? e.overheal ?? 0), 0);
  return { r, dmg: sum('damage'), heal: sum('heal'), auras: ev.filter((e: any) => e.t === 'aura' && e.src === c.id), disp: ev.some((e) => e.t === 'dispel'), intr: ev.some((e: any) => e.t === 'interrupt' && e.src === c.id), moved: Math.hypot(c.pos.x - start.x, c.pos.z - start.z) };
}

describe('skills and talents audit: every ability works in the sim', () => {
  for (const a of Object.values(ABILITIES).filter((x) => !x.retired)) {
    it(`${a.class}: ${a.name} (${a.id})`, () => {
      const ally = a.effects.some((e) => e.type === 'heal' && e.only === 'ally') || a.target === 'ally';
      const t = trial(a, ally);
      assert.ok(t.r.ok, `cast failed: ${(t.r as { reason?: string }).reason}`);
      const has = (k: string) => a.effects.some((e) => e.type === k);
      if (has('damage') && !ally) assert.ok(t.dmg > 0, 'no damage');
      if (has('heal')) assert.ok(t.heal > 0, 'no healing');
      if (a.effects.some((e) => e.type === 'aura' && e.chance === undefined)) assert.ok(t.auras.length > 0, 'no aura applied');
      if (has('dispel')) assert.ok(t.disp, 'nothing dispelled');
      if (has('interrupt')) assert.ok(t.intr, 'no interrupt');
      if (has('blink') || has('dashToTarget') || has('charge')) assert.ok(t.moved > 1, 'did not move');
      if (has('zone')) assert.ok(t.dmg > 0, 'zone did no damage');
    });
  }
});
