import { ARENAS, contentHash } from '@arena/shared';
import type { LiveMatch, ReplayData, StatRow } from '@arena/shared';
import { CLASS_ICON } from './icons';

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
  if (data.hash !== contentHash()) throw new Error('This replay was recorded on an older version of the game and cannot be played back accurately any more.');
  return data;
}

export interface SpectateHandlers {
  onExit(): void;
  onPause(paused: boolean): void;
  onRate(rate: number): void;
  onSeek(tick: number): void;
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
    this.root.replaceChildren(title, table, el('small', '', 'Press B or the button to hide'));
  }
}

/** The strip shown while watching: live spectating (just Exit) or a replay (play/pause, speed, seek, share). */
export class SpectateBar {
  readonly root = el('div', 'spec-bar hidden');
  private title = el('span', 'sb-title');
  private follow = el('span', 'sb-follow');
  private play = el('button', 'mm-small', '⏸');
  private seek = el('input');
  private time = el('span', 'sb-time');
  private rateBtns: HTMLButtonElement[] = [];
  private replayRow = el('div', 'sb-row');
  private paused = false;
  private total = 1;
  readonly board = new Scoreboard();
  private scoreBtn = el('button', 'mm-small hidden', 'Scoreboard (B)');

  constructor(private h: SpectateHandlers) {
    const top = el('div', 'sb-row');
    const exit = el('button', 'mm-small', 'Exit');
    exit.addEventListener('click', () => h.onExit());
    this.scoreBtn.addEventListener('click', () => this.board.toggle());
    top.append(this.title, this.follow, this.scoreBtn, exit);

    this.play.addEventListener('click', () => this.setPaused(!this.paused, true));
    this.seek.type = 'range';
    this.seek.min = '0';
    this.seek.value = '0';
    this.seek.addEventListener('input', () => h.onSeek(Number(this.seek.value)));
    const rates = el('span', 'sb-rates');
    for (const r of [0.5, 1, 2, 4]) {
      const b = el('button', 'mm-small', `${r}×`);
      b.addEventListener('click', () => {
        this.setRate(r);
        h.onRate(r);
      });
      this.rateBtns.push(b);
      rates.append(b);
    }
    this.replayRow.append(this.play, this.seek, this.time, rates);
    this.root.append(top, this.replayRow);
    document.body.append(this.root);
  }

  private setRate(r: number) {
    this.rateBtns.forEach((b, i) => b.classList.toggle('sel', [0.5, 1, 2, 4][i] === r));
  }

  setPaused(p: boolean, notify = false) {
    this.paused = p;
    this.play.textContent = p ? '▶' : '⏸';
    if (notify) this.h.onPause(p);
  }

  showLive() {
    this.title.textContent = '👁 Watching live · 5 s behind';
    this.replayRow.classList.add('hidden');
    this.root.classList.remove('hidden');
  }

  showReplay(totalTicks: number, label: string, shareUrl: string) {
    this.title.textContent = `⏪ Replay · ${label}`;
    this.total = Math.max(1, totalTicks);
    this.seek.max = String(this.total);
    this.replayRow.classList.remove('hidden');
    this.setPaused(false);
    this.setRate(1);
    const old = this.root.querySelector('.sb-share');
    old?.remove();
    const share = el('button', 'mm-small sb-share', '🔗 Copy link');
    share.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(shareUrl);
        share.textContent = '✔ Copied';
      } catch {
        share.textContent = shareUrl;
      }
    });
    this.root.firstElementChild!.insertBefore(share, this.root.firstElementChild!.lastElementChild);
    this.root.classList.remove('hidden');
  }

  update(tick: number, followName: string) {
    this.follow.textContent = followName ? `following ${followName} · Tab or click to switch` : '';
    if (!this.replayRow.classList.contains('hidden')) {
      if (document.activeElement !== this.seek) this.seek.value = String(tick);
      const s = Math.round((tick * 50) / 1000);
      const t = Math.round((this.total * 50) / 1000);
      const f = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
      this.time.textContent = `${f(s)} / ${f(t)}`;
    }
  }

  /** Owner only: stats arrived, so the watch is live (no delay) and the scoreboard can open. */
  setStats(rows: StatRow[]) {
    if (this.scoreBtn.classList.contains('hidden')) {
      this.scoreBtn.classList.remove('hidden');
      this.title.textContent = '👁 Watching live · no delay (owner)';
    }
    this.board.update(rows);
  }

  hide() {
    this.root.classList.add('hidden');
    this.scoreBtn.classList.add('hidden');
    this.board.toggle(false);
  }
}

/** A picker listing the matches in progress. */
export class LivePicker {
  private modal: HTMLElement | null = null;
  constructor(private onPick: (id: string) => void, private refresh: () => void) {}

  show(rows: LiveMatch[] | null) {
    this.close();
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
    if (!rows) card.append(el('p', 'mm-modal-foot', 'Looking for matches…'));
    else if (!rows.length) card.append(el('p', 'mm-modal-foot', 'No matches are being played right now.'));
    else {
      const list = el('div', 'live-list');
      for (const m of rows) {
        const row = el('button', 'live-row');
        const teams = [0, 1].map((t) => m.players.filter((p) => p.team === t).map((p) => `${classIcon(p.classId)} ${p.name}`).join(', '));
        row.append(el('b', '', `${m.ranked ? '🏆 Ranked ' : ''}${m.size}v${m.size} · ${mapName(m.map)}`), el('span', '', `${teams[0]}  vs  ${teams[1]}`), el('small', '', `${Math.floor(m.elapsedMs / 60000)}:${String(Math.floor(m.elapsedMs / 1000) % 60).padStart(2, '0')} in`));
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
  }

  close() {
    this.modal?.remove();
    this.modal = null;
  }
}
