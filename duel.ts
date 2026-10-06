/**
 * Headless bot-vs-bot balance run.
 *   npm run duel                  (10 seeds per matchup, normal difficulty)
 *   npm run duel -- 30 hard       (30 seeds, hard difficulty)
 *
 * This measures how the BOTS' playbook performs, not how humans will. Use it to spot broken classes,
 * stuck bots (draws) and wildly lopsided numbers, then tune shared/data/*.json.
 */
import { ArenaSim, Bot, TUNING } from '../src/index';
import type { ClassId, Difficulty, TeamId } from '../src/index';

const seeds = Number(process.argv[2]) || 10;
const difficulty = (process.argv[3] as Difficulty) || 'normal';
const classes: ClassId[] = ['warrior', 'mage', 'priest', 'rogue'];

const comps: ClassId[][] = [];
for (let i = 0; i < classes.length; i++) for (let j = i; j < classes.length; j++) comps.push([classes[i], classes[j]]);
const label = (c: ClassId[]) => c.join('+');

function play(a: ClassId[], b: ClassId[], seed: number): { winner: TeamId | 'draw'; ms: number } {
  const sim = new ArenaSim({ seed, prepMs: 3000 });
  const bots: Bot[] = [];
  ([a, b] as ClassId[][]).forEach((comp, team) => {
    for (const classId of comp) {
      const u = sim.addUnit({ name: classId, classId, team: team as TeamId, controller: 'bot' });
      bots.push(new Bot(sim, u.id, difficulty, seed * 31 + u.id));
    }
  });
  while (sim.phase !== 'ended' && sim.time < TUNING.maxMatchMs + 5000) {
    for (const bot of bots) bot.tick();
    sim.step();
    sim.drainEvents();
  }
  return { winner: sim.winner ?? 'draw', ms: sim.time - sim.prepEndsAt };
}

interface Stat { wins: number; games: number; draws: number; ms: number }
const comp = new Map<string, Stat>();
const cls = new Map<ClassId, Stat>();
const bump = (m: Map<any, Stat>, k: any, won: boolean, draw: boolean, ms: number) => {
  const s = m.get(k) ?? { wins: 0, games: 0, draws: 0, ms: 0 };
  s.games++;
  s.ms += ms;
  if (draw) s.draws++;
  else if (won) s.wins++;
  m.set(k, s);
};

const t0 = Date.now();
let total = 0;
for (const a of comps) {
  for (const b of comps) {
    if (label(a) === label(b)) continue;
    for (let s = 0; s < seeds; s++) {
      const r = play(a, b, s + 1);
      total++;
      const draw = r.winner === 'draw';
      bump(comp, label(a), r.winner === 0, draw, r.ms);
      bump(comp, label(b), r.winner === 1, draw, r.ms);
      for (const c of new Set(a)) bump(cls, c, r.winner === 0, draw, r.ms);
      for (const c of new Set(b)) bump(cls, c, r.winner === 1, draw, r.ms);
    }
  }
}

const pct = (n: number, d: number) => (d ? ((n / d) * 100).toFixed(0).padStart(3) + '%' : '  - ');
const row = (name: string, s: Stat) =>
  `| ${name.padEnd(16)} | ${pct(s.wins, s.games - s.draws)} | ${pct(s.draws, s.games)} | ${(s.ms / s.games / 1000).toFixed(0).padStart(4)}s | ${String(s.games).padStart(4)} |`;

console.log(`\n${total} matches, ${seeds} seeds per matchup, ${difficulty} bots, ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
console.log('| Team              | Win% (excl. draws) | Draw% | Avg length | Games |');
console.log('|---|---|---|---|---|');
for (const [k, s] of [...comp].sort((x, y) => y[1].wins / (y[1].games - y[1].draws || 1) - x[1].wins / (x[1].games - x[1].draws || 1))) console.log(row(k, s));
console.log('\n| Class (any team containing it) | Win% | Draw% | Avg length | Games |');
console.log('|---|---|---|---|---|');
for (const [k, s] of cls) console.log(row(k, s));
