import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { modelIdFor } from '../src/riggedModels';

describe('which warrior model each spec wears', () => {
  it('the knight for Warbringer and Rampager, the brute for the Barbarian, procedural for other classes', () => {
    assert.equal(modelIdFor('warrior', 'dual'), 'knight');
    assert.equal(modelIdFor('warrior', 'twohand'), 'knight');
    assert.equal(modelIdFor('warrior', 'polearm'), 'brute');
    assert.equal(modelIdFor('warrior', undefined), 'knight');
    assert.equal(modelIdFor('mage', undefined), undefined);
  });
});
