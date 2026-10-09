import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArenaSim, Bot, ReplayRecorder, ReplayRunner, TUNING, botBuild } from '../src/index';
import type { Build, ClassId, SimEvent, Unit } from '../src/index';

const TICK = TUNING.tickMs;
function advance(sim: ArenaSim, ms: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let t = 0; t < ms; t += TICK) {
    sim.step();
    out.push(...sim.drainEvents());
  }
  return out;
}
function mageBuild(spec: string, talents: string[]): Build {
  return { spec, talents, gear: {} };
}
function setup(seed = 1, talents = ['', '', '', '', ''], spec = 'fire') {
  const sim = new ArenaSim({ seed, prepMs: 0 });
  const build = mageBuild(spec, talents);
  const mage = sim.addUnit({ name: 'Mira', classId: 'mage', team: 0, build });
  const foe = sim.addUnit({ name: 'Foe', classId: 'warrior', team: 1, build: { spec: 'arms', talents: ['', '', '', '', ''], gear: {} } });
  mage.pos = { x: 0, z: 0 };
  foe.pos = { x: 0, z: 12 };
  foe.maxHealth = foe.health = 1e6;
  advance(sim, TICK);
  return { sim, mage, foe, build };
}
const images = (sim: ArenaSim) => [...sim.units.values()].filter((u) => u.image);
/** Mirror Image sits on the mage bar only through a tier five pick; put it on the bar directly. */
function cast(sim: ArenaSim, mage: Unit) {
  mage.bar = [...mage.bar.slice(0, 7), 'mirror_image'];
  mage.cooldowns = {};
  const r = sim.useAbility(mage.id, 'mirror_image');
  assert.ok(r.ok, (r as { reason?: string }).reason);
}

describe('Mirror Image', () => {
  it('enemies that were targeting the caster lose their target and their cast', () => {
    const { sim, mage, foe } = setup();
    foe.target = mage.id;
    foe.autoAttack = true;
    sim.useAbility(foe.id, 'mortal_strike', mage.id);
    cast(sim, mage);
    assert.equal(foe.target, null);
    assert.equal(foe.autoAttack, false);
  });

  it('summons two images with the caster\'s class, spec, talents, name and look, on its team', () => {
    const talents = ['mage_fire_t1a', '', 'mage_fire_t3b', '', ''];
    const { sim, mage } = setup(1, talents);
    cast(sim, mage);
    const imgs = images(sim);
    assert.equal(imgs.length, 2);
    for (const i of imgs) {
      assert.equal(i.classId, 'mage');
      assert.equal(i.spec, mage.spec);
      assert.deepEqual(i.talents, mage.talents);
      assert.equal(i.team, mage.team);
      assert.equal(i.name, mage.name);
      assert.equal(i.look, mage.look);
      assert.equal(i.maxHealth, 1);
      assert.equal(i.health, 1);
      assert.equal(i.image!.owner, mage.id);
      assert.equal(i.image!.dmg, 0.2);
    }
    assert.equal(sim.snapshot().units.filter((u) => u.img === mage.id).length, 2);
  });

  it('an image dies to any hit, even a tiny one, and is gone a moment later', () => {
    const { sim, mage, foe } = setup();
    cast(sim, mage);
    const [a, b] = images(sim);
    sim.dealDamage(foe, a, 0.2, 'physical', 'mortal_strike');
    assert.equal(a.alive, false);
    assert.equal(b.alive, true);
    advance(sim, 1000);
    assert.ok(!sim.units.has(a.id), 'removed after it fell');
    assert.ok(sim.units.has(b.id));
  });

  it('images deal 80% less damage than the same hit from the caster', () => {
    const { sim, mage, foe } = setup();
    cast(sim, mage);
    const [a] = images(sim);
    const base = foe.health;
    const real = sim.dealDamage(mage, foe, 1000, 'fire', 'fireball');
    const copy = sim.dealDamage(a, foe, 1000, 'fire', 'fireball');
    assert.equal(base - foe.health, real + copy);
    assert.ok(Math.abs(copy - real * 0.2) <= 2, `${copy} vs ${real}`);
  });

  it('images move up and cast on the enemy, and despawn when the 8 seconds are over', () => {
    const { sim, mage, foe } = setup();
    mage.target = foe.id;
    cast(sim, mage);
    const hp = foe.health;
    const ev = advance(sim, 3000);
    assert.ok(ev.some((e) => e.t === 'damage' && sim.units.get(e.src)?.image && e.tgt === foe.id), 'an image hurt the foe');
    assert.ok(foe.health < hp);
    advance(sim, 6000);
    assert.equal(images(sim).length, 0, 'despawned after the duration');
  });

  it('images go when the caster dies, and a new cast replaces the old pair', () => {
    const { sim, mage } = setup();
    cast(sim, mage);
    const first = images(sim).map((i) => i.id);
    mage.cooldowns = {};
    cast(sim, mage);
    advance(sim, 1000);
    assert.equal(images(sim).length, 2);
    assert.ok(images(sim).every((i) => !first.includes(i.id)));
    mage.cooldowns['cauterize'] = 1e12;
    sim.dealDamage(null, mage, 1e6, 'physical', null);
    advance(sim, 100);
    assert.ok(images(sim).every((i) => !i.alive));
  });

  it('images never decide the match: killing the real units ends it', () => {
    const { sim, mage, foe } = setup();
    cast(sim, mage);
    sim.dealDamage(null, foe, 1e9, 'physical', null);
    advance(sim, 200);
    assert.equal(sim.winner, 0, 'the real mage still stands');
    const s2 = setup(2);
    cast(s2.sim, s2.mage);
    s2.mage.cooldowns['cauterize'] = 1e12;
    s2.sim.dealDamage(null, s2.mage, 1e9, 'physical', null);
    advance(s2.sim, 200);
    assert.equal(s2.sim.winner, 1, 'images alive do not keep the mage team in the fight');
  });

  it('a Cauterize mage\'s images do not cauterize', () => {
    const { sim, mage } = setup();
    cast(sim, mage);
    const [a] = images(sim);
    a.cooldowns = {};
    sim.dealDamage(null, a, 5, 'fire', 'fireball');
    assert.equal(a.alive, false);
  });

  it('a replay with images plays out identically and does not add them as units', () => {
    const sim = new ArenaSim({ seed: 5, prepMs: 0 });
    const rec = new ReplayRecorder(sim, { arena: sim.arena.id, seed: 5, prepMs: 0 });
    const mb = botBuild('mage', 1, true, 'fire');
    mb.talents[4] = 'mage_t5a';
    mb.replace = { mage_t5a: 'polymorph' };
    const m = sim.addUnit({ name: 'Mira', classId: 'mage', team: 0, controller: 'bot', build: mb });
    const w = sim.addUnit({ name: 'Foe', classId: 'warrior', team: 1, controller: 'bot', build: botBuild('warrior', 2, true, 'arms') });
    const bots = [new Bot(sim, m.id, 'hard', 11), new Bot(sim, w.id, 'hard', 12)];
    let casted = false;
    for (let i = 0; i < 400; i++) {
      for (const b of bots) b.tick();
      if (!casted && i === 40) {
        m.cooldowns = {};
        casted = sim.useAbility(m.id, 'mirror_image').ok;
      }
      sim.step();
      sim.drainEvents();
    }
    assert.ok(casted);
    const data = rec.finish([]);
    assert.equal(data.units.length, 2, 'images are not recorded as units');
    const run = new ReplayRunner(data);
    while (!run.done) run.step();
    const key = (x: ArenaSim) => JSON.stringify(x.snapshot().units.map((u) => [u.id, u.x, u.z, u.health, u.alive]));
    assert.equal(key(run.sim), key(sim));
  });
});

describe('class coverage', () => {
  it('images of every class fight a dummy for their time without trouble', () => {
    for (const [classId, spec] of [['warrior', 'arms'], ['warrior', 'fury'], ['mage', 'frost'], ['mage', 'arcane'], ['priest', 'shadow'], ['priest', 'holy'], ['rogue', 'assassination'], ['rogue', 'subtlety']] as [ClassId, string][]) {
      const sim = new ArenaSim({ seed: 3, prepMs: 0 });
      const u = sim.addUnit({ name: 'X', classId, team: 0, build: botBuild(classId, 4, true, spec) });
      const d = sim.addUnit({ name: 'D', classId: 'warrior', team: 1, controller: 'dummy' });
      d.maxHealth = d.health = 1e9;
      u.pos = { x: 0, z: 0 };
      d.pos = { x: 0, z: 10 };
      advance(sim, TICK);
      (sim as unknown as { summonImages(u: Unit, n: number, ms: number, dmg: number): void }).summonImages(u, 2, 8000, 0.2);
      u.target = d.id;
      const ev = advance(sim, 4000);
      assert.ok(ev.some((e) => e.t === 'damage' && sim.units.get(e.src)?.image), `${classId} ${spec} images did damage`);
    }
  });
});
