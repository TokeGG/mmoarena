import { ABILITIES, LOOKS } from './data';

/**
 * Skill looks: how a skill's projectile and impact are drawn, picked from a library of forms, trails, colours and impacts
 * (shared/data/looks.json, one entry per skill). "As it is now" means the skill keeps the look the game gives it. Looks only:
 * never part of the simulation or its content hash. The Animations page of the dev panel edits it (under each skill) and the
 * client's effects read it every time a skill is used, so a change shows on the next cast.
 */

export const LOOKS_ID = 'looks';

export const LOOK_FORMS: [string, string][] = [
  ['default', 'As it is now'],
  ['orb', 'Glowing orb'],
  ['comet', 'Comet with a long tail'],
  ['spiral', 'Curving missile (like Arcane Missiles)'],
  ['bolt', 'Jagged bolt of energy'],
  ['fireball', 'Rolling fireball'],
];
export const LOOK_TRAILS: [string, string][] = [
  ['default', 'As it is now'],
  ['none', 'No trail'],
  ['sparks', 'Sparks'],
  ['stars', 'Stars'],
  ['flame', 'Flames and smoke'],
  ['frost', 'Frost motes and snow'],
  ['embers', 'Glowing embers'],
  ['smoke', 'Dark smoke'],
  ['shadow', 'Dark wisps'],
  ['holy', 'Motes of light'],
];
/** Named colours for a look (a hex number each). 'default' keeps the skill's school colour. */
export const LOOK_COLORS: Record<string, [string, number]> = {
  default: ['The skill\'s own colour', 0],
  white: ['White', 0xffffff], red: ['Red', 0xff3b2e], orange: ['Orange', 0xff8a2a], gold: ['Gold', 0xffd24a], yellow: ['Yellow', 0xfff06a], lime: ['Lime', 0x9dff3a], green: ['Green', 0x37e26a], teal: ['Teal', 0x2fe0c8],
  cyan: ['Ice blue', 0x7fd8ff], blue: ['Blue', 0x3a78ff], violet: ['Violet', 0x9a4dff], purple: ['Arcane purple', 0xc58bff], pink: ['Pink', 0xff6fb4], shadow: ['Shadow purple', 0x6a2fb0], holy: ['Holy light', 0xfff1a8], black: ['Void black', 0x2a1a3a],
};
export const LOOK_IMPACTS: [string, string][] = [['default', 'As it is now'], ['fire', 'Fire'], ['frost', 'Frost'], ['arcane', 'Arcane'], ['shadow', 'Shadow'], ['holy', 'Holy light'], ['nature', 'Nature'], ['dust', 'Dust']];
export const LOOK_HIT_STYLES: [string, string][] = [['default', 'As it is now'], ['impact', 'A flash and burst'], ['eruption', 'Erupts from the ground'], ['pillar', 'A pillar of light'], ['swirl', 'A swirl round the target']];

export interface SkillLook { form: string; color: string; trail: string; size: number; trailAmount: number; speed: number; hitKind: string; hitStyle: string; hitSize: number }
export const NEUTRAL_LOOK: SkillLook = { form: 'default', color: 'default', trail: 'default', size: 1, trailAmount: 1, speed: 1, hitKind: 'default', hitStyle: 'default', hitSize: 1 };
export const LOOK_NUMBER_BOUNDS: Record<string, { min: number; max: number }> = { size: { min: 0.3, max: 3 }, trailAmount: { min: 0, max: 3 }, speed: { min: 0.4, max: 2.5 }, hitSize: { min: 0.3, max: 3 } };
export const LOOK_CHOICES: Record<string, string[]> = {
  form: LOOK_FORMS.map((x) => x[0]), color: Object.keys(LOOK_COLORS), trail: LOOK_TRAILS.map((x) => x[0]), hitKind: LOOK_IMPACTS.map((x) => x[0]), hitStyle: LOOK_HIT_STYLES.map((x) => x[0]),
};
export const LOOK_KEYS = Object.keys(NEUTRAL_LOOK);

/** What a skill's look is now (patches applied); a skill the file does not list keeps every look it has. */
export function skillLook(id: string | null | undefined): SkillLook {
  const s = id ? (LOOKS as Record<string, Partial<SkillLook>>)[id] : undefined;
  return { ...NEUTRAL_LOOK, ...(s ?? {}) };
}
/** A look is changed from the game's own when any part of it is picked. */
export const isCustomLook = (l: SkillLook): boolean => JSON.stringify(l) !== JSON.stringify(NEUTRAL_LOOK);
export const lookColor = (name: string): number | null => (name !== 'default' && LOOK_COLORS[name] ? LOOK_COLORS[name][1] : null);

/** Skills that have a projectile or an impact to look at (all but the pure self buffs and movements). */
export const looksFor = (): string[] => Object.keys(ABILITIES);
