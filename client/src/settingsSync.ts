/**
 * Settings that follow the signed-in account: keybinds, HUD layout and style, sensitivity, class, builds and the
 * practice options. They live in localStorage as `arena.*` keys; this module snapshots them, uploads changes to the
 * server while signed in, and applies the server's copy after login (the page reloads once so every system re-reads it).
 */
import { MAX_SETTINGS } from '@arena/shared';

/** Never synced: credentials, per-browser guest progress, the signed-in name, and the one-off login prompt flag. */
const EXCLUDE = new Set(['arena.session.v1', 'arena.profile.v1', 'arena.setups.v1', 'arena.seenLogin.v1', 'arena.name']);
const RELOAD_FLAG = 'arena.syncReload';

export type Snapshot = Record<string, string>;

export function snapshotSettings(): Snapshot {
  const out: Snapshot = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('arena.') && k !== RELOAD_FLAG && !EXCLUDE.has(k)) out[k] = localStorage.getItem(k) ?? '';
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** Stable text form (sorted keys) so two snapshots compare equal when their contents do. */
export function serialize(s: Snapshot): string {
  return JSON.stringify(Object.fromEntries(Object.entries(s).sort(([a], [b]) => (a < b ? -1 : 1))));
}

/** Parse the server's copy; keeps only well-formed, syncable keys. Null if it is not usable. */
export function parseSettings(raw: string): Snapshot | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const out: Snapshot = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && k.startsWith('arena.') && k.length < 80 && v.length < 8000 && !EXCLUDE.has(k) && k !== RELOAD_FLAG) out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

/** Replace the syncable keys in localStorage with `snap`. */
export function applySettings(snap: Snapshot): void {
  try {
    for (const k of Object.keys(snapshotSettings())) localStorage.removeItem(k);
    for (const [k, v] of Object.entries(snap)) localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

export type SyncResult = 'same' | 'uploaded' | 'reload';

export class SettingsSync {
  private active = false;
  private lastSent = '';
  private timer = 0;

  constructor(private send: (data: string) => void, private reload: () => void = () => location.reload()) {
    window.addEventListener('pagehide', () => this.flush());
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && this.flush());
  }

  /** The server's saved settings arrived (empty string when the account has none yet). */
  onServer(data: string): SyncResult {
    const now = serialize(snapshotSettings());
    const theirs = parseSettings(data);
    this.active = true;
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.flush(), 3000);
    if (!theirs) {
      this.upload(now);
      return 'uploaded';
    }
    if (serialize(theirs) === now) {
      this.lastSent = now;
      return 'same';
    }
    // Apply the account's copy once. If we reloaded a moment ago and still differ (a system rewrote a key on
    // startup), keep what this browser has instead of looping.
    let recent = false;
    try {
      recent = Date.now() - Number(sessionStorage.getItem(RELOAD_FLAG) ?? 0) < 60000;
      sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
    } catch {
      /* ignore */
    }
    if (recent) {
      this.upload(now);
      return 'uploaded';
    }
    applySettings(theirs);
    this.lastSent = serialize(theirs);
    this.reload();
    return 'reload';
  }

  /** Stop syncing (signed out). Local settings are kept as they are. */
  stop() {
    this.active = false;
    window.clearInterval(this.timer);
  }

  flush() {
    if (!this.active) return;
    const now = serialize(snapshotSettings());
    if (now !== this.lastSent) this.upload(now);
  }

  private upload(now: string) {
    if (now.length > MAX_SETTINGS) return;
    this.lastSent = now;
    this.send(now);
  }
}
