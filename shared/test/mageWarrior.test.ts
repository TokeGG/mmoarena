import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, AURAS, ArenaSim, TUNING, arenaById, dist, resolveCollisions, talentsFor } from '../src/index';
import type { ClassId, SimEvent, TeamId, Unit } from '../src/index';

const TICK = TUNING.tickMs;
function advance(sim: ArenaSim, ms: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let t = 0; t < ms; t += TICK) {
    sim.step();
    out.push(...sim.drainEvents());
  }
  return out;
}
function add(sim: ArenaSim, classId: ClassId, team: TeamId, x: number, z: number, spec?: string): Unit {
  const u = sim.addUnit({ name: `${classId}${team}`, classId, team, ...(spec ? { build: { spec, talents: ['', '', '', '', ''], gear: {} } } : {}) });
  u.pos = { x, z };
  return u;
}
function ready(u: Unit) {
  u.cooldowns = {}; u.gcdEnd = 0; u.resource = u.resourceMax;
}
const stacks = (u: Unit, id: string) => u.auras.find((a) => a.id === id)?.stacks ?? 0;

describe('Mirror Image formation', () => {
  const images = (sim: ArenaSim) => [...sim.units.values()].filter((u) => u.image);
  function summon(sim: ArenaSim, mage: Unit) {
    mage.bar = [...mage.bar.slice(0, 7), 'mirror_image'];
    ready(mage);
    assert.ok(sim.useAbility(mage.id, 'mirror_image').ok);
  }
  it('the caster and the two images make a triangle a couple of yards across, with nobody on top of anybody', () => {
    const sim = new ArenaSim({ seed: 3, prepMs: 0 });
    const mage = add(sim, 'mage', 0, 0, 0, 'fire');
    mage.facing = 0;
    mage.lastInput = { ...mage.lastInput, facing: 0 };
    const foe = add(sim, 'warrior', 1, 0, 14);
    foe.maxHealth = foe.health = 1e6;
    advance(sim, TICK);
    summon(sim, mage);
    const [a, b] = images(sim);
    assert.ok(a && b);
    for (const [p, q] of [[a.pos, b.pos], [a.pos, mage.pos], [b.pos, mage.pos]]) {
      const d = dist(p, q);
      assert.ok(d > 2 && d < 3, `corner distance ${d}`);
    }
    // behind the mage (who faces +z), one to each side
    assert.ok(a.pos.z < mage.pos.z && b.pos.z < mage.pos.z);
    assert.ok(a.pos.x * b.pos.x < 0, 'on either side');
  });
  it('keeps the images out of walls: even against the arena edge they stand on clear ground, apart from each other and the caster', () => {
    for (const arenaId of ['colosseum', 'ruins', 'frost', 'serpent', 'forge', 'cinder']) {
      const b = arenaById(arenaId).bounds;
      for (const f of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const sim = new ArenaSim({ seed: 5, prepMs: 0, arena: arenaById(arenaId) });
        const mage = add(sim, 'mage', 0, b.minX + 0.8, b.maxZ - 0.8, 'fire');
        mage.pos = resolveCollisions(mage.pos, sim.arena, 0);
        mage.facing = f;
        mage.lastInput = { ...mage.lastInput, facing: f };
        const foe = add(sim, 'warrior', 1, 0, 0);
        foe.maxHealth = foe.health = 1e6;
        advance(sim, TICK);
        summon(sim, mage);
        const imgs = images(sim);
        assert.equal(imgs.length, 2);
        for (const i of imgs) {
          const fixed = resolveCollisions(i.pos, sim.arena, i.level);
          assert.ok(dist(fixed, i.pos) < 0.05, `${arenaId} facing ${f}: image inside a wall`);
          assert.ok(dist(i.pos, mage.pos) > 1, `${arenaId}: overlaps the caster`);
        }
        assert.ok(dist(imgs[0].pos, imgs[1].pos) > 1, `${arenaId}: images overlap`);
      }
    }
  });
  it('is deterministic: the same cast twice puts the images in the same places', () => {
    const run = () => {
      const sim = new ArenaSim({ seed: 8, prepMs: 0 });
      const mage = add(sim, 'mage', 0, 3, -4, 'fire');
      mage.facing = 0.7;
      mage.lastInput = { ...mage.lastInput, facing: 0.7 };
      const foe = add(sim, 'warrior', 1, 0, 14);
      foe.maxHealth = foe.health = 1e6;
      advance(sim, TICK);
      summon(sim, mage);
      return images(sim).map((i) => [i.pos.x, i.pos.z]);
    };
    assert.deepEqual(run(), run());
  });
});

describe('Starweaving', () => {
  function arcane() {
    const sim = new ArenaSim({ seed: 2, prepMs: 0 });
    const mage = add(sim, 'mage', 0, 0, 0, 'arcane');
    const foe = add(sim, 'warrior', 1, 0, 10);
    foe.maxHealth = foe.health = 1e9;
    advance(sim, TICK);
    return { sim, mage, foe };
  }
  const giveCharges = (sim: ArenaSim, mage: Unit, n: number) => {
    mage.auras = mage.auras.filter((a) => a.id !== 'arcane_charge');
    for (let i = 0; i < n; i++) sim.applyAura(mage, mage, 'arcane_charge');
    assert.equal(stacks(mage, 'arcane_charge'), n);
  };
  it('Arcane Blast hits 5% harder for each Arcane Charge', () => {
    assert.equal(ABILITIES.arcane_blast.scalesWith?.perStack, 0.05);
    const hit = (n: number) => {
      const { sim, mage, foe } = arcane();
      // damage variance is random per hit, so average a few hits
      let sum = 0;
      const N = 30;
      for (let i = 0; i < N; i++) {
        giveCharges(sim, mage, n);
        ready(mage);
        mage.pos = { x: 0, z: 0 };
        mage.facing = 0;
        const hp = foe.health;
        assert.ok(sim.useAbility(mage.id, 'arcane_blast', foe.id).ok);
        advance(sim, 2000);
        sum += hp - foe.health;
      }
      return sum / N;
    };
    const r0 = hit(0);
    const r4 = hit(4);
    assert.ok(r4 / r0 > 1.12 && r4 / r0 < 1.28, `4 charges: x${(r4 / r0).toFixed(3)} (expect 1.20)`);
  });
  it('Arcane Missiles uses up every Arcane Charge and fires one more missile for each', () => {
    for (const n of [0, 2, 5]) {
      const { sim, mage, foe } = arcane();
      giveCharges(sim, mage, n);
      ready(mage);
      assert.ok(sim.useAbility(mage.id, 'arcane_missiles', foe.id).ok);
      assert.equal(mage.cast?.ticks, ABILITIES.arcane_missiles.channel!.ticks + n, `${n} charges`);
      assert.equal(stacks(mage, 'arcane_charge'), 0, 'all charges consumed on the initial cast');
      const evs = advance(sim, 6000);
      const hits = evs.filter((e) => e.t === 'damage' && e.src === mage.id && e.ability === 'arcane_missiles').length;
      assert.equal(hits, ABILITIES.arcane_missiles.channel!.ticks + n, `${n} charges: missiles that landed`);
    }
  });
});

describe('Pyromancy', () => {
  function fire() {
    const sim = new ArenaSim({ seed: 4, prepMs: 0 });
    const mage = add(sim, 'mage', 0, 0, 0, 'fire');
    mage.bar = [...mage.bar.slice(0, 6), 'scorch', 'fireball'];
    const foe = add(sim, 'warrior', 1, 0, 10);
    foe.maxHealth = foe.health = 1e9;
    advance(sim, TICK);
    const cast = (id: string) => {
      ready(mage);
      mage.auras = mage.auras.filter((a) => a.id !== 'hot_streak');
      assert.ok(sim.useAbility(mage.id, id, foe.id).ok, id);
      advance(sim, 2300);
    };
    return { sim, mage, foe, cast };
  }
  const max = AURAS.singed.maxStacks!;
  it('Scorch gives 1 Singed stack and Fireball gives 2', () => {
    const a = fire();
    a.cast('scorch');
    assert.equal(stacks(a.foe, 'singed'), 1);
    const b = fire();
    b.cast('fireball');
    assert.equal(stacks(b.foe, 'singed'), 2);
  });
  it('the hit that takes Singed past its last stack removes it and gives Hot Streak, counting every stack a hit adds', () => {
    const { mage, foe, sim } = fire();
    while (stacks(foe, 'singed') + 2 <= max) sim.applyAura(mage, foe, 'singed', 0, undefined, 2);
    assert.ok(stacks(foe, 'singed') + 2 > max);
    assert.ok(!mage.auras.some((a) => a.id === 'hot_streak'));
    sim.applyAura(mage, foe, 'singed', 0, undefined, 2);
    assert.equal(stacks(foe, 'singed'), 0, 'all stacks removed');
    assert.ok(mage.auras.some((a) => a.id === 'hot_streak'), 'Hot Streak on the caster');
  });
  it("Fireball has a 10% chance of Hot Streak on its own; Dragon's Breath has none", () => {
    const e = ABILITIES.fireball.effects.find((x) => x.type === 'aura' && x.aura === 'hot_streak');
    assert.ok(e && e.type === 'aura' && e.chance === 0.1 && e.self);
    assert.ok(!ABILITIES.dragons_breath.effects.some((x) => x.type === 'aura' && x.aura === 'hot_streak'));
    // statistically, with Singed cleared each time so it never pops
    const { mage, foe, sim } = fire();
    let procs = 0;
    const N = 300;
    for (let i = 0; i < N; i++) {
      foe.auras = [];
      ready(mage);
      mage.auras = mage.auras.filter((a) => a.id !== 'hot_streak');
      mage.pos = { x: 0, z: 0 };
      mage.facing = 0;
      if (!sim.useAbility(mage.id, 'fireball', foe.id).ok) { advance(sim, 100); continue; }
      advance(sim, 2000);
      if (mage.auras.some((a) => a.id === 'hot_streak')) procs++;
    }
    assert.ok(procs >= 12 && procs <= 55, `Fireball Hot Streak ${procs}/${N} (10%)`);
  });
  it('the Streaking talent text does not claim a fixed number of seconds', () => {
    const t = talentsFor('mage', 'fire').flat().find((x) => x.id === 'mage_fire_t3b');
    assert.ok(t);
    assert.doesNotMatch(t.desc, /\d+ seconds/);
    assert.equal(t.mods.auraDuration?.singed, 1.5);
  });
});

describe('Warbringer', () => {
  it('Slam generates 15 rage', () => {
    const sim = new ArenaSim({ seed: 6, prepMs: 0 });
    const w = add(sim, 'warrior', 0, 0, 0, 'arms');
    const f = add(sim, 'warrior', 1, 0, 2);
    f.maxHealth = f.health = 1e9;
    advance(sim, TICK);
    w.resource = 0;
    w.cooldowns = {};
    w.gcdEnd = 0;
    assert.equal(ABILITIES.slam.cost, 0);
    const hp = f.health;
    assert.ok(sim.useAbility(w.id, 'slam', f.id).ok);
    // the 15 from Slam, plus the rage every hit earns from the damage it deals
    const fromHit = (hp - f.health) * TUNING.rageFromDealt;
    assert.ok(Math.abs(w.resource - (15 + fromHit)) < 1, `rage ${w.resource} (hit gave ${fromHit})`);
  });
  it('Slice and Dice hits the 90 degree cone in front like Sweep, not the whole circle', () => {
    assert.equal(ABILITIES.slice_and_dice.coneDeg, ABILITIES.sweep.coneDeg);
    assert.equal(ABILITIES.slice_and_dice.coneDeg, 90);
    const sim = new ArenaSim({ seed: 6, prepMs: 0 });
    const w = add(sim, 'warrior', 0, 0, 0, 'arms');
    const front = add(sim, 'warrior', 1, 0, 3);
    const side = add(sim, 'warrior', 1, 3, 0.2); // 90 degrees off: out
    const behind = add(sim, 'warrior', 1, 0, -3);
    for (const e of [front, side, behind]) e.maxHealth = e.health = 1e9;
    advance(sim, TICK);
    w.facing = 0;
    w.lastInput = { ...w.lastInput, facing: 0 };
    w.resource = 100;
    assert.ok(sim.useAbility(w.id, 'slice_and_dice', front.id).ok);
    advance(sim, 600);
    assert.ok(front.health < 1e9, 'in front: hit');
    assert.equal(side.health, 1e9, 'to the side: untouched');
    assert.equal(behind.health, 1e9, 'behind: untouched');
  });
});
