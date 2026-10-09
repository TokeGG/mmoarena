import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BOT_NAMES, parseClientMsg, pickBotName, validateBotNames } from '@arena/shared';
import type { ClientMsg, ServerMsg } from '@arena/shared';
import { MemoryStore } from '../src/store';
import { Accounts } from '../src/accounts';
import { Lobby } from '../src/rooms';
import { AdminLog } from '../src/adminlog';

const CODE = 'bot-names-code';
const tick = () => new Promise((r) => setTimeout(r, 25));
const mkWs = (out: ServerMsg[]) => ({ readyState: 1, closed: false, send: (s: string) => out.push(JSON.parse(s)), close() { this.closed = true; }, bufferedAmount: 0 }) as any;
const mkP = (name: string, out: ServerMsg[], account: any, ip: string) =>
  ({ ws: mkWs(out), name, classId: 'mage', matches: 0, wins: 0, size: 1, ip, mapPref: 'random', account, ownerOk: false, since: Date.now(), chain: Promise.resolve(), pending: 0 }) as any;
const last = <T extends ServerMsg['t']>(out: ServerMsg[], t: T) => [...out].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;
const handle = (lobby: Lobby, p: any, m: unknown) => lobby.handle(p, m as ClientMsg);
const mkLobby = (a: Accounts, log: AdminLog) => new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 }, a, undefined, undefined, undefined, log);

async function world(store = new MemoryStore()) {
  const a = new Accounts(store, CODE);
  const boss = (await a.register('Boss', 'hunter22', '1.1.1.1', CODE)) as any;
  const dee = (await a.register('Dee', 'hunter22', '2.2.2.2')) as any;
  const granted = await a.adminSet('Dee', { grants: ['dev'] } as any);
  const log = new AdminLog(store);
  const lobby = mkLobby(a, log);
  const out = { owner: [] as ServerMsg[], dev: [] as ServerMsg[], bob: [] as ServerMsg[] };
  const owner = mkP('Boss', out.owner, boss.account, '11.11.11.11');
  owner.ownerOk = true;
  const devP = mkP('Dee', out.dev, granted.ok ? granted.account : dee.account, '22.22.22.22');
  const bobP = mkP('Bob', out.bob, undefined, '33.33.33.33');
  for (const p of [owner, devP, bobP]) (lobby as any).conns.add(p);
  return { lobby, log, store, a, owner, devP, bobP, out };
}

const fight = (lobby: Lobby, owner: any, per: number) => {
  const side = Array.from({ length: per }, () => ({ classId: 'mage' }));
  handle(lobby, owner, { t: 'bot_match', size: per, difficulty: 'normal', teams: [side, side.map((b) => ({ ...b }))] });
  return [...(lobby as any).rooms][0] as any;
};
const unitNames = (room: any): string[] => [...room.sim.units.values()].map((u: any) => u.name);

describe('bot names (validation and picking)', () => {
  const table: [string, unknown, string | null][] = [
    ['valid', ['Alpha', 'Be_ta', 'Ga-mma9'], null],
    ['empty list', [], 'at least one'],
    ['only blanks', ['  ', ''], 'at least one'],
    ['too short', ['A'], 'characters'],
    ['too long', ['A'.repeat(17)], 'characters'],
    ['bad characters', ['Hi there'], 'letters, digits'],
    ['Bot prefix', ['BotKing'], 'Bot or Dummy'],
    ['Dummy prefix', ['dummyone'], 'Bot or Dummy'],
    ['duplicate ignoring case', ['Zed', 'zED'], 'twice'],
    ['25 names', Array.from({ length: 25 }, (_, i) => `Name${i}`), 'At most'],
    ['not an array', 'Alpha', 'one per line'],
    ['non-string entry', ['Alpha', 5], 'one per line'],
  ];
  for (const [label, input, err] of table) {
    it(label, () => {
      const v = validateBotNames(input);
      if (err === null) assert.equal(v.ok, true);
      else assert.ok(!v.ok && v.error.includes(err), JSON.stringify(v));
    });
  }
  it('trims names and ignores blank lines', () => {
    assert.deepEqual(validateBotNames([' Alpha ', '', 'Beta']), { ok: true, names: ['Alpha', 'Beta'] });
  });
  it('picks unused names first, then numbers them', () => {
    const taken = new Set<string>();
    const got: string[] = [];
    for (let i = 0; i < 5; i++) {
      const n = pickBotName(['Aa', 'Bb'], taken);
      taken.add(n);
      got.push(n);
    }
    assert.deepEqual(got.slice(0, 2).sort(), ['Bot Aa', 'Bot Bb']);
    assert.deepEqual(got.slice(2, 4).sort(), ['Bot Aa 2', 'Bot Bb 2']);
    assert.match(got[4], /^Bot (Aa|Bb) 3$/);
  });
  it('the parser keeps read, reset and save apart', () => {
    assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'admin_botnames' })), { t: 'admin_botnames' });
    assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'admin_botnames', names: null })), { t: 'admin_botnames', names: null });
    assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'admin_botnames', names: ['Aa'] })), { t: 'admin_botnames', names: ['Aa'] });
    assert.equal(parseClientMsg(JSON.stringify({ t: 'admin_botnames', names: [1] })), null);
  });
});

describe('bots in a match', () => {
  it('are named Bot <Name> from the built-in list, unique, with the spec as title in the roster', async () => {
    const { lobby, owner } = await world();
    const room = fight(lobby, owner, 3);
    const names = unitNames(room);
    assert.equal(names.length, 6);
    assert.equal(new Set(names).size, 6, 'unique');
    for (const n of names) assert.ok(DEFAULT_BOT_NAMES.some((d) => n === `Bot ${d}`), n);
    const roster = room.roster();
    assert.equal(roster.length, 6);
    for (const r of roster) {
      assert.equal(r.emblem, '🤖');
      assert.equal(r.color, '');
      assert.ok(r.title.length > 0);
    }
  });

  it('use the owner\'s list, numbering names when the list is shorter than the match', async () => {
    const { lobby, owner, out } = await world();
    handle(lobby, owner, { t: 'admin_botnames', names: ['Qq', 'Ww'] });
    await tick();
    assert.deepEqual(last(out.owner, 'botnames')!.names, ['Qq', 'Ww']);
    const names = unitNames(fight(lobby, owner, 2));
    assert.equal(new Set(names).size, 4);
    assert.equal(names.filter((n) => /^Bot (Qq|Ww)$/.test(n)).length, 2);
    assert.equal(names.filter((n) => /^Bot (Qq|Ww) 2$/.test(n)).length, 2);
  });

  it('dummies keep Dummy names and stay out of the roster; a rebuilt bot keeps its name and its title follows the spec', async () => {
    const { lobby, owner } = await world();
    const room = fight(lobby, owner, 1);
    room.addNpc('warrior', 1, 'dummy');
    const dummy = [...room.sim.units.values()].find((u: any) => u.controller === 'dummy') as any;
    assert.equal(dummy.name, 'Dummy Warrior');
    assert.ok(!room.roster().some((r: any) => r.unitId === dummy.id));
    const bot = [...room.sim.units.values()].find((u: any) => u.controller === 'bot') as any;
    const before = bot.name;
    const was = room.roster().find((r: any) => r.unitId === bot.id).title;
    assert.ok(room.devRebuild(bot.id, 'warrior', { spec: 'arms', talents: [] } as any));
    assert.equal(bot.name, before);
    const now = room.roster().find((r: any) => r.unitId === bot.id).title;
    assert.notEqual(now, was);
  });

  it('an old replay roster without bots stays readable', () => {
    const old = [{ unitId: 1, emblem: '⚔', title: 'Rookie', color: '#fff', rating: 1000 }];
    const m = new Map(old.map((p) => [p.unitId, p]));
    assert.equal(m.get(2), undefined);
    assert.equal(m.get(1)!.title, 'Rookie');
  });
});

describe('the owner-only bot name list', () => {
  it('a dev is refused and a player ignored; neither receives it', async () => {
    const { lobby, store, devP, bobP, out } = await world();
    handle(lobby, devP, { t: 'admin_botnames', names: ['Evil'] });
    handle(lobby, devP, { t: 'admin_botnames' });
    handle(lobby, bobP, { t: 'admin_botnames', names: ['Evil'] });
    handle(lobby, bobP, { t: 'admin_botnames' });
    await tick();
    assert.match(last(out.dev, 'dev_result')!.text, /owner only/);
    assert.equal(last(out.dev, 'botnames'), undefined);
    assert.equal(last(out.bob, 'botnames'), undefined);
    assert.equal(await store.get('botnames'), null);
  });

  it('the owner reads, saves (logged), is refused bad lists, and resets', async () => {
    const { lobby, log, store, owner, out } = await world();
    handle(lobby, owner, { t: 'admin_botnames' });
    await tick();
    assert.deepEqual(last(out.owner, 'botnames')!.names, [...DEFAULT_BOT_NAMES]);
    assert.equal(last(out.owner, 'botnames')!.custom, false);
    handle(lobby, owner, { t: 'admin_botnames', names: ['Aa', 'Aa'] });
    await tick();
    assert.match(last(out.owner, 'botnames')!.error!, /twice/);
    assert.equal(await store.get('botnames'), null);
    handle(lobby, owner, { t: 'admin_botnames', names: ['Aa', 'Bb'] });
    await tick();
    assert.deepEqual(JSON.parse((await store.get('botnames'))!), ['Aa', 'Bb']);
    assert.equal((await log.list())[0].action, 'bot names changed');
    handle(lobby, owner, { t: 'admin_botnames', names: null });
    await tick();
    assert.equal(await store.get('botnames'), null);
    assert.equal(last(out.owner, 'botnames')!.custom, false);
  });

  it('survives a lobby restart', async () => {
    const w = await world();
    handle(w.lobby, w.owner, { t: 'admin_botnames', names: ['Persisted'] });
    await tick();
    const lobby2 = mkLobby(w.a, new AdminLog(w.store));
    await tick();
    assert.deepEqual((lobby2 as any).botNames, ['Persisted']);
  });
});
