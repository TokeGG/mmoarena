import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { patchTime } from '../src/patchTime';

describe('patch note times', () => {
  it('shows when a patch went out in the viewer\u2019s own time zone, and just the date for old entries', () => {
    const p = { date: '2026-10-07', at: '2026-10-07T21:24:05Z' };
    const chicago = patchTime(p, 'en-US', 'America/Chicago');
    assert.match(chicago, /Oct 7, 2026/);
    assert.match(chicago, /4:24\s?PM/);
    assert.match(chicago, /CDT/);
    const tokyo = patchTime(p, 'en-US', 'Asia/Tokyo');
    assert.match(tokyo, /Oct 8, 2026/, 'already the next day there');
    assert.equal(patchTime({ date: '2026-01-02' }), '2026-01-02');
  });
});
