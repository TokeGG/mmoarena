import { ABILITIES, AURAS, ICON_LIST, fileIconIdFor, iconDef, iconTitle, iconUrl } from '@arena/shared';
import type { DataPatch, IconKind } from '@arena/shared';
import type { EditSet } from './devEdits';
import { chooseIcon, gridIcons, iconChanged, iconTarget, iconOffered, packChips, previewOf, putBackIcon } from './iconEditLogic';
import { iconEl, setIconPreview, shownIconId } from './iconArt';
import { loadPrivateIcons, privateIconsNow } from './iconPrivate';
import { SCHOOL_GRADIENT } from './icons';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export interface IconEditorHost {
  set: EditSet;
  testing(): Map<string, DataPatch>;
  canRevert: boolean;
  /** An icon was picked or put back (the counters and the changes list follow). */
  onEdit(): void;
  /** Save what was picked (send it on as a proposal). Absent when the host has nowhere to save to. */
  save?: () => string | void;
  saveTitle?: string;
}

/**
 * The "Icon edit" page's right-hand window: the skill (or buff) on show with its icon large and as it looks on the action bar,
 * a search box, pack chips and the grid of every icon in the library. Clicking an icon gives it to the skill at once (on screen;
 * Try, Keep and Send handle it like any other change). The grid is built once and filtered by hiding tiles.
 */
export class IconEditor {
  query = '';
  pack = '';
  private grid: HTMLElement | null = null;
  private tiles = new Map<string, HTMLButtonElement>();
  private box: HTMLElement | null = null;
  private navId = '';
  private availKey = -1;
  private paint: (() => void) | null = null;

  constructor(private host: IconEditorHost) {}

  /** Draw the window for a skill ("a:fireball") or buff ("u:polymorph") into `box`. */
  draw(box: HTMLElement, navId: string): void {
    this.box = box;
    this.navId = navId;
    const t = iconTarget(navId);
    if (!t) return void box.append(el('small', 'devp-dim', 'Pick a skill or buff on the left.'));
    const name = t.kind === 'ability' ? ABILITIES[t.id]?.name : AURAS[t.id]?.name;
    if (!name) return void box.append(el('small', 'devp-dim', 'That one is gone.'));
    // the icons of a private pack are offered once the server says it has them
    void loadPrivateIcons().then((s) => {
      if (s.size !== this.availKey && this.box?.isConnected && this.navId === navId) {
        this.grid = null;
        this.box.replaceChildren();
        this.draw(this.box, navId);
      }
    });
    this.availKey = privateIconsNow()?.size ?? 0;

    const top = el('div', 'ie-top');
    const big = el('div', 'ie-big');
    const info = el('div', 'ie-info');
    const nameEl = el('div', 'devp-title', name);
    const wears = el('small', 'devp-dim');
    const prev = el('div', 'ie-prev');
    const back = el('button', 'mm-small', '↺ Put back the default');
    back.addEventListener('click', () => {
      putBackIcon(this.host.set, navId, this.host.testing(), this.host.canRevert);
      this.changed();
    });
    const save = el('button', 'mm-small mm-go', '💾 Save');
    save.title = this.host.saveTitle ?? 'Save the icons you picked';
    save.hidden = !this.host.save;
    const saved = el('small', 'devp-dim');
    save.addEventListener('click', () => {
      saved.textContent = String(this.host.save?.() ?? 'Saved.');
    });
    info.append(nameEl, wears, back, save, saved);
    top.append(big, info, prev);

    this.paint = () => {
      const cur = shownIconId(t.kind, t.id);
      big.replaceChildren(iconEl(t.kind, t.id, '', false, name));
      wears.textContent = cur ? `${iconTitle(cur)}${iconChanged(this.host.set, navId, this.host.testing()) ? ' (changed)' : ''}` : 'no picture: the emoji';
      back.disabled = !iconChanged(this.host.set, navId, this.host.testing());
      save.disabled = this.host.set.edits.size === 0;
      prev.replaceChildren(this.preview(t.kind, t.id, name));
      const def = fileIconIdFor(t.kind, t.id);
      for (const [id, b] of this.tiles) {
        b.classList.toggle('cur', id === cur);
        b.classList.toggle('def', id === def);
        b.setAttribute('aria-pressed', String(id === cur));
      }
    };

    const find = el('div', 'ie-find');
    const input = el('input', 'devp-search');
    input.type = 'search';
    input.placeholder = 'Search icons by name, pack or kind (fire, shield, barbarian…)';
    input.value = this.query;
    input.addEventListener('keydown', (e) => e.stopPropagation());
    const count = el('small', 'devp-dim ie-count');
    const chips = el('div', 'ie-chips');
    const grid = this.buildGrid();
    const filter = () => {
      const show = new Set(gridIcons(this.query, this.pack, privateIconsNow()).map((i) => i.id));
      for (const [id, b] of this.tiles) b.hidden = !show.has(id);
      count.textContent = `${show.size} icon${show.size === 1 ? '' : 's'}`;
      grid.classList.toggle('empty', show.size === 0);
      drawChips();
    };
    const drawChips = () => {
      chips.replaceChildren();
      for (const c of packChips(this.query, privateIconsNow())) {
        const b = el('button', `ie-chip${c.id === this.pack ? ' sel' : ''}`);
        b.append(el('span', '', `${c.locked ? '🔒 ' : ''}${c.name}`), el('small', '', String(c.count)));
        if (c.locked) b.title = 'A private pack: its files are served by the game server only';
        b.addEventListener('click', () => {
          this.pack = c.id;
          filter();
        });
        chips.append(b);
      }
    };
    input.addEventListener('input', () => {
      this.query = input.value.trim();
      filter();
    });
    find.append(input, count);

    box.append(top, find, chips, grid, el('small', 'devp-dim ie-foot', 'Looks only: an icon never changes a match. The one with the corner dot is the default.'));
    this.paint();
    filter();
  }

  /** The skill as it looks on the bar (or the buff as it looks on a unit). */
  private preview(kind: IconKind, id: string, name: string): HTMLElement {
    const wrap = el('div', 'ie-previews');
    if (kind === 'ability') {
      const slot = el('div', 'slot ie-slot');
      slot.style.background = SCHOOL_GRADIENT[ABILITIES[id].school];
      const ico = el('span', 'ico');
      ico.append(iconEl('ability', id, '', false, name));
      slot.append(ico, el('span', 'nm', name), el('span', 'key', '1'));
      wrap.append(slot);
    } else {
      const harmful = !!AURAS[id]?.harmful;
      const a = el('div', `aura ${harmful ? 'bad' : 'good'} ie-aura`);
      a.append(iconEl('aura', id, '', false, name), el('i', '', '8'));
      const small = el('div', `pdebuff${harmful ? '' : ' good'} ie-pdebuff`);
      small.append(iconEl('aura', id));
      wrap.append(a, small);
    }
    return wrap;
  }

  private buildGrid(): HTMLElement {
    if (this.grid) return this.grid;
    const grid = el('div', 'ie-grid');
    this.tiles.clear();
    const avail = privateIconsNow();
    for (const i of ICON_LIST) {
      if (!iconOffered(i, avail)) continue;
      const b = el('button', 'ie-tile');
      b.type = 'button';
      b.dataset.icon = i.id;
      b.title = `${i.name} · ${iconTitle(i.id).split(':')[0]}`;
      b.setAttribute('aria-label', b.title);
      const img = document.createElement('img');
      img.src = iconUrl(i.id);
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.draggable = false;
      b.append(img);
      b.addEventListener('click', () => {
        if (!iconDef(i.id)) return;
        chooseIcon(this.host.set, this.navId, i.id, this.host.testing(), this.host.canRevert);
        this.changed();
      });
      this.tiles.set(i.id, b);
      grid.append(b);
    }
    this.grid = grid;
    return grid;
  }

  /** A pick or put-back: the screen follows at once, then the panel's counters and list. */
  private changed(): void {
    setIconPreview(previewOf(this.host.set));
    this.paint?.();
    this.host.onEdit();
  }
}
