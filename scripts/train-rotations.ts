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
import { trainRotations } from '../shared/src/index';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../shared/data/rotations.json');
const prior = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string[]>;
const out = trainRotations(prior, { seconds: Number(arg('seconds', '45')), tries: Number(arg('tries', '160')), only: arg('specs', '').split(',').filter(Boolean), log: console.log });
fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${file}`);
