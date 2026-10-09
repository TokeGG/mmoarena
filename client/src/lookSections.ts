/**
 * The Look window gathers every cosmetic and look setting in one place. This file is the pure part: which section
 * holds what, and the search over them (no DOM, so it is tested on its own).
 */
import type { LookOption } from './hudLook';

export type LookSectionId = 'character' | 'name' | 'cursor' | 'hud' | 'effects';

export interface LookSection {
  id: LookSectionId;
  label: string;
  /** One line under the tabs. */
  blurb: string;
  /** Extra words the search matches, besides the label. */
  words: string[];
}

export const LOOK_SECTIONS: LookSection[] = [
  { id: 'character', label: 'Character', blurb: 'Headwear, wings, back, glow and the other slots your character wears. Everyone sees them; they never change how you fight.', words: ['gear', 'cosmetic', 'skin', 'outfit', 'weapon', 'random', 'head', 'headwear', 'wings', 'back', 'cape', 'glow', 'aura', 'model'] },
  { id: 'name', label: 'Name and title', blurb: 'How your name shows on nameplates, the leaderboard and in the menu: emblem, title, colour, special style and animated icon.', words: ['title', 'emblem', 'icon', 'avatar', 'badge', 'frame', 'colour', 'color', 'gradient', 'gif', 'animated', 'style', 'font', 'name', 'nameplate name'] },
  { id: 'cursor', label: 'Cursor', blurb: 'The pointer you see in the menus and in matches. Over an enemy, an ally or while aiming it always switches to the fixed ones.', words: ['pointer', 'mouse', 'size', 'tint', 'trail', 'ripple', 'click', 'crosshair'] },
  { id: 'hud', label: 'Nameplates and HUD', blurb: 'Frames, health bars, nameplates over heads, the target mark, ability slots and the kill feed. Positions are still set in Edit HUD layout.', words: ['hud', 'frames', 'bars', 'health', 'nameplate', 'plates', 'target', 'kill feed', 'portrait', 'slots', 'cast bar', 'combat log', 'help'] },
  { id: 'effects', label: 'Effects', blurb: 'On-screen text: error messages, stun and control text and the network stats readout.', words: ['text', 'floating', 'error', 'stun', 'control', 'network', 'stats', 'damage', 'effects', 'outline', 'shadow'] },
];

/** Groups of the HUD look options that are about on-screen text and effects; everything else belongs to the HUD section. */
export const EFFECT_GROUPS = ['Error text', 'Stun text', 'Network stats'];

/** The section a HUD look option is shown in. */
export function sectionOfOption(o: Pick<LookOption, 'group'>): LookSectionId {
  return EFFECT_GROUPS.includes(o.group ?? '') ? 'effects' : 'hud';
}

export function optionsOfSection(id: LookSectionId, options: readonly LookOption[]): LookOption[] {
  // the old single-profile nameplate dropdowns are replaced by the nameplate editor
  return options.filter((o) => sectionOfOption(o) === id && o.group !== 'Nameplates');
}

/** The group headings of a section in display order ('' is the ungrouped head: frames, bars and slots). */
export function groupsOf(options: readonly LookOption[]): { group: string; options: LookOption[] }[] {
  const out: { group: string; options: LookOption[] }[] = [];
  for (const o of options) {
    const g = o.group ?? '';
    let slot = out.find((x) => x.group === g);
    if (!slot) out.push((slot = { group: g, options: [] }));
    slot.options.push(o);
  }
  return out;
}

export const UNGROUPED_TITLE = 'Frames, bars and ability slots';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export interface LookHits {
  /** Sections whose name or keywords match. */
  sections: LookSection[];
  /** Individual HUD look options that match (shown as live controls in the results). */
  options: LookOption[];
}

/**
 * Every word of the query has to appear in the section's name/keywords, or in an option's label, group or id.
 * `extra` adds words that belong to the character section, such as its slot and item names.
 */
export function searchLook(query: string, options: readonly LookOption[], extra: readonly string[] = []): LookHits {
  const words = norm(query).split(' ').filter(Boolean);
  if (!words.length) return { sections: [], options: [] };
  const has = (hay: string) => words.every((w) => hay.includes(w));
  const sections = LOOK_SECTIONS.filter((s) => has(norm([s.label, ...s.words, ...(s.id === 'character' ? extra : [])].join(' '))));
  const opts = options.filter((o) => o.group !== 'Nameplates' && has(norm(`${o.label} ${o.group ?? ''} ${o.id} ${o.choices.map(([, t]) => t).join(' ')}`)));
  return { sections, options: opts };
}
