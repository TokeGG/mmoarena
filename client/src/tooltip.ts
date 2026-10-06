/**
 * One floating tooltip for the whole UI. Any element with a `data-tip` attribute gets a tooltip; the text is built
 * by a resolver from the key, so HUD elements that are rebuilt every frame (aura icons) keep working: the tooltip
 * re-reads whatever element is under the cursor several times a second.
 */

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
}

export type TipResolver = (key: string, data: DOMStringMap) => TipContent | null;

let resolver: TipResolver = () => null;
let tipEl: HTMLElement | null = null;
let mx = 0;
let my = 0;
let shownKey = '';
let timer = 0;

export function setTipResolver(r: TipResolver) {
  resolver = r;
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

function row(cls: string, text: string): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  return d;
}

function render(c: TipContent): HTMLElement[] {
  const out: HTMLElement[] = [];
  const head = document.createElement('div');
  head.className = 'tt-head';
  const title = document.createElement('span');
  title.className = 'tt-title';
  title.textContent = c.title;
  if (c.titleColor) title.style.color = c.titleColor;
  head.append(title);
  if (c.tag) head.append(row('tt-tag', c.tag));
  out.push(head);
  for (const s of c.stats ?? []) out.push(row('tt-stat', s));
  for (const s of c.lines ?? []) out.push(row('tt-line', s));
  for (const s of c.good ?? []) out.push(row('tt-good', s));
  for (const s of c.bad ?? []) out.push(row('tt-bad', s));
  for (const s of c.notes ?? []) out.push(row('tt-note', s));
  if (c.footer) out.push(row('tt-foot', c.footer));
  return out;
}

function place() {
  const el = ensure();
  const pad = 14;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let x = mx + pad;
  let y = my + pad;
  if (x + w > window.innerWidth - 6) x = mx - w - pad;
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
  const sig = `${key}|${host.dataset.tipSub ?? ''}`;
  if (sig !== shownKey || el.classList.contains('hidden')) {
    const content = resolver(key, host.dataset);
    if (!content) {
      el.classList.add('hidden');
      shownKey = '';
      return;
    }
    if (host.dataset.tipSub) content.footer = content.footer ? `${content.footer}\n${host.dataset.tipSub}` : host.dataset.tipSub;
    el.replaceChildren(...render(content));
    el.classList.remove('hidden');
    shownKey = sig;
  }
  place();
}

/** Call once at startup. */
export function initTooltips() {
  ensure();
  window.addEventListener('mousemove', (e) => {
    mx = e.clientX;
    my = e.clientY;
    refresh();
  });
  window.addEventListener('mousedown', () => {
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
