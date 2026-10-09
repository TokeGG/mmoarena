import { ABILITIES, ABILITY_GRANTS, ARENAS, AURAS, CLASSES, CLASS_IDS, CUSTOM_TITLE_MAX, EMBLEMS, NAME_COLORS, SPECS, TITLES, resolveCosmetics } from '@arena/shared';
import type { AccountInfo, AdminRow, BotPick, ClassId, ClientMsg, CustomStyle, DataPatch, MatchRecord, ServerMsg } from '@arena/shared';
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
  /** Open the full admin panel (from the profile's Owner tab). */
  openAdmin?(): void;
  /** Watch a match / follow a player (from the admin panel). */
  watch?(id: string): void;
  follow?(name: string): void;
  /** True for a dev who is not the owner: matches they may watch only, no pause or end, numbers read-only. (The server refuses it all again.) */
  limited?(): boolean;
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
      case 'admin_overview':
        this.overview = m;
        this.hooks.rerender();
        break;
      case 'overrides':
        this.overrides = m.patches;
        this.hooks.rerender();
        break;
      case 'dev_result':
        this.say(m.text, !m.ok, m.url ?? '');
        break;
      case 'admin_history':
        this.histories.set(m.name, m.rows);
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

  private say(text: string, bad: boolean, url = '') {
    this.noticeUrl = url;
    this.notice = text;
    this.noticeBad = bad;
    this.hooks.rerender();
  }

  /** A link that came with the last result (a pull request). */
  private noticeUrl = '';

  private noticeEl(): HTMLElement | null {
    if (!this.notice) return null;
    const box = el('div', this.noticeBad ? 'auth-err' : 'own-ok', this.notice);
    if (this.noticeUrl) {
      const a = el('a', '', ' Open the pull request');
      a.href = this.noticeUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      box.append(a);
    }
    return box;
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
    // the server, players, matches and tuning live in the admin panel of their own
    const go = el('button', 'mm-small mm-go', '🛡 Open the admin panel');
    go.addEventListener('click', () => this.hooks.openAdmin?.());
    box.append(go);
    box.append(el('p', 'mm-modal-foot', 'Your own name style and animated icon: moved to Look (main menu), under Name and title.'));
    return box;
  }

  // ------------------------------------------------------------------ admin: the server at a glance

  overview: Extract<ServerMsg, { t: 'admin_overview' }> | null = null;
  /** Recent matches per player, asked for from their admin row. */
  private histories = new Map<string, MatchRecord[]>();
  private overrides: DataPatch[] = [];

  /** Who is online and every match running (private ones too): watch any of them live, or end one. */
  serverBox(): HTMLElement {
    const wrap = el('div', 'own-box own-server');
    const top = el('div', 'own-row');
    const refresh = el('button', 'mm-small', 'Refresh');
    refresh.addEventListener('click', () => this.hooks.send({ t: 'admin_overview' }));
    const o = this.overview;
    top.append(el('b', '', o ? `${o.online} online · ${o.queued} in queue · ${o.rooms.length} match${o.rooms.length === 1 ? '' : 'es'}` : 'Press Refresh'), refresh);
    wrap.append(top);
    if (!o) {
      this.hooks.send({ t: 'admin_overview' });
      return wrap;
    }
    if (!o.rooms.length) wrap.append(el('p', 'mm-modal-foot', 'No matches running.'));
    const kindName: Record<string, string> = { ranked: '🏆 Ranked', practice: 'Practice', party: 'Party', bots: '🤖 Bot match', dummies: 'Dummies' };
    for (const r of o.rooms) {
      const row = el('div', 'own-room');
      const t = Math.round(r.elapsedMs / 1000);
      const info = el('div', 'own-room-info');
      const sides = [0, 1].map((team) => r.players.filter((x) => x.team === team).map((x) => (x.human ? `★${x.name}` : x.name)).join(', '));
      info.append(
        el('b', '', `${kindName[r.kind] ?? r.kind} ${r.size}v${r.size} · ${ARENAS.find((x) => x.id === r.map)?.name ?? r.map} · ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`),
        el('span', '', `${sides[0]}  vs  ${sides[1]}`),
        el('small', '', [r.watchers ? `${r.watchers} watching` : '', r.devTest ? 'dev test numbers' : '', r.paused ? 'paused' : ''].filter(Boolean).join(' · ')),
      );
      const limited = !!this.hooks.limited?.();
      row.append(info);
      // a dev watches the listed matches only (the same delayed view as everyone); pausing and ending are the owner's
      if (!limited || r.watchable) {
        const watch = el('button', 'mm-small', 'Watch');
        watch.addEventListener('click', () => (this.hooks.watch ? this.hooks.watch(r.id) : this.hooks.send({ t: 'spectate', id: r.id })));
        row.append(watch);
      } else info.append(el('small', 'devp-dim', 'not open for watching'));
      if (!limited) {
        const pause = el('button', 'mm-small', r.paused ? 'Resume' : 'Pause');
        pause.addEventListener('click', () => this.hooks.send({ t: 'admin_act', act: 'pause_match', id: r.id, on: !r.paused }));
        const end = el('button', 'mm-small', 'End');
        end.addEventListener('click', () => window.confirm('End this match for everyone in it?') && this.hooks.send({ t: 'admin_end', id: r.id }));
        row.append(pause, end);
      }
      wrap.append(row);
      // follow any person in it: you are taken into every match they play
      const humans = r.players.filter((x) => x.human);
      if (humans.length && this.hooks.follow && (!limited || r.watchable)) {
        const fr = el('div', 'own-row own-follow');
        fr.append(el('small', 'devp-dim', 'Follow:'));
        for (const x of humans) {
          const f = el('button', 'mm-small', `👁 ${x.name}`);
          f.title = `Watch this match and every match ${x.name} plays after it`;
          f.addEventListener('click', () => {
            this.hooks.follow!(x.name);
            this.hooks.watch?.(r.id);
          });
          fr.append(f);
        }
        wrap.append(fr);
      }
    }
    return wrap;
  }

  /** A message every connected player sees at once. */
  announceBox(): HTMLElement {
    const row = el('div', 'own-row');
    const input = el('input');
    input.type = 'text';
    input.maxLength = 200;
    input.placeholder = 'Message to everyone online';
    const go = el('button', 'mm-small', 'Send');
    const submit = () => {
      if (!input.value.trim()) return;
      this.hooks.send({ t: 'admin_announce', text: input.value.trim() });
      input.value = '';
      this.say('Announcement sent.', false);
    };
    go.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
    row.append(input, go);
    return row;
  }

  /** Numbers devs saved for everyone, applied over the data files until they are merged or cleared. */
  overridesBox(): HTMLElement {
    const wrap = el('div', 'own-box');
    if (!this.overrides.length) {
      wrap.append(el('p', 'mm-modal-foot', 'None: the game runs on its data files. Devs (give the Dev tools tag below) can try numbers in their own matches against bots (F2) and save them here.'));
      return wrap;
    }
    const list = el('ul', 'own-overrides');
    for (const p of this.overrides) {
      const name = p.file === 'abilities' ? ABILITIES[p.id]?.name : AURAS[p.id]?.name;
      list.append(el('li', '', `${name ?? p.id} · ${p.path.join('.')} = ${p.value}`));
    }
    if (this.hooks.limited?.()) {
      wrap.append(list, el('small', 'devp-dim', 'Only the owner can clear these or open a pull request.'));
      return wrap;
    }
    const clear = el('button', 'mm-small', 'Clear all (back to the data files)');
    clear.addEventListener('click', () => window.confirm('Put every saved number back to the data files, for everyone?') && this.hooks.send({ t: 'overrides_clear' }));
    // propose every live change for the data files on GitHub (the numbers stay live meanwhile)
    const note = el('input');
    note.type = 'text';
    note.maxLength = 600;
    note.placeholder = 'Note for the pull request (optional)';
    const pr = el('button', 'mm-small mm-go', '⤴ Open a pull request with these');
    pr.addEventListener('click', () => {
      pr.disabled = true;
      pr.textContent = 'Opening…';
      this.hooks.send({ t: 'overrides_pr', ...(note.value.trim() ? { note: note.value.trim() } : {}) });
    });
    const row = el('div', 'own-row');
    row.append(note, pr);
    wrap.append(list, row, clear);
    return wrap;
  }

  // ------------------------------------------------------------------ bot match (owner's private test bench)

  /** What the bot match form holds, kept while the panel is redrawn. */
  private bm: { size: 1 | 2 | 3; teams: [BotPick[], BotPick[]]; difficulty: 'easy' | 'normal' | 'hard'; map: string } = {
    size: 1,
    teams: [[{ classId: 'warrior' }, { classId: 'priest' }, { classId: 'mage' }], [{ classId: 'mage' }, { classId: 'rogue' }, { classId: 'priest' }]],
    difficulty: 'hard',
    map: 'random',
  };

  /**
   * Pick both sides (class and spec of each bot), the difficulty and the arena, and watch them fight live in a private
   * room: it is not listed in Watch live and closes when you stop watching.
   */
  botMatch(started?: () => void): HTMLElement {
    const wrap = el('div', 'own-box own-bots');
    wrap.append(el('p', 'mm-modal-foot', 'Watch bots fight each other in a private match only you can see. It closes when you leave it.'));
    const select = (opts: [string, string][], value: string, on: (v: string) => void) => {
      const s = el('select');
      for (const [v, label] of opts) {
        const o = el('option', '', label);
        o.value = v;
        s.append(o);
      }
      s.value = value;
      s.addEventListener('change', () => on(s.value));
      return s;
    };
    const top = el('div', 'own-row');
    top.append(
      select([['1', '1v1'], ['2', '2v2'], ['3', '3v3']], String(this.bm.size), (v) => { this.bm.size = Number(v) as 1 | 2 | 3; this.hooks.rerender(); }),
      select([['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']], this.bm.difficulty, (v) => (this.bm.difficulty = v as 'easy' | 'normal' | 'hard')),
      select([['random', 'Random arena'], ...ARENAS.filter((x) => x.randomPool !== false).map((x): [string, string] => [x.id, x.name])], this.bm.map, (v) => (this.bm.map = v)),
    );
    wrap.append(top);
    ([0, 1] as const).forEach((team) => {
      const row = el('div', 'own-row');
      row.append(el('b', '', team === 0 ? 'Team 1' : 'Team 2'));
      for (let i = 0; i < this.bm.size; i++) {
        const pick = this.bm.teams[team][i];
        row.append(
          select(CLASS_IDS.map((c): [string, string] => [c, CLASSES[c].name]), pick.classId, (v) => { this.bm.teams[team][i] = { classId: v as ClassId }; this.hooks.rerender(); }),
          select([['', 'Any spec'], ...SPECS[pick.classId].map((s): [string, string] => [s.id, s.name])], pick.spec ?? '', (v) => { this.bm.teams[team][i] = { classId: pick.classId, ...(v ? { spec: v } : {}) }; }),
        );
      }
      wrap.append(row);
    });
    const go = el('button', 'mm-small', 'Watch the bots fight');
    go.addEventListener('click', () => {
      const n = this.bm.size;
      this.hooks.send({ t: 'bot_match', size: n, teams: [this.bm.teams[0].slice(0, n), this.bm.teams[1].slice(0, n)], difficulty: this.bm.difficulty, map: this.bm.map });
      started?.();
    });
    wrap.append(go);
    return wrap;
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

  // ------------------------------------------------------------------ admin: moderation of one player

  /** Kick, ban, mute (for a while or for good, with a reason), rating and stats, a private note, recent matches. */
  private moderation(r: AdminRow): HTMLElement {
    const box = el('div', 'adm-mod');
    const until = (u: number) => (u ? `until ${new Date(u).toLocaleString()}` : 'for good');
    if (r.banned) box.append(el('div', 'adm-state bad', `Banned ${until(r.banned.until)} by ${r.banned.by}${r.banned.reason ? `: ${r.banned.reason}` : ''}`));
    if (r.muted) box.append(el('div', 'adm-state warn', `Muted ${until(r.muted.until)} by ${r.muted.by}${r.muted.reason ? `: ${r.muted.reason}` : ''}`));
    const act = (m: Omit<Extract<ClientMsg, { t: 'admin_act' }>, 't' | 'name'>) => this.hooks.send({ t: 'admin_act', name: r.name, ...m });
    const reason = el('input');
    reason.type = 'text';
    reason.maxLength = 200;
    reason.placeholder = 'Reason (shown to them)';
    // how long: a number of minutes; 00 means for good
    const dur = el('input');
    dur.type = 'text';
    dur.inputMode = 'numeric';
    dur.maxLength = 7;
    dur.placeholder = 'Minutes (00 = for good)';
    dur.title = 'How many minutes the ban or mute lasts. Type 00 for indefinite.';
    dur.style.width = '150px';
    const minutes = (): number | null => {
      const t = dur.value.trim();
      if (!/^\d+$/.test(t)) return null;
      return Number(t); // "00" and "0" are 0: for good
    };
    const lengthText = (m: number) => (m === 0 ? 'for good' : `for ${m} minute${m === 1 ? '' : 's'}`);
    const row1 = el('div', 'own-row');
    const kick = el('button', 'mm-small', 'Kick');
    kick.disabled = !r.online;
    kick.title = r.online ? 'Disconnect them now' : 'Not online';
    kick.addEventListener('click', () => act({ act: 'kick', reason: reason.value }));
    const ban = el('button', 'mm-small adm-danger', r.banned ? 'Unban' : 'Ban');
    ban.addEventListener('click', () => {
      if (r.banned) return act({ act: 'unban' });
      const m = minutes();
      if (m === null) return this.say('Type how many minutes (00 for good) before banning.', true);
      if (window.confirm(`Ban ${r.name} ${lengthText(m)}? They are disconnected and cannot sign in.`)) act({ act: 'ban', minutes: m, reason: reason.value });
    });
    const mute = el('button', 'mm-small', r.muted ? 'Unmute' : 'Mute');
    mute.addEventListener('click', () => {
      if (r.muted) return act({ act: 'unmute' });
      const m = minutes();
      if (m === null) return this.say('Type how many minutes (00 for good) before muting.', true);
      act({ act: 'mute', minutes: m, reason: reason.value });
    });
    const killBtn = el('button', 'mm-small adm-danger', 'Kill in match');
    killBtn.disabled = !r.online;
    killBtn.title = 'Kill them if they are in a match right now';
    killBtn.addEventListener('click', () => window.confirm(`Kill ${r.name} in their match?`) && act({ act: 'kill' }));
    row1.append(dur, reason, kick, mute, ban, killBtn);
    box.append(el('b', '', 'Moderation'), row1);

    const row2 = el('div', 'own-row');
    const rating = el('input');
    rating.type = 'number';
    rating.value = String(r.rating);
    rating.style.width = '80px';
    const setR = el('button', 'mm-small', 'Set rating');
    setR.addEventListener('click', () => act({ act: 'set_rating', value: Number(rating.value) }));
    const resetS = el('button', 'mm-small', 'Reset stats');
    resetS.addEventListener('click', () => window.confirm(`Reset ${r.name}'s rating, wins and matches?`) && act({ act: 'reset_stats' }));
    const watch = el('button', 'mm-small', 'Follow');
    watch.title = 'Be taken into every match they play';
    watch.addEventListener('click', () => this.hooks.follow?.(r.name));
    row2.append(rating, setR, resetS, watch);
    box.append(row2);

    const note = el('textarea', 'adm-note');
    note.placeholder = 'Private note (only you see it)';
    note.maxLength = 1000;
    note.value = r.note ?? '';
    const saveN = el('button', 'mm-small', 'Save note');
    saveN.addEventListener('click', () => act({ act: 'note', text: note.value }));
    box.append(note, saveN);

    const hist = this.histories.get(r.name);
    const histBtn = el('button', 'mm-small', hist ? 'Refresh matches' : 'Recent matches');
    histBtn.addEventListener('click', () => act({ act: 'history' }));
    box.append(histBtn);
    if (hist) {
      const key = r.name.toLowerCase();
      const ul = el('ul', 'adm-hist');
      for (const h of hist.slice(0, 15)) {
        const me = h.players.find((x) => x.name.toLowerCase() === key);
        const res = h.winner === 'draw' ? 'Draw' : me && h.winner === me.team ? 'Win' : 'Loss';
        ul.append(el('li', '', `${new Date(h.at).toLocaleString()} · ${h.ranked ? 'Ranked ' : ''}${h.size}v${h.size} · ${res} · ${h.players.map((x) => x.name).join(', ')}`));
      }
      if (!hist.length) ul.append(el('li', '', 'No matches yet.'));
      box.append(ul);
    }
    return box;
  }

  // ------------------------------------------------------------------ admin: accounts

  adminList(): HTMLElement {
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
      head.append(dot, nm, el('small', '', `${r.rating} · ${r.wins}W/${r.matches}M · joined ${new Date(r.createdAt).toLocaleDateString()}${r.lastSeen ? ` · seen ${new Date(r.lastSeen).toLocaleString()}` : ''}`));
      if (r.banned) head.append(el('span', 'adm-badge bad', r.banned.until ? 'banned' : 'banned for good'));
      if (r.muted) head.append(el('span', 'adm-badge warn', 'muted'));
      if (r.grants.includes('dev')) head.append(el('span', 'adm-badge dev', 'dev'));
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
      body.append(el('p', 'mm-modal-foot', 'That is you: the founder account cannot be moderated.'));
      return body;
    }
    body.append(this.moderation(r));
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
