import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARENAS, ArenaSim, ReplayRecorder, ReplayRunner, arenaById, blankArena, copyArena, findArena, mapDisabled, parseClientMsg, registerCustomArenas, replayMapProblem } from '@arena/shared';
import type { ArenaDef, ReplayData, ServerMsg } from '@arena/shared';
import { MemoryStore } from '../src/store';
import { Accounts } from '../src/accounts';
import { CustomMaps } from '../src/custommaps';
import { Lobby, queuePref } from '../src/rooms';

const CODE = 'map-code';
const mkP = (name: string, out: ServerMsg[], account: unknown) => ({ ws: { readyState: 1, send: (s: string) => out.push(JSON.parse(s)), bufferedAmount: 0 }, name, classId: 'mage', matches: 0, wins: 0, size: 1, ip: '1.1.1.1', mapPref: 'random', account, ownerOk: false }) as any;
const last = <T extends ServerMsg['t']>(out: ServerMsg[], t: T) => [...out].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;
const tick = () => new Promise((r) => setTimeout(r, 20));
const good = (id = 'pit-fight', name = 'Pit fight'): ArenaDef => ({ ...blankArena(id, name), desc: 'A test arena.' });

async function world() {
  const store = new MemoryStore();
  const a = new Accounts(store, CODE);
  const toke = (await a.register('Toke', 'hunter22', '1.1.1.1', CODE)) as any;
  const dee = (await a.register('Dee', 'hunter22', '2.2.2.2')) as any;
  let lobby!: Lobby;
  const maps = new CustomMaps(store, undefined, (m) => lobby.customMapsChanged(m));
  lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 }, a, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, maps);
  const outO: ServerMsg[] = [];
  const outD: ServerMsg[] = [];
  const owner = mkP('Toke', outO, toke.account);
  owner.ownerOk = true;
  const devP = mkP('Dee', outD, { ...dee.account, grants: ['dev'] });
  for (const p of [owner, devP]) (lobby as any).conns.add(p);
  return { store, lobby, maps, owner, devP, outO, outD };
}

describe('CustomMaps storage', () => {
  it('saves, lists, updates, persists across a restart, and deletes', async () => {
    const store = new MemoryStore();
    const m = new CustomMaps(store);
    const r = await m.save('Toke', good());
    assert.equal(r.ok, true);
    assert.equal(findArena('pit-fight')?.name, 'Pit fight');
    assert.equal(m.list().length, 1);
    // update by id
    const u = await m.save('Toke', { ...good(), desc: 'Changed.' });
    assert.equal(u.ok, true);
    assert.equal(m.list().length, 1);
    assert.equal(findArena('pit-fight')?.desc, 'Changed.');
    // a fresh server reads it back from the store
    registerCustomArenas([]);
    const again = new CustomMaps(store);
    await again.ready;
    assert.equal(findArena('pit-fight')?.desc, 'Changed.');
    const d = await again.remove('Toke', 'pit-fight');
    assert.equal(d.ok, true);
    assert.equal(findArena('pit-fight'), undefined);
    assert.equal((await again.remove('Toke', 'pit-fight')).ok, false);
    registerCustomArenas([]);
  });

  it('refuses invalid, clashing, unwalkable maps and too many maps, and keeps what it had', async () => {
    const m = new CustomMaps(new MemoryStore());
    assert.equal((await m.save('T', good())).ok, true);
    const clash = await m.save('T', good('other-one', 'Pit fight'));
    assert.equal(clash.ok, false);
    assert.match(clash.text, /taken/);
    assert.equal((await m.save('T', { ...good(), id: 'colosseum' })).ok, false);
    assert.equal((await m.save('T', 'not a map')).ok, false);
    assert.equal((await m.save('T', { ...good('nan-map', 'Nan map'), bounds: { minX: NaN, maxX: 30, minZ: -20, maxZ: 20 } })).ok, false);
    const sealed = { ...good('sealed', 'Sealed pocket'), pillars: [], walls: [{ x0: -8, x1: 8, z0: -2, z1: -1 }, { x0: -8, x1: -7, z0: -10, z1: -1 }, { x0: 7, x1: 8, z0: -10, z1: -1 }, { x0: -8, x1: 8, z0: -11, z1: -10 }] };
    const s = await m.save('T', sealed);
    assert.equal(s.ok, false);
    assert.match(s.text, /cannot be walked to/);
    assert.equal(m.list().length, 1);
    registerCustomArenas([]);
  });

  it('a stored map that no longer passes the check is left out on load', async () => {
    const store = new MemoryStore();
    await store.set('custommaps', JSON.stringify([good(), { ...good('bad-one', 'Bad one'), bounds: { minX: 1, maxX: 2, minZ: 1, maxZ: 2 } }, 'junk']));
    const m = new CustomMaps(store);
    await m.ready;
    assert.deepEqual(m.list().map((x) => x.id), ['pit-fight']);
    registerCustomArenas([]);
  });

  it('is limited in count', async () => {
    const m = new CustomMaps(new MemoryStore());
    await m.ready;
    for (let i = 0; i < 40; i++) assert.equal((await m.save('T', good(`map-${i + 10}`, `Map number ${i}`))).ok, true, String(i));
    const over = await m.save('T', good('one-more', 'One more'));
    assert.equal(over.ok, false);
    assert.match(over.text, /Delete one first/);
    // updating an existing one is still fine
    assert.equal((await m.save('T', { ...good('map-10', 'Map number 0'), desc: 'again' })).ok, true);
    registerCustomArenas([]);
  });
});

describe('custom maps over the protocol', () => {
  it('parses the owner messages', () => {
    assert.deepEqual(parseClientMsg('{"t":"maps_list"}'), { t: 'maps_list' });
    assert.deepEqual(parseClientMsg('{"t":"map_delete","id":"x"}'), { t: 'map_delete', id: 'x' });
    assert.equal(parseClientMsg('{"t":"map_delete"}'), null);
    assert.equal(parseClientMsg('{"t":"map_save","map":"x"}'), null);
    assert.equal(parseClientMsg('{"t":"map_save","map":[]}'), null);
    assert.equal(parseClientMsg(JSON.stringify({ t: 'map_save', map: { junk: 'x'.repeat(30000) } })), null);
    assert.equal(parseClientMsg(JSON.stringify({ t: 'map_save', map: good() }))?.t, 'map_save');
  });

  it('the owner and devs can list, save, delete and switch maps off; a player can do none of it; everyone connected hears the change', async () => {
    const { lobby, owner, devP, outO, outD } = await world();
    const outP: ServerMsg[] = [];
    const player = mkP('Bob', outP, undefined);
    (lobby as any).conns.add(player);
    lobby.handle(player, { t: 'map_save', map: good() });
    lobby.handle(player, { t: 'map_enable', id: 'ruins', on: false });
    await tick();
    assert.equal(findArena('pit-fight'), undefined, 'a player cannot save');
    assert.equal(mapDisabled('ruins'), false, 'or switch a map off');
    lobby.handle(player, { t: 'maps_list' });
    assert.equal(last(outP, 'map_result'), undefined);

    lobby.handle(devP, { t: 'map_save', map: good() });
    await tick();
    assert.equal(last(outD, 'map_result')?.ok, true, 'a dev can save');
    assert.ok(findArena('pit-fight'));
    lobby.handle(devP, { t: 'map_enable', id: 'pit-fight', on: false });
    await tick();
    assert.equal(mapDisabled('pit-fight'), true, 'a dev can switch it off');
    lobby.handle(devP, { t: 'map_enable', id: 'pit-fight', on: true });
    await tick();
    lobby.handle(devP, { t: 'map_delete', id: 'pit-fight' });
    await tick();
    assert.equal(findArena('pit-fight'), undefined, 'a dev can delete');

    lobby.handle(owner, { t: 'map_save', map: good() });
    await tick();
    const res = last(outO, 'map_result')!;
    assert.equal(res.ok, true);
    assert.equal(res.id, 'pit-fight');
    assert.equal(last(outD, 'custom_maps')?.maps[0].id, 'pit-fight', 'the dev (any client) is told');

    // someone connecting later gets the list
    const outN: ServerMsg[] = [];
    const sock = { readyState: 1, send: (s: string) => outN.push(JSON.parse(s)) } as any;
    lobby.connect(sock, '9.9.9.9');
    assert.equal(last(outN, 'custom_maps')?.maps.length, 1);

    lobby.handle(owner, { t: 'map_delete', id: 'pit-fight' });
    await tick();
    assert.equal(findArena('pit-fight'), undefined);
    assert.deepEqual(last(outD, 'custom_maps')?.maps, []);
    // the answer for a refusal carries the reasons
    lobby.handle(owner, { t: 'map_save', map: { ...good(), id: 'colosseum' } });
    await tick();
    assert.equal(last(outO, 'map_result')?.ok, false);
    assert.match(last(outO, 'map_result')!.text, /built-in/);
  });

  it('a custom map can be played in practice and watched in a bot match, but never comes up in the queue or the random pool', async () => {
    const { lobby, owner, maps, outO } = await world();
    assert.equal((await maps.save('Toke', good())).ok, true);
    assert.equal(queuePref('pit-fight'), 'random');
    assert.equal(queuePref('ruins'), 'ruins');
    lobby.handle(owner, { t: 'join', name: 'Toke', classId: 'mage', mode: 'practice', map: 'pit-fight' });
    assert.equal(last(outO, 'welcome')?.map, 'pit-fight');
    const room = (lobby as any).rooms.values().next().value;
    assert.equal(room.sim.arena.id, 'pit-fight');
    lobby.handle(owner, { t: 'leave' } as any);
    // 200 random picks never land on it
    const { pickMap } = await import('../src/rooms');
    for (let i = 0; i < 200; i++) assert.notEqual(pickMap('random'), 'pit-fight');
    assert.equal(pickMap('pit-fight'), 'pit-fight', 'by name it works');
    assert.ok(ARENAS.every((a) => a.id !== 'pit-fight'));
    registerCustomArenas([]);
  });

  it('the owner can start a bot match on a custom map', async () => {
    const { lobby, owner, maps, outO } = await world();
    await maps.save('Toke', good());
    const teams = [[{ classId: 'mage' }], [{ classId: 'rogue' }]] as any;
    lobby.handle(owner, { t: 'bot_match', size: 1, teams, difficulty: 'hard', map: 'pit-fight' });
    assert.equal(last(outO, 'spectating')?.map, 'pit-fight');
    registerCustomArenas([]);
  });
});

describe('replays of custom maps', () => {
  it('a recording of a custom map is marked, a built-in one is not', async () => {
    const m = new CustomMaps(new MemoryStore());
    await m.save('T', good());
    const rec = (id: string) => {
      const sim = new ArenaSim({ seed: 1, prepMs: 0, arena: arenaById(id) });
      return new ReplayRecorder(sim, { arena: id, seed: 1, prepMs: 0 }).finish([]);
    };
    assert.equal(rec('pit-fight').custom, true);
    assert.equal(rec('ruins').custom, undefined);
    registerCustomArenas([]);
  });

  it('a replay of a deleted custom map says so instead of playing on the wrong map', async () => {
    const m = new CustomMaps(new MemoryStore());
    await m.save('T', good());
    const data = { v: 1, arena: 'pit-fight', custom: true, seed: 1, prepMs: 0, units: [], cmds: [], ticks: 0, hash: 'x' } as unknown as ReplayData;
    assert.equal(replayMapProblem(data), null);
    assert.doesNotThrow(() => new ReplayRunner(data));
    await m.remove('T', 'pit-fight');
    assert.match(replayMapProblem(data)!, /no longer exists/);
    assert.throws(() => new ReplayRunner(data), /no longer exists/);
    assert.equal(arenaById('pit-fight'), ARENAS[0]);
    // an old recording of an unknown built-in id keeps playing on the default map as before
    assert.equal(replayMapProblem({ arena: 'default' }), null);
    assert.equal(copyArena(ARENAS[0], 'x-copy', 'X copy').randomPool, undefined);
    registerCustomArenas([]);
  });
});

describe('switching maps off', () => {
  it('a switched-off map is not picked, not queued and not random; it stays off after a restart', async () => {
    const { MemoryStore } = await import('../src/store');
    const { pickMap, queuePref } = await import('../src/rooms');
    const { mapDisabled, setDisabledMaps } = await import('@arena/shared');
    const store = new MemoryStore();
    const m = new CustomMaps(store);
    assert.equal((await m.setAvailable('T', 'ruins', false)).ok, true);
    assert.equal(mapDisabled('ruins'), true);
    assert.notEqual(pickMap('ruins'), 'ruins');
    for (let i = 0; i < 200; i++) assert.notEqual(pickMap('random'), 'ruins');
    assert.equal(queuePref('ruins'), 'random');
    assert.equal((await m.setAvailable('T', 'nope', false)).ok, false);
    setDisabledMaps([]);
    const again = new CustomMaps(store);
    await again.ready;
    assert.equal(mapDisabled('ruins'), true, 'read back from the store');
    await again.setAvailable('T', 'ruins', true);
    assert.equal(pickMap('ruins'), 'ruins');
    setDisabledMaps([]);
  });
});
