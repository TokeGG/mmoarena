import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARENAS, heightAt, resolveCollisions } from '@arena/shared';
import { menuSpot, menuSpots, freeGround, slotOffset } from '../src/lobbySpot';
import { snapUnit } from '../src/unitSmoothing';

describe('lobby spots', () => {
  it('slot offsets alternate sides, 2.4 yards apart', () => {
    assert.deepEqual([0, 1, 2, 3, 4].map(slotOffset), [0, 2.4, -2.4, 4.8, -4.8]);
  });

  for (const a of ARENAS) {
    it(`${a.id}: you and every party slot stand on free, flat ground inside the bounds`, () => {
      const spots = menuSpots(a, 4);
      assert.ok(spots[0], 'you always get a spot');
      assert.deepEqual(spots[0], a.spawns[0][0]);
      let placed = 0;
      for (const p of spots) {
        if (!p) continue;
        placed++;
        assert.ok(p.x > a.bounds.minX + 0.6 && p.x < a.bounds.maxX - 0.6 && p.z > a.bounds.minZ + 0.6 && p.z < a.bounds.maxZ - 0.6, `${a.id}: inside`);
        assert.equal(heightAt(a, p.x, p.z, 0), 0, 'on the floor, not a deck or ramp');
        const r = resolveCollisions(p, a, 0);
        assert.ok(Math.hypot(r.x - p.x, r.z - p.z) < 0.01, `${a.id}: not inside a wall, pillar or ramp`);
      }
      assert.ok(placed >= 3, `${a.id}: at least three of five places are usable`);
      for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) if (spots[i] && spots[j]) assert.ok(Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.z - spots[j]!.z) > 0.9, 'nobody overlaps');
    });
  }

  it('a slot inside a wall moves closer or is dropped, never left in the wall', () => {
    const base = ARENAS[0];
    const spawn = base.spawns[0][0];
    // a wall right where slot 1 would stand (beside the spawn along z)
    const walled = { ...base, walls: [{ x0: spawn.x - 3, x1: spawn.x + 3, z0: spawn.z - 3.5, z1: spawn.z - 1.5 }, { x0: spawn.x - 3, x1: spawn.x + 3, z0: spawn.z + 1.5, z1: spawn.z + 3.5 }] };
    assert.equal(freeGround(walled, spawn.x, spawn.z - 2.4), false);
    for (let i = 1; i < 4; i++) {
      const p = menuSpot(walled, i);
      assert.ok(p === null || freeGround(walled, p.x, p.z), 'free or dropped');
    }
    const boxed = { ...base, walls: [{ x0: spawn.x - 20, x1: spawn.x + 20, z0: spawn.z - 20, z1: spawn.z - 1 }, { x0: spawn.x - 20, x1: spawn.x + 20, z0: spawn.z + 1, z1: spawn.z + 20 }] };
    assert.equal(menuSpot(boxed, 1), null);
  });
});

describe('unit smoothing reset', () => {
  it('a map swap leaves no speed, no walk blend and the new floor height', () => {
    const m = { lastX: -24, lastZ: -3, baseY: 3.2, fallV: 12, phase: 9, move: 0.7, vf: -46, vs: 14 };
    snapUnit(m, -17, -3, 0);
    assert.deepEqual(m, { lastX: -17, lastZ: -3, baseY: 0, fallV: 0, phase: 0, move: 0, vf: 0, vs: 0 });
  });
});
