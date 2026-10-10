import { ABILITIES, SOUNDS } from './data';
import type { AbilityDef } from './types';

/**
 * Sounds: every sound the game plays, by id, and what each one is set to (shared/data/sounds.json): which recording plays
 * (nothing = the built-in synthesised sound), how loud, how high and whether it is switched off. Visual-free and not part of
 * the simulation or its content hash, so editing it never changes a match or a replay. The client's audio engine reads the
 * settings every time it plays a sound, so a dev's change is heard at once. The dev panel's Sounds page lists soundList().
 */

export const SOUND_ID = 'sounds';

/** One recording in the library (client/public/audio/lib), from the RPG Essentials pack the owner supplied. */
export interface SoundFile { file: string; label: string; group: string; seconds: number }
export const SOUND_LIBRARY: SoundFile[] = [
  { file: 'lib/battle-claw-03.mp3', label: 'Battle · claw 03', group: 'Battle', seconds: 0.72 },
  { file: 'lib/battle-bite-04.mp3', label: 'Battle · bite 04', group: 'Battle', seconds: 0.72 },
  { file: 'lib/battle-impact-flesh-02.mp3', label: 'Battle · impact flesh 02', group: 'Battle', seconds: 0.72 },
  { file: 'lib/battle-slash-04.mp3', label: 'Battle · slash 04', group: 'Battle', seconds: 1.4 },
  { file: 'lib/battle-miss-evade-02.mp3', label: 'Battle · miss evade 02', group: 'Battle', seconds: 1.4 },
  { file: 'lib/battle-block-03.mp3', label: 'Battle · block 03', group: 'Battle', seconds: 1.4 },
  { file: 'lib/battle-flee-02.mp3', label: 'Battle · flee 02', group: 'Battle', seconds: 1.4 },
  { file: 'lib/battle-encounter-02.mp3', label: 'Battle · encounter 02', group: 'Battle', seconds: 5.4 },
  { file: 'lib/battle-enemy-death-01.mp3', label: 'Battle · enemy death 01', group: 'Battle', seconds: 2.74 },
  { file: 'lib/battle-flesh-02.mp3', label: 'Battle · flesh 02', group: 'Battle', seconds: 0.72 },
  { file: 'lib/ui-hover-01.mp3', label: 'Menus · hover 01', group: 'Menus', seconds: 1.4 },
  { file: 'lib/ui-confirm-03.mp3', label: 'Menus · confirm 03', group: 'Menus', seconds: 1.4 },
  { file: 'lib/ui-decline-09.mp3', label: 'Menus · decline 09', group: 'Menus', seconds: 1.4 },
  { file: 'lib/ui-denied-03.mp3', label: 'Menus · denied 03', group: 'Menus', seconds: 1.4 },
  { file: 'lib/ui-use-item-01.mp3', label: 'Menus · use item 01', group: 'Menus', seconds: 1.4 },
  { file: 'lib/ui-equip-10.mp3', label: 'Menus · equip 10', group: 'Menus', seconds: 1.4 },
  { file: 'lib/ui-unequip-01.mp3', label: 'Menus · unequip 01', group: 'Menus', seconds: 1.4 },
  { file: 'lib/ui-buy-sell-01.mp3', label: 'Menus · buy sell 01', group: 'Menus', seconds: 1.4 },
  { file: 'lib/ui-pause-04.mp3', label: 'Menus · pause 04', group: 'Menus', seconds: 1.4 },
  { file: 'lib/ui-unpause-04.mp3', label: 'Menus · unpause 04', group: 'Menus', seconds: 1.4 },
  { file: 'lib/move-step-grass-03.mp3', label: 'Movement · step grass 03', group: 'Movement', seconds: 0.72 },
  { file: 'lib/move-step-rock-02.mp3', label: 'Movement · step rock 02', group: 'Movement', seconds: 0.72 },
  { file: 'lib/move-step-wood-03.mp3', label: 'Movement · step wood 03', group: 'Movement', seconds: 0.72 },
  { file: 'lib/move-step-water-02.mp3', label: 'Movement · step water 02', group: 'Movement', seconds: 0.72 },
  { file: 'lib/move-swim-submerged-02.mp3', label: 'Movement · swim submerged 02', group: 'Movement', seconds: 2.05 },
  { file: 'lib/move-jump-03.mp3', label: 'Movement · jump 03', group: 'Movement', seconds: 0.94 },
  { file: 'lib/move-cling-climb-03.mp3', label: 'Movement · cling climb 03', group: 'Movement', seconds: 0.72 },
  { file: 'lib/move-landing-01.mp3', label: 'Movement · landing 01', group: 'Movement', seconds: 0.72 },
  { file: 'lib/move-dive-02.mp3', label: 'Movement · dive 02', group: 'Movement', seconds: 2.05 },
  { file: 'lib/move-attack-03.mp3', label: 'Movement · attack 03', group: 'Movement', seconds: 0.72 },
  { file: 'lib/move-hit-03.mp3', label: 'Movement · hit 03', group: 'Movement', seconds: 0.72 },
  { file: 'lib/move-teleport-02.mp3', label: 'Movement · teleport 02', group: 'Movement', seconds: 4.07 },
  { file: 'lib/magic-fire-explosion-04-medium.mp3', label: 'Magic attacks · fire explosion 04 medium', group: 'Magic attacks', seconds: 2.05 },
  { file: 'lib/magic-ice-explosion-01.mp3', label: 'Magic attacks · ice explosion 01', group: 'Magic attacks', seconds: 2.74 },
  { file: 'lib/magic-thunder-02.mp3', label: 'Magic attacks · thunder 02', group: 'Magic attacks', seconds: 2.74 },
  { file: 'lib/magic-water-02.mp3', label: 'Magic attacks · water 02', group: 'Magic attacks', seconds: 2.74 },
  { file: 'lib/magic-wind-01.mp3', label: 'Magic attacks · wind 01', group: 'Magic attacks', seconds: 2.05 },
  { file: 'lib/magic-earth-02.mp3', label: 'Magic attacks · earth 02', group: 'Magic attacks', seconds: 2.74 },
  { file: 'lib/magic-charge-05.mp3', label: 'Magic attacks · charge 05', group: 'Magic attacks', seconds: 5.4 },
  { file: 'lib/magic-poison-01.mp3', label: 'Magic attacks · poison 01', group: 'Magic attacks', seconds: 2.05 },
  { file: 'lib/buff-heal-02.mp3', label: 'Buffs and heals · heal 02', group: 'Buffs and heals', seconds: 2.05 },
  { file: 'lib/buff-atk-buff-04.mp3', label: 'Buffs and heals · atk buff 04', group: 'Buffs and heals', seconds: 3.38 },
  { file: 'lib/buff-def-buff-01.mp3', label: 'Buffs and heals · def buff 01', group: 'Buffs and heals', seconds: 4.07 },
  { file: 'lib/buff-debuff-01.mp3', label: 'Buffs and heals · debuff 01', group: 'Buffs and heals', seconds: 3.38 },
  { file: 'lib/buff-revive-03.mp3', label: 'Buffs and heals · revive 03', group: 'Buffs and heals', seconds: 6.73 },
  { file: 'lib/buff-absorb-04.mp3', label: 'Buffs and heals · absorb 04', group: 'Buffs and heals', seconds: 4.07 },
  { file: 'lib/buff-sleep-01.mp3', label: 'Buffs and heals · sleep 01', group: 'Buffs and heals', seconds: 3.38 },
  { file: 'lib/buff-speed-up-02.mp3', label: 'Buffs and heals · speed up 02', group: 'Buffs and heals', seconds: 4.07 },
];

/** Uploaded recordings live in the server's store and are served at /audio/custom/<name>. */
export const CUSTOM_SOUND_RE = /^custom\/[a-z0-9][a-z0-9-]{0,47}\.(mp3|ogg|wav)$/;
export const CUSTOM_SOUND_LIMIT_BYTES = 1_500_000;
export const isSoundFile = (v: unknown): v is string => typeof v === 'string' && (v === '' || SOUND_LIBRARY.some((f) => f.file === v) || CUSTOM_SOUND_RE.test(v) || /^[a-z0-9-]+\.mp3$/.test(v));

export interface SoundSetting { file: string; volume: number; pitch: number; off: boolean }
export interface SoundInfo { id: string; label: string; group: string; hint?: string }

const SCHOOLS = ['physical', 'fire', 'frost', 'arcane', 'holy', 'shadow', 'nature'] as const;
const THEMES = ['colosseum', 'ruins', 'frost', 'cinder', 'forge', 'sandstone'] as const;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The sounds that belong to no one skill. */
function general(): SoundInfo[] {
  const g = (group: string, rows: [string, string, string?][]): SoundInfo[] => rows.map(([id, label, hint]) => ({ id, label, group, ...(hint ? { hint } : {}) }));
  return [
    ...g('Menus and clicks', [
      ['ui-click', 'Button click', 'Every button in the menus and the game.'],
      ['ui-select', 'Selecting a target'],
      ['ui-error', 'Cannot do that', 'A skill that fails ("Out of range", "Not ready").'],
      ['ui-ping', 'Notification ping'],
    ]),
    ...g('Movement', [
      ['jump', 'Jump'],
      ['jumpland', 'Landing from a jump'],
      ...THEMES.map((t): [string, string] => [`step-${t}`, `Footstep: ${cap(t)} arena`]),
      ['leap', 'Leap take-off (Heroic Leap)'],
      ['land', 'Leap landing'],
    ]),
    ...g('Fighting', [
      ['auto', 'Weapon hit (auto attack)'],
      ['big', 'Heavy blow boom', 'Under a hit of 320 damage or more.'],
      ['miss', 'Miss'],
      ['immune', 'Immune'],
      ['absorb', 'Damage absorbed by a shield'],
      ['shield-break', 'Shield breaks'],
      ['heal', 'Healing lands'],
      ['death', 'A unit dies'],
      ['heart', 'Heartbeat (you are low on health)'],
      ['m-interrupt', 'Interrupt'],
      ['m-dispel', 'Dispel'],
      ['m-dodge', 'Dodge'],
    ]),
    ...g('Control and buffs', [
      ['cc-stun', 'Stunned'],
      ['cc-incapacitate', 'Incapacitated (sheep, sap, gouge)'],
      ['cc-fear', 'Feared'],
      ['cc-root', 'Rooted'],
      ['slow', 'Slowed'],
      ['speed', 'Sped up'],
      ['buff', 'A buff lands on you'],
      ['stealth-in', 'Stealth begins'],
      ['stealth-out', 'Stealth ends'],
      ['proc', 'A proc lights up (Hot Streak)'],
    ]),
    ...g('School sounds', [
      ...SCHOOLS.map((s): [string, string, string] => [`hit-${s}`, `${cap(s)} hit`, 'A damaging spell or swing of this school with no sound of its own.']),
      ...SCHOOLS.map((s): [string, string, string] => [`cs-${s}`, `${cap(s)} wind-up`, 'The start of a cast of this school with no sound of its own.']),
      ...SCHOOLS.flatMap((s): [string, string, string][] => [[`c-${s}-false`, `${cap(s)} spell released`, 'A spell of this school with no sound of its own.'], [`c-${s}-true`, `${cap(s)} melee strike`, 'A close-range strike of this school with no sound of its own.']]),
    ]),
    ...g('Match', [
      ['count', 'Countdown tick'],
      ['start', 'The gates open'],
      ['result-win', 'You win'],
      ['result-lose', 'You lose'],
      ['result-draw', 'Draw'],
    ]),
  ];
}

const hasDamage = (a: AbilityDef) => a.effects.some((e) => e.type === 'damage' || e.type === 'zone' || e.type === 'heal');
const ticks = (a: AbilityDef) => !!a.channel || a.effects.some((e) => e.type === 'zone' || e.type === 'exsanguinate');

/** Every sound id with its words: the general ones, then up to four for each skill (start of the cast, release, hit, ticks). */
export function soundList(): SoundInfo[] {
  const out = general();
  for (const a of Object.values(ABILITIES)) {
    const group = `${cap(a.class)} skills`;
    if (a.castTime > 0) out.push({ id: `cs-${a.id}`, label: `${a.name}: wind-up`, group, hint: 'While the cast bar fills.' });
    out.push({ id: `c-${a.id}`, label: `${a.name}: cast`, group, hint: 'The moment it is used (or released).' });
    if (hasDamage(a)) out.push({ id: `hit-${a.id}`, label: `${a.name}: lands`, group, hint: 'On the target when it hits.' });
    if (ticks(a)) out.push({ id: `tick-${a.id}`, label: `${a.name}: ticks`, group, hint: 'Each pulse of a channel or ground effect.' });
  }
  return out;
}

/** The recording each sound starts with (the rest stay the built-in sound until a dev picks one). */
export const DEFAULT_SOUND_FILES: Record<string, string> = {
  'ui-click': 'lib/ui-hover-01.mp3', 'ui-select': 'lib/ui-confirm-03.mp3', 'ui-error': 'lib/ui-denied-03.mp3', 'ui-ping': 'lib/ui-use-item-01.mp3',
  jump: 'lib/move-jump-03.mp3', jumpland: 'lib/move-landing-01.mp3', leap: 'lib/move-jump-03.mp3', land: 'lib/move-landing-01.mp3',
  'step-colosseum': 'lib/move-step-rock-02.mp3', 'step-ruins': 'lib/move-step-grass-03.mp3', 'step-frost': 'lib/move-step-rock-02.mp3', 'step-cinder': 'lib/move-step-rock-02.mp3', 'step-forge': 'lib/move-step-wood-03.mp3', 'step-sandstone': 'lib/move-step-grass-03.mp3',
  auto: 'lib/battle-impact-flesh-02.mp3', miss: 'lib/battle-miss-evade-02.mp3', immune: 'lib/battle-block-03.mp3', absorb: 'lib/buff-absorb-04.mp3', heal: 'lib/buff-heal-02.mp3', death: 'lib/battle-enemy-death-01.mp3',
  'm-interrupt': 'lib/battle-block-03.mp3', 'm-dispel': 'lib/buff-debuff-01.mp3', 'm-dodge': 'lib/battle-miss-evade-02.mp3',
  'cc-stun': 'lib/battle-block-03.mp3', 'cc-incapacitate': 'lib/buff-sleep-01.mp3', 'cc-fear': 'lib/battle-flee-02.mp3', 'cc-root': 'lib/move-cling-climb-03.mp3',
  slow: 'lib/buff-debuff-01.mp3', speed: 'lib/buff-speed-up-02.mp3', buff: 'lib/buff-def-buff-01.mp3', 'stealth-in': 'lib/magic-wind-01.mp3', 'stealth-out': 'lib/magic-wind-01.mp3', proc: 'lib/buff-atk-buff-04.mp3',
  'hit-physical': 'lib/battle-flesh-02.mp3', 'hit-fire': 'lib/magic-fire-explosion-04-medium.mp3', 'hit-frost': 'lib/magic-ice-explosion-01.mp3', 'hit-arcane': 'lib/magic-wind-01.mp3', 'hit-holy': 'lib/magic-thunder-02.mp3', 'hit-shadow': 'lib/magic-poison-01.mp3', 'hit-nature': 'lib/magic-earth-02.mp3',
  start: 'lib/battle-encounter-02.mp3', count: 'lib/ui-hover-01.mp3', 'result-win': 'lib/buff-revive-03.mp3', 'result-lose': 'lib/battle-enemy-death-01.mp3',
  'c-fireball': 'fireball-launch.mp3', 'hit-fireball': 'fireball-hit.mp3', 'c-pyroblast': 'fireball-launch.mp3', 'hit-pyroblast': 'fireball-hit.mp3',
  'c-blink': 'lib/move-teleport-02.mp3', 'c-vanish': 'lib/magic-wind-01.mp3', 'c-frost_nova': 'lib/magic-ice-explosion-01.mp3',
};
export const DEFAULT_SOUND_VOLUME = 0.6;
/** Starting volume and pitch of sounds that were tuned before the Sounds page existed. */
export const DEFAULT_SOUND_TUNING: Record<string, { volume?: number; pitch?: number }> = {
  'c-fireball': { volume: 0.5 }, 'hit-fireball': { volume: 0.4 }, 'c-pyroblast': { volume: 0.42, pitch: 0.72 }, 'hit-pyroblast': { volume: 0.5, pitch: 0.62 },
};

/** What a sound is set to now (patches applied); a sound the file does not list is the built-in one at full volume. */
export function soundSetting(id: string): SoundSetting {
  const s = (SOUNDS as unknown as Record<string, Partial<{ file: string; volume: number; pitch: number; off: number | boolean }>>)[id];
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return { file: typeof s?.file === 'string' ? s.file : '', volume: num(s?.volume, 1, 0, 3), pitch: num(s?.pitch, 1, 0.5, 2), off: !!s?.off };
}

/** The recordings devs uploaded (the server's list, set by the client when it loads it). */
let customFiles: { file: string; label: string }[] = [];
export const setCustomSounds = (list: { file: string; label: string }[]): void => {
  customFiles = list.filter((f) => CUSTOM_SOUND_RE.test(f.file));
};
export const customSounds = (): readonly { file: string; label: string }[] => customFiles;
/** What a sound's recording menu offers: the built-in sound, the library, then the uploads, with their words. */
export function soundFileChoices(): { options: string[]; labels: Record<string, string> } {
  const labels: Record<string, string> = { '': 'Built-in sound (made by the game)', 'fireball-launch.mp3': 'Fireball launch (Freesound 105016)', 'fireball-hit.mp3': 'Fireball burst (Freesound 105016)' };
  for (const f of SOUND_LIBRARY) labels[f.file] = `${f.label} (${f.seconds}s)`;
  for (const f of customFiles) labels[f.file] = `Uploaded: ${f.label}`;
  return { options: Object.keys(labels), labels };
}

export const SOUND_FIELD_BOUNDS = { volume: { min: 0, max: 3 }, pitch: { min: 0.5, max: 2 } } as const;
