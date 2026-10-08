import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, skillInfo } from '@arena/shared';
import type { ClientMsg, ServerMsg } from '@arena/shared';
import { AiTune, parseAnswer } from '../src/aitune';
import type { MessagesLike, OfferedField } from '../src/aitune';
import { Lobby } from '../src/rooms';

/** A stand-in for the SDK: answers by picking the offered field whose label matches. */
function fake(pick: (label: string) => boolean, value: number, seen: any[] = []): MessagesLike {
  return {
    async create(params) {
      seen.push(params);
      const fields = JSON.parse(String(params.messages[0].content).split('\n')[1]).fields as { index: number; label: string }[];
      const f = fields.find((x) => pick(x.label))!;
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ changes: [{ field: f.index, value }], summary: 'Done.' }) }] } as any;
    },
  };
}

const offered = (id: string): OfferedField[] => skillInfo(id).sections.flatMap((s) => s.fields.map((f) => ({ ...f, label: `${s.name} · ${f.label}` })));

describe('Ask Claude in the dev panel', () => {
  it('only offered numbers come back, by index; junk is dropped', () => {
    const fields = offered('fireball');
    const cd = fields.findIndex((f) => f.path.join('.') === 'cooldown');
    const r = parseAnswer(JSON.stringify({ changes: [{ field: cd, value: 1500 }, { field: 999, value: 1 }, { field: cd, value: 'x' }], summary: 'Shorter cooldown.' }), fields);
    assert.equal(r.ok, true);
    assert.deepEqual(r.patches, [{ file: 'abilities', id: 'fireball', path: ['cooldown'], value: 1500 }]);
    assert.equal(r.text, 'Shorter cooldown.');
    assert.equal(parseAnswer('not json', fields).ok, false);
    assert.equal(parseAnswer(JSON.stringify({ changes: [], summary: 'Cannot do that.' }), fields).text, 'Cannot do that.');
  });

  it('asks with structured output and fallbacks, is off without a key, and is rate limited', async () => {
    assert.equal(new AiTune({}).enabled, false);
    assert.equal((await new AiTune({}).suggest('a', 'fireball', 'more', [])).ok, false);
    const seen: any[] = [];
    const ai = new AiTune({}, fake((l) => /damage · amount/.test(l), 777, seen));
    const r = await ai.suggest('a', 'fireball', 'hit harder', []);
    assert.equal(r.ok, true, r.text);
    assert.equal(r.patches[0].value, 777);
    assert.equal(seen[0].model, 'claude-opus-5-5');
    assert.equal(seen[0].output_config.format.type, 'json_schema');
    assert.equal(seen[0].fallbacks, 'default');
    assert.match((await ai.suggest('a', 'fireball', 'again', [])).text, /Slow down/);
  });

  it('a refusal changes nothing', async () => {
    const ai = new AiTune({}, { create: async () => ({ stop_reason: 'refusal', content: [] }) as any });
    assert.equal((await ai.suggest('b', 'fireball', 'x', [])).ok, false);
  });

  it('from the menu the answer goes into the dev session numbers', async () => {
    const ai = new AiTune({}, fake((l) => /cooldown/i.test(l), 4321));
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 }, undefined, undefined, undefined, undefined, undefined, ai);
    const out: ServerMsg[] = [];
    const p = { ws: { readyState: 1, send: (s: string) => out.push(JSON.parse(s)), bufferedAmount: 0 }, name: 'Toke', classId: 'mage', matches: 0, wins: 0, size: 1, ip: '1.1.1.1', mapPref: 'random', ownerOk: true } as any;
    (lobby as any).conns.add(p);
    lobby.handle(p, { t: 'dev_ai', ability: 'fireball', text: 'shorter cooldown' } as ClientMsg);
    for (let i = 0; i < 50 && !out.some((m) => m.t === 'dev_result'); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((out.find((m) => m.t === 'dev_result') as any).ok, true);
    assert.equal(p.devSession[0].value, 4321);
    assert.deepEqual((out.find((m) => m.t === 'dev_session') as any).patches, p.devSession);
    lobby.handle(p, { t: 'join', name: 'Toke', classId: 'mage', mode: 'practice', difficulty: 'normal', size: 1 } as ClientMsg);
    assert.equal(p.room.devPatches[0].value, 4321, 'and the next match starts with it');
  });

  it('the lobby tries the answer in the dev’s match at once', async () => {
    const ai = new AiTune({}, fake((l) => /damage · amount/.test(l), 555));
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
    assert.ok(ABILITIES.fireball);
  });
});
