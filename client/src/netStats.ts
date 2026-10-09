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
  /** Milliseconds per server tick (from `welcome`) and how much of a tick the server says it needs (0 to 1+, from `pong`). */
  tickMs = 50;
  serverLoad = 0;
  /** How far ahead of the buffered time other players are drawn (dead reckoning), ms. */
  leadMs = 0;
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
    if (this.arrivals.length > Math.ceil(1000 / this.tickMs) + 1) this.arrivals.shift();
    if (Number.isFinite(this.lastTick) && tick > this.lastTick + 1) {
      const missed = Math.min(Math.ceil(1000 / this.tickMs), tick - this.lastTick - 1);
      this.gaps += missed;
      for (let i = 0; i < missed; i++) this.recent.push(false);
    }
    if (!Number.isFinite(this.lastTick) || tick > this.lastTick) this.lastTick = tick;
    this.got++;
    this.recent.push(true);
    while (this.recent.length > Math.ceil(4000 / this.tickMs)) this.recent.shift();
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
    const busy = this.serverLoad > 0.9;
    return [
      `server ${this.tickMs} ms ticks (${(1000 / this.tickMs).toFixed(1)} Hz)${busy ? '  server busy' : ''}`,
      `ping ${ping}  jitter ${Math.round(r.jitter)} ms`,
      `loss ${this.lossPct().toFixed(1)}%  ticks ${sp.mean.toFixed(0)}±${sp.sd.toFixed(0)} ms`,
      `view delay ${Math.round(this.delayMs)} ms${this.leadMs >= 1 ? ` (-${Math.round(this.leadMs)} ahead)` : ''}  stalls ${this.frames ? ((100 * this.underruns) / this.frames).toFixed(1) : '0.0'}%`,
    ];
  }
}

export const SAMPLE = ['server 50 ms ticks (20.0 Hz)', 'ping 42 ms  jitter 3 ms', 'loss 0.0%  ticks 50±2 ms', 'view delay 100 ms  stalls 0.0%'].join('\n');

/** The small readout. A HUD element (`#netstats`, see hudLayout.ts): the stylesheet places and styles it, the HUD editor moves it. */
export class NetStatsView {
  private root = document.createElement('div');
  private shown = false;
  private paintedAt = 0;

  constructor() {
    this.root.id = 'netstats';
    this.root.className = 'hidden';
    this.root.textContent = SAMPLE; // what the HUD editor shows until real numbers come in
    this.root.setAttribute('aria-hidden', 'true');
    document.body.append(this.root);
  }

  show(on: boolean): void {
    if (on === this.shown) return;
    this.shown = on;
    this.root.classList.toggle('hidden', !on);
  }

  update(stats: NetStats, now: number): void {
    if (!this.shown || now - this.paintedAt < 500) return;
    this.paintedAt = now;
    this.root.textContent = stats.lines().join('\n');
  }
}
