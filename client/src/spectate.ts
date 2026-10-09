import type { Popup } from './popups';
import { makeResizable } from './resizable';
import { ABILITIES, ARENAS, CLASSES, contentHash, specOf, talentsFor } from '@arena/shared';
import type { LiveMatch, ReplayData, StatRow, UnitBuild } from '@arena/shared';
import { ABILITY_ICON, CLASS_ICON } from './icons';
import { tipBuildKey } from './tips';
import { compactScreen } from './lightMode';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export const mapName = (id: string): string => ARENAS.find((a) => a.id === id)?.name ?? id;
export const classIcon = (id: string): string => CLASS_ICON[id as keyof typeof CLASS_ICON] ?? '?';

/** Download and unpack a stored replay. Throws a message fit to show the player. */
export async function loadReplay(id: string): Promise<ReplayData> {
  const res = await fetch(`/api/replay/${encodeURIComponent(id)}`);
  if (res.status === 404) throw new Error('That replay is gone (they are kept for 30 days).');
  if (!res.ok) throw new Error('Could not download the replay.');
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open replays. Try a recent Chrome, Edge, Firefox or Safari.');
  const stream = res.body!.pipeThrough(new DecompressionStream('gzip'));
  const data = JSON.parse(await new Response(stream).text()) as ReplayData;
  if (data.v !== 1) throw new Error('Unknown replay format.');
  if (data.hash !== contentHash(data.tickMs)) throw new Error('This replay was recorded on an older version of the game and cannot be played back accurately any more.');
  return data;
}

export interface SpectateHandlers {
  onExit(): void;
  onPause(paused: boolean): void;
  onRate(rate: number): void;
  onSeek(tick: number): void;
  /** The key bound to switching targets (shown in the "follow" hint), e.g. "Tab". */
  switchKey?(): string;
  /** The on-screen previous / next buttons: follow the previous (-1) or next (1) player. */
  onCycle?(dir: 1 | -1): void;
  /** The builds button (the N key on a keyboard). */
  onBuilds?(): void;
  /** The settings button (the Esc menu on a keyboard). */
  onSettings?(): void;
}

/** The replay speeds, slowest first. */
export const RATES = [0.5, 1, 2, 4];
/** The speed after this one, wrapping from the fastest back to the slowest. */
export const nextRate = (r: number): number => RATES[(Math.max(0, RATES.indexOf(r)) + 1) % RATES.length];

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];

/**
 * For people watching (live or a replay): everyone's spec, talents and ability bar, by team. Hover a talent or a skill
 * for its tooltip (skills show that player's own numbers, talents included).
 */
export class BuildsPanel {
  readonly root = el('div', 'builds hidden');
  private units: UnitBuild[] = [];
  /** Folded down to its title bar; remembered in this browser. */
  private minimized = (() => {
    try {
      return localStorage.getItem('arena.buildsMin') === '1';
    } catch {
      return false;
    }
  })();
  setMinimized(on: boolean) {
    this.minimized = on;
    try {
      localStorage.setItem('arena.buildsMin', on ? '1' : '0');
    } catch {
      /* not remembered */
    }
    this.paint();
  }
  constructor() {
    document.body.append(this.root);
    makeResizable(this.root, { key: 'builds', corner: 'bl', minW: 180, minH: 140, z: 30 });
  }
  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }
  /** Wanted on screen: always at first on a big screen, only on request on a phone (it covers half the picture). */
  private wanted = !compactScreen();
  toggle(on = !this.visible) {
    this.wanted = on;
    this.root.classList.toggle('hidden', !on || !this.units.length);
  }
  set(units: UnitBuild[]) {
    this.units = units;
    this.paint();
  }
  clear() {
    this.units = [];
    this.root.replaceChildren();
    this.root.classList.add('hidden');
  }
  private paint() {
    this.root.replaceChildren();
    const head = el('div', 'bd-head', 'Builds');
    const btns = el('span', 'bd-btns');
    const min = el('button', 'mm-small', this.minimized ? '▢' : '–');
    min.title = this.minimized ? 'Expand' : 'Minimize';
    min.addEventListener('click', () => this.setMinimized(!this.minimized));
    const close = el('button', 'mm-small', '✕');
    close.title = 'Hide (N to show again)';
    close.addEventListener('click', () => this.toggle(false));
    btns.append(min, close);
    head.append(btns);
    head.addEventListener('dblclick', () => this.setMinimized(!this.minimized));
    this.root.append(head);
    this.root.classList.toggle('min', this.minimized);
    if (this.minimized) return void this.root.classList.toggle('hidden', !this.units.length || !this.wanted);
    for (const team of [0, 1]) {
      const units = this.units.filter((u) => u.team === team);
      if (!units.length) continue;
      this.root.append(el('div', `bd-team t${team}`, `Team ${team + 1}`));
      for (const u of units) {
        const card = el('div', 'bd-unit');
        const spec = u.spec ? specOf(u.classId, u.spec) : undefined;
        const name = el('div', 'bd-name');
        name.append(el('span', '', `${CLASS_ICON[u.classId] ?? ''} ${u.name}`), el('small', '', spec ? `${spec.name} ${CLASSES[u.classId].name}` : CLASSES[u.classId].name));
        name.style.color = CLASSES[u.classId].color;
        card.append(name);
        const bar = el('div', 'bd-bar');
        const key = tipBuildKey(u.classId, { spec: u.spec ?? '', talents: u.talents, gear: {} });
        for (const a of u.bar) {
          const s = el('span', 'bd-skill', ABILITY_ICON[a] ?? '✦');
          s.dataset.tip = `ability:${a}`;
          s.dataset.tipBuild = key;
          s.setAttribute('aria-label', ABILITIES[a]?.name ?? a);
          bar.append(s);
        }
        card.append(bar);
        const tiers = talentsFor(u.classId, u.spec ?? undefined);
        const tal = el('div', 'bd-talents');
        u.talents.forEach((id, i) => {
          const t = tiers[i]?.find((x) => x.id === id);
          if (!t) return;
          const c = el('span', 'bd-talent', `${ROMAN[i]} ${t.name}`);
          c.dataset.tip = `talent:${u.classId}:${t.id}`;
          tal.append(c);
        });
        if (!tal.childNodes.length) tal.append(el('span', 'bd-none', 'No talents'));
        card.append(tal);
        this.root.append(card);
      }
    }
    this.root.classList.toggle('hidden', !this.units.length || !this.wanted);
  }
}

/** The owner's live scoreboard: damage and healing totals per player, grouped by team. */
export class Scoreboard {
  readonly root = el('div', 'scoreboard hidden');
  private rows: StatRow[] = [];
  constructor() {
    document.body.append(this.root);
  }
  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }
  toggle(on = !this.visible) {
    this.root.classList.toggle('hidden', !on);
    if (on) this.paint();
  }
  private title = 'Scoreboard';
  update(rows: StatRow[], title = 'Scoreboard') {
    this.rows = rows;
    this.title = title;
    if (this.visible) this.paint();
  }
  private paint() {
    const n = (v: number) => v.toLocaleString('en-US');
    const table = el('table', 'sb-table');
    const head = el('tr');
    for (const h of ['Player', 'Damage', 'Healing', 'Dmg taken', 'Healed on', 'Overheal']) head.append(el('th', '', h));
    table.append(head);
    for (const team of [0, 1]) {
      const members = this.rows.filter((r) => r.team === team);
      if (!members.length) continue;
      const best = (k: 'dmg' | 'heal' | 'taken' | 'healTaken') => Math.max(...members.map((r) => r[k]));
      const sum = (k: 'dmg' | 'heal' | 'taken' | 'healTaken' | 'overheal') => members.reduce((a, r) => a + r[k], 0);
      const tr = el('tr', `sb-team t${team}`);
      const label = el('td', '', `Team ${team + 1}`);
      tr.append(label, el('td', '', n(sum('dmg'))), el('td', '', n(sum('heal'))), el('td', '', n(sum('taken'))), el('td', '', n(sum('healTaken'))), el('td', '', n(sum('overheal'))));
      table.append(tr);
      for (const r of members) {
        const row = el('tr', 'sb-row2');
        row.append(el('td', '', `${classIcon(r.classId)} ${r.name}`));
        for (const k of ['dmg', 'heal', 'taken', 'healTaken'] as const) row.append(el('td', r[k] > 0 && r[k] === best(k) ? 'top' : '', n(r[k])));
        row.append(el('td', '', n(r.overheal)));
        table.append(row);
      }
    }
    const title = el('div', 'sb-head', this.title);
    const close = el('button', 'mm-small sb-close', 'Close');
    close.addEventListener('click', () => this.toggle(false));
    const wrap = el('div', 'sb-scroll');
    wrap.append(table);
    this.root.replaceChildren(title, wrap, el('small', 'sb-hint', 'Press B or the button to hide'), close);
  }
}

/** The strip shown while watching: live spectating (just Exit) or a replay (play/pause, speed, seek, share). */
export class SpectateBar {
  readonly root = el('div', 'spec-bar hidden');
  private title = el('span', 'sb-title');
  private follow = el('span', 'sb-follow');
  private play = el('button', 'mm-small sb-play', '⏸');
  private seek = el('input');
  private time = el('span', 'sb-time');
  private rateBtns: HTMLButtonElement[] = [];
  private replayRow = el('div', 'sb-row sb-replay');
  /** One button that steps through the speeds, for screens too narrow for the four. */
  private speedBtn = el('button', 'mm-small sb-speed', '1×');
  private rate = 1;
  private paused = false;
  private total = 1;
  /** Milliseconds per tick of the replay being shown (the clock is ticks times this). */
  private tickMs = 50;
  readonly board = new Scoreboard();
  private scoreBtn = el('button', 'mm-small hidden', 'Scores');
  private fold = el('button', 'mm-small sb-fold', '▴');

  constructor(private h: SpectateHandlers) {
    const top = el('div', 'sb-row sb-top');
    const exit = el('button', 'mm-small sb-exit', 'Leave');
    exit.addEventListener('click', () => h.onExit());
    this.scoreBtn.addEventListener('click', () => this.board.toggle());
    this.scoreBtn.title = 'Scoreboard (B)';
    const builds = el('button', 'mm-small sb-builds', 'Builds');
    builds.title = 'Builds, talents and skills (N)';
    builds.addEventListener('click', () => h.onBuilds?.());
    const cog = el('button', 'mm-small sb-cog', '⚙');
    cog.title = 'Settings';
    cog.setAttribute('aria-label', 'Settings');
    cog.addEventListener('click', () => h.onSettings?.());
    // small screens: the bar folds down to its title so the picture stays clear
    this.fold.title = 'Fold the bar';
    this.fold.addEventListener('click', () => {
      const on = this.root.classList.toggle('folded');
      this.fold.textContent = on ? '▾' : '▴';
    });
    top.append(this.title, this.scoreBtn, builds, cog, exit, this.fold);
    const nav = el('div', 'sb-row sb-nav');
    const prev = el('button', 'mm-small sb-prev', '◀');
    prev.title = 'Previous player';
    prev.setAttribute('aria-label', 'Previous player');
    prev.addEventListener('click', () => h.onCycle?.(-1));
    const next = el('button', 'mm-small sb-next', '▶');
    next.title = 'Next player';
    next.setAttribute('aria-label', 'Next player');
    next.addEventListener('click', () => h.onCycle?.(1));
    nav.append(prev, this.follow, next);

    this.play.addEventListener('click', () => this.setPaused(!this.paused, true));
    this.seek.type = 'range';
    this.seek.min = '0';
    this.seek.value = '0';
    this.seek.addEventListener('input', () => h.onSeek(Number(this.seek.value)));
    const rates = el('span', 'sb-rates');
    for (const r of RATES) {
      const b = el('button', 'mm-small', `${r}×`);
      b.addEventListener('click', () => {
        this.setRate(r);
        h.onRate(r);
      });
      this.rateBtns.push(b);
      rates.append(b);
    }
    this.speedBtn.title = 'Playback speed';
    this.speedBtn.addEventListener('click', () => {
      const r = nextRate(this.rate);
      this.setRate(r);
      h.onRate(r);
    });
    this.replayRow.append(this.play, this.seek, this.time, rates, this.speedBtn);
    this.root.append(top, nav, this.replayRow);
    document.body.append(this.root);
  }

  private setRate(r: number) {
    this.rate = r;
    this.rateBtns.forEach((b, i) => b.classList.toggle('sel', RATES[i] === r));
    this.speedBtn.textContent = `${r}×`;
  }

  setPaused(p: boolean, notify = false) {
    this.paused = p;
    this.play.textContent = p ? '▶' : '⏸';
    if (notify) this.h.onPause(p);
  }

  showLive() {
    this.title.textContent = '👁 Live · 5 s behind';
    this.replayRow.classList.add('hidden');
    this.root.classList.remove('hidden');
  }

  showReplay(totalTicks: number, label: string, shareUrl: string, tickMs = 50) {
    this.tickMs = tickMs;
    this.title.textContent = `⏪ Replay · ${label}`;
    this.title.title = label;
    this.total = Math.max(1, totalTicks);
    this.seek.max = String(this.total);
    this.replayRow.classList.remove('hidden');
    this.setPaused(false);
    this.setRate(1);
    const old = this.root.querySelector('.sb-share');
    old?.remove();
    const share = el('button', 'mm-small sb-share');
    const say = (icon: string, text: string) => {
      share.textContent = icon;
      share.append(el('span', 'sb-lbl', ` ${text}`));
    };
    say('🔗', 'Copy link');
    share.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(shareUrl);
        say('✔', 'Copied');
      } catch {
        share.textContent = shareUrl;
      }
    });
    this.root.firstElementChild!.insertBefore(share, this.scoreBtn);
    this.root.classList.remove('hidden');
  }

  update(tick: number, followName: string) {
    const key = this.h.switchKey?.() ?? 'Tab';
    this.follow.textContent = followName ? `${followName}` : '';
    this.follow.title = followName ? `Following ${followName}. ${key && key !== '—' ? `${key}, ` : ''}the arrows, or a tap on a player switches.` : '';
    if (!this.replayRow.classList.contains('hidden')) {
      if (document.activeElement !== this.seek) this.seek.value = String(tick);
      const s = Math.round((tick * this.tickMs) / 1000);
      const t = Math.round((this.total * this.tickMs) / 1000);
      const f = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
      this.time.textContent = `${f(s)} / ${f(t)}`;
    }
  }

  /** Owner only: stats arrived, so the watch is live (no delay) and the scoreboard can open. */
  setStats(rows: StatRow[]) {
    if (this.scoreBtn.classList.contains('hidden')) {
      this.scoreBtn.classList.remove('hidden');
      this.title.textContent = '👁 Live · no delay';
    }
    this.board.update(rows);
  }

  hide() {
    this.root.classList.add('hidden');
    this.root.classList.remove('folded');
    this.fold.textContent = '▴';
    this.scoreBtn.classList.add('hidden');
    this.board.toggle(false);
  }
}

/** A picker listing the matches in progress. */
export class LivePicker {
  private modal: HTMLElement | null = null;
  readonly popup: Popup = { isOpen: () => !!this.modal, close: () => this.close(), el: () => this.modal };
  constructor(
    private onPick: (id: string) => void,
    private refresh: () => void,
    private signedIn: () => boolean = () => true,
    private needSignIn: () => void = () => {},
    /** Owner only: follow a player into every match they play (null stops). Absent for everyone else. */
    private follow?: { isOwner: () => boolean; current: () => string | null; set: (name: string | null) => void },
  ) {}

  /** The follow box's text, kept while the list redraws itself. */
  private draft: string | null = null;
  private timer = 0;

  show(rows: LiveMatch[] | null) {
    const hadFocus = document.activeElement instanceof HTMLInputElement && this.modal?.contains(document.activeElement);
    this.modal?.remove();
    this.modal = null;
    window.clearInterval(this.timer);
    const modal = el('div', 'mm-modal');
    modal.addEventListener('mousedown', (e) => e.target === modal && this.close());
    const card = el('div', 'mm-modal-card');
    const head = el('div', 'mm-modal-head');
    head.append(el('h2', '', 'Watch live'));
    const close = el('button', 'mm-small', 'Close');
    close.addEventListener('click', () => this.close());
    const again = el('button', 'mm-small', 'Refresh');
    again.addEventListener('click', () => this.refresh());
    head.append(again, close);
    card.append(head);
    if (this.follow?.isOwner()) {
      // the owner can follow someone: they are taken into each match that player starts, without coming back here
      const row = el('div', 'live-follow');
      const now = this.follow.current();
      const input = el('input');
      input.type = 'text';
      input.placeholder = 'Player name';
      input.maxLength = 16;
      input.value = this.draft ?? now ?? '';
      input.addEventListener('input', () => (this.draft = input.value));
      if (hadFocus) queueMicrotask(() => input.focus());
      const go = el('button', 'mm-small mm-go', 'Follow');
      const submit = () => {
        if (!input.value.trim()) return;
        this.follow!.set(input.value.trim());
        this.close();
      };
      go.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
      row.append(el('b', '', now ? `Following ${now}` : 'Follow a player'), input, go);
      if (now) {
        const stop = el('button', 'mm-small', 'Stop');
        stop.addEventListener('click', () => { this.follow!.set(null); this.close(); });
        row.append(stop);
      }
      card.append(row);
    }
    if (!this.signedIn()) {
      again.disabled = true;
      const lock = el('div', 'sg-lock');
      const msg = el('div', 'sg-lock-t');
      msg.append(el('b', '', 'Sign in to watch live matches'), el('small', '', 'Watching is for signed-in players. It only takes a name and a password.'));
      const go = el('button', 'mm-small mm-go', 'Sign in');
      go.addEventListener('click', () => { this.close(); this.needSignIn(); });
      lock.append(msg, go);
      card.append(lock);
    } else if (!rows) card.append(el('p', 'mm-modal-foot', 'Looking for matches…'));
    else if (!rows.length) card.append(el('p', 'mm-modal-foot', 'No matches are being played right now.'));
    else {
      const list = el('div', 'live-list');
      for (const m of rows) {
        const row = el('button', 'live-row');
        const teams = [0, 1].map((t) => m.players.filter((p) => p.team === t).map((p) => `${classIcon(p.classId)} ${p.name}`).join(', '));
        row.append(el('b', '', `${m.ranked ? '🏆 Ranked ' : m.bots ? '🤖 Bot match ' : ''}${m.size}v${m.size} · ${mapName(m.map)}`), el('span', '', `${teams[0]}  vs  ${teams[1]}`), el('small', '', `${Math.floor(m.elapsedMs / 60000)}:${String(Math.floor(m.elapsedMs / 1000) % 60).padStart(2, '0')} in`));
        if (this.follow?.isOwner()) {
          // a follow button for each person in the match (bots have nobody to follow)
          const people = el('span', 'live-people');
          for (const p of m.players.filter((x) => !x.name.startsWith('Bot ') && !x.name.startsWith('Dummy '))) {
            const f = el('span', 'mm-small live-followbtn', `Follow ${p.name}`);
            f.addEventListener('click', (e) => {
              e.stopPropagation();
              this.follow!.set(p.name);
              this.close();
            });
            people.append(f);
          }
          if (people.childNodes.length) row.append(people);
        }
        row.addEventListener('click', () => {
          this.close();
          this.onPick(m.id);
        });
        list.append(row);
      }
      card.append(list);
    }
    modal.append(card);
    document.body.append(modal);
    this.modal = modal;
    // the list keeps itself up to date while it is open: matches appear and disappear as they start and end
    if (this.signedIn()) this.timer = window.setInterval(() => this.modal && this.refresh(), 3000);
  }

  close() {
    window.clearInterval(this.timer);
    this.draft = null;
    this.modal?.remove();
    this.modal = null;
  }
}
