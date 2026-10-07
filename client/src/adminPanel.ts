import type { AccountInfo, AdminLogRow, ClientMsg, ServerMsg } from '@arena/shared';
import { OwnerPanel } from './ownerUi';
import type { Popup } from './popups';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

type Tab = 'dashboard' | 'players' | 'matches' | 'moderation' | 'tuning' | 'server' | 'log';
const TABS: [Tab, string][] = [
  ['dashboard', 'Dashboard'],
  ['players', 'Players'],
  ['matches', 'Matches'],
  ['moderation', 'Moderation'],
  ['tuning', 'Tuning'],
  ['server', 'Server'],
  ['log', 'Log'],
];

interface Hooks {
  send(m: ClientMsg): void;
  token(): string;
  account(): AccountInfo | null;
  watch(id: string): void;
  follow(name: string): void;
}

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
const dur = (ms: number) => {
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/**
 * The owner's admin panel, a window of its own: the server at a glance, every player (search, moderation, unlocks,
 * history), every match (watch, pause, end), the suggestion box, tuning (live number changes, bot matches),
 * announcements and maintenance mode, and a log of every admin action. The server checks every action again.
 */
export class AdminPanel {
  private root: HTMLElement | null = null;
  private tab: Tab = 'dashboard';
  private log: AdminLogRow[] | null = null;
  private suggestions: { at: number; name: string; text: string; note?: string }[] | null = null;
  private maintText = '';
  /** The same tools as the profile's Owner tab (players, matches, tuning), drawn here. */
  private op: OwnerPanel;
  readonly popup: Popup = { isOpen: () => !!this.root, close: () => this.close(), el: () => this.root };

  constructor(private hooks: Hooks) {
    this.op = new OwnerPanel({ send: hooks.send, token: hooks.token, rerender: () => this.paint(), watch: (id) => { this.close(); hooks.watch(id); }, follow: (n) => hooks.follow(n) });
  }

  get isOpen(): boolean {
    return !!this.root;
  }

  open(tab?: Tab) {
    if (tab) this.tab = tab;
    if (!this.root) {
      this.root = el('div', 'admp');
      this.root.addEventListener('mousedown', (e) => e.target === this.root && this.close());
      document.body.append(this.root);
    }
    this.refresh();
    this.paint();
  }

  close() {
    this.root?.remove();
    this.root = null;
  }

  /** Ask the server for what the current tab shows. */
  private refresh() {
    if (!this.hooks.account()?.ownerOk) return;
    const s = this.hooks.send;
    s({ t: 'admin_overview' });
    if (this.tab === 'players') s({ t: 'admin_list' });
    if (this.tab === 'dashboard' || this.tab === 'log') s({ t: 'admin_act', act: 'log' });
    if (this.tab === 'moderation') s({ t: 'suggestions' });
  }

  handle(m: ServerMsg) {
    switch (m.t) {
      case 'admin_log':
        this.log = m.rows;
        break;
      case 'suggestions':
        this.suggestions = m.rows;
        break;
      case 'owner':
        if (m.ok) this.refresh();
        break;
    }
    this.op.handle(m);
    if (m.t === 'admin_overview' && m.maintenance && !this.maintText) this.maintText = m.maintenance;
    if (this.root) this.paint();
  }

  private paint() {
    const r = this.root;
    if (!r) return;
    const a = this.hooks.account();
    const card = el('div', 'admp-card');
    const head = el('div', 'admp-head');
    const o = this.op.overview;
    head.append(el('h2', '', '🛡 Admin'), el('span', 'admp-status', o ? `${o.online} online · ${o.rooms.length} match${o.rooms.length === 1 ? '' : 'es'} · v${o.version ?? '?'}${o.maintenance ? ' · 🛠 maintenance' : ''}` : ''));
    const refresh = el('button', 'mm-small', '↻');
    refresh.title = 'Refresh';
    refresh.addEventListener('click', () => this.refresh());
    const close = el('button', 'mm-small', 'Close');
    close.addEventListener('click', () => this.close());
    head.append(refresh, close);
    card.append(head);

    if (!a || a.role !== 'owner') {
      card.append(el('p', 'mm-modal-foot', 'Only the founder account can use the admin panel.'));
      r.replaceChildren(card);
      return;
    }
    if (!a.ownerOk) {
      // the unlock form of the Owner tab
      card.append(this.op.render(a));
      r.replaceChildren(card);
      return;
    }

    const tabs = el('div', 'admp-tabs');
    for (const [id, label] of TABS) {
      const b = el('button', `admp-tab${id === this.tab ? ' sel' : ''}`, label);
      b.addEventListener('click', () => {
        this.tab = id;
        this.refresh();
        this.paint();
      });
      tabs.append(b);
    }
    const body = el('div', 'admp-body');
    switch (this.tab) {
      case 'dashboard':
        body.append(this.dashboard());
        break;
      case 'players':
        body.append(el('p', 'mm-modal-foot', 'Click a player for moderation (kick, ban, mute), rating and stats, unlocks and the dev tag, a private note and their recent matches.'), this.op.adminList());
        break;
      case 'matches':
        body.append(this.op.serverBox());
        break;
      case 'moderation':
        body.append(this.moderation());
        break;
      case 'tuning':
        body.append(el('h3', '', 'Live number changes'), this.op.overridesBox(), el('h3', '', 'Bot match'), this.op.botMatch());
        break;
      case 'server':
        body.append(el('h3', '', 'Announcement'), this.op.announceBox(), el('h3', '', 'Maintenance mode'), this.maintenance());
        break;
      case 'log':
        body.append(this.logList(this.log ?? [], 300));
        break;
    }
    card.append(tabs, body);
    r.replaceChildren(card);
  }

  private dashboard(): HTMLElement {
    const box = el('div', 'admp-dash');
    const o = this.op.overview;
    const kinds = (k: string) => o?.rooms.filter((x) => x.kind === k).length ?? 0;
    const cards: [string, string][] = o
      ? [
          ['Online', String(o.online)],
          ['In queue', String(o.queued)],
          ['Matches', String(o.rooms.length)],
          ['Ranked', String(kinds('ranked'))],
          ['Practice', String(kinds('practice') + kinds('dummies') + kinds('party'))],
          ['Bot matches', String(kinds('bots'))],
          ['Uptime', o.uptimeMs !== undefined ? dur(o.uptimeMs) : '?'],
          ['Number changes', String(o.overrides ?? 0)],
        ]
      : [];
    const grid = el('div', 'admp-stats');
    for (const [k, v] of cards) {
      const c = el('div', 'admp-stat');
      c.append(el('b', '', v), el('small', '', k));
      grid.append(c);
    }
    box.append(grid);
    if (o?.maintenance) box.append(el('div', 'adm-state warn', `🛠 Maintenance mode is on: ${o.maintenance}`));
    box.append(el('h3', '', 'Recent admin actions'), this.logList(this.log ?? [], 10));
    return box;
  }

  private logList(rows: AdminLogRow[], max: number): HTMLElement {
    const ul = el('ul', 'admp-log');
    for (const row of rows.slice(0, max)) {
      const li = el('li');
      li.append(el('small', '', `${new Date(row.at).toLocaleString()} (${ago(row.at)})`), el('span', '', ` ${row.by}: ${row.action}${row.target ? ` · ${row.target}` : ''}${row.detail ? ` · ${row.detail}` : ''}`));
      ul.append(li);
    }
    if (!rows.length) ul.append(el('li', '', 'Nothing logged yet.'));
    return ul;
  }

  /** The suggestion box and skill notes, newest first, with delete. */
  private moderation(): HTMLElement {
    const box = el('div');
    box.append(el('h3', '', 'Suggestion box and skill notes'));
    if (!this.suggestions) {
      box.append(el('p', 'mm-modal-foot', 'Loading…'));
      return box;
    }
    if (!this.suggestions.length) box.append(el('p', 'mm-modal-foot', 'The box is empty.'));
    for (const s of this.suggestions) {
      const row = el('div', 'own-room');
      const info = el('div', 'own-room-info');
      info.append(el('b', '', `${s.name} · ${new Date(s.at).toLocaleString()}`), el('span', 'admp-wrap', s.text));
      if (s.note) info.append(el('small', '', `+ attached note (${s.note.length} characters)`));
      const del = el('button', 'mm-small', 'Delete');
      del.addEventListener('click', () => {
        this.hooks.send({ t: 'suggest_delete', at: s.at, text: s.text });
        this.suggestions = this.suggestions!.filter((x) => x !== s);
        this.paint();
      });
      row.append(info, del);
      box.append(row);
    }
    return box;
  }

  /** While on, only the owner can start matches; everyone online is told, and new players see the message. */
  private maintenance(): HTMLElement {
    const box = el('div', 'own-box');
    const on = !!this.op.overview?.maintenance;
    box.append(el('p', 'mm-modal-foot', on ? `On: "${this.op.overview!.maintenance}". Nobody but you can start a match.` : 'Off. Turning it on stops everyone but you from starting matches (matches already running finish) and tells everyone online.'));
    const row = el('div', 'own-row');
    const input = el('input');
    input.type = 'text';
    input.maxLength = 200;
    input.placeholder = 'Message (e.g. Updating, back in 10 minutes)';
    input.value = this.maintText;
    input.addEventListener('input', () => (this.maintText = input.value));
    const go = el('button', `mm-small${on ? '' : ' adm-danger'}`, on ? 'Turn off' : 'Turn on');
    go.addEventListener('click', () => this.hooks.send({ t: 'admin_act', act: 'maintenance', on: !on, text: input.value }));
    row.append(input, go);
    box.append(row);
    return box;
  }
}
