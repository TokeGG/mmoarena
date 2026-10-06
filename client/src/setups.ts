/**
 * Named setup profiles: a snapshot of everything the player has customised (keybinds, HUD layout, sensitivity, name,
 * class and builds, practice options). Profiles live in localStorage and can be exported as a text code to carry to
 * another browser or device. Match progress travels too, but a snapshot never lowers existing progress.
 */

const STORE = 'arena.setups.v1';
const PREFIX = 'arena.';
const CODE_TAG = 'ARENA1.';
const MAX_CODE = 40000;
const PROGRESS_KEY = 'arena.profile.v1';

type Snapshot = Record<string, string>;
interface Store {
  active: string | null;
  list: Record<string, Snapshot>;
}

const read = (): Store => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Store | null;
    if (raw && typeof raw.list === 'object' && raw.list) return { active: raw.active ?? null, list: raw.list };
  } catch {
    /* ignore */
  }
  return { active: null, list: {} };
};
const write = (s: Store) => {
  try {
    localStorage.setItem(STORE, JSON.stringify(s));
  } catch {
    /* ignore */
  }
};

/** Everything customisable that lives in localStorage right now (not the profile list itself). */
export function snapshotLive(): Snapshot {
  const out: Snapshot = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX) && k !== STORE) out[k] = localStorage.getItem(k) ?? '';
    }
  } catch {
    /* ignore */
  }
  return out;
}

const matchesOf = (raw: string | undefined) => {
  try {
    return Number((JSON.parse(raw ?? '{}') as { matches?: number }).matches) || 0;
  } catch {
    return 0;
  }
};

function applySnapshot(snap: Snapshot) {
  const keepProgress = localStorage.getItem(PROGRESS_KEY);
  for (const k of Object.keys(snapshotLive())) localStorage.removeItem(k);
  for (const [k, v] of Object.entries(snap)) localStorage.setItem(k, v);
  // never go backwards on match progress
  if (keepProgress && matchesOf(keepProgress) > matchesOf(snap[PROGRESS_KEY])) localStorage.setItem(PROGRESS_KEY, keepProgress);
}

export const setups = {
  names(): string[] {
    return Object.keys(read().list).sort();
  },
  active(): string | null {
    return read().active;
  },
  /** Save the live settings under `name` and make it the active profile. */
  save(name: string) {
    const s = read();
    s.list[name] = snapshotLive();
    s.active = name;
    write(s);
  },
  /** Refresh the active profile from the live settings (called automatically). */
  autosave() {
    const s = read();
    if (s.active && s.list[s.active]) {
      s.list[s.active] = snapshotLive();
      write(s);
    }
  },
  /** Apply a profile to the live settings. The caller reloads the page so every system re-reads them. */
  load(name: string): boolean {
    const s = read();
    const snap = s.list[name];
    if (!snap) return false;
    applySnapshot(snap);
    s.active = name;
    write(s);
    return true;
  },
  remove(name: string) {
    const s = read();
    delete s.list[name];
    if (s.active === name) s.active = null;
    write(s);
  },
  exportCode(name?: string): string {
    const s = read();
    const snap = name && s.list[name] ? s.list[name] : snapshotLive();
    return CODE_TAG + btoa(unescape(encodeURIComponent(JSON.stringify(snap))));
  },
  /** Parse and validate a pasted code. Returns the snapshot or an error string. */
  parseCode(code: string): Snapshot | string {
    const text = code.trim();
    if (!text.startsWith(CODE_TAG)) return 'That is not an Arena profile code.';
    if (text.length > MAX_CODE) return 'That code is too large.';
    try {
      const obj = JSON.parse(decodeURIComponent(escape(atob(text.slice(CODE_TAG.length))))) as Record<string, unknown>;
      const snap: Snapshot = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && k.startsWith(PREFIX) && k !== STORE && k.length < 80 && v.length < 8000) snap[k] = v;
      }
      if (!Object.keys(snap).length) return 'That code has no settings in it.';
      return snap;
    } catch {
      return 'That code is damaged.';
    }
  },
  /** Store an imported snapshot as a named profile (not applied yet). */
  importAs(name: string, snap: Snapshot) {
    const s = read();
    s.list[name] = snap;
    write(s);
  },
};

// ---------------------------------------------------------------- UI

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** A compact profile switcher for the main menu. Switching reloads the page so keybinds, HUD and builds all re-read. */
export function buildProfileBar(): HTMLElement {
  const root = el('div', 'mm-profiles');
  const label = el('span', 'pl', 'Profile');
  const select = el('select');
  const msg = el('span', 'pmsg');
  const mkBtn = (t: string, tip: string, fn: () => void) => {
    const b = el('button', 'mm-small', t);
    b.title = tip;
    b.addEventListener('click', fn);
    return b;
  };

  const refresh = () => {
    const names = setups.names();
    const active = setups.active();
    select.replaceChildren(new Option(names.length ? '(unsaved settings)' : '(none yet)', ''));
    for (const n of names) select.append(new Option(n, n));
    select.value = active && names.includes(active) ? active : '';
  };
  const say = (t: string) => {
    msg.textContent = t;
    window.setTimeout(() => {
      if (msg.textContent === t) msg.textContent = '';
    }, 3500);
  };
  const askName = (dflt: string) => {
    const n = (window.prompt('Profile name:', dflt) ?? '').trim().slice(0, 24);
    return n || null;
  };

  select.addEventListener('change', () => {
    if (!select.value) return;
    setups.autosave();
    if (setups.load(select.value)) location.reload();
  });

  const save = mkBtn('Save', 'Save your current keybinds, HUD, builds and options to this profile (or create one)', () => {
    const active = setups.active();
    const name = active ?? askName('Main');
    if (!name) return;
    setups.save(name);
    refresh();
    say(`Saved "${name}"`);
  });
  const saveAs = mkBtn('Save as…', 'Save the current settings as a new profile', () => {
    const name = askName('');
    if (!name) return;
    setups.save(name);
    refresh();
    say(`Saved "${name}"`);
  });
  const del = mkBtn('Delete', 'Delete the selected profile', () => {
    const n = select.value;
    if (!n || !window.confirm(`Delete profile "${n}"?`)) return;
    setups.remove(n);
    refresh();
    say(`Deleted "${n}"`);
  });

  // export / import share one small modal with a text box
  const share = mkBtn('Export / Import', 'Copy a code to move your setup to another browser or device, or paste one here', () => {
    const modal = el('div', 'mm-modal');
    const card = el('div', 'mm-modal-card');
    const head = el('div', 'mm-modal-head');
    const close = el('button', 'mm-small', 'Close');
    close.addEventListener('click', () => modal.remove());
    head.append(el('h2', '', 'Profile code'), close);
    const box = el('textarea', 'mm-code');
    box.value = setups.exportCode(select.value || undefined);
    box.readOnly = false;
    box.spellcheck = false;
    const note = el('div', 'mm-modal-foot', 'This code is your current setup (keybinds, HUD layout, builds, options and match progress). Copy it to back it up or move it. To import, paste a code over this text and press Import.');
    const row = el('div', 'mm-row');
    const copy = el('button', 'mm-btn', 'Copy');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(box.value);
        note.textContent = 'Copied to clipboard.';
      } catch {
        box.select();
        note.textContent = 'Press Ctrl+C to copy the selected code.';
      }
    });
    const imp = el('button', 'mm-btn primary', 'Import');
    imp.addEventListener('click', () => {
      const parsed = setups.parseCode(box.value);
      if (typeof parsed === 'string') {
        note.textContent = parsed;
        return;
      }
      const name = askName('Imported');
      if (!name) return;
      setups.importAs(name, parsed);
      setups.load(name);
      location.reload();
    });
    row.append(copy, imp);
    card.append(head, box, row, note);
    modal.append(card);
    modal.addEventListener('mousedown', (e) => {
      if (e.target === modal) modal.remove();
    });
    document.body.append(modal);
    box.focus();
    box.select();
  });

  root.append(label, select, save, saveAs, del, share, msg);
  refresh();
  // keep the active profile current without any clicks
  window.addEventListener('pagehide', () => setups.autosave());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) setups.autosave();
  });
  return root;
}
