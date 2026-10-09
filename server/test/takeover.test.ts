import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { Accounts } from '../src/accounts';
import { MemoryStore } from '../src/store';
import { Lobby } from '../src/rooms';
import { ReplayRunner, parseClientMsg } from '@arena/shared';
import type { ClientMsg, ReplayData, ServerMsg } from '@arena/shared';

const sock = () => {
  const sent: ServerMsg[] = [];
  return { readyState: 1, sent, send(d: string) { sent.push(JSON.parse(d)); } } as any;
};
const until = async (cond: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(await cond(), 'timed out');
};
const types = (s: any, from = 0) => new Set((s.sent as ServerMsg[]).slice(from).map((m) => m.t));

/** A practice match (one person against bots), a watcher, and the owner's connection, with a learner that only records what it is told. */
async function setup(opts: { difficulty?: string; size?: 1 | 2 } = {}) {
  const accounts = new Accounts(new MemoryStore());
  const calls: string[] = [];
  const learner: any = {
    pick: () => null,
    report: () => calls.push('report'),
    learnFrom: async () => void calls.push('learnFrom'),
    trainOn: async () => void calls.push('trainOn'),
  };
  const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 }, accounts, learner);
  const reg = async (name: string) => {
    const s = sock();
    const p = lobby.connect(s, '5.5.5.5');
    lobby.handle(p, { t: 'register', name, password: 'password1' } as ClientMsg);
    await until(() => s.sent.some((m: ServerMsg) => m.t === 'account'));
    return { s, p };
  };
  const human = await reg('Hum');
  const owner = await reg('Own');
  owner.p.ownerOk = true;
  const dev = await reg('Dev');
  dev.p.account = { ...dev.p.account!, grants: ['dev'] };
  const fan = await reg('Fan');
  lobby.handle(human.p, { t: 'join', name: 'x', classId: 'mage', mode: 'practice', size: opts.size ?? 1, difficulty: opts.difficulty ?? 'normal' } as ClientMsg);
  const room: any = human.p.room;
  assert.ok(room, 'practice started');
  const bots = [...room.sim.units.values()].filter((u: any) => u.controller === 'bot');
  return { accounts, lobby, calls, human, owner, dev, fan, room, bots, unit: bots[0] };
}
const takeover = (t: Awaited<ReturnType<typeof setup>>, who = t.owner, unit = t.unit?.id ?? 1) => t.lobby.handle(who.p, { t: 'admin_takeover', id: t.room.id, unit } as ClientMsg);

describe('owner takeover of a bot', () => {
  it('the new messages are checked on the way in', () => {
    assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'admin_takeover', id: 'abcdef012345', unit: 3 })), { t: 'admin_takeover', id: 'abcdef012345', unit: 3 });
    assert.equal(parseClientMsg(JSON.stringify({ t: 'admin_takeover', id: '../x', unit: 3 })), null);
    assert.equal(parseClientMsg(JSON.stringify({ t: 'admin_takeover', id: 'abcdef012345', unit: 'a' })), null);
    assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'admin_release' })), { t: 'admin_release' });
  });


  it('is for the owner only: the dev tag and a normal player get nothing, and a match without a bot refuses', async () => {
    const t = await setup();
    for (const who of [t.dev, t.fan]) {
      const n = who.s.sent.length;
      takeover(t, who);
      assert.equal(who.s.sent.length, n, 'nothing comes back, the feature is not there for them');
      assert.equal(who.p.ctl, undefined);
    }
    assert.equal(t.room.bots.length, t.bots.length, 'the bot still plays');
    assert.equal(t.room.tookOver, false);

    const d = await setup({ difficulty: 'dummy' });
    takeover(d);
    const m = d.owner.s.sent.at(-1) as any;
    assert.equal(m.t, 'dev_result');
    assert.equal(m.ok, false);
    assert.equal(d.owner.p.ctl, undefined);
    // a human unit and an unknown unit are refused too
    takeover(t, t.owner, t.human.p.unitId!);
    assert.equal((t.owner.s.sent.at(-1) as any).ok, false);
    takeover(t, t.owner, 999);
    assert.equal((t.owner.s.sent.at(-1) as any).ok, false);
    assert.equal(t.owner.p.ctl, undefined);
  });

  it('moves the unit to the owner: inputs and casts drive it, the bot stops, nobody else hears of it', async () => {
    const t = await setup();
    const room = t.room;
    for (let i = 0; i < 5; i++) t.lobby.tick();
    // a watcher, before and after
    const watcher = t.fan;
    t.lobby.handle(watcher.p, { t: 'spectate', id: room.id } as ClientMsg);
    const flat = (o: any) => JSON.stringify({ ...o, elapsedMs: 0 });
    const before = { builds: JSON.stringify(room.builds()), live: flat(room.live()), row: flat(room.adminRow()), roster: JSON.stringify(room.roster()) };
    const hn = t.human.s.sent.length;
    const wn = watcher.s.sent.length;

    takeover(t);
    const ctrl = t.owner.s.sent.find((m: ServerMsg) => m.t === 'controlling') as any;
    assert.ok(ctrl, 'the owner is told');
    assert.equal(ctrl.unitId, t.unit.id);
    assert.equal(ctrl.team, t.unit.team);
    assert.equal(ctrl.classId, t.unit.classId);
    assert.equal(room.spectators.has(t.owner.p), false, 'not a spectator any more');
    assert.equal(room.bots.some((b: any) => b.unitId === t.unit.id), false, 'the bot is stopped');
    assert.equal(room.players.has(t.unit.id), false, 'and the unit is not a human slot');

    // idle owner: the unit does not act on its own
    const u = room.sim.units.get(t.unit.id);
    const start = { x: u.pos.x, z: u.pos.z };
    for (let i = 0; i < 40; i++) t.lobby.tick();
    assert.ok(Math.hypot(u.pos.x - start.x, u.pos.z - start.z) < 1.5, 'nobody moves it');
    // the owner's input is that unit's input
    for (let i = 0; i < 20; i++) {
      t.lobby.handle(t.owner.p, { t: 'input', seq: i + 1, fwd: 1, strafe: 0, facing: u.facing } as ClientMsg);
      t.lobby.tick();
    }
    assert.ok(Math.hypot(u.pos.x - start.x, u.pos.z - start.z) > 2, 'the owner moves it');
    // owner snapshots follow the team's view
    const snaps = t.owner.s.sent.filter((m: ServerMsg) => m.t === 'snapshot') as any[];
    assert.ok(snaps.length >= 50);
    assert.ok(snaps.at(-1).snap.units.some((x: any) => x.id === t.unit.id));
    const mine = t.owner.s.sent.filter((m: ServerMsg) => m.t === 'snapshot').length;
    t.lobby.handle(t.owner.p, { t: 'target', id: t.human.p.unitId! } as ClientMsg);
    assert.equal(room.sim.units.get(t.unit.id).target, t.human.p.unitId);
    assert.ok(mine > 0);

    // nothing the others get shows it
    assert.equal(JSON.stringify(room.builds()), before.builds);
    assert.equal(flat(room.live()), before.live);
    assert.equal(JSON.stringify(room.roster()), before.roster);
    const row = JSON.parse(JSON.stringify(room.adminRow()));
    assert.equal(row.players.find((p: any) => p.name === t.unit.name).human, false, 'still a bot in the list');
    assert.equal(flat(room.adminRow()), before.row);
    assert.ok(![...types(t.human.s, hn)].some((x) => x !== 'snapshot' && x !== 'stats'), `the player only gets frames, got ${[...types(t.human.s, hn)]}`);
    assert.ok(![...types(watcher.s, wn)].some((x) => x !== 'snapshot' && x !== 'stats'), `a watcher only gets frames, got ${[...types(watcher.s, wn)]}`);
    // the owner's own row is the only one marking it
    t.lobby.handle(t.owner.p, { t: 'admin_overview' } as ClientMsg);
    const ov: any = t.owner.s.sent.filter((m: ServerMsg) => m.t === 'admin_overview').at(-1);
    assert.equal(ov.rooms.find((r: any) => r.id === room.id).youControl, t.unit.id);
    t.lobby.handle(t.dev.p, { t: 'admin_overview' } as ClientMsg);
    const dov: any = t.dev.s.sent.filter((m: ServerMsg) => m.t === 'admin_overview').at(-1);
    const drow = dov.rooms.find((r: any) => r.id === room.id);
    assert.equal(drow.youControl, undefined);
    assert.ok(drow.players.every((p: any) => p.id === undefined && p.bot === undefined), 'a dev sees no unit ids');
  });

  it('release (button, Leave, disconnect, match end) gives the unit to a fresh bot at once', async () => {
    const t = await setup();
    const room = t.room;
    const act = () => {
      const u = room.sim.units.get(t.unit.id);
      const a = { x: u.pos.x, z: u.pos.z };
      for (let i = 0; i < 80; i++) t.lobby.tick();
      return Math.hypot(u.pos.x - a.x, u.pos.z - a.z) > 1 || u.cast !== null || [...room.sim.units.values()].some((x: any) => x.team !== u.team && x.health < x.maxHealth);
    };
    takeover(t);
    assert.ok(t.owner.p.ctl);
    t.lobby.handle(t.owner.p, { t: 'admin_release' } as ClientMsg);
    assert.equal(t.owner.p.ctl, undefined);
    assert.equal(room.bots.filter((b: any) => b.unitId === t.unit.id).length, 1, 'a bot plays it again');
    assert.ok(room.spectators.has(t.owner.p), 'the owner is back to watching');
    assert.ok(t.owner.s.sent.some((m: ServerMsg) => m.t === 'spectating'));
    assert.ok(act(), 'and it acts');

    // Leave while playing = hand back, still watching
    takeover(t);
    t.lobby.handle(t.owner.p, { t: 'leave' } as ClientMsg);
    assert.equal(t.owner.p.ctl, undefined);
    assert.ok(room.spectators.has(t.owner.p));
    assert.equal(room.bots.filter((b: any) => b.unitId === t.unit.id).length, 1);

    // closing the tab
    takeover(t);
    t.lobby.disconnect(t.owner.p);
    assert.equal(room.bots.filter((b: any) => b.unitId === t.unit.id).length, 1, 'a fresh bot after a disconnect');
    assert.equal(room.spectators.has(t.owner.p), false);

    // the match ending
    const t2 = await setup();
    takeover(t2);
    for (const u of t2.room.sim.units.values()) if (u.team !== t2.unit.team) t2.room.sim.forfeit(u.id);
    t2.lobby.tick();
    assert.equal(t2.owner.p.ctl, undefined);
    assert.equal(t2.room.bots.filter((b: any) => b.unitId === t2.unit.id).length, 1);
    assert.ok(t2.room.spectators.has(t2.owner.p));
  });

  it('the bots learn nothing from a match with a takeover, the owner earns nothing, and the others get a normal, valid record and replay', async () => {
    // control: the same match without a takeover does feed learning
    const base = await setup();
    for (let i = 0; i < 450; i++) base.lobby.tick();
    for (const u of base.room.sim.units.values()) if (u.controller !== 'player') base.room.sim.forfeit(u.id);
    for (let i = 0; i < 4; i++) base.lobby.tick();
    await until(async () => (await base.accounts.history('hum')).length === 1);
    assert.ok(base.calls.length > 0, 'a normal match is studied');

    const t = await setup();
    takeover(t);
    for (let i = 0; i < 450; i++) {
      t.lobby.handle(t.owner.p, { t: 'input', seq: i + 1, fwd: i % 100 < 50 ? 1 : 0, strafe: 0, facing: 1 } as ClientMsg);
      t.lobby.tick();
    }
    for (const u of t.room.sim.units.values()) if (u.controller !== 'player') t.room.sim.forfeit(u.id);
    for (let i = 0; i < 4; i++) t.lobby.tick();
    await until(async () => (await t.accounts.history('hum')).length === 1);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(t.calls, [], 'no outplay lessons, no graded signals, no study');
    assert.equal(t.room.devTest, false, 'not visibly a test match');
    const own = await t.accounts.history('own');
    assert.equal(own.length, 0, 'the owner has no history');
    assert.equal((t.owner.p.account as any).matches, 0, 'and no progress');
    const rec = (await t.accounts.history('hum'))[0];
    assert.equal(rec.players.filter((x) => x.human).length, 1);
    assert.equal(rec.players.length, base.room.realUnits().length);
    assert.equal(rec.replay, true);
    // the replay still replays to the same end, with the owner's inputs as that unit's
    const gz = await t.accounts.getReplay(rec.id);
    const data = JSON.parse(zlib.gunzipSync(gz!).toString()) as ReplayData;
    assert.ok(data.cmds.some((c) => c[1] === 0 && c[2] === t.unit.id && c[4] === 1), 'the owner moved that unit in the recording');
    assert.equal(data.units.find((_, i) => i + 1 === t.unit.id)?.controller, 'bot', 'it is a bot in the recording');
    const run = new ReplayRunner(data);
    run.seek(data.ticks);
    assert.equal(run.sim.winner, t.room.sim.winner);
    for (const [id, u] of t.room.sim.units) {
      const r = run.sim.units.get(id)!;
      assert.equal(r.health, u.health, `unit ${id} health`);
      assert.equal(r.alive, u.alive);
    }
  });
});
