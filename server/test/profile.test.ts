import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Accounts } from '../src/accounts';
import { MemoryStore } from '../src/store';
import { issueProfile, verifyProfile } from '../src/profile';
import { Lobby } from '../src/rooms';
import type { ClientMsg, ServerMsg } from '@arena/shared';

describe('signed profile', () => {
  it('round-trips and rejects tampering, truncation and nonsense', () => {
    const t = issueProfile({ matches: 5, wins: 2 });
    assert.deepEqual(verifyProfile(t), { matches: 5, wins: 2 });
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, m: 500, w: 2 })).toString('base64url');
    assert.equal(verifyProfile(`${forged}.${sig}`), null);
    assert.equal(verifyProfile(`${body}.${sig.slice(0, -2)}x`), null);
    assert.equal(verifyProfile(body), null);
    assert.equal(verifyProfile(`${body}.${sig}.extra`), null);
    assert.equal(verifyProfile(undefined), null);
    assert.equal(verifyProfile(''), null);
    assert.equal(verifyProfile(issueProfile({ matches: 1, wins: 9 })), null, 'wins cannot exceed matches');
  });
});

/** A fake socket so the lobby can be driven directly. */
function fakeSocket() {
  const sent: ServerMsg[] = [];
  return { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)), sent } as any;
}
const join = (extra: Partial<Extract<ClientMsg, { t: 'join' }>> = {}): ClientMsg => ({ t: 'join', name: 'T', classId: 'mage', mode: 'practice', foes: ['warrior'], ally: null, difficulty: 'easy', ...extra });

describe('lobby: builds and progress', () => {
  it('accepts a legal build with cosmetics, drops unknown cosmetics quietly, and rejects bad talents or a forged token', () => {
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 });
    const a = fakeSocket();
    const p = lobby.connect(a);
    lobby.handle(p, join({ build: { spec: 'fire', talents: ['spell_power'], gear: { head: 'crown_gold', back: 'wings_angel' } } }));
    const welcome = a.sent.find((m: ServerMsg) => m.t === 'welcome');
    assert.equal(welcome.spec, 'fire');
    assert.ok(a.sent.some((m: ServerMsg) => m.t === 'profile' && m.matches === 0));
    const unit = [...(p.room as any).sim.units.values()].find((u: any) => u.name === 'T');
    assert.deepEqual(unit.bar.slice(0, 2), ['fireball', 'pyroblast']);

    const b = fakeSocket();
    const q = lobby.connect(b);
    lobby.handle(q, join({ build: { spec: 'frost', talents: [], gear: { head: 't4.head.fury', back: 'cloak_azure' } } }));
    assert.ok(b.sent.some((m: ServerMsg) => m.t === 'welcome'), 'an old gear id from before cosmetics is just dropped');
    const unitQ = [...(q.room as any).sim.units.values()].find((u: any) => u.name === 'T');
    assert.equal(unitQ.look[0], '-', 'no head piece');
    assert.notEqual(unitQ.look[2], '-', 'the valid cloak stays');

    const d = fakeSocket();
    const bad = lobby.connect(d);
    lobby.handle(bad, join({ build: { spec: 'frost', talents: ['no_such_talent'], gear: {} } }));
    assert.ok(d.sent.some((m: ServerMsg) => m.t === 'error' && /talent/.test((m as any).reason)));

    const c = fakeSocket();
    const r = lobby.connect(c);
    const forged = Buffer.from(JSON.stringify({ v: 1, m: 99, w: 1 })).toString('base64url') + '.AAAA';
    lobby.handle(r, join({ profile: forged, build: { spec: 'frost', talents: [], gear: {} } }));
    assert.ok(c.sent.some((m: ServerMsg) => m.t === 'welcome'), 'a forged token is just ignored: it only counts matches now');
    assert.ok(a.sent.some((m: ServerMsg) => m.t === 'profile' && m.matches === 0));
  });

  it('owner-only cosmetics are dropped for guests and ordinary accounts but kept for the owner account', async () => {
    const accounts = new Accounts(new MemoryStore());
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 }, accounts);
    const sign = async (name: string) => {
      const sock = fakeSocket();
      const p = lobby.connect(sock);
      lobby.handle(p, { t: 'register', name, password: 'password1' } as ClientMsg);
      for (let i = 0; i < 300 && !sock.sent.some((m: ServerMsg) => m.t === 'account'); i++) await new Promise((r) => setTimeout(r, 5));
      return { sock, p };
    };
    const lookOf = (p: any) => [...p.room.sim.units.values()].find((u: any) => u.name === p.name).look as string;
    const gear = { head: 'founder_crown', aura: 'throne_light', back: 'cloak_azure' };
    const guest = fakeSocket();
    const g = lobby.connect(guest);
    lobby.handle(g, join({ build: { spec: 'frost', talents: [], gear } }));
    const gl = lookOf(g);
    assert.equal(gl[0], '-', 'guest: no founder crown');
    assert.equal(gl[4], '-', 'guest: no throne');
    assert.notEqual(gl[2], '-', 'guest keeps the ordinary cloak');
    const reg = await sign('Plain_One');
    lobby.handle(reg.p, join({ build: { spec: 'frost', talents: [], gear } }));
    assert.equal(lookOf(reg.p)[0], '-', 'ordinary account: stripped');
    const owner = await sign('Toke');
    lobby.handle(owner.p, join({ build: { spec: 'frost', talents: [], gear } }));
    assert.notEqual(lookOf(owner.p)[0], '-', 'owner keeps the founder crown');
    assert.notEqual(lookOf(owner.p)[4], '-');
  });

  it('a finished match earns progress and issues a new signed token; forfeits and dummies earn nothing', () => {
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 });
    const sock = fakeSocket();
    const p = lobby.connect(sock);
    lobby.handle(p, join({ build: { spec: 'frost', talents: [], gear: {} } }));
    const room: any = p.room;
    const foe = [...room.sim.units.values()].find((u: any) => u.team === 1);
    for (let i = 0; i < 3; i++) lobby.tick();
    room.sim.forfeit(foe.id);
    for (let i = 0; i < 3; i++) lobby.tick();
    const profiles = sock.sent.filter((m: ServerMsg) => m.t === 'profile');
    assert.equal(profiles.length, 2);
    const last = profiles.at(-1) as any;
    assert.equal(last.matches, 1);
    assert.equal(last.wins, 1);
    assert.deepEqual(verifyProfile(last.token), { matches: 1, wins: 1 });
    // credited once only
    for (let i = 0; i < 10; i++) lobby.tick();
    assert.equal(sock.sent.filter((m: ServerMsg) => m.t === 'profile').length, 2);

    // dummies never count
    const s2 = fakeSocket();
    const p2 = lobby.connect(s2);
    lobby.handle(p2, join({ difficulty: 'dummy' }));
    const room2: any = p2.room;
    for (let i = 0; i < 3; i++) lobby.tick();
    room2.sim.forfeit([...room2.sim.units.values()].find((u: any) => u.team === 1).id);
    for (let i = 0; i < 5; i++) lobby.tick();
    assert.equal(s2.sent.filter((m: ServerMsg) => m.t === 'profile').length, 1);

    // leaving early (forfeit) earns nothing
    const s3 = fakeSocket();
    const p3 = lobby.connect(s3);
    lobby.handle(p3, join());
    for (let i = 0; i < 3; i++) lobby.tick();
    lobby.disconnect(p3);
    for (let i = 0; i < 5; i++) lobby.tick();
    assert.equal(s3.sent.filter((m: ServerMsg) => m.t === 'profile').length, 1);
  });
});
