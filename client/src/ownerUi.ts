import { ABILITY_GRANTS, CUSTOM_TITLE_MAX, EMBLEMS, NAME_COLORS, TITLES, resolveCosmetics } from '@arena/shared';
import type { AccountInfo, AdminRow, ClientMsg, CustomStyle, ServerMsg } from '@arena/shared';
import { applyName } from './nameStyle';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

interface Hooks {
  send(m: ClientMsg): void;
  token(): string;
  rerender(): void;
}

const MAX_GIF = 256 * 1024;
const OWNER_ITEMS = [
  ...TITLES.filter((d) => d.unlock.kind === 'owner').map((d) => ({ g: `title:${d.id}`, label: `Title: ${d.name}` })),
  ...EMBLEMS.filter((d) => d.unlock.kind === 'owner').map((d) => ({ g: `emblem:${d.id}`, label: `Emblem: ${d.value} ${d.name}` })),
  ...NAME_COLORS.filter((d) => d.unlock.kind === 'owner').map((d) => ({ g: `color:${d.id}`, label: `Colour: ${d.name}` })),
  ...ABILITY_GRANTS.map((d) => ({ g: d.id as string, label: `Ability: ${d.name}` })),
];

/** The owner's tools: unlock with the code, own custom style, GIF icon, and the friends/admin panel. */
export class OwnerPanel {
  private notice = '';
  private noticeBad = false;
  private rows: AdminRow[] | null = null;
  private query = '';
  private open = '';
  private temp: { name: string; pw: string } | null = null;
  private busy = false;

  constructor(private hooks: Hooks) {}

  handle(m: ServerMsg): void {
    switch (m.t) {
      case 'owner':
        this.say(m.ok ? 'Owner tools unlocked for this session.' : m.reason ?? 'Could not unlock.', !m.ok);
        if (m.ok) this.hooks.send({ t: 'admin_list' });
        break;
      case 'admin_accounts':
        this.rows = m.rows;
        this.hooks.rerender();
        break;
      case 'admin_result':
        if (!m.ok) this.say(m.reason ?? 'Change refused.', true);
        else {
          this.say(`Saved ${m.name}.`, false);
          if (m.row && this.rows) this.rows = this.rows.map((r) => (r.name === m.row!.name ? m.row! : r));
          if (m.tempPassword) this.temp = { name: m.name, pw: m.tempPassword };
        }
        break;
    }
  }

  /** Called when the owner tab opens. */
  opened(a: AccountInfo): void {
    if (a.ownerOk) this.hooks.send({ t: 'admin_list' });
  }

  private say(text: string, bad: boolean) {
    this.notice = text;
    this.noticeBad = bad;
    this.hooks.rerender();
  }

  private noticeEl(): HTMLElement | null {
    return this.notice ? el('div', this.noticeBad ? 'auth-err' : 'own-ok', this.notice) : null;
  }

  // ------------------------------------------------------------------ owner tab

  render(a: AccountInfo): HTMLElement {
    const box = el('div', 'own-box');
    if (!a.ownerOk) {
      box.append(el('h3', '', 'Unlock owner tools'));
      box.append(el('p', 'mm-modal-foot', 'Enter the owner code (the ARENA_OWNER_CODE set on the server). Your session stays unlocked until you sign out.'));
      const row = el('div', 'own-row');
      const input = el('input');
      input.type = 'password';
      input.placeholder = 'Owner code';
      input.autocomplete = 'off';
      input.dataset.f = 'ownercode';
      const go = el('button', 'mm-small', 'Unlock');
      const submit = () => input.value && this.hooks.send({ t: 'owner_unlock', code: input.value });
      go.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
      row.append(input, go);
      box.append(row);
      const n = this.noticeEl();
      if (n) box.append(n);
      return box;
    }
    const n = this.noticeEl();
    if (n) box.append(n);
    box.append(el('h3', '', 'Your name style'));
    box.append(this.styleEditor(a.cosmetics.custom, !!a.cosmetics.useCustom, (custom, use) => this.hooks.send({ t: 'customize', cosmetics: { ...a.cosmetics, custom, useCustom: use } }), true));
    box.append(el('h3', '', 'Animated icon'), this.gifBox(a));
    box.append(el('h3', '', 'Accounts'), this.adminList());
    return box;
  }

  // ------------------------------------------------------------------ custom style editor (self or friend)

  styleEditor(initial: CustomStyle | undefined, useNow: boolean, save: (c: CustomStyle, use: boolean) => void, withUseToggle: boolean, onRemove?: () => void): HTMLElement {
    const wrap = el('div', 'own-box');
    const st: CustomStyle = initial ? { ...initial } : { title: '', color: '#ffd23f', glow: true };
    let grad = !!st.color2;
    let use = useNow || !initial;
    const prev = el('div', 'own-prev');
    const paint = () => {
      prev.replaceChildren(el('span', '', 'PlayerName'));
      applyName(prev.firstElementChild as HTMLElement, { color: st.color, color2: grad ? st.color2 ?? '#2bffd0' : undefined, glow: st.glow }, '', 10);
      prev.append(el('div', 'prof-title', st.title ? `«${st.title}»` : 'No title'));
    };
    const title = el('input');
    title.type = 'text';
    title.maxLength = CUSTOM_TITLE_MAX;
    title.placeholder = `Title text (up to ${CUSTOM_TITLE_MAX} characters)`;
    title.value = st.title;
    title.addEventListener('input', () => {
      st.title = title.value;
      paint();
    });
    const c1 = el('input');
    c1.type = 'color';
    c1.value = st.color;
    c1.addEventListener('input', () => {
      st.color = c1.value;
      paint();
    });
    const c2 = el('input');
    c2.type = 'color';
    c2.value = st.color2 ?? '#2bffd0';
    c2.disabled = !grad;
    c2.addEventListener('input', () => {
      st.color2 = c2.value;
      paint();
    });
    const chk = (label: string, on: boolean, f: (v: boolean) => void) => {
      const l = el('label', 'chk');
      const i = el('input');
      i.type = 'checkbox';
      i.checked = on;
      i.addEventListener('change', () => f(i.checked));
      l.append(i, label);
      return l;
    };
    const gradBox = chk('Gradient', grad, (v) => {
      grad = v;
      c2.disabled = !v;
      st.color2 = v ? c2.value : undefined;
      paint();
    });
    const glowBox = chk('Glow', st.glow, (v) => {
      st.glow = v;
      paint();
    });
    const row = el('div', 'own-row');
    row.append(title);
    const row2 = el('div', 'own-row');
    row2.append('Colour', c1, gradBox, c2, glowBox);
    wrap.append(prev, row, row2);
    if (withUseToggle) wrap.append(chk('Show this instead of my normal title and colour', use, (v) => (use = v)));
    const btns = el('div', 'own-row');
    const ok = el('button', 'mm-small', 'Save style');
    ok.addEventListener('click', () => save({ title: st.title, color: st.color, color2: grad ? st.color2 ?? c2.value : undefined, glow: st.glow }, use));
    btns.append(ok);
    if (onRemove) {
      const rm = el('button', 'mm-small', 'Remove');
      rm.addEventListener('click', onRemove);
      btns.append(rm);
    }
    wrap.append(btns);
    paint();
    return wrap;
  }

  // ------------------------------------------------------------------ GIF icon (owner, or anyone granted the ability)

  gifBox(a: AccountInfo): HTMLElement {
    const box = el('div', 'own-box');
    box.append(el('p', 'mm-modal-foot', `A GIF up to 256x256 pixels and ${MAX_GIF / 1024} KB. It shows next to your name in the menu, leaderboard and in matches.`));
    const row = el('div', 'own-row');
    const file = el('input');
    file.type = 'file';
    file.accept = 'image/gif';
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      if (f.size > MAX_GIF) return this.say(`That GIF is ${Math.round(f.size / 1024)} KB; the limit is ${MAX_GIF / 1024} KB.`, true);
      await this.sendGif('POST', f);
    });
    row.append(file);
    if (a.avatar) {
      const rm = el('button', 'mm-small', 'Remove icon');
      rm.addEventListener('click', () => this.sendGif('DELETE'));
      row.append(rm);
    }
    box.append(row);
    if (this.busy) box.append(el('div', 'own-ok', 'Uploading…'));
    return box;
  }

  private async sendGif(method: 'POST' | 'DELETE', body?: File) {
    this.busy = true;
    this.hooks.rerender();
    try {
      const r = await fetch('/api/avatar', { method, headers: { authorization: `Bearer ${this.hooks.token()}` }, body });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      this.busy = false;
      this.say(r.ok ? (method === 'POST' ? 'Icon updated.' : 'Icon removed.') : j.error ?? 'Upload failed.', !r.ok);
    } catch {
      this.busy = false;
      this.say('Upload failed. Check your connection.', true);
    }
  }

  // ------------------------------------------------------------------ admin: accounts

  private adminList(): HTMLElement {
    const box = el('div', 'own-box');
    if (this.temp) {
      box.append(el('div', 'own-ok', `Temporary password for ${this.temp.name} (shown once; they are signed out and must use it, then ask you if they want a new one):`), el('div', 'own-temp', this.temp.pw));
    }
    const search = el('input');
    search.type = 'search';
    search.placeholder = 'Search accounts';
    search.value = this.query;
    search.dataset.f = 'adminq';
    search.addEventListener('input', () => {
      this.query = search.value;
      this.hooks.rerender();
    });
    box.append(search);
    if (!this.rows) {
      box.append(el('p', 'mm-modal-foot', 'Loading accounts…'));
      return box;
    }
    const list = el('div', 'adm-list');
    const q = this.query.trim().toLowerCase();
    for (const r of this.rows.filter((x) => !q || x.name.toLowerCase().includes(q))) {
      const row = el('div', `adm-row${this.open === r.name ? ' open' : ''}`);
      const head = el('div', 'adm-head');
      const dot = el('span', `dot${r.online ? ' on' : ''}`);
      const rc = resolveCosmetics(r.cosmetics);
      const nm = el('b', '', `${rc.emblem} ${r.name}`);
      applyName(nm, rc);
      head.append(dot, nm, el('small', '', `${r.rating} · ${r.wins}W/${r.matches}M · joined ${new Date(r.createdAt).toLocaleDateString()}`));
      head.addEventListener('click', () => {
        this.open = this.open === r.name ? '' : r.name;
        this.hooks.rerender();
      });
      row.append(head);
      if (this.open === r.name) row.append(this.adminBody(r));
      list.append(row);
    }
    if (!list.children.length) list.append(el('p', 'mm-modal-foot', 'No matching accounts.'));
    box.append(list);
    return box;
  }

  private adminBody(r: AdminRow): HTMLElement {
    const body = el('div', 'adm-body');
    if (r.name.toLowerCase() === 'toke') {
      body.append(el('p', 'mm-modal-foot', 'That is you. Use the sections above.'));
      return body;
    }
    body.append(el('b', '', 'Unlocks and abilities'));
    const grants = new Set(r.grants);
    const grid = el('div', 'chk-grid');
    for (const it of OWNER_ITEMS) {
      const l = el('label', 'chk');
      const i = el('input');
      i.type = 'checkbox';
      i.checked = grants.has(it.g);
      i.addEventListener('change', () => (i.checked ? grants.add(it.g) : grants.delete(it.g)));
      l.append(i, it.label);
      grid.append(l);
    }
    const save = el('button', 'mm-small', 'Save unlocks');
    save.addEventListener('click', () => this.hooks.send({ t: 'admin_set', name: r.name, grants: [...grants] }));
    body.append(grid, save);
    body.append(el('b', '', 'Custom title and colours for them'));
    body.append(
      this.styleEditor(
        r.cosmetics.custom,
        !!r.cosmetics.useCustom,
        (custom, use) => this.hooks.send({ t: 'admin_set', name: r.name, custom, useCustom: use }),
        true,
        r.cosmetics.custom ? () => this.hooks.send({ t: 'admin_set', name: r.name, custom: null }) : undefined,
      ),
    );
    const reset = el('button', 'mm-small', 'Reset password');
    reset.addEventListener('click', () => {
      if (confirm(`Reset ${r.name}'s password? They will be signed out everywhere.`)) this.hooks.send({ t: 'admin_set', name: r.name, resetPassword: true });
    });
    body.append(reset);
    return body;
  }
}
