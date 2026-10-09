import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HUD_IDS, parseClientMsg } from '@arena/shared';
import type { ClientMsg, ServerMsg } from '@arena/shared';
import { MemoryStore } from '../src/store';
import { Accounts } from '../src/accounts';
import { Lobby } from '../src/rooms';
import { AdminLog, HUD_DEFAULT_KEY } from '../src/adminlog';

const CODE = 'hud-default-code';
const tick = () => new Promise((r) => setTimeout(r, 25));
const mkWs = (out: ServerMsg[]) => ({ readyState: 1, closed: false, send: (s: string) => out.push(JSON.parse(s)), close() { this.closed = true; }, bufferedAmount: 0 }) as any;
const mkP = (name: string, out: ServerMsg[], account: any, ip: string) =>
  ({ ws: mkWs(out), name, classId: 'mage', matches: 0, wins: 0, size: 1, ip, mapPref: 'random', account, ownerOk: false, since: Date.now(), chain: Promise.resolve(), pending: 0 }) as any;
const last = <T extends ServerMsg['t']>(out: ServerMsg[], t: T) => [...out].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;
const handle = (lobby: Lobby, p: any, m: unknown) => lobby.handle(p, m as ClientMsg);
const LAYOUT = { announce: { fx: 0.1, fy: 0.2, s: 1.2 }, builds: { fx: -0.3, fy: 0, s: 1, w: 300, h: 200 } };

async function world() {
  const store = new MemoryStore();
  const a = new Accounts(store, CODE);
  const toke = (await a.register('Toke', 'hunter22', '1.1.1.1', CODE)) as any;
  const dee = (await a.register('Dee', 'hunter22', '2.2.2.2')) as any;
  const granted = await a.adminSet('Dee', { grants: ['dev'] } as any);
  const log = new AdminLog(store);
  const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 }, a, undefined, undefined, undefined, log);
  const out = { owner: [] as ServerMsg[], dev: [] as ServerMsg[], bob: [] as ServerMsg[] };
  const owner = mkP('Toke', out.owner, toke.account, '11.11.11.11');
  owner.ownerOk = true;
  const devP = mkP('Dee', out.dev, granted.ok ? granted.account : dee.account, '22.22.22.22');
  const bobP = mkP('Bob', out.bob, undefined, '33.33.33.33');
  for (const p of [owner, devP, bobP]) (lobby as any).conns.add(p);
  return { lobby, log, store, owner, devP, bobP, out };
}

describe('the owner\'s default HUD layout', () => {
  it('only a connected owner can save it; it is stored, pushed to everyone and written in the admin log', async () => {
    const { lobby, log, store, owner, out } = await world();
    handle(lobby, owner, { t: 'admin_hud_default', layout: LAYOUT });
    await tick();
    const pushed = last(out.bob, 'hud_default')!;
    assert.deepEqual(pushed.layout, LAYOUT, 'a guest is told live');
    const stored = JSON.parse((await store.get(HUD_DEFAULT_KEY))!);
    assert.deepEqual(stored.layout, LAYOUT);
    assert.equal(stored.by, 'Toke');
    assert.deepEqual((await log.hudDefault())?.layout, LAYOUT);
    const rows = await log.list();
    assert.equal(rows[0].action, 'hud default saved');
    assert.match(rows[0].detail ?? '', /2 elements/);
  });

  it('a dev is refused, a normal player and a guest are ignored, and nothing is stored', async () => {
    const { lobby, store, devP, bobP, out } = await world();
    handle(lobby, devP, { t: 'admin_hud_default', layout: LAYOUT });
    handle(lobby, bobP, { t: 'admin_hud_default', layout: LAYOUT });
    await tick();
    assert.match(last(out.dev, 'dev_result')!.text, /for the owner only/);
    assert.equal(await store.get(HUD_DEFAULT_KEY), null);
    assert.equal(last(out.bob, 'hud_default'), undefined);
  });

  it('a guest who connects later receives it; removing it tells everyone and clears the store', async () => {
    const { lobby, log, store, owner, out } = await world();
    handle(lobby, owner, { t: 'admin_hud_default', layout: LAYOUT });
    await tick();
    const late: ServerMsg[] = [];
    lobby.connect(mkWs(late), '55.55.55.55');
    assert.deepEqual(last(late, 'hud_default')?.layout, LAYOUT, 'delivered on connect');
    handle(lobby, owner, { t: 'admin_hud_default', layout: null });
    await tick();
    assert.equal(last(out.bob, 'hud_default')?.layout, null);
    assert.equal(await store.get(HUD_DEFAULT_KEY), null);
    assert.equal((await log.list())[0].action, 'hud default removed');
    const later: ServerMsg[] = [];
    lobby.connect(mkWs(later), '66.66.66.66');
    assert.equal(last(later, 'hud_default'), undefined, 'nothing to send once removed');
  });

  it('survives a restart (read back from the store on start)', async () => {
    const { lobby, store, owner } = await world();
    handle(lobby, owner, { t: 'admin_hud_default', layout: LAYOUT });
    await tick();
    const again = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 }, undefined, undefined, undefined, undefined, new AdminLog(store));
    await tick();
    const out: ServerMsg[] = [];
    again.connect(mkWs(out), '77.77.77.77');
    assert.deepEqual(last(out, 'hud_default')?.layout, LAYOUT);
  });

  it('is validated: unknown elements dropped, values clamped, empty or oversized layouts refused', () => {
    const ok = parseClientMsg(JSON.stringify({ t: 'admin_hud_default', layout: { announce: { fx: 9, fy: 0, s: 9 }, bogus: { fx: 0, fy: 0, s: 1 } } })) as any;
    assert.deepEqual(ok.layout, { announce: { fx: 1, fy: 0, s: 1.6 } });
    assert.equal(parseClientMsg(JSON.stringify({ t: 'admin_hud_default', layout: { bogus: { fx: 0, fy: 0, s: 1 } } })), null, 'nothing usable');
    assert.equal(parseClientMsg(JSON.stringify({ t: 'admin_hud_default', layout: 'x' })), null);
    assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'admin_hud_default', layout: null })), { t: 'admin_hud_default', layout: null });
    const huge: Record<string, unknown> = { announce: { fx: 0, fy: 0, s: 1 } };
    for (let i = 0; i < 2000; i++) huge[`junk${i}`] = { fx: 0, fy: 0, s: 1 };
    assert.equal(parseClientMsg(JSON.stringify({ t: 'admin_hud_default', layout: huge })), null, 'size cap on the raw message');
  });

  it('a stored default always fits the size cap even with every element set', async () => {
    const { log } = await world();
    const all = Object.fromEntries(HUD_IDS.map((id) => [id, { fx: -0.123456, fy: 0.654321, s: 1.55, w: 1999, h: 1399 }]));
    assert.equal(await log.setHudDefault({ layout: all, at: 1, by: 'Toke' }), true);
    assert.equal(Object.keys((await log.hudDefault())!.layout).length, HUD_IDS.length);
    assert.equal(await log.setHudDefault({ layout: {}, at: 1, by: 'Toke' }), false, 'empty is not a default');
  });
});
