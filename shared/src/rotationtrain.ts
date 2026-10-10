import { ABILITIES, CLASSES, CLASS_IDS, SPECS, TALENTS } from './data';
import { talentsFor } from './build';
import { botBuild } from './bot';
import { isRotationAbility, rotationDamage } from './rotation';
import { mulberry32 } from './sim';
import type { Build, ClassId } from './types';

export interface TrainOptions {
  seconds?: number;
  tries?: number;
  /** `class:spec` keys to train (all specs when empty). */
  only?: readonly string[];
  log?: (line: string) => void;
}

/**
 * Learns each spec's damage rotation against the data as it is right now (the same search as scripts/train-rotations.ts): start from
 * the order known so far, then keep any swap or move of one ability that does more damage over the fight. Returns the new table
 * (specs not trained keep their old order). The server runs this with a patch's numbers applied, so bots play the new numbers.
 */
export function trainRotations(prior: Record<string, string[]>, opts: TrainOptions = {}): Record<string, string[]> {
  const SECONDS = opts.seconds ?? 45;
  const TRIES = opts.tries ?? 160;
  const only = opts.only ?? [];
  const out: Record<string, string[]> = { ...prior };
  for (const classId of CLASS_IDS as ClassId[]) {
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
      const score = (order: string[]) => builds.reduce((n, b) => n + rotationDamage(classId, b, order, SECONDS), 0) / builds.length;
      const rng = mulberry32(key.length * 977);
      const was = out[key] ?? [];
      let best = [...was.filter((x) => pool.includes(x)), ...pool.filter((x) => !was.includes(x))];
      let bestScore = score(best);
      const start = bestScore;
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
        if (s > bestScore * 1.002) { best = cand; bestScore = s; }
      }
      out[key] = best;
      opts.log?.(`${key}: ${Math.round(start)} -> ${Math.round(bestScore)} damage in ${SECONDS}s  [${best.join(', ')}]`);
    }
  }
  return out;
}

/** The `class:spec` keys a set of changes can alter the best damage order of: every spec of each class they touch. */
export function affectedSpecs(patches: readonly { file: string; id: string; path: readonly (string | number)[] }[]): string[] {
  const classes = new Set<ClassId>();
  for (const p of patches) {
    if (p.file === 'abilities') {
      const c = ABILITIES[p.id]?.class as ClassId | undefined;
      if (c && CLASS_IDS.includes(c)) classes.add(c);
    } else if (p.file === 'auras') {
      for (const a of Object.values(ABILITIES)) if (a.effects.some((e) => e.type === 'aura' && e.aura === p.id) && CLASS_IDS.includes(a.class as ClassId)) classes.add(a.class as ClassId);
    } else if (p.file === 'classes') {
      if (CLASS_IDS.includes(p.id as ClassId)) classes.add(p.id as ClassId);
    } else if (p.file === 'specs' || p.file === 'talents') {
      for (const c of CLASS_IDS) {
        if (SPECS[c].some((s) => s.id === p.id) || Object.values(TALENTS[c] ?? {}).some((tiers) => tiers.some((t) => t.some((x) => x.id === p.id)))) classes.add(c);
      }
    } else if (p.file === 'tuning') {
      if (String(p.path[0]).startsWith('rage')) { for (const c of CLASS_IDS) if (CLASSES[c].resource.type === 'rage') classes.add(c); }
      else for (const c of CLASS_IDS) classes.add(c);
    }
  }
  return [...classes].flatMap((c) => SPECS[c].map((s) => `${c}:${s.id}`));
}
