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
const MARGIN = 6;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class HudLayout {
  editing = false;
  onChange: (editing: boolean) => void = () => {};
  private data: Record<string, Slot> = {};
  private bar: HTMLElement;
  private drag: { id: string; px: number; py: number; dx: number; dy: number } | null = null;

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

    this.bar = document.createElement('div');
    this.bar.id = 'hud-edit-bar';
    this.bar.className = 'hidden';
    const text = document.createElement('span');
    text.textContent = 'HUD layout: drag elements to move them, scroll over one to resize.';
    const reset = document.createElement('button');
    reset.textContent = 'Reset all';
    reset.addEventListener('click', () => this.reset());
    const done = document.createElement('button');
    done.textContent = 'Done';
    done.className = 'primary';
    done.addEventListener('click', () => this.stop());
    this.bar.append(text, reset, done);
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

  reset() {
    this.data = {};
    for (const [id] of TARGETS) this.apply(id);
    this.save();
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
