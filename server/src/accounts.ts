import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { DEFAULT_COSMETICS, MAX_INVENTORY, NAME_RE, isOwnerName, lootItem, rarityIndex, rollLoot, PASSWORD_MAX, PASSWORD_MIN, START_RATING, eloDelta, validateCosmetics } from '@arena/shared';
import type { AccountInfo, Cosmetics, LeaderRow } from '@arena/shared';
import type { Store } from './store';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const SESSION_SECONDS = 30 * 24 * 3600;
const LEADERBOARD_KEY = 'lb:rating';
/** A ranked drop is guaranteed to be epic or better after this many without one. */
export const PITY_EPIC = 20;
const cryptoRand = () => crypto.randomInt(0, 2 ** 30) / 2 ** 30;

export interface AccountRecord extends AccountInfo {
  key: string;
  salt: string;
  hash: string;
  createdAt: number;
  /** JSON snapshot of the player's client settings (HUD, keybinds, builds). */
  settings?: string;
  /** Drops since the last epic or better (bad-luck protection). */
  pity?: number;
}

export type AuthResult = { ok: true; account: AccountRecord; token: string } | { ok: false; reason: string };

/** Simple in-memory limiter: at most `max` events per `windowMs` per key. */
class Limiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  allow(key: string, record = true): boolean {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    if (record) arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
  clear(key: string) {
    this.hits.delete(key);
  }
}

export class Accounts {
  private loginFails = new Limiter(6, 10 * 60 * 1000);
  private registers = new Limiter(5, 60 * 60 * 1000);

  /** If `ownerCode` is set, owner names can only be registered with that code. */
  constructor(private store: Store, private ownerCode?: string) {}

  get storeKind(): string {
    return this.store.kind;
  }

  private async hash(password: string, salt: Buffer): Promise<string> {
    return (await scrypt(password, salt, 32)).toString('base64');
  }

  private newToken(): string {
    return crypto.randomBytes(24).toString('base64url');
  }

  async get(name: string): Promise<AccountRecord | null> {
    const raw = await this.store.get(`acct:${name.toLowerCase()}`);
    if (!raw) return null;
    try {
      const a = JSON.parse(raw) as AccountRecord;
      a.inventory ??= [];
      return a;
    } catch {
      return null;
    }
  }

  async save(a: AccountRecord): Promise<void> {
    await this.store.set(`acct:${a.key}`, JSON.stringify(a));
    await this.store.zadd(LEADERBOARD_KEY, a.rating, a.name);
  }

  async register(name: string, password: string, ip: string, code?: string): Promise<AuthResult> {
    if (!NAME_RE.test(name)) return { ok: false, reason: 'Names are 3-16 letters, numbers or underscores.' };
    if (isOwnerName(name) && this.ownerCode && code !== this.ownerCode) return { ok: false, reason: 'That name is reserved. Enter the owner code to register it.' };
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return { ok: false, reason: `Passwords are ${PASSWORD_MIN}-${PASSWORD_MAX} characters.` };
    if (!this.registers.allow(ip)) return { ok: false, reason: 'Too many new accounts from your network. Try again later.' };
    const salt = crypto.randomBytes(16);
    const record: AccountRecord = {
      key: name.toLowerCase(), name, salt: salt.toString('base64'), hash: await this.hash(password, salt), createdAt: Date.now(),
      matches: 0, wins: 0, peak: START_RATING, rating: START_RATING, rated: 0, cosmetics: { ...DEFAULT_COSMETICS }, inventory: [],
    };
    if (!(await this.store.setNx(`acct:${record.key}`, JSON.stringify(record)))) return { ok: false, reason: 'That name is taken.' };
    await this.store.zadd(LEADERBOARD_KEY, record.rating, record.name);
    return { ok: true, account: record, token: await this.session(record.key) };
  }

  async login(name: string, password: string, ip: string): Promise<AuthResult> {
    const limitKey = `${ip}|${name.toLowerCase()}`;
    if (!this.loginFails.allow(limitKey, false)) return { ok: false, reason: 'Too many failed attempts. Wait a few minutes.' };
    const a = await this.get(name);
    // hash even for unknown names so timing does not reveal which accounts exist
    const salt = a ? Buffer.from(a.salt, 'base64') : crypto.randomBytes(16);
    const got = Buffer.from(await this.hash(password, salt));
    const want = Buffer.from(a?.hash ?? 'x'.repeat(got.length));
    const good = !!a && got.length === want.length && crypto.timingSafeEqual(got, want);
    if (!good) {
      this.loginFails.allow(limitKey);
      return { ok: false, reason: 'Wrong name or password.' };
    }
    this.loginFails.clear(limitKey);
    return { ok: true, account: a!, token: await this.session(a!.key) };
  }

  private async session(key: string): Promise<string> {
    const token = this.newToken();
    await this.store.set(`sess:${token}`, key, SESSION_SECONDS);
    return token;
  }

  async resume(token: string): Promise<AuthResult> {
    const key = await this.store.get(`sess:${token}`);
    const a = key ? await this.get(key) : null;
    if (!a) return { ok: false, reason: 'Session expired. Please sign in again.' };
    return { ok: true, account: a, token };
  }

  async logout(token: string): Promise<void> {
    await this.store.del(`sess:${token}`);
  }

  async saveSettings(a: AccountRecord, data: string): Promise<void> {
    const fresh = (await this.get(a.name)) ?? a;
    fresh.settings = data;
    await this.save(fresh);
    a.settings = data;
  }

  /**
   * Roll the loot for a finished, counted match. Ranked (queue) matches always drop one item and a second for a win, with
   * bad-luck protection towards epics. Practice matches against bots drop at most one item, never above Rare, half the time.
   * A full inventory pushes out its lowest-rarity, oldest item (never one that just dropped).
   */
  async grantLoot(name: string, kind: 'ranked' | 'practice', won: boolean, rand: () => number = cryptoRand): Promise<{ account: AccountRecord; drops: string[]; discarded: string[] } | null> {
    const a = await this.get(name);
    if (!a) return null;
    const count = kind === 'ranked' ? 1 + (won ? 1 : 0) : rand() < 0.5 ? 1 : 0;
    const drops: string[] = [];
    for (let i = 0; i < count; i++) {
      const guaranteed = kind === 'ranked' && (a.pity ?? 0) >= PITY_EPIC - 1;
      let id = rollLoot(rand, { minRarity: guaranteed ? 'epic' : undefined, maxRarity: kind === 'practice' ? 'rare' : undefined });
      while (a.inventory.includes(id) || drops.includes(id)) id = rollLoot(rand, { minRarity: guaranteed ? 'epic' : undefined, maxRarity: kind === 'practice' ? 'rare' : undefined });
      drops.push(id);
      if (kind === 'ranked') a.pity = rarityIndex(lootItem(id)!.rarity!) >= rarityIndex('epic') ? 0 : (a.pity ?? 0) + 1;
    }
    a.inventory.push(...drops);
    const discarded: string[] = [];
    while (a.inventory.length > MAX_INVENTORY) {
      const candidates = a.inventory.filter((id) => !drops.includes(id));
      const pool = candidates.length ? candidates : a.inventory;
      const worst = pool.reduce((w, id) => (rarityIndex(lootItem(id)!.rarity!) < rarityIndex(lootItem(w)!.rarity!) ? id : w));
      a.inventory.splice(a.inventory.indexOf(worst), 1);
      discarded.push(worst);
    }
    await this.save(a);
    return { account: a, drops, discarded };
  }

  async discard(a: AccountRecord, id: string): Promise<AccountRecord | null> {
    const fresh = (await this.get(a.name)) ?? a;
    const i = fresh.inventory.indexOf(id);
    if (i < 0) return null;
    fresh.inventory.splice(i, 1);
    await this.save(fresh);
    return fresh;
  }

  async customize(a: AccountRecord, want: Cosmetics): Promise<AccountRecord | null> {
    const ok = validateCosmetics(want, a);
    if (!ok) return null;
    const fresh = (await this.get(a.name)) ?? a;
    fresh.cosmetics = ok;
    await this.save(fresh);
    return fresh;
  }

  /**
   * Record a finished match. Always counts towards matches/wins (which unlock gear and cosmetics); rating only moves
   * when `rated` is set, using the average rating of the two teams.
   */
  async recordMatch(name: string, r: { won: boolean; draw?: boolean; rated: boolean; opponentAvg: number }): Promise<AccountRecord | null> {
    const a = await this.get(name);
    if (!a) return null;
    a.matches++;
    if (r.won) a.wins++;
    if (r.rated) {
      a.rating = Math.max(0, a.rating + eloDelta(a.rating, r.opponentAvg, r.draw ? 0.5 : r.won ? 1 : 0, a.rated));
      a.rated++;
      a.peak = Math.max(a.peak, a.rating);
    }
    await this.save(a);
    return a;
  }

  /** A rated leaver loses rating (and a match) immediately. */
  async recordForfeit(name: string, opponentAvg: number): Promise<AccountRecord | null> {
    return this.recordMatch(name, { won: false, rated: true, opponentAvg });
  }

  async leaderboard(count = 20): Promise<LeaderRow[]> {
    const top = await this.store.ztop(LEADERBOARD_KEY, count);
    const rows: LeaderRow[] = [];
    for (const { member } of top) {
      const a = await this.get(member);
      if (a) rows.push({ name: a.name, rating: a.rating, wins: a.wins, matches: a.matches, cosmetics: a.cosmetics, role: isOwnerName(a.name) ? 'owner' : undefined });
    }
    return rows;
  }
}

/** The account a player may see: everything except the credentials. */
export function publicInfo(a: AccountRecord): AccountInfo {
  return { name: a.name, matches: a.matches, wins: a.wins, peak: a.peak, rating: a.rating, rated: a.rated, cosmetics: a.cosmetics, role: isOwnerName(a.name) ? 'owner' : undefined, inventory: a.inventory };
}
