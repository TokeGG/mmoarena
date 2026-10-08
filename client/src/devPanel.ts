import { ABILITIES, applyPatches, mergePatches, skillInfo } from '@arena/shared';
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
  /** Numbers kept for this session (the server puts them into every match the dev starts). */
  private session: DataPatch[] = [];
  private ask = '';
  private asking = false;

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
    } else if (m.t === 'dev_session') this.session = m.patches;
    else if (m.t === 'dev_result') {
      this.result = { ok: m.ok, text: m.text, url: m.url };
      this.asking = false;
    }
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
    const info = skillInfo(this.pick);
    for (const sec of info.sections) {
      const box = el('div', `devp-sec ${sec.kind}`);
      const head = el('div', 'devp-sec-head');
      head.append(el('b', '', sec.kind === 'aura' ? `✦ ${sec.name}` : sec.name), el('small', 'devp-dim', ` ${sec.link}`));
      box.append(head);
      if (sec.from.length) box.append(el('div', 'devp-from', `From: ${sec.from.join(' · ')}`));
      if (sec.does.length) box.append(el('div', 'devp-does', sec.does.join(' · ')));
      const list = el('div', 'devp-fields');
      for (const t of sec.fields) {
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
      if (!sec.fields.length) list.append(el('small', 'devp-dim', 'No numbers to tune.'));
      box.append(list);
      r.append(box);
    }
    if (info.modifiers.length) {
      const box = el('div', 'devp-sec mods');
      box.append(el('b', '', 'Also changed by'));
      const ul = el('ul', 'devp-mods');
      for (const m of info.modifiers) {
        const li = el('li');
        li.append(el('b', '', m.name), el('small', 'devp-dim', ` (${m.where})`), el('div', '', m.text));
        ul.append(li);
      }
      box.append(ul);
      r.append(box);
    }

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
    const keep = el('button', 'mm-small mm-go', 'Keep for my session');
    keep.title = 'Every match you start (not ranked) uses these numbers until you clear them or sign out, so you can keep testing across matches';
    keep.addEventListener('click', () => {
      const all = mergePatches(mergePatches(this.session, this.layers.roomPatches), [...this.edits.values()]);
      if (!all.length) {
        this.result = { ok: false, text: 'Change a number first.' };
        return this.paint();
      }
      this.hooks.send({ t: 'dev_session', patches: all });
    });
    acts.append(tryIt, keep, reset, save);
    r.append(acts);
    if (this.session.length) {
      const srow = el('div', 'devp-row');
      srow.append(el('small', 'devp-dim', `🔁 ${this.session.length} number${this.session.length === 1 ? '' : 's'} kept for your session`));
      const clear = el('button', 'mm-small', 'Clear session');
      clear.addEventListener('click', () => this.hooks.send({ t: 'dev_session', patches: [] }));
      srow.append(clear);
      r.append(srow);
    }

    // ask Claude: plain words in, number changes out, tried in this match at once
    const askBox = el('textarea', 'devp-note devp-ask');
    askBox.placeholder = `🤖 Ask Claude to change ${ABILITIES[this.pick].name} (e.g. "hit 20% harder but cost more", "slow lasts 2s less")`;
    askBox.maxLength = 600;
    askBox.value = this.ask;
    askBox.addEventListener('input', () => (this.ask = askBox.value));
    const askGo = el('button', 'mm-small mm-go', this.asking ? 'Claude is thinking…' : '🤖 Ask Claude');
    askGo.disabled = this.asking;
    askGo.addEventListener('click', () => {
      if (!this.ask.trim()) return;
      this.asking = true;
      this.result = null;
      this.hooks.send({ t: 'dev_ai', ability: this.pick, text: this.ask.trim() });
      this.paint();
    });
    r.append(askBox, askGo);

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
