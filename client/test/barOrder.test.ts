import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyOrder, swapSlots } from '../src/barOrder';
import { CAM_MIN, cameraReach, zoomStep } from '../src/camera';

const bar = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

describe('action bar order', () => {
  it('swaps two slots and ignores bad indexes', () => {
    assert.deepEqual(swapSlots(bar, 0, 7).slice(0, 1), ['h']);
    assert.equal(swapSlots(bar, 0, 7)[7], 'a');
    assert.deepEqual(swapSlots(bar, 2, 2), bar);
    assert.deepEqual(swapSlots(bar, -1, 3), bar);
  });
  it('applies a saved order; a talent swap that replaced an ability takes its slot', () => {
    const saved = ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a'];
    assert.deepEqual(applyOrder(bar, saved), saved);
    const swapped = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'z']; // z replaced h
    const out = applyOrder(swapped, saved);
    assert.equal(new Set(out).size, 8);
    assert.equal(out[0], 'z', "h's slot goes to its replacement");
  });
  it('without a save the bar is unchanged', () => {
    assert.deepEqual(applyOrder(bar, null), bar);
  });
});

describe('camera zoom and walls', () => {
  it('scrolling in from the closest third-person view reaches first person, scrolling out leaves it', () => {
    let d = 12;
    for (let i = 0; i < 40; i++) d = zoomStep(d, -100);
    assert.equal(d, 0);
    assert.equal(zoomStep(0, 100), CAM_MIN);
    assert.equal(zoomStep(CAM_MIN, -1), 0, 'even a tiny notch at the closest view enters first person');
    assert.ok(zoomStep(30, 100) <= 30);
  });
  const bounds = { minX: -30, maxX: 30, minZ: -20, maxZ: 20 };
  it('a wall right behind you pulls the camera into first person range', () => {
    const d = cameraReach(12, { x: 0, y: 1.8, z: 19.5 }, { x: 0, y: 0.5, z: 0.87 }, bounds);
    assert.ok(d < 1.8, `got ${d}`);
  });
  it('a pillar behind you pulls it in; open space keeps the zoom', () => {
    assert.ok(cameraReach(12, { x: 0, y: 1.8, z: 0 }, { x: 0, y: 0.5, z: -0.87 }, bounds, 1.2) < 1);
    assert.equal(cameraReach(5, { x: 0, y: 1.8, z: 0 }, { x: 0, y: 0.3, z: -0.95 }, bounds), 5);
  });
});
