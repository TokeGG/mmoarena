// Writes shared/data/looks.json: one entry per skill, every part "as it is now" (the game's own look). Kept entries are not changed.
import { readFileSync, writeFileSync } from 'node:fs';
import { NEUTRAL_LOOK, looksFor } from '../shared/src/index';

const path = new URL('../shared/data/looks.json', import.meta.url);
let old: Record<string, Record<string, unknown>> = {};
try {
  old = JSON.parse(readFileSync(path, 'utf8'));
} catch {
  /* first run */
}
const out: Record<string, Record<string, unknown>> = {};
for (const id of looksFor()) out[id] = { ...NEUTRAL_LOOK, ...(old[id] ?? {}) };
writeFileSync(path, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${Object.keys(out).length} skill looks`);
