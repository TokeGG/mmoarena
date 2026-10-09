/**
 * One floating tooltip for the whole UI. Any element with a `data-tip` attribute gets a tooltip; the text is built
 * by a resolver from the key, so HUD elements that are rebuilt every frame (aura icons) keep working: the tooltip
 * re-reads whatever element is under the cursor several times a second.
 */
import { markedParts } from '@arena/shared';

export interface TipContent {
  title: string;
  titleColor?: string;
  /** Small line under the title, right-aligned on the title row (e.g. school or slot). */
  tag?: string;
  /** Dim line under the title (cost, range, cast time...). */
  stats?: string[];
  lines?: string[];
  good?: string[];
  bad?: string[];
  notes?: string[];
  footer?: string;
  /** In-depth lines (how the numbers are worked out, what boosts it), shown only while the detail key is held. */
  more?: string[];
}

export type TipResolver = (key: string, data: DOMStringMap, detail: boolean) => TipContent | null;

let resolver: TipResolver = () => null;
let tipEl: HTMLElement | null = null;
let mx = 0;
let my = 0;
let shownKey = '';
let timer = 0;
let detailHeld: () => boolean = () => false;
/** When a finger last touched down: a tap shows the tooltip of what it hit (above the finger) and it stays until the next tap. */
let touchAt = -1e9;
let touchMode = false;

/** The tooltip shows its `more` lines while this returns true (the Detailed tooltips key). */
export function setDetailKey(held: () => boolean) {
  detailHeld = held;
}

export function setTipResolver(r: TipResolver) {
  resolver = r;
}

/** What the tooltips describe changed (a talent or spec was picked): build the open tooltip again now, and any later one fresh. */
export function invalidateTip() {
  shownKey = '';
  if (tipEl && !tipEl.classList.contains('hidden')) refresh();
}

function ensure(): HTMLElement {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.id = 'tooltip';
    tipEl.className = 'hidden';
    document.body.append(tipEl);
  }
  return tipEl;
}

/**
 * One tooltip row. A number your spec or talents changed arrives marked (see `markedParts` in describe.ts) and is drawn
 * green (red when it got worse) with the unmodified value struck through next to it.
 */
function row(cls: string, text: string): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  for (const p of markedParts(text)) {
    if ('text' in p) {
      d.append(p.text);
      continue;
    }
    const v = document.createElement('span');
    v.className = `tt-num ${p.better ? 'up' : 'down'}`;
    v.textContent = p.value;
    const was = document.createElement('span');
    was.className = 'tt-was';
    was.textContent = p.base;
    d.append(v, was);
  }
  return d;
}

/** True when the content has a number changed by the build (so the colour key is worth showing). */
const hasMarks = (c: TipContent) => [...(c.stats ?? []), ...(c.lines ?? []), ...(c.good ?? []), ...(c.notes ?? []), ...(c.more ?? [])].some((s) => markedParts(s).some((p) => !('text' in p)));

/** Comparable form of a tooltip line: case, spacing and end punctuation do not matter. */
const lineKey = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[\s.!:]+$/, '').trim();

/**
 * The tooltip's text with every line that repeats the title or an earlier line removed, so nothing reads twice whatever
 * the content builder produced (the in-depth lines never echo the short ones either).
 */
export function dedupeTip(c: TipContent): TipContent {
  const seen = new Set([lineKey(c.title)]);
  const keep = (list: string[] | undefined) => list?.filter((s) => {
    const k = lineKey(s);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const out: TipContent = { ...c, stats: keep(c.stats), lines: keep(c.lines), good: keep(c.good), bad: keep(c.bad), notes: keep(c.notes), more: keep(c.more) };
  if (c.footer && seen.has(lineKey(c.footer))) out.footer = undefined;
  return out;
}

function render(tip: TipContent, detail: boolean): HTMLElement[] {
  const c = dedupeTip(tip);
  const out: HTMLElement[] = [];
  const head = document.createElement('div');
  head.className = 'tt-head';
  const title = document.createElement('span');
  title.className = 'tt-title';
  title.textContent = c.title;
  if (c.titleColor) {
    title.style.color = c.titleColor;
    if (/^#[0-9a-f]{6}$/i.test(c.titleColor)) head.style.background = `linear-gradient(90deg, ${c.titleColor}33, transparent)`;
  }
  head.append(title);
  if (c.tag) head.append(row('tt-tag', c.tag));
  out.push(head);
  if (c.stats?.length) {
    const chips = document.createElement('div');
    chips.className = 'tt-chips';
    for (const s of c.stats) chips.append(row('tt-stat', s));
    out.push(chips);
  }
  for (const s of c.lines ?? []) out.push(row('tt-line', s));
  for (const s of c.good ?? []) out.push(row('tt-good', s));
  for (const s of c.bad ?? []) out.push(row('tt-bad', s));
  for (const s of c.notes ?? []) out.push(row('tt-note', s));
  if (detail && c.more?.length) {
    out.push(row('tt-more-h', 'In depth'));
    for (const s of c.more) out.push(row('tt-more', s));
  }
  if (c.footer) out.push(row('tt-foot', c.footer));
  if (hasMarks(c)) out.push(row('tt-hint', 'Green: changed by your spec and talents (the base value is struck through)'));
  if (!detail && c.more?.length) out.push(row('tt-hint', 'Hold the Detailed tooltips key for more'));
  return out;
}

function place() {
  const el = ensure();
  const pad = 14;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let x = touchMode ? mx - w / 2 : mx + pad;
  let y = touchMode ? my - h - 28 : my + pad;
  if (touchMode && y < 6) y = my + 28; // no room above the finger: below it
  if (x + w > window.innerWidth - 6) x = touchMode ? window.innerWidth - w - 6 : mx - w - pad;
  if (y + h > window.innerHeight - 6) y = my - h - pad;
  el.style.left = `${Math.max(6, x)}px`;
  el.style.top = `${Math.max(6, y)}px`;
}

function refresh() {
  const el = ensure();
  const under = document.elementFromPoint(mx, my) as HTMLElement | null;
  const host = under?.closest?.('[data-tip]') as HTMLElement | null;
  if (!host) {
    el.classList.add('hidden');
    shownKey = '';
    return;
  }
  const key = host.dataset.tip!;
  const detail = detailHeld();
  const sig = `${key}|${host.dataset.tipSub ?? ''}|${detail ? 1 : 0}`;
  if (sig !== shownKey || el.classList.contains('hidden')) {
    const content = resolver(key, host.dataset, detail);
    if (!content) {
      el.classList.add('hidden');
      shownKey = '';
      return;
    }
    if (host.dataset.tipSub) content.footer = content.footer ? `${content.footer}\n${host.dataset.tipSub}` : host.dataset.tipSub;
    el.replaceChildren(...render(content, detail));
    el.classList.remove('hidden');
    shownKey = sig;
  }
  place();
}

/** Call once at startup. */
export function initTooltips() {
  ensure();
  window.addEventListener('mousemove', (e) => {
    if (performance.now() - touchAt < 800) return;
    touchMode = false;
    mx = e.clientX;
    my = e.clientY;
    refresh();
  });
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') {
      touchMode = false;
      return;
    }
    // a tap on something with a tooltip shows it; a tap anywhere else puts it away
    touchAt = performance.now();
    touchMode = true;
    mx = e.clientX;
    my = e.clientY;
    shownKey = '';
    refresh();
  }, true);
  window.addEventListener('mousedown', () => {
    if (performance.now() - touchAt < 800) return; // the mouse event a browser makes up after a tap
    ensure().classList.add('hidden');
    shownKey = '';
  });
  // elements are rebuilt every frame in the HUD, so keep the text current while hovering
  timer = window.setInterval(() => {
    if (!ensure().classList.contains('hidden')) refresh();
  }, 150);
  window.addEventListener('blur', () => ensure().classList.add('hidden'));
  void timer;
}
