import { AURAS, GEAR, SPECS, TALENTS, TUNING } from './data';
import type { AbilityMod, Build, ClassId, GearItem, Mods, ModsInput, StatId } from './types';

/** Everything a build changes in combat is expressed as `Mods`; this file is the only place that turns picks into numbers. */

export const NEUTRAL_MODS: Mods = Object.freeze({
  damageDone: 1, healingDone: 1, damageTaken: 1, maxHealth: 1, castTime: 1, gcd: 1, regen: 1, moveSpeed: 1, ability: {}, auraDuration: {},
}) as Mods;

export function newMods(): Mods {
  return { damageDone: 1, healingDone: 1, damageTaken: 1, maxHealth: 1, castTime: 1, gcd: 1, regen: 1, moveSpeed: 1, ability: {}, auraDuration: {} };
}

const SCALARS = ['damageDone', 'healingDone', 'damageTaken', 'maxHealth', 'castTime', 'gcd', 'regen', 'moveSpeed'] as const;

/** Multiplies `into` by `add` (mutates and returns `into`). */
export function applyMods(into: Mods, add: ModsInput | undefined): Mods {
  if (!add) return into;
  for (const k of SCALARS) if (add[k] !== undefined) into[k] *= add[k]!;
  if (add.ability) {
    for (const [id, m] of Object.entries(add.ability)) {
      const cur: AbilityMod = (into.ability[id] ??= {});
      for (const key of ['damage', 'heal', 'cooldown', 'castTime'] as const) if (m[key] !== undefined) cur[key] = (cur[key] ?? 1) * m[key]!;
      if (m.range !== undefined) cur.range = (cur.range ?? 0) + m.range;
    }
  }
  if (add.auraDuration) for (const [id, v] of Object.entries(add.auraDuration)) into.auraDuration[id] = (into.auraDuration[id] ?? 1) * v;
  return into;
}

// ------------------------------------------------------------------ gear

export const SLOT_IDS = GEAR.slots.map((s) => s.id);

/** All items. Generated from gear.json so adding a tier or flavor is a data change. */
export const ITEMS: GearItem[] = [];
for (const tier of GEAR.tiers) {
  for (const slot of GEAR.slots) {
    for (const flavor of GEAR.flavors) {
      const stats = { power: 0, vitality: 0, haste: 0, resilience: 0 } as Record<StatId, number>;
      for (const [stat, w] of Object.entries(flavor.weights)) stats[stat as StatId] = Math.round(tier.budget * slot.weight * (w ?? 0));
      ITEMS.push({ id: `${tier.id}.${slot.id}.${flavor.id}`, slot: slot.id, tier: tier.id, flavor: flavor.id, name: `${tier.name} ${flavor.name} ${slot.noun}`, stats });
    }
  }
}
const ITEM_BY_ID = new Map(ITEMS.map((i) => [i.id, i]));
export const itemById = (id: string): GearItem | undefined => ITEM_BY_ID.get(id);
export const itemsForSlot = (slot: string): GearItem[] => ITEMS.filter((i) => i.slot === slot);
export const tierOf = (id: string) => GEAR.tiers.find((t) => t.id === id);

export function tierUnlocked(tierId: string, matchesPlayed: number): boolean {
  const t = tierOf(tierId);
  return !!t && matchesPlayed >= t.unlockMatches;
}

export function gearStats(gear: Record<string, string> | undefined): Record<StatId, number> {
  const total = { power: 0, vitality: 0, haste: 0, resilience: 0 } as Record<StatId, number>;
  for (const slot of SLOT_IDS) {
    const item = gear?.[slot] ? itemById(gear[slot]) : undefined;
    if (!item || item.slot !== slot) continue;
    for (const s of Object.keys(total) as StatId[]) total[s] += item.stats[s];
  }
  return total;
}

/** Percentage bonus each stat gives, hard-capped by tuning.gearCap so gear can never exceed it. */
export function statBonuses(stats: Record<StatId, number>): Record<StatId, number> {
  const cap = (TUNING.gearCap - 1) * 100;
  const out = {} as Record<StatId, number>;
  for (const s of Object.keys(stats) as StatId[]) out[s] = Math.min(cap, stats[s] * GEAR.stats[s].ratePct);
  return out;
}

export function gearMods(gear: Record<string, string> | undefined): ModsInput {
  const b = statBonuses(gearStats(gear));
  return {
    damageDone: 1 + b.power / 100,
    healingDone: 1 + b.power / 100,
    maxHealth: 1 + b.vitality / 100,
    castTime: 1 - b.haste / 100,
    gcd: 1 - b.haste / 100,
    damageTaken: 1 - b.resilience / 100,
  };
}

/** Best unlocked item per slot for the given flavor (used by "auto equip"). */
export function bestGear(flavor: string, matchesPlayed: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const slot of SLOT_IDS) {
    const pick = itemsForSlot(slot)
      .filter((i) => i.flavor === flavor && tierUnlocked(i.tier, matchesPlayed))
      .sort((a, b) => (tierOf(b.tier)!.budget - tierOf(a.tier)!.budget))[0];
    if (pick) out[slot] = pick.id;
  }
  return out;
}

// ------------------------------------------------------------------ specs and talents

export const specOf = (classId: ClassId, specId: string) => SPECS[classId]?.find((s) => s.id === specId);
export const defaultSpec = (classId: ClassId) => SPECS[classId][0];
export const talentsFor = (classId: ClassId, specId: string | undefined) => {
  void specId; // talents are per class today; kept in the signature so they can become per spec
  return TALENTS[classId];
};

export const emptyBuild = (classId: ClassId): Build => ({ spec: defaultSpec(classId).id, talents: [], gear: {} });

export type BuildCheck = { ok: true } | { ok: false; reason: string };

/** Strict check used by the server for anything a client sends. */
export function validateBuild(classId: ClassId, b: Build, matchesPlayed: number): BuildCheck {
  if (!specOf(classId, b.spec)) return { ok: false, reason: 'unknown spec' };
  const tiers = TALENTS[classId];
  if (b.talents.length > tiers.length) return { ok: false, reason: 'too many talents' };
  for (let i = 0; i < b.talents.length; i++) {
    if (b.talents[i] === '') continue;
    if (!tiers[i].some((t) => t.id === b.talents[i])) return { ok: false, reason: 'invalid talent' };
  }
  for (const [slot, id] of Object.entries(b.gear)) {
    const item = itemById(id);
    if (!SLOT_IDS.includes(slot) || !item || item.slot !== slot) return { ok: false, reason: 'invalid gear' };
    if (!tierUnlocked(item.tier, matchesPlayed)) return { ok: false, reason: `${item.name} is locked` };
  }
  return { ok: true };
}

/** Lenient compile: ignores anything unknown, so a stale save can never crash a match. */
export function compileMods(classId: ClassId, b: Build | undefined): Mods {
  const m = newMods();
  if (!b) return m;
  applyMods(m, specOf(classId, b.spec)?.mods);
  const tiers = TALENTS[classId] ?? [];
  b.talents.forEach((id, i) => applyMods(m, tiers[i]?.find((t) => t.id === id)?.mods));
  applyMods(m, gearMods(b.gear));
  return m;
}

export function barFor(classId: ClassId, b: Build | undefined, fallback: string[]): string[] {
  const spec = b ? specOf(classId, b.spec) : undefined;
  return spec ? spec.bar : fallback;
}

/** Combined modifiers of the active buff auras on a unit, multiplied onto its base mods. */
export function withAuraMods(base: Mods, auraIds: string[]): Mods {
  let any = false;
  for (const id of auraIds) if (AURAS[id]?.mods) any = true;
  if (!any) return base;
  const m: Mods = { ...base, ability: Object.fromEntries(Object.entries(base.ability).map(([k, v]) => [k, { ...v }])), auraDuration: { ...base.auraDuration } };
  for (const id of auraIds) applyMods(m, AURAS[id]?.mods);
  return m;
}
