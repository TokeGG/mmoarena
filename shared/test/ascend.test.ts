import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArenaSim, AURAS, TUNING, hoverHeight } from '../src/index';
import type { SimEvent, Unit } from '../src/index';

const TICK = TUNING.tickMs;
const live = () => new ArenaSim({ seed: 1, prepMs: 0 });
function advance(sim: ArenaSim, ms: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let t = 0; t < ms; t += TICK) {
    sim.step();
    out.push(...sim.drainEvents());
  }
  return out;
}
const priest = (sim: ArenaSim, team: 0 | 1, x: number, z: number): Unit => {
  const u = sim.addUnit({ name: `p${team}`, classId: 'priest', team, build: { spec: 'holy', talents: [], gear: {} } }); // Lightbearer has Ascend on its bar
  u.pos = { x, z };
  return u;
};
const yOf = (sim: ArenaSim, u: Unit) => sim.snapshot().units.find((s) => s.id === u.id)!.y;

const H = AURAS['ascended'].hover!.height;
const D = AURAS['ascended'].duration!;

describe('Ascend to the Heavens', () => {
  it('rises straight up to its hover height, hovers, and is back on the ground when it ends', () => {
    const sim = live();
    const p = priest(sim, 0, 0, 0);
    priest(sim, 1, 40, 0);
    advance(sim, TICK);
    const x = p.pos.x, z = p.pos.z;
    assert.ok(sim.useAbility(p.id, 'ascend').ok);
    let peak = 0, prev = 0, midAt = 0;
    for (let t = TICK; t < D; t += TICK) {
      sim.step();
      sim.drainEvents();
      const y = yOf(sim, p);
      if (t <= 600) assert.ok(y >= prev - 1e-9, 'rising');
      if (t >= 2000 && !midAt) midAt = y;
      peak = Math.max(peak, y);
      prev = y;
      assert.equal(p.pos.x, x);
      assert.equal(p.pos.z, z);
    }
    assert.ok(peak >= H - 0.1 && peak <= H + 0.01, `peak ${peak}`);
    assert.ok(midAt >= H - 0.1, 'hovering mid way');
    advance(sim, 200);
    assert.equal(yOf(sim, p), 0, 'back down');
    assert.ok(!p.auras.some((a) => a.id === 'ascended'));
  });

  it('the height curve rises over 0.6 s, holds, and falls over 0.6 s', () => {
    const h = AURAS['ascended'].hover!;
    assert.equal(hoverHeight(h, 0, D), 0);
    assert.ok(Math.abs(hoverHeight(h, 300, D) - H / 2) < 1e-9);
    assert.equal(hoverHeight(h, 600, D), H);
    assert.equal(hoverHeight(h, 2000, D), H);
    assert.ok(Math.abs(hoverHeight(h, D - 300, D) - H / 2) < 1e-9);
    assert.equal(hoverHeight(h, D, D), 0);
  });

  it('no movement or jumping is accepted while ascended', () => {
    const sim = live();
    const p = priest(sim, 0, 0, 0);
    priest(sim, 1, 40, 0);
    advance(sim, TICK);
    assert.ok(sim.useAbility(p.id, 'ascend').ok);
    const x = p.pos.x, z = p.pos.z;
    for (let i = 1; i < 60; i++) {
      sim.queueInput(p.id, { seq: i, fwd: 1, strafe: 0.5, facing: 1, jump: i % 10 === 0 });
      sim.step();
    }
    assert.equal(p.pos.x, x);
    assert.equal(p.pos.z, z);
    assert.ok(sim.snapshot().units.find((s) => s.id === p.id)!.y >= H - 0.1, 'no jump on top of the hover');
    advance(sim, D);
    sim.queueInput(p.id, { seq: 100, fwd: 1, strafe: 0, facing: 0 });
    advance(sim, 300);
    assert.ok(Math.hypot(p.pos.x - x, p.pos.z - z) > 0.5, 'free to move again afterwards');
  });

  it('can still be targeted in the air, takes no damage, and can cast spells while it hovers', () => {
    const sim = live();
    const p = priest(sim, 0, 0, 0);
    const f = priest(sim, 1, 3, 0);
    advance(sim, TICK);
    f.target = p.id;
    assert.ok(sim.useAbility(p.id, 'ascend').ok);
    assert.equal(f.target, p.id, 'the enemy keeps its target on you');
    advance(sim, 1000);
    const hp = p.health;
    sim.dealDamage(f, p, 500, 'physical', 'mortal_strike');
    assert.equal(p.health, hp, 'nothing hurts you up there');
    assert.equal(sim.canSee(f, p), true, 'but you can be seen and targeted');
    assert.ok(sim.useAbility(p.id, 'smite', f.id).ok, 'and you can cast');
    const fhp = f.health;
    advance(sim, 2000);
    assert.ok(f.health < fhp, 'the spell landed from the air');
  });
});

describe('what cannot reach up to a hovering unit', () => {
  it('a damage zone on the ground does not hurt someone hovering above it', () => {
    const sim = live();
    const p = priest(sim, 0, 0, 0);
    const m = sim.addUnit({ name: 'm', classId: 'mage', team: 1 });
    m.pos = { x: 0, z: 12 };
    advance(sim, TICK);
    // a zone on top of the priest, then the priest rises
    (sim as unknown as { zones: unknown[] }).zones.push({ id: 1, ability: 'flamestrike', owner: m.id, team: 1, x: 0, z: 0, r: 5, amount: 100, school: 'fire', pulse: 500, nextAt: sim.time + 100, end: sim.time + 3000, level: 0 });
    assert.ok(sim.useAbility(p.id, 'ascend').ok);
    advance(sim, 1500);
    p.auras = p.auras.filter((a) => a.id !== 'ascended'); // never mind the shield: only the height keeps the zone off
    const hp = p.health;
    (sim as unknown as { hoverOf: (u: unknown) => number }).hoverOf = () => 8;
    advance(sim, 800);
    assert.equal(p.health, hp, 'the zone did not reach it up there');
  });
});
