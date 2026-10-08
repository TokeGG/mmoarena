/**
 * Style of the two HUD text elements that tell you why something did not happen (the error text: "Out of range", "No line
 * of sight", "Not enough mana"...) and what is holding you (the stun / control text: "STUNNED 2.1s"). Pure logic: the
 * options themselves live in hudLook.ts (saved, synced and reset with the other look options) and are passed in here.
 */

export const TEXT_COLORS: Record<string, string> = { red: '#ff4a3a', orange: '#ff9a3c', yellow: '#ffe23a', white: '#ffffff', cyan: '#4fe0ff', magenta: '#ff5fe0' };
/** Auto for the error text: the same warm red for every kind of error (it reads as "no" on any floor). */
export const ERROR_AUTO = '#ff5b3a';
export const ERROR_SIZES: Record<string, number> = { sm: 14, md: 17, lg: 20, xl: 30 };
export const CONTROL_SIZES: Record<string, number> = { sm: 20, md: 25, lg: 30, xl: 40 };
/** Text-shadow stacks for the outline / shadow strength. Eight offsets make a real outline; soft is a glow. */
export const OUTLINES: Record<string, string> = {
  off: 'none',
  soft: '0 1px 4px #000',
  strong: '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 -2px 0 #000, 0 2px 0 #000, -2px 0 0 #000, 2px 0 0 #000, 0 2px 6px #000',
};
export const ERROR_TIME_MIN = 0.8;
export const ERROR_TIME_MAX = 3;
export const ERROR_TIME_DEFAULT = 1.8;
/** The same error again within this long is the same message, not a new one. */
export const REPEAT_MS = 300;

export type ControlKind = 'stun' | 'fear' | 'sheep' | 'incapacitate' | 'lock';

/** The border / text colour a kind of control uses on its own ("auto by type"), matching the screen-edge glow. */
export const CONTROL_AUTO: Record<ControlKind, string> = { stun: '#ff5a4a', fear: '#c77dff', sheep: '#6fc3ff', incapacitate: '#6fc3ff', lock: '#ffd24a' };

/** How long the error stays up, in ms: the option's seconds, clamped to 0.8 - 3 s (bad values give the default). */
export function errorDurationMs(seconds: unknown): number {
  const n = typeof seconds === 'number' ? seconds : parseFloat(String(seconds));
  const s = Number.isFinite(n) ? n : ERROR_TIME_DEFAULT;
  return Math.round(Math.min(ERROR_TIME_MAX, Math.max(ERROR_TIME_MIN, s)) * 1000);
}

/** The colour of an error's text: a swatch, or (auto) the warm red every kind of error uses. */
export function errorColor(mode: string): string {
  return TEXT_COLORS[mode] ?? ERROR_AUTO;
}

/**
 * The colour of the control text: a swatch, or (auto) white on the coloured plate, and the colour of what holds you when
 * there is no plate to carry it. Empty = leave the stylesheet's own white.
 */
export function controlColor(mode: string, kind: ControlKind | '', plate = true): string {
  return TEXT_COLORS[mode] ?? (!plate && kind ? CONTROL_AUTO[kind] : '');
}

/** The CSS variables the stylesheet reads for the two texts, from the look options. */
export function textVars(o: Record<string, string>): Record<string, string> {
  const pill = o.errPlate === 'pill';
  return {
    '--err-size': `${ERROR_SIZES[o.errSize] ?? ERROR_SIZES.lg}px`,
    '--err-color': errorColor(o.errColor),
    '--err-weight': o.errBold === 'normal' ? '500' : '800',
    '--err-shadow': OUTLINES[o.errOutline] ?? OUTLINES.strong,
    '--err-bg': pill ? 'rgba(8,8,12,.72)' : 'transparent',
    '--err-pad': pill ? '4px 18px' : '0',
    '--cc-size': `${CONTROL_SIZES[o.ccSize] ?? CONTROL_SIZES.lg}px`,
    '--cc-weight': o.ccBold === 'normal' ? '500' : '800',
    '--cc-shadow': OUTLINES[o.ccOutline] ?? OUTLINES.soft,
  };
}

/** Says whether an error should be shown now: the same message again within REPEAT_MS of the last one shown is dropped. */
export class ErrorGate {
  private last = '';
  private at = -Infinity;
  constructor(private clock: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())) {}
  accept(message: string, suppress = true): boolean {
    const t = this.clock();
    if (suppress && message === this.last && t - this.at < REPEAT_MS) return false;
    this.last = message;
    this.at = t;
    return true;
  }
}
