import { ABILITIES, AURAS, CLASSES, CLASS_BLURB, COSMETICS, SPECS, TALENTS, auraOrigins, compileMods, describeAbility, describeAura, describeTalent, explainAbility, itemById, newMods, specOf, specPassives, talentsFor } from '@arena/shared';
import type { Build, ClassId, ModSource, Mods } from '@arena/shared';
import { invalidateTip, setTipResolver } from './tooltip';
import type { TipContent } from './tooltip';
import { botTests } from './botTestState';
import { botTestTip } from './botTestText';

const SCHOOL_COLOR: Record<string, string> = {
  physical: '#e8d8b8', fire: '#ff9a50', frost: '#8fdcff', arcane: '#d3a8ff', holy: '#fff0a0', shadow: '#b98aff', nature: '#8dff8a',
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The numbers a build gives: its modifiers, and which spec and talents each bonus comes from (for the Alt view). */
interface TipBuild {
  mods: Mods;
  sources: ModSource[];
}

function buildTips(classId: ClassId, build: Build | undefined): TipBuild {
  const sources: ModSource[] = [];
  const spec = build ? specOf(classId, build.spec) : undefined;
  // each bonus is named with where it comes from: the spec's passive, or a talent (and its tier)
  if (spec) sources.push({ label: `${spec.name} (spec passive)`, mods: spec.mods });
  if (build) {
    const tiers = talentsFor(classId, build.spec);
    const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];
    build.talents.forEach((id, i) => {
      const t = tiers[i]?.find((x) => x.id === id);
      if (t) sources.push({ label: `${t.name} (talent, tier ${ROMAN[i] ?? i + 1})`, mods: t.mods });
    });
  }
  return { mods: compileMods(classId, build), sources };
}

/** The player's current build, so ability tooltips show real numbers (spec and talents included). */
let current: TipBuild = buildTips('mage', undefined);
/** The build the tooltips describe. Call it whenever the class, spec or a talent changes: an open tooltip is redrawn at once. */
export function setTipBuild(classId: ClassId, build: Build | undefined) {
  current = buildTips(classId, build);
  cache.clear();
  invalidateTip();
}

/**
 * A `data-tip-build` value for an ability tooltip that should describe another build than the current one (the spec
 * popover in the menu shows each spec with the talents it would have).
 */
export function tipBuildKey(classId: ClassId, build: Build): string {
  return `${classId}|${build.spec}|${build.talents.join(',')}`;
}
const cache = new Map<string, TipBuild>();
/** No spec and no talents: the values an effect has when it is not yours. */
const PLAIN = newMods();
function fromKey(key: string | undefined): TipBuild {
  if (!key) return current;
  let b = cache.get(key);
  if (!b) {
    const [classId, spec, talents] = key.split('|');
    b = CLASSES[classId as ClassId] ? buildTips(classId as ClassId, { spec, talents: talents ? talents.split(',') : [], gear: {} }) : current;
    cache.set(key, b);
  }
  return b;
}

/** Matches played, so cosmetic tooltips can say what is still locked. */
let played = 0;
export function setTipProgress(matches: number) {
  played = matches;
}

/** An ability's tooltip for a build (the current one by default). Numbers the spec or talents change are marked. */
export function abilityTip(id: string, build: TipBuild = current): TipContent | null {
  const def = ABILITIES[id];
  if (!def) return null;
  const d = describeAbility(def, build.mods, undefined, { mark: true });
  return { title: d.name, titleColor: SCHOOL_COLOR[def.school], tag: cap(d.school), stats: d.stats, lines: d.lines, good: d.added, notes: d.notes, more: explainAbility(def, build.mods, build.sources) };
}

export function itemTip(id: string): TipContent | null {
  const item = itemById(id);
  if (!item) return null;
  const slot = COSMETICS.slots.find((s) => s.id === item.slot)!;
  const notes: string[] = [];
  const bad: string[] = [];
  if (item.owner) notes.push('Founder only.');
  else if (item.unlock) (played >= item.unlock ? notes : bad).push(played >= item.unlock ? `Unlocked at ${item.unlock} matches.` : `Locked: play ${item.unlock} matches (you have ${played}).`);
  // "cosmetic only" is said once, in the Look window's header, not on every item
  return { title: item.name, titleColor: item.color, tag: slot.name, lines: item.desc ? [item.desc] : undefined, bad, notes };
}

export function installTips() {
  setTipResolver(resolveTip);
}

/** The tooltip for a `data-tip` key (`ability:id`, `aura:id`, `talent:class:id`...), null when there is none. */
export function resolveTip(key: string, data: DOMStringMap | Record<string, string | undefined>): TipContent | null {
  const [kind, a, b] = key.split(':');
  switch (kind) {
    case 'ability':
      return abilityTip(a, fromKey(data.tipBuild));
    case 'aura': {
      const def = AURAS[a];
      if (!def) return null;
      // where it came from: who put it there (on a unit frame), and what gives it (an ability, a spec passive, a talent)
      const origins = auraOrigins(a).filter((o) => o !== def.name); // Psychic Scream's fear comes from Psychic Scream: no need to say so
      const from = [data.tipFrom ? `From ${data.tipFrom}.` : '', origins.length ? `Comes from ${origins.join(', ')}.` : ''].filter(Boolean);
      return { title: def.name, titleColor: def.harmful ? '#ff8a7a' : '#8dff9a', tag: def.harmful ? 'Debuff' : 'Buff', lines: [describeAura(a, data.tipPlain ? PLAIN : current.mods)], stats: from.length ? from : undefined, notes: def.dispellable ? ['Magic: can be dispelled.'] : [] };
    }
    case 'spec': {
      const spec = specOf(a as ClassId, b);
      if (!spec) return null;
      return {
        title: spec.name,
        titleColor: CLASSES[a as ClassId].color,
        tag: spec.role,
        lines: [spec.desc],
        // its passives: the built-in effect, its auto-attack, and every bonus it carries (no button needed)
        good: specPassives(a as ClassId, spec.id).map((p) => `Passive: ${p}`),
        stats: ['Abilities: ' + spec.bar.map((id) => ABILITIES[id].name).join(', ')],
      };
    }
    case 'talent': {
      const t = Object.values(TALENTS[a as ClassId] ?? {}).flat(2).find((x) => x.id === b);
      if (!t) return null;
      // the description first; generated numbers and the swap only where it does not already say them
      const d = describeTalent(t);
      return { title: t.name, titleColor: '#ffd24a', lines: d.lines, good: d.mods, stats: d.swap ? [d.swap] : undefined, footer: data.tipHint || undefined };
    }
    case 'item':
      return itemTip(a);
    case 'class': {
      const c = CLASSES[a as ClassId];
      if (!c) return null;
      return { title: c.name, titleColor: c.color, stats: [`${c.maxHealth} health · ${cap(c.resource.type)}`], lines: data.tipText ? [data.tipText] : [] };
    }
    case 'bottest': {
      const t = botTests.get(Number(a));
      return t ? botTestTip(t) : null;
    }
    case 'text':
      // a body that only restates the title adds nothing
      return { title: data.tipTitle ?? '', lines: data.tipText && !sameText(data.tipText, data.tipTitle ?? '') ? [data.tipText] : [] };
    default:
      return null;
  }
}

/** True when `body` says no more than `title` ("Ranked" / "Ranked match"). */
function sameText(body: string, title: string): boolean {
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !['a', 'an', 'the', 'match', 'mode'].includes(w));
  const t = new Set(words(title));
  return words(body).every((w) => t.has(w));
}

/** The one-line class pitch on the menu (kept with the other tooltip text in shared). */
export { CLASS_BLURB };
void SPECS;
