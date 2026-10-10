import { AURAS } from '@arena/shared';
import type { SimEvent, TeamId } from '@arena/shared';

/** Everything the meter counts for a unit since the round started; the last ten seconds of damage, healing and damage taken are kept for the per-second numbers. */
interface Tally {
  dealt: number;
  healed: number;
  taken: number;
  overheal: number;
  absorbed: number;
  interrupts: number;
  dispels: number;
  cc: number;
  kills: number;
  deaths: number;
  casts: number;
  log: { t: number; k: 'd' | 'h' | 't'; v: number }[];
}

export type MeterMetric = 'damage' | 'healing' | 'taken' | 'overheal' | 'absorbed' | 'interrupts' | 'dispels' | 'cc' | 'kills' | 'deaths' | 'casts';
export type MeterNumbers = 'both' | 'total' | 'rate';
export type MeterWho = 'all' | 'mine' | 'foes';

/** What the meter can show. `rate`: it also has a per-second number (the last ten seconds). */
export const METRICS: { id: MeterMetric; label: string; hint: string; rate: boolean }[] = [
  { id: 'damage', label: 'Damage done', hint: 'what each unit dealt', rate: true },
  { id: 'healing', label: 'Healing done', hint: 'what each unit healed (without the overhealing)', rate: true },
  { id: 'taken', label: 'Damage taken', hint: 'what each unit took', rate: true },
  { id: 'overheal', label: 'Overhealing', hint: 'healing that went past full health', rate: false },
  { id: 'absorbed', label: 'Damage absorbed', hint: 'what shields and barriers soaked up for each unit', rate: false },
  { id: 'interrupts', label: 'Interrupts', hint: 'casts each unit stopped', rate: false },
  { id: 'dispels', label: 'Dispels', hint: 'effects each unit removed from others', rate: false },
  { id: 'cc', label: 'Crowd control', hint: 'stuns, fears, sheep and roots each unit landed', rate: false },
  { id: 'kills', label: 'Kills', hint: 'who got the killing blows', rate: false },
  { id: 'deaths', label: 'Deaths', hint: 'who fell', rate: false },
  { id: 'casts', label: 'Spells cast', hint: 'how many spells each unit finished casting', rate: false },
];

export interface MeterUnit { id: number; name: string; team: TeamId }
export interface MeterRow { id: number; name: string; team: TeamId; value: number; rate: number | null; tally: Omit<Tally, 'log'> }
export interface MeterOptions { metric: MeterMetric; rows: number; who: MeterWho; numbers: MeterNumbers; friendly: TeamId }

/** How far back the per-second numbers look (the same window the dev panel's meter uses). */
const WINDOW_MS = 10_000;
const PAINT_MS = 250;
const CC_KINDS = new Set(['stun', 'incapacitate', 'fear', 'root']);
export const DEFAULT_OPTIONS: MeterOptions = { metric: 'damage', rows: 5, who: 'all', numbers: 'both', friendly: 0 };

const blank = (): Tally => ({ dealt: 0, healed: 0, taken: 0, overheal: 0, absorbed: 0, interrupts: 0, dispels: 0, cc: 0, kills: 0, deaths: 0, casts: 0, log: [] });

const totalOf = (t: Tally, m: MeterMetric): number => {
  switch (m) {
    case 'damage': return t.dealt;
    case 'healing': return t.healed;
    case 'taken': return t.taken;
    case 'overheal': return t.overheal;
    case 'absorbed': return t.absorbed;
    case 'interrupts': return t.interrupts;
    case 'dispels': return t.dispels;
    case 'cc': return t.cc;
    case 'kills': return t.kills;
    case 'deaths': return t.deaths;
    case 'casts': return t.casts;
  }
};

/**
 * A meter for the HUD (the dev panel keeps its own, with more columns). What it shows is the player's choice: damage, healing,
 * damage taken, overhealing, absorbs, interrupts, dispels, crowd control, kills, deaths or spells cast, for everyone, your team or
 * the enemy. It starts afresh with every round and moves like any other HUD element (Esc menu, "Edit HUD"); what it shows is set
 * there too, in the Look window, or by clicking its header.
 */
export class DpsMeter {
  private tally = new Map<number, Tally>();
  private now = 0;
  private paintedAt = -Infinity;
  /** Called when the header is clicked: the owner of the settings moves to the next thing to show. */
  onCycle: (() => void) | null = null;

  constructor(private root: HTMLElement | null = typeof document === 'undefined' ? null : document.getElementById('dpsmeter')) {}

  reset(): void {
    this.tally.clear();
    this.paintedAt = -Infinity;
    this.root?.replaceChildren();
  }

  private of(id: number): Tally {
    let t = this.tally.get(id);
    if (!t) this.tally.set(id, (t = blank()));
    return t;
  }

  /** Count a batch of events (`time` is the match clock in ms). */
  feed(events: readonly SimEvent[], time: number): void {
    this.now = time;
    for (const e of events) {
      switch (e.t) {
        case 'damage':
          if (e.src > 0) {
            const a = this.of(e.src);
            a.dealt += e.amount;
            a.log.push({ t: time, k: 'd', v: e.amount });
          }
          if (e.tgt > 0) {
            const b = this.of(e.tgt);
            b.taken += e.amount;
            b.absorbed += e.absorbed ?? 0;
            b.log.push({ t: time, k: 't', v: e.amount });
          }
          break;
        case 'heal':
          if (e.src > 0) {
            const a = this.of(e.src);
            a.healed += e.amount;
            a.overheal += e.overheal ?? 0;
            a.log.push({ t: time, k: 'h', v: e.amount });
          }
          break;
        case 'interrupt':
          if (e.src > 0) this.of(e.src).interrupts++;
          break;
        case 'dispel':
          if (e.src > 0) this.of(e.src).dispels++;
          break;
        case 'aura':
          if (e.src > 0 && e.src !== e.tgt && e.dr > 0 && CC_KINDS.has(AURAS[e.aura]?.kind ?? '')) this.of(e.src).cc++;
          break;
        case 'cast':
          if (e.unit > 0) this.of(e.unit).casts++;
          break;
        case 'death':
          if (e.unit > 0) this.of(e.unit).deaths++;
          if (e.killer !== null && e.killer > 0 && e.killer !== e.unit) this.of(e.killer).kills++;
          break;
      }
    }
  }

  private perSecond(t: Tally, k: 'd' | 'h' | 't'): number {
    t.log = t.log.filter((x) => this.now - x.t <= WINDOW_MS);
    const mine = t.log.filter((x) => x.k === k);
    if (!mine.length) return 0;
    const span = Math.max(1, Math.min(WINDOW_MS / 1000, (this.now - mine[0].t) / 1000));
    return mine.reduce((n, x) => n + x.v, 0) / span;
  }

  /** The rows for what is being shown, the biggest first (a unit with nothing to show yet is left out). */
  rows(units: readonly MeterUnit[], o: Partial<MeterOptions> = {}): MeterRow[] {
    const opt = { ...DEFAULT_OPTIONS, ...o };
    const out: MeterRow[] = [];
    for (const [id, t] of this.tally) {
      const u = units.find((x) => x.id === id);
      if (!u) continue;
      if (opt.who === 'mine' && u.team !== opt.friendly) continue;
      if (opt.who === 'foes' && u.team === opt.friendly) continue;
      const value = totalOf(t, opt.metric);
      if (!value) continue;
      const k = opt.metric === 'damage' ? 'd' : opt.metric === 'healing' ? 'h' : opt.metric === 'taken' ? 't' : null;
      out.push({ id, name: u.name, team: u.team, value, rate: k ? this.perSecond(t, k) : null, tally: { dealt: t.dealt, healed: t.healed, taken: t.taken, overheal: t.overheal, absorbed: t.absorbed, interrupts: t.interrupts, dispels: t.dispels, cc: t.cc, kills: t.kills, deaths: t.deaths, casts: t.casts } });
    }
    return out.sort((a, b) => b.value - a.value).slice(0, Math.max(1, opt.rows));
  }

  /** Draw it (at most four times a second). `you` is marked; `o.friendly` is the team shown in the friendly colour (0 when spectating). */
  paint(units: readonly MeterUnit[], you: number, o: Partial<MeterOptions> = {}): void {
    const root = this.root;
    if (!root || this.now - this.paintedAt < PAINT_MS) return;
    this.paintedAt = this.now;
    const opt = { ...DEFAULT_OPTIONS, ...o };
    const rows = this.rows(units, opt);
    if (!rows.length) return void root.replaceChildren();
    const metric = METRICS.find((m) => m.id === opt.metric) ?? METRICS[0];
    const top = Math.max(1, ...rows.map((r) => r.value));
    const frag = document.createDocumentFragment();
    const head = document.createElement('div');
    head.className = 'dm-head';
    head.textContent = metric.label;
    head.title = `${metric.hint}. Click to show something else (more in Edit HUD and the Look window).`;
    head.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.buttons !== 1) return;
      e.stopPropagation();
      this.onCycle?.();
    });
    frag.append(head);
    const num = (n: number) => String(Math.round(n));
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = `dm-row${r.team === opt.friendly ? ' dm-ally' : ' dm-foe'}${r.id === you ? ' dm-you' : ''}`;
      const bar = document.createElement('span');
      bar.className = 'dm-bar';
      bar.style.width = `${Math.round((r.value / top) * 100)}%`;
      const name = document.createElement('span');
      name.className = 'dm-name';
      name.textContent = r.name;
      row.append(bar, name);
      const showRate = r.rate !== null && opt.numbers !== 'total';
      const showTotal = opt.numbers !== 'rate' || r.rate === null;
      if (showRate) {
        const rate = document.createElement('span');
        rate.className = 'dm-dps';
        rate.textContent = num(r.rate!);
        rate.title = 'per second over the last ten seconds';
        row.append(rate);
      }
      if (showTotal) {
        const total = document.createElement('span');
        total.className = showRate ? 'dm-total' : 'dm-dps';
        total.textContent = num(r.value);
        total.title = `Dealt ${num(r.tally.dealt)} · healed ${num(r.tally.healed)} (overheal ${num(r.tally.overheal)}) · took ${num(r.tally.taken)} (absorbed ${num(r.tally.absorbed)}) · ${r.tally.kills} kills, ${r.tally.deaths} deaths · ${r.tally.interrupts} interrupts, ${r.tally.dispels} dispels, ${r.tally.cc} crowd control`;
        row.append(total);
      }
      frag.append(row);
    }
    root.replaceChildren(frag);
  }
}
