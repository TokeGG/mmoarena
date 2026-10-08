import http from 'node:http';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../src/index';
import type { RunningServer } from '../src/index';
import type { ClientMsg, ServerMsg, Snapshot, UnitSnap } from '@arena/shared';
import { SnapMerger } from '@arena/shared';

class TestClient {
  ws: WebSocket;
  snap: Snapshot | null = null;
  errors: string[] = [];
  welcome: Extract<ServerMsg, { t: 'welcome' }> | null = null;
  events: any[] = [];
  seq = 0;
  private merger = new SnapMerger();
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMsg;
      if (m.t === 'welcome') this.welcome = m;
      else if (m.t === 'snapshot') {
        this.snap = this.merger.merge(m.snap, m.info);
        this.events.push(...m.events);
      } else if (m.t === 'error') this.errors.push(m.reason);
    });
  }
  open() {
    return new Promise<void>((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
  }
  send(m: ClientMsg) {
    this.ws.send(JSON.stringify(m));
  }
  me(): UnitSnap {
    return this.snap!.units.find((u) => u.id === this.welcome!.unitId)!;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(10);
  }
}

describe('server end to end', () => {
  let server: RunningServer;
  const clients: TestClient[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  after(async () => {
    for (const t of timers) clearInterval(t);
    for (const c of clients) c.ws.terminate();
    await server?.close();
  });

  it('practice match: walk into range, cast, take real server-side damage', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1', practicePrepMs: 200, staticDir: '/nonexistent' });
    const c = new TestClient(`ws://127.0.0.1:${server.port}/ws`);
    clients.push(c);
    await c.open();
    c.send({ t: 'join', name: 'Tester', classId: 'mage', mode: 'practice', map: 'colosseum' });
    await until(() => c.welcome !== null && c.snap !== null, 2000, 'welcome + first snapshot');
    assert.equal(c.welcome!.team, 0);
    assert.equal(c.snap!.units.length, 4);
    const enemy = c.snap!.units.find((u) => u.team === 1 && u.classId === 'warrior')!;

    // Casting before the gates open is refused by the server.
    c.send({ t: 'cast', ability: 'frostbolt', target: enemy.id });
    await until(() => c.errors.length > 0, 1000, 'prep-phase rejection');
    assert.match(c.errors[0], /not started/);

    await until(() => c.snap!.phase === 'live', 2000, 'live phase');

    // Stream inputs at 20 Hz toward +x until within frostbolt range (30y) of the enemy.
    const start = c.me().x;
    const ticker = setInterval(() => c.send({ t: 'input', seq: ++c.seq, fwd: 1, strafe: 0, facing: Math.PI / 2 }), 50);
    await until(() => enemy.x - c.me().x < 28, 6000, 'closing to range');
    clearInterval(ticker);
    assert.ok(c.me().x > start + 5, 'server moved us');
    assert.ok(c.me().lastSeq > 0, 'server acknowledges input sequence numbers');

    // Like the real client, keep streaming (idle) inputs so the server stops moving us. Casting while still
    // moving cancels the cast, which is the rule working as intended, not something to race against.
    const idle = setInterval(() => c.send({ t: 'input', seq: ++c.seq, fwd: 0, strafe: 0, facing: Math.PI / 2 }), 50);
    c.send({ t: 'target', id: enemy.id });
    await sleep(400);
    clearInterval(idle);
    timers.push(setInterval(() => c.send({ t: 'input', seq: ++c.seq, fwd: 0, strafe: 0, facing: Math.PI / 2 }), 50));
    c.send({ t: 'cast', ability: 'frostbolt', target: enemy.id });
    await until(() => c.me().cast !== null, 1000, 'cast starts');
    await until(() => c.events.some((e) => e.t === 'damage' && e.tgt === enemy.id), 3000, 'damage event');
    const after = c.snap!.units.find((u) => u.id === enemy.id)!;
    assert.ok(after.health < after.maxHealth, 'enemy lost health on the server');
    assert.ok(after.auras.some((a) => a.id === 'frostbolt_slow'));
    assert.ok(c.me().cooldowns.frostbolt === undefined, 'frostbolt has no cooldown');
  });

  it('a malformed URL gets a 400 and the server keeps running', async () => {
    const own = await startServer({ port: 0, host: '127.0.0.1', practicePrepMs: 200, staticDir: '/nonexistent' });
    const get = (path: string) =>
      new Promise<number>((ok, bad) => {
        const req = http.get({ host: '127.0.0.1', port: own.port, path, agent: false, headers: { connection: 'close' } }, (r) => {
          r.resume();
          ok(r.statusCode ?? 0);
        });
        req.on('error', bad);
      });
    assert.equal(await get('/avatar/%E0'), 400);
    assert.equal(await get('/healthz'), 200, 'still up');
    await own.close();
  });

  it('ignores garbage and cannot cast another class\'s ability', async () => {
    const c = new TestClient(`ws://127.0.0.1:${server.port}/ws`);
    clients.push(c);
    await c.open();
    c.ws.send('{{{ not json');
    c.ws.send(JSON.stringify({ t: 'cast', ability: 'mortal_strike' })); // before join: ignored
    c.send({ t: 'join', name: 'Cheat', classId: 'mage', mode: 'practice' });
    await until(() => c.snap !== null, 2000, 'snapshot');
    await until(() => c.snap!.phase === 'live', 2000, 'live');
    c.send({ t: 'cast', ability: 'mortal_strike', target: 3 });
    await until(() => c.errors.length > 0, 1000, 'rejection');
    assert.match(c.errors[0], /unknown ability/);
  });

  it('practice with bots: the enemy bot walks over and fights back through the normal rules', async () => {
    const c = new TestClient(`ws://127.0.0.1:${server.port}/ws`);
    clients.push(c);
    await c.open();
    c.send({ t: 'join', name: 'Bot Bait', classId: 'priest', mode: 'practice', foes: ['warrior'], ally: null, difficulty: 'hard' });
    await until(() => c.snap !== null, 2000, 'snapshot');
    assert.equal(c.snap!.units.length, 2, 'player plus one bot, no ally');
    const bot = c.snap!.units.find((u) => u.team === 1)!;
    assert.match(bot.name, /^Bot (Warbringer|Rampager|Barbarian)$/, 'named after its spec');
    const startX = bot.x;
    await until(() => c.snap!.phase === 'live', 2000, 'live');
    await until(() => Math.abs(c.snap!.units.find((u) => u.id === bot.id)!.x - startX) > 5, 4000, 'bot walks toward us');
    // Stand still and keep the bot company: it should reach melee and start hurting us (charge, hits, auto attacks).
    await until(() => c.me().health < c.me().maxHealth, 15000, 'bot damages the player');
    assert.ok(c.events.some((e) => e.t === 'damage' && e.src === bot.id && e.tgt === c.welcome!.unitId));
  });

  it('queue starts a 2v2 when four players are waiting', async () => {
    const group: TestClient[] = [];
    const classes = ['warrior', 'mage', 'priest', 'rogue'] as const;
    for (const cls of classes) {
      const c = new TestClient(`ws://127.0.0.1:${server.port}/ws`);
      clients.push(c);
      group.push(c);
      await c.open();
      c.send({ t: 'join', name: cls, classId: cls, mode: 'queue' });
    }
    await until(() => group.every((c) => c.snap !== null), 3000, 'match start');
    assert.deepEqual(group.map((c) => c.welcome!.team), [0, 0, 1, 1]);
    assert.equal(group[0].snap!.units.length, 4);
    // Everyone is in the same room.
    assert.equal(new Set(group.map((c) => c.snap!.units.map((u) => u.id).sort().join())).size, 1);
  });
});
