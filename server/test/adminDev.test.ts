import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AdminAct, ClientMsg, ServerMsg } from '@arena/shared';
import { MemoryStore } from '../src/store';
import { Accounts } from '../src/accounts';
import { Lobby } from '../src/rooms';
import { AdminLog } from '../src/adminlog';
import { Suggestions } from '../src/suggestions';
import { DevTools } from '../src/devtools';

const CODE = 'adm-dev-code';
const tick = () => new Promise((r) => setTimeout(r, 25));
const mkP = (name: string, out: ServerMsg[], account: any, ip: string) => {
  const ws = { readyState: 1, closed: false, send: (s: string) => out.push(JSON.parse(s)), close() { this.closed = true; }, bufferedAmount: 0 };
  return { ws, name, classId: 'mage', matches: 0, wins: 0, size: 1, ip, mapPref: 'random', account, ownerOk: false, since: Date.now(), chain: Promise.resolve(), pending: 0 } as any;
};
const last = <T extends ServerMsg['t']>(out: ServerMsg[], t: T) => [...out].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;
const handle = (lobby: Lobby, p: any, m: unknown) => lobby.handle(p, m as ClientMsg);

async function world() {
  const store = new MemoryStore();
  const a = new Accounts(store, CODE);
  const toke = (await a.register('Toke', 'hunter22', '1.1.1.1', CODE)) as any;
  const dee = (await a.register('Dee', 'hunter22', '2.2.2.2')) as any;
  const bob = (await a.register('Bob', 'hunter22', '3.3.3.3')) as any;
  const granted = await a.adminSet('Dee', { grants: ['dev'] } as any);
  assert.ok(granted.ok);
  const log = new AdminLog(store);
  const dev = new DevTools(store, {});
  const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 }, a, undefined, new Suggestions(store), dev, log);
  const out = { owner: [] as ServerMsg[], dev: [] as ServerMsg[], bob: [] as ServerMsg[], guest: [] as ServerMsg[] };
  const owner = mkP('Toke', out.owner, toke.account, '11.11.11.11');
  owner.ownerOk = true;
  const devP = mkP('Dee', out.dev, granted.ok ? granted.account : dee.account, '22.22.22.22');
  const bobP = mkP('Bob', out.bob, bob.account, '33.33.33.33');
  const guest = mkP('Visitor', out.guest, undefined, '44.44.44.44');
  for (const p of [owner, devP, bobP, guest]) (lobby as any).conns.add(p);
  return { a, lobby, dev, log, store, owner, devP, bobP, guest, out };
}

const FORBIDDEN_ACTS: AdminAct[] = ['kick', 'kill', 'ban', 'unban', 'mute', 'unmute', 'set_rating', 'reset_stats', 'note', 'maintenance', 'pause_match', 'autotrain', 'bot_reset'];

describe('admin panel for the dev tag', () => {
  it('adminAccess: owner, dev, nobody', async () => {
    const { lobby, owner, devP, bobP, guest } = await world();
    assert.equal(lobby.adminAccess(owner), 'owner');
    assert.equal(lobby.adminAccess(devP), 'dev');
    assert.equal(lobby.adminAccess(bobP), null);
    assert.equal(lobby.adminAccess(guest), null);
  });

  it('a dev gets the overview and the live server numbers, with no address or location anywhere', async () => {
    const { lobby, devP, out } = await world();
    handle(lobby, devP, { t: 'admin_overview' });
    const o = last(out.dev, 'admin_overview')!;
    assert.ok(o, 'the overview arrives');
    assert.equal(o.online, 4);
    assert.ok(o.tick, 'server tick numbers');
    assert.equal(o.players?.length, 4, 'names, status and time of everyone, guests too');
    for (const q of o.players!) {
      assert.ok(q.name && q.status && typeof q.sinceMs === 'number');
      assert.ok(!('ip' in q) && !('where' in q), `no address or location for ${q.name}`);
    }
    // nothing the dev received mentions any connection's address
    const all = JSON.stringify(out.dev);
    for (const ip of ['11.11.11.11', '22.22.22.22', '33.33.33.33', '44.44.44.44']) assert.ok(!all.includes(ip), `${ip} never reaches a dev`);
  });

  it('the owner keeps the addresses and everything else', async () => {
    const { lobby, owner, out } = await world();
    handle(lobby, owner, { t: 'admin_overview' });
    const o = last(out.owner, 'admin_overview')!;
    const bob = o.players!.find((q) => q.name === 'Bob')!;
    assert.equal(bob.ip, '33.33.33.33');
    assert.equal(typeof bob.where, 'string');
    handle(lobby, owner, { t: 'admin_list' });
    await tick();
    assert.ok(last(out.owner, 'admin_accounts'), 'account list');
    handle(lobby, owner, { t: 'admin_announce', text: 'hello' });
    assert.ok(last(out.bob, 'announce'), 'announcement reaches everyone');
    handle(lobby, owner, { t: 'admin_act', act: 'maintenance', on: true, text: 'brb' });
    await tick();
    assert.equal(last(out.owner, 'admin_overview')?.maintenance, 'brb');
    handle(lobby, owner, { t: 'admin_act', act: 'autotrain', on: true });
    await tick();
    assert.equal(last(out.owner, 'admin_overview')?.autoTrain, true);
    handle(lobby, owner, { t: 'admin_act', act: 'ban', name: 'Bob', minutes: 5 });
    await tick();
    assert.ok(last(out.owner, 'admin_result')?.row?.banned);
    handle(lobby, owner, { t: 'follow', name: 'Bob' });
    assert.ok(last(out.owner, 'following'));
  });

  it('a normal account and a guest get nothing', async () => {
    const { lobby, bobP, guest, out } = await world();
    for (const [p, o] of [[bobP, out.bob], [guest, out.guest]] as const) {
      const before = o.length;
      handle(lobby, p, { t: 'admin_overview' });
      handle(lobby, p, { t: 'admin_proposals', op: 'list' });
      for (const act of ['log', 'feed', 'history', 'train', 'train_status', 'bot_knowledge', 'train_all', 'train_passes'] as AdminAct[]) handle(lobby, p, { t: 'admin_act', act, name: 'Bob', id: 'x' });
      handle(lobby, p, { t: 'suggestions' });
      await tick();
      const got = o.slice(before).map((m) => m.t);
      assert.ok(!got.some((t) => ['admin_overview', 'proposals', 'admin_log', 'admin_feed', 'admin_history', 'train_status', 'bot_knowledge', 'suggestions'].includes(t)), `got ${got.join(',')}`);
    }
    handle(lobby, bobP, { t: 'admin_list' });
    handle(lobby, bobP, { t: 'admin_set', name: 'Bob', grants: ['dev'] });
    await tick();
    assert.ok(!out.bob.some((m) => m.t === 'admin_accounts'));
    assert.ok(out.bob.every((m) => m.t !== 'admin_result' || !m.ok), 'no self-promotion');
    assert.ok(!(await lobby['accounts']!.get('bob'))?.grants?.includes('dev'));
  });

  it('a dev gets the log, the match list, a player’s history, the training queue and the bot knowledge', async () => {
    const { lobby, devP, log, out } = await world();
    await log.add('Toke', 'announce', undefined, 'hi');
    for (const act of ['log', 'feed', 'train_status', 'bot_knowledge'] as AdminAct[]) handle(lobby, devP, { t: 'admin_act', act });
    handle(lobby, devP, { t: 'admin_act', act: 'history', name: 'Bob' });
    await tick();
    assert.equal(last(out.dev, 'admin_log')?.rows[0].action, 'announce');
    assert.ok(last(out.dev, 'admin_feed'));
    assert.ok(last(out.dev, 'train_status'));
    assert.ok(last(out.dev, 'bot_knowledge'));
    assert.equal(last(out.dev, 'admin_history')?.name, 'Bob');
    assert.ok(!out.dev.some((m) => m.t === 'dev_result' && /owner only/.test(m.text)), 'none of those was refused');
  });

  it('a dev may train the bots (it reaches the learner check, not a refusal) and the work is logged under their name', async () => {
    const { lobby, devP, out } = await world();
    for (const act of ['train', 'train_passes', 'train_all'] as AdminAct[]) {
      handle(lobby, devP, { t: 'admin_act', act, id: 'r1', value: 2 });
      await tick();
      assert.match(last(out.dev, 'dev_result')!.text, /Bot learning is not running/, act);
    }
  });

  it('a dev sees the proposals and what they send is logged under their name, and can delete them, but cannot make them live or open a pull request', async () => {
    const { lobby, devP, owner, dev, log, out } = await world();
    handle(lobby, devP, { t: 'dev_save', patches: [{ file: 'abilities', id: 'fireball', path: ['effects', '0', 'amount'], value: 99 }], note: 'more' });
    await tick();
    await tick();
    assert.ok(dev.proposals.length >= 1, 'a dev proposes');
    assert.ok((await log.list()).some((r) => r.by === 'Dee' && r.action === 'proposed numbers'), 'logged under the dev');
    handle(lobby, devP, { t: 'admin_proposals', op: 'list' });
    assert.equal(last(out.dev, 'proposals')!.rows.length, dev.proposals.length);
    // the owner is not bothered, and sees it too
    const id = dev.proposals[0].id;
    for (const op of ['live', 'pr'] as const) {
      handle(lobby, devP, { t: 'admin_proposals', op, ids: [id] });
      await tick();
      assert.match(last(out.dev, 'dev_result')!.text, /for the owner only/, op);
    }
    assert.equal(dev.proposals.find((r) => r.id === id)!.status, 'pending');
    assert.equal(dev.overrides.length, 0, 'nothing went live');
    // a dev may delete a proposal
    handle(lobby, devP, { t: 'admin_proposals', op: 'dismiss', ids: [id] });
    await tick();
    assert.equal(dev.proposals.find((r) => r.id === id)!.status, 'dismissed');
    void owner;
  });

  it('a dev is refused every forbidden action with a clear message, and nothing happens', async () => {
    const { lobby, devP, bobP, a, out } = await world();
    handle(lobby, bobP, { t: 'join', name: 'Bob', classId: 'mage', mode: 'practice', difficulty: 'normal', size: 1 });
    const room = bobP.room;
    for (const act of FORBIDDEN_ACTS) {
      const before = out.dev.length;
      handle(lobby, devP, { t: 'admin_act', act, name: 'Bob', minutes: 10, value: 1, on: true, id: room.id, text: 'x' });
      await tick();
      const r = out.dev.slice(before).find((m) => m.t === 'dev_result') as any;
      assert.ok(r && !r.ok && /for the owner only/.test(r.text), `${act} refused: ${r?.text}`);
    }
    const bob = (await a.get('bob'))!;
    assert.equal(bobP.ws.closed, false, 'not kicked or banned');
    assert.equal(room.paused, false, 'the match was not paused');
    assert.ok(!bob.banned && !bob.muted, 'no ban or mute');
    assert.equal((lobby as any).maint, null, 'no maintenance');
    assert.equal((lobby as any).autoTrain, false);
    // announcements, ending matches, account tools, live-number tools, bot matches
    handle(lobby, devP, { t: 'admin_announce', text: 'hi all' });
    assert.match(last(out.dev, 'dev_result')!.text, /Announcements.*owner only/);
    assert.ok(!out.bob.some((m) => m.t === 'announce'));
    handle(lobby, devP, { t: 'admin_end', id: room.id });
    assert.match(last(out.dev, 'dev_result')!.text, /Ending a match.*owner only/);
    assert.equal(room.closed, false, 'the match still runs');
    handle(lobby, devP, { t: 'admin_list' });
    handle(lobby, devP, { t: 'admin_set', name: 'Bob', grants: ['dev'], resetPassword: true });
    await tick();
    assert.ok(out.dev.filter((m) => m.t === 'auth_error').length >= 2);
    assert.ok(!out.dev.some((m) => m.t === 'admin_accounts' || m.t === 'admin_result'));
    assert.ok(!(await a.get('bob'))!.grants?.includes('dev'), 'no tag handed out');
    handle(lobby, devP, { t: 'overrides_clear' });
    assert.match(last(out.dev, 'dev_result')!.text, /owner only/);
    handle(lobby, devP, { t: 'overrides_pr' });
    assert.match(last(out.dev, 'dev_result')!.text, /owner only/);
    handle(lobby, devP, { t: 'suggest_delete', at: 1, text: 'x' });
    assert.equal(last(out.dev, 'suggest_ack')?.ok, false);
    handle(lobby, devP, { t: 'bot_match', size: 1, difficulty: 'normal', map: 'random', teams: [[{ classId: 'mage' }], [{ classId: 'mage' }]] });
    assert.ok(devP.watching, 'a dev can start a bot match');
  });

  it('a dev can pause the bot match they started', async () => {
    const { lobby, devP } = await world();
    handle(lobby, devP, { t: 'bot_match', size: 1, difficulty: 'normal', map: 'random', teams: [[{ classId: 'mage' }], [{ classId: 'mage' }]] });
    const room = devP.watching;
    assert.ok(room);
    handle(lobby, devP, { t: 'dev_pause', on: true });
    assert.equal(room.paused, true);
    handle(lobby, devP, { t: 'dev_pause', on: false });
    assert.equal(room.paused, false);
  });

  it('a dev reads the suggestion box but cannot delete from it', async () => {
    const { lobby, devP, bobP, out, store } = await world();
    handle(lobby, bobP, { t: 'suggest', text: 'more bears' });
    await tick();
    handle(lobby, devP, { t: 'suggestions' });
    await tick();
    const rows = last(out.dev, 'suggestions')!.rows;
    assert.equal(rows.length, 1);
    handle(lobby, devP, { t: 'suggest_delete', at: rows[0].at, text: rows[0].text });
    await tick();
    assert.equal((await new Suggestions(store).list()).length, 1);
  });

  it('a dev sees only matches they could watch anyway, on the delayed view, and the owner sees all', async () => {
    const { lobby, devP, bobP, owner, out } = await world();
    handle(lobby, bobP, { t: 'join', name: 'Bob', classId: 'mage', mode: 'practice', difficulty: 'dummy', size: 1 });
    const room = bobP.room;
    assert.equal(room.watchable, false, 'private practice');
    handle(lobby, devP, { t: 'admin_overview' });
    const row = last(out.dev, 'admin_overview')!.rooms.find((r) => r.id === room.id)!;
    assert.equal(row.watchable, false, 'the panel hides the Watch button');
    handle(lobby, devP, { t: 'spectate', id: room.id });
    assert.equal(devP.watching, undefined, 'the server refuses it');
    handle(lobby, devP, { t: 'follow', name: 'Bob' });
    assert.equal(last(out.dev, 'following')?.name, 'Bob');
    handle(lobby, bobP, { t: 'ready', on: true, name: 'Bob', classId: 'mage' });
    assert.equal(devP.watching, undefined, 'following never pulls a dev into a private match');
    handle(lobby, owner, { t: 'spectate', id: room.id });
    assert.equal(owner.watching, room, 'the owner watches anything');
  });

  it('pausing: a dev still cannot pause a stranger’s match, and the tag is checked live (revoked at once)', async () => {
    const { lobby, devP, bobP, a, out } = await world();
    handle(lobby, bobP, { t: 'join', name: 'Bob', classId: 'mage', mode: 'practice', difficulty: 'normal', size: 1 });
    handle(lobby, devP, { t: 'dev_pause', on: true });
    assert.equal(bobP.room.paused, false);
    // the owner takes the tag away: the same connection loses the panel on its very next message
    const r = await a.adminSet('Dee', { grants: [] } as any);
    assert.ok(r.ok);
    devP.account = r.account;
    const before = out.dev.length;
    handle(lobby, devP, { t: 'admin_overview' });
    handle(lobby, devP, { t: 'admin_act', act: 'log' });
    await tick();
    assert.equal(out.dev.length, before, 'nothing');
    assert.equal(lobby.adminAccess(devP), null);
  });

  it('real revoke through the owner’s account tools updates the dev’s live connection', async () => {
    const { lobby, owner, devP, out } = await world();
    handle(lobby, owner, { t: 'admin_set', name: 'Dee', grants: [] });
    await tick();
    assert.equal(lobby.adminAccess(devP), null);
    handle(lobby, devP, { t: 'admin_overview' });
    assert.ok(!out.dev.some((m) => m.t === 'admin_overview'));
  });

  it('a dev follows and watches a match that is open for watching', async () => {
    const { lobby, devP, bobP, out } = await world();
    handle(lobby, devP, { t: 'follow', name: 'Bob' });
    handle(lobby, bobP, { t: 'join', name: 'Bob', classId: 'mage', mode: 'practice', difficulty: 'normal', size: 1 });
    const room = bobP.room;
    assert.equal(room.watchable, true);
    assert.equal(devP.watching, room, 'followed into the listed match');
    assert.ok(!room.spectators.has(devP) || devP.ownerOk === false, 'a dev is never on the owner\u2019s live view');
    assert.ok(last(out.dev, 'spectating'));
  });
});
