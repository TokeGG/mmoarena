import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../src/rooms';
import type { ClientMsg, ServerMsg } from '@arena/shared';

const sock = () => {
  const sent: ServerMsg[] = [];
  return { readyState: 1, sent, send(d: string) { sent.push(JSON.parse(d)); } } as any;
};

describe('watching', () => {
  it('guests must sign in to see or watch live matches', () => {
    const l = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 });
    const s = sock();
    const g = l.connect(s, '4.4.4.4');
    l.handle(g, { t: 'live' } as ClientMsg);
    const m = s.sent.at(-1) as any;
    assert.equal(m.t, 'live');
    assert.equal(m.signIn, true);
    assert.equal(m.rows.length, 0);
    l.handle(g, { t: 'spectate', id: 1 } as unknown as ClientMsg);
    assert.ok(!s.sent.some((x: ServerMsg) => x.t === 'spectating'));
  });

  it('any match with a player can be watched; the owner sees it live with running stats, everyone else five seconds late', () => {
    const l = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 });
    const s0 = sock();
    const host = l.connect(s0, '1.1.1.1');
    l.handle(host, { t: 'join', name: 'Host', classId: 'mage', mode: 'practice', size: 1, difficulty: 'normal' } as ClientMsg);
    assert.ok(host.room, 'practice match started');

    const so = sock();
    const owner = l.connect(so, '2.2.2.2');
    owner.ownerOk = true;
    const sg = sock();
    const guest = l.connect(sg, '3.3.3.3');
    for (const [pl, n] of [[owner, 'Own'], [guest, 'Gst']] as const) (pl as any).account = { name: n, key: n.toLowerCase(), matches: 0 };
    l.handle(owner, { t: 'live' } as ClientMsg);
    const rows = (so.sent.at(-1) as any).rows;
    assert.equal(rows.length, 1, 'a casual bot match is listed');
    assert.equal(rows[0].ranked, false);
    for (const p of [owner, guest]) l.handle(p, { t: 'spectate', id: rows[0].id } as ClientMsg);

    // make something happen so the totals move
    const sim = host.room!.sim;
    const me = sim.units.get(host.unitId!)!;
    const foe = [...sim.units.values()].find((u) => u.team !== me.team)!;
    me.pos = { x: 0, z: 0 };
    foe.pos = { x: 0, z: 6 };
    for (let i = 0; i < 40; i++) {
      if (i === 5) sim.dealDamage(me, foe, 123, 'fire', 'fireball');
      if (i === 6) sim.heal(foe, foe, 50, 'flash_heal');
      l.tick();
    }
    const snaps = (s: any) => s.sent.filter((m: ServerMsg) => m.t === 'snapshot').length;
    assert.ok(snaps(so) >= 30, 'the owner gets live frames');
    assert.equal(snaps(sg), 0, 'a normal spectator waits out the delay');
    const stats = so.sent.filter((m: ServerMsg) => m.t === 'stats').at(-1) as any;
    assert.ok(stats, 'owner gets stats');
    const mine = stats.rows.find((r: any) => r.id === me.id);
    const theirs = stats.rows.find((r: any) => r.id === foe.id);
    assert.ok(mine.dmg > 0, 'damage done'); // not an exact figure: a bot may have a defensive up
    assert.ok(theirs.taken > 0, 'damage taken');
    assert.ok(theirs.heal >= 0 && stats.rows.every((r: any) => ['dmg', 'heal', 'taken', 'healTaken', 'overheal'].every((k) => typeof r[k] === 'number')));
    assert.equal(sg.sent.filter((m: ServerMsg) => m.t === 'stats').length, 0, 'stats are for the owner only');
  });
});
