import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { modelIdFor } from '../src/riggedModels';

describe('which warrior model each spec wears', () => {
  it('the knight for every warrior spec (the brute only on request), procedural for other classes', () => {
    assert.equal(modelIdFor('warrior', 'dual'), 'knight');
    assert.equal(modelIdFor('warrior', 'twohand'), 'knight');
    assert.equal(modelIdFor('warrior', 'polearm'), 'knight');
    assert.equal(modelIdFor('warrior', undefined), 'knight');
    assert.equal(modelIdFor('mage', undefined), undefined);
    const g = globalThis as { location?: unknown };
    g.location = { search: '?warriormodel=brute' };
    try {
      assert.equal(modelIdFor('warrior', 'polearm'), 'brute');
    } finally {
      delete g.location;
    }
  });
});
