import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clothWave, clothShade, unfurlProgress, endFade } from '../src/flagCloth';

describe('banner cloth helpers', () => {
  it('stays pinned at the pole and waves further out', () => {
    for (const t of [0, 0.3, 1.7]) assert.equal(Math.abs(clothWave(0, 0.5, t)), 0);
    let max = 0;
    for (let t = 0; t < 3; t += 0.05) max = Math.max(max, Math.abs(clothWave(1, 0.5, t)));
    assert.ok(max > 0.15 && max < 0.5);
  });
  it('shade stays in a sane range', () => {
    for (let u = 0; u <= 1; u += 0.1) for (let t = 0; t < 2; t += 0.2) {
      const s = clothShade(u, 0.5, t);
      assert.ok(s >= 0.55 && s <= 1.1);
    }
  });
  it('unfurls after the drop and fades in the last second', () => {
    assert.equal(unfurlProgress(0.1), 0);
    assert.equal(unfurlProgress(1), 1);
    assert.ok(unfurlProgress(0.37) > 0 && unfurlProgress(0.37) < 1);
    assert.equal(endFade(5000), 1);
    assert.equal(endFade(500), 0.5);
    assert.equal(endFade(-10), 0);
  });
});
