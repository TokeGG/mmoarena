import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SPECS, parseClientMsg } from '@arena/shared';
import type { ClientMsg, DataPatch, ServerMsg } from '@arena/shared';
import { MemoryStore } from '../src/store';
import { Accounts } from '../src/accounts';
import { Lobby } from '../src/rooms';
import { DevTools, label, patchJsonText } from '../src/devtools';

const read = (name: string) => fs.readFileSync(new URL(`../../shared/data/${name}.json`, import.meta.url), 'utf8');
type Json = Record<string, any>;
const specsOf = (text: string) => Object.values(JSON.parse(text) as Json).flat() as Json[];
const find = (text: string, id: string) => specsOf(text).find((s) => s.id === id)!;

describe('committing passives: specs, talents, classes and the game options', () => {
  it('a nested spec passive number changes alone, and the file keeps its layout', () => {
    const text = read('specs');
    const out = patchJsonText(text, 'specs', [{ file: 'specs', id: 'discipline', path: ['mods', 'ability', 'power_word_shield', 'heal'], value: 2 }]);
    const diff = out.split('\n').flatMap((l, i) => (l !== text.split('\n')[i] ? [l.trim()] : []));
    assert.deepEqual(diff, ['"heal": 2']);
    assert.equal(find(out, 'discipline').mods.ability.power_word_shield.heal, 2);
    assert.ok(!/[^\x00-\x7f]/.test(out), 'specs.json keeps its symbols as escapes');
  });

  it('a stat bonus the spec does not have yet is added; a skill switch is written, and turned off it leaves no empty entry', () => {
    const text = read('specs');
    assert.deepEqual(find(text, 'holy').mods, {});
    const added = patchJsonText(text, 'specs', [
      { file: 'specs', id: 'holy', path: ['mods', 'damageDone'], value: 1.25 },
      { file: 'specs', id: 'holy', path: ['mods', 'ability', 'smite', 'castWhileMoving'], value: 1 },
      { file: 'specs', id: 'holy', path: ['mods', 'ability', 'smite', 'damage'], value: 1.5 },
    ]);
    assert.deepEqual(find(added, 'holy').mods, { damageDone: 1.25, ability: { smite: { castWhileMoving: true, damage: 1.5 } } });
    assert.deepEqual(find(added, 'discipline'), find(text, 'discipline'), 'other specs are untouched');
    // the Warden's moving Penance off: the entry goes, Power Word: Shield stays
    const off = patchJsonText(text, 'specs', [{ file: 'specs', id: 'discipline', path: ['mods', 'ability', 'penance', 'castWhileMoving'], value: 0 }]);
    assert.deepEqual(find(off, 'discipline').mods, { ability: { power_word_shield: { heal: 1.5 } } });
    // and a talent can get a stat in every copy
    const talents = read('talents');
    const t = patchJsonText(talents, 'talents', [{ file: 'talents', id: 'warrior_t2a', path: ['mods', 'damageTaken'], value: 0.9 }]);
    const copies = Object.values(JSON.parse(t) as Json).flatMap((b) => Object.values(b as Json).flat(2) as Json[]).filter((x) => x.id === 'warrior_t2a');
    assert.ok(copies.length >= 3 && copies.every((c) => c.mods.damageTaken === 0.9 && c.mods.autoSpeed === 0.8333333333333334));
  });

  it('a talent number inside the tiers changes in its own spec only', () => {
    const talents = read('talents');
    const out = patchJsonText(talents, 'talents', [{ file: 'talents', id: 'warrior_arms_t3a', path: ['mods', 'ability', 'slam', 'damage'], value: 1.25 }]);
    const now = Object.values(JSON.parse(out) as Json).flatMap((b) => Object.values(b as Json).flat(2) as Json[]).filter((x) => x.id === 'warrior_arms_t3a');
    assert.ok(now.length >= 1 && now.every((x) => x.mods.ability.slam.damage === 1.25));
    assert.equal(out.split('\n').filter((l, i) => l !== talents.split('\n')[i]).length, now.length);
  });

  it('the animations (fx.json) are patched in place, nothing else moves', () => {
    const fx = read('fx');
    const out = patchJsonText(fx, 'fx', [
      { file: 'fx', id: 'fx', path: ['dragonsBreath', 'sprayMs'], value: 1000 },
      { file: 'fx', id: 'fx', path: ['heroicLeap', 'arcScale'], value: 1.4 },
    ]);
    const j = JSON.parse(out) as Json;
    assert.equal(j.dragonsBreath.sprayMs, 1000);
    assert.equal(j.heroicLeap.arcScale, 1.4);
    assert.equal(j.flamestrike.popInMs, 150);
    assert.equal(out.split('\n').filter((l, i) => l !== fx.split('\n')[i]).length, 2);
    // out-of-range and unknown numbers are refused before they get anywhere
    assert.equal(parseClientMsg(JSON.stringify({ t: 'dev_patch', patches: [{ file: 'fx', id: 'fx', path: ['dragonsBreath', 'sprayMs'], value: 999999 }] })), null);
    assert.equal(parseClientMsg(JSON.stringify({ t: 'dev_patch', patches: [{ file: 'fx', id: 'fx', path: ['dragonsBreath', 'nonsense'], value: 1 }] })), null);
    assert.ok(parseClientMsg(JSON.stringify({ t: 'dev_patch', patches: [{ file: 'fx', id: 'fx', path: ['dragonsBreath', 'sprayMs'], value: 800 }] })));
  });

  it('the game options (tuning.json) and the class stats are patched in place', () => {
    const tuning = read('tuning');
    const out = patchJsonText(tuning, 'tuning', [
      { file: 'tuning', id: 'game', path: ['gcdMs'], value: 1200 },
      { file: 'tuning', id: 'game', path: ['drSteps', 1], value: 0.4 },
      { file: 'tuning', id: 'game', path: ['cauterizeHealth'], value: 0.5 },
    ]);
    const j = JSON.parse(out) as Json;
    assert.equal(j.gcdMs, 1200);
    assert.deepEqual(j.drSteps, [1, 0.4, 0.25, 0]);
    assert.equal(j.cauterizeHealth, 0.5);
    assert.equal(out.split('\n').filter((l, i) => l !== tuning.split('\n')[i]).length, 3);
    const classes = read('classes');
    const c = patchJsonText(classes, 'classes', [
      { file: 'classes', id: 'mage', path: ['resource', 'regenPerSec'], value: 30 },
      { file: 'classes', id: 'warrior', path: ['auto', 'damage'], value: 99 },
      { file: 'classes', id: 'rogue', path: ['maxHealth'], value: 2900 },
    ]);
    const cj = JSON.parse(c) as Json;
    assert.equal(cj.mage.resource.regenPerSec, 30);
    assert.equal(cj.warrior.auto.damage, 99);
    assert.equal(cj.rogue.maxHealth, 2900);
    assert.equal(cj.priest.resource.regenPerSec, JSON.parse(classes).priest.resource.regenPerSec, 'other classes are untouched');
  });

  it('an aura option is written when on and left out when off', () => {
    const auras = read('auras');
    const on = patchJsonText(auras, 'auras', [{ file: 'auras', id: 'frost_nova_root', path: ['bleed'], value: 1 }]);
    assert.equal((JSON.parse(on) as Json).frost_nova_root.bleed, true);
    const off = patchJsonText(on, 'auras', [{ file: 'auras', id: 'frost_nova_root', path: ['bleed'], value: 0 }]);
    assert.ok(!('bleed' in (JSON.parse(off) as Json).frost_nova_root));
  });

  it('labels read in words', () => {
    assert.equal(label({ file: 'specs', id: 'discipline', path: ['mods', 'ability', 'power_word_shield', 'heal'], value: 1 }), 'Warden · Power Word: Shield: shield strength');
    assert.equal(label({ file: 'tuning', id: 'game', path: ['gcdMs'], value: 1 }), 'Game options · Global cooldown');
    assert.match(label({ file: 'classes', id: 'mage', path: ['resource', 'regenPerSec'], value: 1 }), /^Mage · Mana regenerated per second$/);
  });

  it('a message with a passive or a game option is accepted by the server parser; nonsense is not', () => {
    const ok = parseClientMsg(JSON.stringify({ t: 'dev_patch', patches: [
      { file: 'specs', id: 'discipline', path: ['mods', 'ability', 'power_word_shield', 'heal'], value: 2 },
      { file: 'tuning', id: 'game', path: ['gcdMs'], value: 900 },
      { file: 'specs', id: 'holy', path: ['mods', 'damageDone'], value: 1.1 },
    ] }));
    assert.equal((ok as { patches: unknown[] } | null)?.patches.length, 3);
    assert.equal(parseClientMsg(JSON.stringify({ t: 'dev_patch', patches: [{ file: 'tuning', id: 'game', path: ['tickMs'], value: 5 }] })), null);
    assert.equal(parseClientMsg(JSON.stringify({ t: 'dev_patch', patches: [{ file: 'specs', id: 'holy', path: ['mods', 'bogus'], value: 5 }] })), null);
  });
});

describe('committing passives through the dev tools', () => {
  type Call = { url: string; method: string; body?: any };
  const mkHttp = (calls: Call[]) =>
    (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body });
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.includes('/git/ref/heads/')) return ok({ object: { sha: 'head' } });
      if (url.includes('/git/commits/')) return ok({ tree: { sha: 'tree1' } });
      if (url.endsWith('/git/trees')) return ok({ sha: 'tree2' });
      if (url.endsWith('/git/commits') && method === 'POST') return ok({ sha: 'abc123', html_url: 'https://github.com/TokeGG/mmoarena/commit/abc123' });
      if (url.includes('/git/refs/heads/') && method === 'PATCH') return ok({});
      const m = /\/contents\/([^?]+)/.exec(url);
      if (m && method === 'GET') return ok({ content: fs.readFileSync(new URL('../../' + m[1], import.meta.url)).toString('base64'), sha: 'f' });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
  const tree = (calls: Call[]) => calls.find((c) => c.url.endsWith('/git/trees'))!.body.tree as { path: string; content: string }[];

  it('one commit with a passive, a new stat, a switch and a game option: the right files change and the notes read in words', async () => {
    const calls: Call[] = [];
    const dev = new DevTools(new MemoryStore(), { GITHUB_TOKEN: 'tok' }, mkHttp(calls));
    const r = await dev.commitToBase([
      { file: 'specs', id: 'discipline', path: ['mods', 'ability', 'power_word_shield', 'heal'], value: 1.75 },
      { file: 'specs', id: 'holy', path: ['mods', 'healingDone'], value: 1.1 },
      { file: 'specs', id: 'discipline', path: ['mods', 'ability', 'penance', 'castWhileMoving'], value: 0 },
      { file: 'tuning', id: 'game', path: ['cauterizeHealth'], value: 0.5 },
      { file: 'classes', id: 'mage', path: ['resource', 'regenPerSec'], value: 30 },
      { file: 'talents', id: 'warrior_t2a', path: ['mods', 'autoSpeed'], value: 0.75 },
    ], 'Dee');
    assert.equal(r.applied, 6, r.skipped.join('; '));
    assert.deepEqual(r.skipped, []);
    const files = tree(calls);
    assert.deepEqual(files.map((f) => f.path).sort(), ['README.md', 'client/package.json', 'package.json', 'shared/data/classes.json', 'shared/data/patches.json', 'shared/data/specs.json', 'shared/data/talents.json', 'shared/data/tuning.json', 'shared/src/replay.ts']);
    const specs = files.find((f) => f.path === 'shared/data/specs.json')!.content;
    assert.equal(find(specs, 'holy').mods.healingDone, 1.1);
    assert.equal(find(specs, 'discipline').mods.ability.power_word_shield.heal, 1.75);
    assert.ok(!('penance' in find(specs, 'discipline').mods.ability));
    assert.equal((JSON.parse(files.find((f) => f.path === 'shared/data/tuning.json')!.content) as Json).cauterizeHealth, 0.5);
    const notes = (JSON.parse(files.find((f) => f.path === 'shared/data/patches.json')!.content) as { changes: string[] }[])[0].changes;
    assert.ok(notes.includes('Warden: Power Word: Shield: shield strength +50% to +75%.'), notes.join(' | '));
    assert.ok(notes.some((l) => /^Lightbearer: healing done normal to \+10%\.$/.test(l)), notes.join(' | '));
    assert.ok(notes.some((l) => /^Warden: Penance: can be cast while moving \(now off\)\.$/.test(l)), notes.join(' | '));
    assert.ok(notes.some((l) => /^Game rules: cauterize: health left 35% to 50%\.$/.test(l)), notes.join(' | '));
    assert.ok(notes.some((l) => /^Mage: mana regenerated per second 24 to 30\.$/.test(l)), notes.join(' | '));
  });

  it('an animation-only commit writes fx.json, bumps the version but leaves SIM_REVISION (and replays) alone', async () => {
    const calls: Call[] = [];
    const dev = new DevTools(new MemoryStore(), { GITHUB_TOKEN: 'tok' }, mkHttp(calls));
    const r = await dev.commitToBase([
      { file: 'fx', id: 'fx', path: ['dragonsBreath', 'sprayMs'], value: 900 },
      { file: 'fx', id: 'fx', path: ['charge', 'trailDensity'], value: 1.5 },
    ], 'Dee');
    assert.equal(r.applied, 2, r.skipped.join('; '));
    const files = tree(calls);
    assert.deepEqual(files.map((f) => f.path).sort(), ['README.md', 'client/package.json', 'package.json', 'shared/data/fx.json', 'shared/data/patches.json']);
    const fx = JSON.parse(files.find((f) => f.path === 'shared/data/fx.json')!.content) as Json;
    assert.equal(fx.dragonsBreath.sprayMs, 900);
    assert.equal(fx.charge.trailDensity, 1.5);
    assert.equal(fx.dragonsBreath.fadeMs, 250, 'the rest of the file is as it was');
    const notes = (JSON.parse(files.find((f) => f.path === 'shared/data/patches.json')!.content) as { changes: string[] }[])[0].changes;
    assert.ok(notes.some((l) => /^Animations: Dragon's Breath: how long the spray stays 0\.65 s to 0\.9 s\.$/.test(l)), notes.join(' | '));
  });

  it('an animation commit together with a balance change still raises SIM_REVISION', async () => {
    const calls: Call[] = [];
    const dev = new DevTools(new MemoryStore(), { GITHUB_TOKEN: 'tok' }, mkHttp(calls));
    await dev.commitToBase([
      { file: 'fx', id: 'fx', path: ['frostNova', 'expandMs'], value: 700 },
      { file: 'tuning', id: 'game', path: ['gcdMs'], value: 1500 },
    ], 'Dee');
    assert.ok(tree(calls).some((f) => f.path === 'shared/src/replay.ts'));
  });

  it('a change that does nothing, or no longer fits the files, is left out and said so', async () => {
    const calls: Call[] = [];
    const dev = new DevTools(new MemoryStore(), { GITHUB_TOKEN: 'tok' }, mkHttp(calls));
    const r = await dev.commitToBase([
      { file: 'specs', id: 'holy', path: ['mods', 'damageDone'], value: 1 },
      { file: 'tuning', id: 'game', path: ['gcdMs'], value: 1500 },
    ], 'Dee');
    assert.equal(r.applied, 1);
    assert.match(r.skipped.join(' '), /already 1/);
  });

  it('a proposal for a passive keeps the old value (the neutral one for a new stat) and plain labels', async () => {
    const dev = new DevTools(new MemoryStore());
    const row = await dev.propose('Dee', [
      { file: 'specs', id: 'holy', path: ['mods', 'damageDone'], value: 1.2 },
      { file: 'tuning', id: 'game', path: ['gcdMs'], value: 800 },
    ]);
    assert.deepEqual(row.changes.map((c) => c.from), [1, 1000]);
    assert.deepEqual(row.changes.map((c) => c.label), ['Lightbearer · Damage dealt', 'Game options · Global cooldown']);
  });
});

describe('a passive patch reaches the match', () => {
  const mkP = (name: string, out: ServerMsg[], account: any, classId: string, build?: any) => ({ ws: { readyState: 1, send: (s: string) => out.push(JSON.parse(s)), bufferedAmount: 0 } as any, name, classId, build, matches: 0, wins: 0, size: 1, ip: '1.1.1.1', mapPref: 'random', account, ownerOk: false } as any);

  it('the dev tools change a spec passive for a unit already in the match, and "put all back" restores it', async () => {
    const store = new MemoryStore();
    const a = new Accounts(store, 'dev-code');
    const dee = (await a.register('Dee', 'hunter22', '2.2.2.2')) as any;
    const bob = (await a.register('Bob', 'hunter22', '3.3.3.3')) as any;
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0 }, a, undefined, undefined, new DevTools(store));
    const out: ServerMsg[] = [];
    const devP = mkP('Dee', out, { ...dee.account, grants: ['dev'] }, 'priest', { spec: 'discipline', talents: [], gear: {} });
    const bobP = mkP('Bob', [], bob.account, 'warrior', { spec: 'arms', talents: ['', 'warrior_t2b'], gear: {} });
    const room: any = (lobby as any).makeRoom(0, true, false, 'colosseum');
    (lobby as any).rooms.add(room);
    room.addPlayer(devP, 0);
    room.addPlayer(bobP, 1);
    const unit = (p: any) => room.sim.units.get(p.unitId);
    assert.equal(unit(devP).mods.ability.power_word_shield.heal, 1.5);
    const hp = unit(bobP).maxHealth;
    lobby.handle(devP, { t: 'dev_patch', patches: [
      { file: 'specs', id: 'discipline', path: ['mods', 'ability', 'power_word_shield', 'heal'], value: 4 },
      { file: 'specs', id: 'discipline', path: ['mods', 'ability', 'penance', 'castWhileMoving'], value: 0 },
      { file: 'talents', id: 'warrior_t2b', path: ['mods', 'maxHealth'], value: 2 },
      { file: 'specs', id: 'discipline', path: ['mods', 'damageDone'], value: 1.5 },
    ] } as ClientMsg);
    assert.equal(unit(devP).mods.ability.power_word_shield.heal, 4);
    assert.ok(!unit(devP).mods.ability.penance.castWhileMoving);
    assert.equal(unit(devP).mods.damageDone, 1.5);
    assert.equal(unit(bobP).maxHealth, Math.round(hp / 1.1 * 2), 'the other player in the match plays on it too');
    // the data itself is back as the files have it between ticks
    assert.equal(SPECS.priest[0].mods.ability!.power_word_shield.heal, 1.5);
    lobby.handle(devP, { t: 'dev_patch', patches: [] } as ClientMsg);
    assert.equal(unit(devP).mods.ability.power_word_shield.heal, 1.5);
    assert.ok(unit(devP).mods.ability.penance.castWhileMoving);
    assert.equal(unit(devP).mods.damageDone, 1);
    assert.equal(unit(bobP).maxHealth, hp);
  });
});
