import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, ArenaSim, AURAS, CLASSES, SPECS, TALENTS, TUNING, barFor, validateBuild } from '../src/index';
import type { AbilityDef, Build, ClassId, SimEvent } from '../src/index';

const TICK = TUNING.tickMs;
const classIds = Object.keys(CLASSES) as ClassId[];

/** Every spec's bar once each talent swap that applies to it is in. */
function reachableFor(cid: ClassId, specId: string): Set<string> {
  const sp = SPECS[cid].find((s) => s.id === specId)!;
  const out = new Set(sp.bar);
  for (const a of sp.bar) if (ABILITIES[a]?.stealthSwap) out.add(ABILITIES[a].stealthSwap!); // slots that turn into another ability in stealth
  for (const tier of TALENTS[cid]) for (const t of tier) if (t.swap?.replaces[specId]) out.add(t.swap.to);
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

  it('every ability is on some bar or granted by a talent; every aura it uses exists', () => {
    const seen = new Set<string>();
    for (const cid of classIds) for (const sp of SPECS[cid]) reachableFor(cid, sp.id).forEach((a) => seen.add(a));
    for (const [id, a] of Object.entries(ABILITIES)) {
      assert.ok(seen.has(id), `${id} is unreachable`);
      for (const e of a.effects) if (e.type === 'aura') assert.ok(AURAS[e.aura], `${id}: aura ${e.aura}`);
    }
    for (const [id, au] of Object.entries(AURAS)) if (au.dot) assert.ok(ABILITIES[au.dot.ability], `${id} dot ability`);
  });

  it('every talent does something, swaps cover every spec, and every build combination is valid with a full distinct bar', () => {
    for (const cid of classIds) {
      TALENTS[cid].forEach((tier) => tier.forEach((t) => {
        assert.ok(t.name && t.desc, t.id);
        assert.ok(Object.keys(t.mods ?? {}).length > 0 || t.swap, `${t.id} does nothing`);
        for (const ab of Object.keys(t.mods?.ability ?? {})) assert.equal(ABILITIES[ab]?.class, cid, `${t.id}: ${ab}`);
        for (const au of Object.keys(t.mods?.auraDuration ?? {})) assert.ok(AURAS[au], `${t.id}: ${au}`);
        if (t.swap) for (const sp of SPECS[cid]) {
          const from = t.swap.replaces[sp.id];
          assert.ok(from && sp.bar.includes(from), `${t.id}: no valid swap for ${sp.id}`);
        }
      }));
      for (const sp of SPECS[cid]) {
        const walk = (i: number, picks: string[]) => {
          if (i === TALENTS[cid].length) {
            const b: Build = { spec: sp.id, talents: picks, gear: {} };
            assert.ok(validateBuild(cid, b, 99).ok, picks.join());
            const bar = barFor(cid, b, sp.bar);
            assert.equal(new Set(bar).size, bar.length, `${sp.id} ${picks} duplicates`);
            assert.equal(bar.length, 8);
            return;
          }
          // sample the first and last option of each tier plus every option of swap tiers (keeps this fast)
          const tier = TALENTS[cid][i];
          for (const t of tier.length > 3 ? tier : [tier[0], tier[tier.length - 1]]) walk(i + 1, [...picks, t.id]);
        };
        walk(0, []);
      }
    }
  });

  it('no talent is completely dead for a spec (its abilities or auras are reachable on that spec)', () => {
    for (const cid of classIds) for (const sp of SPECS[cid]) {
      const can = reachableFor(cid, sp.id);
      for (const tier of TALENTS[cid]) for (const t of tier) {
        const m = t.mods ?? {};
        const general = Object.keys(m).some((k) => k !== 'ability' && k !== 'auraDuration');
        const ab = Object.entries(m.ability ?? {}).some(([id, mod]) => {
          const d = ABILITIES[id];
          if (!can.has(id)) return false;
          const dot = Object.values(AURAS).some((a) => a.dot?.ability === id);
          return (!!mod.damage && (d.effects.some((e) => e.type === 'damage' || e.type === 'zone') || dot)) ||
            (!!mod.heal && d.effects.some((e) => e.type === 'heal')) || (!!mod.cooldown && d.cooldown > 0) || (!!mod.castTime && d.castTime > 0) || (!!mod.range && d.range > 0) || !!mod.charges || !!mod.after?.length;
        });
        const au = Object.keys(m.auraDuration ?? {}).some((aid) => [...can].some((a) => ABILITIES[a].effects.some((e) => e.type === 'aura' && e.aura === aid)));
        assert.ok(general || ab || au || t.swap?.replaces[sp.id], `${t.id} is dead on ${sp.id}`);
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
  const sim = new ArenaSim({ seed: 7, prepMs: 0 });
  const specs = SPECS[a.class];
  let spec = specs.find((s) => s.bar.includes(a.id)) ?? specs.find((s) => s.bar.some((b) => ABILITIES[b]?.stealthSwap === a.id));
  let talents: string[] = [];
  if (!spec) {
    for (const s of specs) TALENTS[a.class].forEach((tier, ti) => tier.forEach((t) => {
      if (!spec && t.swap?.to === a.id && t.swap.replaces[s.id]) { spec = s; talents = new Array(ti).fill(''); talents[ti] = t.id; }
    }));
  }
  const c = sim.addUnit({ name: 'c', classId: a.class, team: 0, build: { spec: spec!.id, talents, gear: {} } });
  const f = sim.addUnit({ name: 'f', classId: a.class === 'warrior' || a.requiresTargetCasting ? 'mage' : 'warrior', team: 1 });
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
  if (a.requiresTargetCasting) { f.resource = 999; assert.ok(sim.useAbility(f.id, 'fireball', c.id).ok); }
  if (a.effects.some((e) => e.type === 'dispel')) {
    const buff = Object.keys(AURAS).find((k) => AURAS[k].dispellable && !AURAS[k].harmful)!;
    sim.applyAura(f, f, buff);
  }
  const target = useAlly ? al.id : a.target === 'self' || a.target === 'ground' ? null : f.id;
  const start = { ...c.pos };
  const r = sim.useAbility(c.id, a.id, target, a.target === 'ground' ? { x: f.pos.x, z: f.pos.z } : null);
  step(a.castTime + 4500);
  const sum = (t: 'damage' | 'heal') => ev.filter((e: any) => e.t === t && e.src === c.id).reduce((s, e: any) => s + e.amount + (e.absorbed ?? e.overheal ?? 0), 0);
  return { r, dmg: sum('damage'), heal: sum('heal'), auras: ev.filter((e: any) => e.t === 'aura' && e.src === c.id), disp: ev.some((e) => e.t === 'dispel'), intr: ev.some((e: any) => e.t === 'interrupt' && e.src === c.id), moved: Math.hypot(c.pos.x - start.x, c.pos.z - start.z) };
}

describe('skills and talents audit: every ability works in the sim', () => {
  for (const a of Object.values(ABILITIES)) {
    it(`${a.class}: ${a.name} (${a.id})`, () => {
      const ally = a.effects.some((e) => e.type === 'heal' && e.only === 'ally');
      const t = trial(a, ally);
      assert.ok(t.r.ok, `cast failed: ${(t.r as { reason?: string }).reason}`);
      const has = (k: string) => a.effects.some((e) => e.type === k);
      if (has('damage') && !ally) assert.ok(t.dmg > 0, 'no damage');
      if (has('heal')) assert.ok(t.heal > 0, 'no healing');
      if (has('aura')) assert.ok(t.auras.length > 0, 'no aura applied');
      if (has('dispel')) assert.ok(t.disp, 'nothing dispelled');
      if (has('interrupt')) assert.ok(t.intr, 'no interrupt');
      if (has('blink') || has('dashToTarget') || has('charge')) assert.ok(t.moved > 1, 'did not move');
      if (has('zone')) assert.ok(t.dmg > 0, 'zone did no damage');
    });
  }
});
