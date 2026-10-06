import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { ABILITY_GRANTS, DEFAULT_COSMETICS, EMBLEMS, MAX_INVENTORY, NAME_COLORS, NAME_RE, TITLES, cleanCustom, isOwnerName, lootItem, rarityIndex, rollLoot, PASSWORD_MAX, PASSWORD_MIN, START_RATING, eloDelta, validateCosmetics } from '@arena/shared';
import type { AccountInfo, AdminRow, CustomStyle, Cosmetics, LeaderRow } from '@arena/shared';
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
  /** Bumped on password reset; sessions made before it stop working. */
  epoch?: number;
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
  private ownerFails = new Limiter(5, 10 * 60 * 1000);
  private registers = new Limiter(5, 60 * 60 * 1000);

  /** If `ownerCode` is set, owner names can only be registered with that code. */
  constructor(private store: Store, private ownerCode?: string) {}

  get storeKind(): string {
    return this.store.kind;
  }

  /** False when accounts live only in memory and vanish on every restart or redeploy. */
  get persistent(): boolean {
    return this.store.kind !== 'memory';
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
      a.grants ??= [];
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
      matches: 0, wins: 0, peak: START_RATING, rating: START_RATING, rated: 0, cosmetics: { ...DEFAULT_COSMETICS }, inventory: [], grants: [],
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
    const a = await this.get(key);
    await this.store.set(`sess:${token}`, `${key}:${a?.epoch ?? 0}`, SESSION_SECONDS);
    return token;
  }

  async resume(token: string): Promise<AuthResult> {
    const raw = await this.store.get(`sess:${token}`);
    const [key, ep] = raw ? [raw.slice(0, raw.lastIndexOf(':') < 0 ? raw.length : raw.lastIndexOf(':')), raw.includes(':') ? Number(raw.slice(raw.lastIndexOf(':') + 1)) : 0] : ['', 0];
    const a = key ? await this.get(key) : null;
    if (!a || (a.epoch ?? 0) !== ep) return { ok: false, reason: 'Session expired. Please sign in again.' };
    return { ok: true, account: a, token };
  }

  async logout(token: string): Promise<void> {
    await this.store.del(`sess:${token}`);
    await this.store.del(`own:${token}`);
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

  async customize(a: AccountRecord, want: Cosmetics, ownerOk = false): Promise<AccountRecord | null> {
    const fresh = (await this.get(a.name)) ?? a;
    const ok = validateCosmetics(want, fresh, fresh.cosmetics, ownerOk);
    if (!ok) return null;
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

  // ------------------------------------------------------------------ owner powers

  /** Does this session hold owner powers? Needs the owner name AND the owner code to have been entered for this session. */
  async isOwnerSession(token: string | undefined, a: AccountRecord | undefined): Promise<boolean> {
    if (!token || !a || !this.ownerCode || !isOwnerName(a.name)) return false;
    return (await this.store.get(`own:${token}`)) === '1';
  }

  /** Enter the owner code to switch owner powers on for this session (and, via the token, later resumes). */
  async ownerUnlock(token: string | undefined, a: AccountRecord | undefined, code: string, ip: string): Promise<{ ok: boolean; reason?: string }> {
    if (!token || !a) return { ok: false, reason: 'Sign in first.' };
    if (!isOwnerName(a.name)) return { ok: false, reason: 'Only the founder account can do that.' };
    if (!this.ownerCode) return { ok: false, reason: 'Owner tools are off: set ARENA_OWNER_CODE on the server first.' };
    const limitKey = `own|${ip}`;
    if (!this.ownerFails.allow(limitKey, false)) return { ok: false, reason: 'Too many wrong codes. Wait a few minutes.' };
    const got = Buffer.from(code);
    const want = Buffer.from(this.ownerCode);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      this.ownerFails.allow(limitKey);
      return { ok: false, reason: 'Wrong owner code.' };
    }
    await this.store.set(`own:${token}`, '1', SESSION_SECONDS);
    return { ok: true };
  }

  /** Every account, highest rating first, for the owner's panel. */
  async adminList(online: Set<string>): Promise<AdminRow[]> {
    const top = await this.store.ztop(LEADERBOARD_KEY, 500);
    const rows: AdminRow[] = [];
    for (const { member } of top) {
      const a = await this.get(member);
      if (a) rows.push(this.adminRow(a, online.has(a.key)));
    }
    return rows;
  }

  adminRow(a: AccountRecord, online: boolean): AdminRow {
    return { name: a.name, rating: a.rating, matches: a.matches, wins: a.wins, createdAt: a.createdAt, grants: a.grants ?? [], cosmetics: a.cosmetics, avatar: a.avatar, online };
  }

  /** Grants this server knows how to honour. */
  static validGrant(g: string): boolean {
    const [kind, id] = g.split(':');
    if (!id) return ABILITY_GRANTS.some((x) => x.id === kind);
    const list = kind === 'title' ? TITLES : kind === 'emblem' ? EMBLEMS : kind === 'color' ? NAME_COLORS : null;
    return !!list?.some((d) => d.id === id && d.unlock.kind === 'owner');
  }

  /** Owner edits a friend's account. The founder account itself is never touched here. */
  async adminSet(
    name: string,
    patch: { grants?: string[]; custom?: CustomStyle | null; useCustom?: boolean; resetPassword?: boolean },
  ): Promise<{ ok: true; account: AccountRecord; tempPassword?: string } | { ok: false; reason: string }> {
    const a = await this.get(name);
    if (!a) return { ok: false, reason: 'No such account.' };
    if (isOwnerName(a.name)) return { ok: false, reason: 'The founder account cannot be changed here.' };
    if (patch.grants) {
      if (!patch.grants.every((g) => Accounts.validGrant(g))) return { ok: false, reason: 'Unknown grant.' };
      a.grants = patch.grants;
      // anything equipped that is no longer unlocked falls back to the default
      const s = { ...a, grants: a.grants };
      const c = a.cosmetics;
      if (!isUnlockedGrant(TITLES.find((x) => x.id === c.title), s, 'title')) c.title = DEFAULT_COSMETICS.title;
      if (!isUnlockedGrant(EMBLEMS.find((x) => x.id === c.emblem), s, 'emblem')) c.emblem = DEFAULT_COSMETICS.emblem;
      if (!isUnlockedGrant(NAME_COLORS.find((x) => x.id === c.color), s, 'color')) c.color = DEFAULT_COSMETICS.color;
      if (!a.grants.includes('gif') && a.avatar) {
        a.avatar = undefined;
        await this.store.del(`avatar:${a.key}`);
      }
    }
    if (patch.custom === null) {
      delete a.cosmetics.custom;
      delete a.cosmetics.useCustom;
    } else if (patch.custom) {
      const clean = cleanCustom(patch.custom);
      if (!clean) return { ok: false, reason: 'Bad custom style.' };
      a.cosmetics.custom = clean;
      a.cosmetics.useCustom = patch.useCustom ?? true;
    } else if (patch.useCustom !== undefined && a.cosmetics.custom) {
      a.cosmetics.useCustom = patch.useCustom;
    }
    let tempPassword: string | undefined;
    if (patch.resetPassword) {
      tempPassword = crypto.randomBytes(9).toString('base64url');
      const salt = crypto.randomBytes(16);
      a.salt = salt.toString('base64');
      a.hash = await this.hash(tempPassword, salt);
      a.epoch = (a.epoch ?? 0) + 1;
    }
    await this.save(a);
    return { ok: true, account: a, tempPassword };
  }

  // ------------------------------------------------------------------ animated icon

  canGif(a: AccountRecord, ownerOk: boolean): boolean {
    return ownerOk || !!a.grants?.includes('gif');
  }

  /** `data` is a validated GIF (see validateGif). */
  async setAvatar(a: AccountRecord, data: Buffer): Promise<AccountRecord> {
    const fresh = (await this.get(a.name)) ?? a;
    await this.store.set(`avatar:${fresh.key}`, data.toString('base64'));
    fresh.avatar = Date.now();
    await this.save(fresh);
    return fresh;
  }

  async clearAvatar(a: AccountRecord): Promise<AccountRecord> {
    const fresh = (await this.get(a.name)) ?? a;
    await this.store.del(`avatar:${fresh.key}`);
    delete fresh.avatar;
    await this.save(fresh);
    return fresh;
  }

  async getAvatar(name: string): Promise<Buffer | null> {
    if (!NAME_RE.test(name)) return null;
    const raw = await this.store.get(`avatar:${name.toLowerCase()}`);
    return raw ? Buffer.from(raw, 'base64') : null;
  }

  async accountForToken(token: string): Promise<AccountRecord | null> {
    const r = await this.resume(token);
    return r.ok ? r.account : null;
  }

  async leaderboard(count = 20): Promise<LeaderRow[]> {
    const top = await this.store.ztop(LEADERBOARD_KEY, count);
    const rows: LeaderRow[] = [];
    for (const { member } of top) {
      const a = await this.get(member);
      if (a) rows.push({ name: a.name, rating: a.rating, wins: a.wins, matches: a.matches, cosmetics: a.cosmetics, role: isOwnerName(a.name) ? 'owner' : undefined, avatar: a.avatar });
    }
    return rows;
  }
}

/** The account a player may see: everything except the credentials. */
export function publicInfo(a: AccountRecord, ownerOk = false): AccountInfo {
  return { name: a.name, matches: a.matches, wins: a.wins, peak: a.peak, rating: a.rating, rated: a.rated, cosmetics: a.cosmetics, role: isOwnerName(a.name) ? 'owner' : undefined, inventory: a.inventory, grants: a.grants ?? [], avatar: a.avatar, ownerOk: ownerOk || undefined };
}

function isUnlockedGrant(def: { id: string; unlock: { kind: string } } | undefined, s: { name: string; grants: string[] }, kind: 'title' | 'emblem' | 'color'): boolean {
  if (!def) return false;
  return def.unlock.kind !== 'owner' || s.grants.includes(`${kind}:${def.id}`);
}

/** A GIF we are willing to store and serve: real GIF header, small, and no bigger than 256x256 pixels. */
export const AVATAR_MAX_BYTES = 256 * 1024;
export function validateGif(b: Buffer): string | null {
  if (b.length < 14) return 'Not a GIF.';
  if (b.length > AVATAR_MAX_BYTES) return `GIF is too big (max ${AVATAR_MAX_BYTES / 1024} KB).`;
  const sig = b.subarray(0, 6).toString('latin1');
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return 'Not a GIF.';
  const w = b.readUInt16LE(6);
  const h = b.readUInt16LE(8);
  if (!w || !h || w > 256 || h > 256) return 'GIF must be at most 256x256 pixels.';
  return null;
}
