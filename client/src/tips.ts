import { ABILITIES, AURAS, CLASSES, GEAR, SPECS, TALENTS, describeAbility, describeAura, describeMods, itemById, itemColor, newMods, perkById, rarityOf, specOf, tierOf } from '@arena/shared';
import type { ClassId, Mods, StatId } from '@arena/shared';
import { setTipResolver } from './tooltip';
import type { TipContent } from './tooltip';

const SCHOOL_COLOR: Record<string, string> = {
  physical: '#e8d8b8', fire: '#ff9a50', frost: '#8fdcff', arcane: '#d3a8ff', holy: '#fff0a0', shadow: '#b98aff', nature: '#8dff8a',
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The player's current numbers, so ability tooltips show real damage (talents and gear included). */
let mods: Mods = newMods();
let matches = 0;
export function setTipMods(m: Mods) {
  mods = m;
}
export function setTipProgress(n: number) {
  matches = n;
}

export function abilityTip(id: string): TipContent | null {
  const def = ABILITIES[id];
  if (!def) return null;
  const d = describeAbility(def, mods);
  return { title: d.name, titleColor: SCHOOL_COLOR[def.school], tag: cap(d.school), stats: d.stats, lines: d.lines, notes: d.notes };
}

export function itemTip(id: string): TipContent | null {
  const item = itemById(id);
  if (!item) return null;
  const slot = GEAR.slots.find((s) => s.id === item.slot)!;
  const lines = (Object.keys(item.stats) as StatId[]).filter((s) => item.stats[s] > 0).map((s) => `+${item.stats[s]} ${GEAR.stats[s].name}`);
  if (item.rarity) {
    const perk = perkById(item.perk);
    return {
      title: item.name,
      titleColor: itemColor(item),
      tag: slot.name,
      stats: [`${rarityOf(item.rarity)?.name ?? 'Loot'} · dropped loot`],
      good: perk ? [...lines, `${perk.name}: ${perk.desc} (counts once)`] : lines,
      bad: [],
    };
  }
  const tier = tierOf(item.tier)!;
  const flavor = GEAR.flavors.find((f) => f.id === item.flavor)!;
  return {
    title: item.name,
    titleColor: tier.color,
    tag: slot.name,
    stats: [`${tier.name} tier · ${flavor.desc}`],
    good: lines,
    bad: matches < tier.unlockMatches ? [`Locked: play ${tier.unlockMatches - matches} more match${tier.unlockMatches - matches === 1 ? '' : 'es'} to unlock.`] : [],
  };
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
        return { title: def.name, titleColor: def.harmful ? '#ff8a7a' : '#8dff9a', tag: def.harmful ? 'Debuff' : 'Buff', lines: [describeAura(a)], notes: def.dispellable ? ['Magic: can be dispelled.'] : [] };
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
        const t = TALENTS[a as ClassId]?.flat().find((x) => x.id === b);
        if (!t) return null;
        return { title: t.name, titleColor: '#ffd24a', lines: [t.desc], good: describeMods(t.mods), footer: data.tipHint || undefined };
      }
      case 'item':
        return itemTip(a);
      case 'stat': {
        const s = GEAR.stats[a as StatId];
        if (!s) return null;
        return { title: s.name, titleColor: '#ffd24a', lines: [s.desc], stats: [`Each point gives ${s.ratePct}%.`] };
      }
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
