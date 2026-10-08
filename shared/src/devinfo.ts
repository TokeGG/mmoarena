import { ABILITIES, AURAS, CLASSES, SPECS, TALENTS } from './data';
import { auraOrigins, describeAura, describeAbility, describeMods, plainText } from './describe';
import { tunableNumbers } from './devpatch';
import type { TunableNumber } from './devpatch';
import type { ClassId } from './types';

/** One block of the dev panel: the skill itself, or an aura it is tied to, with where it comes from and what it does. */
export interface SkillSection {
  kind: 'ability' | 'aura';
  id: string;
  name: string;
  /** How it is tied to the skill: "the skill", "put on the target", "buff on you when it hits"... */
  link: string;
  /** Where it comes from (who has the skill, what applies the aura). */
  from: string[];
  /** What it does, in tooltip words (the numbers as they are now). */
  does: string[];
  fields: TunableNumber[];
}

/** A talent, spec or aura that changes the skill (not tunable here, shown so a dev sees everything acting on it). */
export interface SkillModifier {
  name: string;
  where: string;
  text: string;
}

export interface SkillInfo {
  sections: SkillSection[];
  modifiers: SkillModifier[];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Who has an ability: the specs whose bar starts with it, and the talents that swap it in. */
function abilityOrigins(id: string): string[] {
  const out: string[] = [];
  for (const cls of Object.keys(SPECS) as ClassId[]) {
    const cname = CLASSES[cls]?.name ?? cls;
    const specs = SPECS[cls].filter((s) => s.bar.includes(id)).map((s) => s.name);
    if (specs.length) out.push(`${cname}: ${specs.length === SPECS[cls].length ? 'every spec' : specs.join(', ')}`);
    for (const s of SPECS[cls]) {
      for (const tier of TALENTS[cls]?.[s.id] ?? []) {
        for (const t of tier) if (t.swap?.to === id) out.push(`${cname} ${s.name}: talent ${t.name} (replaces ${ABILITIES[t.swap.from]?.name ?? t.swap.from})`);
      }
    }
  }
  return [...new Set(out)];
}

/**
 * Everything the dev panel shows for a skill: its own numbers, every aura tied to it (put on the target or the caster,
 * a proc, an aura it consumes or exploits, one a talent adds), where each comes from and what it does, and the talents,
 * specs and buffs that change the skill.
 */
export function skillInfo(abilityId: string): SkillInfo {
  const def = ABILITIES[abilityId];
  if (!def) return { sections: [], modifiers: [] };
  const text = describeAbility(def);
  const sections: SkillSection[] = [
    { kind: 'ability', id: abilityId, name: def.name, link: 'the skill', from: abilityOrigins(abilityId), does: [...text.stats, ...text.lines].map(plainText), fields: tunableNumbers('abilities', abilityId) },
  ];
  const links = new Map<string, string[]>();
  const tie = (aura: string, how: string) => {
    if (!AURAS[aura]) return;
    links.set(aura, [...(links.get(aura) ?? []), how]);
  };
  for (const e of def.effects) {
    if (e.type === 'aura') tie(e.aura, `${e.self ? 'on you' : 'on the target'}${e.chance !== undefined ? ` (${Math.round(e.chance * 100)}% chance)` : ''}${e.duration ? `, lasts ${e.duration / 1000}s here` : ''}`);
    if (e.type === 'zone' && e.procOnHit) tie(e.procOnHit, 'buff on you when the opening hit lands');
  }
  if (def.consumes) tie(def.consumes.aura, `consumed by it: ${def.consumes.perStack} more per stack`);
  if (def.exploit) tie(def.exploit.aura, `it does ×${def.exploit.mult} to targets with it`);
  for (const [id, a] of Object.entries(AURAS)) if ((a as { dot?: { ability?: string } }).dot?.ability === abilityId) tie(id, 'its damage over time');

  const modifiers: SkillModifier[] = [];
  for (const cls of Object.keys(SPECS) as ClassId[]) {
    for (const s of SPECS[cls]) {
      const sm = s.mods?.ability?.[abilityId];
      if (sm) modifiers.push({ name: s.name, where: `${CLASSES[cls]?.name ?? cls} spec`, text: describeMods({ ability: { [abilityId]: sm } }).map(cap).join(' ') });
      for (const tier of TALENTS[cls]?.[s.id] ?? []) {
        for (const t of tier) {
          const m = t.mods?.ability?.[abilityId];
          for (const a of m?.after ?? []) tie(a, `added by talent ${t.name}`);
          for (const x of m?.extra ?? []) if (x.type === 'aura') tie(x.aura, `added by talent ${t.name}`);
          if (m || t.swap?.to === abilityId) modifiers.push({ name: t.name, where: `${CLASSES[cls]?.name ?? cls} ${s.name} talent`, text: t.desc });
        }
      }
    }
  }
  // auras on the skill whose duration talents change
  for (const cls of Object.keys(SPECS) as ClassId[]) {
    for (const s of SPECS[cls]) {
      for (const tier of TALENTS[cls]?.[s.id] ?? []) {
        for (const t of tier) {
          const hits = Object.keys(t.mods?.auraDuration ?? {}).some((a) => links.has(a)) || Object.keys(t.mods?.auraExtend ?? {}).some((a) => links.has(a));
          if (hits && !modifiers.some((x) => x.name === t.name)) modifiers.push({ name: t.name, where: `${CLASSES[cls]?.name ?? cls} ${s.name} talent`, text: t.desc });
        }
      }
    }
  }
  // buffs (from any skill) that change this one while they are up
  for (const [id, a] of Object.entries(AURAS)) {
    const am = (a as { mods?: { ability?: Record<string, unknown> } }).mods?.ability?.[abilityId];
    if (am) modifiers.push({ name: a.name, where: `aura (${auraOrigins(id).join(', ') || 'no source'})`, text: plainText(describeAura(id)) });
  }

  for (const [aura, how] of links) {
    const a = AURAS[aura];
    sections.push({ kind: 'aura', id: aura, name: a.name, link: [...new Set(how)].join('; '), from: auraOrigins(aura), does: [plainText(describeAura(aura))].filter(Boolean), fields: tunableNumbers('auras', aura) });
  }
  // the same talent in several specs is one line
  const merged = new Map<string, SkillModifier>();
  for (const m of modifiers) {
    const k = `${m.name}\n${m.text}`;
    const had = merged.get(k);
    if (had) had.where = `${had.where}, ${m.where}`;
    else merged.set(k, { ...m });
  }
  return { sections, modifiers: [...merged.values()] };
}
