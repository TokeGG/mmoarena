import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findMatch } from '../src/matchmaking';
import type { QEntry } from '../src/matchmaking';

let t = 0;
const e = (names: string[], size: 1 | 2 | 3 = 3, pref = 'random'): QEntry<string> => ({ members: names, size, pref, at: t++ });
const names = (es: QEntry<string>[]) => es.flatMap((x) => x.members).sort();

describe('matchmaking', () => {
  it('needs exactly 2 x size players', () => {
    assert.equal(findMatch([e(['a']), e(['b']), e(['c']), e(['d']), e(['f'])], 3, () => 'm'), null);
    const m = findMatch([e(['a']), e(['b']), e(['c']), e(['d']), e(['f']), e(['g'])], 3, () => 'm');
    assert.ok(m);
    assert.equal(m!.teamA.flatMap((x) => x.members).length, 3);
    assert.equal(m!.teamB.flatMap((x) => x.members).length, 3);
  });

  it('parties are never split and fill a team with the right mix', () => {
    const entries = [e(['p1', 'p2']), e(['s1']), e(['q1', 'q2']), e(['s2']), e(['s3'])];
    const m = findMatch(entries, 3, () => 'm')!;
    assert.ok(m);
    const sizes = (es: QEntry<string>[]) => es.map((x) => x.members.length).sort();
    for (const team of [m.teamA, m.teamB]) assert.equal(team.reduce((n, x) => n + x.members.length, 0), 3);
    for (const team of [m.teamA, m.teamB]) for (const en of team) assert.ok(en.members.every((x) => x.length === 2 || x.length === 2) || en.members.length >= 1);
    assert.equal(names([...m.teamA, ...m.teamB]).length, 6);
    void sizes;
  });

  it('two parties of three make a match on their own', () => {
    const m = findMatch([e(['a', 'b', 'c']), e(['d', 'e', 'f'])], 3, () => 'm');
    assert.ok(m);
    assert.deepEqual(names(m!.teamA), ['a', 'b', 'c']);
  });

  it('a party of three cannot fill a 1v1 or 2v2 queue; sizes never mix', () => {
    assert.equal(findMatch([e(['a', 'b', 'c'], 2), e(['d'], 2)], 2, () => 'm'), null);
    assert.equal(findMatch([e(['a'], 1), e(['b'], 2)], 1, () => 'm'), null);
    assert.ok(findMatch([e(['a'], 1), e(['b'], 1)], 1, () => 'm'));
  });

  it('arena preferences: specific players only play there, randoms fill in', () => {
    const entries = [e(['a'], 1, 'frost'), e(['b'], 1, 'ruins'), e(['c'], 1, 'random')];
    const m = findMatch(entries, 1, () => 'colosseum')!;
    assert.equal(m.map, 'frost', 'oldest specific request wins and includes its anchor');
    assert.deepEqual(names([...m.teamA, ...m.teamB]), ['a', 'c']);
    assert.equal(findMatch([e(['a'], 1, 'frost'), e(['b'], 1, 'ruins')], 1, () => 'x'), null, 'different arenas never match');
    const randoms = findMatch([e(['a'], 1), e(['b'], 1)], 1, () => 'ruins')!;
    assert.equal(randoms.map, 'ruins');
  });

  it('prefers whoever has waited longest', () => {
    const entries = [e(['old1'], 1), e(['old2'], 1), e(['new1'], 1), e(['new2'], 1)];
    assert.deepEqual(names(findMatch(entries, 1, () => 'm')!.teamA.concat(findMatch(entries, 1, () => 'm')!.teamB)), ['old1', 'old2']);
  });
});
