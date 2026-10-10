import botbrainJson from '../data/botbrain.json' with { type: 'json' };
import type { ClassId } from './types';

/**
 * Everything about how a bot plays that is a judgement call rather than a rule. The numbers are what gets learned:
 * offline by self-play (scripts/train-bots.ts writes shared/data/botbrain.json) and live on the server, which tries
 * variants of them against real players and keeps the ones that win (server/src/botlearn.ts).
 */
export interface Brain {
  /** Health fraction below which the bot runs for a pillar to break line of sight. */
  coverHp: number;
  /** Health fraction below which it uses defensive cooldowns, vanish, evasion, desperate prayer. */
  defHp: number;
  /** 0..1 how hard it sidesteps while fighting. */
  strafe: number;
  /** Target score bonus for healers (higher = hunts the priest first). */
  healerPrio: number;
  /** Target score bonus for whatever a teammate is already attacking (focus fire). */
  focus: number;
  /** How much a low-health enemy attracts the bot (finishing weak targets). */
  killLow: number;
  /** Added to a caster's preferred distance (negative = fights closer). */
  rangeBias: number;
  /** Multiplies priest heal thresholds: above 1 heals earlier. */
  healAt: number;
  /** Enemy health fraction below which it spends burst cooldowns (it always bursts at the start of a fight too when 1). */
  burstHp: number;
  /** Seconds between its stationary-target-breaking direction flips. */
  strafeFlip: number;
  /** 0..1 how often it chases a fleeing slowed target instead of switching. */
  chase: number;
  /** Health fraction below which it spends its big emergency button (heal, shield, barrier, damage reduction). */
  panicHp: number;
  /** Fraction of max health lost in about 2.5 s that counts as a burst: it protects itself before it is low. */
  dangerAt: number;
  /** 0..1 willingness to use stuns, fears and sheep defensively as health drops (raises the health it starts at). */
  ccEarly: number;
  /** 0..1 how readily it walks out of an enemy's ground zone (Flamestrike, Blizzard) instead of standing in it. */
  dodge: number;
  /** Health fraction at or below which it keeps its own shield or barrier up while enemies are near (1 = always, even at full health). */
  preShield: number;
  /** 0..1 how often a caster fakes a cast (starts it, then stops it) while an enemy's interrupt is ready and in reach. */
  jukeChance: number;
  /** How far into a fake cast (fraction of the cast time) it stops casting. */
  jukeAt: number;
  /** How far into an enemy cast (fraction) it waits before interrupting: later beats fakes, too late misses. */
  kickAt: number;
  /** 0..1 willingness to break line of sight: stepping behind a pillar or a deck from a big enemy cast, fighting from cover. */
  losUse: number;
  /** 0..1 how much it keeps moving while it fights: strafing between casts, circling in melee, hopping. */
  mobility: number;
  /** 0..1 how readily it spends the trinket (heal, shield, cleanse): higher heals earlier and breaks out of a stun, fear or sheep at once. */
  trinketAt: number;
  /** 0..1 how early it pops its offensive cooldowns when it is losing (Recklessness, Adrenaline Rush, Arcane Power...): the health it starts at. */
  burstUse: number;
  /** 0..1 how soon a caster pushes melee off itself (Frost Nova, Dragon's Breath, Psychic Scream) instead of standing and casting. */
  peelAt: number;
  /** Health fraction of an ally below which the healer puts a shield or Pain Suppression on them. */
  shieldAt: number;
  /** Health fraction above which the healer does not heal an ally (casting a heal at nearly full health is wasted). */
  healCap: number;
  /** Enemy health fraction at or below which it finishes its target instead of switching away. */
  switchHp: number;
  /** Score bonus for staying on the current target; low also means it leaves a target it cannot hit (out of sight, immune) sooner. */
  stickiness: number;
  /** 0..1 how quickly it stops a cast whose target stepped out of sight (1 = at once). */
  losCheck: number;
  /** Yards kept inside the maximum range before it starts a cast (a target at the edge walks out of range mid-cast). */
  rangeBuffer: number;
  /** 0..1 how strictly it keeps crowd control off targets whose diminishing returns have already cut it down. */
  drRespect: number;
  /** 0..1 how soon it saves mana (Evocation, no filler spells at low mana) so it is never empty at the key moment. */
  spendBias: number;
  /** 0..1 how closely a fighter keeps to its healer partner: higher turns back sooner when it has wandered out of the healer's reach (0 = never). */
  stayNear: number;
  /** 0..1 how far from a lava pit it keeps before it hops (a hop near the rim can end in the lava). */
  edgeCare: number;
}

export const BRAIN_BOUNDS: Record<keyof Brain, [number, number]> = {
  coverHp: [0.15, 0.7],
  defHp: [0.25, 0.7],
  strafe: [0.3, 1], // a bot that never moves is not a player: the learner cannot train these to nothing
  healerPrio: [0, 45],
  focus: [0, 30],
  killLow: [20, 100],
  rangeBias: [-6, 6],
  healAt: [0.7, 1.3],
  burstHp: [0.3, 1],
  strafeFlip: [0.6, 3],
  chase: [0.15, 1],
  panicHp: [0.15, 0.5],
  dangerAt: [0.15, 0.7],
  ccEarly: [0, 1],
  dodge: [0, 1],
  preShield: [0.5, 1],
  jukeChance: [0, 1],
  jukeAt: [0.2, 0.7],
  kickAt: [0, 0.85],
  losUse: [0, 1],
  mobility: [0.4, 1],
  trinketAt: [0, 1],
  burstUse: [0, 1],
  peelAt: [0, 1],
  shieldAt: [0.2, 0.9],
  healCap: [0.5, 0.99],
  switchHp: [0, 0.5],
  stickiness: [0, 40],
  losCheck: [0, 1],
  rangeBuffer: [0, 3],
  drRespect: [0, 1],
  spendBias: [0, 1],
  stayNear: [0, 1],
  edgeCare: [0, 1],
};

export const DEFAULT_BRAIN: Brain = {
  coverHp: 0.45, defHp: 0.45, strafe: 0.8, healerPrio: 20, focus: 10, killLow: 60,
  rangeBias: 0, healAt: 1, burstHp: 1, strafeFlip: 1.5, chase: 0.5,
  panicHp: 0.3, dangerAt: 0.35, ccEarly: 0.6, dodge: 0.7, preShield: 0.9,
  jukeChance: 0.35, jukeAt: 0.4, kickAt: 0.45, losUse: 0.6, mobility: 0.7,
  trinketAt: 0.5, burstUse: 0.3, peelAt: 0.5, shieldAt: 0.45, healCap: 0.99, switchHp: 0, stickiness: 10, losCheck: 0.5, rangeBuffer: 0, drRespect: 0, spendBias: 0.5, stayNear: 0, edgeCare: 0.5,
};

/** The numbers a lesson pushes down (the fix is lower): earlier fake stops, smaller bursts treated as danger, no heals on full health, less loyalty to a target. */
export const LOWER_KEYS: ReadonlySet<keyof Brain> = new Set<keyof Brain>(['jukeAt', 'dangerAt', 'healCap', 'stickiness']);

export const BRAIN_KEYS = Object.keys(DEFAULT_BRAIN) as (keyof Brain)[];

/**
 * Every field in range, and anything missing filled in from `base` (by default the general defaults). A brain stored by
 * an older version lacks the newer traits; without this they read as undefined and switch whole behaviours off.
 */
export function clampBrain(b: Partial<Brain> | undefined, base: Brain = DEFAULT_BRAIN): Brain {
  const out = { ...DEFAULT_BRAIN, ...base };
  for (const k of BRAIN_KEYS) {
    const v = b?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(BRAIN_BOUNDS[k][1], Math.max(BRAIN_BOUNDS[k][0], v));
  }
  return out;
}

/** The trained baseline for a class (the defaults until offline training has been run). */
export function brainFor(classId: ClassId): Brain {
  return clampBrain((botbrainJson as Record<string, Partial<Brain>>)[classId]);
}

/** A population loaded from storage, every brain completed against the class's trained baseline (older saves miss newer fields). */
export function freshenPopulation(pop: Population): Population {
  const base = brainFor(pop.classId);
  for (const v of pop.variants) v.brain = clampBrain(v.brain, base);
  return pop;
}

/** A nearby brain: each number moves by a random fraction of its range with probability `rate`. */
export function mutateBrain(b: Brain, rng: () => number, amount = 0.15, rate = 0.5): Brain {
  const out = { ...b };
  for (const k of BRAIN_KEYS) {
    if (rng() > rate) continue;
    const [lo, hi] = BRAIN_BOUNDS[k];
    out[k] = out[k] + (rng() * 2 - 1) * amount * (hi - lo);
  }
  return clampBrain(out);
}

// ---------------------------------------------------------------- live learning (pure logic; the server stores it)

export interface Variant { id: string; brain: Brain; wins: number; games: number }
export interface Population { classId: ClassId; variants: Variant[]; generation: number; sinceEvolve: number }

export const POP_SIZE = 6;
/** Games each variant needs before the worst can be replaced. */
export const EVOLVE_GAMES = 6;

export function newPopulation(classId: ClassId, rng: () => number): Population {
  const base = brainFor(classId);
  const variants: Variant[] = [{ id: 'g0v0', brain: base, wins: 0, games: 0 }];
  for (let i = 1; i < POP_SIZE; i++) variants.push({ id: `g0v${i}`, brain: mutateBrain(base, rng, 0.2, 0.6), wins: 0, games: 0 });
  return { classId, variants, generation: 0, sinceEvolve: 0 };
}

function gaussish(rng: () => number): number {
  return (rng() + rng() + rng() - 1.5) / 0.5; // roughly N(0,1)
}
/** Beta(a, b) sample through two Gamma-ish normal approximations, good enough for exploration. */
function betaSample(a: number, b: number, rng: () => number): number {
  const mean = a / (a + b);
  const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
  return Math.min(1, Math.max(0, mean + gaussish(rng) * sd));
}

/** Thompson sampling: variants that win more get picked more, uncertain ones still get tried. */
export function pickVariant(pop: Population, rng: () => number): Variant {
  let best = pop.variants[0];
  let bestV = -1;
  for (const v of pop.variants) {
    const s = betaSample(v.wins + 1, v.games - v.wins + 1, rng);
    if (s > bestV) {
      bestV = s;
      best = v;
    }
  }
  return best;
}

/** Record one finished game for a variant; evolves the population when enough evidence has piled up. */
/**
 * `score` (0..1) lets a result count for more than win or lose: a bot that lasted long and kept its health counts for
 * more in a loss, and one that won with health to spare counts for more than one that barely made it.
 */
export function recordResult(pop: Population, variantId: string, won: boolean, rng: () => number, score?: number, guide?: Guide): boolean {
  const v = pop.variants.find((x) => x.id === variantId);
  if (!v) return false; // the population moved on: that variant was already replaced
  v.games++;
  v.wins += score !== undefined ? Math.min(1, Math.max(0, score)) : won ? 1 : 0;
  pop.sinceEvolve++;
  if (pop.sinceEvolve >= EVOLVE_GAMES * POP_SIZE && pop.variants.every((x) => x.games >= EVOLVE_GAMES / 2)) {
    evolve(pop, rng, guide);
    return true;
  }
  return false;
}

const rate = (v: Variant) => (v.wins + 1) / (v.games + 2);

/** Evidence of where a brain number should go (what bots learned from losing to people): value and how much backs it. */
export type Guide = Partial<Record<keyof Brain, { value: number; weight: number }>>;

/**
 * Replace the weakest variant with a mutation of the best (or a blend of the top two) and age everyone's record. With a
 * `guide`, the mutation is also pulled part of the way towards it, so new variants try the fixes people's wins point at.
 */
export function evolve(pop: Population, rng: () => number, guide?: Guide): void {
  const ranked = [...pop.variants].sort((a, b) => rate(b) - rate(a));
  const [best, second] = ranked;
  const worst = ranked[ranked.length - 1];
  pop.generation++;
  const blend = { ...best.brain };
  if (second && rng() < 0.5) for (const k of BRAIN_KEYS) if (rng() < 0.5) blend[k] = second.brain[k];
  let brain = mutateBrain(clampBrain(blend), rng, 0.12, 0.5);
  if (guide) {
    const pulled = { ...brain };
    for (const k of BRAIN_KEYS) {
      const g = guide[k];
      if (!g || g.weight < 30 || !Number.isFinite(g.value)) continue;
      // lessons point one way (see lessonBrain): only move when the guide is on the side it points to
      const lower = LOWER_KEYS.has(k);
      if (lower ? g.value >= brain[k] : g.value <= brain[k]) continue;
      pulled[k] = brain[k] + (g.value - brain[k]) * 0.5 * Math.min(1, g.weight / 150);
    }
    brain = clampBrain(pulled);
  }
  const child: Variant = { id: `g${pop.generation}v${Math.floor(rng() * 1e6)}`, brain, wins: 0, games: 0 };
  pop.variants[pop.variants.indexOf(worst)] = child;
  for (const v of pop.variants) {
    v.wins = Math.round((v.wins / 2) * 100) / 100;
    v.games = Math.round(v.games / 2);
  }
  child.wins = 0;
  child.games = 0;
  pop.sinceEvolve = 0;
}
