import { AURAS, GEAR, SPECS, TALENTS, TUNING } from './data';
import { lootItem, perkById, rarityOf } from './loot';
import type { AbilityMod, Build, ClassId, GearItem, Mods, ModsInput, StatId, TalentDef } from './types';

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
export const itemById = (id: string): GearItem | undefined => ITEM_BY_ID.get(id) ?? lootItem(id);
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

/** Legacy stat table. Gear is cosmetic now, so nothing in combat reads this; kept for item data and tests. */
export function statBonuses(stats: Record<StatId, number>): Record<StatId, number> {
  const cap = (TUNING.gearCap - 1) * 100;
  const out = {} as Record<StatId, number>;
  for (const s of Object.keys(stats) as StatId[]) out[s] = Math.min(cap, stats[s] * GEAR.stats[s].ratePct);
  return out;
}

export function gearMods(gear: Record<string, string> | undefined): ModsInput {
  const b = statBonuses(gearStats(gear));
  const out: ModsInput = {
    damageDone: 1 + b.power / 100,
    healingDone: 1 + b.power / 100,
    maxHealth: 1 + b.vitality / 100,
    castTime: 1 - b.haste / 100,
    gcd: 1 - b.haste / 100,
    damageTaken: 1 - b.resilience / 100,
  };
  // loot perks: each distinct perk counts once, however many equipped pieces carry it
  const seen = new Set<string>();
  for (const slot of SLOT_IDS) {
    const item = gear?.[slot] ? itemById(gear[slot]) : undefined;
    const perk = item && item.slot === slot ? perkById(item.perk) : undefined;
    if (!perk || seen.has(perk.id)) continue;
    seen.add(perk.id);
    for (const [k, v] of Object.entries(perk.mods) as [keyof ModsInput, number][]) {
      if (typeof v === 'number') (out as Record<string, number>)[k] = ((out as Record<string, number>)[k] ?? 1) * v;
    }
  }
  return out;
}

/** How well an item suits a flavor: its stats weighted by the flavor, plus a little for a perk. */
export function itemScore(item: GearItem, flavor: string): number {
  const w = GEAR.flavors.find((f) => f.id === flavor)?.weights ?? {};
  let score = 0;
  for (const s of Object.keys(item.stats) as StatId[]) score += item.stats[s] * (w[s] ?? 0);
  return score + (item.perk ? 1.5 : 0);
}

/**
 * Best unlocked item per slot for the given flavor (used by "auto equip"). Pass the account's loot ids to consider
 * them too; set gear is chosen by tier, and loot replaces it only when it scores higher for the flavor.
 */
export function bestGear(flavor: string, matchesPlayed: number, ownedLoot: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const loot = ownedLoot.map((id) => lootItem(id)).filter((i): i is GearItem => !!i);
  for (const slot of SLOT_IDS) {
    let pick = itemsForSlot(slot)
      .filter((i) => i.flavor === flavor && tierUnlocked(i.tier, matchesPlayed))
      .sort((a, b) => (tierOf(b.tier)!.budget - tierOf(a.tier)!.budget))[0];
    for (const l of loot) if (l.slot === slot && (!pick || itemScore(l, flavor) > itemScore(pick, flavor))) pick = l;
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
export function validateBuild(classId: ClassId, b: Build, matchesPlayed: number, ownedLoot?: readonly string[] | ReadonlySet<string>): BuildCheck {
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
    if (item.rarity) {
      const owns = ownedLoot && (Array.isArray(ownedLoot) ? ownedLoot.includes(id) : (ownedLoot as ReadonlySet<string>).has(id));
      if (!owns) return { ok: false, reason: `${item.name} is not in your inventory` };
    } else if (!tierUnlocked(item.tier, matchesPlayed)) return { ok: false, reason: `${item.name} is locked` };
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
  // gear is cosmetic only: it never changes numbers (see gearLook for what it changes)
  return m;
}

/** The talent swap (if any) that applies to this spec, i.e. one whose `replaces` entry is on the spec's bar. */
export function swapsFor(classId: ClassId, b: Build | undefined): { talent: TalentDef; from: string; to: string }[] {
  const spec = b ? specOf(classId, b.spec) : undefined;
  if (!b || !spec) return [];
  const out: { talent: TalentDef; from: string; to: string }[] = [];
  const tiers = TALENTS[classId] ?? [];
  b.talents.forEach((id, i) => {
    const t = tiers[i]?.find((x) => x.id === id);
    const from = t?.swap?.replaces[spec.id];
    if (t?.swap && from && spec.bar.includes(from)) out.push({ talent: t, from, to: t.swap.to });
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

// ------------------------------------------------------------------ gear look (what other players see)

export interface LookPiece {
  /** 0 = nothing equipped, 1-4 = tier gear (Initiate..Gladiator), 1-5 = loot rarity (Common..Legendary). */
  rank: number;
  flavor: string;
  /** Tier or rarity colour as a CSS hex string. */
  color: string;
}
const LOOK_RARITY = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const LOOK_FLAVOR: Record<string, string> = { fury: 'f', bulwark: 'b', tempo: 't', balance: 'p' };
const LOOK_FLAVOR_BACK: Record<string, string> = { f: 'fury', b: 'bulwark', t: 'tempo', p: 'balance' };

/**
 * Compact string for the gear a unit wears, two characters per slot in `SLOT_IDS` order: a rank digit (tier 1-4, loot
 * 'a'-'e' for Common..Legendary) and a flavor letter. '--' = empty slot. Cosmetic only, carried in snapshots.
 */
export function gearLook(gear: Record<string, string> | undefined): string {
  let out = '';
  for (const slot of SLOT_IDS) {
    const item = gear?.[slot] ? itemById(gear[slot]) : undefined;
    if (!item || item.slot !== slot) {
      out += '--';
      continue;
    }
    const rank = item.rarity ? 'abcde'[Math.max(0, LOOK_RARITY.indexOf(item.rarity))] : String(Math.max(1, GEAR.tiers.findIndex((t) => t.id === item.tier) + 1));
    out += rank + (LOOK_FLAVOR[item.flavor] ?? 'p');
  }
  return out;
}

/** Decodes `gearLook`. Tolerates anything: junk gives empty pieces. */
export function parseLook(look: string | undefined | null): Record<string, LookPiece> {
  const out: Record<string, LookPiece> = {};
  SLOT_IDS.forEach((slot, i) => {
    const r = look?.[i * 2] ?? '-';
    const f = LOOK_FLAVOR_BACK[look?.[i * 2 + 1] ?? ''] ?? 'balance';
    let rank = 0;
    let color = '#9d9d9d';
    if (r >= '1' && r <= '9') {
      rank = Math.min(GEAR.tiers.length, Number(r));
      color = GEAR.tiers[rank - 1]?.color ?? color;
    } else if (r >= 'a' && r <= 'e') {
      rank = r.charCodeAt(0) - 96;
      color = rarityOf(LOOK_RARITY[rank - 1])?.color ?? color;
    }
    out[slot] = { rank, flavor: f, color };
  });
  return out;
}
