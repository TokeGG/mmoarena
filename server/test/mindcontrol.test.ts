import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientMsg, ServerMsg } from '@arena/shared';
import { MemoryStore } from '../src/store';
import { Accounts } from '../src/accounts';
import { Lobby } from '../src/rooms';

const mkP = (name: string, out: ServerMsg[], account: any) => {
  const ws = { readyState: 1, closed: false, send: (s: string) => out.push(JSON.parse(s)), close() { this.closed = true; }, bufferedAmount: 0 };
  return { ws, name, classId: 'priest', matches: 0, wins: 0, size: 1, ip: '9.9.9.9', mapPref: 'random', account, ownerOk: false, since: Date.now(), chain: Promise.resolve(), pending: 0 } as any;
};

describe('Mind Control reaches the priest\'s screen', () => {
  it('the priest\'s client is switched to the enemy it took, and back when the control ends', async () => {
    const store = new MemoryStore();
    const accounts = new Accounts(store, 'code');
    const bob = (await accounts.register('Bob', 'hunter22', '3.3.3.3')) as any;
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 }, accounts);
    const out: ServerMsg[] = [];
    const p = mkP('Bob', out, bob.account);
    (lobby as any).conns.add(p);
    lobby.handle(p, { t: 'join', name: 'Bob', classId: 'priest', mode: 'practice', difficulty: 'dummy', size: 1 } as ClientMsg);
    const room = p.room;
    assert.ok(room, 'in a match');
    const sim = room.sim;
    const me = sim.units.get(p.unitId)!;
    const foe = [...sim.units.values()].find((u) => u.team !== me.team)!;
    me.bar = [...me.bar.slice(0, 7), 'mind_control'];
    me.pos = { x: 0, z: 0 };
    foe.pos = { x: 0, z: 12 };
    foe.maxHealth = foe.health = 1e6;
    for (let i = 0; i < 5; i++) room.tick(); // the match goes live
    const cast = sim.useAbility(me.id, 'mind_control', foe.id);
    assert.ok(cast.ok, JSON.stringify(cast));
    const controlling = () => out.filter((m) => m.t === 'controlling') as Extract<ServerMsg, { t: 'controlling' }>[];
    for (let i = 0; i < 400 && !controlling().length; i++) room.tick();
    const first = controlling()[0];
    assert.ok(first, 'the priest was told');
    assert.equal(first.mind, 'control');
    assert.equal(first.unitId, foe.id, 'the screen follows the enemy unit');
    assert.equal(first.classId, foe.classId);
    assert.equal(first.team, me.team, 'which fights for the priest\'s team meanwhile');
    for (let i = 0; i < 1500 && controlling().length < 2; i++) room.tick();
    const second = controlling()[1];
    assert.ok(second, 'and told again when it ended');
    assert.equal(second.mind, 'own');
    assert.equal(second.unitId, me.id);
    assert.equal(foe.team, 1 - me.team, 'the enemy is back on its own team');
  });
});
