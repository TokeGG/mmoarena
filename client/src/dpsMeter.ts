import type { SimEvent, TeamId } from '@arena/shared';

/** What a unit dealt, healed and took since the round started, with the last ten seconds kept for the per-second numbers. */
interface Tally { dealt: number; healed: number; taken: number; log: { t: number; d: number; h: number }[] }

export interface MeterUnit { id: number; name: string; team: TeamId }
export interface MeterRow { id: number; name: string; team: TeamId; dps: number; dealt: number; hps: number; healed: number; taken: number }

/** How far back the per-second numbers look (the same window the dev panel's meter uses). */
const WINDOW_MS = 10_000;
/** The most rows the corner shows. */
const MAX_ROWS = 6;
const PAINT_MS = 250;

/**
 * A damage and healing meter for the HUD (the dev panel keeps its own, with more columns): who deals the most per second and in
 * all, and who heals. It listens to the same events as everything else, starts afresh with every round and moves like any other
 * HUD element (the editor: Esc menu, "Edit HUD").
 */
export class DpsMeter {
  private tally = new Map<number, Tally>();
  private now = 0;
  private paintedAt = -Infinity;

  constructor(private root: HTMLElement | null = typeof document === 'undefined' ? null : document.getElementById('dpsmeter')) {}

  reset(): void {
    this.tally.clear();
    this.paintedAt = -Infinity;
    this.root?.replaceChildren();
  }

  private of(id: number): Tally {
    let t = this.tally.get(id);
    if (!t) this.tally.set(id, (t = { dealt: 0, healed: 0, taken: 0, log: [] }));
    return t;
  }

  /** Count a batch of events (`time` is the match clock in ms). */
  feed(events: readonly SimEvent[], time: number): void {
    this.now = time;
    for (const e of events) {
      if (e.t === 'damage') {
        if (e.src > 0) {
          const a = this.of(e.src);
          a.dealt += e.amount;
          a.log.push({ t: time, d: e.amount, h: 0 });
        }
        if (e.tgt > 0) this.of(e.tgt).taken += e.amount;
      } else if (e.t === 'heal') {
        if (e.src > 0) {
          const a = this.of(e.src);
          a.healed += e.amount;
          a.log.push({ t: time, d: 0, h: e.amount });
        }
      }
    }
  }

  /** The rows, the biggest dealer first (units that did nothing yet are left out). */
  rows(units: readonly MeterUnit[]): MeterRow[] {
    const out: MeterRow[] = [];
    for (const [id, t] of this.tally) {
      const u = units.find((x) => x.id === id);
      if (!u || (!t.dealt && !t.healed)) continue;
      t.log = t.log.filter((x) => this.now - x.t <= WINDOW_MS);
      const span = Math.max(1, Math.min(WINDOW_MS / 1000, (this.now - (t.log[0]?.t ?? this.now)) / 1000));
      out.push({ id, name: u.name, team: u.team, dps: t.log.reduce((n, x) => n + x.d, 0) / span, dealt: t.dealt, hps: t.log.reduce((n, x) => n + x.h, 0) / span, healed: t.healed, taken: t.taken });
    }
    return out.sort((a, b) => b.dealt - a.dealt || b.healed - a.healed).slice(0, MAX_ROWS);
  }

  /** Draw it (at most four times a second). `you` is marked; `friendly` is the team shown in the friendly colour (null: team 0, as when spectating). */
  paint(units: readonly MeterUnit[], you: number, friendly: TeamId | null): void {
    const root = this.root;
    if (!root || this.now - this.paintedAt < PAINT_MS) return;
    this.paintedAt = this.now;
    const rows = this.rows(units);
    if (!rows.length) return void root.replaceChildren();
    const mine = friendly ?? 0;
    const top = Math.max(1, ...rows.map((r) => r.dealt));
    const frag = document.createDocumentFragment();
    const head = document.createElement('div');
    head.className = 'dm-head';
    head.textContent = 'Damage';
    frag.append(head);
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = `dm-row${r.team === mine ? ' dm-ally' : ' dm-foe'}${r.id === you ? ' dm-you' : ''}`;
      const bar = document.createElement('span');
      bar.className = 'dm-bar';
      bar.style.width = `${Math.round((r.dealt / top) * 100)}%`;
      const name = document.createElement('span');
      name.className = 'dm-name';
      name.textContent = r.name;
      const dps = document.createElement('span');
      dps.className = 'dm-dps';
      dps.textContent = String(Math.round(r.dps));
      const total = document.createElement('span');
      total.className = 'dm-total';
      total.textContent = r.healed > r.dealt ? `+${Math.round(r.healed)}` : String(Math.round(r.dealt));
      total.title = `Dealt ${Math.round(r.dealt)} · healed ${Math.round(r.healed)} (${Math.round(r.hps)}/s) · took ${Math.round(r.taken)}`;
      row.append(bar, name, dps, total);
      frag.append(row);
    }
    root.replaceChildren(frag);
  }
}
