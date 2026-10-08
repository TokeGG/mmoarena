import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARENAS, ArenaSim, TUNING, arenaById, hasLOS, inLava, moveTo, resolveCollisions } from '../src/index';

const forge = arenaById('forge');
const pit = forge.lows!.find((r) => r.lava)!;
const mid = { x: (pit.x0 + pit.x1) / 2, z: (pit.z0 + pit.z1) / 2 };

describe('lava pits', () => {
  it('the Lava Forge basins are lava, and only they', () => {
    assert.equal(forge.lows!.filter((r) => r.lava).length, 4);
    for (const a of ARENAS) if (a.id !== 'forge') assert.equal(a.lows?.some((r) => r.lava) ?? false, false, a.id);
  });
  it('walking into a pit is blocked, a jump can land in it and nobody is pushed out of it', () => {
    const outside = { x: pit.x0 - 1.5, z: mid.z };
    const walked = moveTo(forge, 0, outside, mid, 0).pos;
    assert.ok(!inLava(forge, walked), 'on foot you stay out');
    const jumped = moveTo(forge, 0, outside, mid, 0.6).pos;
    assert.ok(inLava(forge, jumped), 'in a jump you come down inside');
    const landed = moveTo(forge, 0, jumped, { x: jumped.x + 0.3, z: jumped.z }, 0).pos;
    assert.ok(inLava(forge, landed), 'inside, you stay and can move about');
    assert.ok(!inLava(forge, resolveCollisions(landed, forge, 0, 0)), 'without a way in, the basin is still a barricade');
  });
  it('standing in lava burns every half second, and nothing burns outside', () => {
    const sim = new ArenaSim({ seed: 1, prepMs: 0, arena: forge });
    const u = sim.addUnit({ name: 'u', classId: 'warrior', team: 0, controller: 'player' });
    sim.addUnit({ name: 'd', classId: 'warrior', team: 1, controller: 'dummy' });
    sim.step();
    u.pos = { ...mid };
    const full = u.health;
    for (let t = 0; t < 2100; t += TUNING.tickMs) sim.step();
    const burned = full - u.health;
    assert.ok(burned >= u.maxHealth * TUNING.lavaPct * 4 * 0.9 && burned <= u.maxHealth * TUNING.lavaPct * 6, `burned ${burned}`);
    u.pos = { x: 0, z: 0 };
    const keep = u.health;
    for (let t = 0; t < 2000; t += TUNING.tickMs) sim.step();
    assert.equal(u.health, keep, 'no damage outside');
  });
  it('a pit does not hide anyone any less than before (still a person-high barricade)', () => {
    assert.equal(hasLOS({ x: pit.x0 - 3, z: mid.z }, { x: pit.x1 + 3, z: mid.z }, forge), false);
  });
});
