/**
 * Offline self-play training for bot brains. Usage:
 *   npx tsx scripts/train-bots.ts [--classes warrior,rogue] [--gens 4] [--mutants 5] [--seeds 8] [--minutes 20]
 * Each generation mutates the current champion, plays every candidate against the other classes' bots (1v1, hard,
 * specs rotating) on the same seeds, keeps the best, and writes shared/data/botbrain.json. Run it after every patch
 * that changes abilities, then commit the file (see CLAUDE.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArenaSim, Bot, CLASS_IDS, SPECS, brainFor, botBuild, mutateBrain, BRAIN_KEYS } from '../shared/src/index';
import type { Brain, ClassId } from '../shared/src/index';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const classes = arg('classes', CLASS_IDS.join(',')).split(',') as ClassId[];
const GENS = Number(arg('gens', '4'));
const MUTANTS = Number(arg('mutants', '5'));
const SEEDS = Number(arg('seeds', '8'));
const deadline = Date.now() + Number(arg('minutes', '20')) * 60000;

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
function evaluate(cls: ClassId, brain: Brain): number {
  let total = 0;
  let n = 0;
  for (const foe of CLASS_IDS) { // every class, the mirror included
    for (let seed = 1; seed <= SEEDS; seed++) {
      const sim = new ArenaSim({ seed, prepMs: 3000 });
      const a = sim.addUnit({ name: cls, classId: cls, team: 0, controller: 'bot', build: botBuild(cls, seed) });
      const b = sim.addUnit({ name: foe, classId: foe, team: 1, controller: 'bot', build: botBuild(foe, seed + 7) });
      const bots = [new Bot(sim, a.id, 'hard', seed * 31 + a.id, brain), new Bot(sim, b.id, 'hard', seed * 31 + b.id)];
      let ms = 0;
      while (sim.phase !== 'ended' && ms < 150000) {
        for (const x of bots) x.tick();
        sim.step();
        ms += 50;
      }
      const won = sim.winner === 0;
      // a win counts most, health left over rewards staying alive; a loss still earns credit for damage dealt and for lasting
      total += won ? 1 + 0.6 * (a.health / a.maxHealth) : 0.3 * (1 - b.health / b.maxHealth) + 0.3 * Math.min(1, ms / 60000); // staying alive pays in wins and in losses
      n++;
    }
  }
  return total / n;
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
  out[cls] = rounded;
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
}
void SPECS;
