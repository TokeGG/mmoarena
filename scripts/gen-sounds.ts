// Writes shared/data/sounds.json: one entry for every sound id (soundList) with its starting recording, volume 1, pitch 1, on.
// Run after adding a skill: `npx tsx scripts/gen-sounds.ts`. Settings already in the file are kept.
import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_SOUND_FILES, DEFAULT_SOUND_TUNING, DEFAULT_SOUND_VOLUME, soundList } from '../shared/src/index';

const path = new URL('../shared/data/sounds.json', import.meta.url);
let old: Record<string, { file?: string; volume?: number; pitch?: number; off?: number }> = {};
try {
  old = JSON.parse(readFileSync(path, 'utf8'));
} catch {
  /* a first run */
}
const out: Record<string, { file: string; volume: number; pitch: number; off: number }> = {};
for (const s of soundList()) {
  const was = old[s.id];
  const file = was?.file ?? DEFAULT_SOUND_FILES[s.id] ?? '';
  out[s.id] = { file, volume: was?.volume ?? DEFAULT_SOUND_TUNING[s.id]?.volume ?? (file ? DEFAULT_SOUND_VOLUME : 1), pitch: was?.pitch ?? DEFAULT_SOUND_TUNING[s.id]?.pitch ?? 1, off: was?.off ?? 0 };
}
writeFileSync(path, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${Object.keys(out).length} sounds`);
