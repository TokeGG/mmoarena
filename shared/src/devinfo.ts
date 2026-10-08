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

/** A small fact about how a skill behaves ("Uses the global cooldown"), for the chips at the top of the dev panel. */
export interface SkillFlag {
  label: string;
  /** What it means in a sentence. */
  tip: string;
  /** 'yes' = a rule that applies, 'no' = an exemption, 'info' = a plain fact. */
  tone: 'yes' | 'no' | 'info';
}

export interface SkillInfo {
  flags: SkillFlag[];
  sections: SkillSection[];
  modifiers: SkillModifier[];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Every rule that applies to a skill, as chips: global cooldown, cast, movement, control, range, cost and so on. */
export function skillFlags(abilityId: string): SkillFlag[] {
  const d = ABILITIES[abilityId];
  if (!d) return [];
  const out: SkillFlag[] = [];
  const add = (label: string, tip: string, tone: SkillFlag['tone'] = 'info') => out.push({ label, tip, tone });
  if (d.gcd) add('Affected by GCD', 'Using it starts the global cooldown, and it cannot be used while the global cooldown runs.', 'yes');
  else add('Off the GCD', 'Ignores the global cooldown: it can be used at any moment and does not start one.', 'no');
  if (d.channel) add('Channelled', `Channelled over ${d.channel.ticks} tick${d.channel.ticks === 1 ? '' : 's'}.`);
  else if (d.castTime > 0) add('Has a cast time', 'Takes time to cast and stops if you move or are interrupted.', 'yes');
  else add('Instant', 'No cast time.', 'info');
  if (d.castWhileMoving) add('Cast while moving', 'Moving does not cancel it.', 'no');
  if (d.unstoppable) add('Unstoppable', 'Cannot be interrupted, and shrugs off stuns, fears, roots and slows while it lasts.', 'no');
  if (d.ignoresControl) add('Works while stunned', 'Can be used while stunned, feared or incapacitated.', 'no');
  if (d.ignoresLockout) add('Ignores lockouts', 'Cannot be locked out by an interrupt.', 'no');
  if (d.allowWhileRooted) add('Usable while rooted', 'A root does not stop it.', 'no');
  if (d.requiresStealth) add('Needs stealth', 'Only usable while stealthed.', 'yes');
  if (d.stealthSwap) add('Stealth swap', `Its slot becomes ${ABILITIES[d.stealthSwap]?.name ?? d.stealthSwap} while stealthed.`);
  if (d.outOfCombatOnly) add('Out of combat only', 'Cannot be used in combat.', 'yes');
  if (d.requiresTargetCasting) add('Needs a casting target', 'Only works while the target is casting.', 'yes');
  if (d.maxTargetHealthPct) add(`Target under ${d.maxTargetHealthPct}% health`, 'Only works on a target below this health.', 'yes');
  if (d.requiresTargetAura?.length) add('Needs a debuff on the target', `Target needs: ${d.requiresTargetAura.map((a) => AURAS[a]?.name ?? a).join(' or ')}.`, 'yes');
  if (d.cpSpend) add('Spends combo points', 'Needs at least one combo point and spends them all.', 'yes');
  if (d.cpGain) add(`+${d.cpGain} combo point`, 'Earns combo points when it lands.');
  if (d.rageSpend) add('Rage payoff', `Needs ${d.rageSpend.min} rage and spends it all.`, 'yes');
  if (d.target === 'ground') add('Ground target', 'Aimed at a spot on the ground.');
  else if (d.target === 'self') add('Self', 'Only affects you.');
  else if (d.target === 'ally' || d.target === 'ally_or_self') add('Friendly target', 'Used on an ally (or you).');
  else if (d.target === 'any') add('Any target', 'Used on an ally or an enemy.');
  else if (d.target === 'aoe_enemy' || d.target === 'aoe_all') add('Area', `Hits everything within ${d.radius ?? '?'} yards.`);
  else if (d.target === 'enemy') add('Enemy target', 'Used on an enemy.');
  if (d.range > 0) add(`${d.range} yd range`, 'How far away the target can be.');
  if (d.minRange) add(`Min ${d.minRange} yd`, 'The target must be at least this far away.', 'yes');
  if (!d.unmissable && d.target !== 'self' && d.target !== 'ground') add('Needs facing', 'You must face the target (a 90 degree cone) and have line of sight.', 'yes');
  if (d.cost > 0) add(`Costs ${d.cost}`, 'Resource spent when used.');
  if (d.cooldown > 0) add(`${d.cooldown / 1000}s cooldown`, 'Time before it can be used again.');
  add(`${d.school} school`, 'An interrupt locks out this school.');
  if (d.prepOk) add('Usable before the gates open', 'Can be used during the preparation phase.', 'no');
  return out;
}

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
  if (!def) return { flags: [], sections: [], modifiers: [] };
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
  return { flags: skillFlags(abilityId), sections, modifiers: [...merged.values()] };
}
