import type { AbilityDef, School } from '@arena/shared';

/**
 * Sound recipes for abilities and actions. A recipe is a few oscillator and noise bursts played through a `Synth`
 * (the audio engine in the game, a recorder in the tests). Every ability gets a voice for when it is released, many
 * get one for the wind-up and for the hit, and anything without its own is built from what the ability does.
 */

export interface ToneOpts {
  f: number;
  to?: number;
  type?: OscillatorType;
  a?: number;
  d: number;
  vol?: number;
  delay?: number;
  detune?: number;
  lp?: number;
}
export interface NoiseOpts {
  d: number;
  f: number;
  to?: number;
  q?: number;
  type?: BiquadFilterType;
  a?: number;
  vol?: number;
  delay?: number;
}
export interface Synth {
  tone(o: ToneOpts): void;
  noise(o: NoiseOpts): void;
}
/** `power` is 0.4..1.4: how big the thing is (bigger hits and heals sound fuller). */
export type Recipe = (s: Synth, power: number) => void;

// ------------------------------------------------------------------ building blocks

const whoosh = (f: number, to: number, d: number, vol = 1): Recipe => (s) => s.noise({ d, f, to, q: 1.1, vol });
const thump = (f: number, d = 0.16, vol = 0.55): Recipe => (s, p) => s.tone({ f: f * (1.05 - p * 0.1), to: f * 0.4, d: d * (0.8 + p * 0.3), vol: vol * p });
const strike = (pitch: number, weight: number): Recipe => (s, p) => {
  s.noise({ d: 0.05 + 0.1 * weight, f: 2600 * pitch, to: 300, type: 'lowpass', vol: 0.5 * p });
  s.tone({ f: 170 * pitch, to: 50, d: 0.1 + 0.12 * weight, vol: 0.5 * p });
};
const slice = (pitch: number): Recipe => (s, p) => {
  s.noise({ d: 0.09, f: 2400 * pitch, to: 6500 * pitch, q: 2, vol: 0.7 * p });
  s.tone({ f: 1900 * pitch, to: 1300 * pitch, d: 0.12, vol: 0.12, type: 'triangle', delay: 0.02 });
};
const stab = (pitch: number): Recipe => (s, p) => {
  s.noise({ d: 0.05, f: 1800 * pitch, to: 700, q: 1.5, vol: 0.9 * p });
  s.tone({ f: 260 * pitch, to: 90, d: 0.09, vol: 0.4 * p, type: 'triangle' });
};
const zap = (f: number, to: number, type: OscillatorType = 'square', d = 0.16): Recipe => (s, p) => {
  s.tone({ f, to, d, vol: 0.25 * p, type, lp: 2600 });
  s.tone({ f: f * 1.5, to: to * 1.5, d: d * 0.8, vol: 0.12 * p, detune: 16 });
};
const chime = (notes: number[], d = 0.4, type: OscillatorType = 'triangle', gap = 0.07): Recipe => (s, p) => notes.forEach((f, i) => s.tone({ f, d, vol: 0.2 * p, type, delay: i * gap }));
const shimmer = (base: number, n = 4, gap = 0.05): Recipe => (s, p) => {
  for (let i = 0; i < n; i++) s.tone({ f: base * Math.pow(1.25, i), to: base * Math.pow(1.25, i) * 1.05, d: 0.3, vol: 0.14 * p, delay: i * gap });
};
const boom = (f: number, d = 0.55, vol = 0.7): Recipe => (s, p) => {
  s.tone({ f: f * (1.1 - p * 0.15), to: f * 0.35, d: d * (0.8 + p * 0.3), vol: vol * p, lp: 500 });
  s.noise({ d: d * 0.9, f: 1400, to: 150, type: 'lowpass', vol: 0.55 * p });
};
const roar = (f: number, d = 0.5, type: OscillatorType = 'sawtooth'): Recipe => (s, p) => {
  s.tone({ f, to: f * 0.8, d, a: 0.06, vol: 0.3 * p, type, lp: 900 });
  s.noise({ d, a: 0.06, f: 500, to: 250, q: 0.6, vol: 0.4 * p });
};
const hiss = (f: number, d = 0.3): Recipe => (s, p) => s.noise({ d, a: 0.04, f, type: 'highpass', vol: 0.45 * p });
const pop = (): Recipe => (s, p) => {
  s.tone({ f: 600, to: 150, d: 0.07, vol: 0.4 * p });
  s.noise({ d: 0.08, f: 3000, type: 'highpass', vol: 0.3 * p });
};
const bubble = (): Recipe => (s, p) => {
  s.tone({ f: 300, to: 900, d: 0.14, vol: 0.25 * p, type: 'sine' });
  s.tone({ f: 900, to: 320, d: 0.2, vol: 0.25 * p, type: 'sine', delay: 0.14 });
  s.tone({ f: 450, to: 1100, d: 0.12, vol: 0.18 * p, type: 'sine', delay: 0.3 });
};
const rattle = (n: number, f = 4500): Recipe => (s, p) => {
  for (let i = 0; i < n; i++) s.noise({ d: 0.04, f: f + (i % 2) * 1200, type: 'highpass', vol: 0.5 * p, delay: i * 0.05 });
};
const multi = (...rs: Recipe[]): Recipe => (s, p) => rs.forEach((r) => r(s, p));
const later = (delay: number, r: Recipe): Recipe => (s, p) => r({ tone: (o) => s.tone({ ...o, delay: (o.delay ?? 0) + delay }), noise: (o) => s.noise({ ...o, delay: (o.delay ?? 0) + delay }) }, p);
const shatter = (): Recipe => (s, p) => {
  s.noise({ d: 0.18, f: 5200, type: 'highpass', vol: 0.55 * p });
  for (const [i, f] of [3400, 2600, 4100].entries()) s.tone({ f, to: f * 0.6, d: 0.14, vol: 0.16 * p, type: 'triangle', delay: i * 0.03 });
};
const clang = (): Recipe => (s, p) => {
  s.tone({ f: 740, d: 0.35, vol: 0.2 * p, type: 'square', lp: 2400 });
  s.tone({ f: 1110, d: 0.3, vol: 0.14 * p, type: 'square', lp: 2400, detune: 20 });
  s.noise({ d: 0.05, f: 4500, type: 'highpass', vol: 0.4 * p });
};
const scream = (): Recipe => (s, p) => {
  s.tone({ f: 600, to: 1500, d: 0.5, a: 0.03, vol: 0.2 * p, type: 'sawtooth', lp: 2600 });
  s.tone({ f: 640, to: 1560, d: 0.5, a: 0.03, vol: 0.18 * p, type: 'sawtooth', lp: 2600, detune: 25 });
};
const hum = (f: number, d = 0.5): Recipe => (s, p) => {
  s.tone({ f, to: f * 1.3, d, a: 0.12, vol: 0.2 * p, type: 'sine' });
  s.tone({ f: f * 2.01, to: f * 2.6, d, a: 0.12, vol: 0.1 * p, type: 'triangle' });
};

// ------------------------------------------------------------------ released (the moment the ability goes off)

export const CAST_VOICE: Record<string, Recipe> = {
  // warrior
  charge: multi(whoosh(300, 3200, 0.38, 1.3), thump(90, 0.3, 0.4)),
  heroic_leap: multi(whoosh(250, 2200, 0.4, 1.2), thump(70, 0.35, 0.35)),
  mortal_strike: multi(strike(0.9, 1), clang()),
  bloodthirst: multi(strike(1, 0.7), (s, p) => s.noise({ d: 0.2, f: 420, q: 2.5, vol: 0.6 * p })),
  slam: strike(0.75, 1.3),
  execute: multi(strike(0.7, 1.4), (s, p) => s.tone({ f: 1500, to: 400, d: 0.2, vol: 0.14 * p, type: 'triangle', delay: 0.03 })),
  concussion_blow: multi(strike(0.8, 1.2), (s, p) => s.tone({ f: 260, to: 130, d: 0.2, vol: 0.3 * p, type: 'square', lp: 900, delay: 0.05 })),
  pummel: multi(strike(1.2, 0.5), (s, p) => s.noise({ d: 0.05, f: 4500, type: 'highpass', vol: 0.4 * p })),
  hamstring: slice(0.85),
  whirlwind: multi(whoosh(400, 1800, 0.22, 1), later(0.12, whoosh(500, 2000, 0.22, 1)), later(0.24, whoosh(400, 1500, 0.24, 0.9))),
  bladestorm: multi(whoosh(500, 2400, 0.2, 1), later(0.1, whoosh(500, 2400, 0.2, 1)), later(0.2, whoosh(500, 2400, 0.2, 1)), later(0.3, clang())),
  shockwave: multi(boom(75, 0.6, 0.7), (s, p) => s.noise({ d: 0.3, f: 300, to: 1200, q: 0.7, vol: 0.5 * p })),
  intimidating_shout: roar(190, 0.55),
  piercing_howl: roar(900, 0.6, 'square'),
  recklessness: multi(roar(150, 0.5), shimmer(300, 3)),
  enraged_regeneration: multi(roar(130, 0.35), chime([392, 523, 659], 0.4)),
  shield_wall: clang(),
  die_by_the_sword: multi(clang(), later(0.1, clang())),
  hammer_toss: multi(whoosh(300, 1500, 0.3, 1), thump(110, 0.2, 0.3)),
  harpoon_throw: multi(whoosh(500, 2500, 0.22, 1), rattle(3, 3800)),
  axe_throw: multi(whoosh(350, 1700, 0.28, 1), (s, p) => s.tone({ f: 220, to: 330, d: 0.25, vol: 0.12 * p, type: 'triangle' })),
  reel_in: multi(rattle(6, 3200), whoosh(1500, 400, 0.3, 0.8)),
  deep_cuts: slice(0.8),
  slice_and_dice: multi(slice(1.1), later(0.08, slice(1.3)), later(0.16, slice(1.2))),
  not_going_anywhere: multi(clang(), thump(70, 0.4, 0.5)),
  dragon_roar: multi(roar(110, 0.6), whoosh(300, 2600, 0.5, 1.2)),
  battle_banner: multi(clang(), thump(80, 0.4, 0.4), shimmer(330, 3)),
  // new tier 4 / 5 skills
  trinket_cleanse: chime([784, 988, 1175], 0.4),
  trinket_shield: multi(clang(), shimmer(500, 3)),
  trinket_heal: chime([523, 659, 784], 0.45),
  mirror_image: multi(shimmer(700, 4), whoosh(1200, 400, 0.3, 0.8)),
  rune_of_power: multi(hum(220, 0.6), shimmer(440, 3)),
  leap_of_faith: multi(whoosh(500, 2200, 0.35, 1), chime([659, 880], 0.35)),
  purifying_light: chime([880, 1109, 1319], 0.5),
  ascend: multi(hum(330, 0.8), whoosh(300, 3000, 0.6, 1)),
  gouge: multi(slice(1.4), (s, p) => s.tone({ f: 1800, to: 900, d: 0.1, vol: 0.14 * p, type: 'triangle' })),
  sap: strike(1.4, 0.35),
  // mage
  frostbolt: multi(whoosh(3500, 6500, 0.18, 0.8), (s, p) => s.tone({ f: 2400, to: 3600, d: 0.12, vol: 0.16 * p, type: 'triangle' })),
  ice_lance: multi(whoosh(4500, 8000, 0.1, 0.9), (s, p) => s.tone({ f: 3200, to: 4600, d: 0.09, vol: 0.14 * p, type: 'triangle' })),
  fireball: multi(whoosh(600, 2200, 0.3, 1.1), roar(120, 0.25)),
  pyroblast: multi(roar(70, 0.7), whoosh(300, 2600, 0.5, 1.2)),
  scorch: multi(hiss(2600, 0.14), (s, p) => s.noise({ d: 0.12, f: 900, to: 1800, vol: 0.7 * p })),
  flamestrike: multi(roar(100, 0.4), whoosh(500, 1800, 0.35, 0.9)),
  dragons_breath: multi(hiss(1800, 0.5), roar(180, 0.5)),
  blizzard: multi(hiss(5500, 0.5), chime([2093, 2637, 3136, 2349], 0.3, 'sine', 0.09)),
  frost_nova: multi(shatter(), (s, p) => s.tone({ f: 900, to: 180, d: 0.4, vol: 0.25 * p, type: 'triangle' })),
  deep_freeze: multi(shatter(), boom(90, 0.4, 0.5)),
  ice_barrier: shimmer(1568, 4, 0.045),
  blink: multi((s, p) => s.tone({ f: 400, to: 2600, d: 0.08, vol: 0.28 * p, type: 'sine' }), (s, p) => s.tone({ f: 2600, to: 450, d: 0.09, vol: 0.22 * p, type: 'sine', delay: 0.07 }), pop()),
  polymorph: bubble(),
  counterspell: multi(zap(1100, 300, 'square', 0.1), (s, p) => s.noise({ d: 0.08, f: 4200, type: 'highpass', vol: 0.4 * p })),
  arcane_blast: zap(900, 260, 'square', 0.22),
  arcane_barrage: multi(zap(1300, 300, 'sawtooth', 0.2), thump(120, 0.2, 0.3)),
  arcane_missiles: zap(1500, 700, 'square', 0.1),
  arcane_explosion: multi(boom(160, 0.3, 0.5), zap(1000, 200, 'square', 0.2)),
  arcane_power: shimmer(440, 5, 0.06),
  arcane_silence: multi(hiss(3000, 0.25), zap(700, 200, 'square', 0.2)),
  evocation: hum(220, 0.6),
  // priest
  flash_heal: chime([660, 880, 1320], 0.35),
  greater_heal: chime([392, 523, 659, 784], 0.55, 'triangle', 0.09),
  power_word_shield: chime([1318, 1760, 2093], 0.5, 'sine', 0.06),
  holy_word: chime([523, 659, 784, 1047], 0.7, 'triangle', 0.05),
  penance: chime([880, 880, 1175], 0.22, 'triangle', 0.13),
  smite: multi(zap(1500, 600, 'triangle', 0.18), hiss(5000, 0.1)),
  holy_nova: multi(shimmer(784, 4, 0.03), boom(220, 0.3, 0.4)),
  judgment_hammer: multi(clang(), boom(100, 0.35, 0.5)),
  mind_blast: multi((s, p) => s.tone({ f: 140, to: 55, d: 0.3, vol: 0.5 * p, type: 'sawtooth', lp: 500 }), (s, p) => s.noise({ d: 0.2, f: 700, to: 150, vol: 0.45 * p })),
  shadow_word_death: multi(boom(65, 0.7, 0.8), (s, p) => s.tone({ f: 130, d: 0.5, vol: 0.25 * p, type: 'sawtooth', lp: 400, delay: 0.1 })),
  mind_flay: hum(110, 0.5),
  plague_bloom: bubble(),
  hush: multi(hiss(2500, 0.3), (s, p) => s.tone({ f: 500, to: 120, d: 0.3, vol: 0.2 * p, type: 'sawtooth', lp: 600 })),
  psychic_scream: scream(),
  pain_suppression: chime([523, 392], 0.5, 'sine', 0.1),
  desperate_prayer: chime([392, 523, 784], 0.6, 'sine', 0.1),
  dispersion: multi(hum(130, 0.6), shimmer(262, 3)),
  power_infusion: shimmer(523, 5, 0.05),
  dispel_magic: (s, p) => {
    s.tone({ f: 2200, d: 0.3, vol: 0.2 * p });
    s.tone({ f: 3300, d: 0.22, vol: 0.1 * p, delay: 0.03 });
  },
  // rogue
  stealth: (s, p) => s.noise({ d: 0.45, a: 0.12, f: 700, to: 200, type: 'lowpass', vol: 0.35 * p }),
  vanish: multi(pop(), hiss(1400, 0.4), (s, p) => s.noise({ d: 0.35, f: 1200, to: 250, type: 'lowpass', vol: 0.5 * p })),
  cheap_shot: multi(stab(1), thump(120, 0.15, 0.3)),
  kidney_shot: multi(stab(0.85), thump(100, 0.18, 0.4)),
  sinister_strike: slice(1.1),
  backstab: multi(stab(0.8), (s, p) => s.noise({ d: 0.1, f: 500, q: 2, vol: 0.5 * p })),
  mutilate: multi(slice(1), later(0.08, stab(0.9))),
  eviscerate: multi(slice(0.8), (s, p) => s.noise({ d: 0.25, f: 450, q: 2, vol: 0.6 * p, delay: 0.04 })),
  crippling_strike: slice(0.9),
  kick: multi(strike(1.3, 0.4), (s, p) => s.noise({ d: 0.05, f: 4500, type: 'highpass', vol: 0.4 * p })),
  sprint: whoosh(500, 3000, 0.4, 0.9),
  evasion: multi(whoosh(2000, 600, 0.3, 0.8), shimmer(660, 3, 0.04)),
  adrenaline_rush: multi(shimmer(392, 5, 0.04), whoosh(500, 2800, 0.3, 0.8)),
  shadowstep: multi(whoosh(2800, 500, 0.12, 0.9), later(0.1, pop())),
  blind: multi(hiss(3500, 0.3), pop()),
  garrote: multi(whoosh(2500, 4500, 0.1, 0.8), stab(1.2)),
  fan_of_knives: multi(whoosh(1800, 5000, 0.14, 1), later(0.05, whoosh(1900, 5200, 0.14, 1)), later(0.1, whoosh(1700, 4800, 0.14, 1))),
  knife_snipe: multi(whoosh(2500, 6000, 0.14, 1), stab(1.3)),
  choke_bomb: multi(pop(), hiss(1500, 0.45)),
  exsanguinate: multi(slice(0.7), (s, p) => s.noise({ d: 0.3, f: 380, q: 2.5, vol: 0.7 * p })),
};

// ------------------------------------------------------------------ the wind-up of a cast with a cast time

export const START_VOICE: Record<string, Recipe> = {
  pyroblast: (s, p) => s.noise({ d: 0.9, a: 0.5, f: 300, to: 1500, q: 0.7, vol: 0.4 * p }),
  fireball: (s, p) => s.noise({ d: 0.5, a: 0.2, f: 400, to: 1800, q: 0.7, vol: 0.3 * p }),
  frostbolt: (s, p) => s.tone({ f: 1500, to: 2800, d: 0.5, a: 0.2, vol: 0.16 * p, type: 'triangle' }),
  polymorph: (s, p) => {
    s.tone({ f: 400, to: 700, d: 0.4, a: 0.1, vol: 0.14 * p });
    s.tone({ f: 420, to: 740, d: 0.4, a: 0.1, vol: 0.12 * p, detune: 22 });
  },
  evocation: hum(180, 0.8),
  greater_heal: chime([262, 330, 392], 0.6, 'triangle', 0.1),
  flash_heal: chime([392, 494], 0.3),
  holy_word: chime([392, 494, 587], 0.7, 'triangle', 0.12),
  mind_blast: (s, p) => s.tone({ f: 90, to: 160, d: 0.5, a: 0.15, vol: 0.26 * p, type: 'sawtooth', lp: 400 }),
  arcane_blast: (s, p) => s.tone({ f: 350, to: 800, d: 0.4, a: 0.1, vol: 0.18 * p, type: 'square', lp: 1600 }),
  arcane_missiles: hum(520, 0.4),
  blizzard: hiss(5000, 0.4),
  flamestrike: (s, p) => s.noise({ d: 0.6, a: 0.3, f: 300, to: 1200, vol: 0.3 * p }),
};

// ------------------------------------------------------------------ the hit landing on its target

export const HIT_VOICE: Record<string, Recipe> = {
  ice_lance: shatter(),
  frostbolt: multi(shatter(), thump(180, 0.12, 0.3)),
  fireball: multi(boom(140, 0.35, 0.55), hiss(2000, 0.2)),
  pyroblast: boom(60, 0.8, 0.9),
  scorch: multi(hiss(2200, 0.16), thump(160, 0.12, 0.3)),
  flamestrike: multi(boom(110, 0.4, 0.5), hiss(1800, 0.3)),
  dragons_breath: hiss(1600, 0.35),
  arcane_blast: multi(zap(700, 180, 'square', 0.2), thump(120, 0.15, 0.35)),
  arcane_barrage: multi(boom(150, 0.35, 0.55), zap(900, 200, 'square', 0.2)),
  smite: multi(zap(1100, 500, 'triangle', 0.16), thump(150, 0.14, 0.3)),
  mind_blast: multi(boom(100, 0.35, 0.55), (s, p) => s.noise({ d: 0.25, f: 900, to: 200, vol: 0.4 * p })),
  shadow_word_death: boom(55, 0.8, 0.9),
  mortal_strike: multi(strike(0.8, 1.3), clang()),
  slam: strike(0.7, 1.4),
  execute: boom(70, 0.5, 0.8),
  bloodthirst: multi(strike(0.9, 1), (s, p) => s.noise({ d: 0.2, f: 420, q: 2.5, vol: 0.5 * p })),
  concussion_blow: boom(90, 0.4, 0.6),
  whirlwind: strike(1, 0.6),
  shockwave: boom(85, 0.45, 0.6),
  sinister_strike: slice(1.05),
  backstab: multi(stab(0.75), thump(100, 0.14, 0.4)),
  mutilate: stab(0.9),
  eviscerate: multi(slice(0.75), thump(90, 0.2, 0.5)),
  kick: strike(1.2, 0.4),
  fan_of_knives: stab(1.2),
  knife_snipe: stab(1.3),
  garrote: stab(1.1),
  exsanguinate: multi(slice(0.7), (s, p) => s.noise({ d: 0.3, f: 380, q: 2.5, vol: 0.6 * p })),
};

// ------------------------------------------------------------------ fallbacks built from what an ability does

const SCHOOL_PITCH: Record<School, number> = { physical: 1, fire: 0.8, frost: 1.4, arcane: 1.1, holy: 1.2, shadow: 0.7, nature: 0.95 };

/** The release voice for an ability: its own recipe, or one built from its effects (null: use the school sound). */
export function castVoice(def: AbilityDef): Recipe | null {
  const own = CAST_VOICE[def.id];
  if (own) return own;
  const types = new Set(def.effects.map((e) => e.type));
  if (types.has('charge') || types.has('dashToTarget') || types.has('leap') || types.has('blink')) return whoosh(400, 2800, 0.3, 1);
  if (types.has('heal') || types.has('healMax')) return chime([660, 880], 0.35);
  if (types.has('aura') && (def.target === 'self' || def.target === 'ally')) return shimmer(520 * SCHOOL_PITCH[def.school], 3);
  if (def.school === 'physical' && def.range <= 6) return strike(1, 0.8);
  return null;
}

export function startVoice(def: AbilityDef): Recipe | null {
  return START_VOICE[def.id] ?? null;
}

export function hitVoice(def: AbilityDef | undefined): Recipe | null {
  return def ? HIT_VOICE[def.id] ?? null : null;
}

// ------------------------------------------------------------------ player actions and small events

export const ACTION_VOICE = {
  /** Auto-attack landing: a swing and a light impact. */
  autoHit: multi(whoosh(600, 1500, 0.08, 0.6), strike(1.1, 0.3)),
  /** Damage over time or a channel tick: quiet and short. */
  tick: (s: Synth, p: number) => s.tone({ f: 260 * (0.9 + p * 0.2), to: 140, d: 0.07, vol: 0.18 * p, type: 'triangle' }),
  /** A shield took the whole blow. */
  absorb: (s: Synth, p: number) => {
    s.tone({ f: 2400, to: 1800, d: 0.18, vol: 0.2 * p, type: 'triangle' });
    s.noise({ d: 0.04, f: 5000, type: 'highpass', vol: 0.3 * p });
  },
  /** A shield broke. */
  shieldBreak: shatter(),
  buff: shimmer(660, 3, 0.04),
  speed: whoosh(600, 2200, 0.2, 0.7),
  slow: (s: Synth, p: number) => s.tone({ f: 500, to: 160, d: 0.3, vol: 0.2 * p, type: 'triangle' }),
  stealthIn: (s: Synth, p: number) => s.noise({ d: 0.4, a: 0.1, f: 700, to: 200, type: 'lowpass', vol: 0.3 * p }),
  stealthOut: pop(),
  leap: whoosh(250, 2200, 0.4, 1.2),
  land: multi(boom(75, 0.4, 0.7), (s: Synth, p: number) => s.noise({ d: 0.25, f: 500, to: 120, type: 'lowpass', vol: 0.5 * p })),
  immune: (s: Synth, p: number) => {
    s.tone({ f: 1200, to: 900, d: 0.12, vol: 0.18 * p, type: 'square', lp: 2000 });
    s.tone({ f: 900, to: 700, d: 0.12, vol: 0.16 * p, type: 'square', lp: 2000, delay: 0.1 });
  },
  miss: whoosh(1200, 500, 0.12, 0.5),
  heartbeat: (s: Synth, p: number) => {
    s.tone({ f: 62, to: 45, d: 0.12, vol: 0.6 * p });
    s.tone({ f: 58, to: 42, d: 0.12, vol: 0.45 * p, delay: 0.17 });
  },
  /** Landing from a jump. */
  jumpLand: (s: Synth, p: number) => {
    s.tone({ f: 120, to: 55, d: 0.1, vol: 0.4 * p });
    s.noise({ d: 0.08, f: 500, type: 'lowpass', vol: 0.4 * p });
  },
  /** Cooldown ready or a proc lighting up (Hot Streak and friends). */
  proc: chime([1175, 1568], 0.25, 'triangle', 0.06),
} satisfies Record<string, Recipe>;

/** Footsteps by what the arena floor is made of. */
export const STEP_SURFACE: Record<string, { f: number; lp: number; thud: number }> = {
  colosseum: { f: 420, lp: 1, thud: 85 },
  ruins: { f: 360, lp: 1, thud: 75 },
  frost: { f: 900, lp: 1.8, thud: 110 },
  cinder: { f: 300, lp: 1, thud: 70 }, // cracked basalt
  forge: { f: 520, lp: 1, thud: 95 }, // brick and iron
  sandstone: { f: 380, lp: 1, thud: 80 }, // sand over cobble
};
