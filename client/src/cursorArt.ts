/**
 * Mouse cursor art, drawn in code as inline SVG (no image files). Every cursor is designed on a 32 x 32 grid and scaled
 * by the Size setting; the same markup is used as the native CSS cursor (a data: URI) and, for the animated styles, as the
 * element of the overlay that follows the mouse. Pure functions only (no DOM), so they are tested without a browser.
 */

/** What the pointer is over / doing: the default gauntlet draws a different cursor for each. */
export type CursorContext = 'default' | 'enemy' | 'ally' | 'self' | 'aim' | 'aimBlocked' | 'busy';
export const CURSOR_CONTEXTS: CursorContext[] = ['default', 'enemy', 'ally', 'self', 'aim', 'aimBlocked', 'busy'];
/** The art states: the game contexts plus `link`, the pointing hand over buttons and links. */
export type ArtState = CursorContext | 'link';
export const ART_STATES: ArtState[] = [...CURSOR_CONTEXTS, 'link'];

/** Largest side of a cursor image the browsers accept. */
export const MAX_CURSOR_PX = 128;
export const GRID = 32;

export interface CursorArt {
  svg: string;
  /** Pixel size of the image (1x). */
  w: number;
  h: number;
  /** Hotspot in pixels, inside the image. */
  hx: number;
  hy: number;
}

export interface ArtOptions {
  /** Size multiplier (0.75 .. 2). */
  size?: number;
  /** Glow colour behind the art (class tint, or red / green over enemies and allies); null for none. */
  glow?: string | null;
  /** Image density: 2 makes a 2x variant (twice the pixels, same hotspot in CSS pixels). */
  density?: 1 | 2;
  /** Prefix for the element ids, when the SVG is placed inline in a page (several inline copies would otherwise share ids). */
  ids?: string;
}

export const AIM_OK = '#6dff8a';
export const AIM_BLOCKED = '#ff4b3e';
export const ENEMY_GLOW = '#ff4b3e';
export const ALLY_GLOW = '#4dff7a';
export const GOLD = '#f2c14e';

const OUT = '#15110d';
/** The dark outline every shape gets (width in grid units). */
const stk = (w = 1.6) => `stroke="${OUT}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;

/** Gradients shared by every cursor. */
const DEFS = `<linearGradient id="st" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".42" stop-color="#c3ccda"/><stop offset="1" stop-color="#6b778c"/></linearGradient>` +
  `<linearGradient id="gd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff0b0"/><stop offset=".5" stop-color="#f2b933"/><stop offset="1" stop-color="#9a6513"/></linearGradient>` +
  `<linearGradient id="rd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb4a6"/><stop offset=".45" stop-color="#e5352b"/><stop offset="1" stop-color="#7a0e12"/></linearGradient>` +
  `<linearGradient id="gr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d4ffd0"/><stop offset=".45" stop-color="#35d65f"/><stop offset="1" stop-color="#0f7432"/></linearGradient>` +
  `<linearGradient id="wd" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7a4a26"/><stop offset=".5" stop-color="#b57a43"/><stop offset="1" stop-color="#5a3318"/></linearGradient>`;

const r1 = (n: number) => Math.round(n * 10) / 10;

// ------------------------------------------------------------------------------------------------ the gauntlet

const ARROW = 'M4 3 L4 25.6 L9.3 20.7 L13.1 29 L17.4 27.1 L13.6 18.9 L20.8 18.7 Z';

function gauntletDefault(): string {
  return (
    `<clipPath id="ac"><path d="${ARROW}"/></clipPath>` +
    `<path d="${ARROW}" fill="url(#st)" ${stk(2.4)}/>` +
    `<path d="${ARROW}" fill="none" stroke="url(#gd)" stroke-width="2.3" clip-path="url(#ac)"/>` +
    // light ridge along the leading edge and plate seams across the finger
    `<path d="M6.4 8.5 L6.4 21.4" stroke="#fff" stroke-width="1.1" stroke-linecap="round" opacity=".85"/>` +
    `<path d="M9.2 17.6 L16.3 17.4" stroke="#7d889c" stroke-width=".9" stroke-linecap="round"/>` +
    // gold cuff band on the wrist and a rivet
    `<path d="M11.4 25.6 L15.8 23.7" stroke="${OUT}" stroke-width="3.4" stroke-linecap="butt" clip-path="url(#ac)"/>` +
    `<path d="M11.4 25.6 L15.8 23.7" stroke="url(#gd)" stroke-width="2.2" stroke-linecap="butt" clip-path="url(#ac)"/>` +
    `<circle cx="7.4" cy="12.3" r=".9" fill="${GOLD}" stroke="${OUT}" stroke-width=".5"/>`
  );
}

function gauntletHand(): string {
  const plate = (d: string) => `<path d="${d}" fill="url(#st)" ${stk()}/>`;
  return (
    // thumb, back of the hand, three curled finger plates, then the pointing finger on top
    plate('M4.6 15.6 Q4.2 13.6 6.2 13.8 L10.4 18.4 L10.4 23.2 L6.8 20 Z') +
    plate('M10.2 17.6 L27.6 17.6 L27.6 24.2 Q27.6 25.6 26 25.6 L11.8 25.6 Q10.2 25.6 10.2 24.2 Z') +
    plate('M15.4 13.4 Q15.4 11.2 17.6 11.2 Q19.8 11.2 19.8 13.4 L19.8 18.4 L15.4 18.4 Z') +
    plate('M19.8 14 Q19.8 12 21.9 12 Q24 12 24 14 L24 18.4 L19.8 18.4 Z') +
    plate('M24 15.4 Q24 13.6 25.9 13.6 Q27.8 13.6 27.8 15.4 L27.8 18.4 L24 18.4 Z') +
    plate('M10.2 4.6 Q10.2 2.4 12.6 2.4 Q15 2.4 15 4.6 L15 18.6 L10.2 18.6 Z') +
    `<path d="M10.5 9.6 L14.7 9.6 M10.5 14 L14.7 14 M15.6 15.4 L19.6 15.4 M20 15.8 L23.8 15.8" stroke="#6e7a90" stroke-width=".9" stroke-linecap="round"/>` +
    `<path d="M11.6 4.8 L11.6 17" stroke="#fff" stroke-width="1" stroke-linecap="round" opacity=".85"/>` +
    // gold cuff
    `<rect x="9.4" y="24.4" width="19" height="4.6" rx="1.4" fill="url(#gd)" ${stk()}/>` +
    `<path d="M10.8 26.7 L27 26.7" stroke="#fff3c0" stroke-width=".7" opacity=".8"/>`
  );
}

function swordArt(): string {
  // a red blade, gold guard; drawn pointing down from its tip, then turned so the tip is the hotspot at the top left
  return (
    `<g transform="translate(4.2 4.2) rotate(-45) scale(1.08)">` +
    `<path d="M0 0 L2.5 4 L2.5 17.5 L-2.5 17.5 L-2.5 4 Z" fill="url(#rd)" ${stk()}/>` +
    `<path d="M0 3 L0 16.5" stroke="#ffd9d2" stroke-width="1" stroke-linecap="round" opacity=".85"/>` +
    `<rect x="-6.4" y="17.2" width="12.8" height="2.8" rx="1.2" fill="url(#gd)" ${stk()}/>` +
    `<rect x="-1.5" y="20" width="3" height="5.2" fill="#4a2a18" ${stk()}/>` +
    `<circle cx="0" cy="26.4" r="2.2" fill="url(#gd)" ${stk()}/>` +
    `</g>`
  );
}

function crossArt(): string {
  const d = 'M12.4 4.5 H19.6 V12.4 H27.5 V19.6 H19.6 V27.5 H12.4 V19.6 H4.5 V12.4 H12.4 Z';
  return (
    `<path d="${d}" fill="url(#gr)" ${stk(2.2)}/>` +
    `<path d="M14.2 6.6 H17.8 M6.6 14.2 H11" stroke="#fff" stroke-width="1.2" stroke-linecap="round" opacity=".85"/>` +
    `<path d="M16 9.2 V22.8 M9.2 16 H22.8" stroke="#0c5a27" stroke-width=".8" stroke-linecap="round" opacity=".35"/>`
  );
}

function shieldArt(): string {
  const d = 'M16 3.6 L26.2 7.6 V16 C26.2 22 21.4 26.6 16 28.6 C10.6 26.6 5.8 22 5.8 16 V7.6 Z';
  return (
    `<path d="${d}" fill="url(#gd)" ${stk(2.2)}/>` +
    `<path d="M16 7 L23 9.8 V16 C23 20.4 19.8 23.8 16 25.4 C12.2 23.8 9 20.4 9 16 V9.8 Z" fill="url(#st)" stroke="${OUT}" stroke-width=".9"/>` +
    `<path d="M16 10.4 V21 M11.4 15.4 H20.6" stroke="${GOLD}" stroke-width="2" stroke-linecap="round"/>`
  );
}

/** Aiming a ground spell: a crosshair in the colour of the ring on the ground; with a slash when the spell cannot land there. */
function crosshairArt(blocked: boolean): string {
  const c = blocked ? AIM_BLOCKED : AIM_OK;
  const lines = 'M16 2.8 V10.4 M16 21.6 V29.2 M2.8 16 H10.4 M21.6 16 H29.2';
  return (
    `<g fill="none" stroke-linecap="round">` +
    `<g stroke="${OUT}" stroke-width="4.6"><circle cx="16" cy="16" r="7.4"/><path d="${lines}"/>${blocked ? '<path d="M10.8 10.8 L21.2 21.2"/>' : ''}</g>` +
    `<g stroke="${c}" stroke-width="2.3"><circle cx="16" cy="16" r="7.4"/><path d="${lines}"/>${blocked ? '<path d="M10.8 10.8 L21.2 21.2" stroke-width="2.6"/>' : ''}</g>` +
    `</g>` +
    (blocked ? '' : `<circle cx="16" cy="16" r="1.7" fill="${c}" stroke="${OUT}" stroke-width=".8"/>`)
  );
}

function busyArt(): string {
  return (
    `<g opacity=".72">${gauntletDefault()}</g>` +
    `<path d="M19.6 20.4 H29.2 L24.4 25.6 L29.2 30.8 H19.6 L24.4 25.6 Z" fill="#e9dcc0" ${stk()}/>` +
    `<path d="M21.6 29.4 H27.2 L24.4 26.6 Z" fill="${GOLD}"/>`
  );
}

// ------------------------------------------------------------------------------------------------ the other styles

function wandArt(): string {
  return (
    `<g transform="translate(8.4 8.4) rotate(-45)">` +
    `<rect x="-1.5" y="1.5" width="3" height="22.6" rx="1.2" fill="url(#wd)" ${stk()}/>` +
    `<rect x="-2.1" y="9.6" width="4.2" height="1.8" rx=".6" fill="url(#gd)" ${stk(1)}/>` +
    `<rect x="-2.1" y="21.4" width="4.2" height="2.2" rx=".6" fill="url(#gd)" ${stk(1)}/>` +
    `<path d="M-1.9 1.4 L0 -0.4 L1.9 1.4 Z" fill="url(#gd)" ${stk(1)}/>` +
    `<radialGradient id="orb"><stop offset="0" stop-color="#fff"/><stop offset=".4" stop-color="#9fefff"/><stop offset="1" stop-color="#2a6cff"/></radialGradient>` +
    `<circle cx="0" cy="-2.6" r="4.4" fill="#5fc9ff" opacity=".28"/>` +
    `<circle cx="0" cy="-2.6" r="3.2" fill="url(#orb)" ${stk(1.1)}/>` +
    `</g>` +
    `<path d="M11.4 2.2 L12.4 4.2 L11.4 6.2 L10.4 4.2 Z M3 12 L3.8 13.6 L3 15.2 L2.2 13.6 Z" fill="#fff" opacity=".9"/>`
  );
}

function daggerArt(): string {
  return (
    `<g transform="translate(4.4 4.4) rotate(-45) scale(1.06)">` +
    `<path d="M0 0 L2 3.6 L2 15.4 L-2 15.4 L-2 3.6 Z" fill="url(#st)" ${stk()}/>` +
    `<path d="M0 3.4 L0 14.6" stroke="#8795ad" stroke-width=".8"/>` +
    // glowing rune on the blade
    `<path d="M-0.9 6 L0.9 7.2 L-0.9 8.6 L0.9 10 M0 5.2 L0 11.2" stroke="#39e8ff" stroke-width=".8" stroke-linecap="round" fill="none"/>` +
    `<rect x="-5" y="15.2" width="10" height="2.4" rx="1.1" fill="url(#gd)" ${stk()}/>` +
    `<rect x="-1.4" y="17.6" width="2.8" height="5.2" fill="#2b2230" ${stk()}/>` +
    `<path d="M-1.4 19 L1.4 19.8 M-1.4 20.8 L1.4 21.6" stroke="#6b5a78" stroke-width=".7"/>` +
    `<circle cx="0" cy="24.2" r="1.9" fill="#39e8ff" ${stk(1)}/>` +
    `</g>`
  );
}

/** Pixel arrow: a 16 x 16 grid at 2 units a pixel, drawn as merged runs so the edges stay crisp. */
const PIXEL_ROWS = [
  '#..........',
  '##.........',
  '#o#........',
  '#oo#.......',
  '#ooo#......',
  '#oooo#.....',
  '#ooooo#....',
  '#oooooo#...',
  '#ooooooo#..',
  '#oooooooo#.',
  '#ooooo#####',
  '#oo#oo#....',
  '#o#.#oo#...',
  '##..#oo#...',
  '#....#oo#..',
  '.....####..',
];
function pixelArt(): string {
  let o = '<g shape-rendering="crispEdges">';
  PIXEL_ROWS.forEach((row, y) => {
    for (const [ch, col] of [['#', '#101018'], ['o', '#ffffff']] as const) {
      const re = new RegExp(`${ch}+`, 'g');
      for (let m = re.exec(row); m; m = re.exec(row)) o += `<rect x="${m.index * 2}" y="${y * 2}" width="${m[0].length * 2}" height="2" fill="${col}"/>`;
    }
  });
  // a shaded edge on the lower right of the white fill
  o += `<rect x="8" y="18" width="2" height="2" fill="#aab4c8"/><rect x="10" y="20" width="2" height="2" fill="#aab4c8"/><rect x="8" y="24" width="2" height="2" fill="#aab4c8"/>`;
  return o + '</g>';
}

function ringArt(tint: string | null): string {
  const c = tint ?? '#ffffff';
  return (
    `<circle cx="16" cy="16" r="8" fill="none" stroke="${OUT}" stroke-width="5" opacity=".92"/>` +
    `<circle cx="16" cy="16" r="8" fill="none" stroke="${c}" stroke-width="2.4"/>` +
    `<circle cx="16" cy="16" r="2.6" fill="${OUT}"/><circle cx="16" cy="16" r="1.4" fill="${c}"/>`
  );
}

function emberArt(): string {
  return (
    `<radialGradient id="ef" cx=".5" cy=".7" r=".75"><stop offset="0" stop-color="#fff6c0"/><stop offset=".35" stop-color="#ffc233"/><stop offset=".75" stop-color="#ff5a1a"/><stop offset="1" stop-color="#b21a0a"/></radialGradient>` +
    `<g class="ac-flame" transform-origin="19 25">` +
    `<g transform="rotate(-24 19 24)">` +
    `<path d="M19 3.4 C21.6 8.6 27 12 27 19 C27 24.8 23.4 28.6 19 28.6 C14.6 28.6 11 24.8 11 19 C11 15.4 13 13 14.6 11 C15 13.6 16.2 14.6 17.2 14.4 C16.4 10.6 17 6.4 19 3.4 Z" fill="url(#ef)" ${stk()}/>` +
    `<path d="M19 15 C21 18 23 19.6 23 22.6 C23 25.2 21.2 26.8 19 26.8 C16.8 26.8 15.2 25.2 15.2 22.6 C15.2 20 17.6 18.6 19 15 Z" fill="#fff0a0" opacity=".9"/>` +
    `</g></g>` +
    `<circle class="ac-sp1" cx="7.4" cy="13.2" r="1.3" fill="#ffd23a"/><circle class="ac-sp2" cx="24.4" cy="5.4" r="1.1" fill="#ff9a2a"/><circle class="ac-sp3" cx="5" cy="21.4" r=".9" fill="#ffe27a"/>`
  );
}

function frostArt(): string {
  return (
    `<path d="M4.2 4.2 L11.6 8.4 L21.6 8.6 L27.8 18.2 L20.4 27.8 L12.2 21.4 L8.6 11.8 Z" fill="#c9f0ff" ${stk(2)}/>` +
    `<path d="M4.2 4.2 L11.6 8.4 L8.6 11.8 Z" fill="#f4fdff"/>` +
    `<path d="M11.6 8.4 L21.6 8.6 L16 17 Z" fill="#9adcff"/>` +
    `<path d="M21.6 8.6 L27.8 18.2 L16 17 Z" fill="#5db6f5"/>` +
    `<path d="M27.8 18.2 L20.4 27.8 L16 17 Z" fill="#2f86d8"/>` +
    `<path d="M20.4 27.8 L12.2 21.4 L16 17 Z" fill="#4aa3ea"/>` +
    `<path d="M12.2 21.4 L8.6 11.8 L16 17 Z" fill="#7cc8fa"/>` +
    `<path d="M8.6 11.8 L11.6 8.4 L16 17 Z" fill="#e1f7ff"/>` +
    `<path d="M4.2 4.2 L11.6 8.4 L21.6 8.6 L27.8 18.2 L20.4 27.8 L12.2 21.4 L8.6 11.8 Z M11.6 8.4 L16 17 L27.8 18.2 M16 17 L20.4 27.8 M16 17 L12.2 21.4 M16 17 L8.6 11.8" fill="none" stroke="#173b66" stroke-width=".7" stroke-linejoin="round" opacity=".7"/>` +
    `<path d="M19.4 4 L20.2 5.8 L22 6.6 L20.2 7.4 L19.4 9.2 L18.6 7.4 L16.8 6.6 L18.6 5.8 Z" fill="#fff" class="ac-twk"/>`
  );
}

function voidEyeArt(): string {
  return (
    `<radialGradient id="vi" cx=".5" cy=".5" r=".6"><stop offset="0" stop-color="#f2d4ff"/><stop offset=".4" stop-color="#b266ff"/><stop offset="1" stop-color="#4a1590"/></radialGradient>` +
    `<linearGradient id="vl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7a3fd1"/><stop offset="1" stop-color="#2a0f55"/></linearGradient>` +
    `<path d="M1.6 16 Q16 3.4 30.4 16 Q16 28.6 1.6 16 Z" fill="url(#vl)" stroke="#12062a" stroke-width="2.2" stroke-linejoin="round"/>` +
    `<path d="M3.8 16 Q16 6.2 28.2 16 Q16 25.8 3.8 16 Z" fill="#0f0620" opacity=".55"/>` +
    `<clipPath id="ve"><path d="M3.8 16 Q16 6 28.2 16 Q16 26 3.8 16 Z"/></clipPath>` +
    `<g clip-path="url(#ve)"><g class="ac-pupil"><circle cx="16" cy="16" r="6.6" fill="url(#vi)" stroke="#1a0838" stroke-width="1"/>` +
    `<ellipse cx="16" cy="16" rx="2" ry="4.6" fill="#08020f"/><circle cx="14.2" cy="13.6" r="1.3" fill="#fff" opacity=".9"/></g></g>` +
    `<path d="M1.6 16 Q16 3.4 30.4 16" fill="none" stroke="#c28bff" stroke-width=".8" opacity=".8"/>`
  );
}

function crownArt(): string {
  const d = 'M4.4 24.6 L3.6 9.4 L10.8 15.8 L16 5.4 L21.2 15.8 L28.4 9.4 L27.6 24.6 Z';
  return (
    `<path d="${d}" fill="url(#gd)" ${stk(2)}/>` +
    `<rect x="4" y="23" width="24" height="5" rx="1.6" fill="url(#gd)" ${stk(2)}/>` +
    `<path d="M6.4 11.6 L10.4 17.6 M25.6 11.6 L21.6 17.6" stroke="#fff3c0" stroke-width=".9" stroke-linecap="round" opacity=".8"/>` +
    `<circle cx="16" cy="7.6" r="2.3" fill="#ff3b58" ${stk(1)}/>` +
    `<circle cx="3.9" cy="9.6" r="1.7" fill="#4ea3ff" ${stk(.9)}/><circle cx="28.1" cy="9.6" r="1.7" fill="#4ea3ff" ${stk(.9)}/>` +
    `<circle cx="10.6" cy="25.5" r="1.1" fill="#ff3b58"/><circle cx="16" cy="25.5" r="1.1" fill="#7dffb0"/><circle cx="21.4" cy="25.5" r="1.1" fill="#ff3b58"/>`
  );
}

/** Dragon claw: open, or (when `closed`) the talons curled in; the live cursor swaps the two on click. */
function clawArt(): string {
  const finger = (d: string) => `<path d="${d}" fill="none" stroke="${OUT}" stroke-width="7.2" stroke-linecap="round"/><path d="${d}" fill="none" stroke="#d3382d" stroke-width="4.6" stroke-linecap="round"/>`;
  const shine = (d: string) => `<path d="${d}" fill="none" stroke="#ff9d8c" stroke-width="1" stroke-linecap="round" opacity=".8"/>`;
  const talon = (d: string) => `<path d="${d}" fill="#f6ecd2" ${stk(1.3)}/>`;
  const open =
    finger('M11.4 23 Q8 20 7.8 15') + finger('M16 23 L16 13.4') + finger('M20.6 23 Q24 20 24.2 15') +
    shine('M7 17 L7.2 15.6') +
    talon('M5.8 15.4 Q4.4 10 3.2 4.6 Q9 7.6 10 14.4 Z') + talon('M13.9 12.6 Q13.5 7.2 16 2.2 Q18.5 7.2 18.1 12.6 Z') + talon('M26.2 15.4 Q27.6 10 28.8 4.6 Q23 7.6 22 14.4 Z');
  const closed =
    finger('M11.4 23 Q8.2 18 12.4 14') + finger('M16 23 L16 15.4') + finger('M20.6 23 Q23.8 18 19.6 14') +
    talon('M10.4 15 Q11 9.6 15 6.4 Q15.8 11.4 13.6 15.6 Z') + talon('M21.6 15 Q21 9.6 17 6.4 Q16.2 11.4 18.4 15.6 Z') + talon('M14.2 15 Q14.2 10 16 5.4 Q17.8 10 17.8 15 Z');
  return (
    `<g class="cl-open">${open}</g><g class="cl-closed" style="display:none">${closed}</g>` +
    `<path d="M6.4 22.6 Q16 16.6 25.6 22.6 L24.4 28.4 Q16 31.4 7.6 28.4 Z" fill="#c62f26" ${stk(2)}/>` +
    `<path d="M10.6 22.4 Q12.4 21 14.2 22.4 Q16 21 17.8 22.4 Q19.6 21 21.4 22.4 M11.8 26 Q13.6 24.6 15.4 26 Q17.2 24.6 19 26 Q20.8 24.6 22.2 26" fill="none" stroke="#7a1410" stroke-width="1" stroke-linecap="round"/>` +
    `<path d="M8.4 25 Q8.8 23.4 10.4 22.8" fill="none" stroke="#ff9a8a" stroke-width="1" stroke-linecap="round" opacity=".8"/>` +
    `<path d="M7.2 27.6 Q16 30.6 24.8 27.6" fill="none" stroke="url(#gd)" stroke-width="2.4" stroke-linecap="round"/>`
  );
}

function starArt(): string {
  const cx = 20;
  const cy = 20;
  let p = '';
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? 4.4 : 9.4;
    p += `${i ? 'L' : 'M'}${r1(cx + Math.cos(a) * r)} ${r1(cy + Math.sin(a) * r)} `;
  }
  return (
    `<linearGradient id="tl" x1="1" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ffb02e"/><stop offset="1" stop-color="#ff7a1a" stop-opacity="0"/></linearGradient>` +
    `<radialGradient id="sg" cx=".5" cy=".5" r=".6"><stop offset="0" stop-color="#ffffff"/><stop offset=".5" stop-color="#ffd84a"/><stop offset="1" stop-color="#e08a14"/></radialGradient>` +
    `<path d="M17 17 L2.4 4.2 L4.2 2.4 Z" fill="url(#tl)" class="ac-tail"/>` +
    `<path d="M16.4 20.8 L3 9.2 L9.2 3 Z" fill="url(#tl)" opacity=".5" class="ac-tail"/>` +
    `<circle cx="8.6" cy="14" r=".9" fill="#ffb02e"/><circle cx="14.4" cy="8.4" r=".9" fill="#ffb02e"/>` +
    `<path d="${p}Z" fill="url(#sg)" ${stk(1.8)}/>` +
    `<circle cx="19" cy="18.6" r="1.5" fill="#fff" opacity=".9"/>`
  );
}

// ------------------------------------------------------------------------------------------------ assembling

type Draw = { body: string; hot: [number, number] };

function drawFor(style: string, state: ArtState, tint: string | null): Draw {
  if (state === 'aim') return { body: crosshairArt(false), hot: [16, 16] };
  if (state === 'aimBlocked') return { body: crosshairArt(true), hot: [16, 16] };
  if (style === 'gauntlet' || !STYLE_ART[style]) {
    switch (state) {
      case 'enemy':
        return { body: swordArt(), hot: [4.4, 4.4] };
      case 'ally':
        return { body: crossArt(), hot: [16, 16] };
      case 'self':
        return { body: shieldArt(), hot: [16, 16] };
      case 'busy':
        return { body: busyArt(), hot: [4, 3] };
      case 'link':
        return { body: gauntletHand(), hot: [12.6, 3] };
      default:
        return { body: gauntletDefault(), hot: [4, 3] };
    }
  }
  const a = STYLE_ART[style];
  const body = style === 'dot' ? ringArt(tint) : a.draw();
  return { body: state === 'busy' ? `<g opacity=".6">${body}</g>` : body, hot: a.hot };
}

const STYLE_ART: Record<string, { draw: () => string; hot: [number, number]; overlay?: boolean }> = {
  wand: { draw: wandArt, hot: [6.6, 6.6] },
  dagger: { draw: daggerArt, hot: [4.4, 4.4] },
  pixel: { draw: pixelArt, hot: [0, 0] },
  dot: { draw: () => '', hot: [16, 16] },
  ember: { draw: emberArt, hot: [11.6, 5], overlay: true },
  frost: { draw: frostArt, hot: [4.2, 4.2], overlay: true },
  claw: { draw: clawArt, hot: [16, 3.4], overlay: true },
  void: { draw: voidEyeArt, hot: [16, 16], overlay: true },
  crown: { draw: crownArt, hot: [16, 16] },
  star: { draw: starArt, hot: [20, 20], overlay: true },
};

/** Styles that animate and so are drawn by the overlay that follows the mouse (when motion is allowed). */
export const OVERLAY_STYLES = Object.keys(STYLE_ART).filter((k) => STYLE_ART[k].overlay);
export const isOverlayStyle = (style: string): boolean => OVERLAY_STYLES.includes(style);
export const ART_STYLES = ['gauntlet', ...Object.keys(STYLE_ART)];

/** The glow colour for a state: red over enemies, green over allies, gold on a link, else the tint (class colour). */
export function glowFor(style: string, state: ArtState, tint: string | null): string | null {
  if (state === 'aim' || state === 'aimBlocked' || state === 'busy') return null;
  if (state === 'enemy') return ENEMY_GLOW;
  if (state === 'ally') return ALLY_GLOW;
  if (style === 'gauntlet' && state === 'link') return tint ?? GOLD;
  return tint;
}

/** One cursor image: the SVG text, its pixel size and hotspot. The hotspot is always inside the image. */
export function cursorArt(style: string, state: ArtState, o: ArtOptions = {}): CursorArt {
  const size = Math.min(2, Math.max(0.75, o.size ?? 1));
  const dens = o.density === 2 ? 2 : 1;
  const w = Math.min(MAX_CURSOR_PX, Math.round(GRID * size * dens));
  const css = Math.round(w / dens);
  const d = drawFor(style, state, o.glow ?? null);
  const hx = Math.min(css - 1, Math.max(0, Math.round((d.hot[0] / GRID) * css)));
  const hy = Math.min(css - 1, Math.max(0, Math.round((d.hot[1] / GRID) * css)));
  const glow = o.glow && state !== 'aim' && state !== 'aimBlocked' ? o.glow : null;
  const faint = state === 'default' || state === 'busy' ? 0.85 : 1;
  const inner = glow
    ? `<defs>${DEFS}<g id="a">${d.body}</g><filter id="gl" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur in="SourceAlpha" stdDeviation="1.9" result="b"/><feFlood flood-color="${glow}"/><feComposite in2="b" operator="in"/></filter></defs>` +
      `<use xlink:href="#a" filter="url(#gl)" opacity="${faint}"/><use xlink:href="#a"/>`
    : `<defs>${DEFS}</defs>${d.body}`;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${w}" viewBox="0 0 ${GRID} ${GRID}">${inner}</svg>`;
  if (o.ids) svg = svg.replace(/ id="([\w-]+)"/g, ` id="${o.ids}$1"`).replace(/url\(#([\w-]+)\)/g, `url(#${o.ids}$1)`).replace(/xlink:href="#([\w-]+)"/g, `xlink:href="#${o.ids}$1"`);
  return { svg, w, h: w, hx, hy };
}
