import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, AURAS, ArenaSim, SPECS, TUNING, arenaById, hasLOS, heightAt, onRaised } from '../src/index';
import type { ClassId, SimEvent, TeamId, Unit } from '../src/index';

/**
 * Every ability type on arenas with two levels: it works with caster and target both up on the deck (or both below it),
 * and never reaches through the floor between them.
 */
const TICK = TUNING.tickMs;
const ARENA = arenaById('overlook'); // a deck at height 3.2 over x -6..6, z -5..5, with ramps at both ends

type Spot = { x: number; z: number; lv: 0 | 1 };
const classOf = (ability: string): ClassId => {
  for (const c of Object.keys(SPECS) as ClassId[]) for (const s of SPECS[c]) if (s.bar.includes(ability)) return c;
  return 'warrior';
};

function setup(ability: string, from: Spot, to: Spot, opts: { aim?: Spot; facing?: number } = {}) {
  const sim = new ArenaSim({ seed: 3, prepMs: 0, arena: ARENA });
  const def = ABILITIES[ability];
  const caster = sim.addUnit({ name: 'caster', classId: classOf(ability), team: 0 as TeamId, controller: 'bot' });
  const foe = sim.addUnit({ name: 'foe', classId: 'warrior', team: 1 as TeamId, controller: 'dummy' });
  const ally = sim.addUnit({ name: 'ally', classId: 'priest', team: 0 as TeamId, controller: 'dummy' });
  sim.step();
  sim.drainEvents();
  const put = (u: Unit, s: Spot) => { u.pos = { x: s.x, z: s.z }; u.level = s.lv; };
  put(caster, from);
  const friendly = def.target === 'ally' || def.target === 'ally_or_self' || def.target === 'any' || def.target === 'aoe_all';
  const other = friendly ? ally : foe;
  put(other, to);
  put(friendly ? foe : ally, { x: 25, z: 15, lv: 0 }); // the spare unit stands far away
  caster.facing = opts.facing ?? Math.atan2(to.x - from.x, to.z - from.z);
  caster.lastInput = { ...caster.lastInput, facing: caster.facing };
  if (!caster.bar.includes(ability)) caster.bar = [...caster.bar, ability];
  caster.resource = 1e6; caster.resourceMax = 1e6; caster.cp = 5;
  other.health = other.maxHealth = 1e6;
  if (friendly) other.health = other.maxHealth * 0.5;
  if (def.requiresStealth) sim.applyAura(caster, caster, 'stealth');
  if (def.outOfCombatOnly || def.requiresStealth) caster.lastCombatAt = -1e9;
  if (def.maxTargetHealthPct !== undefined) other.health = Math.floor(other.maxHealth * (def.maxTargetHealthPct / 100) * 0.5);
  if (def.requiresTargetAura) sim.applyAura(caster, other, def.requiresTargetAura[0]);
  if (def.requiresTargetCasting) other.cast = { ability: 'frostbolt', target: caster.id, start: sim.time, end: sim.time + 5000 };
  sim.drainEvents();
  return { sim, def, caster, other, friendly };
}

const touched = (ev: SimEvent[], caster: Unit, other: Unit): boolean =>
  ev.some((e) => (e.t === 'damage' || e.t === 'heal' || e.t === 'aura' || e.t === 'interrupt' || e.t === 'dispel' || e.t === 'immune' || e.t === 'miss') && 'tgt' in e && e.tgt === other.id && (!('src' in e) || e.src === caster.id || other.id === caster.id));

function runWith(s: ReturnType<typeof setup>, ability: string, to: Spot, aim?: Spot) {
  const { sim, def, caster, other } = s;
  const startPos = { ...caster.pos };
  const startLv = caster.level;
  const hp0 = other.health;
  const ground = def.target === 'ground' ? { x: (aim ?? to).x, z: (aim ?? to).z, ...((aim ?? to).lv === 1 ? { lv: 1 as const } : {}) } : null;
  sim.setTarget(caster.id, other.id);
  const r = sim.useAbility(caster.id, ability, other.id, ground);
  const ev: SimEvent[] = [];
  const total = (def.castTime || 0) + 1600;
  for (let t = 0; t < total; t += TICK) { sim.step(); ev.push(...sim.drainEvents()); }
  const cast = ev.some((e) => e.t === 'cast' && e.unit === caster.id && e.ability === ability);
  return { ...s, r, ev, cast, hit: touched(ev, caster, other) || other.health !== hp0, moved: Math.hypot(caster.pos.x - startPos.x, caster.pos.z - startPos.z), startLv, zones: sim.snapshot().zones };
}

const IDS = Object.keys(ABILITIES);
const DECK1: Spot = { x: -3, z: 0, lv: 1 };
const DECK2: Spot = { x: -1, z: 0, lv: 1 };
/** Right under the first deck spot: the deck is between them. */
const BELOW: Spot = { x: -3.5, z: 0, lv: 0 };
const GROUND1: Spot = { x: -3, z: 0, lv: 0 };
const GROUND2: Spot = { x: -1, z: 0, lv: 0 };

/** What the ability does to its target (as opposed to the caster or the ground): these are the ones that must reach a target on the same floor and nobody else. */
const hitsTarget = (id: string) => {
  const d = ABILITIES[id];
  if (d.target === 'self' || d.target === 'ground') return false;
  return d.effects.some((e) => ['damage', 'heal', 'interrupt', 'dispel'].includes(e.type) || (e.type === 'aura' && !e.self));
};
const MAGIC_DEBUFF = Object.entries(AURAS).find(([, a]) => a.harmful && a.dispellable && a.kind === 'slow')![0];
const prep = (id: string) => (id === 'dispel_magic' || id === 'purifying_light' ? MAGIC_DEBUFF : null);
/** Abilities that need a run-up. */
const FAR: Record<string, Spot> = { charge: { x: 4, z: 0, lv: 1 }, shadowstep: { x: 4, z: 0, lv: 1 } };

describe('abilities on a deck (two levels)', () => {
  for (const id of IDS) {
    const def = ABILITIES[id];
    if (def.target === 'self' || def.target === 'ground') continue;
    it(`${id}: works from the deck onto the deck, and not through the floor`, () => {
      const buff = prep(id);
      const run = (from: Spot, to: Spot, aim?: Spot) => {
        const s = setup(id, from, to, { aim });
        if (buff) { s.sim.applyAura(s.sim.units.get(s.other.id === 3 ? 2 : 3)!, s.other, buff); s.sim.drainEvents(); }
        return runWith(s, id, to, aim);
      };
      const up = run(DECK1, FAR[id] ?? DECK2);
      assert.ok(up.r.ok, `${id} on the deck: ${JSON.stringify(up.r)}`);
      assert.ok(up.cast, `${id} went off on the deck`);
      if (hitsTarget(id)) assert.ok(up.hit, `${id} reached its target on the deck`);
      for (const [name, from, to] of [['from above', DECK1, BELOW], ['from below', GROUND1, { ...DECK1, x: -3.5 }]] as const) {
        const r = run(from, to, to);
        assert.equal(r.hit, false, `${id} ${name}: nothing gets through the floor`);
        assert.equal(r.cast && ABILITIES[id].target !== 'aoe_enemy' && ABILITIES[id].target !== 'aoe_all', false, `${id} ${name}: not even cast at a target behind the floor`);
      }
      // both below the deck is just the ground
      const low = run(GROUND1, FAR[id] ? { ...FAR[id], lv: 0 } : GROUND2);
      assert.ok(low.r.ok && low.cast, `${id} below the deck: ${JSON.stringify(low.r)}`);
      if (hitsTarget(id)) assert.ok(low.hit, `${id} reached its target below the deck`);
    });
  }
});

describe('ramps', () => {
  // overlook: the ramp at z 5..13 rises towards the deck (3.2 high at z = 5); its foot is at z = 13
  const FOOT: Spot = { x: 0, z: 15, lv: 0 };
  const LOW_RAMP: Spot = { x: 0, z: 12, lv: 1 }; // 0.4 up
  const HIGH_RAMP: Spot = { x: 0, z: 7, lv: 1 }; // 2.0 up
  const UNDER_RAMP_TOP: Spot = { x: 0, z: 3, lv: 0 }; // on the ground under the deck's end

  for (const id of ['frostbolt', 'smite', 'counterspell', 'mortal_strike', 'kick']) {
    it(`${id}: from the foot of a ramp onto its low part, and from the ramp onto the deck`, () => {
      const ranged = ABILITIES[id].range > 5;
      const run = (from: Spot, to: Spot) => runWith(setup(id, from, to), id, to);
      const a = run(FOOT, LOW_RAMP);
      assert.ok(a.r.ok && a.hit, `${id} foot -> low ramp: ${JSON.stringify(a.r)}`);
      const b = run(LOW_RAMP, FOOT);
      assert.ok(b.r.ok && b.hit, `${id} low ramp -> foot: ${JSON.stringify(b.r)}`);
      if (ranged) {
        const c = run(HIGH_RAMP, { x: 0, z: 0, lv: 1 });
        assert.ok(c.r.ok && c.hit, `${id} ramp -> deck: ${JSON.stringify(c.r)}`);
        const d = run(FOOT, { x: 0, z: 0, lv: 1 });
        assert.ok(d.r.ok && d.hit, `${id} foot -> deck is a clear diagonal up the ramp: ${JSON.stringify(d.r)}`);
      }
    });

    it(`${id}: nothing under the ramp or the deck end reaches the ramp above (the ramp is solid)`, () => {
      const run = (from: Spot, to: Spot) => runWith(setup(id, from, to), id, to);
      const a = run(UNDER_RAMP_TOP, HIGH_RAMP);
      assert.equal(a.hit, false, `${id} from under the deck onto the ramp`);
      const b = run(HIGH_RAMP, UNDER_RAMP_TOP);
      assert.equal(b.hit, false, `${id} from the ramp onto the ground under the deck`);
    });
  }

  it('the sight line is the same both ways round', () => {
    for (const [a, b] of [[FOOT, LOW_RAMP], [FOOT, HIGH_RAMP], [UNDER_RAMP_TOP, HIGH_RAMP], [DECK1, BELOW], [GROUND1, GROUND2]] as const) {
      assert.equal(
        hasLOS({ x: a.x, z: a.z }, { x: b.x, z: b.z }, ARENA, a.lv, b.lv),
        hasLOS({ x: b.x, z: b.z }, { x: a.x, z: a.z }, ARENA, b.lv, a.lv),
        `${JSON.stringify(a)} <-> ${JSON.stringify(b)}`,
      );
    }
    assert.ok(heightAt(ARENA, 0, 12, 1) < heightAt(ARENA, 0, 7, 1));
  });
});
