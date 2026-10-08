import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientMsg, ServerMsg } from '@arena/shared';
import { MemoryStore } from '../src/store';
import { Accounts } from '../src/accounts';
import { Lobby } from '../src/rooms';
import { whereIs } from '../src/geoip';

const mk = (out: ServerMsg[]) => ({ readyState: 1, send: (s: string) => out.push(JSON.parse(s)), bufferedAmount: 0 }) as any;

describe('owner: online now', () => {
  it('names the country from the proxy header, never looks anything up', () => {
    assert.equal(whereIs('8.8.8.8', 'de'), 'Germany');
    assert.equal(whereIs('8.8.8.8', 'XX'), '');
    assert.equal(whereIs('8.8.8.8'), '');
    assert.equal(whereIs('192.168.1.5', 'DE'), 'local network');
    assert.equal(whereIs('::ffff:10.0.0.2'), 'local network');
  });

  it('the owner sees every connection, guests included, with address and country; others get nothing', async () => {
    const accounts = new Accounts(new MemoryStore(), 'owner-code');
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 }, accounts);
    const outO: ServerMsg[] = [];
    const outG: ServerMsg[] = [];
    const owner = lobby.connect(mk(outO), '1.1.1.1', 'US');
    const guest = lobby.connect(mk(outG), '2.2.2.2', 'FR');
    owner.ownerOk = true;
    lobby.handle(guest, { t: 'admin_overview' } as ClientMsg);
    assert.equal(outG.length, 0, 'a guest gets no overview');
    lobby.handle(owner, { t: 'admin_overview' } as ClientMsg);
    const ov = [...outO].reverse().find((m) => m.t === 'admin_overview') as Extract<ServerMsg, { t: 'admin_overview' }>;
    assert.equal(ov.players?.length, 2);
    const g = ov.players!.find((q) => q.ip === '2.2.2.2')!;
    assert.equal(g.guest, true);
    assert.equal(g.where, 'France');
    assert.equal(g.status, 'in the menu');
  });
});
