import type { Popup } from './popups';
import { OwnerPanel } from './ownerUi';
import { applyName, avatarImg, avatarUrl } from './nameStyle';
import { EMBLEMS, NAME_COLORS, NAME_RE, isOwnerName, PASSWORD_MAX, PASSWORD_MIN, RANKS, TITLES, isUnlocked, rankProgress, resolveCosmetics, unlockText } from '@arena/shared';
import type { AccountInfo, ClientMsg, CosmeticDef, Cosmetics, LeaderRow, MatchRecord, ServerMsg } from '@arena/shared';
import { classIcon, mapName } from './spectate';

/**
 * Account chip, sign-in/register dialog and the profile screen (overview, cosmetics, leaderboard). All data comes from
 * the server; this module only draws it and sends intents. The session token lives in localStorage under
 * `arena.session.v1` (kept out of exported setup codes).
 */

export const SESSION_KEY = 'arena.session.v1';
const SEEN_KEY = 'arena.seenLogin.v1';

export interface AccountHooks {
  /** Make sure the socket is open, then send. */
  send(msg: ClientMsg): void;
  onAccount(account: AccountInfo | null): void;
  /** Open a recorded match for playback. */
  onReplay(id: string): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k) ?? '';
    } catch {
      return '';
    }
  },
  set(k: string, v: string) {
    try {
      if (v) localStorage.setItem(k, v);
      else localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

type Tab = 'overview' | 'history' | 'customize' | 'leaders' | 'owner';

export class AccountUi {
  readonly chip = el('button', 'acct-chip');
  account: AccountInfo | null = null;
  private modal: HTMLElement | null = null;
  /** The sign-in or profile window, for the pop-up manager. */
  readonly popup: Popup = { isOpen: () => !!this.modal, close: () => this.closeModal(), el: () => this.modal };
  private tab: Tab = 'overview';
  private authError = '';
  private authMode: 'login' | 'register' = 'login';
  private rows: LeaderRow[] = [];
  private matches: MatchRecord[] | null = null;
  private pendingResume: ((v: void) => void) | null = null;
  private settledPromise: Promise<void> = Promise.resolve();
  private owner = new OwnerPanel({ send: (m) => this.hooks.send(m), token: () => this.token, rerender: () => this.modal && this.renderModal() });

  constructor(private hooks: AccountHooks) {
    this.chip.addEventListener('click', () => (this.account ? this.openProfile() : this.openAuth()));
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.modal) this.closeModal();
    });
    this.renderChip();
    fetch('/api/status')
      .then((r) => r.json())
      .then((j: { persistent?: boolean }) => {
        this.ephemeral = j.persistent === false;
        this.renderChip();
        if (this.modal) this.renderModal();
      })
      .catch(() => {});
  }

  /** True when the server keeps accounts in memory only (they vanish on restart). */
  private ephemeral = false;

  get token(): string {
    return store.get(SESSION_KEY);
  }

  /** Called right after the socket opens: resume a saved session. Resolves once the server has answered. */
  resume() {
    const token = this.token;
    if (!token) return;
    this.settledPromise = new Promise<void>((res) => {
      this.pendingResume = res;
      window.setTimeout(() => this.settle(), 4000);
    });
    this.hooks.send({ t: 'resume', token });
  }

  /** Joining must wait for a pending resume so the server knows who is joining. */
  settled(): Promise<void> {
    return this.settledPromise;
  }
  private settle() {
    this.pendingResume?.();
    this.pendingResume = null;
  }

  /** First visit: offer sign-in once. */
  promptIfNew() {
    if (this.token || store.get(SEEN_KEY)) return;
    window.setTimeout(() => {
      if (!this.account && !this.modal) this.openAuth();
    }, 600);
  }

  handle(m: ServerMsg) {
    switch (m.t) {
      case 'account':
        if (m.token) store.set(SESSION_KEY, m.token);
        this.account = m.account;
        this.authError = '';
        this.settle();
        this.renderChip();
        this.hooks.onAccount(m.account);
        if (this.modal && this.modal.dataset.kind === 'auth') this.closeModal();
        else if (this.modal) this.renderModal();
        break;
      case 'auth_error':
        this.authError = m.reason;
        if (/expired/i.test(m.reason)) {
          store.set(SESSION_KEY, '');
          if (this.account) {
            this.account = null;
            this.renderChip();
            this.hooks.onAccount(null);
          }
        }
        this.settle();
        if (this.modal) this.renderModal();
        else if (/expired/i.test(m.reason)) this.openAuth();
        break;
      case 'logged_out':
        store.set(SESSION_KEY, '');
        this.account = null;
        this.closeModal();
        this.renderChip();
        this.hooks.onAccount(null);
        break;
      case 'owner':
      case 'admin_accounts':
      case 'admin_result':
        this.owner.handle(m);
        break;
      case 'history':
        this.matches = m.rows;
        if (this.modal && this.tab === 'history') this.renderModal();
        break;
      case 'leaderboard':
        this.rows = m.rows;
        if (this.modal && this.tab === 'leaders') this.renderModal();
        break;
    }
  }

  // ------------------------------------------------------------------ chip

  private renderChip() {
    const a = this.account;
    this.chip.replaceChildren();
    if (!a) {
      this.chip.classList.remove('in');
      this.chip.append(el('span', 'ci', '👤'), el('span', 'ct', 'Sign in / Register'), el('span', 'cs', 'or play as guest'));
      return;
    }
    const c = resolveCosmetics(a.cosmetics);
    const { tier } = rankProgress(a.rating);
    this.chip.classList.add('in');
    const name = el('span', 'cn', a.name);
    const rank = el('span', 'cr', `${tier.icon} ${tier.name} · ${a.rating}`);
    rank.style.color = tier.color;
    applyName(name, c);
    const ico = el('span', 'ci', c.emblem);
    const img = avatarImg(avatarUrl(a.name, a.avatar));
    if (img) ico.replaceChildren(img);
    this.chip.append(ico, name, rank);
    if (this.ephemeral) {
      const w = el('span', 'cw', '⚠ not saved');
      w.title = 'The server is not saving accounts permanently; they reset on restart.';
      this.chip.append(w);
    }
  }

  // ------------------------------------------------------------------ modal plumbing

  private closeModal() {
    this.modal?.remove();
    this.modal = null;
    this.authError = '';
  }

  private openModal(kind: 'auth' | 'profile') {
    this.closeModal();
    const modal = el('div', 'mm-modal');
    modal.dataset.kind = kind;
    modal.addEventListener('mousedown', (e) => {
      if (e.target === modal) this.closeModal();
    });
    document.body.append(modal);
    this.modal = modal;
    this.renderModal();
  }

  private renderModal() {
    const m = this.modal;
    if (!m) return;
    const keepFocus = document.activeElement instanceof HTMLInputElement ? document.activeElement.dataset.f : '';
    m.replaceChildren(m.dataset.kind === 'auth' ? this.authCard() : this.profileCard());
    if (keepFocus) (m.querySelector(`[data-f="${keepFocus}"]`) as HTMLElement | null)?.focus();
  }

  // ------------------------------------------------------------------ sign in / register

  openAuth() {
    this.openModal('auth');
  }

  private authCard(): HTMLElement {
    const card = el('div', 'mm-modal-card auth-card');
    const head = el('div', 'mm-modal-head');
    head.append(el('h2', '', this.authMode === 'login' ? 'Sign in' : 'Create account'));
    card.append(head);
    if (this.ephemeral) card.append(el('div', 'acct-warn', '⚠ This server is not saving accounts permanently, so they will be wiped on the next restart. The owner needs to connect the database (UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN).'));

    const tabs = el('div', 'acct-tabs');
    for (const [mode, label] of [['login', 'Sign in'], ['register', 'Register']] as const) {
      const b = el('button', this.authMode === mode ? 'sel' : '', label);
      b.addEventListener('click', () => {
        this.authMode = mode;
        this.authError = '';
        this.renderModal();
      });
      tabs.append(b);
    }
    const name = el('input');
    name.type = 'text';
    name.placeholder = 'Username (3-16 letters, numbers, _)';
    name.maxLength = 16;
    name.autocomplete = 'username';
    name.dataset.f = 'name';
    // reserved owner names need the owner code (only shown when the typed name is one)
    const code = el('input');
    code.type = 'password';
    code.placeholder = 'Owner code';
    code.autocomplete = 'off';
    code.dataset.f = 'code';
    code.style.display = 'none';
    const syncCode = () => (code.style.display = this.authMode === 'register' && isOwnerName(name.value.trim()) ? '' : 'none');
    name.addEventListener('input', syncCode);
    const pass = el('input');
    pass.type = 'password';
    pass.placeholder = `Password (${PASSWORD_MIN}+ characters)`;
    pass.maxLength = PASSWORD_MAX;
    pass.autocomplete = this.authMode === 'login' ? 'current-password' : 'new-password';
    pass.dataset.f = 'pass';
    const err = el('div', 'auth-err', this.authError);
    const go = el('button', 'mm-btn primary', this.authMode === 'login' ? 'Sign in' : 'Create account');
    const submit = () => {
      const n = name.value.trim();
      if (!NAME_RE.test(n)) return this.say(err, 'Names are 3-16 letters, numbers or underscores.');
      if (pass.value.length < PASSWORD_MIN) return this.say(err, `Passwords need at least ${PASSWORD_MIN} characters.`);
      this.say(err, 'Working…');
      if (this.authMode === 'register') this.hooks.send({ t: 'register', name: n, password: pass.value, ownerCode: code.value || undefined });
      else this.hooks.send({ t: 'login', name: n, password: pass.value });
    };
    go.addEventListener('click', submit);
    for (const i of [name, pass, code]) i.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
    const guest = el('button', 'mm-link', 'Continue as guest (no rank, progress stays in this browser)');
    guest.addEventListener('click', () => {
      store.set(SEEN_KEY, '1');
      this.closeModal();
    });
    const note = el('div', 'mm-modal-foot', 'Accounts keep your rank, wins, cosmetics and all your settings (HUD, keybinds, builds) on any device. Passwords are hashed on the server.');
    card.append(tabs, name, pass, code, err, go, guest, note);
    window.setTimeout(() => name.focus(), 0);
    return card;
  }

  /** Show a connection failure inside the open dialog. */
  fail(reason: string) {
    this.authError = reason;
    this.settle();
    if (this.modal) this.renderModal();
  }

  private say(target: HTMLElement, text: string) {
    target.textContent = text;
  }

  // ------------------------------------------------------------------ profile

  openProfile(tab: Tab = 'overview') {
    this.tab = tab;
    this.openModal('profile');
    if (tab === 'leaders') this.hooks.send({ t: 'leaderboard' });
  }

  private profileCard(): HTMLElement {
    const a = this.account;
    const card = el('div', 'mm-modal-card prof-card');
    if (!a) {
      card.append(el('p', '', 'Not signed in.'));
      return card;
    }
    const c = resolveCosmetics(a.cosmetics);
    const { tier } = rankProgress(a.rating);

    const head = el('div', 'prof-head');
    const emblem = el('div', 'prof-emblem', c.emblem);
    const big = avatarImg(avatarUrl(a.name, a.avatar), 'av-big');
    if (big) emblem.replaceChildren(big);
    emblem.style.borderColor = tier.color;
    const who = el('div', 'prof-who');
    const nm = el('div', 'prof-name', a.name);
    applyName(nm, c, '', 12);
    who.append(nm, el('div', 'prof-title', c.title || 'No title'));
    if (a.role === 'owner') who.append(el('div', 'owner-ribbon', '★ FOUNDER · Owner of the Arena'));
    const rank = el('div', 'prof-rank');
    rank.style.color = tier.color;
    rank.append(el('div', 'rr-icon', tier.icon), el('div', 'rr-name', tier.name), el('div', 'rr-num', String(a.rating)));
    const close = el('button', 'mm-small', 'Close');
    close.addEventListener('click', () => this.closeModal());
    head.append(emblem, who, rank, close);

    const tabs = el('div', 'acct-tabs');
    const tabList: [Tab, string][] = [['overview', 'Overview'], ['history', 'Matches'], ['customize', 'Customize'], ['leaders', 'Leaderboard']];
    if (a.role === 'owner') tabList.push(['owner', '★ Owner']);
    for (const [t, label] of tabList) {
      const b = el('button', this.tab === t ? 'sel' : '', label);
      b.addEventListener('click', () => {
        this.tab = t;
        if (t === 'leaders') this.hooks.send({ t: 'leaderboard' });
        if (t === 'history') this.hooks.send({ t: 'history' });
        if (t === 'owner') this.owner.opened(a);
        this.renderModal();
      });
      tabs.append(b);
    }
    card.append(head, tabs);

    if (this.tab === 'overview') card.append(this.overview(a));
    else if (this.tab === 'history') card.append(this.history(a));
    else if (this.tab === 'customize') card.append(this.customize(a));
    else if (this.tab === 'owner' && a.role === 'owner') card.append(this.owner.render(a));
    else card.append(this.leaders(a));

    const foot = el('div', 'prof-foot');
    const out = el('button', 'mm-small', 'Sign out');
    out.addEventListener('click', () => this.hooks.send({ t: 'logout' }));
    foot.append(out);
    card.append(foot);
    return card;
  }

  private overview(a: AccountInfo): HTMLElement {
    const box = el('div', 'prof-over');
    const p = rankProgress(a.rating);
    const bar = el('div', 'rank-bar');
    const fill = el('div', 'rank-fill');
    fill.style.width = `${p.frac * 100}%`;
    fill.style.background = p.tier.color;
    bar.append(fill);
    const label = p.next ? `${p.next.min - a.rating} rating to ${p.next.icon} ${p.next.name}` : 'Top tier reached';
    const stats = el('div', 'stat-grid');
    const stat = (k: string, v: string) => {
      const s = el('div', 'st');
      s.append(el('b', '', v), el('span', '', k));
      return s;
    };
    const losses = Math.max(0, a.matches - a.wins);
    stats.append(stat('Rating', String(a.rating)), stat('Peak', String(a.peak)), stat('Matches', String(a.matches)), stat('Wins', String(a.wins)), stat('Losses', String(losses)), stat('Win rate', a.matches ? `${Math.round((a.wins / a.matches) * 100)}%` : '–'));
    const ladder = el('div', 'rank-ladder');
    for (const r of RANKS) {
      const x = el('div', `rl${r.id === p.tier.id ? ' cur' : ''}${a.peak >= r.min ? ' got' : ''}`);
      x.style.setProperty('--c', r.color);
      x.append(el('span', '', r.icon), el('small', '', `${r.name}\n${r.min}+`));
      ladder.append(x);
    }
    box.append(el('div', 'rank-label', label), bar, stats, ladder, el('div', 'mm-modal-foot', `Ranked rating changes only in ranked queue matches (1v1, 2v2 and 3v3 share one rating). ${a.rated} rated games played${a.rated < 5 ? ' (placement: ratings move faster for your first 5)' : ''}. Leaving a live ranked match counts as a loss.`));
    return box;
  }

  private customize(a: AccountInfo): HTMLElement {
    const box = el('div', 'prof-cust');
    const pick = (field: keyof Cosmetics, defs: CosmeticDef[], render: (d: CosmeticDef) => string, title: string) => {
      box.append(el('h3', '', title));
      const row = el('div', `opt-row ${field}`);
      for (const d of defs) {
        const open = isUnlocked(d, a, field as 'title' | 'emblem' | 'color');
        if (!open && d.unlock.kind === 'owner') continue; // owner-only items stay hidden from everyone else
        const b = el('button', `opt${a.cosmetics[field] === d.id ? ' sel' : ''}${open ? '' : ' locked'}`);
        b.append(el('span', 'ov', render(d)), el('small', '', open ? d.name : `🔒 ${unlockText(d)}`));
        if (field === 'color' && d.value) b.style.setProperty('--c', d.value);
        b.addEventListener('click', () => {
          if (!open) return;
          this.hooks.send({ t: 'customize', cosmetics: { ...a.cosmetics, [field]: d.id } });
        });
        row.append(b);
      }
      box.append(row);
    };
    pick('emblem', EMBLEMS, (d) => d.value ?? '', 'Emblem');
    pick('title', TITLES, (d) => (d.id ? '«»' : '—'), 'Title');
    pick('color', NAME_COLORS, () => 'Aa', 'Name colour');
    if (a.cosmetics.custom && a.role !== 'owner') {
      const l = el('label', 'chk');
      const i = el('input');
      i.type = 'checkbox';
      i.checked = !!a.cosmetics.useCustom;
      i.addEventListener('change', () => this.hooks.send({ t: 'customize', cosmetics: { title: a.cosmetics.title, emblem: a.cosmetics.emblem, color: a.cosmetics.color, useCustom: i.checked } }));
      l.append(i, `Use my special title «${a.cosmetics.custom.title}» and colours`);
      box.append(el('h3', '', 'Special style'), l);
    }
    if (a.grants.includes('gif') && a.role !== 'owner') box.append(el('h3', '', 'Animated icon'), this.owner.gifBox(a));
    box.append(el('div', 'mm-modal-foot', 'Other players see your emblem, title and colour on your nameplate in matches. Unlock more by playing, winning and climbing the ranks.'));
    if (this.authError) box.append(el('div', 'auth-err', this.authError));
    return box;
  }

  private history(a: AccountInfo): HTMLElement {
    const box = el('div', 'hist-list');
    if (!this.matches) {
      box.append(el('p', 'mm-modal-foot', 'Loading…'));
      return box;
    }
    if (!this.matches.length) {
      box.append(el('p', 'mm-modal-foot', 'No matches yet. Ranked games and practice against bots show up here, newest first, with a replay when one was saved.'));
      return box;
    }
    const ago = (t: number) => {
      const m = Math.max(1, Math.round((Date.now() - t) / 60000));
      return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
    };
    for (const r of this.matches) {
      const me = r.players.find((p) => p.name === a.name);
      const res = r.winner === 'draw' || r.winner === null ? 'draw' : me && r.winner === me.team ? 'win' : 'loss';
      const row = el('div', `hist-row ${res}`);
      row.append(el('div', 'hist-res', res === 'win' ? 'WIN' : res === 'loss' ? 'LOSS' : 'DRAW'));
      const mid = el('div', 'hist-mid');
      const team = (t: number) => r.players.filter((p) => p.team === t).map((p) => `${classIcon(p.classId)} ${p.name}`).join(', ');
      const myTeam = me?.team ?? 0;
      mid.append(el('div', '', `${r.size}v${r.size} · ${mapName(r.map)}${r.ranked ? ' · Ranked' : ' · Practice'}`), el('div', 'hist-sub', `${team(myTeam)}  vs  ${team(1 - myTeam)}`), el('div', 'hist-sub', `${ago(r.at)} · ${Math.floor(r.durationMs / 60000)}:${String(Math.floor(r.durationMs / 1000) % 60).padStart(2, '0')}`));
      const right = el('div');
      if (me?.delta !== undefined) right.append(el('div', `hist-d ${me.delta >= 0 ? 'up' : 'down'}`, `${me.delta >= 0 ? '+' : ''}${me.delta}`));
      if (r.replay) {
        const w = el('button', 'mm-small', '▶ Replay');
        w.addEventListener('click', () => {
          this.closeModal();
          this.hooks.onReplay(r.id);
        });
        right.append(w);
      }
      row.append(mid, right);
      box.append(row);
    }
    return box;
  }

  private leaders(a: AccountInfo): HTMLElement {
    const box = el('div', 'prof-lb');
    if (!this.rows.length) {
      box.append(el('p', 'mm-modal-foot', 'Loading…'));
      return box;
    }
    const table = el('div', 'lb-table');
    this.rows.forEach((r, i) => {
      const row = el('div', `lb-row${r.name === a.name ? ' me' : ''}`);
      const rc = resolveCosmetics(r.cosmetics);
      const tier = rankProgress(r.rating).tier;
      const nm = el('span', 'lb-name', `${r.role === 'owner' ? '★ ' : ''}${rc.emblem} ${r.name}`);
      const lbImg = avatarImg(avatarUrl(r.name, r.avatar));
      if (lbImg) nm.replaceChildren(r.role === 'owner' ? '★ ' : '', lbImg, ` ${r.name}`);
      applyName(nm, rc);
      const rating = el('span', 'lb-rating', `${tier.icon} ${r.rating}`);
      rating.style.color = tier.color;
      row.append(el('span', 'lb-pos', `#${i + 1}`), nm, rating, el('span', 'lb-wl', `${r.wins}W / ${r.matches}M`));
      table.append(row);
    });
    box.append(table);
    return box;
  }
}
