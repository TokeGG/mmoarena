import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blankArena, cleanCustomArena } from '@arena/shared';
import { addItem, duplicateSel, symmetrize } from '../src/mapEditLogic';

describe('map editor helpers', () => {
  it('duplicates a piece two yards over, and a pillar too', () => {
    const d = blankArena();
    const s = addItem(d, 'wall', { x: -10, z: 0 }, { x: -6, z: 2 });
    const copy = duplicateSel(d, s);
    assert.deepEqual(copy, { kind: 'wall', i: 1 });
    assert.equal(d.walls![1].x0, d.walls![0].x0 + 2);
    const p = addItem(d, 'pillar', { x: 4, z: 4 }, { x: 4, z: 4 });
    const n = d.pillars.length;
    assert.equal(duplicateSel(d, p)?.kind, 'pillar');
    assert.equal(d.pillars.length, n + 1);
  });

  it('makes a map point-symmetric: the left half is kept, the right half is its turned-around copy, ramps turn the other way', () => {
    const d = blankArena();
    d.pillars = [{ x: -8, z: 3, r: 1.5 }, { x: 9, z: -9, r: 1 }];
    addItem(d, 'wall', { x: -12, z: 5 }, { x: -9, z: 6 });
    addItem(d, 'flat', { x: -14, z: -4 }, { x: -6, z: 4 });
    addItem(d, 'ramp', { x: -20, z: -2 }, { x: -14, z: 2 });
    d.deck!.ramps[0].rise = '+x';
    const r = symmetrize(d);
    assert.ok(r.removed >= 1 && r.added >= 4);
    assert.deepEqual(d.pillars.map((p) => [p.x, p.z]).sort(), [[-8, 3], [8, -3]]);
    assert.equal(d.walls!.length, 2);
    assert.equal(d.walls![1].x0, 9);
    assert.equal(d.deck!.flats.length, 2);
    assert.equal(d.deck!.ramps[1].rise, '-x');
    assert.deepEqual(d.spawns[1], d.spawns[0].map((p) => ({ x: 0 - p.x, z: 0 - p.z })));
    // nothing the shared checker would trip over comes out of it
    assert.ok(cleanCustomArena(JSON.parse(JSON.stringify(d)), []).arena || cleanCustomArena(JSON.parse(JSON.stringify(d)), []).problems.every((x) => !/is not a number/.test(x)));
  });
});
