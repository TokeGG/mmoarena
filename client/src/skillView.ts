import { ABILITIES, UNIT_NAME, fieldOf, skillInfo, skillSlots, valueHint } from '@arena/shared';
import type { DataPatch, DevField, FieldGroup } from '@arena/shared';
import { iconEl } from './iconArt';
import { EditSet, patchKey, showValue } from './devEdits';

export { patchKey };

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** The row of skill icons to pick from (hover shows the skill's tooltip). */
export function skillPicker(ids: string[], pick: string, onPick: (id: string) => void): HTMLElement {
  const picker = el('div', 'devp-skills');
  for (const id of ids) {
    const b = el('button', `devp-skill${id === pick ? ' sel' : ''}`);
    b.append(iconEl('ability', id, '', true));
    b.dataset.tip = `ability:${id}`;
    b.addEventListener('click', () => onPick(id));
    picker.append(b);
  }
  return picker;
}

const STEP: Record<string, string> = { x: '0.05', chance: '0.01', ms: '50', yd: '0.5', percent: '1', count: '1', hp: '10', deg: '5', plain: 'any' };
/** What a number is measured in, in words, for the models, looks and sounds pages: yards of the world, degrees of turn, times the normal size. */
const MEASURE: Record<string, string> = { yd: 'yards', deg: 'degrees', x: '× normal' };
const nice = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * The number editor shared by the debug panel and the admin panel's Tuning tab: one row per value (what it is in plain words,
 * a box to type the new value, what it means in familiar terms, the file's value once changed and a reset), groups that
 * fold, and the skill view (its rules, its numbers, the buffs and debuffs tied to it, the talents and specs that change it).
 * What was typed lives in `set` (see EditSet); `testing` is what is being tried or proposed already (shown as changed).
 */
export class SkillEditor {
  readonly set = new EditSet();
  readonly key = patchKey;
  /** What is in effect already (the match's test numbers, the session's, or the proposals). */
  testing: () => Map<string, DataPatch> = () => new Map();
  /** In the Tuning tab numbers already proposed are not put back from here (a proposal is handled in its own list). */
  canRevert = true;
  /** Called after any change (the host updates its counters). */
  onEdit: () => void = () => undefined;
  /** Rows that do not match this text are hidden (lowercase; empty shows all). */
  filter = '';
  /** Which groups are folded open, kept by the host across redraws. */
  open = new Map<string, boolean>();

  get edits(): Map<string, DataPatch> {
    return this.set.edits;
  }

  private matches(f: DevField): boolean {
    return !this.filter || `${f.label} ${f.hint ?? ''} ${f.path.join(' ')}`.toLowerCase().includes(this.filter);
  }

  /** One value: its name, a box (tick box, list) for it, its meaning, the file's value once changed, and a reset. */
  fieldRow(f: DevField): HTMLElement {
    const testing = this.testing();
    const row = el('div', 'devp-field');
    const name = el('span', 'devp-flabel', f.label);
    const tip = [f.hint, f.unit !== 'plain' && f.kind === 'number' ? `Unit: ${UNIT_NAME[f.unit]}` : '', `File value: ${showValue(f, f.base)}`, f.added ? 'The data file does not have this yet: changing it adds it.' : ''].filter(Boolean);
    row.title = tip.join('\n');
    const meaning = el('small', 'devp-fhint');
    const was = el('small', 'devp-fbase');
    const undo = el('button', 'devp-undo', '↺');
    undo.title = 'Put back the value in the data file';
    undo.type = 'button';
    const shown = () => this.set.shown(f, testing);
    const sync = () => {
      const changed = this.set.changed(f, testing);
      row.classList.toggle('changed', changed);
      row.classList.toggle('pending', this.set.pending(f));
      undo.hidden = !changed;
      was.textContent = changed ? `file: ${showValue(f, f.base)}` : '';
      const range = f.min !== undefined && f.max !== undefined ? ` (${nice(f.min)} to ${nice(f.max)})` : '';
      meaning.textContent = f.kind === 'number' ? (f.unit === 'ms' ? 'seconds' : MEASURE[f.unit] && (f.file === 'models' || f.file === 'looks' || f.file === 'sounds') ? `${MEASURE[f.unit]}${range} · ${valueHint(f.unit, Number(shown())) || nice(Number(shown()))}` : valueHint(f.unit, Number(shown()))) : '';
    };
    let control: HTMLElement;
    let reread: () => void;
    if (f.kind === 'switch') {
      const cb = el('input');
      cb.type = 'checkbox';
      reread = () => (cb.checked = Number(shown()) === 1);
      cb.addEventListener('change', () => {
        this.set.set(f, cb.checked ? 1 : 0, testing, this.canRevert);
        sync();
        this.onEdit();
      });
      control = cb;
    } else if (f.kind === 'choice') {
      const sel = el('select', 'devp-sel');
      for (const v of f.options ?? []) {
        const o = el('option', '', f.optionLabels?.[v] ?? v.replace(/_/g, ' '));
        o.value = v;
        sel.append(o);
      }
      reread = () => (sel.value = String(shown()));
      sel.addEventListener('change', () => {
        this.set.set(f, sel.value, testing, this.canRevert);
        sync();
        this.onEdit();
      });
      control = sel;
    } else {
      const input = el('input');
      input.type = 'number';
      // times are typed in seconds (1.2 is 1.2 s) and stored in milliseconds
      const secs = f.unit === 'ms';
      input.step = secs ? '0.05' : f.file === 'models' && f.unit === 'yd' ? '0.05' : f.file === 'models' && f.unit === 'deg' ? '1' : STEP[f.unit] ?? 'any';
      input.title = secs ? 'Seconds (decimals allowed: 1.2)' : '';
      if (secs) input.classList.add('devp-secs');
      const unitK = secs ? 0.001 : 1;
      if (f.min !== undefined) input.min = String(f.min * unitK);
      if (f.max !== undefined) input.max = String(f.max * unitK);
      reread = () => (input.value = String(Math.round(Number(shown()) * (secs ? 0.001 : 1) * 10000) / 10000));
      input.addEventListener('input', () => {
        if (input.value.trim() === '') return;
        const typed = Number(input.value);
        if (!Number.isFinite(typed) || Math.abs(typed) > 1_000_000) return;
        let v = secs ? Math.round(typed * 1000) : typed;
        if (f.min !== undefined) v = Math.max(f.min, v);
        if (f.max !== undefined) v = Math.min(f.max, v);
        this.set.set(f, v, testing, this.canRevert);
        sync();
        this.onEdit();
      });
      control = input;
    }
    control.addEventListener('keydown', (e) => e.stopPropagation()); // typing here never casts spells
    undo.addEventListener('click', () => {
      this.set.set(f, f.base, testing, this.canRevert);
      reread();
      sync();
      this.onEdit();
    });
    reread();
    sync();
    if (f.kind === 'switch') row.classList.add('switch');
    row.append(name, control, meaning, was, undo);
    return row;
  }

  /** Rows for some fields (those matching the search). */
  fieldList(fields: DevField[]): HTMLElement {
    const list = el('div', 'devp-fields');
    for (const f of fields.filter((x) => this.matches(x))) list.append(this.fieldRow(f));
    return list;
  }

  /** A fold-out group of rows with its name, a note, how many are changed, and a reset for the group. */
  group(g: FieldGroup, scope: string): HTMLElement | null {
    const fields = g.fields.filter((f) => this.matches(f));
    if (!fields.length) return null;
    const key = `${scope}:${g.id}`;
    const box = el('details', 'devp-sec');
    const testing = this.testing();
    const changed = fields.filter((f) => this.set.changed(f, testing)).length;
    // a group with a changed value is never folded away
    box.open = this.filter ? true : this.open.get(key) ?? (changed > 0 || (g.open ?? true));
    box.addEventListener('toggle', () => {
      if (!this.filter) this.open.set(key, box.open);
    });
    const sum = el('summary', 'devp-sec-head');
    sum.append(el('b', '', g.title), el('small', 'devp-dim', ` ${g.sub ? `${g.sub} · ` : ''}${fields.length} value${fields.length === 1 ? '' : 's'}`));
    if (changed) sum.append(el('span', 'devp-badge', `${changed} changed`));
    box.append(sum, this.fieldList(fields));
    return box;
  }

  /** The chips, sections (with options and numbers) and "also changed by" for one skill. */
  skillBody(abilityId: string): HTMLElement {
    const r = el('div');
    const info = skillInfo(abilityId);
    // how the skill behaves, as chips (hover for what each means)
    const chips = el('div', 'devp-chips');
    for (const f of info.flags) {
      const c = el('span', `devp-chip ${f.tone}`, f.label);
      c.title = f.tip;
      chips.append(c);
    }
    r.append(chips);
    for (const sec of info.sections) {
      const box = el('div', `devp-sec ${sec.kind === 'aura' ? 'effect' : sec.kind}`);
      const head = el('div', 'devp-sec-head');
      head.append(el('b', '', sec.kind === 'aura' ? `✦ ${sec.name}` : sec.name), el('small', 'devp-dim', ` ${sec.link}`));
      box.append(head);
      if (sec.from.length) box.append(el('div', 'devp-from', `From: ${sec.from.join(' · ')}`));
      if (sec.does.length) box.append(el('div', 'devp-does', sec.does.join(' · ')));
      const fields: DevField[] = [];
      if (sec.options) {
        for (const c of sec.options.choices) {
          const f = fieldOf({ file: 'abilities', id: sec.id, path: [c.key], label: c.label, value: 0 });
          fields.push(f);
        }
        for (const o of sec.options.flags) fields.push(fieldOf({ file: 'abilities', id: sec.id, path: [o.key], label: o.label, value: o.value }));
      }
      const nums = sec.fields.map((t) => fieldOf(t));
      if (fields.length) {
        const opts = el('details', 'devp-sec devp-optbox');
        const key = `skill-options:${sec.kind}:${sec.id}`;
        opts.open = this.filter ? true : this.open.get(key) ?? true;
        opts.addEventListener('toggle', () => {
          if (!this.filter) this.open.set(key, opts.open);
        });
        opts.append(el('summary', 'devp-sec-head', 'Options (target, school and switches)'), this.fieldList(fields));
        if (opts.querySelector('.devp-field')) box.append(opts);
      }
      const list = this.fieldList(nums);
      if (!nums.length) list.append(el('small', 'devp-dim', 'No numbers to tune.'));
      box.append(list);
      if (this.filter && !box.querySelector('.devp-field') && sec.kind !== 'ability') continue;
      r.append(box);
    }
    if (info.modifiers.length) {
      const box = el('div', 'devp-sec mods');
      box.append(el('b', '', 'Also changed by'));
      const ul = el('ul', 'devp-mods');
      for (const m of info.modifiers) {
        const li = el('li');
        li.append(el('b', '', m.name), el('small', 'devp-dim', ` (${m.where})`), el('div', 'devp-does', m.text));
        const have = skillSlots(m.source.file, m.source.id, abilityId);
        const existing = new Set(m.fields.map((t) => patchKey(t)));
        const fields = [...m.fields.map((t) => fieldOf(t)), ...have.filter((f) => !f.added && !existing.has(patchKey(f)))];
        if (fields.length) li.append(this.fieldList(fields));
        const spare = have.filter((f) => f.added);
        if (spare.length) {
          const more = el('details', 'devp-sec');
          more.append(el('summary', 'devp-dim', `Add a change to ${ABILITIES[abilityId].name} from ${m.name}`), this.fieldList(spare));
          li.append(more);
        }
        ul.append(li);
      }
      box.append(ul);
      r.append(box);
    }
    return r;
  }
}
