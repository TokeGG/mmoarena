import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { ABILITY_GRANTS, sanctionActive, DEFAULT_COSMETICS, EMBLEMS, NAME_COLORS, NAME_RE, TITLES, cleanCustom, isOwnerName, PASSWORD_MAX, PASSWORD_MIN, START_RATING, eloDelta, validateCosmetics } from '@arena/shared';
import { MAX_FRIENDS, MAX_HISTORY, MAX_REQUESTS } from '@arena/shared';
import type { AccountInfo, AdminRow, Sanction, CustomStyle, Cosmetics, LeaderRow, MatchRecord } from '@arena/shared';
import type { Store } from './store';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const SESSION_SECONDS = 30 * 24 * 3600;
const LEADERBOARD_KEY = 'lb:rating';
/** A ranked drop is guaranteed to be epic or better after this many without one. */

export interface AccountRecord extends AccountInfo {
  key: string;
  salt: string;
  hash: string;
  createdAt: number;
  /** JSON snapshot of the player's client settings (HUD, keybinds, builds). */
  settings?: string;
  /** Bumped on password reset; sessions made before it stop working. */
  epoch?: number;
  /** Friends (display names) and requests other players have sent this account. */
  friends?: string[];
  requests?: string[];
  /** Moderation by the owner: a ban keeps the account out, a mute stops suggestions, invites and friend requests. */
  banned?: Sanction;
  muted?: Sanction;
  /** The owner's private note on this player. */
  adminNote?: string;
  lastSeen?: number;
}

export type AuthResult = { ok: true; account: AccountRecord; token: string } | { ok: false; reason: string };

/** Simple in-memory limiter: at most `max` events per `windowMs` per key. Old keys are swept so the map never grows without bound. */
/** The message a banned account gets when it tries to sign in, or null when it is not banned. */
export function bannedText(a: AccountRecord, now = Date.now()): string | null {
  if (!sanctionActive(a.banned, now)) return null;
  const until = a.banned!.until ? ` until ${new Date(a.banned!.until).toUTCString()}` : '';
  return `This account is banned${until}${a.banned!.reason ? `: ${a.banned!.reason}` : '.'}`;
}

export class Limiter {
  private hits = new Map<string, number[]>();
  private lastSweep = Date.now();
  constructor(private max: number, private windowMs: number) {}
  allow(key: string, record = true): boolean {
    const now = Date.now();
    this.sweep(now);
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    if (record) arr.push(now);
    if (arr.length) this.hits.set(key, arr);
    else this.hits.delete(key);
    return true;
  }
  clear(key: string) {
    this.hits.delete(key);
  }
  /** How many keys are being tracked (for tests). */
  get size(): number {
    return this.hits.size;
  }
  /** Drop every key whose newest hit has left the window (at most once per window). */
  sweep(now = Date.now(), force = false): void {
    if (!force && now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [k, arr] of this.hits) if (!arr.length || now - arr[arr.length - 1] >= this.windowMs) this.hits.delete(k);
  }
}

/** Matches kept in the owner's list of every match. */
const FEED_KEEP = 400;
/** How long the leaderboard is served from memory before it is read again. */
const LEADERBOARD_CACHE_MS = 10000;

export class Accounts {
  private loginFails = new Limiter(6, 10 * 60 * 1000);
  /** Failed logins per account name from anywhere: stops one password being tried on every name from many addresses. */
  private nameFails = new Limiter(30, 15 * 60 * 1000);
  private ownerFails = new Limiter(5, 10 * 60 * 1000);
  private registers = new Limiter(5, 60 * 60 * 1000);
  /** One write queue per account: every read-modify-write of a record runs after the previous one finished. */
  private queues = new Map<string, Promise<void>>();
  private board: { at: number; count: number; rows: Promise<LeaderRow[]> } | null = null;

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

  /**
   * Run `fn` while holding the write queue of every listed account. All queues are joined at once (synchronously), so
   * two operations that share accounts always run one after the other and can never deadlock.
   */
  private async exclusive<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const ks = [...new Set(keys.map((k) => k.toLowerCase()))];
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const prev = ks.map((k) => this.queues.get(k) ?? Promise.resolve());
    for (const k of ks) this.queues.set(k, mine);
    try {
      await Promise.all(prev);
      return await fn();
    } finally {
      release();
      for (const k of ks) if (this.queues.get(k) === mine) this.queues.delete(k);
    }
  }

  async get(name: string): Promise<AccountRecord | null> {
    return parseAccount(await this.store.get(`acct:${name.toLowerCase()}`));
  }

  /** Many accounts in one database round trip. */
  async getMany(names: string[]): Promise<(AccountRecord | null)[]> {
    const out: (AccountRecord | null)[] = [];
    for (let i = 0; i < names.length; i += 100) {
      const raws = await this.store.mget(names.slice(i, i + 100).map((n) => `acct:${n.toLowerCase()}`));
      out.push(...raws.map(parseAccount));
    }
    return out;
  }

  async save(a: AccountRecord): Promise<void> {
    await this.store.set(`acct:${a.key}`, JSON.stringify(a));
    await this.store.zadd(LEADERBOARD_KEY, a.rating, a.name);
  }

  async register(name: string, password: string, ip: string, code?: string): Promise<AuthResult> {
    if (!NAME_RE.test(name)) return { ok: false, reason: 'Names are 3-16 letters, numbers or underscores.' };
    // without an owner code on the server nobody can prove they are the founder, so the name cannot be taken at all
    if (isOwnerName(name) && (!this.ownerCode || code !== this.ownerCode)) return { ok: false, reason: 'That name is reserved. Enter the owner code to register it.' };
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return { ok: false, reason: `Passwords are ${PASSWORD_MIN}-${PASSWORD_MAX} characters.` };
    if (!this.registers.allow(ip)) return { ok: false, reason: 'Too many new accounts from your network. Try again later.' };
    const salt = crypto.randomBytes(16);
    const record: AccountRecord = {
      key: name.toLowerCase(), name, salt: salt.toString('base64'), hash: await this.hash(password, salt), createdAt: Date.now(),
      matches: 0, wins: 0, peak: START_RATING, rating: START_RATING, rated: 0, cosmetics: { ...DEFAULT_COSMETICS }, grants: [], friends: [], requests: [],
    };
    if (!(await this.store.setNx(`acct:${record.key}`, JSON.stringify(record)))) return { ok: false, reason: 'That name is taken.' };
    await this.store.zadd(LEADERBOARD_KEY, record.rating, record.name);
    return { ok: true, account: record, token: await this.session(record.key) };
  }

  async login(name: string, password: string, ip: string): Promise<AuthResult> {
    const limitKey = `${ip}|${name.toLowerCase()}`;
    const nameKey = name.toLowerCase();
    if (!this.loginFails.allow(limitKey, false) || !this.nameFails.allow(nameKey, false)) return { ok: false, reason: 'Too many failed attempts. Wait a few minutes.' };
    const a = await this.get(name);
    // hash even for unknown names so timing does not reveal which accounts exist
    const salt = a ? Buffer.from(a.salt, 'base64') : crypto.randomBytes(16);
    const got = Buffer.from(await this.hash(password, salt));
    const want = Buffer.from(a?.hash ?? 'x'.repeat(got.length));
    const good = !!a && got.length === want.length && crypto.timingSafeEqual(got, want);
    if (!good) {
      this.loginFails.allow(limitKey);
      this.nameFails.allow(nameKey);
      return { ok: false, reason: 'Wrong name or password.' };
    }
    this.loginFails.clear(limitKey);
    const banned = bannedText(a!);
    if (banned) return { ok: false, reason: banned };
    void this.touch(a!.key);
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
    const banned = a ? bannedText(a) : null; // said even though the ban also ended the session
    if (banned) return { ok: false, reason: banned };
    if (!a || (a.epoch ?? 0) !== ep) return { ok: false, reason: 'Session expired. Please sign in again.' };
    void this.touch(a.key);
    return { ok: true, account: a, token };
  }

  async logout(token: string): Promise<void> {
    await this.store.del(`sess:${token}`);
    await this.store.del(`own:${token}`);
  }

  async saveSettings(a: AccountRecord, data: string): Promise<void> {
    await this.exclusive([a.key], async () => {
      const fresh = (await this.get(a.name)) ?? a;
      fresh.settings = data;
      await this.save(fresh);
    });
    a.settings = data;
  }

  /** Owner-tier looks need the owner session (name and code), never the name alone. */
  async customize(a: AccountRecord, want: Cosmetics, ownerOk = false): Promise<AccountRecord | null> {
    return this.exclusive([a.key], async () => {
      const fresh = (await this.get(a.name)) ?? a;
      // the owner account has every earned title, icon and colour open; the owner-tier ones also need the owner session
      const asOwner = { ...fresh, matches: 1e9, wins: 1e9, peak: 1e9 };
      const ok = validateCosmetics(want, ownerOk ? fresh : isOwnerName(fresh.name) ? { ...asOwner, name: undefined } : { ...fresh, name: undefined }, fresh.cosmetics, ownerOk);
      if (!ok) return null;
      fresh.cosmetics = ok;
      await this.save(fresh);
      return fresh;
    });
  }

  /**
   * Record a finished match. Always counts towards matches/wins (which unlock gear and cosmetics); rating only moves
   * when `rated` is set, using the average rating of the two teams.
   */
  async recordMatch(name: string, r: { won: boolean; draw?: boolean; rated: boolean; opponentAvg: number }): Promise<AccountRecord | null> {
    return this.exclusive([name], async () => {
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
    });
  }

  /** A rated leaver loses rating (and a match) immediately. `key` is the account key the room recorded at the start. */
  async recordForfeit(key: string, opponentAvg: number): Promise<AccountRecord | null> {
    return this.recordMatch(key, { won: false, rated: true, opponentAvg });
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
    const acctKey = `own@${a.key}`; // and per account, so changing address does not reset the count
    if (!this.ownerFails.allow(limitKey, false) || !this.ownerFails.allow(acctKey, false)) return { ok: false, reason: 'Too many wrong codes. Wait a few minutes.' };
    const got = Buffer.from(code);
    const want = Buffer.from(this.ownerCode);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      this.ownerFails.allow(limitKey);
      this.ownerFails.allow(acctKey);
      return { ok: false, reason: 'Wrong owner code.' };
    }
    await this.store.set(`own:${token}`, '1', SESSION_SECONDS);
    return { ok: true };
  }

  /** Every account, highest rating first, for the owner's panel. */
  async adminList(online: Set<string>): Promise<AdminRow[]> {
    const top = await this.store.ztop(LEADERBOARD_KEY, 500);
    const rows: AdminRow[] = [];
    for (const a of await this.getMany(top.map((t) => t.member))) if (a) rows.push(this.adminRow(a, online.has(a.key)));
    return rows;
  }

  adminRow(a: AccountRecord, online: boolean): AdminRow {
    return {
      name: a.name, rating: a.rating, peak: a.peak, matches: a.matches, wins: a.wins, createdAt: a.createdAt, grants: a.grants ?? [], cosmetics: a.cosmetics, avatar: a.avatar, online,
      ...(a.lastSeen ? { lastSeen: a.lastSeen } : {}),
      ...(sanctionActive(a.banned) ? { banned: a.banned } : {}),
      ...(sanctionActive(a.muted) ? { muted: a.muted } : {}),
      ...(a.adminNote ? { note: a.adminNote } : {}),
    };
  }

  /** When the account was last seen (sign-in or resumed session); at most one write a minute. */
  private async touch(key: string): Promise<void> {
    try {
      await this.exclusive([key], async () => {
        const a = await this.get(key);
        if (!a || (a.lastSeen && Date.now() - a.lastSeen < 60000)) return;
        a.lastSeen = Date.now();
        await this.save(a);
      });
    } catch {
      /* not worth failing a sign-in over */
    }
  }

  isMuted(a: AccountRecord | undefined): boolean {
    return !!a && sanctionActive(a.muted);
  }

  /**
   * Owner moderation of one account: ban or mute for `minutes` (0 = for good), lift them, set the rating, reset the
   * stats, or keep a private note. The founder account is never touched.
   */
  async adminModerate(
    name: string,
    act: 'ban' | 'unban' | 'mute' | 'unmute' | 'set_rating' | 'reset_stats' | 'note',
    o: { minutes?: number; reason?: string; value?: number; text?: string; by: string },
  ): Promise<{ ok: true; account: AccountRecord } | { ok: false; reason: string }> {
    return this.exclusive([name], async () => {
      const a = await this.get(name);
      if (!a) return { ok: false, reason: 'No such account.' };
      if (isOwnerName(a.name) && act !== 'note') return { ok: false, reason: 'The founder account cannot be changed here.' };
      const now = Date.now();
      const sanction = (): Sanction => ({ until: o.minutes && o.minutes > 0 ? now + o.minutes * 60000 : 0, reason: (o.reason ?? '').slice(0, 200), by: o.by, at: now });
      switch (act) {
        case 'ban':
          a.banned = sanction();
          a.epoch = (a.epoch ?? 0) + 1; // every session of the account ends
          break;
        case 'unban':
          delete a.banned;
          break;
        case 'mute':
          a.muted = sanction();
          break;
        case 'unmute':
          delete a.muted;
          break;
        case 'set_rating': {
          const v = Math.round(o.value ?? NaN);
          if (!Number.isFinite(v) || v < 0 || v > 5000) return { ok: false, reason: 'Rating must be 0 to 5000.' };
          a.rating = v;
          a.peak = Math.max(a.peak ?? v, v);
          await this.store.zadd(LEADERBOARD_KEY, a.rating, a.name);
          this.board = null;
          break;
        }
        case 'reset_stats':
          a.rating = START_RATING;
          a.peak = START_RATING;
          a.rated = 0;
          a.matches = 0;
          a.wins = 0;
          await this.store.zadd(LEADERBOARD_KEY, a.rating, a.name);
          this.board = null;
          break;
        case 'note':
          a.adminNote = (o.text ?? '').slice(0, 1000) || undefined;
          break;
      }
      await this.save(a);
      return { ok: true, account: a };
    });
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
    return this.exclusive([name], () => this.adminSetLocked(name, patch));
  }

  private async adminSetLocked(
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

  // ------------------------------------------------------------------ friends

  /**
   * Friend requests work like the usual two-step: `add` asks (or accepts, if they already asked you), `accept` and `decline`
   * answer a request, `remove` ends a friendship for both. Returns both fresh records so online sessions can be updated.
   */
  async friendOp(
    meKey: string,
    op: 'add' | 'accept' | 'decline' | 'remove',
    name: string,
  ): Promise<{ ok: true; me: AccountRecord; other?: AccountRecord; note?: string } | { ok: false; reason: string }> {
    return this.exclusive([meKey, name], () => this.friendOpLocked(meKey, op, name));
  }

  private async friendOpLocked(
    meKey: string,
    op: 'add' | 'accept' | 'decline' | 'remove',
    name: string,
  ): Promise<{ ok: true; me: AccountRecord; other?: AccountRecord; note?: string } | { ok: false; reason: string }> {
    const me = await this.get(meKey);
    if (!me) return { ok: false, reason: 'Sign in first.' };
    const lc = (x: string) => x.toLowerCase();
    const idx = (list: string[], n: string) => list.findIndex((x) => lc(x) === lc(n));
    const friends = (me.friends ??= []);
    const requests = (me.requests ??= []);
    if (lc(name) === me.key) return { ok: false, reason: 'That is you.' };
    if (op === 'decline') {
      const i = idx(requests, name);
      if (i >= 0) requests.splice(i, 1);
      await this.save(me);
      return { ok: true, me };
    }
    const other = await this.get(name);
    if (op === 'remove') {
      const i = idx(friends, name);
      if (i >= 0) friends.splice(i, 1);
      await this.save(me);
      if (other?.friends) {
        const j = idx(other.friends, me.name);
        if (j >= 0) {
          other.friends.splice(j, 1);
          await this.save(other);
        }
      }
      return { ok: true, me, other: other ?? undefined };
    }
    if (!other) return { ok: false, reason: 'No player with that name.' };
    const becomeFriends = async (): Promise<{ ok: true; me: AccountRecord; other: AccountRecord; note: string } | { ok: false; reason: string }> => {
      if (friends.length >= MAX_FRIENDS) return { ok: false, reason: `Your friends list is full (${MAX_FRIENDS}).` };
      if ((other.friends ??= []).length >= MAX_FRIENDS) return { ok: false, reason: `${other.name}'s friends list is full.` };
      const i = idx(requests, other.name);
      if (i >= 0) requests.splice(i, 1);
      if (idx(friends, other.name) < 0) friends.push(other.name);
      if (idx(other.friends, me.name) < 0) other.friends.push(me.name);
      const j = idx(other.requests ?? [], me.name);
      if (j >= 0) other.requests!.splice(j, 1);
      await this.save(me);
      await this.save(other);
      return { ok: true, me, other, note: `You and ${other.name} are now friends.` };
    };
    if (op === 'accept') {
      if (idx(requests, other.name) < 0) return { ok: false, reason: 'No request from that player.' };
      return becomeFriends();
    }
    // add
    if (idx(friends, other.name) >= 0) return { ok: false, reason: `${other.name} is already your friend.` };
    if (idx(requests, other.name) >= 0) return becomeFriends(); // they already asked: adding back accepts
    const theirs = (other.requests ??= []);
    if (idx(theirs, me.name) >= 0) return { ok: false, reason: 'Request already sent.' };
    if (theirs.length >= MAX_REQUESTS) return { ok: false, reason: `${other.name} has too many pending requests.` };
    theirs.push(me.name);
    await this.save(other);
    return { ok: true, me, other, note: `Request sent to ${other.name}.` };
  }

  // ------------------------------------------------------------------ match history and replays

  /** Put a finished match at the top of each listed account's history (newest first, capped). */
  async addHistory(keys: string[], rec: MatchRecord): Promise<void> {
    for (const key of new Set(keys)) {
      const list = await this.history(key);
      list.unshift(rec);
      await this.store.set(`hist:${key}`, JSON.stringify(list.slice(0, MAX_HISTORY)));
    }
  }

  /** Every match played on the server, newest first (the owner's match list), kept as long as their replays. */
  async addFeed(rec: MatchRecord): Promise<void> {
    await this.exclusive(['__feed'], async () => {
      const list = await this.feed();
      list.unshift(rec);
      await this.store.set('feed', JSON.stringify(list.slice(0, FEED_KEEP)));
    });
  }

  async feed(): Promise<MatchRecord[]> {
    try {
      const raw = await this.store.get('feed');
      const v = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(v) ? (v as MatchRecord[]) : [];
    } catch {
      return [];
    }
  }

  async history(key: string): Promise<MatchRecord[]> {
    const raw = await this.store.get(`hist:${key.toLowerCase()}`);
    try {
      return raw ? (JSON.parse(raw) as MatchRecord[]) : [];
    } catch {
      return [];
    }
  }

  /** `gz` is the gzip of the replay JSON. Kept for 30 days. */
  async saveReplay(id: string, gz: Buffer): Promise<boolean> {
    if (gz.length > REPLAY_MAX_BYTES) return false;
    await this.store.set(`rp:${id}`, gz.toString('base64'), 30 * 24 * 3600);
    return true;
  }

  async getReplay(id: string): Promise<Buffer | null> {
    if (!/^[0-9a-f]{12,16}$/.test(id)) return null;
    const raw = await this.store.get(`rp:${id}`);
    return raw ? Buffer.from(raw, 'base64') : null;
  }

  // ------------------------------------------------------------------ animated icon

  canGif(a: AccountRecord, ownerOk: boolean): boolean {
    return ownerOk || !!a.grants?.includes('gif');
  }

  /** `data` is a validated GIF (see validateGif). */
  async setAvatar(a: AccountRecord, data: Buffer): Promise<AccountRecord> {
    return this.exclusive([a.key], async () => {
      const fresh = (await this.get(a.name)) ?? a;
      await this.store.set(`avatar:${fresh.key}`, data.toString('base64'));
      fresh.avatar = Date.now();
      await this.save(fresh);
      return fresh;
    });
  }

  async clearAvatar(a: AccountRecord): Promise<AccountRecord> {
    return this.exclusive([a.key], async () => {
      const fresh = (await this.get(a.name)) ?? a;
      await this.store.del(`avatar:${fresh.key}`);
      delete fresh.avatar;
      await this.save(fresh);
      return fresh;
    });
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

  /**
   * The top of the ladder. Served from memory for LEADERBOARD_CACHE_MS (everyone asking in that time shares one read),
   * and read in one batch, so spamming the button cannot burn through the database quota.
   */
  leaderboard(count = 20): Promise<LeaderRow[]> {
    const now = Date.now();
    if (this.board && this.board.count >= count && now - this.board.at < LEADERBOARD_CACHE_MS) return this.board.rows.then((r) => r.slice(0, count));
    const rows = this.readLeaderboard(count);
    this.board = { at: now, count, rows };
    rows.catch(() => { if (this.board?.rows === rows) this.board = null; });
    return rows;
  }

  private async readLeaderboard(count: number): Promise<LeaderRow[]> {
    const top = await this.store.ztop(LEADERBOARD_KEY, count);
    const rows: LeaderRow[] = [];
    for (const a of await this.getMany(top.map((t) => t.member))) {
      if (a) rows.push({ name: a.name, rating: a.rating, wins: a.wins, matches: a.matches, cosmetics: a.cosmetics, role: isOwnerName(a.name) ? 'owner' : undefined, avatar: a.avatar });
    }
    return rows;
  }
}

/** A stored account record, upgraded from older saves; null if missing or unreadable. */
function parseAccount(raw: string | null): AccountRecord | null {
  if (!raw) return null;
  try {
    const a = JSON.parse(raw) as AccountRecord;
    delete (a as { inventory?: unknown }).inventory; // loot was removed; old saves may still carry it
    delete (a as { pity?: unknown }).pity;
    a.grants ??= [];
    a.friends ??= [];
    a.requests ??= [];
    return a;
  } catch {
    return null;
  }
}

/** The account a player may see: everything except the credentials. */
export function publicInfo(a: AccountRecord, ownerOk = false): AccountInfo {
  return { name: a.name, matches: a.matches, wins: a.wins, peak: a.peak, rating: a.rating, rated: a.rated, cosmetics: a.cosmetics, role: isOwnerName(a.name) ? 'owner' : undefined, grants: a.grants ?? [], avatar: a.avatar, ownerOk: ownerOk || undefined };
}

function isUnlockedGrant(def: { id: string; unlock: { kind: string } } | undefined, s: { name: string; grants: string[] }, kind: 'title' | 'emblem' | 'color'): boolean {
  if (!def) return false;
  return def.unlock.kind !== 'owner' || s.grants.includes(`${kind}:${def.id}`);
}

/** A GIF we are willing to store and serve: real GIF header, small, and no bigger than 256x256 pixels. */
/** Replays bigger than this (compressed) are not stored. */
export const REPLAY_MAX_BYTES = 600 * 1024;
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
