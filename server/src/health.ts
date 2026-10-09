import { HEALTH_HOURS } from '@arena/shared';
import type { HealthHour } from '@arena/shared';
import type { Store } from './store';

const KEY = 'sh:hours';
/** The hour record is written at most this often. */
const FLUSH_MS = 60_000;
const HOUR_MS = 3_600_000;

/** What the tick meter hands over (see TickMeter.drain). */
export interface HealthDrain { ticks: number; late: number; busyMs: number; maxMs: number }

const num = (v: unknown, max = 1e12): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : 0);

/** A list read from the store, forced into the shape and bounds it must have. */
export function cleanHealth(raw: unknown): HealthHour[] {
  if (!Array.isArray(raw)) return [];
  const out: HealthHour[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const h = Math.floor(num(o.h, 1e7));
    if (!h) continue;
    out.push({ h, ticks: num(o.ticks), busyMs: num(o.busyMs), late: num(o.late), maxMs: num(o.maxMs, 1e7), peakOnline: Math.floor(num(o.peakOnline, 1e6)), stepMs: num(o.stepMs, 1000) });
  }
  return out.sort((a, b) => a.h - b.h).slice(-HEALTH_HOURS);
}

/**
 * How the server loop coped, one record per UTC hour for the last three days: ticks run, time they took, late ones, the
 * slowest tick and the most people online. The lobby hands in what the tick meter counted about once a second.
 */
export class ServerHealth {
  private hours: HealthHour[] = [];
  private loaded: Promise<void>;
  private flushed = 0;
  private dirty = false;

  constructor(private store: Store, private tickMs: number, private now: () => number = Date.now) {
    this.flushed = this.now();
    this.loaded = this.store.get(KEY).then(
      (raw) => {
        if (!raw) return;
        const stored = cleanHealth(JSON.parse(raw));
        // what was counted before the stored copy arrived is added to the same hours
        for (const mine of this.hours) {
          const at = stored.find((x) => x.h === mine.h);
          if (!at) stored.push(mine);
          else this.merge(at, mine);
        }
        this.hours = cleanHealth(stored);
      },
      () => undefined,
    ).catch(() => undefined);
  }

  private merge(into: HealthHour, from: HealthHour): void {
    into.ticks += from.ticks;
    into.busyMs += from.busyMs;
    into.late += from.late;
    into.maxMs = Math.max(into.maxMs, from.maxMs);
    into.peakOnline = Math.max(into.peakOnline, from.peakOnline);
  }

  /** Add what the tick meter counted since the last call, and how many people are online right now. */
  record(d: HealthDrain, online: number): void {
    const now = this.now();
    const h = Math.floor(now / HOUR_MS);
    let cur = this.hours[this.hours.length - 1];
    if (!cur || cur.h !== h) {
      cur = { h, ticks: 0, busyMs: 0, late: 0, maxMs: 0, peakOnline: 0, stepMs: this.tickMs };
      this.hours.push(cur);
      this.hours = this.hours.slice(-HEALTH_HOURS);
    }
    cur.ticks += d.ticks;
    cur.busyMs += d.busyMs;
    cur.late += d.late;
    cur.maxMs = Math.max(cur.maxMs, d.maxMs);
    cur.peakOnline = Math.max(cur.peakOnline, online);
    this.dirty = true;
    if (now - this.flushed >= FLUSH_MS) void this.flush();
  }

  /** Write the hours now (the store hiccuping is ignored: the next write tries again). */
  async flush(): Promise<void> {
    await this.loaded;
    this.flushed = this.now();
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await this.store.set(KEY, JSON.stringify(this.hours));
    } catch {
      this.dirty = true;
    }
  }

  async list(): Promise<HealthHour[]> {
    await this.loaded;
    return this.hours.map((x) => ({ ...x }));
  }
}
