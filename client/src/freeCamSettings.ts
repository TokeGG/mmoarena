import { speedSetting } from './freeCam';

/** Esc-menu settings of the free camera, saved as arena.* keys (so they follow the account). */
export const SPEED_KEY = 'arena.freecam.speed';
export const REMEMBER_KEY = 'arena.freecam.remember';
/** Whether free cam was on when the match ended (only kept while "remember" is on). */
export const ON_KEY = 'arena.freecam.on';

const get = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const set = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
};

export const freeCamPrefs = {
  speed: (): number => speedSetting(get(SPEED_KEY)),
  remember: (): boolean => get(REMEMBER_KEY) === '1',
  /** Was it on last time (and should it come back)? */
  wasOn: (): boolean => freeCamPrefs.remember() && get(ON_KEY) === '1',
  saveOn: (on: boolean): void => set(ON_KEY, freeCamPrefs.remember() && on ? '1' : null),
};

/** Wire the two rows of the settings block (call once at start-up). */
export function bindFreeCamSettings(): void {
  const speed = document.getElementById('fc-speed') as HTMLInputElement | null;
  const speedVal = document.getElementById('fc-speed-val');
  const rem = document.getElementById('fc-remember') as HTMLInputElement | null;
  const remVal = document.getElementById('fc-remember-val');
  if (speed) {
    speed.value = String(freeCamPrefs.speed());
    const show = () => speedVal && (speedVal.textContent = `${Number(speed.value).toFixed(1)}×`);
    speed.addEventListener('input', () => {
      set(SPEED_KEY, speed.value);
      show();
    });
    show();
  }
  if (rem) {
    rem.checked = freeCamPrefs.remember();
    const show = () => remVal && (remVal.textContent = rem.checked ? 'On' : 'Off');
    rem.addEventListener('change', () => {
      set(REMEMBER_KEY, rem.checked ? '1' : '0');
      if (!rem.checked) set(ON_KEY, null);
      show();
    });
    show();
  }
}
