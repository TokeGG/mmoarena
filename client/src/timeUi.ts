import { ARENAS, CLASSES, SPECS, TIME_CATS, TIME_CAT_LABEL, TIME_DAYS } from '@arena/shared';
import type { ClientMsg, ServerMsg, TimeBuckets, TimeCat, TimeGlobal, TimeRecord, TimeRow } from '@arena/shared';

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
const mapLabel = (id: string) => ARENAS.find((a) => a.id === id)?.name ?? id;

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
  private data: { global: TimeGlobal; rows: TimeRow[] } | null = null;
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
    if (m.t === 'admin_time') this.data = { global: m.global, rows: m.rows };
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
    const hours = el('div', 'tm-box');
    hours.append(el('h4', '', 'Busiest hours of the day (UTC)'));
    const row = el('div', 'tm-hours');
    const max = Math.max(1, ...g.hours);
    g.hours.forEach((ms, h) => {
      const col = el('div', 'tm-hour');
      col.title = `${String(h).padStart(2, '0')}:00 UTC: ${span(ms)}`;
      const fill = el('i');
      fill.style.height = ms ? `${Math.max(4, Math.round((ms / max) * 100))}%` : '2px';
      col.append(fill, el('small', '', h % 3 === 0 ? String(h) : ''));
      row.append(col);
    });
    hours.append(row);
    box.append(hours);
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
