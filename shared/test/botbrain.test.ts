import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BRAIN_BOUNDS, BRAIN_KEYS, DEFAULT_BRAIN, POP_SIZE, EVOLVE_GAMES, brainFor, clampBrain, mutateBrain, newPopulation, pickVariant, recordResult } from '../src/index';

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('bot brains', () => {
  it('clamp keeps every value in range and fills gaps with defaults', () => {
    const b = clampBrain({ strafe: 9, coverHp: -3, healAt: NaN as number });
    assert.equal(b.strafe, BRAIN_BOUNDS.strafe[1]);
    assert.equal(b.coverHp, BRAIN_BOUNDS.coverHp[0]);
    assert.equal(b.healAt, DEFAULT_BRAIN.healAt);
    for (const c of ['warrior', 'mage', 'priest', 'rogue'] as const) for (const k of BRAIN_KEYS) {
      assert.ok(brainFor(c)[k] >= BRAIN_BOUNDS[k][0] && brainFor(c)[k] <= BRAIN_BOUNDS[k][1]);
    }
  });
  it('mutation stays in bounds and actually moves things', () => {
    const r = rng(5);
    let b = DEFAULT_BRAIN;
    let moved = false;
    for (let i = 0; i < 200; i++) {
      const n = mutateBrain(b, r, 0.3, 0.8);
      for (const k of BRAIN_KEYS) assert.ok(n[k] >= BRAIN_BOUNDS[k][0] && n[k] <= BRAIN_BOUNDS[k][1]);
      if (BRAIN_KEYS.some((k) => n[k] !== b[k])) moved = true;
      b = n;
    }
    assert.ok(moved);
  });
  it('a variant that keeps winning gets picked more and the weakest is replaced', () => {
    const r = rng(11);
    const pop = newPopulation('mage', r);
    assert.equal(pop.variants.length, POP_SIZE);
    const star = pop.variants[2].id;
    const before = pop.variants.map((v) => v.id);
    for (let i = 0; i < EVOLVE_GAMES * POP_SIZE; i++) {
      const v = pop.variants[i % POP_SIZE];
      recordResult(pop, v.id, v.id === star ? i % 4 !== 0 : i % 4 === 0, r);
    }
    assert.equal(pop.generation, 1, 'evolved once');
    assert.ok(pop.variants.some((v) => v.id === star), 'the best survives');
    assert.ok(before.some((id) => !pop.variants.some((v) => v.id === id)), 'something was replaced');
    const star2 = pop.variants.find((v) => v.id === star)!;
    star2.wins = 30; star2.games = 36;
    let picks = 0;
    for (let i = 0; i < 300; i++) if (pickVariant(pop, r).id === star) picks++;
    assert.ok(picks > 150, `star picked ${picks}/300`);
    assert.equal(recordResult(pop, 'gone', true, r), false, 'unknown variants are ignored');
  });
});

import { BRAIN_KEYS as WORD_KEYS } from '../src/botbrain';
import { BRAIN_WORDS, plainMove, showBrainValue } from '../src/brainwords';
describe('bot learning in plain words', () => {
  it('every brain number has words, and a move reads as behaviour', () => {
    for (const k of WORD_KEYS) assert.ok(BRAIN_WORDS[k]?.what && BRAIN_WORDS[k].up && BRAIN_WORDS[k].down && BRAIN_WORDS[k].watch, k);
    assert.equal(plainMove({ key: 'defHp', before: 0.65, after: 0.62 }), 'hold defensive cooldowns until they are lower (the health at which it uses defensive cooldowns: 62%, was 65%)');
    assert.equal(showBrainValue('strafeFlip', 1.5), '1.5 s');
  });
});
