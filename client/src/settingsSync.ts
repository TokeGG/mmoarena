/**
 * Settings that follow the signed-in account: keybinds, HUD layout and style, sensitivity, class, builds and the
 * practice options. They live in localStorage as `arena.*` keys; this module snapshots them, uploads changes to the
 * server while signed in, and merges the server's copy after login (the page reloads once so every system re-reads it).
 *
 * The merge is per setting, against the copy this browser last agreed on with the server for that account (the "base"):
 * a setting only changed here is kept, a setting only changed on another device is taken from the server, and a setting
 * changed in both places keeps this browser's value. So a device that synced once can never overwrite what was changed
 * elsewhere since, and two accounts on one browser each keep their own base.
 */
import { MAX_SETTINGS } from '@arena/shared';

/** Never synced: credentials, per-browser guest progress, the signed-in name, the one-off login prompt flag and the bases. */
const BASE_PREFIX = 'arena.syncBase';
const EXCLUDE = new Set(['arena.session.v1', 'arena.profile.v1', 'arena.seenLogin.v1', 'arena.name']);
const RELOAD_FLAG = 'arena.syncReload';
const excluded = (k: string) => EXCLUDE.has(k) || k === RELOAD_FLAG || k.startsWith(BASE_PREFIX);

export type Snapshot = Record<string, string>;

export function snapshotSettings(): Snapshot {
  const out: Snapshot = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('arena.') && !excluded(k)) out[k] = localStorage.getItem(k) ?? '';
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
export function parseSettings(raw: string | null): Snapshot | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const out: Snapshot = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && k.startsWith('arena.') && k.length < 80 && v.length < 8000 && !excluded(k)) out[k] = v;
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

/**
 * Three-way merge, one setting at a time. `base` is what this browser and the server last agreed on (null: never, for
 * this account), `local` what this browser has now, `theirs` what the server has now.
 */
export function mergeSettings(base: Snapshot | null, local: Snapshot, theirs: Snapshot): Snapshot {
  const out: Snapshot = {};
  for (const k of new Set([...Object.keys(local), ...Object.keys(theirs), ...Object.keys(base ?? {})])) {
    const b = base?.[k];
    const l = local[k];
    const t = theirs[k];
    let v: string | undefined;
    if (!base) v = t ?? l; // first time on this browser for this account: the account's copy, plus anything only kept here
    else if (l === b) v = t; // unchanged here: whatever the server has (changed or removed on another device)
    else v = l; // changed here (whether or not it also changed elsewhere): this browser's value
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const baseKey = (account: string) => `${BASE_PREFIX}.${account.toLowerCase()}`;
function readBase(account: string): Snapshot | null {
  try {
    return parseSettings(localStorage.getItem(baseKey(account)));
  } catch {
    return null;
  }
}
function writeBase(account: string, s: Snapshot) {
  try {
    localStorage.setItem(baseKey(account), serialize(s));
  } catch {
    /* ignore */
  }
}

export type SyncResult = 'same' | 'uploaded' | 'reload';

export class SettingsSync {
  private active = false;
  private account = '';
  private lastSent = '';
  private timer = 0;

  /** `send` returns false when the upload could not go out (no connection), so it is retried on the next flush. */
  constructor(private send: (data: string) => boolean | void, private reload: () => void = () => location.reload()) {
    window.addEventListener('pagehide', () => this.flush());
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && this.flush());
  }

  /** The server's saved settings for `account` arrived (empty string when the account has none yet). */
  onServer(data: string, account = 'default'): SyncResult {
    const local = snapshotSettings();
    const now = serialize(local);
    const theirs = parseSettings(data);
    this.active = true;
    this.account = account;
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.flush(), 3000);
    if (!theirs) {
      this.upload(local);
      return 'uploaded';
    }
    if (serialize(theirs) === now) {
      this.lastSent = now;
      writeBase(account, theirs);
      return 'same';
    }
    const merged = mergeSettings(readBase(account), local, theirs);
    const m = serialize(merged);
    if (m === now) {
      // nothing new from the server: this browser's edits go up
      this.upload(local);
      return 'uploaded';
    }
    // something changed on another device: take it in once (reloading so every system re-reads it). If we reloaded a
    // moment ago and still differ (a system rewrote a key on startup), keep what this browser has instead of looping.
    let recent = false;
    try {
      recent = Date.now() - Number(sessionStorage.getItem(RELOAD_FLAG) ?? 0) < 60000;
      sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
    } catch {
      /* ignore */
    }
    if (recent) {
      this.upload(local);
      return 'uploaded';
    }
    applySettings(merged);
    if (m !== serialize(theirs)) this.upload(merged); // our own edits ride along
    else {
      this.lastSent = m;
      writeBase(account, merged);
    }
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
    const snap = snapshotSettings();
    if (serialize(snap) !== this.lastSent) this.upload(snap);
  }

  private upload(snap: Snapshot) {
    const now = serialize(snap);
    if (now.length > MAX_SETTINGS) return;
    if (this.send(now) === false) return; // not sent: try again on the next flush
    this.lastSent = now;
    writeBase(this.account, snap); // the server now holds this: it is the new common ground
  }
}
