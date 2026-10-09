import { ABILITIES, AURAS, CLASSES, ICON_LIST, ICON_PACKS, SPECS, fileIconIdFor, iconDef, iconTitle, iconUrl } from '@arena/shared';
import type { DataPatch, IconKind } from '@arena/shared';
import type { EditSet } from './devEdits';
import { chooseIcon, suggestedIcons, gridIcons, iconChanged, iconTarget, iconOffered, packChips, previewOf, putBackIcon } from './iconEditLogic';
import { iconEl, setIconPreview, shownIconId } from './iconArt';
import { loadPrivateIcons, privateIconsNow } from './iconPrivate';
import { DROP_LIMITS, deletePack, filesOfDrop, loadCustomIcons, packNameProblem, stageFiles, suggestPackName, uploadPack } from './iconCustom';
import type { Staged } from './iconCustom';
import { SCHOOL_GRADIENT } from './icons';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const STYLE = `
.ie-drop { margin-top:10px; padding:10px; border:2px dashed #3d3550; border-radius:8px; background:#15131d; text-align:center; transition:border-color .12s, background .12s; }
.ie-drop.over { border-color:#c9a24a; background:#211c2c; }
.ie-drop b { color:#e6dfc8; font-weight:600; }
.ie-drop .ie-drop-row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; justify-content:center; margin:6px 0; }
.ie-drop small { display:block; }
.ie-stage { display:flex; flex-direction:column; gap:6px; align-items:center; margin-top:8px; }
.ie-stage .ie-thumbs { display:flex; flex-wrap:wrap; gap:3px; justify-content:center; max-width:100%; }
.ie-stage .ie-thumbs img { width:32px; height:32px; border-radius:4px; background:#0d0c12; }
.ie-stage input[type=text] { width:12em; max-width:100%; background:#0d0c12; border:1px solid #3d3550; border-radius:5px; color:#e6dfc8; padding:3px 6px; font:inherit; }
.ie-stage .ie-bad { color:#ff8a8a; }
.ie-stage .ie-ok { color:#8fd18f; }
.ie-cloud { color:#8ab4ff; }
`;

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
  private sugTiles = new Map<string, HTMLButtonElement>();
  private paint: (() => void) | null = null;
  private pickFiles: (() => void) | null = null;
  private dropAbort: AbortController | null = null;

  constructor(private host: IconEditorHost) {}

  /** Draw the window for a skill ("a:fireball") or buff ("u:polymorph") into `box`. */
  draw(box: HTMLElement, navId: string): void {
    this.box = box;
    this.navId = navId;
    const t = iconTarget(navId);
    if (!t) return void box.append(el('small', 'devp-dim', 'Pick a skill or buff on the left.'));
    const name = t.kind === 'ability' ? ABILITIES[t.id]?.name : t.kind === 'aura' ? AURAS[t.id]?.name : t.kind === 'class' ? CLASSES[t.id as keyof typeof CLASSES]?.name : Object.values(SPECS).flat().find((s) => s.id === t.id)?.name;
    if (!name) return void box.append(el('small', 'devp-dim', 'That one is gone.'));
    // the icons of a private pack are offered once the server says it has them
    void loadPrivateIcons().then((s) => {
      if (s.size !== this.availKey && this.box?.isConnected && this.navId === navId) {
        this.grid = null;
        this.box.replaceChildren();
        this.draw(this.box, navId);
      }
    });
    // the packs uploaded to this server join the library
    void loadCustomIcons().then((changed) => {
      if (changed && this.box?.isConnected && this.navId === navId) this.rebuild();
    });
    this.availKey = privateIconsNow()?.size ?? 0;
    this.sugTiles.clear();

    const top = el('div', 'ie-top');
    const big = el('div', `ie-big${t.kind === 'class' || t.kind === 'spec' ? ' round' : ''}`);
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
      for (const [id, b] of [...this.tiles, ...this.sugTiles]) {
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
    const del = el('button', 'mm-small', '🗑 Delete this custom pack');
    del.title = 'Only the owner can delete a pack';
    del.hidden = true;
    del.addEventListener('click', () => {
      const pack = this.pack;
      if (!ICON_PACKS.find((p) => p.id === pack)?.custom || !confirm(`Delete the custom pack "${pack}" and its icons from this server? Skills that wear one of them lose the picture.`)) return;
      void deletePack(pack).then(async (r) => {
        if (!r.ok) return void alert(r.text);
        this.pack = '';
        await loadCustomIcons();
        this.rebuild();
      });
    });
    const grid = this.buildGrid();
    const filter = () => {
      const show = new Set(gridIcons(this.query, this.pack, privateIconsNow()).map((i) => i.id));
      for (const [id, b] of this.tiles) b.hidden = !show.has(id);
      count.textContent = `${show.size} icon${show.size === 1 ? '' : 's'}`;
      grid.classList.toggle('empty', show.size === 0);
      drawChips();
      del.hidden = !ICON_PACKS.find((p) => p.id === this.pack)?.custom;
    };
    const drawChips = () => {
      chips.replaceChildren();
      for (const c of packChips(this.query, privateIconsNow())) {
        const b = el('button', `ie-chip${c.id === this.pack ? ' sel' : ''}`);
        const label = el('span', '', `${c.locked ? '🔒 ' : ''}${c.name}`);
        if (c.custom) label.append(el('span', 'ie-cloud', ' ☁'));
        b.append(label, el('small', '', String(c.count)));
        if (c.locked) b.title = 'A private pack: its files are served by the game server only';
        if (c.custom) b.title = 'A custom pack: lives on this server only';
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
    const addBtn = el('button', 'mm-small', '⬆ Add pack');
    addBtn.title = 'Make a new icon pack from images or a zip (or drop them anywhere in this window)';
    addBtn.addEventListener('click', () => this.pickFiles?.());
    find.append(input, count, addBtn);

    const sug = suggestedIcons(navId, privateIconsNow());
    const sugRow = el('div', 'ie-sug');
    if (sug.length) {
      sugRow.append(el('small', 'devp-dim', 'Suggested (made for it)'));
      const row = el('div', 'ie-grid ie-sugrow');
      for (const i of sug) {
        const b = this.tile(i.id);
        this.sugTiles.set(i.id, b);
        row.append(b);
      }
      sugRow.append(row);
    }
    box.append(top, sugRow, find, chips, del, grid, this.dropZone(), el('small', 'devp-dim ie-foot', 'Looks only: an icon never changes a match. The one with the corner dot is the default. Custom icons (☁) live on this server only.'));
    this.paint();
    filter();
  }

  /** Draw the whole window again (the library changed). */
  private rebuild(): void {
    if (!this.box) return;
    this.grid = null;
    this.box.replaceChildren();
    this.draw(this.box, this.navId);
  }

  /** The drop zone at the bottom: images or a zip are made into a new custom pack (128 x 128 WebP each) on this server. */
  private dropZone(): HTMLElement {
    if (!document.getElementById('ie-drop-style')) {
      const st = document.createElement('style');
      st.id = 'ie-drop-style';
      st.textContent = STYLE;
      document.head.append(st);
    }
    const zone = el('div', 'ie-drop');
    zone.dataset.drop = 'icons';
    const pick = el('button', 'mm-small', 'Choose files…');
    pick.type = 'button';
    const input = el('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.png,.jpg,.jpeg,.webp,.gif,.zip,image/*,application/zip';
    input.hidden = true;
    const row = el('div', 'ie-drop-row');
    row.append(pick, input);
    const stage = el('div', 'ie-stage');
    zone.append(
      el('b', '', '⬆ Add an icon pack'),
      el('small', 'devp-dim', 'Drop images (PNG, JPG, WebP, GIF) or a zip of them here. Each becomes a 128×128 icon in a new pack.'),
      row,
      el('small', 'devp-dim', `Up to ${DROP_LIMITS.images} images and 8 MB per drop. Custom icons live on this server only.`),
      stage,
    );
    this.pickFiles = () => {
      zone.scrollIntoView?.({ block: 'center' });
      input.click();
    };
    const say = (text: string, cls = 'devp-dim') => stage.replaceChildren(el('small', cls, text));
    const handle = async (files: { file: File; path: string }[]) => {
      if (!files.length) return;
      zone.scrollIntoView?.({ block: 'nearest' });
      say('Reading the pictures…');
      let staged: Staged;
      try {
        staged = await stageFiles(files, (d, n) => say(`Resizing ${d + 1} of ${n}…`));
      } catch (e) {
        return say(e instanceof Error ? e.message : 'Could not read that.', 'ie-bad');
      }
      stage.replaceChildren();
      if (!staged.icons.length) return say(`No usable images in that drop. ${staged.notes.join(' ')}`.trim(), 'ie-bad');
      const thumbs = el('div', 'ie-thumbs');
      for (const i of staged.icons.slice(0, 16)) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(new Blob([i.webp as BlobPart], { type: 'image/webp' }));
        img.addEventListener('load', () => URL.revokeObjectURL(img.src));
        img.alt = '';
        thumbs.append(img);
      }
      const name = el('input');
      name.type = 'text';
      name.maxLength = 24;
      name.value = suggestPackName(staged.from);
      name.setAttribute('aria-label', 'Pack name');
      name.addEventListener('keydown', (e) => e.stopPropagation());
      const bad = el('small', 'ie-bad');
      const go = el('button', 'mm-small mm-go', `Add ${staged.icons.length} icon${staged.icons.length === 1 ? '' : 's'} as a pack`);
      const cancel = el('button', 'mm-small', 'Cancel');
      const check = () => {
        const p = packNameProblem(name.value);
        bad.textContent = p ?? '';
        go.disabled = !!p;
      };
      name.addEventListener('input', check);
      cancel.addEventListener('click', () => stage.replaceChildren());
      go.addEventListener('click', () => {
        go.disabled = cancel.disabled = true;
        bad.textContent = 'Uploading…';
        void uploadPack(name.value, staged.icons).then(async (r) => {
          if (!r.ok) {
            bad.textContent = r.text;
            cancel.disabled = false;
            return check();
          }
          await loadCustomIcons();
          this.pack = name.value;
          this.rebuild();
        });
      });
      const nameRow = el('div', 'ie-drop-row');
      nameRow.append(el('small', 'devp-dim', 'Pack name'), name, go, cancel);
      stage.append(el('small', 'ie-ok', `${staged.icons.length} icon${staged.icons.length === 1 ? '' : 's'} ready`), thumbs, nameRow, bad);
      if (staged.notes.length) stage.append(el('small', 'devp-dim', staged.notes.join(' ')));
      check();
    };
    pick.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      void handle([...(input.files ?? [])].map((file) => ({ file, path: file.name })));
      input.value = '';
    });
    // a drop anywhere on the window works (the grid is long), the zone at the bottom is the marked place
    const target = this.box ?? zone;
    this.dropAbort?.abort();
    this.dropAbort = new AbortController();
    const { signal } = this.dropAbort;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    for (const ev of ['dragenter', 'dragover'] as const) {
      target.addEventListener(ev, (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        zone.classList.add('over');
      }, { signal });
    }
    target.addEventListener('dragleave', (e) => {
      if (!target.contains(e.relatedTarget as Node | null)) zone.classList.remove('over');
    }, { signal });
    target.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      zone.classList.remove('over');
      if (e.dataTransfer) void filesOfDrop(e.dataTransfer).then(handle);
    }, { signal });
    return zone;
  }

  /** The skill as it looks on the bar (or the buff as it looks on a unit). */
  private preview(kind: IconKind, id: string, name: string): HTMLElement {
    const wrap = el('div', 'ie-previews');
    if (kind === 'class' || kind === 'spec') {
      const a = el('div', 'ie-round');
      a.append(iconEl(kind, id, '', false, name));
      const b = el('div', 'ie-round small');
      b.append(iconEl(kind, id));
      wrap.append(a, b);
    } else if (kind === 'ability') {
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
      const b = this.tile(i.id);
      this.tiles.set(i.id, b);
      grid.append(b);
    }
    this.grid = grid;
    return grid;
  }

  private tile(id: string): HTMLButtonElement {
    const i = iconDef(id)!;
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
      chooseIcon(this.host.set, this.navId, i.id, this.host.testing(), this.host.canRevert);
      this.changed();
    });
    return b;
  }

  /** A pick or put-back: the screen follows at once, then the panel's counters and list. */
  private changed(): void {
    setIconPreview(previewOf(this.host.set));
    this.paint?.();
    this.host.onEdit();
  }
}
