import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEV_POWERS, hasPower, withPower } from '../src/index';

describe('dev powers', () => {
  it('the ones that are on by default go away with a deny, the ones that are off come with a power grant', () => {
    assert.equal(hasPower(['dev'], 'maps'), true);
    assert.equal(hasPower(['dev', 'deny:maps'], 'maps'), false);
    assert.equal(hasPower(['dev'], 'maintain'), false);
    assert.equal(hasPower(['dev', 'power:maintain'], 'maintain'), true);
    assert.equal(hasPower(['dev'], 'nonsense'), false);
  });
  it('withPower flips one and keeps every other grant', () => {
    let g = ['dev', 'gif', 'title:founder'];
    g = withPower(g, 'botmatch', false);
    assert.deepEqual(g, ['dev', 'gif', 'title:founder', 'deny:botmatch']);
    assert.equal(hasPower(g, 'botmatch'), false);
    g = withPower(g, 'botmatch', true);
    assert.deepEqual(g, ['dev', 'gif', 'title:founder']);
    g = withPower(g, 'maintain', true);
    assert.ok(hasPower(g, 'maintain'));
    g = withPower(withPower(g, 'maintain', true), 'maintain', true);
    assert.equal(g.filter((x) => x === 'power:maintain').length, 1, 'no duplicates');
    assert.ok(DEV_POWERS.every((p) => /^[a-z0-9_]{2,16}$/.test(p.id)), 'ids fit the grant format');
  });
});
