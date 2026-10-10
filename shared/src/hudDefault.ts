import { clamp } from './geometry';

/**
 * HUD layouts: what the client's editor saves, and the owner's default layout for everyone. Pure, so the client, the
 * server and the tests all use the same bounds. A layout is `{ [element id]: slot }` where the slot is the element's
 * offset from its built-in spot as a fraction of the screen, plus a scale and optionally a size.
 */

/** One element's saved place: the offset as a fraction of the screen (so a layout made on a big screen fits a small one). */
export interface HudSlot {
  fx: number;
  fy: number;
  s: number;
  w?: number;
  h?: number;
  /** Text size multiplier for boxes of text. */
  t?: number;
}
export type HudLayoutMap = Record<string, HudSlot>;

/** Every element the editor can move. The client adds friendly names and selectors (client/src/hudLayout.ts). */
export const HUD_IDS: readonly string[] = [
  'self-frame', 'target-frame', 'party', 'enemies', 'actionbar', 'trinketbar', 'cast', 'autoind', 'log', 'killfeed', 'dpsmeter', 'recap', 'help', 'err', 'ccstate', 'netstats', 'mute-btn', 'devbtn',
  'banner', 'damp', 'announce', 'update-notice', 'endchoice', 'spec-bar', 'spec-top', 'spec-nav', 'spec-replay', 'scoreboard', 'builds', 'follow-box', 'takeover-chip', 'fr-toasts', 'fr-invites',
];

/** Boxes of text: their text grows with the box. Value: the text size in px at 1x. */
export const HUD_TEXT_BOX: Record<string, number> = { log: 11, killfeed: 12, dpsmeter: 12, netstats: 11 };
export const HUD_TEXT_MIN = 0.6;
export const HUD_TEXT_MAX = 3;
export const HUD_SCALE_MIN = 0.6;
export const HUD_SCALE_MAX = 1.6;

/** The most text a stored default layout may take (every element fits many times over). */
export const HUD_DEFAULT_MAX_CHARS = 8000;

/**
 * The saved layout from what localStorage, the account or the server holds: only known elements, scale / size /
 * position clamped, anything malformed dropped. `width` / `height` (the window) are only used to read an older pixel
 * layout; pass 0 to refuse those.
 */
export function parseHudLayout(rawIn: unknown, ids: readonly string[], width: number, height: number): HudLayoutMap {
  const out: HudLayoutMap = {};
  if (!rawIn || typeof rawIn !== 'object' || Array.isArray(rawIn)) return out;
  const raw = rawIn as Record<string, Record<string, unknown> | null>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  for (const id of ids) {
    if (!Object.prototype.hasOwnProperty.call(raw, id)) continue;
    const r = raw[id];
    if (!r || typeof r !== 'object' || !num(r.s)) continue;
    const sc = clamp(r.s, HUD_SCALE_MIN, HUD_SCALE_MAX);
    const size = { ...(num(r.w) ? { w: clamp(r.w, 40, 2000) } : {}), ...(num(r.h) ? { h: clamp(r.h, 16, 1400) } : {}), ...(num(r.t) && id in HUD_TEXT_BOX ? { t: clamp(r.t, HUD_TEXT_MIN, HUD_TEXT_MAX) } : {}) };
    if (num(r.fx) && num(r.fy)) out[id] = { fx: clamp(r.fx, -1, 1), fy: clamp(r.fy, -1, 1), s: sc, ...size };
    else if (width > 0 && height > 0 && num(r.dx) && num(r.dy)) out[id] = { fx: r.dx / width, fy: r.dy / height, s: sc }; // an older pixel layout
  }
  return out;
}

/** The owner's default as the server stores and sends it: validated, or null when there is nothing usable (so "no default"). */
export function parseHudDefault(raw: unknown): HudLayoutMap | null {
  const l = parseHudLayout(raw, HUD_IDS, 0, 0);
  return Object.keys(l).length ? l : null;
}

/** A layout as it is stored: key order fixed. Null if it is empty or too big to keep. */
export function packHudDefault(l: HudLayoutMap): string | null {
  if (!Object.keys(l).length) return null;
  const s = JSON.stringify(Object.fromEntries(HUD_IDS.filter((id) => id in l).map((id) => [id, l[id]])));
  return s.length <= HUD_DEFAULT_MAX_CHARS ? s : null;
}

/**
 * Which layer decides where an element sits: the player's own position if they moved it, else the owner's default,
 * else the built-in spot (no slot). Elements the player never moved keep following the default when it changes.
 */
export function layerSlot(id: string, personal: HudLayoutMap, def: HudLayoutMap | null): { slot: HudSlot | null; from: 'personal' | 'default' | 'builtin' } {
  const p = personal[id];
  if (p) return { slot: p, from: 'personal' };
  const d = def?.[id];
  if (d) return { slot: d, from: 'default' };
  return { slot: null, from: 'builtin' };
}

/** The layout in force: personal over default (the built-in spot is "no entry"). */
export function layerLayout(personal: HudLayoutMap, def: HudLayoutMap | null): HudLayoutMap {
  return { ...(def ?? {}), ...personal };
}
