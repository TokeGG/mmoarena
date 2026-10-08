/**
 * The mouse cursor: the player's chosen style (a steel gauntlet by default, ten more to unlock, with a size, a tint, a click
 * ripple and a trail) for normal use, and three fixed overrides that look the same for everyone: a red sword over an enemy,
 * a green cross over an ally and a crosshair while a ground spell is aimed (red when it cannot land). All art is drawn in
 * code (`cursorArt.ts`).
 *
 * Still styles use the native CSS cursor (a data: URI SVG with a 1x/2x image-set and a keyword fallback). The animated ones
 * (Ember, Frost shard, Void eye, Dragon claw, Starfall) and the ripple / trail use one small overlay that follows the mouse,
 * driven by a single requestAnimationFrame loop that only runs while something moves. The overlay hides itself whenever the
 * OS cursor is hidden anyway (pointer lock, steering with the right button) and nothing is done on touch-only devices.
 *
 * Everything that decides something (settings parsing, unlocks, context, CSS) is a pure function, tested without a DOM;
 * the manager at the bottom is the only part that touches the page.
 */
import { CURSORS, DEFAULT_CURSOR, isUnlocked } from '@arena/shared';
import type { Stats } from '@arena/shared';
import { cursorArt, glowFor, isOverlayStyle, isOverride } from './cursorArt';
import type { ArtState, CursorArt, CursorContext } from './cursorArt';

export { CURSOR_CONTEXTS, ART_STATES, ART_STYLES, OVERLAY_STYLES, cursorArt, glowFor, isOverlayStyle, isOverride } from './cursorArt';
export type { ArtState, CursorArt, CursorContext } from './cursorArt';

// ------------------------------------------------------------------------------------------------ settings

export const CURSOR_KEYS = { style: 'arena.cursor.style', size: 'arena.cursor.size', tint: 'arena.cursor.tint', ripple: 'arena.cursor.ripple', trail: 'arena.cursor.trail', trailLen: 'arena.cursor.trailLen' } as const;
export const SIZE_MIN = 0.75;
export const SIZE_MAX = 2;
export const TRAIL_MIN = 4;
export const TRAIL_MAX = 32;

export interface CursorSettings {
  /** An id from `CURSORS` (a locked one is never applied). */
  style: string;
  /** 0.75 .. 2. */
  size: number;
  /** 'class' = the class colour, 'off' = no glow, or a #rrggbb colour. */
  tint: string;
  ripple: boolean;
  trail: boolean;
  /** Number of trail points, 4 .. 32. */
  trailLen: number;
}

export const DEFAULT_CURSOR_SETTINGS: CursorSettings = { style: DEFAULT_CURSOR, size: 1, tint: 'class', ripple: false, trail: false, trailLen: 12 };

/** Preset tints offered next to the class colour (all valid #rrggbb values). */
export const TINT_CHOICES: [string, string][] = [['class', 'Class colour'], ['off', 'None'], ['#f2c14e', 'Gold'], ['#ff4b3e', 'Red'], ['#4dff7a', 'Green'], ['#6fe0ff', 'Cyan'], ['#c58bff', 'Violet'], ['#ffffff', 'White']];

const HEX = /^#[0-9a-fA-F]{6}$/;
const num = (v: string | null, lo: number, hi: number, dflt: number, step = 0.05): number => {
  if (v === null || v.trim() === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.round(Math.min(hi, Math.max(lo, n)) / step) * step;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Reads the settings from `read` (localStorage in the game). Anything bad or still locked falls back to the default. */
export function parseCursorSettings(read: (key: string) => string | null, isOpen: (id: string) => boolean): CursorSettings {
  const d = DEFAULT_CURSOR_SETTINGS;
  const style = read(CURSOR_KEYS.style);
  const tint = read(CURSOR_KEYS.tint);
  return {
    style: style !== null && CURSORS.some((c) => c.id === style) && isOpen(style) ? style : d.style,
    size: r2(num(read(CURSOR_KEYS.size), SIZE_MIN, SIZE_MAX, d.size)),
    tint: tint === 'off' || tint === 'class' || (tint !== null && HEX.test(tint)) ? tint.toLowerCase() : d.tint,
    ripple: read(CURSOR_KEYS.ripple) === '1',
    trail: read(CURSOR_KEYS.trail) === '1',
    trailLen: Math.round(num(read(CURSOR_KEYS.trailLen), TRAIL_MIN, TRAIL_MAX, d.trailLen, 1)),
  };
}

/** The same settings as the strings stored under `arena.cursor.*`. */
export function serializeCursorSettings(s: CursorSettings): Record<string, string> {
  return { [CURSOR_KEYS.style]: s.style, [CURSOR_KEYS.size]: String(s.size), [CURSOR_KEYS.tint]: s.tint, [CURSOR_KEYS.ripple]: s.ripple ? '1' : '0', [CURSOR_KEYS.trail]: s.trail ? '1' : '0', [CURSOR_KEYS.trailLen]: String(s.trailLen) };
}

/** Merge a change into the settings, keeping every field valid. A locked style in the patch is ignored (the old one stays). */
export function patchCursorSettings(cur: CursorSettings, patch: Partial<CursorSettings>, isOpen: (id: string) => boolean): CursorSettings {
  const p = { ...patch };
  if (p.style !== undefined && !isOpen(p.style)) delete p.style;
  const raw = serializeCursorSettings({ ...cur, ...p });
  return parseCursorSettings((k) => raw[k] ?? null, isOpen);
}

// ------------------------------------------------------------------------------------------------ unlocks

export interface CursorStats extends Stats {
  name?: string;
  grants?: string[];
}

export const cursorDef = (id: string) => CURSORS.find((c) => c.id === id);

/** Is this cursor open for this player? Free ones always are, the owner has every one, the rest follow matches / wins / peak rating. */
export function cursorOpen(id: string, stats: CursorStats): boolean {
  const def = cursorDef(id);
  return !!def && isUnlocked(def, stats, 'cursor');
}

// ------------------------------------------------------------------------------------------------ colours

/** The colour a glow or tint takes: the class colour, a chosen colour or none. */
export function tintColor(s: Pick<CursorSettings, 'tint'>, classColor: string | null): string | null {
  if (s.tint === 'off') return null;
  if (s.tint === 'class') return classColor && HEX.test(classColor) ? classColor : null;
  return HEX.test(s.tint) ? s.tint : null;
}

// ------------------------------------------------------------------------------------------------ context

/** What the game knows, polled a few times a second. */
export interface CursorSituation {
  inMatch: boolean;
  spectating: boolean;
  /** A ground spell is being aimed: 'aim' when it can land where the ring is, 'aimBlocked' when it cannot be cast or the ring is red. */
  aim: 'aim' | 'aimBlocked' | null;
  myTeam: number | null;
}
/** The unit under the pointer. */
export interface CursorHover {
  team: number;
  alive: boolean;
  /** The unit is you: the chosen style stays. */
  self: boolean;
}

/**
 * The context for the pointer: aiming wins over what is under it; otherwise an enemy or ally under the pointer overrides the
 * chosen style. Off the scene, for spectators and over yourself (or anyone dead) it is the default.
 */
export function decideContext(sit: CursorSituation, hover: CursorHover | null, overScene: boolean): CursorContext {
  if (!sit.inMatch || !overScene) return 'default';
  if (sit.aim && !sit.spectating) return sit.aim;
  if (sit.spectating || !hover || !hover.alive || hover.self) return 'default';
  return sit.myTeam !== null && hover.team === sit.myTeam ? 'ally' : 'enemy';
}

/** The pick (a raycast) is only needed while nothing else decides the context. */
export function needsPick(sit: CursorSituation): boolean {
  return sit.inMatch && !sit.spectating && !sit.aim;
}

// ------------------------------------------------------------------------------------------------ plan and CSS

export interface CursorPlan {
  style: string;
  state: ArtState;
  /** The art follows the mouse in an overlay (animated styles) instead of being the native cursor. */
  overlay: boolean;
  trail: boolean;
  trailLen: number;
  ripple: boolean;
}

/** `prefers-reduced-motion`: no overlay animation, trail or ripple; every style falls back to its still art as the native cursor. */
export function planFor(s: CursorSettings, ctx: CursorContext, reducedMotion: boolean): CursorPlan {
  const frost = s.style === 'frost';
  return {
    style: s.style,
    state: ctx,
    overlay: isOverlayStyle(s.style) && !reducedMotion && !isOverride(ctx),
    trail: !reducedMotion && (s.trail || frost),
    trailLen: s.trail ? s.trailLen : frost ? 10 : s.trailLen,
    ripple: !reducedMotion && s.ripple,
  };
}

const FALLBACK: Record<ArtState, string> = { default: 'auto', link: 'pointer', enemy: 'crosshair', ally: 'pointer', aim: 'crosshair', aimBlocked: 'not-allowed' };
export const cursorFallback = (state: ArtState): string => FALLBACK[state];

const dataUri = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29')}")`;

/**
 * The `cursor:` declarations for one state: a plain url() first (every browser), then the image-set() forms, which browsers
 * that understand them use for a sharp image on high-DPI screens. Each ends with a keyword fallback.
 */
export function cursorDeclarations(style: string, state: ArtState, opts: { size: number; glow: string | null }, important = false): string[] {
  const one: CursorArt = cursorArt(style, state, { size: opts.size, glow: opts.glow, density: 1 });
  const two: CursorArt = cursorArt(style, state, { size: opts.size, glow: opts.glow, density: 2 });
  const fb = FALLBACK[state];
  const hot = `${one.hx} ${one.hy}`;
  const tail = `${hot}, ${fb}${important ? ' !important' : ''};`;
  const set = `${dataUri(one.svg)} 1x, ${dataUri(two.svg)} 2x`;
  return [`cursor:${dataUri(one.svg)} ${tail}`, `cursor:-webkit-image-set(${set}) ${tail}`, `cursor:image-set(${set}) ${tail}`];
}

/**
 * The style sheet text that makes `plan` the page's cursor: the art for the state, the gauntlet's pressing-finger variant
 * over buttons (other styles keep their own art there), none while the overlay draws it.
 */
export function cursorCss(plan: CursorPlan, s: CursorSettings, classColor: string | null): string {
  const tint = tintColor(s, classColor);
  const art = (state: ArtState) => ({ size: s.size, glow: glowFor(plan.style, state, tint) });
  const base = cursorDeclarations(plan.style, plan.state, art(plan.state)).join('');
  const link = plan.style === 'gauntlet' ? `html.ac-pt,html.ac-pt *{${cursorDeclarations(plan.style, 'link', art('link'), true).join('')}}` : '';
  return `html{${base}}${link}html.ac-own,html.ac-own *{cursor:none !important;}`;
}

// ------------------------------------------------------------------------------------------------ the page (browser only)

export interface CursorHooks {
  /** The scene canvas: the context only changes while the pointer is over it. */
  canvas: HTMLCanvasElement;
  /** The game state, read a few times a second; must be cheap. */
  situation(): CursorSituation;
  /** The unit under a screen point, or null. Runs a raycast, so it is throttled. */
  pick(x: number, y: number): CursorHover | null;
  /** Matches, wins, peak rating and name of the player (for unlocks). */
  stats(): CursorStats;
  /** The colour of the class being played (or picked in the menu), for the tint. */
  classColor(): string | null;
}

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable: the choice lasts until the page is closed */
  }
};

/** Which animation colours a style throws (trail, ripple, sparks). */
const FX_COLOR: Record<string, string> = { ember: '#ff8a2a', frost: '#9fe8ff', void: '#b266ff', star: '#ffd84a', claw: '#ff6a4a', wand: '#7fe8ff', dagger: '#39e8ff' };

let hooks: CursorHooks | null = null;
let settings: CursorSettings = { ...DEFAULT_CURSOR_SETTINGS };
let ctx: CursorContext = 'default';
let appliedKey = '';
let styleEl: HTMLStyleElement | null = null;
let reduced = false;
const listeners = new Set<() => void>();

export const getCursorSettings = (): CursorSettings => settings;
/** Called when the settings or the unlocked set change (the settings panel re-draws). */
export const onCursorChange = (fn: () => void): (() => void) => (listeners.add(fn), () => listeners.delete(fn));
const emit = () => listeners.forEach((f) => f());
const isOpen = (id: string) => cursorOpen(id, hooks?.stats() ?? { matches: 0, wins: 0, peak: 0 });
export const isCursorOpen = isOpen;
export const cursorClassColor = (): string | null => hooks?.classColor() ?? null;
export const currentCursorContext = (): CursorContext => ctx;

/** Set the context directly (the game calls this for states it knows; the pointer probe sets the rest). */
export function setCursorContext(next: CursorContext): void {
  if (next === ctx) return;
  ctx = next;
  apply();
}

/** Change one or more settings: validated, saved under `arena.cursor.*` and applied at once. */
export function updateCursorSettings(patch: Partial<CursorSettings>): void {
  settings = patchCursorSettings(settings, patch, isOpen);
  for (const [k, v] of Object.entries(serializeCursorSettings(settings))) write(k, v);
  apply();
  emit();
}

/** The account's stats or the stored settings changed (sign-in, a synced setting): read everything again. */
export function refreshCursor(): void {
  settings = parseCursorSettings(read, isOpen);
  apply();
  emit();
}

function apply(): void {
  if (!hooks || !styleEl) return;
  const cc = hooks.classColor();
  const plan = planFor(settings, ctx, reduced);
  const key = `${plan.style}|${plan.state}|${plan.overlay}|${settings.size}|${settings.tint}|${cc}`;
  if (key !== appliedKey) {
    appliedKey = key;
    styleEl.textContent = cursorCss(plan, settings, cc);
  }
  overlay.configure(plan, tintColor(settings, cc), cc);
}

// ---- overlay: the art that follows the mouse, plus the canvas for trail, ripple and sparks

class Overlay {
  private art: HTMLDivElement | null = null;
  private fx: HTMLCanvasElement | null = null;
  private g: CanvasRenderingContext2D | null = null;
  private plan: CursorPlan | null = null;
  private artKey = '';
  private tint: string | null = null;
  private x = -100;
  private y = -100;
  private shownX = -1000;
  private shownY = -1000;
  private seen = false;
  private hidden = false;
  private rmb = false;
  private raf = 0;
  private dpr = 1;
  private hx = 0;
  private hy = 0;
  private pupil: SVGGElement | null = null;
  private px = 0;
  private py = 0;
  private lastT = 0;
  // trail: ring buffer of positions
  private trailX = new Float32Array(TRAIL_MAX + 2);
  private trailY = new Float32Array(TRAIL_MAX + 2);
  private trailN = 0;
  private trailHead = 0;
  private trailQuiet = 0;
  // ripples and sparks: fixed pools
  private rip = new Float64Array(6 * 3); // x, y, start (ms), x6
  private ripN = 0;
  private sp = new Float32Array(24 * 5); // x, y, vx, vy, life
  private spActive = 0;
  private drawn = false;

  /** Does the page-wide `cursor:none` apply right now (the overlay draws the cursor)? */
  get owns(): boolean {
    return !!this.plan?.overlay;
  }

  start(): void {
    const d = document;
    d.addEventListener('mousemove', (e) => this.move(e), { passive: true, capture: true });
    d.addEventListener('mousedown', (e) => this.down(e), { passive: true, capture: true });
    d.addEventListener('mouseup', (e) => this.up(e), { passive: true, capture: true });
    d.documentElement.addEventListener('mouseleave', () => this.setHidden(true));
    d.documentElement.addEventListener('mouseenter', () => this.setHidden(false));
    d.addEventListener('pointerlockchange', () => this.setHidden(!!d.pointerLockElement || this.rmb), { passive: true });
    window.addEventListener('blur', () => ((this.rmb = false), this.setHidden(true)));
    window.addEventListener('resize', () => this.resize());
  }

  configure(plan: CursorPlan, tint: string | null, _classColor: string | null): void {
    this.plan = plan;
    this.tint = tint;
    if (plan.overlay) this.ensureArt();
    else if (this.art) this.art.style.display = 'none';
    document.documentElement.classList.toggle('ac-own', plan.overlay && !this.hover);
    if (plan.trail || plan.ripple || plan.overlay) this.ensureFx();
    this.paintArt();
    this.show();
    this.kick();
  }

  /** The pointer is over something that keeps its own cursor (a text box, a resize grip): the overlay steps aside. */
  hover = 0;
  setHover(other: boolean): void {
    this.hover = other ? 1 : 0;
    document.documentElement.classList.toggle('ac-own', !!this.plan?.overlay && !other);
    this.show();
  }

  private ensureArt(): void {
    if (this.art) return;
    const a = document.createElement('div');
    a.id = 'arena-cursor-art';
    a.setAttribute('aria-hidden', 'true');
    a.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647;display:none;will-change:transform;contain:layout paint style;';
    document.body.append(a);
    this.art = a;
  }

  private ensureFx(): void {
    if (this.fx) return;
    const c = document.createElement('canvas');
    c.id = 'arena-cursor-fx';
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;background:transparent;';
    document.body.append(c);
    this.fx = c;
    this.g = c.getContext('2d');
    this.resize();
  }

  private resize(): void {
    if (!this.fx) return;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.fx.width = Math.ceil(window.innerWidth * this.dpr);
    this.fx.height = Math.ceil(window.innerHeight * this.dpr);
  }

  /** Put the art for the current style and context into the overlay (only when something about it changed). */
  private paintArt(): void {
    const p = this.plan;
    if (!p || !p.overlay || !this.art) return;
    const glow = glowFor(p.style, p.state, this.tint);
    const key = `${p.style}|${p.state}|${settings.size}|${glow}`;
    if (key === this.artKey) return;
    this.artKey = key;
    const a = cursorArt(p.style, p.state, { size: settings.size, glow, ids: 'acx-' });
    this.art.innerHTML = a.svg;
    this.art.style.width = this.art.style.height = `${a.w}px`;
    this.hx = a.hx;
    this.hy = a.hy;
    this.pupil = this.art.querySelector<SVGGElement>('.ac-pupil');
    this.art.classList.toggle('ac-down', this.down0);
    this.shownX = -1000; // reposition with the new hotspot
  }

  private down0 = false;

  private setHidden(h: boolean): void {
    this.hidden = h;
    this.show();
  }

  private show(): void {
    if (!this.art) return;
    const on = !!this.plan?.overlay && this.seen && !this.hidden && !this.hover && !document.pointerLockElement && !this.rmb;
    this.art.style.display = on ? 'block' : 'none';
  }

  private move(e: MouseEvent): void {
    if (document.pointerLockElement) return; // locked: the OS cursor is hidden and the coordinates are frozen
    this.x = e.clientX;
    this.y = e.clientY;
    if (!this.seen || this.hidden) {
      this.seen = true;
      this.hidden = false;
      this.show();
    }
    this.kick();
  }

  private down(e: MouseEvent): void {
    const p = this.plan;
    if (e.button === 2) {
      this.rmb = true; // steering: the browser takes the pointer, the overlay goes
      this.show();
    }
    if (!p || e.button !== 0) return;
    if (p.style === 'claw' && p.overlay && this.art) {
      this.down0 = true;
      this.art.classList.add('ac-down');
      this.toggleClaw(true);
    }
    if (p.ripple) this.addRipple(e.clientX, e.clientY);
    if (p.style === 'ember' && p.overlay) this.burst(e.clientX, e.clientY);
    this.kick();
  }

  private up(e: MouseEvent): void {
    if (e.button === 2) {
      this.rmb = false;
      this.show();
    }
    if (e.button === 0 && this.down0) {
      this.down0 = false;
      this.art?.classList.remove('ac-down');
      this.toggleClaw(false);
    }
  }

  private toggleClaw(closed: boolean): void {
    const o = this.art?.querySelector<SVGGElement>('.cl-open');
    const c = this.art?.querySelector<SVGGElement>('.cl-closed');
    if (o) o.style.display = closed ? 'none' : '';
    if (c) c.style.display = closed ? '' : 'none';
  }

  private addRipple(x: number, y: number): void {
    const i = (this.ripN++ % 6) * 3;
    this.rip[i] = x;
    this.rip[i + 1] = y;
    this.rip[i + 2] = performance.now();
  }

  private burst(x: number, y: number): void {
    let n = 0;
    for (let i = 0; i < 24 && n < 12; i++) {
      const o = i * 5;
      if (this.sp[o + 4] > 0) continue;
      const a = Math.random() * Math.PI * 2;
      const v = 40 + Math.random() * 130;
      this.sp[o] = x;
      this.sp[o + 1] = y;
      this.sp[o + 2] = Math.cos(a) * v;
      this.sp[o + 3] = Math.sin(a) * v - 30;
      this.sp[o + 4] = 0.35 + Math.random() * 0.3;
      n++;
      this.spActive++;
    }
  }

  /** Start the loop if it is not running; it stops itself when nothing moves. */
  private kick(): void {
    if (!this.raf && (this.plan?.overlay || this.plan?.trail || this.plan?.ripple || this.spActive > 0)) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(t: number): void {
    this.raf = 0;
    const p = this.plan;
    if (!p) return;
    const dt = Math.min(0.05, this.lastT ? (t - this.lastT) / 1000 : 0.016);
    this.lastT = t;
    const moved = this.x !== this.shownX || this.y !== this.shownY;
    let busy = false;
    if (p.overlay && this.art) {
      if (moved) {
        const dx = this.x - (this.shownX < -500 ? this.x : this.shownX);
        const dy = this.y - (this.shownY < -500 ? this.y : this.shownY);
        this.art.style.transform = `translate3d(${this.x - this.hx}px,${this.y - this.hy}px,0)`;
        this.shownX = this.x;
        this.shownY = this.y;
        if (this.pupil) this.lookAt(dx, dy);
        busy = true;
      } else if (this.pupil && (Math.abs(this.px) > 0.05 || Math.abs(this.py) > 0.05)) {
        this.lookAt(0, 0);
        busy = true;
      }
    }
    if (p.trail && moved) this.pushTrail();
    const g = this.g;
    if (g && this.fx) {
      const live = (p.trail && this.trailN > 0 && this.trailQuiet < 40) || this.spActive > 0 || this.ripN > 0;
      if (live || this.drawn) {
        g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        g.clearRect(0, 0, this.fx.width / this.dpr, this.fx.height / this.dpr);
        this.drawn = false;
        if (p.trail) busy = this.drawTrail(g, p, moved) || busy;
        busy = this.drawRipples(g, t, p) || busy;
        busy = this.drawSparks(g, dt) || busy;
      }
    }
    if (busy || moved) this.raf = requestAnimationFrame((tt) => this.frame(tt));
    else this.lastT = 0;
  }

  /** The Void eye's pupil leans the way the mouse is moving and settles back when it stops. */
  private lookAt(dx: number, dy: number): void {
    const len = Math.hypot(dx, dy);
    const k = len > 0.5 ? Math.min(1, len / 14) : 0;
    const tx = len > 0 ? (dx / len) * k * 4.2 : 0;
    const ty = len > 0 ? (dy / len) * k * 2.2 : 0;
    this.px += (tx - this.px) * (len > 0.5 ? 0.45 : 0.16);
    this.py += (ty - this.py) * (len > 0.5 ? 0.45 : 0.16);
    this.pupil?.setAttribute('transform', `translate(${this.px.toFixed(2)} ${this.py.toFixed(2)})`);
  }

  private pushTrail(): void {
    this.trailHead = (this.trailHead + 1) % this.trailX.length;
    this.trailX[this.trailHead] = this.x;
    this.trailY[this.trailHead] = this.y;
    if (this.trailN < this.trailX.length) this.trailN++;
    this.trailQuiet = 0;
  }

  private drawTrail(g: CanvasRenderingContext2D, p: CursorPlan, moved: boolean): boolean {
    if (!moved) this.trailQuiet++;
    const len = Math.min(p.trailLen, this.trailN - 1);
    if (len < 1) return false;
    const col = FX_COLOR[p.style] ?? this.tint ?? '#ffffff';
    g.strokeStyle = col;
    g.lineCap = 'round';
    const n = this.trailX.length;
    const fade = this.trailQuiet > 0 ? Math.max(0, 1 - this.trailQuiet / 30) : 1;
    let any = false;
    for (let i = 0; i < len; i++) {
      const a = (this.trailHead - i + n) % n;
      const b = (this.trailHead - i - 1 + n) % n;
      const f = 1 - i / len;
      g.globalAlpha = 0.6 * f * fade;
      g.lineWidth = Math.max(1, 7 * settings.size * f);
      g.beginPath();
      g.moveTo(this.trailX[a], this.trailY[a]);
      g.lineTo(this.trailX[b], this.trailY[b]);
      g.stroke();
      any = true;
    }
    g.globalAlpha = 1;
    this.drawn = any;
    return any && fade > 0;
  }

  private drawRipples(g: CanvasRenderingContext2D, now: number, p: CursorPlan): boolean {
    if (this.ripN <= 0) return false;
    let alive = 0;
    const col = this.tint ?? FX_COLOR[p.style] ?? '#ffffff';
    g.strokeStyle = col;
    for (let i = 0; i < 6; i++) {
      const o = i * 3;
      const age = (now - this.rip[o + 2]) / 480;
      if (!(this.rip[o + 2] > 0) || age >= 1) continue;
      alive++;
      g.globalAlpha = (1 - age) * 0.8;
      g.lineWidth = 2.4 * (1 - age) + 0.6;
      g.beginPath();
      g.arc(this.rip[o], this.rip[o + 1], (4 + age * 24) * settings.size, 0, Math.PI * 2);
      g.stroke();
      this.drawn = true;
    }
    g.globalAlpha = 1;
    if (!alive) this.ripN = 0;
    return alive > 0;
  }

  private drawSparks(g: CanvasRenderingContext2D, dt: number): boolean {
    if (this.spActive <= 0) return false;
    let alive = 0;
    for (let i = 0; i < 24; i++) {
      const o = i * 5;
      if (this.sp[o + 4] <= 0) continue;
      this.sp[o + 4] -= dt;
      if (this.sp[o + 4] <= 0) {
        this.spActive--;
        continue;
      }
      this.sp[o + 3] += 260 * dt;
      this.sp[o] += this.sp[o + 2] * dt;
      this.sp[o + 1] += this.sp[o + 3] * dt;
      g.globalAlpha = Math.min(1, this.sp[o + 4] * 3);
      g.fillStyle = i % 3 === 0 ? '#fff0a0' : '#ff9a2a';
      g.fillRect(this.sp[o] - 1.2, this.sp[o + 1] - 1.2, 2.4, 2.4);
      this.drawn = true;
      alive++;
    }
    g.globalAlpha = 1;
    return alive > 0;
  }
}
const overlay = new Overlay();

const OVERLAY_CSS =
  '@keyframes ac-flick{0%,100%{transform:scale(1,1) skewX(0)}25%{transform:scale(1.04,.94) skewX(3deg)}50%{transform:scale(.96,1.06) skewX(-3deg)}75%{transform:scale(1.03,.97) skewX(2deg)}}' +
  '@keyframes ac-tw{0%,100%{opacity:1}50%{opacity:.35}}' +
  '#arena-cursor-art .ac-flame{animation:ac-flick .34s ease-in-out infinite;transform-box:fill-box;transform-origin:50% 100%}' +
  '#arena-cursor-art .ac-sp1,#arena-cursor-art .ac-sp2,#arena-cursor-art .ac-sp3,#arena-cursor-art .ac-twk{animation:ac-tw .6s ease-in-out infinite}' +
  '#arena-cursor-art .ac-sp2{animation-delay:.2s}#arena-cursor-art .ac-sp3{animation-delay:.4s}';

/**
 * Start the cursor system (once, after the scene exists). Does nothing on touch-only devices.
 * `rootClass` toggles: `ac-pt` over buttons and links (the link art), `ac-own` while the overlay draws the cursor.
 */
export function initCursors(h: CursorHooks): void {
  if (hooks || typeof document === 'undefined') return;
  try {
    if (window.matchMedia && !window.matchMedia('(any-hover: hover) and (any-pointer: fine)').matches) return;
    const rm = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduced = rm.matches;
    rm.addEventListener?.('change', () => {
      reduced = rm.matches;
      appliedKey = '';
      apply();
    });
  } catch {
    /* no matchMedia: assume a mouse and normal motion */
  }
  hooks = h;
  styleEl = document.createElement('style');
  styleEl.id = 'arena-cursor-style';
  document.head.append(styleEl);
  const anim = document.createElement('style');
  anim.textContent = OVERLAY_CSS;
  document.head.append(anim);
  settings = parseCursorSettings(read, isOpen);
  overlay.start();
  apply();

  // buttons and links get the pointing variant; text boxes and grips keep their own cursor
  const root = document.documentElement;
  let last: EventTarget | null = null;
  document.addEventListener(
    'mouseover',
    (e) => {
      const t = e.target as Element | null;
      if (!t || t === last) return;
      last = t;
      overScene = t === h.canvas;
      if (overScene) {
        root.classList.remove('ac-pt');
        overlay.setHover(false);
        return;
      }
      const wasOwn = root.classList.contains('ac-own');
      root.classList.remove('ac-pt', 'ac-own');
      const c = getComputedStyle(t).cursor;
      root.classList.toggle('ac-own', wasOwn);
      const kind = c.includes('pointer') ? 'pt' : c.startsWith('url(') || c === 'auto' || c === 'default' ? 'auto' : 'other';
      root.classList.toggle('ac-pt', kind === 'pt');
      overlay.setHover(kind === 'other');
    },
    { passive: true, capture: true },
  );
  document.addEventListener('mousemove', (e) => ((px = e.clientX), (py = e.clientY), (moved = true)), { passive: true, capture: true });

  // the context: polled a few times a second, the raycast only while the pointer moves over the scene
  let hover: CursorHover | null = null;
  let lastPick = 0;
  window.setInterval(() => {
    if (document.hidden) return;
    const sit = h.situation();
    const locked = !!document.pointerLockElement;
    const now = performance.now();
    if (!locked && overScene && needsPick(sit) && now - lastPick > (moved ? 60 : 250)) {
      hover = h.pick(px, py);
      lastPick = now;
      moved = false;
    } else if (!overScene || !needsPick(sit)) hover = null;
    if (!locked) setCursorContext(decideContext(sit, hover, overScene));
    const cc = h.classColor();
    if (cc !== lastClass) {
      lastClass = cc;
      apply();
    }
  }, 50);
}
let overScene = false;
let px = 0;
let py = 0;
let moved = false;
let lastClass: string | null = null;
