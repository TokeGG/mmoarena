import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArenaSim, TUNING } from '../src/index';
import type { TeamId } from '../src/index';

function world() {
  const sim = new ArenaSim({ seed: 3, prepMs: 0, tickMs: 16 });
  const priest = sim.addUnit({ name: 'p', classId: 'priest', team: 0 as TeamId, controller: 'dummy', build: { spec: 'holy', talents: [], gear: {} } });
  const mage = sim.addUnit({ name: 'm', classId: 'mage', team: 1 as TeamId, controller: 'dummy', build: { spec: 'frost', talents: [], gear: {} } });
  const rogue = sim.addUnit({ name: 'r', classId: 'rogue', team: 1 as TeamId, controller: 'dummy' });
  priest.pos = { x: 0, z: 0 }; mage.pos = { x: 0, z: 3 }; rogue.pos = { x: 40, z: 40 };
  for (const u of [priest, mage, rogue]) u.maxHealth = u.health = 1e6;
  sim.step();
  return { sim, priest, mage, rogue };
}
const run = (sim: ArenaSim, ms: number) => { for (let t = 0; t < ms; t += 16) sim.step(); };

describe('priest fixes', () => {
  it('a plain fear stumbles slowly, Fleeing Scream\'s fear runs at full speed', () => {
    const slow = world();
    slow.sim.applyAura(slow.priest, slow.mage, 'psychic_scream');
    const a0 = { ...slow.mage.pos };
    run(slow.sim, 1000);
    const walked = Math.hypot(slow.mage.pos.x - a0.x, slow.mage.pos.z - a0.z);
    const fast = world();
    fast.sim.applyAura(fast.priest, fast.mage, 'psychic_flee');
    const b0 = { ...fast.mage.pos };
    run(fast.sim, 1000);
    const ran = Math.hypot(fast.mage.pos.x - b0.x, fast.mage.pos.z - b0.z);
    assert.ok(ran > walked * 1.8, `fled ${ran.toFixed(1)} yd against ${walked.toFixed(1)}`);
    assert.ok(ran > TUNING.runSpeed * 0.8, 'about a full run');
  });
  it('Purifying Light keeps allies in its circle from being interrupted', () => {
    const w = world();
    const ally = w.sim.addUnit({ name: 'a', classId: 'mage', team: 0 as TeamId, controller: 'dummy' });
    ally.pos = { x: 3, z: 0 }; ally.maxHealth = ally.health = 1e6;
    w.priest.resource = 1e6;
    w.priest.bar = [...w.priest.bar.slice(0, 7), 'purifying_light'];
    w.sim.step();
    assert.ok(w.sim.useAbility(w.priest.id, 'purifying_light').ok);
    run(w.sim, 100);
    assert.ok(ally.auras.some((a) => a.id === 'purified') && w.priest.auras.some((a) => a.id === 'purified'), 'caster and ally are covered');
    // the ally starts a long cast and the enemy mage kicks it
    ally.bar = [...ally.bar.slice(0, 7), 'counterspell'];
    w.mage.bar = [...w.mage.bar.slice(0, 7), 'counterspell'];
    w.mage.pos = { x: 3, z: 6 };
    w.sim.step();
    assert.ok(w.sim.useAbility(ally.id, 'pyroblast', w.mage.id).ok || w.sim.useAbility(ally.id, 'fireball', w.mage.id).ok);
    run(w.sim, 100);
    assert.ok(ally.cast, 'casting');
    w.mage.resource = 1e6;
    w.sim.useAbility(w.mage.id, 'counterspell', ally.id);
    run(w.sim, 50);
    assert.ok(ally.cast, 'the cast was not interrupted');
    assert.ok((ally.lockouts.fire ?? 0) <= w.sim.time && (ally.lockouts.frost ?? 0) <= w.sim.time, 'and nothing was locked out');
  });
});
