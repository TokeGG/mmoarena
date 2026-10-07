import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, ArenaSim, TUNING, describeAbility } from '../src/index';
import type { ClassId } from '../src/index';

const TICK = TUNING.tickMs;

describe('tooltips match the sim', () => {
  it('there is no random damage variance', () => assert.equal(TUNING.damageVariance, 0));

  it('the damage a direct-damage ability lists is the damage it deals', () => {
    const bad: string[] = [];
    let checked = 0;
    for (const def of Object.values(ABILITIES)) {
      const eff = def.effects.find((e) => e.type === 'damage');
      if (!eff || def.channel || def.cpScale || def.behindMult || def.requiresStealth || def.maxTargetHealthPct !== undefined
        || def.requiresTargetCasting || def.requiresTargetAura || def.consumes || def.exploit || def.target === 'ground' || def.cpSpend) continue;
      const sim = new ArenaSim({ seed: 3, prepMs: 0 });
      const me = sim.addUnit({ name: 'me', classId: def.class as ClassId, team: 0 });
      const foe = sim.addUnit({ name: 'foe', classId: 'warrior', team: 1 });
      me.pos = { x: 0, z: 0 }; foe.pos = { x: 0, z: 2 };
      foe.maxHealth = foe.health = 1e7;
      me.bar = [def.id, ...me.bar.filter((x) => x !== def.id)];
      sim.step();
      me.resource = me.resourceMax; me.facing = 0; me.lastInput = { ...me.lastInput, facing: 0 };
      const r = sim.useAbility(me.id, def.id, def.target === 'self' || def.target === 'aoe_enemy' ? me.id : foe.id);
      if (!r.ok) continue;
      let dealt = 0;
      for (let t = 0; t < def.castTime + 2 * TICK; t += TICK) {
        sim.step();
        for (const e of sim.drainEvents()) if (e.t === 'damage' && e.tgt === foe.id && e.ability === def.id) dealt += e.amount;
      }
      const listed = Number(/(?:[Dd]eals|dealing) (\d+)/.exec(describeAbility(def, me.mods).lines.find((l) => /damage/.test(l)) ?? '')?.[1]);
      checked++;
      if (!(dealt > 0)) continue; // missed or conditional on something not set up here
      if (Math.abs(dealt - listed) > 1) bad.push(`${def.id}: tooltip ${listed}, dealt ${dealt}`);
    }
    assert.ok(checked > 15, `only checked ${checked}`);
    assert.deepEqual(bad, []);
  });
});
