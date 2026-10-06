import { GEAR } from './data';
import type { GearItem, ModsInput, StatId } from './types';

/**
 * Loot: random gear that drops after matches. An item is fully described by its id, `L.<rarity>.<slot>.<seed>`: the stat
 * roll, perk and name are derived from the id with a seeded generator, so the server only has to remember ids and the
 * client, server and simulation always agree on what an item is. Loot lives in the signed-in account's inventory; the
 * server refuses a build that equips an id the account does not own.
 *
 * Fairness: loot stats go through the same capped stat bonuses as tier gear (tuning.gearCap), and each perk only counts
 * once however many pieces carry it.
 */

export interface Rarity {
  id: string;
  name: string;
  color: string;
  /** Stat budget at slot weight 1, comparable to gear tier budgets (14-20). */
  budget: number;
  /** How many different stats the roll is spread over. */
  lines: number;
  /** Drop weight. */
  weight: number;
  perkChance: number;
}

export const RARITIES: Rarity[] = [
  { id: 'common', name: 'Common', color: '#9d9d9d', budget: 14, lines: 2, weight: 55, perkChance: 0 },
  { id: 'uncommon', name: 'Uncommon', color: '#1eff00', budget: 16, lines: 2, weight: 28, perkChance: 0 },
  { id: 'rare', name: 'Rare', color: '#2f8cff', budget: 18, lines: 3, weight: 12, perkChance: 0 },
  { id: 'epic', name: 'Epic', color: '#b45cff', budget: 20, lines: 3, weight: 4.2, perkChance: 0.5 },
  { id: 'legendary', name: 'Legendary', color: '#ff8c1a', budget: 22, lines: 4, weight: 0.8, perkChance: 1 },
];
export const rarityOf = (id: string): Rarity | undefined => RARITIES.find((r) => r.id === id);
export const rarityIndex = (id: string): number => RARITIES.findIndex((r) => r.id === id);

export interface LootPerk {
  id: string;
  name: string;
  desc: string;
  /** Lowest rarity it can roll on. */
  from: 'epic' | 'legendary';
  mods: ModsInput;
}

export const PERKS: LootPerk[] = [
  { id: 'fleet', name: 'Fleet', desc: '+3% movement speed', from: 'epic', mods: { moveSpeed: 1.03 } },
  { id: 'enduring', name: 'Enduring', desc: '+12% health and mana regeneration', from: 'epic', mods: { regen: 1.12 } },
  { id: 'windrunner', name: 'Windrunner', desc: '+5% movement speed', from: 'legendary', mods: { moveSpeed: 1.05 } },
  { id: 'stormborn', name: 'Stormborn', desc: '4% faster casting and 3% shorter global cooldown', from: 'legendary', mods: { castTime: 0.96, gcd: 0.97 } },
  { id: 'warded', name: 'Warded', desc: '3% less damage taken and 3% more health', from: 'legendary', mods: { damageTaken: 0.97, maxHealth: 1.03 } },
  { id: 'ruinous', name: 'Ruinous', desc: '+3% damage and healing', from: 'legendary', mods: { damageDone: 1.03, healingDone: 1.03 } },
];
export const perkById = (id: string | undefined): LootPerk | undefined => PERKS.find((p) => p.id === id);

// ---------------------------------------------------------------- deterministic generator

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, a: readonly T[]): T => a[Math.floor(r() * a.length) % a.length];

const NOUNS: Record<string, string[]> = {
  weapon: ['Blade', 'Staff', 'Mace', 'Edge', 'Scepter'],
  head: ['Helm', 'Crown', 'Cowl', 'Visage'],
  chest: ['Chestguard', 'Robes', 'Cuirass', 'Vestments'],
  legs: ['Legguards', 'Greaves', 'Leggings', 'Tassets'],
  trinket: ['Charm', 'Idol', 'Sigil', 'Talisman', 'Relic'],
};
const PREFIX: Record<StatId, string[]> = {
  power: ['Ruthless', 'Savage', 'Searing', 'Merciless'],
  vitality: ['Stalwart', 'Hardy', 'Thriving', 'Ironbound'],
  haste: ['Swift', 'Gale', 'Flickering', 'Hurried'],
  resilience: ['Warded', 'Unyielding', 'Steadfast', 'Aegis'],
};
const EPITHETS = ['of the Phoenix', 'of Embers', 'of the Tide', 'of Ruin', 'of Dawn', 'of the Warden', 'of the Fallen Star', 'of Storms', 'of the Pit'];

const SEED_RE = /^[a-z0-9]{4,8}$/;
const STATS: StatId[] = ['power', 'vitality', 'haste', 'resilience'];

/** Resolve a loot id to its item, or undefined if the id is not well-formed. */
export function lootItem(id: string): GearItem | undefined {
  const parts = id.split('.');
  if (parts.length !== 4 || parts[0] !== 'L') return undefined;
  const [, rarityId, slotId, seed] = parts;
  const rarity = rarityOf(rarityId);
  const slot = GEAR.slots.find((s) => s.id === slotId);
  if (!rarity || !slot || !SEED_RE.test(seed)) return undefined;

  const r = mulberry(hash(id));
  const budget = rarity.budget * slot.weight * (0.92 + r() * 0.16);
  const chosen = [...STATS].sort(() => r() - 0.5).slice(0, rarity.lines);
  const weights = chosen.map(() => 0.5 + r());
  const sum = weights.reduce((a, b) => a + b, 0);
  const stats = { power: 0, vitality: 0, haste: 0, resilience: 0 } as Record<StatId, number>;
  chosen.forEach((s, i) => (stats[s] = Math.max(1, Math.round((budget * weights[i]) / sum))));

  let perk: LootPerk | undefined;
  if (r() < rarity.perkChance) {
    const pool = PERKS.filter((p) => (p.from === 'legendary' ? rarity.id === 'legendary' : rarityIndex(rarity.id) >= rarityIndex('epic')));
    perk = pick(r, pool);
  }
  const top = chosen[weights.indexOf(Math.max(...weights))];
  const base = `${pick(r, PREFIX[top])} ${pick(r, NOUNS[slotId] ?? [slot.noun])}`;
  const name = rarityIndex(rarity.id) >= rarityIndex('rare') ? `${base} ${pick(r, EPITHETS)}` : base;
  return { id, slot: slotId, tier: 'loot', flavor: 'loot', name, stats, rarity: rarity.id, perk: perk?.id };
}

export const isLootId = (id: string): boolean => id.startsWith('L.');

/** Colour of an item's name: its rarity for loot, its tier for set gear. */
export function itemColor(item: GearItem): string {
  if (item.rarity) return rarityOf(item.rarity)?.color ?? '#9d9d9d';
  return GEAR.tiers.find((t) => t.id === item.tier)?.color ?? '#9d9d9d';
}

/** Roll a new loot id. `rand` returns [0,1); the server passes a cryptographic one. */
export function rollLoot(rand: () => number, opts: { minRarity?: string; maxRarity?: string } = {}): string {
  const lo = Math.max(0, rarityIndex(opts.minRarity ?? 'common'));
  const hi = opts.maxRarity ? rarityIndex(opts.maxRarity) : RARITIES.length - 1;
  const pool = RARITIES.slice(lo, hi + 1);
  let x = rand() * pool.reduce((a, r) => a + r.weight, 0);
  let rarity = pool[pool.length - 1];
  for (const r of pool) {
    if ((x -= r.weight) < 0) {
      rarity = r;
      break;
    }
  }
  const slot = GEAR.slots[Math.floor(rand() * GEAR.slots.length)];
  let seed = '';
  for (let i = 0; i < 6; i++) seed += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rand() * 36)];
  return `L.${rarity.id}.${slot.id}.${seed}`;
}

export const MAX_INVENTORY = 60;
