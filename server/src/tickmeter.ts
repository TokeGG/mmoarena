/**
 * Watches how the server loop copes: how long each tick of all rooms takes (process time, not a guess), kept as one bucket per
 * second so the average and worst of the last seconds, and the number of late ticks in the last minute, are cheap to read.
 * Owner-facing numbers only (/api/status and the admin overview); it never changes anything by itself.
 */
export interface TickReport {
  /** Milliseconds per tick the server runs at. */
  ms: number;
  /** Average and worst time one tick of all rooms took over the last 10 seconds. */
  avgMs: number;
  maxMs: number;
  /** avgMs / ms: 1.0 means every tick needs the whole step, the server cannot keep up above that. */
  load: number;
  /** Ticks in the last minute that took longer than a step, or started more than one step after they were due. */
  late: number;
  /** Worst single tick since the server started. */
  worstMs: number;
}

interface Bucket { sec: number; sum: number; n: number; max: number; late: number }

const AVG_WINDOW_S = 10;
const LATE_WINDOW_S = 60;
export const OVERLOAD_LOAD = 0.7;
export const OVERLOAD_AFTER_S = 10;
const WARN_EVERY_MS = 60000;

export class TickMeter {
  private buckets: Bucket[] = [];
  private lastStart = -1;
  private worst = 0;
  private highSince = -1;
  private lastWarn = -1e12;
  private warnedSec = -1;
  private ticks = 0;
  private lateTicks = 0;
  private busyMs = 0;
  private slowest = 0;

  constructor(readonly tickMs: number, private clock: () => number = () => performance.now()) {}

  /** Record one tick that started at `startedAt` and took `spent` ms. Returns true when the load has stayed high long enough to warn (at most once a minute). */
  record(startedAt: number, spent: number): boolean {
    const late = spent > this.tickMs || (this.lastStart >= 0 && startedAt - this.lastStart > this.tickMs * 2);
    this.lastStart = startedAt;
    this.ticks++;
    this.busyMs += spent;
    if (late) this.lateTicks++;
    if (spent > this.slowest) this.slowest = spent;
    if (spent > this.worst) this.worst = spent;
    const sec = Math.floor(startedAt / 1000);
    let b = this.buckets[this.buckets.length - 1];
    if (!b || b.sec !== sec) {
      b = { sec, sum: 0, n: 0, max: 0, late: 0 };
      this.buckets.push(b);
      while (this.buckets.length && this.buckets[0].sec <= sec - LATE_WINDOW_S) this.buckets.shift();
    }
    b.sum += spent;
    b.n++;
    if (spent > b.max) b.max = spent;
    if (late) b.late++;
    // a finished second decides: more than 70 % of the step spent for 10 seconds in a row
    if (this.buckets.length >= 2 && this.warnedSec !== sec) {
      this.warnedSec = sec;
      const done = this.buckets[this.buckets.length - 2];
      const hot = done.sec === sec - 1 && done.sum / Math.max(1, done.n) / this.tickMs > OVERLOAD_LOAD;
      if (!hot) this.highSince = -1;
      else if (this.highSince < 0) this.highSince = startedAt;
      if (this.highSince >= 0 && startedAt - this.highSince >= OVERLOAD_AFTER_S * 1000 && startedAt - this.lastWarn >= WARN_EVERY_MS) {
        this.lastWarn = startedAt;
        return true;
      }
    }
    return false;
  }

  /** Everything counted since the last call (for the hourly health record); the slowest tick starts over too. */
  drain(): { ticks: number; late: number; busyMs: number; maxMs: number } {
    const out = { ticks: this.ticks, late: this.lateTicks, busyMs: this.busyMs, maxMs: this.slowest };
    this.ticks = this.lateTicks = this.busyMs = this.slowest = 0;
    return out;
  }

  report(): TickReport {
    const sec = Math.floor(this.clock() / 1000);
    let sum = 0, n = 0, max = 0, late = 0;
    for (const b of this.buckets) {
      if (b.sec > sec - LATE_WINDOW_S) late += b.late;
      if (b.sec > sec - AVG_WINDOW_S) { sum += b.sum; n += b.n; if (b.max > max) max = b.max; }
    }
    const avg = n ? sum / n : 0;
    const r = (x: number) => Math.round(x * 100) / 100;
    return { ms: this.tickMs, avgMs: r(avg), maxMs: r(max), load: r(avg / this.tickMs), late, worstMs: r(this.worst) };
  }
}
