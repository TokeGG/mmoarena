/**
 * HUD layout editor. Every movable element gets a saved offset and scale applied through the CSS `translate` and
 * `scale` properties, which compose with each element's own positioning and transforms. Edit mode (from the Esc menu)
 * lets you drag elements and scroll over one to resize it; positions persist in localStorage.
 */

interface Slot {
  dx: number;
  dy: number;
  s: number;
}

const TARGETS: [string, string][] = [
  ['self-frame', 'Your frame'],
  ['target-frame', 'Target'],
  ['party', 'Party'],
  ['enemies', 'Enemies'],
  ['actionbar', 'Action bar'],
  ['cast', 'Cast bar'],
  ['autoind', 'Auto-attack'],
  ['log', 'Combat log'],
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

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class HudLayout {
  editing = false;
  onChange: (editing: boolean) => void = () => {};
  private data: Record<string, Slot> = {};
  private bar: HTMLElement;
  private drag: { id: string; px: number; py: number; dx: number; dy: number } | null = null;
  private style = 'classic';
  private styleSel!: HTMLSelectElement;
  private styleDesc!: HTMLElement;

  constructor() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Partial<Slot>>;
      for (const [id] of TARGETS) {
        const r = raw[id];
        if (r && Number.isFinite(r.dx) && Number.isFinite(r.dy) && Number.isFinite(r.s)) this.data[id] = { dx: r.dx!, dy: r.dy!, s: clamp(r.s!, 0.6, 1.6) };
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

    this.bar = document.createElement('div');
    this.bar.id = 'hud-edit-bar';
    this.bar.className = 'hidden';
    const text = document.createElement('span');
    text.textContent = 'Drag to move, scroll to resize.';
    this.styleSel = document.createElement('select');
    for (const p of PRESETS) this.styleSel.append(new Option(p.name, p.id));
    this.styleSel.value = this.style;
    this.styleDesc = document.createElement('small');
    this.styleDesc.textContent = PRESETS.find((p) => p.id === this.style)?.desc ?? '';
    this.styleSel.addEventListener('change', () => this.setStyle(this.styleSel.value));
    const label = document.createElement('label');
    label.textContent = 'Style ';
    label.append(this.styleSel);
    const reset = document.createElement('button');
    reset.textContent = 'Reset all';
    reset.addEventListener('click', () => this.reset());
    const done = document.createElement('button');
    done.textContent = 'Done';
    done.className = 'primary';
    done.addEventListener('click', () => this.stop());
    this.bar.append(text, label, this.styleDesc, reset, done);
    document.body.append(this.bar);

    for (const [id, label] of TARGETS) {
      const e = document.getElementById(id);
      if (!e) continue;
      e.dataset.hud = label;
      e.addEventListener('pointerdown', (ev) => this.down(ev, id));
      e.addEventListener('wheel', (ev) => this.wheel(ev, id), { passive: false });
    }
    window.addEventListener('pointermove', (ev) => this.move(ev));
    window.addEventListener('pointerup', () => (this.drag = null));
    window.addEventListener('resize', () => this.fitAll());
    for (const [id] of TARGETS) this.apply(id);
    requestAnimationFrame(() => this.fitAll());
  }

  start() {
    this.editing = true;
    document.body.classList.add('hud-edit');
    this.bar.classList.remove('hidden');
    this.onChange(true);
  }

  stop() {
    if (!this.editing) return;
    this.editing = false;
    this.drag = null;
    document.body.classList.remove('hud-edit');
    this.bar.classList.add('hidden');
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
  }

  private slot(id: string): Slot {
    return (this.data[id] ??= { dx: 0, dy: 0, s: 1 });
  }

  private apply(id: string) {
    const e = document.getElementById(id);
    if (!e) return;
    const s = this.data[id];
    e.style.translate = s ? `${s.dx}px ${s.dy}px` : '';
    e.style.scale = s && s.s !== 1 ? String(s.s) : '';
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

  private down(ev: PointerEvent, id: string) {
    if (!this.editing) return;
    ev.preventDefault();
    ev.stopPropagation();
    const s = this.slot(id);
    this.drag = { id, px: ev.clientX, py: ev.clientY, dx: s.dx, dy: s.dy };
  }

  private move(ev: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    const s = this.slot(d.id);
    s.dx = d.dx + (ev.clientX - d.px);
    s.dy = d.dy + (ev.clientY - d.py);
    this.apply(d.id);
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
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* ignore */
    }
  }
}
