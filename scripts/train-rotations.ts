/**
 * Learns each spec's damage rotation. Usage:
 *   npx tsx scripts/train-rotations.ts [--seconds 45] [--tries 160] [--specs mage:fire,rogue:subtlety]
 * For every spec it plays its damage abilities (the bar and every talent swap that adds one) against a target dummy in a
 * fixed priority order, with the real cooldowns, costs, global cooldown, procs and combo points, and searches for the
 * order that deals the most damage over the fight: start from the bar order, then keep any swap or move of one ability
 * that does better (several builds per spec, so the order also suits the talent swaps). Writes shared/data/rotations.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLASS_IDS, SPECS, botBuild, isRotationAbility, rotationDamage, talentsFor } from '../shared/src/index';
import type { Build, ClassId } from '../shared/src/index';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SECONDS = Number(arg('seconds', '45'));
const TRIES = Number(arg('tries', '160'));
const only = arg('specs', '').split(',').filter(Boolean);

const damageOf = (classId: ClassId, build: Build, order: string[]) => rotationDamage(classId, build, order, SECONDS);

function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../shared/data/rotations.json');
const out = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string[]>;
for (const classId of CLASS_IDS) {
  for (const spec of SPECS[classId]) {
    const key = `${classId}:${spec.id}`;
    if (only.length && !only.includes(key)) continue;
    const swaps = talentsFor(classId, spec.id).flat().flatMap((t) => (t.swap ? [t.swap.to] : []));
    const pool = [...new Set([...spec.bar, ...swaps])].filter(isRotationAbility);
    if (!pool.length) continue;
    // the plain spec, plus a few talent builds (seeded) so swapped-in abilities are scored where they really show up
    const builds: Build[] = [{ spec: spec.id, talents: [], gear: {} }];
    for (let s = 1; builds.length < 4 && s < 200; s++) {
      const b = botBuild(classId, s);
      if (b.spec === spec.id) builds.push(b);
    }
    const score = (order: string[]) => builds.reduce((n, b) => n + damageOf(classId, b, order), 0) / builds.length;
    const rng = mulberry32(key.length * 977);
    const prior = out[key] ?? [];
    let best = [...prior.filter((x) => pool.includes(x)), ...pool.filter((x) => !prior.includes(x))];
    let bestScore = score(best);
    const start = bestScore;
    // a few fresh random starting orders too, so the search does not stay in the first hollow it finds
    for (let r = 0; r < 3; r++) {
      const shuffled = [...pool].sort(() => rng() - 0.5);
      const s = score(shuffled);
      if (s > bestScore) { best = shuffled; bestScore = s; }
    }
    for (let i = 0; i < TRIES; i++) {
      const cand = [...best];
      const a = Math.floor(rng() * cand.length);
      const b = Math.floor(rng() * cand.length);
      if (a === b) continue;
      if (rng() < 0.5) [cand[a], cand[b]] = [cand[b], cand[a]];
      else cand.splice(b, 0, cand.splice(a, 1)[0]);
      const s = score(cand);
      if (s > bestScore * 1.002) {
        best = cand;
        bestScore = s;
      }
    }
    out[key] = best;
    console.log(`${key}: ${Math.round(start)} -> ${Math.round(bestScore)} damage in ${SECONDS}s  [${best.join(', ')}]`);
  }
}
fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${file}`);
