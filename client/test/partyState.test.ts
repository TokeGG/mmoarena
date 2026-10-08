import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { partyReadiness } from '../src/partyState';
import type { PartyInfo } from '@arena/shared';

const m = (name: string, ready: boolean) => ({ name, ready, side: 0 as const, classId: 'mage' as const, spec: 'fire', look: '' });
const party = (...ms: ReturnType<typeof m>[]): PartyInfo => ({ id: 'p', leader: 'Ann', members: ms });

describe('party readiness label', () => {
  it('names who the leader waits for with a count that includes the leader', () => {
    const r = partyReadiness(party(m('Ann', true), m('Bob', false), m('Cy', true), m('Dee', false)));
    assert.deepEqual(r.waiting, ['Bob', 'Dee']);
    assert.equal(r.label, 'Waiting for Bob, Dee to ready up (2/4).');
    assert.equal(r.canStart, false);
  });
  it('can start when everyone but the leader is ready, and when alone', () => {
    assert.equal(partyReadiness(party(m('Ann', true), m('Bob', true))).canStart, true);
    assert.equal(partyReadiness(null).canStart, true);
  });
  it('the leader never counts as waiting even if its flag is off', () => {
    assert.deepEqual(partyReadiness(party(m('Ann', false), m('Bob', true))).waiting, []);
  });
});
