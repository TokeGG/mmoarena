/**
 * Study how people beat the bots, from real replays. Usage:
 *   npx tsx scripts/study-replays.ts --server https://your.server --code OWNER_CODE   (the live server's kept replays)
 *   npx tsx scripts/study-replays.ts --store                                           (straight from Upstash: UPSTASH_REDIS_REST_URL/TOKEN)
 *   npx tsx scripts/study-replays.ts --dir path/to/replays                             (.json or gzipped files, e.g. from /api/replay/<id>)
 *   add --apply to move shared/data/botbrain.json towards the lessons, --limit N to read only the newest N
 *
 * The server keeps the newest 400 matches between people and bots (solo practice included). Each is played back
 * (shared/src/outplay.ts): every way a person beat a bot becomes a lesson for one of its brain numbers, and how the
 * people kick and fake is measured too. It writes shared/data/players.json: per class, how people play and the bots' real
 * win rates against them. scripts/train-bots.ts then trains against player-like opponents, weighted towards the
 * match-ups bots lose most, and `--calibrate` there compares its simulated win rates with these real ones.
 * Replays recorded on other game data (an older patch) cannot be played back the same and are skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { BRAIN_KEYS, CLASS_IDS, brainFor, contentHash, measureHumans, lessonBrain, mergeStyle, studyMatch } from '../shared/src/index';
import type { BotStudy, ClassId, HumanStyle, Lessons, ReplayData } from '../shared/src/index';
import { createStore } from '../server/src/store';

const has = (k: string) => process.argv.includes(`--${k}`);
const arg = (k: string, d = '') => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] ?? d : d;
};
const LIMIT = Number(arg('limit', '400'));
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function parse(buf: Buffer): ReplayData | null {
  try {
    const text = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    const v = JSON.parse(text) as ReplayData;
    return v && v.v === 1 && Array.isArray(v.units) && Array.isArray(v.cmds) ? v : null;
  } catch {
    return null;
  }
}

async function* source(): AsyncGenerator<ReplayData> {
  if (has('dir')) {
    const dir = arg('dir');
    const files = fs.readdirSync(dir).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile());
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const f of files.slice(0, LIMIT)) {
      const r = parse(fs.readFileSync(f));
      if (r) yield r;
    }
    return;
  }
  if (has('server')) {
    const base = arg('server').replace(/\/$/, '');
    const headers = { 'x-owner-code': arg('code') };
    const res = await fetch(`${base}/api/botlearn/export`, { headers });
    if (!res.ok) throw new Error(`export: ${res.status} ${await res.text()}`);
    const exp = (await res.json()) as { index: { id: string }[] };
    for (const e of exp.index.slice(0, LIMIT)) {
      const r = await fetch(`${base}/api/botlearn/replay/${e.id}`, { headers });
      if (!r.ok) continue; // expired
      const rp = parse(Buffer.from(await r.arrayBuffer()));
      if (rp) yield rp;
    }
    return;
  }
  if (has('store')) {
    const store = createStore();
    const raw = await store.get('lrp:index');
    const index = raw ? (JSON.parse(raw) as { id: string }[]) : [];
    for (const e of index.slice(0, LIMIT)) {
      const b = await store.get(`lrp:${e.id}`);
      const rp = b ? parse(Buffer.from(b, 'base64')) : null;
      if (rp) yield rp;
    }
    return;
  }
  console.error('Give a source: --server URL --code CODE, --store, or --dir PATH');
  process.exit(1);
}

const hash = contentHash();
let read = 0;
let stale = 0;
const lessons = new Map<ClassId, Lessons>();
const styles = new Map<ClassId, HumanStyle>();
/** bot class -> person class -> games and bot wins */
const real = new Map<ClassId, Map<ClassId, { g: number; w: number }>>();
const studies: BotStudy[] = [];

for await (const replay of source()) {
  read++;
  if (replay.hash !== hash) {
    stale++;
    continue;
  }
  const st = studyMatch(replay);
  for (const b of st.bots) {
    studies.push(b);
    lessons.set(b.classId, mergeStyle(lessons.get(b.classId) ?? {}, b.lessons));
    const row = real.get(b.classId) ?? new Map();
    real.set(b.classId, row);
    for (const p of new Set(b.foes)) {
      const e = row.get(p) ?? { g: 0, w: 0 };
      e.g++;
      if (b.won) e.w++;
      row.set(p, e);
    }
  }
  for (const p of st.players) if (Object.keys(p.sample).length) styles.set(p.classId, mergeStyle(styles.get(p.classId) ?? {}, p.sample));
  for (const h of measureHumans(replay)) if (Object.keys(h.sample).length) styles.set(h.classId, mergeStyle(styles.get(h.classId) ?? {}, h.sample));
}

console.log(`read ${read} replays, ${read - stale} on this patch's data (${stale} from older patches skipped)\n`);
const pct = (x: number) => `${Math.round(x * 100)}%`;
for (const c of CLASS_IDS) {
  const mine = studies.filter((s) => s.classId === c);
  if (!mine.length) continue;
  const losses = mine.filter((s) => !s.won);
  const sum = (f: (s: BotStudy) => number, xs = mine) => xs.reduce((a, s) => a + f(s), 0);
  console.log(`${c} bots: ${mine.length} games against people, won ${pct(sum((s) => (s.won ? 1 : 0)) / mine.length)}`);
  for (const [p, e] of real.get(c) ?? []) console.log(`  vs ${p.padEnd(8)} ${String(e.g).padStart(4)} games, bot won ${pct(e.w / e.g)}`);
  console.log('  how people beat them:');
  const threat = sum((s) => s.facts.castsUnderThreat);
  if (threat) console.log(`    casts kicked while a kick was ready: ${pct(sum((s) => s.facts.kicked) / Math.max(1, threat))} of ${threat}`);
  if (sum((s) => s.facts.juked + s.facts.kicksLanded)) console.log(`    its kicks juked: ${sum((s) => s.facts.juked)}, landed: ${sum((s) => s.facts.kicksLanded)}`);
  if (losses.length) {
    console.log(`    losses with a defensive still ready: ${pct(losses.filter((s) => s.facts.diedWithDefensive).length / losses.length)}`);
    console.log(`    losses to a burst (half its health in 3 s): ${pct(losses.filter((s) => s.facts.burstDeaths).length / losses.length)}`);
  }
  const sec = sum((s) => s.facts.engagedSec);
  if (sec) console.log(`    long casts taken per minute: ${(sum((s) => s.facts.bigCastsTaken) / (sec / 60)).toFixed(1)}, ground-effect hits per minute: ${(sum((s) => s.facts.zoneHits) / (sec / 60)).toFixed(1)}`);
  const L = lessons.get(c) ?? {};
  const base = brainFor(c);
  const next = lessonBrain(base, L);
  const moved = BRAIN_KEYS.filter((k) => Math.abs(next[k] - base[k]) > 1e-3).map((k) => `${k} ${base[k].toFixed(2)}→${next[k].toFixed(2)}`);
  console.log(`  lessons: ${moved.length ? moved.join(', ') : 'not enough evidence yet'}\n`);
}

if (read - stale === 0) {
  console.log('nothing on this patch to learn from yet: shared/data/players.json left as it was');
  process.exit(0);
}
// what offline training reads: how people play each class, and how bots really do against them
const playersFile = path.join(root, 'shared/data/players.json');
const out: Record<string, { style: HumanStyle; vsPeople: Record<string, { games: number; botWins: number }> }> = {};
for (const c of CLASS_IDS) {
  out[c] = {
    style: Object.fromEntries(Object.entries(styles.get(c) ?? {}).map(([k, m]) => [k, { value: Math.round(m!.value * 1000) / 1000, weight: Math.round(m!.weight) }])) as HumanStyle,
    vsPeople: Object.fromEntries([...(real.get(c) ?? [])].map(([p, e]) => [p, { games: e.g, botWins: e.w }])),
  };
}
fs.writeFileSync(playersFile, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${path.relative(root, playersFile)}`);

if (has('apply')) {
  const file = path.join(root, 'shared/data/botbrain.json');
  const now = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, number>>;
  for (const c of CLASS_IDS) {
    const L = lessons.get(c);
    if (!L) continue;
    const b = lessonBrain(brainFor(c), L);
    now[c] = Object.fromEntries(BRAIN_KEYS.map((k) => [k, Math.round(b[k] * 1000) / 1000]));
  }
  fs.writeFileSync(file, JSON.stringify(now, null, 1) + '\n');
  console.log('applied the lessons to shared/data/botbrain.json');
}
