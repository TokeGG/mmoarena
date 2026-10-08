import { clamp } from '@arena/shared';
import { LOOK_OPTIONS, loadLook, look, resetLook, setLook } from './hudLook';

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
}
/** What is saved (and synced to other devices): the offset as a fraction of the screen, so a layout made on a big screen still fits a small one. */
interface Saved {
  fx: number;
  fy: number;
  s: number;
  w?: number;
  h?: number;
}

const TARGETS: [string, string][] = [
  ['self-frame', 'Your frame'],
  ['target-frame', 'Target'],
  ['party', 'Party'],
  ['enemies', 'Enemies'],
  ['actionbar', 'Action bar'],
  ['trinketbar', 'Trinket button'],
  ['cast', 'Cast bar'],
  ['autoind', 'Auto-attack'],
  ['log', 'Combat log'],
  ['killfeed', 'Kill feed'],
  ['help', 'Help text'],
];
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


export class HudLayout {
  editing = false;
  onChange: (editing: boolean) => void = () => {};
  private data: Record<string, Slot> = {};
  private bar: HTMLElement;
  private drag: { id: string; px: number; py: number; dx: number; dy: number } | null = null;
  /** Dragging an element's corner grip: its size when the drag began. */
  private sizing: { id: string; px: number; py: number; w: number; h: number } | null = null;
  private grips = new Map<string, HTMLElement>();
  private style = 'classic';
  private styleSel!: HTMLSelectElement;
  private styleDesc!: HTMLElement;
  /** Grid overlay and snapping, saved with the editor. */
  private grid = { show: true, snap: true, size: 16 };
  private gridEl!: HTMLElement;
  private selected: string | null = null;
  private lookSelects = new Map<string, HTMLSelectElement>();

  /** The saved layout as screen fractions; pixel offsets are worked out from it for the current window size. */
  private saved: Record<string, Saved> = {};

  constructor() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Partial<Slot & Saved>>;
      for (const [id] of TARGETS) {
        const r = raw[id];
        if (!r || !Number.isFinite(r.s)) continue;
        const sc = clamp(r.s!, 0.6, 1.6);
        const size = { ...(Number.isFinite(r.w) ? { w: clamp(r.w!, 40, 2000) } : {}), ...(Number.isFinite(r.h) ? { h: clamp(r.h!, 16, 1400) } : {}) };
        if (Number.isFinite(r.fx) && Number.isFinite(r.fy)) this.saved[id] = { fx: clamp(r.fx!, -1, 1), fy: clamp(r.fy!, -1, 1), s: sc, ...size };
        else if (Number.isFinite(r.dx) && Number.isFinite(r.dy)) this.saved[id] = { fx: r.dx! / window.innerWidth, fy: r.dy! / window.innerHeight, s: sc }; // an older pixel layout
      }
      this.fromSaved();
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

    for (const [id, label] of TARGETS) {
      const e = document.getElementById(id);
      if (!e) continue;
      e.dataset.hud = label;
      e.addEventListener('pointerdown', (ev) => this.down(ev, id));
      e.addEventListener('wheel', (ev) => this.wheel(ev, id), { passive: false });
    }
    window.addEventListener('pointermove', (ev) => this.move(ev));
    window.addEventListener('pointerup', () => {
      this.drag = null;
      this.sizing = null;
    });
    window.addEventListener('resize', () => {
      if (!this.editing) this.fromSaved();
      this.fitAll();
    });
    for (const [id] of TARGETS) this.apply(id);
    requestAnimationFrame(() => this.fitAll());
  }

  start() {
    this.editing = true;
    document.body.classList.add('hud-edit');
    for (const [id] of TARGETS) this.addGrip(id);
    this.bar.classList.remove('hidden');
    this.selected = null;
    this.paintSelection();
    this.paintGrid();
    window.addEventListener('keydown', this.keyHandler);
    this.onChange(true);
  }

  stop() {
    if (!this.editing) return;
    this.editing = false;
    this.drag = null;
    document.body.classList.remove('hud-edit');
    for (const g of this.grips.values()) g.remove();
    this.grips.clear();
    this.bar.classList.add('hidden');
    this.gridEl.classList.add('hidden');
    window.removeEventListener('keydown', this.keyHandler);
    this.save();
    this.onChange(false);
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
    this.data = {};
    for (const [tid] of TARGETS) this.apply(tid);
    // scale first, then measure the natural position and offset the centre onto the target spot
    const W = window.innerWidth;
    const H = window.innerHeight;
    requestAnimationFrame(() => {
      for (const [tid, [fx, fy, sc]] of Object.entries(p.place)) {
        const e = document.getElementById(tid);
        if (!e) continue;
        const slot = this.slot(tid);
        slot.s = sc;
        slot.dx = 0;
        slot.dy = 0;
        this.apply(tid);
        const r = e.getBoundingClientRect();
        if (r.width === 0) continue;
        slot.dx = fx * W - (r.left + r.width / 2);
        slot.dy = fy * H - (r.top + r.height / 2);
        this.apply(tid);
        this.fit(tid);
      }
      this.save();
    });
  }

  reset() {
    this.setStyle('classic');
    resetLook();
    this.syncLookSelects();
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
    head.append(mk('b', '', 'Edit HUD'), mk('span', 'he-sub', 'Drag to move. Drag the corner to change width and height (double-click it for the natural size). Scroll to scale. Arrow keys nudge the last one you moved.'));
    const done = mk('button', 'primary', 'Done');
    done.addEventListener('click', () => this.stop());
    const reset = mk('button', '', 'Reset all');
    reset.addEventListener('click', () => this.reset());
    head.append(reset, done);

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

    // look options
    const details = document.createElement('details');
    details.className = 'he-look';
    details.append(mk('summary', '', 'Frames, health bars, nameplates and slots'));
    const grid = mk('div', 'he-lookgrid');
    let group = '';
    for (const o of LOOK_OPTIONS) {
      if ((o.group ?? '') !== group) {
        group = o.group ?? '';
        grid.append(mk('h4', 'he-group', group));
      }
      const l = mk('label', '', `${o.label} `);
      const sel = document.createElement('select');
      for (const [v, t] of o.choices) sel.append(new Option(t, v));
      sel.value = look[o.id];
      sel.addEventListener('change', () => setLook(o.id, sel.value));
      this.lookSelects.set(o.id, sel);
      l.append(sel);
      grid.append(l);
    }
    details.append(grid);

    panel.append(head, row1, row2, details);
    return panel;
  }

  private syncLookSelects() {
    for (const [id, sel] of this.lookSelects) sel.value = look[id];
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
    for (const [tid] of TARGETS) document.getElementById(tid)?.classList.toggle('hud-selected', tid === this.selected);
  }

  /** Pull the element to the nearest grid line (its left or right edge) and to the screen centre when close. */
  private snap(id: string) {
    const e = document.getElementById(id);
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
    s.dx += v[0];
    s.dy += v[1];
    this.apply(this.selected);
    this.fit(this.selected);
  };

  private slot(id: string): Slot {
    return (this.data[id] ??= { dx: 0, dy: 0, s: 1 });
  }

  private apply(id: string) {
    const e = document.getElementById(id);
    if (!e) return;
    const s = this.data[id];
    e.style.translate = s ? `${s.dx}px ${s.dy}px` : '';
    e.style.scale = s && s.s !== 1 ? String(s.s) : '';
    e.style.width = s?.w ? `${s.w}px` : '';
    e.style.height = s?.h ? `${s.h}px` : '';
    e.classList.toggle('hud-sized', !!(s?.w || s?.h));
  }

  /** The corner grip shown on an element while editing: drag it to change the element's width and height. */
  private addGrip(id: string) {
    const e = document.getElementById(id);
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
      this.paintSelection();
      this.sizing = { id, px: ev.clientX, py: ev.clientY, w: r.width / s.s, h: r.height / s.s };
    });
    g.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      const s = this.slot(id);
      delete s.w;
      delete s.h;
      this.apply(id);
      this.fit(id);
      this.save();
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
    const e = document.getElementById(id);
    const s = this.data[id];
    if (!e || !s) return;
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
    for (const [id] of TARGETS) this.fit(id);
  }

  /** Pixel offsets for this window size from the saved fractions. */
  private fromSaved() {
    this.data = {};
    for (const [id, f] of Object.entries(this.saved)) this.data[id] = { dx: f.fx * window.innerWidth, dy: f.fy * window.innerHeight, s: f.s, ...(f.w ? { w: f.w } : {}), ...(f.h ? { h: f.h } : {}) };
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
    this.paintSelection();
    this.drag = { id, px: ev.clientX, py: ev.clientY, dx: s.dx, dy: s.dy };
  }

  private move(ev: PointerEvent) {
    const z = this.sizing;
    if (z) {
      const s = this.slot(z.id);
      const g = this.grid.snap && !ev.altKey ? this.grid.size / 2 : 1;
      s.w = Math.round(clamp(z.w + (ev.clientX - z.px) / s.s, 40, window.innerWidth) / g) * g;
      s.h = Math.round(clamp(z.h + (ev.clientY - z.py) / s.s, 16, window.innerHeight) / g) * g;
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
    s.s = clamp(Math.round((s.s - Math.sign(ev.deltaY) * 0.05) * 100) / 100, 0.6, 1.6);
    this.apply(id);
    this.fit(id);
  }

  private save() {
    this.saved = Object.fromEntries(Object.entries(this.data).map(([id, d]) => [id, { fx: Math.round((d.dx / window.innerWidth) * 10000) / 10000, fy: Math.round((d.dy / window.innerHeight) * 10000) / 10000, s: d.s, ...(d.w ? { w: Math.round(d.w) } : {}), ...(d.h ? { h: Math.round(d.h) } : {}) }]));
    try {
      localStorage.setItem(KEY, JSON.stringify(this.saved));
    } catch {
      /* ignore */
    }
  }
}
