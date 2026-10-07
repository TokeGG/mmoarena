import { AURAS, COSMETICS, SPECS, TALENTS } from './data';
import type { AbilityMod, Build, ClassId, CosmeticItem, Mods, ModsInput, TalentDef } from './types';

/** Everything a build changes in combat is expressed as `Mods`; this file is the only place that turns picks into numbers. */

export const NEUTRAL_MODS: Mods = Object.freeze({
  damageDone: 1, healingDone: 1, damageTaken: 1, maxHealth: 1, castTime: 1, gcd: 1, regen: 1, moveSpeed: 1, autoSpeed: 1, ability: {}, auraDuration: {},
}) as Mods;

export function newMods(): Mods {
  return { damageDone: 1, healingDone: 1, damageTaken: 1, maxHealth: 1, castTime: 1, gcd: 1, regen: 1, moveSpeed: 1, autoSpeed: 1, ability: {}, auraDuration: {} };
}

const SCALARS = ['damageDone', 'healingDone', 'damageTaken', 'maxHealth', 'castTime', 'gcd', 'regen', 'moveSpeed', 'autoSpeed'] as const;

/** Multiplies `into` by `add` (mutates and returns `into`). */
export function applyMods(into: Mods, add: ModsInput | undefined): Mods {
  if (!add) return into;
  for (const k of SCALARS) if (add[k] !== undefined) into[k] *= add[k]!;
  if (add.ability) {
    for (const [id, m] of Object.entries(add.ability)) {
      const cur: AbilityMod = (into.ability[id] ??= {});
      for (const key of ['damage', 'heal', 'cooldown', 'castTime'] as const) if (m[key] !== undefined) cur[key] = (cur[key] ?? 1) * m[key]!;
      if (m.range !== undefined) cur.range = (cur.range ?? 0) + m.range;
      if (m.charges !== undefined) cur.charges = (cur.charges ?? 0) + m.charges;
      if (m.after) cur.after = [...(cur.after ?? []), ...m.after];
    }
  }
  if (add.auraDuration) for (const [id, v] of Object.entries(add.auraDuration)) into.auraDuration[id] = (into.auraDuration[id] ?? 1) * v;
  return into;
}

// ------------------------------------------------------------------ cosmetics

export const SLOT_IDS = COSMETICS.slots.map((x) => x.id);
export const ITEMS: CosmeticItem[] = COSMETICS.items;
const ITEM_BY_ID = new Map(ITEMS.map((i) => [i.id, i]));
export const itemById = (id: string): CosmeticItem | undefined => ITEM_BY_ID.get(id);
export const itemsForSlot = (slot: string): CosmeticItem[] => ITEMS.filter((i) => i.slot === slot);

/** Keep only cosmetics that exist, sit in the right slot and are allowed (owner-only items need `isOwner`). */
export function cleanGear(gear: Record<string, string> | undefined, isOwner = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [slot, id] of Object.entries(gear ?? {})) {
    const item = itemById(id);
    if (item && item.slot === slot && (isOwner || !item.owner)) out[slot] = id;
  }
  return out;
}

export const specOf = (classId: ClassId, specId: string) => SPECS[classId]?.find((s) => s.id === specId);
export const defaultSpec = (classId: ClassId) => SPECS[classId][0];
/** The six talent tiers of one spec (talents differ per spec). */
export const talentsFor = (classId: ClassId, specId: string | undefined): TalentDef[][] => TALENTS[classId]?.[specId ?? ''] ?? [];

export const emptyBuild = (classId: ClassId): Build => ({ spec: defaultSpec(classId).id, talents: [], gear: {} });

export type BuildCheck = { ok: true } | { ok: false; reason: string };

/** Strict check used by the server for anything a client sends. */
export function validateBuild(classId: ClassId, b: Build, isOwner = false): BuildCheck {
  if (!specOf(classId, b.spec)) return { ok: false, reason: 'unknown spec' };
  const tiers = talentsFor(classId, b.spec);
  if (b.talents.length > tiers.length) return { ok: false, reason: 'too many talents' };
  for (let i = 0; i < b.talents.length; i++) {
    if (b.talents[i] === '') continue;
    if (!tiers[i].some((t) => t.id === b.talents[i])) return { ok: false, reason: 'invalid talent' };
  }
  for (const [slot, id] of Object.entries(b.gear)) {
    const item = itemById(id);
    if (!SLOT_IDS.includes(slot) || !item || item.slot !== slot) return { ok: false, reason: 'invalid cosmetic' };
    if (item.owner && !isOwner) return { ok: false, reason: `${item.name} is owner only` };
  }
  return { ok: true };
}

/** Lenient compile: ignores anything unknown, so a stale save can never crash a match. */
export function compileMods(classId: ClassId, b: Build | undefined): Mods {
  const m = newMods();
  if (!b) return m;
  applyMods(m, specOf(classId, b.spec)?.mods);
  const tiers = talentsFor(classId, b.spec);
  b.talents.forEach((id, i) => applyMods(m, tiers[i]?.find((t) => t.id === id)?.mods));
  // gear is cosmetic only: it never changes numbers (see gearLook for what it changes)
  return m;
}

/** The talent swaps picked in this build, in tier order. */
export function swapsFor(classId: ClassId, b: Build | undefined): { talent: TalentDef; from: string; to: string }[] {
  const spec = b ? specOf(classId, b.spec) : undefined;
  if (!b || !spec) return [];
  const out: { talent: TalentDef; from: string; to: string }[] = [];
  const tiers = talentsFor(classId, b.spec);
  b.talents.forEach((id, i) => {
    const t = tiers[i]?.find((x) => x.id === id);
    if (t?.swap && spec.bar.includes(t.swap.from)) out.push({ talent: t, from: t.swap.from, to: t.swap.to });
  });
  return out;
}

export function barFor(classId: ClassId, b: Build | undefined, fallback: string[]): string[] {
  const spec = b ? specOf(classId, b.spec) : undefined;
  if (!spec) return fallback;
  const bar = [...spec.bar];
  for (const s of swapsFor(classId, b)) {
    const at = bar.indexOf(s.from);
    if (at >= 0 && !bar.includes(s.to)) bar[at] = s.to;
  }
  return bar;
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

/** True when a unit's bar differs from its spec's default (a talent swapped an ability). */
export function barSwapped(classId: ClassId, spec: string | null, bar: readonly string[]): boolean {
  const d = spec ? specOf(classId, spec) : undefined;
  return !!d && (d.bar.length !== bar.length || d.bar.some((a, i) => a !== bar[i]));
}

// ------------------------------------------------------------------ cosmetic look (what other players see)

/**
 * Compact string for what a unit wears: one character per slot in `SLOT_IDS` order, the item's index within its slot
 * in base 36, or '-' for nothing. Carried in snapshots so everyone sees everyone's cosmetics.
 */
export function gearLook(gear: Record<string, string> | undefined): string {
  let out = '';
  for (const slot of SLOT_IDS) {
    const item = gear?.[slot] ? itemById(gear[slot]) : undefined;
    const at = item && item.slot === slot ? itemsForSlot(slot).indexOf(item) : -1;
    out += at >= 0 ? at.toString(36) : '-';
  }
  return out;
}

/** Decodes `gearLook` into slot -> item. Tolerates anything: junk gives no piece for that slot. */
export function parseLook(look: string | undefined | null): Record<string, CosmeticItem> {
  const out: Record<string, CosmeticItem> = {};
  SLOT_IDS.forEach((slot, i) => {
    const c = look?.[i] ?? '-';
    const at = c === '-' ? -1 : parseInt(c, 36);
    const item = Number.isFinite(at) && at >= 0 ? itemsForSlot(slot)[at] : undefined;
    if (item) out[slot] = item;
  });
  return out;
}
