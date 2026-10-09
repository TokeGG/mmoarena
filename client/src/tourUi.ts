/**
 * The lists that replay tours: "Help & tours" for players (the Esc menu and the main menu) and the Tours section of the
 * admin panel. Both use `toursList`; the Help window is a small window of its own, drawn over everything but a running tour.
 */
import { tours } from './tour';
import { TOUR_LIST } from './tourData';
import { registerPopup } from './popups';
import type { Popup } from './popups';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const GROUP_TITLE = { dev: 'Dev tools', admin: 'Admin panel', player: 'The game' } as const;

/** One row per tour with a replay button, grouped. `started` runs when a tour was launched (the Help window closes itself). */
export function toursList(groups: readonly ('player' | 'dev' | 'admin')[], started?: () => void): HTMLElement {
  const box = el('div', 'tour-list');
  const say = el('div', 'tour-say');
  say.setAttribute('aria-live', 'polite');
  for (const g of groups) {
    const defs = TOUR_LIST.filter((d) => d.group === g);
    if (!defs.length) continue;
    if (groups.length > 1) box.append(el('h4', 'tour-group', GROUP_TITLE[g]));
    for (const d of defs) {
      const row = el('div', 'tour-row');
      const info = el('div', 'tour-info');
      const seen = tours.isSeen(d.id);
      info.append(el('b', '', d.name), el('small', seen ? 'tour-seen' : 'tour-new', seen ? 'seen' : 'new'), el('div', 'tour-blurb', d.blurb));
      const go = el('button', 'mm-small', 'Replay');
      go.type = 'button';
      go.addEventListener('click', () => {
        const why = tours.launch(d.id);
        say.textContent = why ?? '';
        if (!why) started?.();
      });
      row.append(info, go);
      box.append(row);
    }
  }
  box.append(say);
  return box;
}

/** "Help & tours": the player tours, and a link that makes every tour new again. */
class HelpWindow implements Popup {
  private root: HTMLElement | null = null;
  isOpen() {
    return !!this.root;
  }
  el() {
    return this.root;
  }
  close() {
    this.root?.remove();
    this.root = null;
  }
  open() {
    this.close();
    const root = el('div', 'tour-help');
    root.addEventListener('mousedown', (e) => e.target === root && this.close());
    const card = el('div', 'tour-help-card');
    const head = el('div', 'mm-modal-head');
    const done = el('button', 'mm-small', 'Close');
    done.type = 'button';
    done.addEventListener('click', () => this.close());
    head.append(el('h2', '', 'Help & tours'), done);
    card.append(head, el('p', 'mm-modal-foot', 'Short guided walkthroughs. They also start by themselves the first time you reach each part of the game.'), toursList(['player'], () => this.close()));
    const reset = el('button', 'mm-link', 'Reset all tours');
    reset.type = 'button';
    reset.title = 'Every tour counts as new again and shows by itself next time';
    reset.addEventListener('click', () => {
      tours.resetAll();
      this.open();
    });
    card.append(reset);
    root.append(card);
    document.body.append(root);
    this.root = root;
  }
}

export const helpWindow = new HelpWindow();
registerPopup(helpWindow);
