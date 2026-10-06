import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../src/rooms';
import type { ClientMsg, ServerMsg } from '@arena/shared';

const sock = () => {
  const sent: ServerMsg[] = [];
  return { readyState: 1, sent, send(d: string) { sent.push(JSON.parse(d)); } } as any;
};
const lobbyOf = () => new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 });
const join = (l: Lobby, size: 1 | 2 | 3, mode: 'queue' | 'practice' = 'queue', extra: Partial<ClientMsg> = {}) => {
  const s = sock();
  const p = l.connect(s, '1.1.1.1');
  l.handle(p, { t: 'join', name: 'P', classId: 'mage', mode, size, ...extra } as ClientMsg);
  return { s, p };
};
const welcomes = (s: any) => s.sent.filter((m: ServerMsg) => m.t === 'welcome');

describe('team sizes', () => {
  it('1v1 starts with two players, each on their own team', () => {
    const l = lobbyOf();
    const a = join(l, 1);
    assert.equal(welcomes(a.s).length, 0);
    assert.deepEqual((a.s.sent.at(-1) as any).needed, 2);
    const b = join(l, 1);
    assert.equal(welcomes(a.s).length, 1);
    assert.notEqual(welcomes(a.s)[0].team, welcomes(b.s)[0].team);
  });

  it('3v3 needs six, and queues of different sizes never mix', () => {
    const l = lobbyOf();
    const all = [join(l, 3), join(l, 3), join(l, 3), join(l, 2), join(l, 2), join(l, 3), join(l, 3)];
    assert.equal(welcomes(all[0].s).length, 0, 'five 3v3 players are not enough');
    assert.equal(welcomes(all[3].s).length, 0, 'two 2v2 players are not enough');
    const last = join(l, 3);
    const started = [...all.filter((_, i) => i !== 3 && i !== 4), last].filter((x) => welcomes(x.s).length === 1);
    assert.equal(started.length, 6);
    const teams = started.map((x) => welcomes(x.s)[0].team);
    assert.equal(teams.filter((t) => t === 0).length, 3);
    assert.equal(teams.filter((t) => t === 1).length, 3);
    assert.equal(welcomes(all[3].s).length, 0);
    assert.equal(welcomes(all[4].s).length, 0);
  });

  it('practice sizes: 1v1 has one dummy foe, 3v3 has two partners and three foes', () => {
    const l = lobbyOf();
    const one = join(l, 1, 'practice');
    const three = join(l, 3, 'practice');
    const room = (p: any) => p.p.room;
    assert.equal(room(one).sim.units.size, 2);
    assert.equal(room(three).sim.units.size, 6);
    const custom = join(l, 3, 'practice', { foes: ['rogue'], allies: ['priest', 'warrior'] });
    assert.equal(room(custom).sim.units.size, 4);
  });
});
