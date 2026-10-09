import { CLASSES } from '@arena/shared';
import type { UnitBuild } from '@arena/shared';
import { registerPopup } from './popups';

/**
 * Owner only: the "Play as…" list of a watched match's bots and the small "Hand back to bot" chip shown while one is played.
 * Nothing here is ever visible to anyone else (the server sends no sign of a takeover to other clients).
 */
export class TakeoverUi {
  private chip = document.createElement('div');
  private label = document.createElement('span');
  private list = document.createElement('div');

  constructor(private h: { onPick(unit: number): void; onRelease(): void }) {
    this.chip.className = 'takeover-chip hidden';
    const back = document.createElement('button');
    back.textContent = 'Hand back to bot';
    back.title = 'A bot plays this character again, at once';
    back.addEventListener('click', () => h.onRelease());
    this.chip.append(this.label, back);
    this.list.className = 'takeover-list hidden';
    document.body.append(this.chip, this.list);
    registerPopup({ isOpen: () => !this.list.classList.contains('hidden'), close: () => this.close(), el: () => this.list });
  }

  /** Show the chip while a bot is played (its name), hide it with null. */
  setControlling(name: string | null): void {
    this.chip.classList.toggle('hidden', !name);
    this.label.textContent = name ? `🎮 Playing ${name}` : '';
    this.close();
  }

  close(): void {
    this.list.classList.add('hidden');
  }

  /** The bots among these units, as buttons under `anchor`. */
  pick(units: readonly UnitBuild[], anchor: HTMLElement): void {
    if (!this.list.classList.contains('hidden')) return this.close();
    const bots = units.filter((u) => u.bot);
    this.list.replaceChildren();
    if (!bots.length) {
      const none = document.createElement('small');
      none.textContent = 'No bots in this match.';
      this.list.append(none);
    }
    for (const u of bots) {
      const b = document.createElement('button');
      b.textContent = `${u.name} · ${CLASSES[u.classId]?.name ?? u.classId} · team ${u.team + 1}`;
      b.addEventListener('click', () => {
        this.close();
        this.h.onPick(u.id);
      });
      this.list.append(b);
    }
    const r = anchor.getBoundingClientRect();
    this.list.style.top = `${Math.round(r.bottom + 4)}px`;
    this.list.style.left = `${Math.max(8, Math.min(Math.round(r.left), window.innerWidth - 250))}px`;
    this.list.classList.remove('hidden');
  }
}
