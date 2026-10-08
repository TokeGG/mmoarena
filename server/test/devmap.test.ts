import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARENAS, ArenaSim, parseClientMsg, resolveCollisions } from '@arena/shared';
import type { ClientMsg, ServerMsg } from '@arena/shared';
import { MemoryStore } from '../src/store';
import { Accounts } from '../src/accounts';
import { Lobby } from '../src/rooms';

const CODE = 'map-code';
const mkP = (name: string, out: ServerMsg[], account: any) => ({ ws: { readyState: 1, send: (s: string) => out.push(JSON.parse(s)), bufferedAmount: 0 } as any, name, classId: 'mage', matches: 0, wins: 0, size: 1, ip: '1.1.1.1', mapPref: 'random', account, ownerOk: false } as any);
const last = <T extends ServerMsg['t']>(out: ServerMsg[], t: T) => [...out].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;

async function world() {
  const a = new Accounts(new MemoryStore(), CODE);
  const toke = (await a.register('Toke', 'hunter22', '1.1.1.1', CODE)) as any;
  const dee = (await a.register('Dee', 'hunter22', '2.2.2.2')) as any;
  const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 }, a);
  const outO: ServerMsg[] = [];
  const outD: ServerMsg[] = [];
  const owner = mkP('Toke', outO, toke.account);
  owner.ownerOk = true;
  const devP = mkP('Dee', outD, { ...dee.account, grants: ['dev'] });
  for (const p of [owner, devP]) (lobby as any).conns.add(p);
  return { lobby, owner, devP, outO, outD };
}
const join = (lobby: Lobby, p: any, size = 2) => lobby.handle(p, { t: 'join', name: p.name, classId: 'mage', mode: 'practice', difficulty: 'normal', size, map: 'colosseum' } as ClientMsg);
const atSpawns = (room: any) => {
  const slots = new Map<number, number>();
  for (const u of room.sim.units.values()) {
    const i = slots.get(u.team) ?? 0;
    slots.set(u.team, i + 1);
    const sp = room.sim.arena.spawns[u.team];
    const s = sp[i % sp.length];
    assert.deepEqual({ x: u.pos.x, z: u.pos.z }, { x: s.x, z: s.z }, `unit ${u.id} at its spawn`);
    assert.equal(u.facing, room.sim.arena.spawnFacing[u.team]);
  }
};

describe('dev map swap', () => {
  it('parses only known arena ids', () => {
    assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'dev_map', id: ARENAS[1].id })), { t: 'dev_map', id: ARENAS[1].id });
    assert.equal(parseClientMsg(JSON.stringify({ t: 'dev_map', id: 'nowhere' })), null);
    assert.equal(parseClientMsg(JSON.stringify({ t: 'dev_map', id: 5 })), null);
    assert.equal(parseClientMsg(JSON.stringify({ t: 'dev_map' })), null);
  });

  it('the owner swaps the map paused: spawns, builds, bots and numbers stay, everyone is told', async () => {
    const { lobby, owner, outO } = await world();
    join(lobby, owner);
    const room = owner.room;
    const from = room.arenaId;
    const to = ARENAS.find((a) => a.id !== from)!;
    lobby.handle(owner, { t: 'dev_pause', on: true } as ClientMsg);
    lobby.handle(owner, { t: 'dev_patch', patches: [{ file: 'abilities', id: 'fireball', path: ['cooldown'], value: 2000 }] } as ClientMsg);
    const before = [...room.sim.units.values()].map((u: any) => ({ id: u.id, classId: u.classId, spec: u.spec, talents: [...u.talents], bar: [...u.bar], controller: u.controller, name: u.name }));
    const bots = room.bots.length;
    assert.ok(bots > 0);
    lobby.handle(owner, { t: 'dev_map', id: to.id } as ClientMsg);
    assert.equal(room.arenaId, to.id);
    assert.equal(room.sim.arena, to);
    assert.equal(room.paused, true, 'still paused');
    assert.equal(room.devTest, true);
    assert.equal(room.bots.length, bots);
    assert.deepEqual(room.devPatches.map((p: any) => p.value), [2000]);
    assert.deepEqual([...room.sim.units.values()].map((u: any) => ({ id: u.id, classId: u.classId, spec: u.spec, talents: [...u.talents], bar: [...u.bar], controller: u.controller, name: u.name })), before);
    atSpawns(room);
    assert.equal(last(outO, 'dev_map')?.map, to.id);
    assert.equal(last(outO, 'notice')?.text, `Map: ${to.name}`);
    // paused snapshots keep flowing so the client sees the new positions
    outO.length = 0;
    for (let i = 0; i < 6; i++) lobby.tick();
    assert.ok(outO.some((m) => m.t === 'snapshot' && m.snap.paused));
    // watchers are told too, and the live list shows the new map
    assert.equal(room.live().map, to.id);
  });

  it('spectators of the room get the swap', async () => {
    const { lobby, owner, devP, outD } = await world();
    join(lobby, devP);
    const room = devP.room;
    owner.ownerOk = true;
    room.addSpectator(owner);
    const outO = owner.ws as any;
    const got: ServerMsg[] = [];
    outO.send = (s: string) => got.push(JSON.parse(s));
    const to = ARENAS.find((a) => a.id !== room.arenaId)!;
    lobby.handle(owner, { t: 'dev_map', id: to.id } as ClientMsg);
    assert.equal(room.arenaId, to.id);
    assert.equal(last(outD, 'dev_map')?.map, to.id, 'the player is told');
    assert.equal(last(got, 'dev_map')?.map, to.id, 'the watcher is told');
  });

  it('a dev (not only the owner) swaps the map; refused outside a match and for unknown maps', async () => {
    const { lobby, owner, devP, outD, outO } = await world();
    join(lobby, devP);
    const room = devP.room;
    const from = room.arenaId;
    const other = ARENAS.find((a) => a.id !== from)!.id;
    lobby.handle(devP, { t: 'dev_map', id: other } as ClientMsg);
    assert.equal(room.arenaId, other, 'a dev can change the map of their own test match');
    assert.equal(last(outD, 'dev_map')?.map, other);
    // no match at all
    lobby.handle(owner, { t: 'dev_map', id: other } as ClientMsg);
    assert.equal(last(outO, 'dev_result')?.ok, false);
    // unknown id (it never gets past the parser, and the handler refuses it too)
    join(lobby, owner);
    const mine = owner.room;
    const was = mine.arenaId;
    lobby.handle(owner, { t: 'dev_map', id: 'nowhere' } as ClientMsg);
    assert.equal(mine.arenaId, was);
    assert.equal(last(outO, 'dev_result')?.ok, false);
  });

  it('is refused in a ranked room for a dev tag holder', async () => {
    const { lobby, devP } = await world();
    const ranked: any = (lobby as any).makeRoom(0, true, true, 'colosseum');
    (lobby as any).rooms.add(ranked);
    ranked.addPlayer(devP, 0);
    const to = ARENAS.find((a) => a.id !== 'colosseum')!.id;
    lobby.handle(devP, { t: 'dev_map', id: to } as ClientMsg);
    assert.equal(ranked.arenaId, 'colosseum');
    assert.equal(ranked.devTest, false);
  });

  it('swapping through every arena keeps the match steppable, nobody in a wall', async () => {
    const { lobby, owner } = await world();
    join(lobby, owner, 3);
    const room = owner.room;
    for (const a of [...ARENAS, ARENAS[0]]) {
      lobby.handle(owner, { t: 'dev_map', id: a.id } as ClientMsg);
      assert.equal(room.sim.arena, a);
      atSpawns(room);
      for (const u of room.sim.units.values()) {
        const r = resolveCollisions({ x: u.pos.x, z: u.pos.z }, a, 0);
        assert.ok(Math.hypot(r.x - u.pos.x, r.z - u.pos.z) < 1e-6, `${a.id}: unit ${u.id} spawns clear of walls`);
      }
      for (let i = 0; i < 150; i++) lobby.tick();
      for (const u of room.sim.units.values()) assert.ok(Number.isFinite(u.pos.x) && Number.isFinite(u.pos.z));
    }
    assert.equal(room.closed, false);
  });

  it('ArenaSim.switchArena moves dummies home too', () => {
    const sim = new ArenaSim({ prepMs: 0, seed: 1, arena: ARENAS[0], facing: true });
    sim.addUnit({ name: 'Me', classId: 'mage', team: 0 });
    const d = sim.addUnit({ name: 'Dummy', classId: 'warrior', team: 1, controller: 'dummy' });
    const to = ARENAS[1];
    sim.switchArena(to);
    assert.equal(sim.arena, to);
    assert.deepEqual(d.home, { x: to.spawns[1][0].x, z: to.spawns[1][0].z });
    assert.deepEqual({ x: d.pos.x, z: d.pos.z }, d.home);
    for (let i = 0; i < 100; i++) sim.step();
  });
});
