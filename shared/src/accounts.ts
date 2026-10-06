/**
 * Account-level definitions shared by server and client: rank tiers, the Elo update, and unlockable cosmetics
 * (title, emblem, name colour). The server is the only place stats change; the client uses these to display and to
 * grey out what is still locked.
 */

export const START_RATING = 1000;

export interface RankTier {
  id: string;
  name: string;
  min: number;
  color: string;
  icon: string;
}

export const RANKS: RankTier[] = [
  { id: 'bronze', name: 'Bronze', min: 0, color: '#c98a56', icon: '🥉' },
  { id: 'silver', name: 'Silver', min: 1100, color: '#c9d2dc', icon: '🥈' },
  { id: 'gold', name: 'Gold', min: 1300, color: '#f1c40f', icon: '🥇' },
  { id: 'platinum', name: 'Platinum', min: 1500, color: '#6fe0d0', icon: '💠' },
  { id: 'diamond', name: 'Diamond', min: 1700, color: '#6fb6ff', icon: '💎' },
  { id: 'gladiator', name: 'Gladiator', min: 1900, color: '#ff5a4d', icon: '🏆' },
];

export function rankOf(rating: number): RankTier {
  let r = RANKS[0];
  for (const t of RANKS) if (rating >= t.min) r = t;
  return r;
}

/** Progress to the next tier: the tier, the next one (null at the top) and 0..1 through the current band. */
export function rankProgress(rating: number): { tier: RankTier; next: RankTier | null; frac: number } {
  const tier = rankOf(rating);
  const next = RANKS[RANKS.indexOf(tier) + 1] ?? null;
  return { tier, next, frac: next ? Math.min(1, Math.max(0, (rating - tier.min) / (next.min - tier.min))) : 1 };
}

/** Elo with a larger K while a player is new, so placement is quick. Teams are compared by average rating. */
export function eloDelta(rating: number, opponentAvg: number, score: 0 | 0.5 | 1, ratedGames: number): number {
  const expected = 1 / (1 + 10 ** ((opponentAvg - rating) / 400));
  const k = ratedGames < 5 ? 48 : ratedGames < 20 ? 32 : 24;
  return Math.round(k * (score - expected));
}

// ---------------------------------------------------------------- cosmetics

export interface Stats {
  matches: number;
  wins: number;
  /** Highest rating ever reached. */
  peak: number;
}

/** Names that carry the owner role (lowercase). Owner-only cosmetics can only be used by these accounts. */
export const OWNER_NAMES = ['toke'];
export const isOwnerName = (name: string): boolean => OWNER_NAMES.includes(name.toLowerCase());

export type Unlock = { kind: 'free' } | { kind: 'owner' } | { kind: 'matches' | 'wins' | 'peak'; n: number };
export interface CosmeticDef {
  id: string;
  name: string;
  unlock: Unlock;
  /** Emblem glyph or colour hex. */
  value?: string;
}

const owner: Unlock = { kind: 'owner' };

const free: Unlock = { kind: 'free' };
export const TITLES: CosmeticDef[] = [
  { id: '', name: 'No title', unlock: free },
  { id: 'initiate', name: 'Initiate', unlock: free },
  { id: 'veteran', name: 'Veteran', unlock: { kind: 'matches', n: 5 } },
  { id: 'challenger', name: 'Challenger', unlock: { kind: 'wins', n: 5 } },
  { id: 'relentless', name: 'the Relentless', unlock: { kind: 'matches', n: 30 } },
  { id: 'duelist', name: 'Duelist', unlock: { kind: 'peak', n: 1300 } },
  { id: 'warlord', name: 'Warlord', unlock: { kind: 'wins', n: 25 } },
  { id: 'gladiator', name: 'Gladiator', unlock: { kind: 'peak', n: 1900 } },
  // owner only
  { id: 'founder', name: 'Founder', unlock: owner },
  { id: 'architect', name: 'Architect of the Arena', unlock: owner },
  { id: 'archon', name: 'Grand Archon', unlock: owner },
  { id: 'unbound', name: 'the Unbound', unlock: owner },
  { id: 'sovereign', name: 'Sovereign of Sparks', unlock: owner },
];

export const EMBLEMS: CosmeticDef[] = [
  { id: 'swords', name: 'Crossed swords', value: '⚔️', unlock: free },
  { id: 'shield', name: 'Shield', value: '🛡️', unlock: free },
  { id: 'orb', name: 'Arcane orb', value: '🔮', unlock: free },
  { id: 'dagger', name: 'Dagger', value: '🗡️', unlock: free },
  { id: 'flame', name: 'Flame', value: '🔥', unlock: { kind: 'wins', n: 3 } },
  { id: 'frost', name: 'Frost', value: '❄️', unlock: { kind: 'wins', n: 3 } },
  { id: 'bolt', name: 'Lightning', value: '⚡', unlock: { kind: 'matches', n: 10 } },
  { id: 'skull', name: 'Skull', value: '💀', unlock: { kind: 'wins', n: 10 } },
  { id: 'eagle', name: 'Eagle', value: '🦅', unlock: { kind: 'matches', n: 20 } },
  { id: 'dragon', name: 'Dragon', value: '🐉', unlock: { kind: 'peak', n: 1500 } },
  { id: 'crown', name: 'Crown', value: '👑', unlock: { kind: 'peak', n: 1700 } },
  { id: 'trophy', name: 'Trophy', value: '🏆', unlock: { kind: 'peak', n: 1900 } },
  // owner only
  { id: 'trident', name: 'Sovereign trident', value: '🔱', unlock: owner },
  { id: 'comet', name: 'Comet', value: '☄️', unlock: owner },
  { id: 'cosmos', name: 'Cosmos', value: '🌌', unlock: owner },
  { id: 'volcano', name: 'Caldera', value: '🌋', unlock: owner },
];

export const NAME_COLORS: CosmeticDef[] = [
  { id: 'white', name: 'Silver', value: '#e6e9ef', unlock: free },
  { id: 'gold', name: 'Gold', value: '#f1c40f', unlock: { kind: 'wins', n: 3 } },
  { id: 'cyan', name: 'Frost', value: '#6fe0ff', unlock: { kind: 'matches', n: 8 } },
  { id: 'lime', name: 'Venom', value: '#9dff5a', unlock: { kind: 'matches', n: 15 } },
  { id: 'orange', name: 'Ember', value: '#ff9a3c', unlock: { kind: 'wins', n: 8 } },
  { id: 'violet', name: 'Void', value: '#c58bff', unlock: { kind: 'peak', n: 1300 } },
  { id: 'rose', name: 'Rose', value: '#ff7aa8', unlock: { kind: 'peak', n: 1500 } },
  { id: 'crimson', name: 'Crimson', value: '#ff4d4d', unlock: { kind: 'peak', n: 1700 } },
  // owner only (drawn with a glow)
  { id: 'neon', name: 'Neon', value: '#ff2bd6', unlock: owner },
  { id: 'aurora', name: 'Aurora', value: '#2bffd0', unlock: owner },
  { id: 'sunfire', name: 'Sunfire', value: '#ffd23f', unlock: owner },
];

export interface Cosmetics {
  title: string;
  emblem: string;
  color: string;
}
export const DEFAULT_COSMETICS: Cosmetics = { title: '', emblem: 'swords', color: 'white' };

export function isUnlocked(def: CosmeticDef, s: Stats & { name?: string }): boolean {
  const u = def.unlock;
  if (u.kind === 'free') return true;
  if (u.kind === 'owner') return !!s.name && isOwnerName(s.name);
  return s[u.kind] >= u.n;
}

export function unlockText(def: CosmeticDef): string {
  const u = def.unlock;
  if (u.kind === 'free') return 'Unlocked';
  if (u.kind === 'owner') return 'Founder only';
  return u.kind === 'matches' ? `Play ${u.n} matches` : u.kind === 'wins' ? `Win ${u.n} matches` : `Reach ${u.n} rating`;
}

/** Returns the cleaned choice, or null if any pick is unknown or still locked. */
export function validateCosmetics(c: Cosmetics, s: Stats & { name?: string }): Cosmetics | null {
  const t = TITLES.find((x) => x.id === c.title);
  const e = EMBLEMS.find((x) => x.id === c.emblem);
  const k = NAME_COLORS.find((x) => x.id === c.color);
  if (!t || !e || !k) return null;
  if (!isUnlocked(t, s) || !isUnlocked(e, s) || !isUnlocked(k, s)) return null;
  return { title: t.id, emblem: e.id, color: k.id };
}

/** What other players see: the glyph, the title text and the colour hex, resolved from ids. */
export function resolveCosmetics(c: Cosmetics): { emblem: string; title: string; color: string; glow: boolean } {
  return {
    glow: NAME_COLORS.find((x) => x.id === c.color)?.unlock.kind === 'owner',
    emblem: EMBLEMS.find((x) => x.id === c.emblem)?.value ?? '⚔️',
    title: TITLES.find((x) => x.id === c.title)?.name ?? '',
    color: NAME_COLORS.find((x) => x.id === c.color)?.value ?? '#e6e9ef',
  };
}

// ---------------------------------------------------------------- public account shapes

/** What a player may see of an account (never the password hash). */
export interface AccountInfo extends Stats {
  name: string;
  rating: number;
  /** Rated games played (drives K-factor and placement). */
  rated: number;
  cosmetics: Cosmetics;
  /** 'owner' for the founder account. */
  role?: 'owner';
}

export interface LeaderRow {
  name: string;
  rating: number;
  wins: number;
  matches: number;
  cosmetics: Cosmetics;
  role?: 'owner';
}

export interface RosterEntry {
  unitId: number;
  emblem: string;
  title: string;
  color: string;
  glow?: boolean;
  rating: number;
}

export const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 64;
