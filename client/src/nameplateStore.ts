/**
 * Saving the three nameplate profiles. Each profile is one `arena.plates.<kind>.v1` key (JSON, well under the sync size
 * limit), so they follow the account like the other `arena.*` settings. Until a profile has been saved, it is worked out
 * from the old single-profile look options (`arena.hud.look.v1`), which stay readable and are never rewritten here.
 */
import { PLATE_KINDS, cloneProfile, compactProfile, defaultProfile, migrateOldLook, sanitizeProfile, type PlateKind, type PlateProfile } from './nameplateLayout';

export const PLATE_KEY = (k: PlateKind) => `arena.plates.${k}.v1`;
export const PLATE_UI_KEY = 'arena.plates.ui.v1';
const OLD_LOOK_KEY = 'arena.hud.look.v1';

/** Editor preferences (snapping, zoom), saved with the profiles. */
export interface PlateEditorPrefs {
  snap: boolean;
  zoom: number; // 0 = fit the window
  guides: boolean;
}
export const DEFAULT_PREFS: PlateEditorPrefs = { snap: true, zoom: 0, guides: true };

let profiles: Record<PlateKind, PlateProfile> | null = null;
let prefs: PlateEditorPrefs | null = null;
let version = 1;
const listeners = new Set<() => void>();

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

/** Read all three from storage (saved ones as saved, the rest migrated from the old look). */
export function loadPlates(): Record<PlateKind, PlateProfile> {
  const migrated = migrateOldLook(read(OLD_LOOK_KEY));
  const out = {} as Record<PlateKind, PlateProfile>;
  for (const k of PLATE_KINDS) {
    const saved = read(PLATE_KEY(k));
    out[k] = saved === undefined ? migrated[k] : sanitizeProfile(saved, defaultProfile());
  }
  profiles = out;
  version++;
  return out;
}

/** The profile in use for a kind (loaded on first use). Treat it as read-only; change it through `setPlate`. */
export function plateProfile(k: PlateKind): PlateProfile {
  if (!profiles) loadPlates();
  return profiles![k];
}

/** Bumps whenever any profile changes, so a view can tell its cached layout is stale. */
export const plateVersion = (): number => version;

export function onPlatesChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Use and save a profile (validated first). */
export function setPlate(k: PlateKind, p: PlateProfile): PlateProfile {
  if (!profiles) loadPlates();
  const clean = sanitizeProfile(p, defaultProfile());
  profiles![k] = clean;
  version++;
  try {
    localStorage.setItem(PLATE_KEY(k), JSON.stringify(compactProfile(clean)));
  } catch {
    /* ignore */
  }
  for (const cb of listeners) cb();
  return clean;
}

/** Back to the classic look for a kind (saved, so it stays that way). */
export function resetPlate(k: PlateKind): PlateProfile {
  return setPlate(k, defaultProfile());
}

export function copyPlate(from: PlateKind, to: PlateKind): PlateProfile {
  return setPlate(to, cloneProfile(plateProfile(from)));
}

export function loadPrefs(): PlateEditorPrefs {
  if (prefs) return prefs;
  const raw = read(PLATE_UI_KEY);
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<PlateEditorPrefs>;
  prefs = {
    snap: typeof o.snap === 'boolean' ? o.snap : DEFAULT_PREFS.snap,
    zoom: typeof o.zoom === 'number' && o.zoom >= 0 && o.zoom <= 4 ? o.zoom : DEFAULT_PREFS.zoom,
    guides: typeof o.guides === 'boolean' ? o.guides : DEFAULT_PREFS.guides,
  };
  return prefs;
}

export function savePrefs(p: PlateEditorPrefs): void {
  prefs = { ...p };
  try {
    localStorage.setItem(PLATE_UI_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}
