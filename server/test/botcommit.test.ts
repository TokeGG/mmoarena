import { landingRoute } from './githubLanding';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ARENAS, ArenaSim, Bot, EMPTY_GRADED, ReplayRecorder, botBuild, brainFor, hasHumanData, mergePlayers, nothingReason, parseClientMsg, roundBrain } from '@arena/shared';
import type { BotReport, BotStudy, ClassId, ClientMsg, ReplayData, ServerMsg } from '@arena/shared';
import { MemoryStore } from '../src/store';
import { BotLearner } from '../src/botlearn';
import type { StudiedEvent } from '../src/botlearn';
import { AdminLog } from '../src/adminlog';
import { DevTools } from '../src/devtools';
import { Lobby } from '../src/rooms';

/** A person (a hard bot steering a player unit) against an easy bot. */
function peopleMatch(person: ClassId, bot: ClassId, seed: number): ReplayData {
  const sim = new ArenaSim({ seed, prepMs: 3000, arena: ARENAS[1] });
  const rec = new ReplayRecorder(sim, { arena: ARENAS[1].id, seed, prepMs: 3000 });
  const p = sim.addUnit({ name: 'P', classId: person, team: 0, controller: 'player', build: botBuild(person, seed) });
  const b = sim.addUnit({ name: 'B', classId: bot, team: 1, controller: 'bot', build: botBuild(bot, seed + 9) });
  const drivers = [new Bot(sim, p.id, 'hard', 1), new Bot(sim, b.id, 'easy', 2)];
  for (let ms = 0; sim.phase !== 'ended' && ms < 150000; ms += 50) {
    for (const d of drivers) d.tick();
    sim.step();
    sim.drainEvents();
  }
  return rec.finish([]);
}
function botsOnlyMatch(seed: number): ReplayData {
  const sim = new ArenaSim({ seed, prepMs: 3000, arena: ARENAS[1] });
  const rec = new ReplayRecorder(sim, { arena: ARENAS[1].id, seed, prepMs: 3000 });
  const a = sim.addUnit({ name: 'A', classId: 'warrior', team: 0, controller: 'bot', build: botBuild('warrior', seed) });
  const b = sim.addUnit({ name: 'B', classId: 'mage', team: 1, controller: 'bot', build: botBuild('mage', seed + 9) });
  const drivers = [new Bot(sim, a.id, 'hard', 1), new Bot(sim, b.id, 'easy', 2)];
  for (let ms = 0; sim.phase !== 'ended' && ms < 150000; ms += 50) {
    for (const d of drivers) d.tick();
    sim.step();
    sim.drainEvents();
  }
  return rec.finish([]);
}

const facts = (): BotStudy['facts'] => ({ castsUnderThreat: 0, kicked: 0, juked: 0, kicksLanded: 0, diedWithDefensive: 0, burstDeaths: 0, bigCastsTaken: 0, zoneHits: 0, engagedSec: 60, kitedFrac: 0, pinnedFrac: 0, mistakes: {} });
const mageLoss = (lessons: BotStudy['lessons']): BotStudy => ({ unitId: 2, classId: 'mage', foes: ['warrior'], won: false, lessons, graded: { ...EMPTY_GRADED, sec: 60 }, people: { ...EMPTY_GRADED, sec: 60 }, nudges: [], facts: facts() });
const stub = (bots: BotStudy[]) => async () => ({ humans: [], study: { bots, players: [] } });

type Call = { url: string; method: string; body?: any };
/** A fake GitHub holding the repository's real files, one tree and one commit, and a branch pointer. */
const mkHttp = (calls: Call[]) =>
  (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body });
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    const landed = landingRoute(url, method, ok);
    if (landed) return landed;
    if (url.includes('/git/ref/heads/') && method === 'GET') return ok({ object: { sha: 'head1' } });
    if (url.includes('/git/commits/')) return ok({ tree: { sha: 'tree1' } });
    if (url.endsWith('/git/trees')) return ok({ sha: 'tree2' });
    if (url.endsWith('/git/commits') && method === 'POST') return ok({ sha: 'abc123', html_url: 'https://github.com/TokeGG/mmoarena/commit/abc123' });
    if (url.includes('/git/refs/heads/') && method === 'PATCH') return ok({});
    const m = /\/contents\/([^?]+)/.exec(url);
    if (m && method === 'GET') return ok({ content: fs.readFileSync(new URL('../../' + m[1], import.meta.url)).toString('base64'), sha: 'f' });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
const tree = (calls: Call[]) => calls.find((c) => c.url.endsWith('/git/trees'))!.body.tree as { path: string; content: string }[];
const commits = (calls: Call[]) => calls.filter((c) => c.url.endsWith('/git/commits') && c.method === 'POST');

/** A learner that has studied a match with people which taught the mage bots something. */
async function learned(store = new MemoryStore()) {
  const learner = new BotLearner(store, () => 0.5, stub([mageLoss({ peelAt: { value: 1, weight: 150 }, trinketAt: { value: 1, weight: 150 } })]));
  await learner.whenReady();
  const events: StudiedEvent[] = [];
  learner.onStudied = (e) => events.push(e);
  const replay = peopleMatch('warrior', 'mage', 3);
  await learner.learnFrom(replay, 'abc123');
  // some real results against people, so players.json has something to say
  const pick = learner.pick('mage')!;
  for (let i = 0; i < 6; i++) learner.report('mage', pick.variantId, i < 2, 0.5, ['warrior'], 'normal');
  await learner.flush();
  return { learner, events, store };
}

describe('live learning is counted and written down', () => {
  it('counts matches with people, tells the admin log what came of each (also when nothing moved), and survives a restart', async () => {
    const { learner, events, store } = await learned();
    const st = learner.liveStatus();
    assert.equal(st.people, 1);
    assert.equal(st.botOnly, 0);
    assert.equal(st.sinceCommit, 1);
    assert.ok(st.lastAt);
    assert.equal(st.persistent, false, 'the memory store is the not-persistent fallback');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'people');
    assert.match(events[0].text, /changed|Nothing to learn/);
    // a match where the bots learn nothing is still recorded, with the reason
    const none = new BotLearner(new MemoryStore(), () => 0.5, stub([]));
    const seen: StudiedEvent[] = [];
    none.onStudied = (e) => seen.push(e);
    await none.learnFrom(peopleMatch('warrior', 'mage', 4), 'abc124');
    assert.equal(seen.length, 1);
    assert.match(seen[0].text, /^Nothing to learn from this match: /);
    await learner.flush();
    const again = new BotLearner(store);
    await again.whenReady();
    assert.equal(again.liveStatus().people, 1, 'the counters are kept in the store');
  });

  it('bot-only matches only count when the owner chose to train on them, and are told apart', async () => {
    const l = new BotLearner(new MemoryStore(), () => 0.5, stub([]));
    const seen: StudiedEvent[] = [];
    l.onStudied = (e) => seen.push(e);
    await l.trainOn(botsOnlyMatch(5), 'abc125', { source: 'auto' });
    await l.trainOn(botsOnlyMatch(6), 'abc126', { source: 'owner' });
    const st = l.liveStatus();
    assert.equal(st.botOnly, 1, 'only the automatic study counts as live learning');
    assert.equal(st.people, 0);
    assert.equal(st.sinceCommit, 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, 'bots');
  });

  it('a report of a fight with mistakes but no movement says so', () => {
    const bot: BotReport = { classId: 'mage', won: false, foes: ['warrior'], engagedSec: 60, mistakes: [{ label: 'casts kicked', count: 2 }], compared: [], lessons: [] };
    assert.match(nothingReason([bot]), /2 mistakes showed \(2 casts kicked\)/);
  });
});

describe('committing the learned bots', () => {
  it('exports only the classes that learned, in the files\' formats', async () => {
    const { learner } = await learned();
    const x = await learner.exportLive();
    assert.deepEqual(Object.keys(x.brains), ['mage']);
    assert.notDeepEqual(x.brains.mage, roundBrain(brainFor('mage')));
    assert.deepEqual(Object.keys(x.players).sort(), ['mage', 'priest', 'rogue', 'warrior']);
    assert.deepEqual(x.players.mage.vsPeople.warrior, { games: 6, botWins: 2 });
    assert.equal(x.matches, 1);
  });

  it('is ONE commit with the two data files and the patch bookkeeping, and a single player-facing line', async () => {
    const { learner } = await learned();
    const calls: Call[] = [];
    const dev = new DevTools(new MemoryStore(), { GITHUB_TOKEN: 'tok' }, mkHttp(calls));
    const data = await learner.exportLive();
    data.matches = 42;
    // bigger than anything the repo's own players.json already holds, so this side wins the merge whatever the file has by now
    data.players.mage.vsPeople.warrior = { games: 987654, botWins: 321 };
    const r = await dev.commitLearnedBots(data, 'Toke');
    assert.equal(commits(calls).length, 1);
    assert.equal(calls.filter((c) => c.url.endsWith('/git/trees')).length, 1);
    const files = tree(calls);
    const paths = files.map((f) => f.path).sort();
    assert.deepEqual(paths, ['README.md', 'client/package.json', 'package.json', 'shared/data/botbrain.json', 'shared/data/patches.json', 'shared/data/players.json', 'shared/src/replay.ts']);
    const patches = JSON.parse(files.find((f) => f.path === 'shared/data/patches.json')!.content) as { version: string; title: string; changes: string[] }[];
    const before = JSON.parse(fs.readFileSync(new URL('../../shared/data/patches.json', import.meta.url), 'utf8')) as { version: string }[];
    const [a, b, c] = before[0].version.split('.').map(Number);
    assert.equal(patches[0].version, `${a}.${b}.${c + 1}`, 'only the last number moves');
    assert.equal(r.version, patches[0].version);
    assert.equal(patches[0].title, 'Bots learned from live matches');
    assert.deepEqual(patches[0].changes, ['The bots studied 42 more matches against players and play better for it.']);
    assert.match(files.find((f) => f.path === 'package.json')!.content, new RegExp(`"version":\\s*"${r.version.replace(/\./g, '\\.')}"`));
    const sim = (f: string) => Number(/SIM_REVISION\s*=\s*(\d+)/.exec(f)![1]);
    assert.equal(sim(files.find((f) => f.path === 'shared/src/replay.ts')!.content), sim(fs.readFileSync(new URL('../../shared/src/replay.ts', import.meta.url), 'utf8')) + 1);
    const brains = JSON.parse(files.find((f) => f.path === 'shared/data/botbrain.json')!.content) as Record<string, Record<string, number>>;
    assert.deepEqual(brains.mage, data.brains.mage);
    assert.deepEqual(brains.warrior, JSON.parse(fs.readFileSync(new URL('../../shared/data/botbrain.json', import.meta.url), 'utf8')).warrior, 'other classes stay as they are');
    const players = JSON.parse(files.find((f) => f.path === 'shared/data/players.json')!.content);
    assert.equal(players.mage.vsPeople.warrior.games, 987654);
    assert.ok(hasHumanData(players, 'mage'));
    assert.equal(dev.commits[0].version, r.version, 'it shows with the other commits');
  });

  it('says "1 more match" for one, refuses with no new matches or no token', async () => {
    const { learner } = await learned();
    const calls: Call[] = [];
    const dev = new DevTools(new MemoryStore(), { GITHUB_TOKEN: 'tok' }, mkHttp(calls));
    const data = await learner.exportLive();
    await dev.commitLearnedBots(data, 'Toke');
    const patches = JSON.parse(tree(calls).find((f) => f.path === 'shared/data/patches.json')!.content) as { changes: string[] }[];
    assert.equal(patches[0].changes[0], 'The bots studied 1 more match against players and play better for it.');
    const n = calls.length;
    await assert.rejects(dev.commitLearnedBots({ ...data, matches: 0 }, 'Toke'), /have not studied a match/);
    await assert.rejects(new DevTools(new MemoryStore(), {}).commitLearnedBots(data, 'Toke'), /No GITHUB_TOKEN/);
    assert.equal(calls.length, n, 'nothing was sent');
  });

  it('merging keeps the side with more evidence', () => {
    const merged = mergePlayers(
      { mage: { style: { strafe: { value: 0.9, weight: 500 } } as any, vsPeople: { warrior: { games: 50, botWins: 10 } } } },
      { warrior: { style: {}, vsPeople: {} }, mage: { style: { strafe: { value: 0.1, weight: 20 } } as any, vsPeople: { warrior: { games: 6, botWins: 2 }, rogue: { games: 3, botWins: 1 } } }, priest: { style: {}, vsPeople: {} }, rogue: { style: {}, vsPeople: {} } },
    );
    assert.equal((merged.mage.style as any).strafe.value, 0.9);
    assert.equal(merged.mage.vsPeople.warrior.games, 50);
    assert.equal(merged.mage.vsPeople.rogue.games, 3);
  });
});

describe('Commit learned bots from the admin panel', () => {
  const mkP = (name: string, out: ServerMsg[], extra: object) => ({ ws: { readyState: 1, send: (s: string) => out.push(JSON.parse(s)), bufferedAmount: 0 } as any, name, classId: 'mage', matches: 0, wins: 0, size: 1, ip: '1.1.1.1', mapPref: 'random', ...extra }) as any;
  const last = <T extends ServerMsg['t']>(out: ServerMsg[], t: T) => [...out].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;

  it('is the owner\'s: committed, logged, counter reset; a dev only sees the status', async () => {
    const store = new MemoryStore();
    const { learner } = await learned(store);
    const calls: Call[] = [];
    const dev = new DevTools(store, { GITHUB_TOKEN: 'tok' }, mkHttp(calls));
    const log = new AdminLog(store);
    const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0 }, undefined, learner, undefined, dev, log);
    const outO: ServerMsg[] = [];
    const outD: ServerMsg[] = [];
    const owner = mkP('Toke', outO, { ownerOk: true });
    const devP = mkP('Dee', outD, { account: { name: 'Dee', key: 'dee', grants: ['dev'] } });
    for (const p of [owner, devP]) (lobby as any).conns.add(p);
    assert.ok(parseClientMsg(JSON.stringify({ t: 'admin_act', act: 'bot_commit' })));

    lobby.handle(devP, { t: 'admin_act', act: 'bot_commit' } as ClientMsg);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(last(outD, 'dev_result')?.ok, false);
    assert.match(last(outD, 'dev_result')!.text, /owner only/);
    assert.equal(commits(calls).length, 0);
    lobby.handle(devP, { t: 'admin_act', act: 'bot_knowledge' } as ClientMsg);
    await new Promise((r) => setTimeout(r, 30));
    const k = last(outD, 'bot_knowledge')!;
    assert.equal(k.live?.people, 1);
    assert.equal(k.live?.persistent, false);
    assert.equal(k.live?.sinceCommit, 1);

    lobby.handle(owner, { t: 'admin_act', act: 'bot_commit' } as ClientMsg);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(commits(calls).length, 1);
    assert.equal(last(outO, 'dev_result')?.ok, true, last(outO, 'dev_result')?.text);
    assert.equal(learner.liveStatus().sinceCommit, 0);
    assert.equal(learner.liveStatus().lastCommit?.matches, 1);
    const rows = await log.list();
    assert.ok(rows.some((r) => r.action === 'committed learned bots to GitHub'), JSON.stringify(rows));
    // a second press has nothing new to commit
    lobby.handle(owner, { t: 'admin_act', act: 'bot_commit' } as ClientMsg);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(commits(calls).length, 1);
    assert.equal(last(outO, 'dev_result')?.ok, false);
  });

  it('every match the bots study on their own lands in the admin log', async () => {
    const store = new MemoryStore();
    const learner = new BotLearner(store, () => 0.5, stub([]));
    const log = new AdminLog(store);
    new Lobby({ practicePrepMs: 0, queuePrepMs: 0 }, undefined, learner, undefined, undefined, log);
    await learner.learnFrom(peopleMatch('warrior', 'mage', 7), 'abc127');
    await new Promise((r) => setTimeout(r, 30));
    const row = (await log.list()).find((r) => r.action === 'studied a match with people');
    assert.ok(row);
    assert.equal(row!.target, 'abc127');
    assert.match(row!.detail ?? '', /Nothing to learn from this match/);
  });
});

describe('scripts/train-bots.ts without human data', () => {
  it('warns that it is bot-vs-bot self-play and refuses to write botbrain.json', () => {
    const file = new URL('../../shared/data/botbrain.json', import.meta.url);
    const players = JSON.parse(fs.readFileSync(new URL('../../shared/data/players.json', import.meta.url), 'utf8'));
    if (hasHumanData(players, 'mage')) return; // the repository has real data: the guard has nothing to say
    const before = fs.readFileSync(file, 'utf8');
    const r = spawnSync('npx', ['tsx', 'scripts/train-bots.ts', '--classes', 'mage', '--gens', '1', '--mutants', '1', '--seeds', '1'], { cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /BOT-VS-BOT SELF-PLAY/);
    assert.match(r.stderr, /--allow-sim-only/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
});
