import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMsg } from '@arena/shared';
import { Designer, requestStatus, scopeId } from '../src/designer';

describe('Ask Claude thread', () => {
  it('keeps answers per scope, updates an answer by id and tracks requests', () => {
    const d = new Designer();
    let n = 0;
    d.onChange(() => n++);
    const turn = (id: string, applied: boolean): ServerMsg => ({ t: 'dev_chat', turn: { id, kind: 'changes', scope: 'fireball', text: 'Doing it', applied, changes: [{ label: 'Fireball · cooldown', from: 8000, to: 3000 }] } });
    assert.equal(d.handle(turn('a1', true)), true);
    assert.equal(d.handle(turn('a1', false)), true);
    assert.equal((d as any).threads.get('fireball').length, 1, 'the same answer is updated, not repeated');
    assert.equal((d as any).threads.get('fireball')[0].turn.applied, false);
    d.handle({ t: 'dev_requests', rows: [{ id: 'r1', status: 'done' } as any], all: false });
    assert.equal(d.requests.length, 1);
    assert.match(requestStatus(d.requests[0]), /done/);
    assert.equal(n, 3);
    assert.equal(scopeId({ ability: '', classId: 'mage', name: 'x' }), 'class:mage');
  });
});
