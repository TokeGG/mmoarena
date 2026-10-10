import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, applyPatches, entityProblems, entityText, parsePatches, smokeProblem, validPatch } from '../src/index';
import type { DataPatch } from '../src/index';

const edited = (id: string, f: (o: any) => void): DataPatch => {
  const o = JSON.parse(entityText('abilities', id)!);
  f(o);
  return { file: 'abilities', id, path: ['$entity'], value: JSON.stringify(o, null, 2) };
};

describe('the data editor (whole entries as JSON)', () => {
  it('shows an entry as text and takes the same text back', () => {
    const t = entityText('abilities', 'fireball')!;
    assert.deepEqual(entityProblems('abilities', 'fireball', t), []);
  });
  it('a shield can be added to a skill, and undone', () => {
    const was = JSON.stringify(ABILITIES.fireball);
    const p = edited('fireball', (o) => o.effects.push({ type: 'aura', aura: 'pw_shield', target: 'self' }));
    assert.ok(validPatch(p));
    const undo = applyPatches([p]);
    assert.equal(ABILITIES.fireball.effects.at(-1)!.type, 'aura');
    assert.equal(smokeProblem([p]), null);
    undo();
    assert.equal(JSON.stringify(ABILITIES.fireball), was);
  });
  it('rejects bad entries in plain words', () => {
    assert.ok(entityProblems('abilities', 'fireball', '{nope').length);
    assert.ok(entityProblems('abilities', 'fireball', '{"id":"fireball","name":"x","class":"mage","school":"fire","target":"enemy","effects":[{"type":"zap"}]}').some((x) => /type/.test(x)));
    assert.ok(entityProblems('abilities', 'fireball', '{"__proto__":{"a":1}}').length);
    const p = edited('fireball', (o) => { o.effects[0].aura = 'nope'; o.effects.push({ type: 'aura', aura: 'nope' }); });
    assert.ok(!validPatch(p));
  });
  it('travels through the message parser with a long value', () => {
    const p = edited('fireball', () => {});
    assert.equal(parsePatches([p])?.length, 1);
    assert.equal(parsePatches([{ ...p, path: ['x'] }]), null);
  });
});
