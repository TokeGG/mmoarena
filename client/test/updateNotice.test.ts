import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UpdateNotice, needsRefresh } from '../src/updateNotice';

describe('update notice', () => {
  it('asks for a refresh only when the server runs a different version', () => {
    assert.ok(needsRefresh('0.69.15', '0.69.16'));
    assert.ok(needsRefresh('0.69.15', '0.70.0'));
    assert.ok(needsRefresh('0.69.15', '0.69.14'), 'a roll-back also needs a reload');
    assert.ok(!needsRefresh('0.69.15', '0.69.15'));
    assert.ok(!needsRefresh('0.69.15', undefined));
    assert.ok(!needsRefresh('0.69.15', 'garbage'));
    assert.ok(!needsRefresh('0.69.15', 17));
  });

  it('a status page that is down, or runs the same version, shows nothing', async () => {
    assert.equal(await new UpdateNotice('0.69.15', async () => ({ version: '0.69.15' })).check(), false);
    assert.equal(await new UpdateNotice('0.69.15', async () => { throw new Error('restarting'); }).check(), false);
    assert.equal(await new UpdateNotice('0.69.15', async () => null).check(), false);
  });
});
