import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { groupFriends, onlineCount, statusLine } from '../src/friendsState';
import { compareVersions, markSeen, missedText, unseenPatchCount } from '../src/patchSeen';
import type { FriendRow } from '@arena/shared';

const f = (name: string, status: FriendRow['status']): FriendRow => ({ name, status });
const list = [f('Ann', 'menu'), f('Bob', 'offline'), f('Cy', 'queue'), f('Dee', 'match'), f('Eve', 'party'), f('Fay', 'menu')];

describe('friends list helpers', () => {
  it('counts everyone who is not offline', () => {
    assert.equal(onlineCount(list), 5);
    assert.equal(onlineCount([]), 0);
  });
  it('groups by status with party mates first and offline last, and filters by name', () => {
    const g = groupFriends(list, ['Fay']);
    assert.deepEqual(g.map((x) => x.group), ['party', 'online', 'queue', 'match', 'offline']);
    assert.deepEqual(g[0].rows.map((r) => r.name), ['Fay']);
    assert.deepEqual(groupFriends(list, [], 'e').flatMap((x) => x.rows.map((r) => r.name)).sort(), ['Dee', 'Eve']);
    assert.deepEqual(groupFriends(list, [], 'BO').map((x) => x.group), ['offline']);
    assert.deepEqual(groupFriends([], []), []);
  });
  it('says what a friend is doing', () => {
    assert.equal(statusLine(f('Fay', 'menu'), ['fay']), 'In your party');
    assert.equal(statusLine(f('Eve', 'party'), []), 'In another party');
    assert.equal(statusLine(f('Cy', 'queue'), []), 'Queueing');
  });
});

describe('patch notes seen counter', () => {
  const patches = [{ version: '0.69.3' }, { version: '0.69.2' }, { version: '0.68.10' }, { version: '0.68.9' }];
  it('compares versions numerically', () => {
    assert.ok(compareVersions('0.68.10', '0.68.9') > 0);
    assert.equal(compareVersions('0.69', '0.69.0'), 0);
  });
  it('counts newer entries; a fresh install sees nothing new', () => {
    assert.equal(unseenPatchCount(patches, '0.68.9'), 3);
    assert.equal(unseenPatchCount(patches, '0.69.3'), 0);
    assert.equal(unseenPatchCount(patches, null), 0);
  });
  it('marks the newest as seen and never goes backwards', () => {
    assert.equal(markSeen(patches, '0.68.9'), '0.69.3');
    assert.equal(markSeen(patches, null), '0.69.3');
    assert.equal(markSeen(patches.slice(2), '0.69.3'), '0.69.3');
  });
  it('words the banner', () => {
    assert.equal(missedText(3), 'You missed 3 updates since your last visit.');
    assert.equal(missedText(1), 'You missed 1 update since your last visit.');
    assert.equal(missedText(0), '');
  });
});

import { badgeText, liveCount, pendingProposals } from '../src/counts';
describe('badge counters', () => {
  it('counts unchecked proposals and live matches', () => {
    assert.equal(pendingProposals([{ status: 'pending' }, { status: 'dismissed' }, { status: 'pending' }, { status: 'pr' }]), 2);
    assert.equal(pendingProposals(null), 0);
    assert.equal(liveCount([1, 2, 3]), 3);
    assert.equal(liveCount(undefined), 0);
  });
  it('words the bubble', () => {
    assert.equal(badgeText(0), '');
    assert.equal(badgeText(7), '7');
    assert.equal(badgeText(120), '99+');
  });
});
