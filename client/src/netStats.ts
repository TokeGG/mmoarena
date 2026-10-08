/** Network statistics for the corner readout (Esc menu: Show network stats; always on for devs). The collector is pure and tested. */
import { RttEstimator } from './netClock';

export class NetStats {
  readonly rtt = new RttEstimator();
  private arrivals: number[] = [];
  private got = 0;
  private gaps = 0;
  private lastTick = Number.NaN;
  /** Snapshots recently: [received?] markers, newest last, for a rolling loss estimate. */
  private recent: boolean[] = [];
  delayMs = 0;
  underruns = 0;
  frames = 0;

  reset(): void {
    this.arrivals = [];
    this.got = 0;
    this.gaps = 0;
    this.lastTick = Number.NaN;
    this.recent = [];
    this.underruns = 0;
    this.frames = 0;
  }

  /** A snapshot of server tick `tick` arrived at local time `at` (ms). Missing ticks in between count as lost. */
  snapshot(at: number, tick: number): void {
    this.arrivals.push(at);
    if (this.arrivals.length > 61) this.arrivals.shift();
    if (Number.isFinite(this.lastTick) && tick > this.lastTick + 1) {
      const missed = Math.min(20, tick - this.lastTick - 1);
      this.gaps += missed;
      for (let i = 0; i < missed; i++) this.recent.push(false);
    }
    if (!Number.isFinite(this.lastTick) || tick > this.lastTick) this.lastTick = tick;
    this.got++;
    this.recent.push(true);
    while (this.recent.length > 200) this.recent.shift();
  }

  /** Mean and standard deviation of the time between snapshot arrivals (ms). */
  spacing(): { mean: number; sd: number } {
    const a = this.arrivals;
    if (a.length < 3) return { mean: 0, sd: 0 };
    const d: number[] = [];
    for (let i = 1; i < a.length; i++) d.push(a[i] - a[i - 1]);
    const mean = d.reduce((s, v) => s + v, 0) / d.length;
    const sd = Math.sqrt(d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length);
    return { mean, sd };
  }

  /** Share of recent server ticks whose snapshot never came (0 to 100). */
  lossPct(): number {
    if (!this.recent.length) return 0;
    return (100 * this.recent.filter((r) => !r).length) / this.recent.length;
  }

  /** One frame was drawn; `underrun` when the draw time was past the newest snapshot. */
  frame(underrun: boolean): void {
    this.frames++;
    if (underrun) this.underruns++;
  }

  lines(): string[] {
    const sp = this.spacing();
    const r = this.rtt;
    const ping = Number.isFinite(r.rtt) ? `${Math.round(r.rtt)} ms` : '-';
    return [
      `ping ${ping}  jitter ${Math.round(r.jitter)} ms`,
      `loss ${this.lossPct().toFixed(1)}%  ticks ${sp.mean.toFixed(0)}±${sp.sd.toFixed(0)} ms`,
      `view delay ${Math.round(this.delayMs)} ms  stalls ${this.frames ? ((100 * this.underruns) / this.frames).toFixed(1) : '0.0'}%`,
    ];
  }
}

/** The small readout in the corner of the screen. */
export class NetStatsView {
  private root = document.createElement('div');
  private shown = false;
  private paintedAt = 0;

  constructor() {
    this.root.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:20;padding:4px 8px;border-radius:6px;background:rgba(10,9,12,.62);color:#cfc6ae;font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;white-space:pre;pointer-events:none;display:none';
    this.root.setAttribute('aria-hidden', 'true');
    document.body.append(this.root);
  }

  show(on: boolean): void {
    if (on === this.shown) return;
    this.shown = on;
    this.root.style.display = on ? 'block' : 'none';
  }

  update(stats: NetStats, now: number): void {
    if (!this.shown || now - this.paintedAt < 500) return;
    this.paintedAt = now;
    this.root.textContent = stats.lines().join('\n');
  }
}
