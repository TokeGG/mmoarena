import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RATES, nextRate } from '../src/spectate';

describe('replay speed button (phones)', () => {
  it('steps slowest to fastest and wraps round', () => {
    assert.deepEqual(RATES, [0.5, 1, 2, 4]);
    assert.equal(nextRate(0.5), 1);
    assert.equal(nextRate(1), 2);
    assert.equal(nextRate(2), 4);
    assert.equal(nextRate(4), 0.5);
  });

  it('an unknown speed goes to the next of the list from the start', () => {
    assert.equal(nextRate(3), 1);
  });
});
