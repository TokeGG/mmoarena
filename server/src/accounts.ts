import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { DEFAULT_COSMETICS, NAME_RE, isOwnerName, PASSWORD_MAX, PASSWORD_MIN, START_RATING, eloDelta, validateCosmetics } from '@arena/shared';
import type { AccountInfo, Cosmetics, LeaderRow } from '@arena/shared';
import type { Store } from './store';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const SESSION_SECONDS = 30 * 24 * 3600;
const LEADERBOARD_KEY = 'lb:rating';

export interface AccountRecord extends AccountInfo {
  key: string;
  salt: string;
  hash: string;
  createdAt: number;
  /** JSON snapshot of the player's client settings (HUD, keybinds, builds). */
  settings?: string;
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
      return JSON.parse(raw) as AccountRecord;
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
      matches: 0, wins: 0, peak: START_RATING, rating: START_RATING, rated: 0, cosmetics: { ...DEFAULT_COSMETICS },
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
  return { name: a.name, matches: a.matches, wins: a.wins, peak: a.peak, rating: a.rating, rated: a.rated, cosmetics: a.cosmetics, role: isOwnerName(a.name) ? 'owner' : undefined };
}
