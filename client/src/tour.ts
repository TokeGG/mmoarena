/**
 * Guided tours: a spotlight on one part of the screen and a card that says what it is, a step at a time. This is the
 * engine (the page, the keys, remembering what was seen); the words are in `tourData.ts` and the rules in `tourLogic.ts`.
 *
 * A tour that dims the page (`modal`) takes every key and every click, so nothing behind it can be pressed or cast. The
 * match tour (`hint`) only outlines the part it talks about and leaves the match playable: it uses Enter and Esc and
 * lets the other keys through. Either way the tour itself never sends anything to the game.
 *
 * Import this file before anything that listens for keys in `main.ts`: its key listener must run first.
 */
import { TOURS } from './tourData';
import { CARD_W, TOURS_KEY, canStartIn, counterText, isLastStep, keyAction, markSeenIn, parseSeen, pickAutoTour, placeCard, serializeSeen, spotRect, stepBack, stepForward, textFor, unionRect } from './tourLogic';
import type { Rect, SeenMap, TourContext, TourDef, TourHost, TourId, TourStep, TourTrigger } from './tourLogic';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/** A finger is the main pointer: the touch wording of the steps is used. */
const touchScreen = () => {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
};

/** Something is already open that a tour must not stack on (a sign-in window, the Esc menu, the HUD editor, a dev window). */
const busy = () => !!document.querySelector('.mm-modal:not(.hidden), .mm-specpop:not(.hidden), #menu:not(.hidden), .admp, .tour-help, .devp:not(.hidden)') || document.body.classList.contains('hud-edit') || document.body.classList.contains('hud-demo');

interface Run {
  def: TourDef;
  steps: TourStep[];
  index: number;
  /** Bumped on every step change; a step that was still opening when another began is dropped. */
  token: number;
}

class TourRunner {
  host: TourHost | null = null;
  private ctx: TourContext = 'other';
  private syncPending = false;
  private deferred: (() => void) | null = null;
  private run: Run | null = null;
  private n: { root: HTMLElement; dim: HTMLElement; spot: HTMLElement; card: HTMLElement; title: HTMLElement; count: HTMLElement; text: HTMLElement; back: HTMLButtonElement; skip: HTMLButtonElement; next: HTMLButtonElement } | null = null;
  private timer = 0;
  private lastLayout = '';
  private raf = 0;
  /** Called when a tour starts or ends (the Help window redraws). */
  onChange: () => void = () => undefined;

  constructor() {
    // first in line (see the header): while a tour is open the game behind it never sees these keys
    window.addEventListener('keydown', (e) => this.key(e), true);
    window.addEventListener('keyup', (e) => {
      if (this.run && keyAction(e.code, this.run.def.mode) !== 'pass') e.stopImmediatePropagation();
    }, true);
    window.addEventListener('resize', () => this.soon());
    window.addEventListener('scroll', () => this.soon(), true);
  }

  /** A tour is open. The game checks this before it casts or moves anything on a key or click. */
  get active(): boolean {
    return !!this.run;
  }
  /** A tour that dims the page is open: the game takes no input at all. */
  get blocking(): boolean {
    return this.run?.def.mode === 'modal';
  }
  get activeId(): TourId | null {
    return this.run?.def.id ?? null;
  }
  get context(): TourContext {
    return this.ctx;
  }

  // ------------------------------------------------------------------ what was seen

  seen(): SeenMap {
    try {
      return parseSeen(localStorage.getItem(TOURS_KEY));
    } catch {
      return {};
    }
  }
  isSeen(id: TourId): boolean {
    return !!this.seen()[id];
  }
  private save(m: SeenMap) {
    try {
      if (Object.keys(m).length) localStorage.setItem(TOURS_KEY, serializeSeen(m));
      else localStorage.removeItem(TOURS_KEY);
    } catch {
      /* not remembered: the tour may show again */
    }
  }
  /** "Reset all tours": every tour is new again. */
  resetAll() {
    this.save({});
    this.onChange();
  }

  // ------------------------------------------------------------------ when tours start

  setHost(h: TourHost) {
    this.host = h;
  }

  /** Where the person is now (main.ts reports it every frame); a new place may start that place's tour. */
  setContext(c: TourContext) {
    if (c === this.ctx) return;
    this.ctx = c;
    if (c === 'menu') this.autoRun('menu');
    else if (c === 'match') this.autoRun('match');
    else if (c === 'watch') this.autoRun('watch');
  }

  /** A signed-in account's settings (which carry the seen list) have not arrived yet: wait before starting anything by itself. */
  setSyncPending(on: boolean) {
    this.syncPending = on;
    if (!on && this.deferred) {
      const go = this.deferred;
      this.deferred = null;
      go();
    }
  }

  /**
   * A moment that may start a tour (the menu showed, a match began, the Dev tools opened). It starts at most one, only when
   * that tour was not seen yet, and (unless `panel`) not while a window is open over the screen.
   */
  autoRun(trigger: TourTrigger, panel = false) {
    const attempt = (tries: number) => {
      if (this.run) return;
      const id = pickAutoTour(trigger, this.seen(), this.host?.access() ?? null);
      if (!id) return;
      if (!canStartIn(TOURS[id].needs, this.ctx)) return; // the person moved on
      if (this.syncPending) {
        this.deferred = () => attempt(0);
        return;
      }
      if (!panel && busy()) {
        if (tries < 90) window.setTimeout(() => attempt(tries + 1), 1000);
        return;
      }
      this.start(id);
    };
    window.setTimeout(() => attempt(0), panel ? 350 : 900);
  }

  // ------------------------------------------------------------------ running a tour

  /** Start a tour now (a replay, or an automatic one). False when one is already open or this one does not fit the screen. */
  start(id: TourId): boolean {
    const def = TOURS[id];
    if (!def || this.run || !this.host || !canStartIn(def.needs, this.ctx)) return false;
    const steps = def.steps.filter((s) => !s.optional || this.targets(s).length);
    if (!steps.length) return false;
    this.run = { def, steps, index: 0, token: 0 };
    this.build(def.mode);
    document.body.classList.add('tour-open');
    if (def.mode === 'modal') {
      this.host.releaseInput();
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
    this.timer = window.setInterval(() => this.tick(), 200);
    this.onChange();
    void this.goTo(0);
    return true;
  }

  /**
   * A replay button: open whatever the tour needs (the Dev tools window, the admin panel on a tab), then start it. Returns
   * a sentence for the person when it cannot start from here (for instance a menu tour while a match is on).
   */
  launch(id: TourId): string | null {
    const def = TOURS[id];
    const h = this.host;
    if (!def || !h) return 'Tours are not ready yet.';
    if (this.run) this.end(false);
    if (id === 'devtools') {
      h.closeAdmin();
      h.closeMenus();
      if (!h.openDevPanel()) return 'The Dev tools open from the main menu or a match (the 🛠 button, or F2). Open them there, then replay this tour.';
    } else if (id === 'tuning' || id === 'admin') {
      h.closeMenus();
      h.openAdmin(id === 'tuning' ? 'tuning' : 'dashboard');
    } else {
      if (!canStartIn(def.needs, this.ctx)) return def.needs === 'menu' ? 'Go to the main menu first (leave the match), then replay this tour.' : def.needs === 'match' ? 'Start a match first (Practice works); this tour runs in your first seconds of one.' : 'Watch a live match or a replay first, then replay this tour.';
      h.closeAdmin();
      h.closeMenus();
    }
    window.setTimeout(() => this.start(id), 400);
    return null;
  }

  private async goTo(index: number) {
    const r = this.run;
    if (!r || !this.host) return;
    r.index = index;
    const token = ++r.token;
    const step = r.steps[index];
    try {
      await step.onEnter?.(this.host);
    } catch {
      /* a window that would not open: the card shows anyway */
    }
    if (this.run !== r || r.token !== token) return;
    if (step.wait) {
      for (let i = 0; i < 15 && !this.targets(step).length; i++) {
        await sleep(100);
        if (this.run !== r || r.token !== token) return;
      }
    }
    this.paintStep();
  }

  next() {
    const r = this.run;
    if (!r) return;
    const w = stepForward(r.index, r.steps.length);
    if (w.done) this.end(true);
    else void this.goTo(w.index);
  }
  back() {
    const r = this.run;
    if (r && r.index > 0) void this.goTo(stepBack(r.index));
  }
  /** Skip or finish: both count as seen. */
  skip() {
    this.end(true);
  }

  /** Close the tour. `seen`: remember it as seen (finished or skipped), else it comes back next time (the person left the place it was about). */
  end(seen: boolean) {
    const r = this.run;
    if (!r) return;
    this.run = null;
    window.clearInterval(this.timer);
    window.cancelAnimationFrame(this.raf);
    this.n?.root.remove();
    this.n = null;
    this.lastLayout = '';
    document.body.classList.remove('tour-open');
    if (seen) this.save(markSeenIn(this.seen(), r.def.id, Date.now()));
    try {
      if (this.host) r.def.onEnd?.(this.host);
    } catch {
      /* ignore */
    }
    this.onChange();
  }

  // ------------------------------------------------------------------ keys

  private key(e: KeyboardEvent) {
    const r = this.run;
    if (!r) return;
    const act = keyAction(e.code, r.def.mode);
    if (act === 'pass') return;
    e.stopImmediatePropagation(); // nothing else sees it: not the game, not the menus under the tour
    if (act === 'swallow') return; // browser shortcuts (F5, Tab to move between the card's buttons) still work
    e.preventDefault();
    if (e.repeat) return;
    if (act === 'next') this.next();
    else if (act === 'back') this.back();
    else this.skip();
  }

  // ------------------------------------------------------------------ drawing

  private build(mode: 'modal' | 'hint') {
    const root = el('div', `tour ${mode}`);
    const dim = el('div', 'tour-dim');
    const spot = el('div', 'tour-spot');
    const card = el('div', 'tour-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Guided tour');
    const head = el('div', 'tour-head');
    const title = el('b', 'tour-title');
    const count = el('span', 'tour-count');
    head.append(title, count);
    const text = el('div', 'tour-text');
    text.setAttribute('aria-live', 'polite');
    const btns = el('div', 'tour-btns');
    const skip = el('button', 'tour-skip', 'Skip tour');
    skip.type = 'button';
    skip.addEventListener('click', () => this.skip());
    const back = el('button', 'tour-back', 'Back');
    back.type = 'button';
    back.addEventListener('click', () => this.back());
    const next = el('button', 'tour-next', 'Next');
    next.type = 'button';
    next.addEventListener('click', () => this.next());
    btns.append(skip, el('span', 'tour-gap'), back, next);
    card.append(head, text, btns);
    root.append(dim, spot, card);
    if (mode === 'modal') root.addEventListener('contextmenu', (e) => e.preventDefault());
    document.body.append(root);
    this.n = { root, dim, spot, card, title, count, text, back, skip, next };
  }

  private paintStep() {
    const r = this.run;
    const n = this.n;
    if (!r || !n) return;
    const step = r.steps[r.index];
    const count = r.steps.length;
    n.title.textContent = step.title;
    n.count.textContent = counterText(r.index, count);
    n.text.textContent = textFor(step.text, touchScreen());
    n.back.hidden = r.index === 0;
    const last = isLastStep(r.index, count);
    n.next.textContent = last ? 'Done' : 'Next';
    n.skip.hidden = last;
    n.root.classList.add('shown');
    // bring the target into view when it sits in a scrolling list
    const first = this.targets(step)[0];
    try {
      const b = first?.getBoundingClientRect();
      if (first && b && (b.top < 0 || b.bottom > window.innerHeight)) first.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch {
      /* ignore */
    }
    this.lastLayout = '';
    this.layout();
    if (r.def.mode === 'modal') n.next.focus({ preventScroll: true });
  }

  /** The elements a step points at that are on screen now. */
  private targets(step: TourStep): Element[] {
    const t = step.target;
    if (!t) return [];
    let found: Element[] = [];
    try {
      const got = typeof t === 'string' ? [...document.querySelectorAll(t)] : t();
      found = Array.isArray(got) ? got : got ? [got] : [];
    } catch {
      found = [];
    }
    return found.filter((e) => {
      if (this.n?.root.contains(e)) return false;
      const b = e.getBoundingClientRect();
      return b.width > 0 && b.height > 0;
    });
  }

  private soon() {
    if (!this.run || this.raf) return;
    this.raf = window.requestAnimationFrame(() => {
      this.raf = 0;
      this.layout();
    });
  }

  private tick() {
    const r = this.run;
    if (!r) return;
    // the place the tour is about is gone (a match ended, the menu was left): close it, it comes back next time
    if (!canStartIn(r.def.needs, this.ctx)) return this.end(false);
    if (this.host) r.steps[r.index].keep?.(this.host);
    this.layout();
  }

  /** Put the spotlight on the target and the card beside it (again whenever the page moved). */
  private layout() {
    const r = this.run;
    const n = this.n;
    if (!r || !n || !n.root.classList.contains('shown')) return;
    const step = r.steps[r.index];
    const vp = { w: window.innerWidth, h: window.innerHeight };
    const rects: Rect[] = this.targets(step).map((e) => {
      const b = e.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height };
    });
    const box = unionRect(rects);
    const spot = box ? spotRect(box, 6, vp) : null;
    const card = { w: n.card.offsetWidth, h: n.card.offsetHeight };
    const placed = placeCard(spot, card, vp, r.def.mode === 'hint');
    const key = JSON.stringify([spot, placed, card, vp]);
    if (key === this.lastLayout) return;
    this.lastLayout = key;
    n.root.classList.toggle('nospot', !spot);
    if (spot) {
      n.spot.style.cssText = `left:${spot.x}px;top:${spot.y}px;width:${spot.w}px;height:${spot.h}px`;
    }
    n.card.classList.toggle('dock', placed.kind === 'dock');
    n.card.classList.toggle('dock-top', placed.kind === 'dock' && placed.edge === 'top');
    if (placed.kind === 'dock') n.card.style.cssText = '';
    else n.card.style.cssText = `left:${placed.left}px;top:${placed.top}px;width:${Math.min(CARD_W, vp.w - 16)}px`;
  }
}

export const tours = new TourRunner();

