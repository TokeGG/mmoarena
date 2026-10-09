import { ABILITIES, AURAS, CLASSES, COSMETICS, SPECS, TALENTS } from './data';
import type { AbilityMod, AutoDef, Build, ClassId, CosmeticItem, Mods, ModsInput, TalentDef } from './types';

/** Everything a build changes in combat is expressed as `Mods`; this file is the only place that turns picks into numbers. */

export const NEUTRAL_MODS: Mods = Object.freeze({
  damageDone: 1, healingDone: 1, healingTaken: 1, damageTaken: 1, maxHealth: 1, castTime: 1, gcd: 1, regen: 1, moveSpeed: 1, autoSpeed: 1, maxCp: 0, cpPower: 1, rage: 1, lifesteal: 0, ability: {}, auraDuration: {}, auraExtend: {},
}) as Mods;

export function newMods(): Mods {
  return { damageDone: 1, healingDone: 1, healingTaken: 1, damageTaken: 1, maxHealth: 1, castTime: 1, gcd: 1, regen: 1, moveSpeed: 1, autoSpeed: 1, maxCp: 0, cpPower: 1, rage: 1, lifesteal: 0, ability: {}, auraDuration: {}, auraExtend: {} };
}

const SCALARS = ['damageDone', 'healingDone', 'healingTaken', 'damageTaken', 'maxHealth', 'castTime', 'gcd', 'regen', 'moveSpeed', 'autoSpeed', 'cpPower', 'rage'] as const;

/** Multiplies `into` by `add` (mutates and returns `into`). */
export function applyMods(into: Mods, add: ModsInput | undefined): Mods {
  if (!add) return into;
  if (add.maxCp) into.maxCp += add.maxCp;
  if (add.lifesteal) into.lifesteal += add.lifesteal;
  if (add.auraExtend) for (const [id, v] of Object.entries(add.auraExtend)) into.auraExtend[id] = (into.auraExtend[id] ?? 0) + v;
  for (const k of SCALARS) if (add[k] !== undefined) into[k] *= add[k]!;
  if (add.ability) {
    for (const [id, m] of Object.entries(add.ability)) {
      const cur: AbilityMod = (into.ability[id] ??= {});
      for (const key of ['damage', 'heal', 'cooldown', 'castTime', 'cost'] as const) if (m[key] !== undefined) cur[key] = (cur[key] ?? 1) * m[key]!;
      if (m.stored !== undefined) cur.stored = (cur.stored ?? 0) + m.stored;
      if (m.cpChance !== undefined) cur.cpChance = Math.min(1, (cur.cpChance ?? 0) + m.cpChance);
      if (m.shadowProc !== undefined) cur.shadowProc = Math.min(1, (cur.shadowProc ?? 0) + m.shadowProc);
      if (m.extra) cur.extra = [...(cur.extra ?? []), ...m.extra];
      if (m.range !== undefined) cur.range = (cur.range ?? 0) + m.range;
      if (m.charges !== undefined) cur.charges = (cur.charges ?? 0) + m.charges;
      if (m.after) cur.after = [...(cur.after ?? []), ...m.after];
      if (m.free) cur.free = true;
      if (m.castDuring) cur.castDuring = true;
      if (m.allyOk) cur.allyOk = true;
      if (m.before) cur.before = [...(cur.before ?? []), ...m.before];
      if (m.landing) cur.landing = [...(cur.landing ?? []), ...m.landing];
      if (m.gain !== undefined) cur.gain = (cur.gain ?? 1) * m.gain;
      if (m.ticks !== undefined) cur.ticks = m.ticks;
      if (m.swapAura) cur.swapAura = { ...(cur.swapAura ?? {}), ...m.swapAura };
      if (m.shieldPct !== undefined) cur.shieldPct = (cur.shieldPct ?? 0) + m.shieldPct;
      if (m.echo !== undefined) cur.echo = (cur.echo ?? 0) + m.echo;
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

/** Can this player wear the item? Owner-only items need `isOwner`; unlockable ones need enough matches played (the owner skips that). */
export function canWear(item: CosmeticItem, isOwner = false, matches = Infinity): boolean {
  if (item.owner) return isOwner;
  return isOwner || !item.unlock || matches >= item.unlock;
}

/**
 * Old saves and recordings: wings used to be back items (and one was a head item), and the shoulders slot is gone. Moves the wings to the wings
 * slot (an explicit wings pick wins) and drops what no longer exists or sits in the wrong slot. Says nothing about who may wear what (see `cleanGear`).
 */
export function currentGear(gear: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [at, id] of Object.entries(gear ?? {})) {
    const item = itemById(id);
    const slot = item?.slot === 'wings' && (at === 'back' || at === 'head') ? 'wings' : at;
    if (item && item.slot === slot && !(slot === 'wings' && at !== 'wings' && out.wings)) out[slot] = id;
  }
  return out;
}

/** Keep only cosmetics that exist, sit in the right slot and are allowed (see `canWear`); wings saved in an old slot move to the wings slot. */
export function cleanGear(gear: Record<string, string> | undefined, isOwner = false, matches = Infinity): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [slot, id] of Object.entries(currentGear(gear))) if (canWear(itemById(id)!, isOwner, matches)) out[slot] = id;
  return out;
}

export const specOf = (classId: ClassId, specId: string) => SPECS[classId]?.find((s) => s.id === specId);
export const defaultSpec = (classId: ClassId) => SPECS[classId][0];
/** The five talent tiers of one spec (talents differ per spec). */
export const talentsFor = (classId: ClassId, specId: string | undefined): TalentDef[][] => TALENTS[classId]?.[specId ?? ''] ?? [];

/**
 * The talents another spec shows before you pick it: only the picks you can see now that its tree also has (the shared
 * tiers). A tier you cannot see from here is never counted, so its card never shows a buff you have not picked.
 */
export function previewTalents(classId: ClassId, current: readonly string[], specId: string): string[] {
  return talentsFor(classId, specId).map((tier, i) => (current[i] && tier.some((t) => t.id === current[i]) ? current[i] : ''));
}

/**
 * The talents a spec gets when you switch to it: the shared tiers keep what you picked now (what its card showed), the
 * tiers of its own come back as you last left them on that spec.
 */
export function switchTalents(classId: ClassId, current: readonly string[], specId: string, saved: readonly string[] | null): string[] {
  const now = previewTalents(classId, current, specId);
  return talentsFor(classId, specId).map((tier, i) => {
    // a tier this spec shares keeps the current choice, even when that is "none"
    if (now[i] || sharedTier(classId, i)) return now[i];
    return saved?.[i] && tier.some((t) => t.id === saved[i]) ? saved[i] : '';
  });
}

/** True when every spec of the class has the same talents in this tier (the class tiers, not a spec's own). */
export function sharedTier(classId: ClassId, tier: number): boolean {
  const ids = SPECS[classId].map((s) => talentsFor(classId, s.id)[tier]?.map((t) => t.id).join(',') ?? '');
  return ids.every((x) => x === ids[0]);
}

export const emptyBuild = (classId: ClassId): Build => ({ spec: defaultSpec(classId).id, talents: [], gear: {} });

/** The tier whose pick is the trinket: an extra button next to the action bar. */
export const TRINKET_TIER = 3;

export type BuildCheck = { ok: true } | { ok: false; reason: string };

/** Strict check used by the server for anything a client sends. */
export function validateBuild(classId: ClassId, b: Build, isOwner = false, matches = Infinity): BuildCheck {
  if (!specOf(classId, b.spec)) return { ok: false, reason: 'unknown spec' };
  const tiers = talentsFor(classId, b.spec);
  if (b.talents.length > tiers.length) return { ok: false, reason: 'too many talents' };
  for (let i = 0; i < b.talents.length; i++) {
    if (b.talents[i] === '') continue;
    if (!tiers[i].some((t) => t.id === b.talents[i])) return { ok: false, reason: 'invalid talent' };
  }
  for (const [talent, from] of Object.entries(b.replace ?? {})) {
    const t = tiers.flat().find((x) => x.id === talent);
    if (!t?.swap || ![t.swap.from, ...(t.swap.alt ?? [])].includes(from) || !b.talents.includes(talent)) return { ok: false, reason: 'invalid replacement' };
  }
  for (const [slot, id] of Object.entries(b.gear)) {
    const item = itemById(id);
    if (!SLOT_IDS.includes(slot) || !item || item.slot !== slot) return { ok: false, reason: 'invalid cosmetic' };
    if (item.owner && !isOwner) return { ok: false, reason: `${item.name} is owner only` };
    if (!canWear(item, isOwner, matches)) return { ok: false, reason: `${item.name} unlocks after ${item.unlock} matches` };
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
  // an ability that needs a mark on the target (Deep Freeze needs Fingers of Frost or Shatter) works without it when nothing
  // else on this bar can ever apply that mark: a Fire or Arcane mage who talents into Deep Freeze gets a plain stun
  const bar = barFor(classId, b, CLASSES[classId].bar);
  for (const id of bar) {
    const need = ABILITIES[id]?.requiresTargetAura;
    if (!need) continue;
    const makers = bar.filter((o) => o !== id && ABILITIES[o]?.effects.some((e) => e.type === 'aura' && need.includes(e.aura)));
    if (!makers.length) (m.ability[id] ??= {}).free = true;
  }
  // gear is cosmetic only: it never changes numbers (see gearLook for what it changes)
  return m;
}

/** The skill a swap talent gives up in this build: the player's choice when the talent offers one, else its `from`. */
export function replacedBy(t: TalentDef, b: Build): string {
  const pick = b.replace?.[t.id];
  return t.swap && pick && (pick === t.swap.from || t.swap.alt?.includes(pick)) ? pick : t.swap?.from ?? '';
}

/** The talent swaps picked in this build, in tier order (stealth-only swaps are not here: see `stealthSwapsFor`). */
export function swapsFor(classId: ClassId, b: Build | undefined): { talent: TalentDef; from: string; to: string }[] {
  const spec = b ? specOf(classId, b.spec) : undefined;
  if (!b || !spec) return [];
  const out: { talent: TalentDef; from: string; to: string }[] = [];
  const tiers = talentsFor(classId, b.spec);
  b.talents.forEach((id, i) => {
    const t = tiers[i]?.find((x) => x.id === id);
    if (!t?.swap || t.swap.stealth) return;
    const from = replacedBy(t, b);
    if (spec.bar.includes(from)) out.push({ talent: t, from, to: t.swap.to });
  });
  return out;
}

/** Bar slots that turn into another ability while stealthed, from talents (Sap on Kidney Shot). */
export function stealthSwapsFor(classId: ClassId, b: Build | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const spec = b ? specOf(classId, b.spec) : undefined;
  if (!b || !spec) return out;
  const tiers = talentsFor(classId, b.spec);
  b.talents.forEach((id, i) => {
    const t = tiers[i]?.find((x) => x.id === id);
    if (t?.swap?.stealth && spec.bar.includes(t.swap.from)) out[t.swap.from] = t.swap.to;
  });
  return out;
}

/** The trinket a build carries (the tier 4 pick), or undefined. */
export function trinketFor(classId: ClassId, b: Build | undefined): string | undefined {
  if (!b) return undefined;
  const id = b.talents[TRINKET_TIER];
  return id ? talentsFor(classId, b.spec)[TRINKET_TIER]?.find((t) => t.id === id)?.trinket : undefined;
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
  const m: Mods = { ...base, ability: Object.fromEntries(Object.entries(base.ability).map(([k, v]) => [k, { ...v }])), auraDuration: { ...base.auraDuration }, auraExtend: { ...base.auraExtend } };
  // the same effect from two sources counts once (two Mortal Wounds are not 0.36 healing taken, two Power Infusions do not stack)
  for (const id of new Set(auraIds)) applyMods(m, AURAS[id]?.mods);
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
export function gearLook(gearIn: Record<string, string> | undefined): string {
  const gear = currentGear(gearIn);
  let out = '';
  for (const slot of SLOT_IDS) {
    const item = gear[slot] ? itemById(gear[slot]) : undefined;
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

/** The auto-attack a unit swings with: its spec's weapon when it has one, else the class default (undefined for classes without one). */
export function autoFor(classId: ClassId, specId: string | null | undefined): AutoDef | null | undefined {
  const spec = specId ? SPECS[classId]?.find((x) => x.id === specId) : undefined;
  return spec?.auto ?? CLASSES[classId].auto;
}

/** The weapon id a unit's spec is built around ('dual', 'twohand', 'polearm', 'fire_staff', ...), if any. */
export function weaponFor(classId: ClassId, specId: string | null | undefined): string | undefined {
  return specId ? SPECS[classId]?.find((x) => x.id === specId)?.weapon?.id : undefined;
}
