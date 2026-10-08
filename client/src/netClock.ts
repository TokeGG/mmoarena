/**
 * The server clock as the client sees it, and the round trip to the server. Pure (no DOM, no timers): every time is passed
 * in, so the behaviour under jitter and reordering is unit tested (client/test/netClock.test.ts).
 */

/**
 * Estimates server time from the time labels of snapshots.
 *
 * Each snapshot gives `offset = serverTime - localTime`; the largest offset over a short window belongs to the snapshot that
 * travelled fastest, so it carries the least network delay. The estimate slews towards that (a fraction per snapshot), and
 * `now()` never returns less than it returned before: render time and lag compensation (`vt`) can pause but not run backwards.
 */
export class NetClock {
  private win: { at: number; off: number }[] = [];
  private offset = Number.NaN;
  private floor = -Infinity;
  /** How much later than the fastest recent snapshot each one arrived (ms), newest last. */
  private late: number[] = [];

  constructor(
    private windowMs = 2000,
    private slew = 0.1,
    /** A change of the target larger than this is a new clock (another match, a long freeze), not jitter: adopt it at once. */
    private jumpMs = 1000,
  ) {}

  reset(): void {
    this.win = [];
    this.offset = Number.NaN;
    this.floor = -Infinity;
    this.late = [];
  }

  get ready(): boolean {
    return Number.isFinite(this.offset);
  }

  /** A snapshot labelled `serverTime` (ms) arrived at local time `localMs`. */
  sample(serverTime: number, localMs: number): void {
    const off = serverTime - localMs;
    this.win.push({ at: localMs, off });
    while (this.win.length > 1 && this.win[0].at < localMs - this.windowMs) this.win.shift();
    let target = -Infinity;
    for (const w of this.win) if (w.off > target) target = w.off;
    if (!this.ready) this.offset = target;
    else if (Math.abs(target - this.offset) > this.jumpMs) {
      this.offset = target;
      this.floor = -Infinity;
      this.win = [{ at: localMs, off }];
      this.late = [];
    } else this.offset += (target - this.offset) * this.slew;
    this.late.push(Math.max(0, target - off));
    if (this.late.length > 100) this.late.shift();
  }

  /** Server time now, in ms (0 before the first snapshot). Never decreases. */
  now(localMs: number): number {
    if (!this.ready) return 0;
    const v = localMs + this.offset;
    if (v > this.floor) this.floor = v;
    return this.floor;
  }

  /** The 95th percentile of how late snapshots arrive compared with the fastest ones (the jitter that matters). */
  latenessP95(): number {
    return percentile(this.late, 0.95);
  }
}

export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

/** Smoothed round-trip time and its deviation (RFC 6298 style), from ping/pong. */
export class RttEstimator {
  rtt = Number.NaN;
  jitter = 0;

  add(sampleMs: number): void {
    if (!Number.isFinite(sampleMs) || sampleMs < 0) return;
    if (!Number.isFinite(this.rtt)) {
      this.rtt = sampleMs;
      this.jitter = sampleMs / 2;
      return;
    }
    this.jitter += (Math.abs(sampleMs - this.rtt) - this.jitter) * 0.25;
    this.rtt += (sampleMs - this.rtt) * 0.125;
  }
}
