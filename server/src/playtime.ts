import { ARENAS, CLASS_IDS, SPECS, TIME_CATS, TIME_DAYS, TIME_MATCH_CATS, TIME_MODES, emptyCats } from '@arena/shared';
import type { TimeBuckets, TimeCat, TimeGlobal, TimeRecord, TimeRow } from '@arena/shared';
import type { Store } from './store';

/** Store keys: one small record per account, one for the server, and a sorted set (score: seconds played) to list accounts. */
const REC = (key: string) => `pt:${key.toLowerCase()}`;
const GLOBAL = 'pt:*global';
const RANK = 'pt:rank';
/** An account's record is written at most this often while it is connected (and always when the last connection closes). */
const FLUSH_MS = 60_000;
/** A gap between two samples longer than this (the server stalled, the clock jumped) is counted as this much. */
const MAX_STEP_MS = 30_000;
const MAX_MS = 1e12;
const MAX_TIME = 1e14;
/** Accounts listed in the owner's table. */
const LIST_MAX = 500;

/** What one connection is doing right now, as the lobby sees it. */
export interface TimeSample {
  /** Account key (lowercase name); absent for a guest. */
  key?: string;
  name?: string;
  /** Another connection id, only used to count a guest's sessions. */
  conn?: number;
  cat: TimeCat;
  /** False when the connection has been idle too long to count. */
  active: boolean;
  classId?: string;
  spec?: string;
  map?: string;
  size?: number;
}

const SPEC_KEYS = new Set(CLASS_IDS.flatMap((c) => (SPECS[c] ?? []).map((s) => `${c}:${s.id}`)));
const MAP_IDS = new Set(ARENAS.map((a) => a.id));
const CLASS_SET = new Set<string>(CLASS_IDS);
const MODE_SET = new Set<string>(TIME_MODES);

const stamp = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX_TIME, Math.max(0, Math.round(v))) : 0);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX_MS, Math.max(0, Math.round(v))) : 0);

/** Keep only the keys `ok` accepts, with sane numbers. */
function bucket(raw: unknown, ok: (k: string) => boolean): TimeBuckets {
  const out: TimeBuckets = {};
  if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (ok(k) && num(v) > 0) out[k] = num(v);
  return out;
}

function cats(raw: unknown): Record<TimeCat, number> {
  const out = emptyCats();
  if (raw && typeof raw === 'object') for (const c of TIME_CATS) out[c] = num((raw as Record<string, unknown>)[c]);
  return out;
}

const DAY_RE = /^\d{8}$/;
/** The newest TIME_DAYS days only. */
function days(raw: unknown): TimeBuckets {
  const all = bucket(raw, (k) => DAY_RE.test(k));
  return pruneDays(all);
}
function pruneDays(d: TimeBuckets): TimeBuckets {
  const keys = Object.keys(d).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - TIME_DAYS))) delete d[k];
  return d;
}

export const dayKey = (t: number): string => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');

export function emptyRecord(now: number): TimeRecord {
  return { first: now, last: now, sessions: 0, total: 0, idle: 0, cat: emptyCats(), cls: {}, spec: {}, map: {}, mode: {}, days: {} };
}

/** A record read from the store, forced into the shape and bounds it must have (the store is not trusted blindly). */
export function cleanRecord(raw: unknown, now: number): TimeRecord {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    first: stamp(r.first) || now, last: stamp(r.last) || now, sessions: Math.min(1e7, num(r.sessions)), total: num(r.total), idle: num(r.idle),
    cat: cats(r.cat), cls: bucket(r.cls, (k) => CLASS_SET.has(k)), spec: bucket(r.spec, (k) => SPEC_KEYS.has(k)), map: bucket(r.map, (k) => MAP_IDS.has(k)),
    mode: bucket(r.mode, (k) => MODE_SET.has(k)), days: days(r.days),
  };
}

function cleanGlobal(raw: unknown, now: number): TimeGlobal {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const g = (r.guests && typeof r.guests === 'object' ? r.guests : {}) as Record<string, unknown>;
  const hours = Array.isArray(r.hours) ? r.hours : [];
  return {
    since: stamp(r.since) || now, sessions: Math.min(1e9, num(r.sessions)), total: num(r.total), cat: cats(r.cat), cls: bucket(r.cls, (k) => CLASS_SET.has(k)),
    spec: bucket(r.spec, (k) => SPEC_KEYS.has(k)), map: bucket(r.map, (k) => MAP_IDS.has(k)), mode: bucket(r.mode, (k) => MODE_SET.has(k)), days: days(r.days),
    hours: Array.from({ length: 24 }, (_, i) => num(hours[i])),
    guests: { total: num(g.total), sessions: Math.min(1e9, num(g.sessions)), cat: cats(g.cat) },
  };
}

const add = (b: TimeBuckets, k: string, ms: number) => void (b[k] = Math.min(MAX_MS, (b[k] ?? 0) + ms));

/** Spend `ms` of counted time on a record's category and, in a match, its class / spec / arena / mode. */
function credit(t: { total: number; cat: Record<TimeCat, number>; cls: TimeBuckets; spec: TimeBuckets; map: TimeBuckets; mode: TimeBuckets; days: TimeBuckets }, s: TimeSample, ms: number, day: string): void {
  t.total = Math.min(MAX_MS, t.total + ms);
  t.cat[s.cat] = Math.min(MAX_MS, t.cat[s.cat] + ms);
  add(t.days, day, ms);
  pruneDays(t.days);
  if (!TIME_MATCH_CATS.includes(s.cat)) return;
  if (s.classId && CLASS_SET.has(s.classId)) {
    add(t.cls, s.classId, ms);
    if (s.spec && SPEC_KEYS.has(`${s.classId}:${s.spec}`)) add(t.spec, `${s.classId}:${s.spec}`, ms);
  }
  if (s.map && MAP_IDS.has(s.map)) add(t.map, s.map, ms);
  const mode = s.size ? `${s.size}v${s.size}` : '';
  if (MODE_SET.has(mode)) add(t.mode, mode, ms);
}

/** Better first: a match, then watching one, then the queue, then the menu; an active connection beats an idle one. */
const RANK_OF: Record<TimeCat, number> = { ranked: 7, duel: 6, party: 5, practice: 4, dev: 3, spectate: 2, queue: 1, menu: 0 };
const better = (a: TimeSample, b: TimeSample) => (a.active === b.active ? RANK_OF[a.cat] > RANK_OF[b.cat] : a.active);

interface Live {
  rec: TimeRecord;
  name: string;
  dirty: boolean;
  flushed: number;
}

/**
 * Play time per account. The lobby hands in one sample per connection about once a second; the time since the previous
 * sample is credited to what each account was doing (server clock only, the client is never asked). Guests are one bucket.
 * Records are written at most once a minute per account and when its last connection closes.
 */
export class PlayTime {
  private lastAt: number | null = null;
  private live = new Map<string, Live>();
  private loading = new Map<string, Promise<void>>();
  private g: TimeGlobal;
  private gDirty = false;
  private gFlushed = 0;
  private gLoaded: Promise<void>;
  private guestConns = new Set<number>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private store: Store, private now: () => number = Date.now) {
    this.g = cleanGlobal(null, this.now());
    this.gFlushed = this.now();
    this.gLoaded = this.store.get(GLOBAL).then(
      (raw) => {
        if (!raw) return;
        const stored = cleanGlobal(JSON.parse(raw), this.now());
        this.g = mergeGlobal(stored, this.g);
      },
      () => undefined,
    ).catch(() => undefined);
  }

  /** Credit the time since the last call to what each connection is doing. */
  tick(samples: TimeSample[], now = this.now()): void {
    const dt = this.lastAt === null ? 0 : Math.min(MAX_STEP_MS, Math.max(0, now - this.lastAt));
    this.lastAt = now;
    const day = dayKey(now);
    const byKey = new Map<string, TimeSample>();
    for (const s of samples) {
      if (!s.key) continue;
      const prev = byKey.get(s.key);
      if (!prev || better(s, prev)) byKey.set(s.key, s);
    }
    // accounts that are gone: write them now and forget them
    for (const [key, l] of this.live) if (!byKey.has(key)) this.evict(key, l);
    for (const [key, s] of byKey) {
      const l = this.live.get(key);
      if (!l) {
        this.load(key, s.name ?? key, now);
        continue;
      }
      if (s.name) l.name = s.name;
      if (dt > 0) this.count(l.rec, s, dt, day);
      l.rec.last = now;
      l.dirty = true;
      this.hour(s, dt, now);
      if (dt > 0 && s.active) credit(this.g, s, dt, day);
      if (dt > 0) this.gDirty = true;
      if (now - l.flushed >= FLUSH_MS) this.save(key, l, now);
    }
    // guests together: no per-guest storage
    const seen = new Set<number>();
    for (const s of samples) {
      if (s.key) continue;
      if (s.conn !== undefined) {
        seen.add(s.conn);
        if (!this.guestConns.has(s.conn)) {
          this.g.guests.sessions++;
          this.g.sessions++;
          this.gDirty = true;
        }
      }
      if (dt > 0 && s.active) {
        this.g.guests.total = Math.min(MAX_MS, this.g.guests.total + dt);
        this.g.guests.cat[s.cat] = Math.min(MAX_MS, this.g.guests.cat[s.cat] + dt);
        credit(this.g, s, dt, day);
        this.hour(s, dt, now);
        this.gDirty = true;
      }
    }
    this.guestConns = seen;
    if (this.gDirty && now - this.gFlushed >= FLUSH_MS) this.saveGlobal(now);
  }

  private count(rec: TimeRecord, s: TimeSample, dt: number, day: string): void {
    if (!s.active) {
      rec.idle = Math.min(MAX_MS, rec.idle + dt);
      return;
    }
    credit(rec, s, dt, day);
  }

  /** Hours of the day (UTC) are for the server only. Accounts and guests are both counted, active time only. */
  private hour(s: TimeSample, dt: number, now: number): void {
    if (dt <= 0 || !s.active) return;
    const h = new Date(now).getUTCHours();
    this.g.hours[h] = Math.min(MAX_MS, this.g.hours[h] + dt);
  }

  private load(key: string, name: string, now: number): void {
    if (this.loading.has(key)) return;
    const p = this.store.get(REC(key)).then(
      (raw) => {
        let rec: TimeRecord;
        try {
          rec = raw ? cleanRecord(JSON.parse(raw), now) : emptyRecord(now);
        } catch {
          rec = emptyRecord(now);
        }
        rec.sessions++;
        rec.last = now;
        this.g.sessions++;
        this.gDirty = true;
        this.live.set(key, { rec, name, dirty: true, flushed: now });
      },
      () => undefined, // the store hiccuped: the next sample tries again
    ).finally(() => this.loading.delete(key));
    this.loading.set(key, p);
  }

  private evict(key: string, l: Live): void {
    this.live.delete(key);
    this.save(key, l, this.now());
    if (this.gDirty) this.saveGlobal(this.now());
  }

  private save(key: string, l: Live, now: number): void {
    l.flushed = now;
    l.dirty = false;
    const json = JSON.stringify(l.rec);
    const score = Math.round(l.rec.total / 1000);
    this.queue(async () => {
      await this.store.set(REC(key), json);
      await this.store.zadd(RANK, score, l.name);
    });
  }

  private saveGlobal(now: number): void {
    this.gFlushed = now;
    this.gDirty = false;
    this.queue(async () => {
      await this.gLoaded; // the stored totals are merged in first, so they are never overwritten
      await this.store.set(GLOBAL, JSON.stringify(this.g));
    });
  }

  /** Writes happen one after the other, so a slow store cannot reorder them; a failed one is dropped, never thrown. */
  private queue(job: () => Promise<void>): void {
    this.chain = this.chain.then(job).catch(() => undefined);
  }

  /** Write everything that changed (live accounts and the server totals). */
  flush(): Promise<void> {
    const now = this.now();
    for (const [key, l] of this.live) if (l.dirty) this.save(key, l, now);
    if (this.gDirty) this.saveGlobal(now);
    return this.settle();
  }

  /** Wait for loads and writes that are under way (tests, shutdown). */
  async settle(): Promise<void> {
    await Promise.all([...this.loading.values(), this.gLoaded]);
    await this.chain;
  }

  /** One account's record, current to the second; null when there is none. */
  async player(name: string): Promise<TimeRecord | null> {
    await this.flush();
    const raw = await this.store.get(REC(name));
    if (!raw) return null;
    try {
      return cleanRecord(JSON.parse(raw), this.now());
    } catch {
      return null;
    }
  }

  /** The server totals and the accounts with the most time (at most 500). */
  async overview(online: Set<string>): Promise<{ global: TimeGlobal; rows: TimeRow[] }> {
    await this.flush();
    const top = await this.store.ztop(RANK, LIST_MAX);
    const raws = [] as (string | null)[];
    for (let i = 0; i < top.length; i += 100) raws.push(...(await this.store.mget(top.slice(i, i + 100).map((t) => REC(t.member)))));
    const rows: TimeRow[] = [];
    top.forEach((t, i) => {
      if (!raws[i]) return;
      try {
        const r = cleanRecord(JSON.parse(raws[i]!), this.now());
        rows.push({ name: t.member, total: r.total, last: r.last, online: online.has(t.member.toLowerCase()), cat: r.cat });
      } catch {
        /* a damaged record is skipped */
      }
    });
    rows.sort((a, b) => b.total - a.total);
    return { global: structuredClone(this.g), rows };
  }
}

function addInto(a: TimeBuckets, b: TimeBuckets): TimeBuckets {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.min(MAX_MS, (out[k] ?? 0) + v);
  return out;
}
const addCats = (a: Record<TimeCat, number>, b: Record<TimeCat, number>) => {
  const out = emptyCats();
  for (const c of TIME_CATS) out[c] = Math.min(MAX_MS, a[c] + b[c]);
  return out;
};

/** What was stored plus what was counted before the stored copy arrived. */
function mergeGlobal(stored: TimeGlobal, now: TimeGlobal): TimeGlobal {
  return {
    since: Math.min(stored.since, now.since), sessions: stored.sessions + now.sessions, total: stored.total + now.total, cat: addCats(stored.cat, now.cat),
    cls: addInto(stored.cls, now.cls), spec: addInto(stored.spec, now.spec), map: addInto(stored.map, now.map), mode: addInto(stored.mode, now.mode),
    days: pruneDays(addInto(stored.days, now.days)), hours: stored.hours.map((h, i) => h + now.hours[i]),
    guests: { total: stored.guests.total + now.guests.total, sessions: stored.guests.sessions + now.guests.sessions, cat: addCats(stored.guests.cat, now.guests.cat) },
  };
}
