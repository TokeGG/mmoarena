import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArenaSim, ReplayRecorder, DEFAULT_BRAIN, isDefensive, measureHumans, mergeStyle, styledBrain, TUNING } from '../src/index';

function recording(strafe: number, dist: number, seconds = 20) {
  const sim = new ArenaSim({ seed: 11, prepMs: 0, facing: true });
  const rec = new ReplayRecorder(sim, { arena: 'default', seed: 11, prepMs: 0 });
  const me = sim.addUnit({ name: 'me', classId: 'mage', team: 0, controller: 'player', build: { spec: 'frost', talents: [], gear: {} } });
  const foe = sim.addUnit({ name: 'foe', classId: 'warrior', team: 1, controller: 'dummy' });
  foe.maxHealth = foe.health = 1e9;
  sim.step();
  sim.setTarget(me.id, foe.id);
  for (let i = 0; i < Math.round((seconds * 1000) / sim.tickMs); i++) {
    const d = Math.hypot(foe.pos.x - me.pos.x, foe.pos.z - me.pos.z); // walk up to `dist` yards from the dummy, then hold there
    const facing = Math.atan2(foe.pos.x - me.pos.x, foe.pos.z - me.pos.z);
    const fwd = d > dist + 0.5 ? 1 : d < dist - 0.5 ? -1 : 0;
    sim.queueInput(me.id, { seq: i + 1, fwd, strafe: fwd === 0 || d <= dist + 4 ? strafe : 0, facing });
    sim.step();
    sim.drainEvents();
  }
  return rec.finish([]);
}

describe('learning from human replays', () => {
  it('measures how a person actually moved and stood', () => {
    const [s] = measureHumans(recording(1, 20, 40));
    assert.equal(s.classId, 'mage');
    assert.ok(s.sample.strafe && s.sample.strafe.value > 0.9, JSON.stringify(s.sample));
    assert.ok(s.sample.rangeBias && Math.abs(s.sample.rangeBias.value) < 8, JSON.stringify(s.sample.rangeBias));
    const [still] = measureHumans(recording(0, 20, 40));
    assert.ok(still.sample.strafe!.value < 0.05);
    assert.equal(measureHumans({ ...recording(0, 20, 40), units: [] }).length, 0);
  });

  it('a style is a running average and pulls a brain towards it, never all the way', () => {
    let st = mergeStyle({}, { strafe: { value: 0.2, weight: 300 } });
    st = mergeStyle(st, { strafe: { value: 0.6, weight: 300 } });
    assert.ok(Math.abs(st.strafe!.value - 0.4) < 1e-9);
    const b = styledBrain({ ...DEFAULT_BRAIN, strafe: 0.9 }, st);
    assert.ok(b.strafe < 0.9 && b.strafe > 0.4, `${b.strafe}`);
    assert.equal(styledBrain(DEFAULT_BRAIN, { strafe: { value: 0, weight: 5 } }).strafe, DEFAULT_BRAIN.strafe, 'too little evidence changes nothing');
  });

  it('shields, stealth and self heals count as defensives; attacks do not', () => {
    for (const id of ['ice_barrier', 'vanish', 'power_word_shield']) assert.ok(isDefensive(id), id);
    for (const id of ['frostbolt', 'mortal_strike']) assert.ok(!isDefensive(id), id);
    void TUNING;
  });
});
