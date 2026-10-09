/**
 * Light mode: the phone-friendly picture. A lower pixel ratio, no bloom or multisampling, smaller shadow maps and fewer
 * particles. On by itself for touch and small screens (see `lightModeDefault`), with a setting to turn it on or off.
 * The choice is kept per device (not synced with the account: a phone and a desktop want different answers).
 */
import { lightModeDefault, pixelRatioFor } from './touch';

export const LIGHT_KEY = 'device.lightmode';

export const isCoarse = (): boolean => {
  try {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
};

/** A finger is the main way to point here (no hover): the controls and tooltips adapt. */
export const isTouch = isCoarse;

function saved(): string | null {
  try {
    return localStorage.getItem(LIGHT_KEY);
  } catch {
    return null;
  }
}

export function detectLight(): boolean {
  if (typeof navigator === 'undefined' || typeof screen === 'undefined') return false;
  const nav = navigator as Navigator & { deviceMemory?: number };
  return lightModeDefault({ coarse: isCoarse(), screenMin: Math.min(screen.width || 0, screen.height || 0), memoryGb: nav.deviceMemory, saved: saved() });
}

class LightMode {
  on = detectLight();
  private subs: (() => void)[] = [];
  /** The saved choice: 'auto' when the person never set one. */
  get choice(): 'auto' | 'on' | 'off' {
    const s = saved();
    return s === '1' ? 'on' : s === '0' ? 'off' : 'auto';
  }
  set(choice: 'auto' | 'on' | 'off') {
    try {
      if (choice === 'auto') localStorage.removeItem(LIGHT_KEY);
      else localStorage.setItem(LIGHT_KEY, choice === 'on' ? '1' : '0');
    } catch {
      /* not remembered */
    }
    this.on = detectLight();
    if (typeof document !== 'undefined') document.documentElement.classList.toggle('light', this.on);
    for (const f of this.subs) f();
  }
  pixelRatio(): number {
    return pixelRatioFor(typeof window === 'undefined' ? 1 : window.devicePixelRatio, this.on);
  }
  onChange(f: () => void) {
    this.subs.push(f);
  }
}

export const lightMode = new LightMode();
if (typeof document !== 'undefined') {
  document.documentElement.classList.toggle('light', lightMode.on);
  document.documentElement.classList.toggle('touch', isCoarse());
}

/** A phone or a narrow window: side panels start closed and the bars are made for thumbs. */
export const compactScreen = (): boolean => {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(max-width:900px), (pointer:coarse)').matches;
  } catch {
    return false;
  }
};
