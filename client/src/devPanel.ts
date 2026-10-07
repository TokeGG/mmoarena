import { ABILITIES, applyPatches, mergePatches, tunables } from '@arena/shared';
import type { ClientMsg, DataPatch, ServerMsg, UnitBuild } from '@arena/shared';
import { ABILITY_ICON } from './icons';
import { invalidateTip } from './tooltip';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/**
 * The numbers this client plays with: the data files, then the numbers a dev saved for everyone (from the server), then
 * the test numbers in the dev's own match. Each layer is put back before the layers are applied again.
 */
export class DataLayers {
  private live: DataPatch[] = [];
  private room: DataPatch[] = [];
  private undo: (() => void) | null = null;
  setLive(p: DataPatch[]) {
    this.live = p;
    this.apply();
  }
  setRoom(p: DataPatch[]) {
    this.room = p;
    this.apply();
  }
  get roomPatches(): DataPatch[] {
    return this.room;
  }
  private apply() {
    this.undo?.();
    const a = applyPatches(this.live);
    const b = applyPatches(this.room);
    this.undo = () => {
      b();
      a();
    };
    invalidateTip(); // open tooltips redraw with the new numbers
  }
}

interface Hooks {
  send(m: ClientMsg): void;
  /** Abilities to offer: everyone's bars in the match. */
  builds(): UnitBuild[];
  /** The dev's own bar, offered first. */
  myBar(): string[];
}

/**
 * Dev tools in a match: pause it, change any number on a skill (and on the effects it puts on people), try it at once,
 * then keep it for everyone or put it back; and send the owner a note about a skill. In any match that is not ranked:
 * everyone in it gets the same test numbers and is told, and the match stops counting.
 */
export class DevPanel {
  readonly root = el('div', 'devp hidden');
  readonly button = el('button', 'devp-btn hidden', '🛠 Dev');
  private paused = false;
  private pick = '';
  private edits = new Map<string, DataPatch>();
  private result: { ok: boolean; text: string; url?: string } | null = null;
  private note = '';

  constructor(private hooks: Hooks, readonly layers: DataLayers) {
    this.button.title = 'Dev tools (F2)';
    this.button.addEventListener('click', () => this.toggle());
    document.body.append(this.root, this.button);
  }

  get open(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** In a match as a dev: the button shows; out of it everything hides and the test numbers go. */
  setAvailable(on: boolean) {
    this.button.classList.toggle('hidden', !on);
    if (!on) {
      this.root.classList.add('hidden');
      this.paused = false;
      this.edits.clear();
      this.result = null;
      this.layers.setRoom([]);
    }
  }

  toggle(on = !this.open) {
    if (this.button.classList.contains('hidden')) return;
    this.root.classList.toggle('hidden', !on);
    if (on) {
      this.hooks.send({ t: 'dev_builds' });
      this.paint();
    }
  }

  handle(m: ServerMsg) {
    if (m.t === 'dev_state') {
      this.paused = m.paused;
      this.layers.setRoom(m.patches);
      this.edits.clear();
    } else if (m.t === 'dev_result') this.result = { ok: m.ok, text: m.text, url: m.url };
    if (this.open) this.paint();
  }

  /** Builds arrived: the skill list can offer everyone's bars. */
  refresh() {
    if (this.open) this.paint();
  }

  private key = (p: Pick<DataPatch, 'file' | 'id' | 'path'>) => `${p.file}:${p.id}:${p.path.join('.')}`;

  private paint() {
    const r = this.root;
    r.replaceChildren();
    const head = el('div', 'devp-head');
    head.append(el('b', '', '🛠 Dev tools'));
    const close = el('button', 'mm-small', '✕');
    close.addEventListener('click', () => this.toggle(false));
    head.append(close);
    r.append(head);

    const row = el('div', 'devp-row');
    const pause = el('button', `mm-small${this.paused ? ' mm-go' : ''}`, this.paused ? '▶ Resume' : '⏸ Pause');
    pause.addEventListener('click', () => this.hooks.send({ t: 'dev_pause', on: !this.paused }));
    row.append(pause, el('small', 'devp-dim', this.layers.roomPatches.length ? `${this.layers.roomPatches.length} test number${this.layers.roomPatches.length === 1 ? '' : 's'} in this match` : 'Real numbers'));
    r.append(row);

    // the skills in this match: yours first, then everyone else's
    const ids = [...new Set([...this.hooks.myBar(), ...this.hooks.builds().flatMap((b) => b.bar)])].filter((id) => ABILITIES[id]);
    if (!this.pick || !ids.includes(this.pick)) this.pick = ids[0] ?? '';
    const picker = el('div', 'devp-skills');
    for (const id of ids) {
      const b = el('button', `devp-skill${id === this.pick ? ' sel' : ''}`, ABILITY_ICON[id] ?? '✦');
      b.dataset.tip = `ability:${id}`;
      b.addEventListener('click', () => {
        this.pick = id;
        this.paint();
      });
      picker.append(b);
    }
    r.append(picker);
    if (!this.pick) return;
    r.append(el('div', 'devp-title', ABILITIES[this.pick].name));

    const testing = new Map(this.layers.roomPatches.map((p) => [this.key(p), p]));
    const list = el('div', 'devp-fields');
    for (const t of tunables(this.pick)) {
      const k = this.key(t);
      const f = el('label', `devp-field${testing.has(k) || this.edits.has(k) ? ' changed' : ''}`);
      const input = el('input');
      input.type = 'number';
      input.step = 'any';
      input.value = String(this.edits.get(k)?.value ?? t.value);
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (!Number.isFinite(v)) return;
        this.edits.set(k, { file: t.file, id: t.id, path: t.path, value: v });
        f.classList.add('changed');
      });
      f.append(el('span', '', t.label), input);
      list.append(f);
    }
    r.append(list);

    const acts = el('div', 'devp-row');
    const tryIt = el('button', 'mm-small mm-go', 'Try in this match');
    tryIt.addEventListener('click', () => this.hooks.send({ t: 'dev_patch', patches: mergePatches(this.layers.roomPatches, [...this.edits.values()]) }));
    const reset = el('button', 'mm-small', 'Put all back');
    reset.addEventListener('click', () => {
      this.edits.clear();
      this.hooks.send({ t: 'dev_patch', patches: [] });
    });
    const save = el('button', 'mm-small', 'Save for everyone…');
    save.addEventListener('click', () => {
      const all = mergePatches(this.layers.roomPatches, [...this.edits.values()]);
      if (!all.length) {
        this.result = { ok: false, text: 'Change a number and try it first.' };
        return this.paint();
      }
      if (!window.confirm(`Keep ${all.length} changed number${all.length === 1 ? '' : 's'} for everyone? They go live at once, and a pull request for the data files is opened.`)) return;
      this.hooks.send({ t: 'dev_save', patches: all, ...(this.note.trim() ? { note: this.note.trim() } : {}) });
    });
    acts.append(tryIt, reset, save);
    r.append(acts);

    const noteBox = el('textarea', 'devp-note');
    noteBox.placeholder = `A note on ${ABILITIES[this.pick].name} for the owner (sent to Discord)`;
    noteBox.maxLength = 600;
    noteBox.value = this.note;
    noteBox.addEventListener('input', () => (this.note = noteBox.value));
    const send = el('button', 'mm-small', 'Send note');
    send.addEventListener('click', () => {
      if (!this.note.trim()) return;
      this.hooks.send({ t: 'dev_note', ability: this.pick, text: this.note.trim() });
      this.note = '';
      noteBox.value = '';
    });
    r.append(noteBox, send);

    if (this.result) {
      const res = el('div', `devp-result ${this.result.ok ? 'ok' : 'bad'}`, this.result.text);
      if (this.result.url) {
        const a = el('a', '', ' Open the pull request');
        a.href = this.result.url;
        a.target = '_blank';
        a.rel = 'noopener';
        res.append(a);
      }
      r.append(res);
    }
  }
}
