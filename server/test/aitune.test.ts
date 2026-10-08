import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES } from '@arena/shared';
import type { ClientMsg, ServerMsg } from '@arena/shared';
import { AiTune, parseAnswer } from '../src/aitune';
import { Lobby } from '../src/rooms';

const answer = (obj: unknown) =>
  (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.match(body.messages[0].content, /Request: /);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: `Here you go:\n${JSON.stringify(obj)}` }] }), { status: 200 });
  }) as typeof fetch;

describe('Ask Claude in the dev panel', () => {
  it('only numbers that were offered, and valid, come back', () => {
    const offered = [{ file: 'abilities', id: 'fireball', path: ['cooldown'] }];
    const r = parseAnswer(JSON.stringify({ changes: [{ file: 'abilities', id: 'fireball', path: ['cooldown'], value: 1500 }, { file: 'abilities', id: 'fireball', path: ['name'], value: 1 }, { file: 'abilities', id: 'frostbolt', path: ['cooldown'], value: 1 }], summary: 'Shorter cooldown.' }), offered);
    assert.equal(r.ok, true);
    assert.deepEqual(r.patches, [{ file: 'abilities', id: 'fireball', path: ['cooldown'], value: 1500 }]);
    assert.equal(r.text, 'Shorter cooldown.');
    assert.equal(parseAnswer('no json here', offered).ok, false);
    assert.equal(parseAnswer(JSON.stringify({ changes: [], summary: 'Cannot do that.' }), offered).text, 'Cannot do that.');
  });

  it('off without a key, and rate limited', async () => {
    assert.equal((await new AiTune({}).suggest('a', 'fireball', 'more', [])).ok, false);
    const dmg = ABILITIES.fireball.effects.findIndex((e) => e.type === 'damage');
    const ai = new AiTune({ ANTHROPIC_API_KEY: 'k' }, answer({ changes: [{ file: 'abilities', id: 'fireball', path: ['effects', dmg, 'amount'], value: 777 }], summary: 'More damage.' }));
    const r = await ai.suggest('a', 'fireball', 'hit harder', []);
    assert.equal(r.ok, true, r.text);
    assert.equal(r.patches[0].value, 777);
    assert.match((await ai.suggest('a', 'fireball', 'again', [])).text, /Slow down/);
  });

  it('the lobby tries the answer in the dev’s match at once', async () => {
    const dmg = ABILITIES.fireball.effects.findIndex((e) => e.type === 'damage');
    const ai = new AiTune({ ANTHROPIC_API_KEY: 'k' }, answer({ changes: [{ file: 'abilities', id: 'fireball', path: ['effects', dmg, 'amount'], value: 555 }], summary: 'Done.' }));
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 }, undefined, undefined, undefined, undefined, undefined, ai);
    const out: ServerMsg[] = [];
    const p = { ws: { readyState: 1, send: (s: string) => out.push(JSON.parse(s)), bufferedAmount: 0 }, name: 'Toke', classId: 'mage', matches: 0, wins: 0, size: 1, ip: '1.1.1.1', mapPref: 'random', ownerOk: true } as any;
    (lobby as any).conns.add(p);
    lobby.handle(p, { t: 'join', name: 'Toke', classId: 'mage', mode: 'practice', difficulty: 'normal', size: 1 } as ClientMsg);
    lobby.handle(p, { t: 'dev_ai', ability: 'fireball', text: 'hit harder' } as ClientMsg);
    for (let i = 0; i < 50 && !out.some((m) => m.t === 'dev_result'); i++) await new Promise((r) => setTimeout(r, 10));
    const res = out.find((m) => m.t === 'dev_result') as Extract<ServerMsg, { t: 'dev_result' }>;
    assert.equal(res.ok, true, res.text);
    assert.equal(p.room.devPatches[0].value, 555);
    assert.equal(p.room.devTest, true);
  });
});
