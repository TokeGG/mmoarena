import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MARKS, parseClientMsg } from '@arena/shared';
import type { ClientMsg, ServerMsg } from '@arena/shared';
import { Lobby } from '../src/rooms';

describe('raid marks', () => {
  it('a player marks units for their team: one mark per unit, a mark moves, the same mark again clears it', () => {
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 });
    const out: ServerMsg[] = [];
    const p = { ws: { readyState: 1, send: (s: string) => out.push(JSON.parse(s)), bufferedAmount: 0 }, name: 'Ann', classId: 'mage', matches: 0, wins: 0, size: 2, ip: '1.1.1.1', mapPref: 'random' } as any;
    (lobby as any).conns.add(p);
    lobby.handle(p, { t: 'join', name: 'Ann', classId: 'mage', mode: 'practice', difficulty: 'normal', size: 2 } as ClientMsg);
    const room = p.room;
    const foes = [...room.sim.units.values()].filter((u: any) => u.team !== room.sim.units.get(p.unitId).team).map((u: any) => u.id);
    assert.ok(foes.length >= 2);
    const last = () => [...out].reverse().find((m) => m.t === 'marks') as Extract<ServerMsg, { t: 'marks' }>;
    const skull = MARKS.findIndex((m) => m.id === 'skull') + 1;
    lobby.handle(p, { t: 'mark', unit: foes[0], mark: skull } as ClientMsg);
    assert.deepEqual(last().marks, [[foes[0], skull]]);
    lobby.handle(p, { t: 'mark', unit: foes[1], mark: skull } as ClientMsg);
    assert.deepEqual(last().marks, [[foes[1], skull]], 'the skull moves');
    lobby.handle(p, { t: 'mark', unit: foes[1], mark: 1 } as ClientMsg);
    assert.deepEqual(last().marks, [[foes[1], 1]], 'a unit wears one mark');
    lobby.handle(p, { t: 'mark', unit: foes[1], mark: 1 } as ClientMsg);
    assert.deepEqual(last().marks, [], 'the same mark again clears it');
    lobby.handle(p, { t: 'mark', unit: 9999, mark: 1 } as ClientMsg);
    assert.deepEqual(last().marks, [], 'unknown units are ignored');
  });

  it('bad marks are refused at the door', () => {
    assert.equal(parseClientMsg(JSON.stringify({ t: 'mark', unit: 1, mark: 9 })), null);
    assert.equal(parseClientMsg(JSON.stringify({ t: 'mark', unit: 1.5, mark: 1 })), null);
    assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'mark', unit: 3, mark: 0 })), { t: 'mark', unit: 3, mark: 0 });
  });
});
