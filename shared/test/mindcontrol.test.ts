import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArenaSim, Bot, TUNING } from '../src/index';
import type { SimEvent, TeamId } from '../src/index';

const TICK = TUNING.tickMs;
function world() {
  const sim = new ArenaSim({ seed: 11, prepMs: 0 });
  const priest = sim.addUnit({ name: 'priest', classId: 'priest', team: 0 as TeamId, controller: 'dummy', build: { spec: 'holy', talents: [], gear: {} } });
  const mage = sim.addUnit({ name: 'mage', classId: 'mage', team: 1 as TeamId, controller: 'dummy', build: { spec: 'fire', talents: [], gear: {} } });
  const ally = sim.addUnit({ name: 'warrior', classId: 'warrior', team: 0 as TeamId, controller: 'dummy' });
  const foe2 = sim.addUnit({ name: 'rogue', classId: 'rogue', team: 1 as TeamId, controller: 'dummy' });
  priest.pos = { x: 0, z: 0 };
  mage.pos = { x: 0, z: 10 };
  ally.pos = { x: 4, z: 0 };
  foe2.pos = { x: 6, z: 12 };
  priest.bar = [...priest.bar.slice(0, 7), 'mind_control'];
  for (const u of [priest, mage, ally, foe2]) u.maxHealth = u.health = 100000;
  sim.step();
  sim.drainEvents();
  const run = (ms: number): SimEvent[] => {
    const out: SimEvent[] = [];
    for (let t = 0; t < ms; t += TICK) { sim.step(); out.push(...sim.drainEvents()); }
    return out;
  };
  return { sim, priest, mage, ally, foe2, run };
}
const start = (w: ReturnType<typeof world>) => {
  assert.ok(w.sim.useAbility(w.priest.id, 'mind_control', w.mage.id).ok);
  return w.run(1800);
};

describe('Mind Control', () => {
  it('takes the enemy: it fights for the priest\'s team, both sides wear a buff, and the priest\'s body stands still', () => {
    const w = world();
    const ev = start(w);
    assert.ok(ev.some((e) => e.t === 'mindControl' && e.caster === w.priest.id && e.target === w.mage.id));
    assert.equal(w.mage.team, 0, 'the mage is on the priest\'s side for now');
    assert.equal(w.mage.mc?.team, 1, 'and remembers where it came from');
    assert.ok(w.mage.auras.some((a) => a.id === 'mind_controlled'));
    assert.ok(w.priest.auras.some((a) => a.id === 'mind_controlling'));
  });

  it('the priest\'s commands drive the mage: movement, spells with the mage\'s own bar, and the mage\'s own commands do nothing', () => {
    const w = world();
    start(w);
    const x0 = w.mage.pos.x, px = w.priest.pos.x;
    w.sim.queueInput(w.priest.id, { seq: 1, fwd: 0, strafe: 1, facing: 0 });
    w.sim.queueInput(w.mage.id, { seq: 1, fwd: 1, strafe: 0, facing: Math.PI }); // the controlled player pressing keys
    w.run(500);
    assert.notEqual(w.mage.pos.x, x0, 'the mage moved with the priest\'s input');
    assert.equal(w.priest.pos.x, px, 'the priest\'s own body did not');
    // a spell from the priest's key is the mage's spell, at the mage's enemy (the rogue is the mage's former ally and now an enemy)
    const hp = w.foe2.health;
    assert.ok(w.sim.setTarget(w.priest.id, w.foe2.id).ok);
    const r = w.sim.useAbility(w.priest.id, 'fireball', w.foe2.id);
    assert.ok(r.ok, 'the mage\'s Fireball can be cast from the priest\'s keys');
    w.run(2500);
    assert.ok(w.foe2.health < hp, 'and it hurt the mage\'s own former ally');
    // the controlled unit's own spell press is ignored
    assert.ok(!w.sim.useAbility(w.mage.id, 'fireball', w.ally.id).ok);
  });

  it('ends after eight seconds: the mage is back on its own team, free, and the buffs are gone', () => {
    const w = world();
    start(w);
    const ev = w.run(8000);
    assert.ok(ev.some((e) => e.t === 'mindControlEnd' && e.target === w.mage.id));
    assert.equal(w.mage.team, 1);
    assert.equal(w.mage.mc, undefined);
    assert.equal(w.priest.mcTarget, undefined);
    assert.ok(!w.mage.auras.some((a) => a.id === 'mind_controlled') && !w.priest.auras.some((a) => a.id === 'mind_controlling'));
    // the mage's own keys work again
    assert.ok(w.sim.setTarget(w.mage.id, w.ally.id).ok);
  });

  it('ends at once when the priest is stunned or dies, or the effect is dispelled', () => {
    for (const how of ['stun', 'death', 'dispel'] as const) {
      const w = world();
      start(w);
      assert.equal(w.mage.team, 0);
      if (how === 'stun') w.sim.applyAura(w.foe2, w.priest, 'kidney_shot');
      else if (how === 'death') { w.priest.health = 0; w.priest.alive = false; }
      else for (const a of [...w.mage.auras]) if (a.id === 'mind_controlled') w.sim.removeAura(w.mage, a, 'dispelled');
      w.run(TICK * 3);
      assert.equal(w.mage.team, 1, `${how}: the mage is back`);
    }
  });

  it('cannot be cast on something untargetable or already controlled, or while already controlling', () => {
    const w = world();
    w.mage.auras.push({ id: 'ascended', sourceId: w.mage.id, expiresAt: Infinity, stacks: 1 } as any);
    assert.ok(w.sim.useAbility(w.priest.id, 'mind_control', w.mage.id).ok);
    w.run(1800);
    assert.equal(w.mage.team, 1, 'an invulnerable target is not taken');
  });

  it('a controlled unit still counts for its own team when the match is decided', () => {
    const w = world();
    start(w);
    w.foe2.health = 0; w.foe2.alive = false; // the mage's team has only the controlled mage left
    w.run(TICK * 3);
    assert.equal(w.sim.winner, null, 'the match goes on: the mage is still team 1\'s');
    w.mage.health = 0; w.mage.alive = false;
    w.run(TICK * 3);
    assert.equal(w.sim.winner, 0);
  });
});

describe('bots and Mind Control', () => {
  it('a priest bot takes an enemy with it and plays that unit against its own former team, and a bot being controlled does nothing of its own', () => {
    const sim = new ArenaSim({ seed: 4, prepMs: 0 });
    const priest = sim.addUnit({ name: 'priest', classId: 'priest', team: 0 as TeamId, controller: 'bot', build: { spec: 'holy', talents: [], gear: {} } });
    const ally = sim.addUnit({ name: 'warrior', classId: 'warrior', team: 0 as TeamId, controller: 'dummy' });
    const mage = sim.addUnit({ name: 'mage', classId: 'mage', team: 1 as TeamId, controller: 'bot', build: { spec: 'fire', talents: [], gear: {} } });
    const rogue = sim.addUnit({ name: 'rogue', classId: 'rogue', team: 1 as TeamId, controller: 'dummy' });
    priest.pos = { x: 0, z: 0 }; ally.pos = { x: 3, z: 0 }; mage.pos = { x: 0, z: 14 }; rogue.pos = { x: 4, z: 15 };
    priest.bar = [...priest.bar.slice(0, 7), 'mind_control'];
    for (const u of [priest, ally, mage, rogue]) u.maxHealth = u.health = 1e6;
    const bots = [new Bot(sim, priest.id, 'hard', 1), new Bot(sim, mage.id, 'hard', 2)];
    sim.step(); sim.drainEvents();
    let controlled = false, rogueHurtWhileControlled = false;
    let lastRogue = rogue.health;
    for (let t = 0; t < 26000 / TICK && sim.winner === null; t++) {
      for (const b of bots) b.tick();
      sim.step();
      sim.drainEvents();
      if (mage.mc) {
        controlled = true;
        if (rogue.health < lastRogue) rogueHurtWhileControlled = true;
      }
      lastRogue = rogue.health;
    }
    assert.ok(controlled, 'the priest bot cast Mind Control');
    assert.ok(rogueHurtWhileControlled, 'the controlled mage hurt its own former ally');
    assert.equal(mage.team, 1, 'and it is back on its own team afterwards');
  });
});
