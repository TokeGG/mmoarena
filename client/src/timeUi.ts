import { CLASSES, findArena, SPECS, TIME_CATS, TIME_CAT_LABEL, TIME_DAYS } from '@arena/shared';
import type { ClientMsg, HealthHour, ServerMsg, TimeBuckets, TimeCat, TimeGlobal, TimeRecord, TimeRow } from '@arena/shared';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** "3 h 05 min", "12 min", "40 s": play time as a person reads it. */
export function span(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 100 ? `${h} h ${String(m % 60).padStart(2, '0')} min` : `${h} h`;
}

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

const HOUR_MS = 3_600_000;
const pad2 = (n: number) => String(n).padStart(2, '0');

/** The three busiest hours of the day (UTC), busiest first, with their share of all counted time. */
export function busiestHours(hours: number[]): { hour: number; ms: number; share: number }[] {
  const total = hours.reduce((a, b) => a + b, 0);
  return hours
    .map((ms, hour) => ({ hour, ms, share: total ? ms / total : 0 }))
    .filter((x) => x.ms > 0)
    .sort((a, b) => b.ms - a.ms || a.hour - b.hour)
    .slice(0, 3);
}

/** How much of its tick budget the server used in one hour (1 = every tick needed the whole step). */
export const hourLoad = (h: HealthHour): number => (h.ticks && h.stepMs ? h.busyMs / (h.ticks * h.stepMs) : 0);

/** Totals over the kept hours: average and worst load, late ticks and their share, slowest tick, most people online. */
export function healthSummary(hours: HealthHour[]): { avgLoad: number; peakLoad: number; peakHour: number | null; late: number; ticks: number; lateShare: number; maxMs: number; peakOnline: number } {
  let busy = 0, budget = 0, ticks = 0, late = 0, maxMs = 0, peakOnline = 0, peakLoad = 0;
  let peakHour: number | null = null;
  for (const h of hours) {
    busy += h.busyMs;
    budget += h.ticks * h.stepMs;
    ticks += h.ticks;
    late += h.late;
    maxMs = Math.max(maxMs, h.maxMs);
    peakOnline = Math.max(peakOnline, h.peakOnline);
    const l = hourLoad(h);
    if (l > peakLoad) { peakLoad = l; peakHour = h.h; }
  }
  return { avgLoad: budget ? busy / budget : 0, peakLoad, peakHour, late, ticks, lateShare: ticks ? late / ticks : 0, maxMs, peakOnline };
}

type Col = 'total' | 'ranked' | 'practice' | 'party' | 'menu' | 'spectate' | 'last';
/** The columns of the table and what each sums up. */
const COLS: [Col, string][] = [['total', 'Total'], ['ranked', 'Ranked'], ['practice', 'Practice'], ['party', 'Party / duel'], ['menu', 'Menu'], ['spectate', 'Spectating'], ['last', 'Last seen']];

export function colValue(r: TimeRow, c: Col): number {
  switch (c) {
    case 'total': return r.total;
    case 'ranked': return r.cat.ranked;
    case 'practice': return r.cat.practice;
    case 'party': return r.cat.party + r.cat.duel;
    case 'menu': return r.cat.menu + r.cat.queue;
    case 'spectate': return r.cat.spectate;
    case 'last': return r.last;
  }
}

/** Rows sorted by a column, biggest first. */
export function sortRows(rows: TimeRow[], c: Col): TimeRow[] {
  return [...rows].sort((a, b) => colValue(b, c) - colValue(a, c) || b.total - a.total);
}

export interface BarRow { label: string; ms: number }

/** The largest entries of a bucket, biggest first. */
export function topBars(b: TimeBuckets, label: (k: string) => string, max = 12): BarRow[] {
  return Object.entries(b).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).slice(0, max).map(([k, v]) => ({ label: label(k), ms: v }));
}

const className = (id: string) => CLASSES[id as keyof typeof CLASSES]?.name ?? id;
const specName = (k: string) => {
  const [c, s] = k.split(':');
  const spec = SPECS[c as keyof typeof SPECS]?.find((x) => x.id === s);
  return `${spec?.name ?? s} ${className(c)}`;
};
const mapLabel = (id: string) => findArena(id)?.name ?? id;

/** The last `n` days (UTC) ending today, oldest first, with zero for days nobody played. */
export function lastDays(days: TimeBuckets, n = TIME_DAYS, now = Date.now()): { key: string; ms: number }[] {
  const out: { key: string; ms: number }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const key = new Date(now - i * 86400_000).toISOString().slice(0, 10).replace(/-/g, '');
    out.push({ key, ms: days[key] ?? 0 });
  }
  return out;
}

/** The owner's Play time tab: the server at a glance, a table of players by time, and one player's breakdown. */
export class TimeView {
  private data: { global: TimeGlobal; rows: TimeRow[]; health: HealthHour[] } | null = null;
  private detail: { name: string; rec: TimeRecord | null } | null = null;
  private sort: Col = 'total';
  private query = '';
  private picked = '';

  constructor(private send: (m: ClientMsg) => void, private repaint: () => void) {}

  /** Ask for the table (and the picked player, if any). */
  refresh(): void {
    this.send({ t: 'admin_act', act: 'time' });
    if (this.picked) this.send({ t: 'admin_act', act: 'time', name: this.picked });
  }

  handle(m: ServerMsg): boolean {
    if (m.t === 'admin_time') this.data = { global: m.global, rows: m.rows, health: m.health ?? [] };
    else if (m.t === 'admin_time_player') {
      if (m.name.toLowerCase() === this.picked.toLowerCase()) this.detail = { name: m.name, rec: m.rec };
    } else return false;
    return true;
  }

  private bars(title: string, rows: BarRow[], total: number): HTMLElement {
    const box = el('div', 'tm-box');
    box.append(el('h4', '', title));
    if (!rows.length) box.append(el('small', 'tm-none', 'Nothing yet.'));
    const max = Math.max(1, ...rows.map((r) => r.ms));
    for (const r of rows) {
      const line = el('div', 'tm-line');
      const bar = el('div', 'tm-bar');
      const fill = el('i');
      fill.style.width = `${Math.max(1, Math.round((r.ms / max) * 100))}%`;
      bar.append(fill);
      line.append(el('span', 'tm-lbl', r.label), bar, el('span', 'tm-val', `${span(r.ms)}${total > 0 ? ` · ${Math.round((r.ms / total) * 100)}%` : ''}`));
      box.append(line);
    }
    return box;
  }

  private catBars(cat: Record<TimeCat, number>, total: number): HTMLElement {
    return this.bars('Where the time goes', TIME_CATS.map((c) => ({ label: TIME_CAT_LABEL[c], ms: cat[c] })).filter((r) => r.ms > 0).sort((a, b) => b.ms - a.ms), total);
  }

  private dayBars(days: TimeBuckets): HTMLElement {
    const box = el('div', 'tm-box');
    box.append(el('h4', '', `Last ${TIME_DAYS} days (UTC)`));
    const list = lastDays(days);
    const max = Math.max(1, ...list.map((d) => d.ms));
    const row = el('div', 'tm-days');
    for (const d of list) {
      const col = el('div', 'tm-day');
      col.title = `${d.key.slice(0, 4)}-${d.key.slice(4, 6)}-${d.key.slice(6)}: ${d.ms ? span(d.ms) : 'no play'}`;
      const fill = el('i');
      fill.style.height = d.ms ? `${Math.max(4, Math.round((d.ms / max) * 100))}%` : '2px';
      col.append(fill);
      row.append(col);
    }
    box.append(row, el('small', 'tm-none', `Busiest day ${span(max === 1 ? 0 : max)}; ${list.filter((d) => d.ms).length} of ${TIME_DAYS} days played.`));
    return box;
  }

  /** Show the hours of the day in this browser's time zone instead of UTC. */
  private local = false;

  private hoursChart(utc: number[]): HTMLElement {
    const box = el('div', 'tm-box');
    const offset = this.local ? -Math.round(new Date().getTimezoneOffset() / 60) : 0;
    const zone = this.local ? 'your time' : 'UTC';
    // the bar for local hour L holds UTC hour L - offset
    const hours = Array.from({ length: 24 }, (_, l) => utc[(((l - offset) % 24) + 24) % 24] ?? 0);
    const head = el('div', 'tm-hhead');
    head.append(el('h4', '', `Busiest hours of the day (${zone})`));
    const toggle = el('button', 'mm-small', this.local ? 'Show UTC' : 'Show my time');
    toggle.addEventListener('click', () => {
      this.local = !this.local;
      this.repaint();
    });
    head.append(toggle);
    box.append(head);
    const top = busiestHours(hours);
    if (!top.length) {
      box.append(el('small', 'tm-none', 'No play time counted yet.'));
      return box;
    }
    const range = (h: number) => `${pad2(h)}:00-${pad2((h + 1) % 24)}:00`;
    box.append(el('div', 'tm-hbest', `Busiest: ${range(top[0].hour)} ${zone}, ${span(top[0].ms)} (${Math.round(top[0].share * 100)}% of all play)${top.length > 1 ? `. Next: ${top.slice(1).map((x) => `${range(x.hour)} (${Math.round(x.share * 100)}%)`).join(', ')}` : ''}`));
    const row = el('div', 'tm-hours');
    const max = Math.max(1, ...hours);
    const rank = new Map(top.map((x, i) => [x.hour, i]));
    hours.forEach((ms, h) => {
      const col = el('div', `tm-hour${rank.has(h) ? ` top${rank.get(h)}` : ''}`);
      col.title = `${range(h)} ${zone}: ${span(ms)}${rank.has(h) ? ` (busiest #${rank.get(h)! + 1})` : ''}`;
      const fill = el('i');
      fill.style.height = ms ? `${Math.max(4, Math.round((ms / max) * 100))}%` : '2px';
      col.append(fill);
      if (rank.has(h)) col.append(el('em', '', `#${rank.get(h)! + 1}`));
      col.append(el('small', '', pad2(h)));
      row.append(col);
    });
    box.append(row);
    return box;
  }

  /** Server load and losses per hour for the last three days: how much of its step each tick used, and how many were late. */
  private healthBox(): HTMLElement {
    const box = el('div', 'tm-box');
    const list = this.data?.health ?? [];
    box.append(el('h4', '', 'Server load and losses (last 72 hours, UTC)'));
    if (!list.length) {
      box.append(el('small', 'tm-none', 'Nothing recorded yet: the server starts counting when it runs, one record per hour.'));
      return box;
    }
    const sum = healthSummary(list);
    const cards = el('div', 'admp-stats');
    const stat = (v: string, k: string, cls = '') => {
      const c = el('div', `admp-stat ${cls}`);
      c.append(el('b', '', v), el('small', '', k));
      cards.append(c);
    };
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    stat(pct(sum.avgLoad), 'Average load', sum.avgLoad > 0.7 ? 'bad' : '');
    stat(pct(sum.peakLoad), sum.peakHour === null ? 'Busiest hour load' : `Load at its worst (${pad2(sum.peakHour % 24)}:00 UTC)`, sum.peakLoad > 0.7 ? 'bad' : '');
    stat(`${sum.late}`, `Late ticks (${sum.ticks ? `${(sum.lateShare * 100).toFixed(sum.lateShare < 0.001 ? 3 : 2)}%` : '0%'} of all ticks)`, sum.late > 0 ? 'warn' : '');
    stat(`${Math.round(sum.maxMs)} ms`, 'Slowest single tick');
    stat(String(sum.peakOnline), 'Most people online');
    box.append(cards);
    box.append(el('small', 'tm-none', 'Load is how much of its step the server needed for each tick: 100% means it could not keep up. A late tick took longer than its step or started more than a step late, so everyone sees a small hitch.'));
    // one bar per hour for the last 72 hours, empty hours kept as gaps
    const last = list[list.length - 1].h;
    const byH = new Map(list.map((x) => [x.h, x]));
    const hoursList = Array.from({ length: 72 }, (_, i) => last - 71 + i);
    const chart = (title: string, value: (h: HealthHour) => number, fmt: (h: HealthHour) => string, cls: (h: HealthHour) => string, scaleMin: number) => {
      const wrap = el('div', 'tm-hchart');
      wrap.append(el('small', 'tm-hlabel', title));
      const row = el('div', 'tm-hours tm-long');
      const max = Math.max(scaleMin, ...list.map(value));
      hoursList.forEach((hr) => {
        const h = byH.get(hr);
        const col = el('div', `tm-hour${h ? ` ${cls(h)}` : ' gap'}`);
        const when = new Date(hr * HOUR_MS);
        col.title = h ? `${when.toISOString().slice(5, 10)} ${pad2(when.getUTCHours())}:00 UTC: ${fmt(h)} · slowest tick ${Math.round(h.maxMs)} ms · up to ${h.peakOnline} online` : `${when.toISOString().slice(5, 10)} ${pad2(when.getUTCHours())}:00 UTC: not recorded`;
        const fill = el('i');
        fill.style.height = h && value(h) > 0 ? `${Math.max(4, Math.round((value(h) / max) * 100))}%` : '2px';
        col.append(fill);
        if (when.getUTCHours() % 6 === 0) col.append(el('small', '', when.getUTCHours() === 0 ? when.toISOString().slice(5, 10) : pad2(when.getUTCHours())));
        row.append(col);
      });
      wrap.append(row);
      return wrap;
    };
    box.append(
      chart('Load (percent of the step used)', hourLoad, (h) => `load ${Math.round(hourLoad(h) * 100)}%`, (h) => (hourLoad(h) > 0.7 ? 'hot' : hourLoad(h) > 0.4 ? 'warm' : 'cool'), 1),
      chart('Losses (late ticks per hour)', (h) => h.late, (h) => `${h.late} late tick${h.late === 1 ? '' : 's'} of ${h.ticks}`, (h) => (h.late > 0 ? 'hot' : 'cool'), 5),
    );
    return box;
  }

  private summary(g: TimeGlobal): HTMLElement {
    const box = el('div', 'tm-sum');
    const cards = el('div', 'admp-stats');
    const stat = (v: string, k: string) => {
      const c = el('div', 'admp-stat');
      c.append(el('b', '', v), el('small', '', k));
      cards.append(c);
    };
    stat(span(g.total), 'Played in all');
    stat(String(g.sessions), 'Sessions');
    stat(span(g.guests.total), 'By guests');
    stat(span(g.cat.ranked), 'Ranked');
    box.append(cards, this.catBars(g.cat, g.total));
    const grid = el('div', 'tm-grid');
    const matchTotal = g.cat.practice + g.cat.party + g.cat.duel + g.cat.ranked + g.cat.dev;
    grid.append(this.bars('Most played classes', topBars(g.cls, className), matchTotal), this.bars('Most played specs', topBars(g.spec, specName, 8), matchTotal), this.bars('Arenas', topBars(g.map, mapLabel), matchTotal), this.bars('Modes', topBars(g.mode, (k) => k), matchTotal));
    box.append(grid);
    box.append(this.hoursChart(g.hours));
    box.append(this.healthBox());
    box.append(el('small', 'tm-none', `Counting since ${new Date(g.since).toLocaleDateString()}. Guests are one anonymous group: their time is in the totals above, not in the table.`));
    return box;
  }

  private player(name: string, rec: TimeRecord | null): HTMLElement {
    const box = el('div', 'tm-detail');
    const head = el('div', 'tm-dhead');
    const close = el('button', 'mm-small', 'Close');
    close.addEventListener('click', () => {
      this.picked = '';
      this.detail = null;
      this.repaint();
    });
    head.append(el('h3', '', name), close);
    box.append(head);
    if (!rec) {
      box.append(el('p', 'mm-modal-foot', 'No play time recorded for this account yet.'));
      return box;
    }
    box.append(el('small', 'tm-none', `${span(rec.total)} played · ${rec.sessions} session${rec.sessions === 1 ? '' : 's'} · first seen ${new Date(rec.first).toLocaleDateString()} · last seen ${ago(rec.last)} · ${span(rec.idle)} idle (not counted)`));
    const matchTotal = rec.cat.practice + rec.cat.party + rec.cat.duel + rec.cat.ranked + rec.cat.dev;
    const grid = el('div', 'tm-grid');
    grid.append(this.catBars(rec.cat, rec.total), this.bars('Classes', topBars(rec.cls, className), matchTotal), this.bars('Specs', topBars(rec.spec, specName, 10), matchTotal), this.bars('Arenas', topBars(rec.map, mapLabel), matchTotal), this.bars('Modes', topBars(rec.mode, (k) => k), matchTotal));
    box.append(grid, this.dayBars(rec.days));
    return box;
  }

  render(): HTMLElement {
    const root = el('div', 'tm');
    if (!this.data) {
      root.append(el('p', 'mm-modal-foot', 'Loading play time...'));
      return root;
    }
    root.append(el('p', 'mm-modal-foot', 'Time on the server per signed-in account, counted by the server (not the client). A menu with no input for 5 minutes stops counting. No addresses or locations are kept here.'));
    root.append(this.summary(this.data.global));
    if (this.picked) root.append(this.detail ? this.player(this.detail.name, this.detail.rec) : el('p', 'mm-modal-foot', 'Loading...'));
    root.append(el('h3', '', `Players by time (${this.data.rows.length})`));
    const search = el('input', 'mm-input') as HTMLInputElement;
    search.placeholder = 'Search a name';
    search.value = this.query;
    search.addEventListener('input', () => {
      this.query = search.value;
      this.fillTable(tbody);
    });
    const table = el('table', 'tm-table');
    const hr = el('tr');
    hr.append(el('th', '', 'Player'));
    for (const [c, label] of COLS) {
      const th = el('th', `tm-sortable${c === this.sort ? ' sel' : ''}`, label);
      th.addEventListener('click', () => {
        this.sort = c;
        this.repaint();
      });
      hr.append(th);
    }
    const thead = el('thead');
    thead.append(hr);
    const tbody = el('tbody');
    table.append(thead, tbody);
    this.fillTable(tbody);
    root.append(search, table);
    return root;
  }

  private fillTable(tbody: HTMLElement): void {
    tbody.replaceChildren();
    const q = this.query.trim().toLowerCase();
    const rows = sortRows(this.data?.rows ?? [], this.sort).filter((r) => !q || r.name.toLowerCase().includes(q));
    for (const r of rows) {
      const tr = el('tr', r.name.toLowerCase() === this.picked.toLowerCase() ? 'sel' : '');
      tr.append(el('td', '', `${r.online ? '● ' : ''}${r.name}`));
      for (const [c] of COLS) tr.append(el('td', c === 'last' ? 'tm-ago' : 'tm-num', c === 'last' ? (r.online ? 'online' : ago(r.last)) : span(colValue(r, c))));
      tr.addEventListener('click', () => {
        this.picked = r.name;
        this.detail = null;
        this.send({ t: 'admin_act', act: 'time', name: r.name });
        this.repaint();
      });
      tbody.append(tr);
    }
    if (!rows.length) {
      const tr = el('tr');
      const td = el('td', '', this.data?.rows.length ? 'No player matches.' : 'Nobody has been counted yet.');
      td.colSpan = COLS.length + 1;
      tr.append(td);
      tbody.append(tr);
    }
  }
}
