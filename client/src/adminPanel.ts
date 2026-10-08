import { CLASSES } from '@arena/shared';
import type { AccountInfo, AdminLogRow, ClientMsg, MatchRecord, ServerMsg } from '@arena/shared';
import { OwnerPanel } from './ownerUi';
import { mapName } from './spectate';
import type { Popup } from './popups';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

type Tab = 'dashboard' | 'players' | 'matches' | 'replays' | 'moderation' | 'tuning' | 'server' | 'log';
const TABS: [Tab, string][] = [
  ['dashboard', 'Dashboard'],
  ['players', 'Players'],
  ['matches', 'Live matches'],
  ['replays', 'Replays'],
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
  /** Play a stored replay. */
  replay(id: string): void;
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
  /** Every match played on the server (newest first), with its replay. */
  private feed: MatchRecord[] | null = null;
  private feedFilter: 'all' | 'people' | 'bots' | 'ranked' = 'all';
  private trainMsg: { ok: boolean; text: string } | null = null;
  private training = new Set<string>();
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
    if (this.tab === 'replays') s({ t: 'admin_act', act: 'feed' });
  }

  handle(m: ServerMsg) {
    switch (m.t) {
      case 'admin_log':
        this.log = m.rows;
        break;
      case 'suggestions':
        this.suggestions = m.rows;
        break;
      case 'admin_feed':
        this.feed = m.rows;
        break;
      case 'dev_result':
        if (this.tab === 'replays') {
          this.trainMsg = { ok: m.ok, text: m.text };
          this.training.clear();
        }
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
        body.append(el('p', 'mm-modal-foot', 'Every match running now, bot matches included. Watch one, pause it to change numbers (F2 while watching), or end it.'), this.op.serverBox());
        break;
      case 'replays':
        body.append(this.replays());
        break;
      case 'moderation':
        body.append(this.moderation());
        break;
      case 'tuning':
        body.append(el('h3', '', 'Live number changes'), this.prState(), this.op.overridesBox(), el('h3', '', 'Bot match'), el('p', 'mm-modal-foot', 'Bot matches show live on the Watch tab, and every one is kept under Replays, where you can train the bots on it.'), this.op.botMatch());
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
    if (o) box.append(this.prState());
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

  /** Whether "Save for everyone" can open pull requests and skill notes reach Discord (server settings). */
  private prState(): HTMLElement {
    const o = this.op.overview;
    const box = el('div', 'admp-env');
    const pr = o?.pullRequests;
    const notes = o?.notes;
    box.append(
      el('div', `adm-state ${pr ? 'ok' : 'warn'}`, pr ? '✔ Saving numbers for everyone also opens a GitHub pull request.' : '⚠ No GITHUB_TOKEN on the server: saved numbers go live, but no pull request is opened. Set GITHUB_TOKEN (a fine-grained token for the repository with Contents and Pull requests: read and write) in the server\'s environment and restart it.'),
      el('div', `adm-state ${notes ? 'ok' : 'warn'}`, notes ? '✔ Skill notes go to Discord.' : '⚠ No Discord webhook: skill notes are not sent. Set DEV_NOTES_WEBHOOK_URL (or SUGGESTION_WEBHOOK_URL).'),
      el('div', `adm-state ${o?.ai ? 'ok' : 'warn'}`, o?.ai ? '✔ Ask Claude works in the dev panel.' : '⚠ Ask Claude is off: set ANTHROPIC_API_KEY (from console.anthropic.com) in the server\'s environment.'),
    );
    return box;
  }

  /** Every match on the server with its replay: watch it, save the file, or make the bots train on it; or upload a file. */
  private replays(): HTMLElement {
    const box = el('div');
    const top = el('div', 'own-row');
    const filters: [typeof this.feedFilter, string][] = [['all', 'All'], ['people', 'With people'], ['bots', 'Bot matches'], ['ranked', 'Ranked']];
    for (const [id, label] of filters) {
      const b = el('button', `mm-small${this.feedFilter === id ? ' mm-go' : ''}`, label);
      b.addEventListener('click', () => {
        this.feedFilter = id;
        this.paint();
      });
      top.append(b);
    }
    const up = el('label', 'mm-small admp-upload', '⬆ Train on a file…');
    const file = el('input');
    file.type = 'file';
    file.accept = '.json,.gz,.replay,application/json,application/gzip,application/octet-stream';
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      file.value = '';
      if (f) void this.upload(f);
    });
    up.append(file);
    top.append(up);
    box.append(top);
    box.append(el('p', 'mm-modal-foot', 'Every match played here, bot matches included (replays are kept for 30 days). "Train bots" makes the bots learn from it now, even a bot match (its losers learn from its winners), and keeps it for offline study.'));
    if (this.trainMsg) box.append(el('div', `adm-state ${this.trainMsg.ok ? 'ok' : 'warn'}`, this.trainMsg.text));
    if (!this.feed) {
      box.append(el('p', 'mm-modal-foot', 'Loading…'));
      return box;
    }
    const rows = this.feed.filter((m) => (this.feedFilter === 'bots' ? m.bots : this.feedFilter === 'people' ? !m.bots : this.feedFilter === 'ranked' ? m.ranked : true));
    if (!rows.length) box.append(el('p', 'mm-modal-foot', 'No matches yet.'));
    for (const m of rows) box.append(this.feedRow(m));
    return box;
  }

  private feedRow(m: MatchRecord): HTMLElement {
    const row = el('div', 'own-room');
    const info = el('div', 'own-room-info');
    const kind = m.bots ? '🤖 Bot match' : m.ranked ? 'Ranked' : 'Unranked';
    const won = m.winner === 'draw' ? 'Draw' : m.winner === null ? 'No result' : `Team ${m.winner + 1} won`;
    info.append(el('b', '', `${kind} ${m.size}v${m.size} · ${mapName(m.map)} · ${won}`), el('small', '', `${new Date(m.at).toLocaleString()} (${ago(m.at)}) · ${dur(m.durationMs)}`));
    const teams = el('span', 'admp-wrap');
    for (const t of [0, 1]) {
      const names = m.players.filter((p) => p.team === t).map((p) => `${p.name} (${CLASSES[p.classId as keyof typeof CLASSES]?.name ?? p.classId})`);
      if (names.length) teams.append(el('span', m.winner === t ? 'admp-win' : '', `${t ? ' vs ' : ''}${names.join(', ')}`));
    }
    info.append(teams);
    row.append(info);
    if (m.replay) {
      const watch = el('button', 'mm-small', '▶ Watch');
      watch.addEventListener('click', () => {
        this.close();
        this.hooks.replay(m.id);
      });
      const save = el('a', 'mm-small', '⬇ Save');
      save.href = `/api/replay/${m.id}`;
      save.download = `replay-${m.id}.json.gz`;
      save.title = 'Save the replay file (it can be uploaded here later to train on it)';
      const train = el('button', 'mm-small mm-go', this.training.has(m.id) ? 'Training…' : '🧠 Train bots');
      train.disabled = this.training.has(m.id);
      train.addEventListener('click', () => {
        this.training.add(m.id);
        this.trainMsg = null;
        this.hooks.send({ t: 'admin_act', act: 'train', id: m.id });
        this.paint();
      });
      row.append(watch, save, train);
    } else row.append(el('small', 'devp-dim', 'no replay'));
    return row;
  }

  private async upload(f: File) {
    this.trainMsg = { ok: true, text: `Training on ${f.name}…` };
    this.paint();
    try {
      const r = await fetch('/api/botlearn/upload', { method: 'POST', headers: { authorization: `Bearer ${this.hooks.token()}`, 'content-type': 'application/octet-stream' }, body: f });
      const j = (await r.json().catch(() => ({ ok: false, text: `The server said ${r.status}.` }))) as { ok: boolean; text: string };
      this.trainMsg = { ok: !!j.ok, text: j.text };
    } catch {
      this.trainMsg = { ok: false, text: 'Could not reach the server.' };
    }
    this.paint();
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
