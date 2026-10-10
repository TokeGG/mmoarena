/**
 * The rules of the guided tours, kept free of the page so they can be tested: which tours exist, the remembered "seen"
 * list (and how two devices' lists are merged), which tour starts by itself at a given moment, how the steps are walked
 * and what a key press does while a tour is open. `tour.ts` draws it; `tourData.ts` holds the words.
 */

export const TOUR_IDS = ['devtools', 'tuning', 'admin', 'menu', 'build', 'hud', 'watch'] as const;
export type TourId = (typeof TOUR_IDS)[number];

/** localStorage key of the seen list. Every `arena.*` key follows a signed-in account (settingsSync.ts), so this one does too. */
export const TOURS_KEY = 'arena.tours.v1';

/** When each tour was finished or skipped (ms since 1970). A tour that is not in the list has not been seen. */
export type SeenMap = Partial<Record<TourId, number>>;

const isId = (k: string): k is TourId => (TOUR_IDS as readonly string[]).includes(k);

/** Read the saved list; anything that is not a known tour with a sane time is dropped. Never throws. */
export function parseSeen(raw: string | null | undefined): SeenMap {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out: SeenMap = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (isId(k) && typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
    }
    return out;
  } catch {
    return {};
  }
}

/** The list as saved (known tours only, in a fixed order, so equal lists give equal text). */
export function serializeSeen(m: SeenMap): string {
  const out: Record<string, number> = {};
  for (const id of TOUR_IDS) if (m[id]) out[id] = m[id]!;
  return JSON.stringify(out);
}

export function markSeenIn(m: SeenMap, id: TourId, now: number): SeenMap {
  return { ...m, [id]: Math.max(1, Math.floor(now)) };
}

/** "Skip tour": the person does not want any of them by themselves, so every tour counts as seen (the Help & tours list still starts any of them). */
export function markAllSeenIn(m: SeenMap, now: number): SeenMap {
  const out: SeenMap = { ...m };
  for (const id of TOUR_IDS) out[id] ??= now;
  return out;
}

/** Both devices' lists together: a tour seen anywhere stays seen (the earlier time is kept). */
export function unionSeen(a: string | null | undefined, b: string | null | undefined): string {
  const x = parseSeen(a);
  const y = parseSeen(b);
  const out: SeenMap = {};
  for (const id of TOUR_IDS) {
    const t = [x[id], y[id]].filter((n): n is number => !!n);
    if (t.length) out[id] = Math.min(...t);
  }
  return serializeSeen(out);
}

// ------------------------------------------------------------------ what starts by itself

export type TourTrigger = 'devpanel' | 'tuning' | 'admin' | 'menu' | 'match' | 'watch';
export type Access = 'owner' | 'dev' | null;

/** The tour a moment starts, or null: it was seen already, or the person may not use that screen. One tour per moment. */
export function pickAutoTour(trigger: TourTrigger, seen: SeenMap, access: Access): TourId | null {
  const staff = access === 'owner' || access === 'dev';
  switch (trigger) {
    case 'devpanel':
      return staff && !seen.devtools ? 'devtools' : null;
    case 'tuning':
      return staff && !seen.tuning ? 'tuning' : null;
    case 'admin':
      return staff && !seen.admin ? 'admin' : null;
    // the welcome tour first; the build tour is next time the menu shows, so a new player is not given two in a row
    case 'menu':
      return !seen.menu ? 'menu' : !seen.build ? 'build' : null;
    case 'match':
      return !seen.hud ? 'hud' : null;
    case 'watch':
      return !seen.watch ? 'watch' : null;
  }
}

/** Where the person is: the menu, playing a match, watching one (or a replay), or somewhere else (loading, a dev window). */
export type TourContext = 'menu' | 'match' | 'watch' | 'other';
export type TourNeeds = 'menu' | 'match' | 'watch' | 'any';

/** Whether a tour can run where the person is (the menu tours point at the menu, the HUD tour at a match). */
export function canStartIn(needs: TourNeeds, ctx: TourContext): boolean {
  return needs === 'any' || needs === ctx;
}

// ------------------------------------------------------------------ walking the steps

export interface Walk {
  index: number;
  done: boolean;
}

/** Next step; past the last one the tour is done. */
export function stepForward(index: number, count: number): Walk {
  if (count <= 0) return { index: 0, done: true };
  return index + 1 >= count ? { index: count - 1, done: true } : { index: Math.max(0, index) + 1, done: false };
}

export function stepBack(index: number): number {
  return Math.max(0, index - 1);
}

/** "3 / 9" (one based). */
export function counterText(index: number, count: number): string {
  return `${Math.min(count, Math.max(0, index) + 1)} / ${count}`;
}

export function isLastStep(index: number, count: number): boolean {
  return index >= count - 1;
}

/** Text that reads differently on a screen with a mouse and one with a finger. */
export type TourText = string | { desktop: string; touch: string };
export function textFor(t: TourText, touch: boolean): string {
  return typeof t === 'string' ? t : touch ? t.touch : t.desktop;
}

// ------------------------------------------------------------------ keys

export type TourKey = 'next' | 'back' | 'skip' | 'swallow' | 'pass';

/**
 * What a key press does while a tour is open. A tour that dims the page (`modal`) takes every key, so nothing reaches the
 * game behind it: Enter and the right arrow go on, the left arrow goes back, Esc skips, the rest is swallowed. A tour that
 * leaves the match playable (`hint`) only uses Enter and Esc and lets the other keys through to the game.
 */
export function keyAction(code: string, mode: 'modal' | 'hint'): TourKey {
  if (code === 'Escape') return 'skip';
  if (code === 'Enter' || code === 'NumpadEnter') return 'next';
  if (mode === 'hint') return 'pass';
  if (code === 'ArrowRight') return 'next';
  if (code === 'ArrowLeft') return 'back';
  return 'swallow';
}

// ------------------------------------------------------------------ where the card goes

export interface Rect { x: number; y: number; w: number; h: number }
export type Placed = { kind: 'free'; left: number; top: number } | { kind: 'dock'; edge: 'top' | 'bottom' };

/** Screens at most this wide get the card docked to the top or bottom edge, full width, with big buttons. */
export const NARROW = 600;
export const CARD_W = 340;
const GAP = 12;
const EDGE = 8;

/**
 * Where the card goes. With nothing to point at it is centred. On a phone it docks to the bottom edge (the top when the
 * thing it points at sits in the lower half, so the card never covers it). On a bigger screen it sits beside the target:
 * below, above, right, then left, whichever fits first, and over the middle of the screen when none does.
 */
export function placeCard(target: Rect | null, card: { w: number; h: number }, vp: { w: number; h: number }, preferTop = false): Placed {
  const clampX = (x: number) => Math.max(EDGE, Math.min(x, vp.w - card.w - EDGE));
  const clampY = (y: number) => Math.max(EDGE, Math.min(y, vp.h - card.h - EDGE));
  if (vp.w <= NARROW) {
    if (!target) return { kind: 'dock', edge: preferTop ? 'top' : 'bottom' };
    const mid = target.y + target.h / 2;
    return { kind: 'dock', edge: preferTop || mid > vp.h * 0.5 ? 'top' : 'bottom' };
  }
  if (!target) return { kind: 'free', left: clampX((vp.w - card.w) / 2), top: clampY((vp.h - card.h) / 2) };
  const cx = target.x + target.w / 2 - card.w / 2;
  const cy = target.y + target.h / 2 - card.h / 2;
  if (target.y + target.h + GAP + card.h <= vp.h - EDGE) return { kind: 'free', left: clampX(cx), top: target.y + target.h + GAP };
  if (target.y - GAP - card.h >= EDGE) return { kind: 'free', left: clampX(cx), top: target.y - GAP - card.h };
  if (target.x + target.w + GAP + card.w <= vp.w - EDGE) return { kind: 'free', left: target.x + target.w + GAP, top: clampY(cy) };
  if (target.x - GAP - card.w >= EDGE) return { kind: 'free', left: target.x - GAP - card.w, top: clampY(cy) };
  return { kind: 'free', left: clampX((vp.w - card.w) / 2), top: clampY(vp.h - card.h - 24) };
}

/** The box around several rectangles (a target that matches more than one element is lit as one). */
export function unionRect(rs: readonly Rect[]): Rect | null {
  if (!rs.length) return null;
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  const right = Math.max(...rs.map((q) => q.x + q.w));
  const bottom = Math.max(...rs.map((q) => q.y + q.h));
  return { x, y, w: right - x, h: bottom - y };
}

/** A rectangle grown by `pad` and cut to the screen. Null when it is off the screen or has no size. */
export function spotRect(r: Rect, pad: number, vp: { w: number; h: number }): Rect | null {
  const x = Math.max(0, r.x - pad);
  const y = Math.max(0, r.y - pad);
  const right = Math.min(vp.w, r.x + r.w + pad);
  const bottom = Math.min(vp.h, r.y + r.h + pad);
  return right - x > 2 && bottom - y > 2 ? { x, y, w: right - x, h: bottom - y } : null;
}

// ------------------------------------------------------------------ what a tour is

/** What a step points at: a CSS selector (every visible match is lit together), or a function for anything a selector cannot say. */
export type TourTarget = string | (() => Element | Element[] | null);

/** The things a tour may do to the game around it (open a window, switch a tab). Filled in by main.ts. */
export interface TourHost {
  /** Forget held keys and mouse buttons (a tour that dims the page opens over a game that was being played). */
  releaseInput(): void;
  /** The Dev tools window: open it (from the menu or a match), and pick what it shows. */
  openDevPanel(): boolean;
  devShow(o: { section?: 'values' | 'match' | 'ask'; page?: string; drawer?: boolean; setups?: boolean }): void;
  /** The admin panel on a tab. */
  openAdmin(tab: string): void;
  closeAdmin(): void;
  /** Close the Esc / settings menu and the Help window. */
  closeMenus(): void;
  /** Whether the person is a dev or the owner. */
  access(): Access;
}

export interface TourStep {
  title: string;
  text: TourText;
  /** Nothing: a card in the middle of the screen. */
  target?: TourTarget;
  /** Runs when the step opens (switch a tab, open a window). */
  onEnter?: (h: TourHost) => void | Promise<void>;
  /** The target may take a moment to exist (a window opening): wait up to 1.5 s for it, then show the card in the middle. */
  wait?: boolean;
  /** Dropped from the tour when its target is not on screen when the tour starts (a button only some people have). */
  optional?: boolean;
  /** Runs every 200 ms while the step shows (keeps a hover card open). */
  keep?: (h: TourHost) => void;
}

export interface TourDef {
  id: TourId;
  /** Name in the lists ("Main menu", "Your first match"). */
  name: string;
  /** One line under the name in Help & tours. */
  blurb: string;
  group: 'player' | 'dev' | 'admin';
  needs: TourNeeds;
  /** `modal` dims the page and takes every key; `hint` leaves the match playable (see keyAction). */
  mode: 'modal' | 'hint';
  steps: TourStep[];
  /** Runs when the tour ends, however it ends (close what the steps opened). */
  onEnd?: (h: TourHost) => void;
}
