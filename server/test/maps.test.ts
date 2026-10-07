import { ARENAS } from '@arena/shared';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../src/rooms';
import type { ServerMsg } from '@arena/shared';

function fakeSocket() {
  const sent: ServerMsg[] = [];
  return { readyState: 1, sent, send(d: string) { sent.push(JSON.parse(d)); } } as any;
}
const join = (lobby: Lobby, p: any, map?: string) => lobby.handle(p, { t: 'join', name: 'P', classId: 'mage', mode: 'queue', map });
const mapOf = (s: any) => (s.sent.find((m: ServerMsg) => m.t === 'welcome') as any)?.map as string | undefined;

describe('arena choice', () => {
  it('players who picked different arenas are not mixed; randoms fill any', () => {
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 });
    const socks = Array.from({ length: 6 }, fakeSocket);
    const ps = socks.map((s) => lobby.connect(s, '1.1.1.1'));
    join(lobby, ps[0], 'ruins');
    join(lobby, ps[1], 'frost');
    join(lobby, ps[2], 'ruins');
    join(lobby, ps[3], 'ruins');
    assert.equal(mapOf(socks[0]), undefined, 'three ruins players are not enough');
    join(lobby, ps[4], 'random');
    assert.equal(mapOf(socks[0]), 'ruins');
    assert.equal(mapOf(socks[2]), 'ruins');
    assert.equal(mapOf(socks[3]), 'ruins');
    assert.equal(mapOf(socks[4]), 'ruins', 'random player joins the ruins match');
    assert.equal(mapOf(socks[1]), undefined, 'frost player keeps waiting');
  });

  it('practice honours the chosen arena', () => {
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 });
    const s = fakeSocket();
    const p = lobby.connect(s, '2.2.2.2');
    lobby.handle(p, { t: 'join', name: 'P', classId: 'mage', mode: 'practice', map: 'frost' });
    assert.equal(mapOf(s), 'frost');
  });

  it('four randoms get one valid arena', () => {
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 });
    const socks = Array.from({ length: 4 }, fakeSocket);
    const ps = socks.map((s) => lobby.connect(s, '3.3.3.3'));
    ps.forEach((p) => join(lobby, p));
    const maps = new Set(socks.map(mapOf));
    assert.equal(maps.size, 1);
    assert.ok(ARENAS.filter((a) => a.randomPool !== false).some((a) => a.id === [...maps][0]), `${[...maps][0]} is in the random pool`);
  });
});
