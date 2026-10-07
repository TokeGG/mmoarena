/**
 * Offline training for bot brains. Usage:
 *   npx tsx scripts/train-bots.ts [--classes warrior,rogue] [--gens 4] [--mutants 5] [--seeds 8] [--minutes 20] [--sizes 1,2,3]
 *   npx tsx scripts/train-bots.ts --calibrate [--seeds 12]   (simulated 1v1 win rates next to the real ones, no training)
 * Each generation mutates the current champion, plays every candidate against the other classes (specs and talents
 * rotating) on the same seeds, in 1v1, 2v2 and 3v3 and on every arena in turn, keeps the best, and writes
 * shared/data/botbrain.json. Run it after every patch that changes abilities, then commit the file (see CLAUDE.md).
 *
 * Training against bots alone teaches bots to beat bots. When shared/data/players.json has real data (written by
 * scripts/study-replays.ts from the server's replays), the opponents play the way people of that class do (their
 * spacing, sidestepping, kick timing and fakes), and the match-ups the bots really lose most against people count most.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARENAS, ArenaSim, Bot, CLASS_IDS, SPECS, brainFor, botBuild, mutateBrain, styledBrain, BRAIN_KEYS } from '../shared/src/index';
import type { Brain, ClassId, HumanStyle } from '../shared/src/index';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const classes = arg('classes', CLASS_IDS.join(',')).split(',') as ClassId[];
const GENS = Number(arg('gens', '4'));
const MUTANTS = Number(arg('mutants', '5'));
const SEEDS = Number(arg('seeds', '8'));
const deadline = Date.now() + Number(arg('minutes', '20')) * 60000;
const SIZES = arg('sizes', '1,2,3').split(',').map(Number).filter((n) => n >= 1 && n <= 3);

const playersFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '../shared/data/players.json');
type Players = Partial<Record<ClassId, { style?: HumanStyle; vsPeople?: Partial<Record<ClassId, { games: number; botWins: number }>> }>>;
const players: Players = fs.existsSync(playersFile) ? (JSON.parse(fs.readFileSync(playersFile, 'utf8')) as Players) : {};
/** How a person of this class plays, as a brain: the trained one pulled towards what the replays measured. */
const playerBrain = (c: ClassId): Brain => styledBrain(brainFor(c), players[c]?.style ?? {});
/** The bots' real win rate against people of `foe` (null without enough games to say). */
const realRate = (cls: ClassId, foe: ClassId): number | null => {
  const e = players[cls]?.vsPeople?.[foe];
  return e && e.games >= 5 ? e.botWins / e.games : null;
};
/** Train hardest where the bots lose most to people: weight 0.5 (bots win them all) to 1.5 (bots never win). */
const foeWeight = (cls: ClassId, foe: ClassId) => {
  const r = realRate(cls, foe);
  return r === null ? 1 : 0.5 + (1 - r);
};

function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Score (about 0..1.6) for `cls` playing with `brain`: wins count 1, plus up to 0.3 for health left; losses 0 plus a little for damage dealt. */
function evaluate(cls: ClassId, brain: Brain, only?: { foe: ClassId; size: number; wins: boolean }): number {
  let total = 0;
  let n = 0;
  for (const foe of only ? [only.foe] : CLASS_IDS) { // every class, the mirror included
    const fw = only ? 1 : foeWeight(cls, foe);
    for (let seed = 1; seed <= SEEDS; seed++) {
      // team size and arena rotate with the seed: the brain has to work in every mode and on every map
      const size = only ? only.size : SIZES[seed % SIZES.length];
      const sim = new ArenaSim({ seed, prepMs: 3000, arena: ARENAS[(seed + foe.length) % ARENAS.length] });
      const a = sim.addUnit({ name: cls, classId: cls, team: 0, controller: 'bot', build: botBuild(cls, seed) });
      const b = sim.addUnit({ name: foe, classId: foe, team: 1, controller: 'bot', build: botBuild(foe, seed + 7) });
      // the other side plays like people of its class do (as far as the replays have measured)
      const bots = [new Bot(sim, a.id, 'hard', seed * 31 + a.id, brain), new Bot(sim, b.id, 'hard', seed * 31 + b.id, playerBrain(foe))];
      // the rest of each team: other classes on the same baseline brains (the trainee's teammates share its brain)
      for (let i = 1; i < size; i++) {
        const mate = CLASS_IDS[(CLASS_IDS.indexOf(cls) + i * 2 + seed) % CLASS_IDS.length];
        const rival = CLASS_IDS[(CLASS_IDS.indexOf(foe) + i * 3 + seed) % CLASS_IDS.length];
        const m = sim.addUnit({ name: mate, classId: mate, team: 0, controller: 'bot', build: botBuild(mate, seed * 3 + i) });
        const r = sim.addUnit({ name: rival, classId: rival, team: 1, controller: 'bot', build: botBuild(rival, seed * 5 + i) });
        bots.push(new Bot(sim, m.id, 'hard', seed * 37 + m.id, mate === cls ? brain : undefined), new Bot(sim, r.id, 'hard', seed * 41 + r.id, playerBrain(rival)));
      }
      let ms = 0;
      while (sim.phase !== 'ended' && ms < 150000) {
        for (const x of bots) x.tick();
        sim.step();
        ms += 50;
      }
      const won = sim.winner === 0;
      if (only?.wins) {
        total += won ? 1 : sim.winner === 'draw' || sim.winner === null ? 0.5 : 0;
        n++;
        continue;
      }
      // a win counts most, health left over rewards staying alive; a loss still earns credit for damage dealt and for lasting
      total += fw * (won ? 1 + 0.6 * (a.health / a.maxHealth) : 0.3 * (1 - b.health / b.maxHealth) + 0.3 * Math.min(1, ms / 60000)); // staying alive pays in wins and in losses
      n += fw;
    }
  }
  return total / n;
}

if (process.argv.includes('--calibrate')) {
  // simulated 1v1 against player-like opponents next to the bots' real results against people
  console.log('bot class  vs class   simulated  real (games)');
  for (const cls of classes) {
    for (const foe of CLASS_IDS) {
      const sim = evaluate(cls, brainFor(cls), { foe, size: 1, wins: true });
      const e = players[cls]?.vsPeople?.[foe];
      const realTxt = e?.games ? `${Math.round((e.botWins / e.games) * 100)}% (${e.games})` : 'no data';
      console.log(`${cls.padEnd(10)} ${foe.padEnd(10)} ${`${Math.round(sim * 100)}%`.padStart(9)}  ${realTxt}`);
    }
  }
  process.exit(0);
}

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../shared/data/botbrain.json');
const out = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Partial<Brain>>;
for (const cls of classes) {
  const rng = mulberry32(1234 + cls.length);
  let champ = brainFor(cls);
  let best = evaluate(cls, champ);
  console.log(`${cls}: baseline ${best.toFixed(3)}`);
  for (let g = 1; g <= GENS && Date.now() < deadline; g++) {
    let improved = false;
    for (let m = 0; m < MUTANTS && Date.now() < deadline; m++) {
      const cand = mutateBrain(champ, rng, 0.2 / g ** 0.5, 0.5);
      const s = evaluate(cls, cand);
      if (s > best + 0.005) {
        best = s;
        champ = cand;
        improved = true;
      }
    }
    console.log(`${cls}: gen ${g} ${best.toFixed(3)}${improved ? '' : ' (no change)'}`);
  }
  const rounded: Record<string, number> = {};
  for (const k of BRAIN_KEYS) rounded[k] = Math.round(champ[k] * 1000) / 1000;
  // re-read before writing: other classes may be training in parallel processes and writing the same file
  const now = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Partial<Brain>>;
  now[cls] = rounded;
  fs.writeFileSync(file, JSON.stringify(now, null, 1) + '\n');
}
void SPECS;
