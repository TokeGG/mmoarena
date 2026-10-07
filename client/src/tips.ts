import { ABILITIES, AURAS, CLASSES, COSMETICS, SPECS, TALENTS, compileMods, describeAbility, describeAura, describeMods, explainAbility, itemById, newMods, specOf, talentsFor } from '@arena/shared';
import type { Build, ClassId, ModSource, Mods } from '@arena/shared';
import { setTipResolver } from './tooltip';
import type { TipContent } from './tooltip';

const SCHOOL_COLOR: Record<string, string> = {
  physical: '#e8d8b8', fire: '#ff9a50', frost: '#8fdcff', arcane: '#d3a8ff', holy: '#fff0a0', shadow: '#b98aff', nature: '#8dff8a',
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The player's current numbers, so ability tooltips show real damage (talents and gear included). */
let mods: Mods = newMods();
let sources: ModSource[] = [];
/** The build the tooltips describe: its modifiers, and which spec and talents each bonus comes from (for the Alt view). */
export function setTipBuild(classId: ClassId, build: Build | undefined) {
  mods = compileMods(classId, build);
  sources = [];
  const spec = build ? specOf(classId, build.spec) : undefined;
  if (spec) sources.push({ label: spec.name, mods: spec.mods });
  if (build) {
    const tiers = talentsFor(classId, build.spec);
    build.talents.forEach((id, i) => {
      const t = tiers[i]?.find((x) => x.id === id);
      if (t) sources.push({ label: t.name, mods: t.mods });
    });
  }
}
/** Matches played, so cosmetic tooltips can say what is still locked. */
let played = 0;
export function setTipProgress(matches: number) {
  played = matches;
}

export function abilityTip(id: string): TipContent | null {
  const def = ABILITIES[id];
  if (!def) return null;
  const d = describeAbility(def, mods);
  return { title: d.name, titleColor: SCHOOL_COLOR[def.school], tag: cap(d.school), stats: d.stats, lines: d.lines, notes: d.notes, more: explainAbility(def, mods, sources) };
}

export function itemTip(id: string): TipContent | null {
  const item = itemById(id);
  if (!item) return null;
  const slot = COSMETICS.slots.find((s) => s.id === item.slot)!;
  const notes: string[] = [];
  const bad: string[] = [];
  if (item.owner) notes.push('Founder only.');
  else if (item.unlock) (played >= item.unlock ? notes : bad).push(played >= item.unlock ? `Unlocked at ${item.unlock} matches.` : `Locked: play ${item.unlock} matches (you have ${played}).`);
  return { title: item.name, titleColor: item.color, tag: slot.name, stats: [], good: ['Cosmetic only: changes how you look, never how you fight.'], bad, notes };
}

export function installTips() {
  setTipResolver((key, data) => {
    const [kind, a, b] = key.split(':');
    switch (kind) {
      case 'ability':
        return abilityTip(a);
      case 'aura': {
        const def = AURAS[a];
        if (!def) return null;
        return { title: def.name, titleColor: def.harmful ? '#ff8a7a' : '#8dff9a', tag: def.harmful ? 'Debuff' : 'Buff', lines: [describeAura(a, mods)], notes: def.dispellable ? ['Magic: can be dispelled.'] : [] };
      }
      case 'spec': {
        const spec = specOf(a as ClassId, b);
        if (!spec) return null;
        return {
          title: spec.name,
          titleColor: CLASSES[a as ClassId].color,
          tag: spec.role,
          lines: [spec.desc],
          good: describeMods(spec.mods),
          stats: ['Abilities: ' + spec.bar.map((id) => ABILITIES[id].name).join(', ')],
        };
      }
      case 'talent': {
        const t = Object.values(TALENTS[a as ClassId] ?? {}).flat(2).find((x) => x.id === b);
        if (!t) return null;
        const swap = t.swap ? [`Learn ${ABILITIES[t.swap.to]?.name ?? t.swap.to} in place of ${ABILITIES[t.swap.from]?.name ?? t.swap.from}`] : undefined;
        return { title: t.name, titleColor: '#ffd24a', lines: [t.desc], good: describeMods(t.mods), stats: swap, footer: data.tipHint || undefined };
      }
      case 'item':
        return itemTip(a);
      case 'class': {
        const c = CLASSES[a as ClassId];
        if (!c) return null;
        return { title: c.name, titleColor: c.color, stats: [`${c.maxHealth} health · ${cap(c.resource.type)}`], lines: [data.tipText ?? ''] };
      }
      case 'text':
        return { title: data.tipTitle ?? '', lines: data.tipText ? [data.tipText] : [] };
      default:
        return null;
    }
  });
}

export const CLASS_BLURB: Record<ClassId, string> = {
  warrior: 'Heavy melee fighter. Builds rage by fighting. Charges in, hamstrings, interrupts.',
  mage: 'Ranged caster. Slows, roots and polymorphs. Fragile, so keep your distance.',
  priest: 'Healer and support. Shields, heals, dispels and fears. Mana-hungry.',
  rogue: 'Stealth melee assassin. Stuns from stealth, kicks casters, hard to pin down.',
};
void SPECS;
