import { applySkinTo, loadSkin, optionsFor, resetSkin, setSkin, skinChanged, skinValue } from './hudSkin';
import { HUD_IDS, HUD_TEXT_BOX, HUD_TEXT_MAX, HUD_TEXT_MIN, clamp, layerLayout, parseHudLayout } from '@arena/shared';
import type { HudLayoutMap } from '@arena/shared';
import { EDIT_BODY_CLASSES, EDIT_IDLE, closeEditor, leavesEditor, openEditor, type HudEditState } from './hudEditState';
import { sameLayout, sourceOf, tagText, viewLayout, whereText, type EditMode } from './hudLayers';
import { LOOK_OPTIONS, look, loadLook, setLook } from './hudLook';
import { nameplateEditorOpen, openNameplateEditor } from './nameplateEditor';

/**
 * HUD layout editor. Every movable element gets a saved offset and scale applied through the CSS `translate` and
 * `scale` properties, which compose with each element's own positioning and transforms. Edit mode (from the Esc menu)
 * lets you drag elements and scroll over one to resize it; positions persist in localStorage.
 */

interface Slot {
  dx: number;
  dy: number;
  s: number;
  /** Width and height set by dragging the element's corner (before its scale), or none for its natural size. */
  w?: number;
  h?: number;
  /** Text size multiplier for boxes of text (the combat log, kill feed, network stats). */
  t?: number;
}
/** What is saved (and synced to other devices): the offset as a fraction of the screen, so a layout made on a big screen still fits a small one. */
type Saved = HudLayoutMap[string];

/** Boxes of text: their text grows with the box (dragging the corner) and with the scroll wheel. Value: the text size in px at 1x. */
const TEXT_BOX = HUD_TEXT_BOX;
const TEXT_MIN = HUD_TEXT_MIN;
const TEXT_MAX = HUD_TEXT_MAX;

/** The spectator bar breaks into three strips on phones and tablets (index.html: `.spec-bar { display:contents }`). */
const COMPACT_Q = '(max-width:900px), (pointer:coarse)';
const compact = (): boolean => {
  try {
    return window.matchMedia(COMPACT_Q).matches;
  } catch {
    return false;
  }
};

interface Target {
  id: string;
  label: string;
  /** Where to find it when the id is not an element id. */
  sel?: string;
  /** Only movable on some screens. */
  active?: () => boolean;
  /** Shown as a stand-in while editing (the real one only exists for a moment, so it is hidden meanwhile). */
  ghost?: () => HTMLElement;
}

const mkGhost = (cls: string, html: string): HTMLElement => {
  const g = document.createElement('div');
  g.className = `${cls} hud-ghost`;
  g.innerHTML = html;
  return g;
};

const TARGET_DEFS: Target[] = [
  { id: 'self-frame', label: 'Your frame' },
  { id: 'target-frame', label: 'Target' },
  { id: 'party', label: 'Party' },
  { id: 'enemies', label: 'Enemies' },
  { id: 'actionbar', label: 'Action bar' },
  { id: 'trinketbar', label: 'Trinket button' },
  { id: 'cast', label: 'Cast bar' },
  { id: 'autoind', label: 'Auto-attack' },
  { id: 'log', label: 'Combat log' },
  { id: 'killfeed', label: 'Kill feed' },
  { id: 'dpsmeter', label: 'DPS meter' },
  { id: 'recap', label: 'Match recap' },
  { id: 'help', label: 'Help text' },
  { id: 'err', label: 'Error text' },
  { id: 'ccstate', label: 'Stun text' },
  { id: 'netstats', label: 'Network stats' },
  { id: 'mute-btn', label: 'Sound button' },
  { id: 'devbtn', label: 'Dev button' },
  { id: 'banner', label: 'Match banner' },
  { id: 'damp', label: 'Dampening' },
  { id: 'endchoice', label: 'Ready / Leave' },
  { id: 'announce', label: 'Announcement', sel: '.announce', ghost: () => mkGhost('announce in', '<button class="announce-x">✕</button><div class="announce-head">📣 Announcement from the owner<small>12:00</small></div><div class="announce-text">Announcements from the owner show up here.</div>') },
  { id: 'update-notice', label: 'Update notice', sel: '.update-notice', ghost: () => mkGhost('update-notice', '<div><b>New update available</b>The game was updated. Refresh to keep playing.</div><button class="big">Refresh now</button><button class="update-x">Later</button>') },
  { id: 'spec-bar', label: 'Spectator bar', sel: '.spec-bar', active: () => !compact() },
  { id: 'spec-top', label: 'Spectator buttons', sel: '.spec-bar .sb-top', active: compact },
  { id: 'spec-nav', label: 'Follow arrows', sel: '.spec-bar .sb-nav', active: compact },
  { id: 'spec-replay', label: 'Replay controls', sel: '.spec-bar .sb-replay', active: compact },
  { id: 'scoreboard', label: 'Scoreboard', sel: '.scoreboard' },
  { id: 'builds', label: 'Builds panel', sel: '.builds' },
  { id: 'follow-box', label: 'Follow chip', sel: '.follow-box' },
  { id: 'takeover-chip', label: 'Play-as chip', sel: '.takeover-chip' },
  { id: 'fr-toasts', label: 'Notices', sel: '.fr-toasts' },
  { id: 'fr-invites', label: 'Invites', sel: '.fr-invites' },
];
const TARGETS: [string, string][] = TARGET_DEFS.map((t) => [t.id, t.label]);
const DEF_OF = new Map(TARGET_DEFS.map((t) => [t.id, t]));
const isActive = (id: string): boolean => DEF_OF.get(id)?.active?.() ?? true;
const ACTIVE_IDS = (): string[] => TARGET_DEFS.filter((t) => isActive(t.id)).map((t) => t.id);
const elsOf = (id: string): HTMLElement[] => {
  const d = DEF_OF.get(id);
  return Array.from(document.querySelectorAll<HTMLElement>(d?.sel ?? `#${id}`));
};
/** The one to measure: the stand-in while editing, else the first one that is laid out, else any. */
const mainEl = (id: string): HTMLElement | null => {
  const all = elsOf(id);
  return all.find((e) => e.classList.contains('hud-ghost')) ?? all.find((e) => e.getBoundingClientRect().width > 0) ?? all[0] ?? null;
};
/** The owner's default is also kept here so the first paint already has it (not an `arena.` key: it must not sync with the account). */
const DEFAULT_CACHE = 'arenaHudDefault';
const KEY = 'arena.hud.v1';
const STYLE_KEY = 'arena.hud.style.v1';

/** A style = a skin (CSS look, via body[data-hud-style]) plus where each element sits, as [x, y, scale] with x/y the element's centre as a fraction of the screen. */
interface Preset {
  id: string;
  name: string;
  desc: string;
  place: Record<string, [number, number, number]>;
}
const PRESETS: Preset[] = [
  { id: 'classic', name: 'Classic', desc: 'Gold-trimmed fantasy frames in the default spots.', place: {} },
  {
    id: 'arena',
    name: 'Arena',
    desc: 'WoW-arena style: you and your target flank the action bar, enemies on the right.',
    place: { 'self-frame': [0.27, 0.86, 1], 'target-frame': [0.73, 0.86, 1], party: [0.09, 0.42, 1], enemies: [0.91, 0.36, 1], actionbar: [0.5, 0.93, 1], cast: [0.5, 0.74, 1], autoind: [0.5, 0.68, 1], log: [0.15, 0.9, 0.9] },
  },
  {
    id: 'minimal',
    name: 'Minimal',
    desc: 'Flat, thin and quiet. Frames tucked top-left, everything small.',
    place: { 'self-frame': [0.13, 0.06, 0.9], 'target-frame': [0.13, 0.15, 0.9], party: [0.1, 0.27, 0.85], enemies: [0.9, 0.12, 0.85], actionbar: [0.5, 0.94, 0.9], cast: [0.5, 0.78, 0.9], autoind: [0.5, 0.72, 0.9], log: [0.15, 0.9, 0.85] },
  },
  {
    id: 'glass',
    name: 'Glass',
    desc: 'Frosted cyan glass. Frames along the top, enemies under your target.',
    place: { 'self-frame': [0.3, 0.07, 1], 'target-frame': [0.7, 0.07, 1], party: [0.1, 0.2, 0.95], enemies: [0.9, 0.21, 0.95], actionbar: [0.5, 0.93, 1], cast: [0.5, 0.78, 1], autoind: [0.5, 0.72, 1], log: [0.15, 0.9, 0.9] },
  },
  {
    id: 'compact',
    name: 'Compact',
    desc: 'Small and out of the way. Maximum screen for the fight.',
    place: { 'self-frame': [0.13, 0.06, 0.8], 'target-frame': [0.27, 0.06, 0.8], party: [0.09, 0.17, 0.75], enemies: [0.92, 0.1, 0.75], actionbar: [0.5, 0.95, 0.8], cast: [0.5, 0.8, 0.8], autoind: [0.5, 0.74, 0.8], log: [0.14, 0.92, 0.75] },
  },
];
const MARGIN = 6;
const GRID_KEY = 'arena.hud.grid.v1';
const GRID_SIZES = [8, 16, 24, 32, 48];


/** The saved layout from what localStorage (or the account) holds: only known elements, scale / size / position clamped, anything malformed dropped. */
export function parseLayout(rawIn: unknown, ids: string[], width: number, height: number): Record<string, Saved> {
  return parseHudLayout(rawIn, ids, width, height);
}

/** The ids of the movable elements, in the editor's order. */
export const HUD_ELEMENTS = TARGETS.map(([id]) => id);

export { sameLayout };

export class HudLayout {
  /** Open / close state (see hudEditState.ts); `editing` is read all over main.ts. */
  private st: HudEditState = EDIT_IDLE;
  get editing(): boolean {
    return this.st.editing;
  }
  /** The editor opened or closed; on closing, `restoreMenu` says it was opened over the main menu and that menu should come back. */
  onChange: (editing: boolean, restoreMenu?: boolean) => void = () => {};
  /** Set by main.ts: whether the signed-in account is the owner (the owner's part of the editor), and how a layout is sent to the server (null removes the default). */
  isOwner: () => boolean = () => false;
  publish: (layout: HudLayoutMap | null) => void = () => {};
  private data: Record<string, Slot> = {};
  private bar: HTMLElement;
  private drag: { id: string; px: number; py: number; dx: number; dy: number } | null = null;
  /** Dragging an element's corner grip: its size when the drag began. */
  private sizing: { id: string; px: number; py: number; w: number; h: number; w0: number } | null = null;
  private grips = new Map<string, HTMLElement>();
  private style = 'classic';
  private styleSel!: HTMLSelectElement;
  private styleDesc!: HTMLElement;
  /** Grid overlay and snapping, saved with the editor. */
  private grid = { show: true, snap: true, size: 16 };
  private gridEl!: HTMLElement;
  private selected: string | null = null;

  /** Layers, from the bottom: the built-in spots (no entry), the owner's default for everyone, then what this player moved themselves. */
  private saved: Record<string, Saved> = {};
  private def: HudLayoutMap = {};
  private defMeta: { at: number; by: string } | null = null;
  /** The owner's "everyone" mode edits this copy of the default; it only reaches the server when published. */
  private mode: EditMode = 'me';
  private draft: HudLayoutMap = {};
  private publishing = false;
  /** Elements moved in the layer being edited (they are kept when saving even if they are not in it yet). */
  private touched = new Set<string>();
  private ghosts = new Map<string, HTMLElement>();
  private selBox!: HTMLElement;
  private savedEl!: HTMLElement;
  private savedTimer: ReturnType<typeof setTimeout> | null = null;
  /** The popup of the selected element (its place, its reset and its own options) and the list of every element. */
  private pop!: HTMLElement;
  private itemList!: HTMLElement;
  private ownerBox!: HTMLElement;
  private noteEl!: HTMLElement;
  private resetAllBtn!: HTMLButtonElement;

  constructor() {
    loadSkin();
    if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(() => this.applySkins());
    try {
      this.saved = parseLayout(JSON.parse(localStorage.getItem(KEY) ?? '{}'), HUD_ELEMENTS, window.innerWidth, window.innerHeight);
    } catch {
      /* ignore */
    }
    try {
      const c = JSON.parse(localStorage.getItem(DEFAULT_CACHE) ?? 'null') as { layout?: unknown; at?: unknown; by?: unknown } | null;
      const l = c ? parseHudLayout(c.layout, HUD_IDS, 0, 0) : {};
      if (Object.keys(l).length) {
        this.def = l;
        this.defMeta = { at: typeof c?.at === 'number' ? c.at : 0, by: typeof c?.by === 'string' ? c.by : '' };
      }
    } catch {
      /* ignore */
    }
    try {
      const st = localStorage.getItem(STYLE_KEY);
      if (st && PRESETS.some((p) => p.id === st)) this.style = st;
    } catch {
      /* ignore */
    }
    document.body.dataset.hudStyle = this.style;

    try {
      const g = JSON.parse(localStorage.getItem(GRID_KEY) ?? '{}') as Partial<typeof this.grid>;
      if (typeof g.show === 'boolean') this.grid.show = g.show;
      if (typeof g.snap === 'boolean') this.grid.snap = g.snap;
      if (typeof g.size === 'number' && GRID_SIZES.includes(g.size)) this.grid.size = g.size;
    } catch {
      /* defaults */
    }
    loadLook();

    this.gridEl = document.createElement('div');
    this.gridEl.id = 'hud-grid';
    this.gridEl.className = 'hidden';
    document.body.append(this.gridEl);

    this.bar = document.createElement('div');
    this.bar.id = 'hud-edit-bar';
    this.bar.className = 'hidden';
    this.bar.append(this.buildPanel());
    document.body.append(this.bar);
    this.paintGrid();

    // elements are found by their id or selector, even when they are made later (an announcement, a notice): one listener for all of them
    const hit = (ev: Event): string | null => {
      const t = ev.target as HTMLElement | null;
      if (!this.editing || !t?.closest || t.closest('.hud-grip')) return null;
      return t.closest<HTMLElement>('[data-hud-id]')?.dataset.hudId ?? null;
    };
    document.addEventListener('pointerdown', (ev) => {
      const id = hit(ev);
      if (id) this.down(ev, id);
    }, true);
    document.addEventListener('wheel', (ev) => {
      const id = hit(ev);
      if (id) this.wheel(ev, id);
    }, { passive: false, capture: true });
    // a button (sound, dev tools) dragged in the editor must not also be clicked
    document.addEventListener('click', (ev) => {
      if (!hit(ev)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);
    window.addEventListener('pointermove', (ev) => this.move(ev));
    window.addEventListener('pointerup', () => {
      this.drag = null;
      this.sizing = null;
    });
    window.addEventListener('resize', () => {
      if (!this.editing) this.fromSaved();
      this.fitAll();
    });
    this.fromSaved();
    new MutationObserver(() => this.adopt()).observe(document.body, { childList: true });
    requestAnimationFrame(() => this.fitAll());
  }

  /** Mark and place every movable element that exists now (the ones made later arrive through the observer). */
  /** Put every element's own look (hudSkin.ts) on it. */
  applySkins() {
    for (const t of TARGET_DEFS) for (const e of elsOf(t.id)) applySkinTo(e, t.id);
  }

  private adopt() {
    this.applySkins();
    for (const t of TARGET_DEFS) {
      for (const e of elsOf(t.id)) {
        if (e.dataset.hudId === t.id) continue;
        e.dataset.hudId = t.id;
        e.dataset.hud = t.label;
        this.applyOne(e, t.id);
      }
    }
  }

  /** The text shown on an element's tag while editing: its name, and a diamond while it follows the owner's default. */
  private paintLabels() {
    for (const t of TARGET_DEFS) {
      const text = tagText(t.label, this.mode, this.source(t.id));
      for (const e of elsOf(t.id)) e.dataset.hud = text;
    }
  }

  start(fromMenu = false) {
    this.st = openEditor(this.st, fromMenu);
    this.mode = 'me';
    this.draft = {};
    this.touched.clear();
    document.body.classList.add('hud-edit');
    document.body.classList.remove('hud-edit-all');
    // elements that only exist for a moment get a stand-in to move
    for (const t of TARGET_DEFS) {
      if (!t.ghost || this.ghosts.has(t.id)) continue;
      const g = t.ghost();
      document.body.append(g);
      this.ghosts.set(t.id, g);
    }
    this.adopt();
    this.fromSaved();
    for (const id of ACTIVE_IDS()) this.addGrip(id);
    this.bar.classList.remove('hidden');
    this.selected = null;
    this.paintAll();
    window.addEventListener('keydown', this.keyHandler);
    window.addEventListener('keydown', this.escHandler, true);
    this.onChange(true);
  }

  /** Leave the editor and put everything back; safe to call twice. `matchStarted`: a match is starting, so the main menu must not come back. */
  stop(matchStarted = false) {
    const was = this.st.editing;
    const closed = closeEditor(this.st, matchStarted);
    this.st = closed.state;
    this.drag = null;
    this.sizing = null;
    this.selected = null;
    for (const c of EDIT_BODY_CLASSES) document.body.classList.remove(c);
    document.body.classList.remove('hud-edit-all');
    for (const t of TARGET_DEFS) for (const e of elsOf(t.id)) e.classList.remove('hud-selected');
    for (const g of this.grips.values()) g.remove();
    this.grips.clear();
    for (const g of this.ghosts.values()) g.remove();
    this.ghosts.clear();
    this.bar.classList.add('hidden');
    this.gridEl.classList.add('hidden');
    window.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('keydown', this.escHandler, true);
    const a = document.activeElement;
    if (a instanceof HTMLElement && this.bar.contains(a)) a.blur(); // a drop-down left focused would otherwise keep swallowing keys
    if (!was) return;
    try {
      // the owner's unpublished changes to the default are dropped; the player's own layout is saved
      if (this.mode === 'all') {
        this.mode = 'me';
        this.draft = {};
        this.touched.clear();
        this.fromSaved();
      } else this.save();
      this.paintLabels();
    } finally {
      this.onChange(false, closed.restoreMenu);
    }
  }

  /**
   * Escape leaves the editor wherever the keyboard focus is. The game's own key handler ignores keys typed into a
   * drop-down (the editor is full of them), so without this a press after choosing a preset did nothing. Capture phase:
   * it runs before the game's handler, which must not also open the menu on the same press.
   */
  private escHandler = (ev: KeyboardEvent) => {
    if (nameplateEditorOpen() || !leavesEditor(this.st, ev.code, ev.repeat)) return; // the nameplate editor over this one takes Escape first
    ev.preventDefault();
    ev.stopImmediatePropagation();
    this.stop();
  };

  /** The owner's default layout changed (or arrived when connecting): everything the player has not moved follows it. Null: there is none. */
  setDefault(layout: HudLayoutMap | null, at = 0, by = '') {
    const parsed = layout ? parseHudLayout(layout, HUD_IDS, 0, 0) : {};
    const has = Object.keys(parsed).length > 0;
    const pristine = this.mode === 'all' && sameLayout(this.draft, this.def);
    if (this.editing) this.save(); // keep what is being moved
    this.def = has ? parsed : {};
    this.defMeta = has ? { at, by } : null;
    try {
      if (has) localStorage.setItem(DEFAULT_CACHE, JSON.stringify({ layout: parsed, at, by }));
      else localStorage.removeItem(DEFAULT_CACHE);
    } catch {
      /* ignore */
    }
    if (this.mode === 'all' && (this.publishing || pristine)) {
      this.draft = { ...this.def };
      this.touched.clear();
    }
    this.publishing = false;
    this.fromSaved();
    this.paintAll();
    this.refit();
  }

  /** The default as the client holds it (for the status line and for tests). */
  defaultInfo(): { layout: HudLayoutMap; at: number; by: string } | null {
    return this.defMeta ? { layout: this.def, at: this.defMeta.at, by: this.defMeta.by } : null;
  }

  /** Is this element's place its own (moved by the player in the layer being edited)? */
  private source(id: string) {
    return sourceOf(this.mode, id, { saved: this.saved, def: this.def, draft: this.draft, touched: this.touched });
  }
  private own(id: string): boolean {
    return this.source(id) === 'own';
  }

  /** Switch skin and move every element to the preset's spots. Works while editing (elements are measured as laid out). */
  setStyle(id: string) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    this.style = id;
    document.body.dataset.hudStyle = id;
    this.styleSel.value = id;
    this.styleDesc.textContent = p.desc;
    try {
      localStorage.setItem(STYLE_KEY, id);
    } catch {
      /* ignore */
    }
    this.clearLayer();
    this.fromSaved();
    if (!Object.keys(p.place).length) {
      this.persist();
      this.paintAll();
      return;
    }
    // scale first, then measure the natural position and offset the centre onto the target spot
    const W = window.innerWidth;
    const H = window.innerHeight;
    requestAnimationFrame(() => {
      for (const [tid, [fx, fy, sc]] of Object.entries(p.place)) {
        const e = mainEl(tid);
        if (!e || !isActive(tid)) continue;
        const slot: Slot = { dx: 0, dy: 0, s: sc };
        this.data[tid] = slot;
        this.apply(tid);
        const r = e.getBoundingClientRect();
        if (r.width === 0) continue;
        slot.dx = fx * W - (r.left + r.width / 2);
        slot.dy = fy * H - (r.top + r.height / 2);
        this.touched.add(tid);
        this.apply(tid);
        this.fit(tid);
      }
      this.save();
      this.paintAll();
    });
  }

  /** Everything back to the default: the owner's if there is one (the built-in spots otherwise). In "everyone" mode: the draft back to the built-in spots. */
  reset() {
    this.setStyle('classic');
  }

  /** Put one element back to the default (the owner's, or the built-in spot). */
  resetOne(id: string) {
    delete (this.mode === 'all' ? this.draft : this.saved)[id];
    this.touched.delete(id);
    this.persist();
    this.fromSaved();
    if (isActive(id)) this.fit(id);
    this.paintAll();
  }

  /** Forget every move in the layer being edited. */
  private clearLayer() {
    if (this.mode === 'all') this.draft = {};
    else this.saved = {};
    this.touched.clear();
  }

  // ------------------------------------------------------------------ editor panel

  private buildPanel(): HTMLElement {
    const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    const panel = mk('div', 'he-panel');
    const head = mk('div', 'he-head');
    head.append(mk('b', '', 'Edit HUD'));
    this.savedEl = mk('span', 'he-saved');
    head.append(this.savedEl);
    const done = mk('button', 'primary', 'Done (Esc)');
    done.title = 'Save and leave the editor (Esc)';
    done.addEventListener('click', () => this.stop());
    this.resetAllBtn = mk('button', '', 'Reset all');
    this.resetAllBtn.addEventListener('click', () => this.reset());
    head.append(this.resetAllBtn, done);
    const hint = mk('div', 'he-sub', 'Drag anything on screen to move it, or pick it from the list for its options. Drag a corner to resize (double-click for the natural size), scroll to scale, arrow keys nudge.');

    // every element of the HUD, one button each: it opens that element's own popup
    this.itemList = mk('div', 'he-list');

    // presets
    const row1 = mk('div', 'he-row');
    this.styleSel = document.createElement('select');
    for (const p of PRESETS) this.styleSel.append(new Option(p.name, p.id));
    this.styleSel.value = this.style;
    this.styleDesc = mk('small');
    this.styleDesc.textContent = PRESETS.find((p) => p.id === this.style)?.desc ?? '';
    this.styleSel.addEventListener('change', () => this.setStyle(this.styleSel.value));
    const presetLabel = mk('label', '', 'Layout preset ');
    presetLabel.append(this.styleSel);
    row1.append(presetLabel, this.styleDesc);

    // grid and snapping
    const row2 = mk('div', 'he-row');
    const toggle = (text: string, get: () => boolean, set: (v: boolean) => void) => {
      const l = mk('label', 'he-tgl');
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = get();
      c.addEventListener('change', () => {
        set(c.checked);
        this.saveGrid();
        this.paintGrid();
      });
      l.append(c, document.createTextNode(` ${text}`));
      return l;
    };
    const sizeSel = document.createElement('select');
    for (const n of GRID_SIZES) sizeSel.append(new Option(`${n} px`, String(n)));
    sizeSel.value = String(this.grid.size);
    sizeSel.addEventListener('change', () => {
      this.grid.size = Number(sizeSel.value);
      this.saveGrid();
      this.paintGrid();
    });
    const sizeLabel = mk('label', '', 'Grid size ');
    sizeLabel.append(sizeSel);
    row2.append(toggle('Show grid', () => this.grid.show, (v) => (this.grid.show = v)), toggle('Snap to grid and centre', () => this.grid.snap, (v) => (this.grid.snap = v)), sizeLabel, mk('small', '', 'Hold Alt while dragging to ignore snapping.'));

    // the selected element: where its place comes from, and a way back to the default (shown in its own popup beside the panel)
    this.selBox = mk('div', 'he-sel');
    this.pop = mk('div', 'he-pop hidden');
    this.pop.append(this.selBox);
    this.noteEl = mk('div', 'he-moved');
    this.ownerBox = mk('div', 'he-owner hidden');

    // the look options (bars, nameplates, target marks, text styles) live in the Look window now
    const moved = mk('div', 'he-moved', 'Health bar, nameplate, target mark and text looks are in Look (main menu).');

    // nameplates have their own editor (profiles for you, allies and enemies; see nameplateEditor.ts)
    const plateRow = mk('div', 'he-row');
    const plateBtn = mk('button', '', 'Edit nameplates…');
    plateBtn.title = 'Size, place and style the nameplates: separate looks for you, allies and enemies';
    plateBtn.addEventListener('click', () => openNameplateEditor());
    plateRow.append(plateBtn);
    const more = document.createElement('details');
    more.className = 'he-more';
    more.append(mk('summary', '', 'Layout preset, grid, nameplates'), row1, row2, plateRow, moved);
    panel.append(head, hint, this.itemList, this.noteEl, this.ownerBox, more);
    this.bar.append(this.pop);
    return panel;
  }

  /** Refresh everything the panel shows about layers: the selected element, the owner's section, the tags. */
  private paintAll() {
    this.paintList();
    this.paintSelection();
    this.paintOwner();
    this.paintLabels();
  }

  /** Pick an element from the list: it is selected on screen and its popup opens. */
  private select(id: string | null) {
    this.selected = id;
    if (id) this.touched.add(id);
    this.paintSelection();
    this.paintLabels();
  }

  /** The list of every element of the HUD (the ones in use now), the selected one lit, the ones moved from the default marked. */
  private paintList() {
    this.itemList.replaceChildren();
    for (const id of ACTIVE_IDS()) {
      const b = document.createElement('button');
      b.className = `he-item${id === this.selected ? ' on' : ''}`;
      b.textContent = DEF_OF.get(id)?.label ?? id;
      if (this.own(id)) b.append(Object.assign(document.createElement('i'), { textContent: ' ●', title: 'Moved from the default' }));
      b.addEventListener('click', () => this.select(id === this.selected ? null : id));
      this.itemList.append(b);
    }
  }

  private paintSelInfo() {
    const mk = (tag: string, text: string) => {
      const e = document.createElement(tag);
      e.textContent = text;
      return e;
    };
    const id = this.selected;
    const all = this.mode === 'all';
    this.resetAllBtn.textContent = all ? 'Reset draft' : 'Reset all to default';
    this.resetAllBtn.title = all ? 'Put every element of the default layout back to its built-in spot (not published until you press the save button)' : this.defMeta ? 'Put every element back to the default layout the owner set' : 'Put every element back to its built-in spot';
    this.selBox.replaceChildren();
    this.paintList();
    this.pop.classList.toggle('hidden', !id);
    if (!id) return;
    const label = DEF_OF.get(id)?.label ?? id;
    const own = this.own(id);
    const where = whereText(this.mode, this.source(id));
    const reset = mk('button', all ? 'Reset to built-in' : 'Reset to default') as HTMLButtonElement;
    reset.disabled = !own;
    reset.title = all ? 'Put this element back to its built-in spot in the default layout' : 'Put this element back to the default (it follows the owner\'s layout again)';
    reset.addEventListener('click', () => this.resetOne(id));
    const top = document.createElement('div');
    top.className = 'he-pop-head';
    const close = mk('button', '✕') as HTMLButtonElement;
    close.title = 'Close this popup';
    close.addEventListener('click', () => this.select(null));
    top.append(mk('b', label), close);
    this.selBox.append(top, mk('small', where), reset);
    if (id === 'dpsmeter') this.selBox.append(this.dpsSettings());
    this.selBox.append(this.skinSettings(id));
  }

  /** The element's look: background, border, corners, opacity, text colour, shadow, and the options only it has (layout, button style...). */
  private skinSettings(id: string): HTMLElement {
    const box = document.createElement('div');
    box.className = 'he-opts';
    const head = document.createElement('div');
    head.className = 'he-pop-head';
    const title = document.createElement('b');
    title.textContent = 'Style';
    const clear = document.createElement('button');
    clear.textContent = 'Reset style';
    clear.disabled = !skinChanged(id);
    clear.addEventListener('click', () => {
      resetSkin(id);
      this.applySkins();
      this.flashSaved('Style put back');
      this.paintSelInfo();
    });
    head.append(title, clear);
    box.append(head);
    for (const o of optionsFor(id)) {
      const label = document.createElement('label');
      label.textContent = `${o.label} `;
      const sel = document.createElement('select');
      for (const [v, text] of o.choices) sel.append(new Option(text, v));
      sel.value = skinValue(id, o.id);
      sel.addEventListener('change', () => {
        setSkin(id, o.id, sel.value);
        this.applySkins();
        this.flashSaved('Saved: this style stays on this device');
        clear.disabled = !skinChanged(id);
        requestAnimationFrame(() => this.fitAll());
      });
      label.append(sel);
      box.append(label);
    }
    return box;
  }

  /** What the DPS meter shows: the same settings as Look > HUD > DPS meter, here where the meter is being placed. */
  private dpsSettings(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'he-opts';
    box.append(Object.assign(document.createElement('small'), { textContent: 'Each list shows one thing. Add a second or third list to see damage, healing and more at the same time.' }));
    for (const o of LOOK_OPTIONS.filter((x) => x.group === 'DPS meter' && x.id !== 'dpsmeter')) {
      const label = document.createElement('label');
      label.textContent = `${o.label} `;
      const sel = document.createElement('select');
      for (const [v, text] of o.choices) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = text;
        sel.append(opt);
      }
      sel.value = look[o.id];
      sel.addEventListener('change', () => {
        setLook(o.id, sel.value);
        this.flashSaved('Saved');
      });
      label.append(sel);
      box.append(label);
    }
    return box;
  }

  /** The owner's part of the editor: who the changes are for, and saving / removing the default for everyone. Only the owner sees it. */
  private paintOwner() {
    const owner = this.isOwner();
    this.noteEl.textContent = !owner && this.defMeta ? 'The owner set a default layout. Elements you have not moved yourself follow it (marked ◆); Reset to default puts one back.' : '';
    this.ownerBox.classList.toggle('hidden', !owner);
    this.ownerBox.replaceChildren();
    if (!owner) return;
    const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    const title = mk('div', 'he-owner-h', 'Owner: default layout for everyone');
    const modes = mk('div', 'he-row');
    modes.append(mk('span', '', 'Editing:'));
    for (const [m, text, tip] of [['me', 'Just me', 'Changes are your own layout'], ['all', 'Everyone', 'Changes edit the default layout (you see it live); it only reaches players when you save it below']] as const) {
      const b = mk('button', `he-mode${this.mode === m ? ' on' : ''}`, text);
      b.title = tip;
      b.addEventListener('click', () => this.setMode(m));
      modes.append(b);
    }
    const dirty = this.mode === 'all' && !sameLayout(this.draft, this.def);
    const save = mk('button', 'primary', 'Save this layout as the default for everyone');
    save.title = this.mode === 'all' ? 'Publish the default layout you are editing' : 'Publish what you see now (your layout over the current default) as the default for everyone';
    save.addEventListener('click', () => this.publishCurrent());
    const remove = mk('button', '', 'Remove the default');
    remove.disabled = !this.defMeta;
    remove.title = 'Everyone goes back to the built-in layout, apart from what they moved themselves';
    remove.addEventListener('click', () => {
      this.publishing = true;
      this.publish(null);
    });
    const acts = mk('div', 'he-row');
    acts.append(save, remove);
    const when = this.defMeta?.at ? new Date(this.defMeta.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
    const n = Object.keys(this.def).length;
    const status = mk('small', 'he-owner-st', this.defMeta ? `Default saved${when ? ` ${when}` : ''}${this.defMeta.by ? ` by ${this.defMeta.by}` : ''}: ${n} element${n === 1 ? '' : 's'}.${dirty ? ' You have unsaved changes to it.' : ''}` : `No default saved: everyone gets the built-in layout.${dirty ? ' You have unsaved changes.' : ''}`);
    const hint = mk('small', '', 'Players keep anything they moved themselves; everything else follows the default, also when you change it later. Nobody is told.');
    this.ownerBox.append(title, modes, acts, status, hint);
  }

  /** Owner: who the edits are for. "Everyone" works on a copy of the default that you see live and publish when it is right. */
  setMode(m: EditMode) {
    if (m === this.mode || !this.editing) return;
    if (m === 'all' && !this.isOwner()) return;
    this.save();
    this.touched.clear();
    this.mode = m;
    if (m === 'all') this.draft = { ...this.def };
    document.body.classList.toggle('hud-edit-all', m === 'all');
    this.fromSaved();
    this.fitAll();
    this.paintAll();
  }

  /** Owner: send the layout on screen (the draft, or in "just me" mode your layout over the default) to the server as the default. */
  private publishCurrent() {
    if (!this.isOwner()) return;
    this.save();
    const layer = this.mode === 'all' ? this.draft : layerLayout(this.saved, this.def);
    this.publishing = true;
    this.publish(Object.keys(layer).length ? layer : null);
  }

  private saveGrid() {
    try {
      localStorage.setItem(GRID_KEY, JSON.stringify(this.grid));
    } catch {
      /* ignore */
    }
  }

  private paintGrid() {
    this.gridEl.style.setProperty('--g', `${this.grid.size}px`);
    this.gridEl.classList.toggle('hidden', !(this.editing && this.grid.show));
  }

  private paintSelection() {
    for (const t of TARGET_DEFS) for (const e of elsOf(t.id)) e.classList.toggle('hud-selected', t.id === this.selected);
    this.paintSelInfo();
  }

  /** Pull the element to the nearest grid line (its left or right edge) and to the screen centre when close. */
  private snap(id: string) {
    const e = mainEl(id);
    const s = this.data[id];
    if (!e || !s) return;
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const g = this.grid.size;
    const pick = (cands: number[]) => cands.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a), Infinity);
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const xs = [Math.round(r.left / g) * g - r.left, Math.round(r.right / g) * g - r.right];
    const ys = [Math.round(r.top / g) * g - r.top, Math.round(r.bottom / g) * g - r.bottom];
    const mx = window.innerWidth / 2 - cx;
    const my = window.innerHeight / 2 - cy;
    if (Math.abs(mx) <= 10) xs.push(mx);
    if (Math.abs(my) <= 10) ys.push(my);
    s.dx += pick(xs);
    s.dy += pick(ys);
    this.apply(id);
  }

  /** Arrow keys nudge the selected element by a pixel (a grid cell with Shift). */
  private keyHandler = (ev: KeyboardEvent) => {
    if (!this.editing || !this.selected) return;
    const t = (ev.target as HTMLElement | null)?.tagName;
    if (t === 'SELECT' || t === 'INPUT') return;
    const step = ev.shiftKey ? this.grid.size : 1;
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const v = d[ev.code];
    if (!v) return;
    ev.preventDefault();
    ev.stopPropagation();
    const s = this.slot(this.selected);
    this.touched.add(this.selected);
    s.dx += v[0];
    s.dy += v[1];
    this.apply(this.selected);
    this.fit(this.selected);
    this.paintAll();
  };

  private slot(id: string): Slot {
    return (this.data[id] ??= { dx: 0, dy: 0, s: 1 });
  }

  private apply(id: string) {
    for (const e of elsOf(id)) this.applyOne(e, id);
  }

  private applyOne(e: HTMLElement, id: string) {
    const s = isActive(id) ? this.data[id] : undefined;
    e.style.translate = s ? `${s.dx}px ${s.dy}px` : '';
    e.style.scale = s && s.s !== 1 ? String(s.s) : '';
    e.style.width = s?.w ? `${s.w}px` : '';
    e.style.height = s?.h ? `${s.h}px` : '';
    e.classList.toggle('hud-sized', !!(s?.w || s?.h));
    const base = TEXT_BOX[id];
    if (base) {
      const px = s?.t && s.t !== 1 ? `${Math.round(base * s.t * 10) / 10}px` : '';
      if (id === 'netstats') e.style.setProperty('--net-size', px || '11px');
      else e.style.fontSize = px;
    }
  }

  /** The corner grip shown on an element while editing: drag it to change the element's width and height. */
  private addGrip(id: string) {
    const e = mainEl(id);
    if (!e || this.grips.has(id)) return;
    const g = document.createElement('div');
    g.className = 'hud-grip';
    g.title = 'Drag to change the width and height · double-click for the natural size';
    g.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const s = this.slot(id);
      const r = e.getBoundingClientRect();
      this.selected = id;
      this.touched.add(id);
      this.paintSelection();
      this.sizing = { id, px: ev.clientX, py: ev.clientY, w: r.width / s.s, h: r.height / s.s, w0: s.w ? s.w / (s.t || 1) : r.width / s.s };
    });
    g.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      const s = this.slot(id);
      delete s.w;
      delete s.h;
      delete s.t;
      this.touched.add(id);
      this.apply(id);
      this.fit(id);
      this.save();
      this.paintAll();
    });
    e.append(g);
    this.grips.set(id, g);
    // elements that redraw their insides (the action bar, party and enemy frames) get the grip back
    const mo = new MutationObserver(() => {
      if (!this.grips.has(id)) return mo.disconnect();
      if (g.parentElement !== e) e.append(g);
    });
    mo.observe(e, { childList: true });
  }

  /** Keep an element fully on screen by nudging its offset. Skips elements that are not currently laid out. */
  private fit(id: string) {
    const e = mainEl(id);
    const s = this.data[id];
    if (!e || !s || !isActive(id)) return;
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    let nx = 0;
    let ny = 0;
    if (r.left < MARGIN) nx = MARGIN - r.left;
    else if (r.right > window.innerWidth - MARGIN) nx = window.innerWidth - MARGIN - r.right;
    if (r.top < MARGIN) ny = MARGIN - r.top;
    else if (r.bottom > window.innerHeight - MARGIN) ny = window.innerHeight - MARGIN - r.bottom;
    if (nx || ny) {
      s.dx += nx;
      s.dy += ny;
      this.apply(id);
    }
  }

  private fitAll() {
    for (const id of ACTIVE_IDS()) this.fit(id);
  }

  /** The layout in force for what is being edited: the owner's draft in "everyone" mode, else the player's over the default. */
  private view(): HudLayoutMap {
    return viewLayout(this.mode, { saved: this.saved, def: this.def, draft: this.draft });
  }

  /** Pixel offsets for this window size from the layers' fractions. */
  private fromSaved() {
    this.data = {};
    for (const [id, f] of Object.entries(this.view())) this.data[id] = { dx: f.fx * window.innerWidth, dy: f.fy * window.innerHeight, s: f.s, ...(f.w ? { w: f.w } : {}), ...(f.h ? { h: f.h } : {}), ...(f.t ? { t: f.t } : {}) };
    for (const [id] of TARGETS) this.apply(id);
  }

  /**
   * Call when the HUD has just been shown: elements hidden until now could not be measured, so anything a layout from
   * another screen put off the edge is pulled back on (it is never left unreachable, even outside the editor).
   */
  refit() {
    requestAnimationFrame(() => this.fitAll());
  }

  private down(ev: PointerEvent, id: string) {
    if (!this.editing) return;
    ev.preventDefault();
    ev.stopPropagation();
    const s = this.slot(id);
    this.selected = id;
    this.touched.add(id);
    this.paintSelection();
    this.paintLabels();
    this.drag = { id, px: ev.clientX, py: ev.clientY, dx: s.dx, dy: s.dy };
  }

  private move(ev: PointerEvent) {
    const z = this.sizing;
    if (z) {
      const s = this.slot(z.id);
      const g = this.grid.snap && !ev.altKey ? this.grid.size / 2 : 1;
      s.w = Math.round(clamp(z.w + (ev.clientX - z.px) / s.s, 40, window.innerWidth) / g) * g;
      s.h = Math.round(clamp(z.h + (ev.clientY - z.py) / s.s, 16, window.innerHeight) / g) * g;
      if (z.id in TEXT_BOX) s.t = Math.round(clamp(s.w / z.w0, TEXT_MIN, TEXT_MAX) * 100) / 100; // the text grows with the box
      this.apply(z.id);
      return;
    }
    const d = this.drag;
    if (!d) return;
    const s = this.slot(d.id);
    s.dx = d.dx + (ev.clientX - d.px);
    s.dy = d.dy + (ev.clientY - d.py);
    this.apply(d.id);
    if (this.grid.snap && !ev.altKey) this.snap(d.id); // hold Alt to drag freely
    this.fit(d.id);
  }

  private wheel(ev: WheelEvent, id: string) {
    if (!this.editing) return;
    ev.preventDefault();
    const s = this.slot(id);
    this.touched.add(id);
    if (id in TEXT_BOX) {
      s.t = clamp(Math.round(((s.t ?? 1) - Math.sign(ev.deltaY) * 0.1) * 100) / 100, TEXT_MIN, TEXT_MAX); // text boxes: the wheel sizes the text
      this.apply(id);
      this.fit(id);
      this.save();
      this.paintAll();
      return;
    }
    s.s = clamp(Math.round((s.s - Math.sign(ev.deltaY) * 0.05) * 100) / 100, 0.6, 1.6);
    this.apply(id);
    this.fit(id);
  }

  /** The working offsets as saved fractions, for the elements the layer being edited owns (or that were just moved). */
  private pack(layer: HudLayoutMap): HudLayoutMap {
    const out: HudLayoutMap = {};
    for (const [id, d] of Object.entries(this.data)) {
      if (!(id in layer) && !this.touched.has(id)) continue;
      out[id] = { fx: Math.round((d.dx / window.innerWidth) * 10000) / 10000, fy: Math.round((d.dy / window.innerHeight) * 10000) / 10000, s: d.s, ...(d.w ? { w: Math.round(d.w) } : {}), ...(d.h ? { h: Math.round(d.h) } : {}), ...(d.t ? { t: d.t } : {}) };
    }
    return out;
  }

  /** Keep what was moved. "Just me": the player's own layer, in this browser (and the account). "Everyone": the owner's draft, which only the save button publishes. */
  private save() {
    if (this.mode === 'all') {
      this.draft = this.pack(this.draft);
      this.flashSaved('Draft updated: nothing is published until you press Save for everyone');
    } else {
      this.saved = this.pack(this.saved);
      this.persist();
      this.flashSaved('Saved');
    }
  }

  /** Say that a change went in: a green tick and a few words in the panel's header for a couple of seconds. */
  flashSaved(text = 'Saved') {
    if (!this.savedEl) return;
    this.savedEl.textContent = `✓ ${text}`;
    this.savedEl.classList.add('on');
    if (this.savedTimer) clearTimeout(this.savedTimer);
    this.savedTimer = setTimeout(() => this.savedEl.classList.remove('on'), 2600);
  }

  private persist() {
    if (this.mode === 'all') return;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.saved));
    } catch {
      /* ignore */
    }
  }
}
