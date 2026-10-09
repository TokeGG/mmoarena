import { ABILITIES, CLASSES, SPECS, TALENTS, skillInfo, tunableNumbers } from '@arena/shared';
import type { ClassId, DataPatch, TunableNumber } from '@arena/shared';
import { ABILITY_ICON } from './icons';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export const patchKey = (p: Pick<DataPatch, 'file' | 'id' | 'path'>) => `${p.file}:${p.id}:${p.path.join('.')}`;

/** The row of skill icons to pick from (hover shows the skill's tooltip). */
export function skillPicker(ids: string[], pick: string, onPick: (id: string) => void): HTMLElement {
  const picker = el('div', 'devp-skills');
  for (const id of ids) {
    const b = el('button', `devp-skill${id === pick ? ' sel' : ''}`, ABILITY_ICON[id] ?? '✦');
    b.dataset.tip = `ability:${id}`;
    b.addEventListener('click', () => onPick(id));
    picker.append(b);
  }
  return picker;
}

type Options = NonNullable<ReturnType<typeof skillInfo>['sections'][number]['options']>;

/**
 * The skill info view and number editor shared by the debug panel and the admin panel's Tuning tab: a skill's rules,
 * its numbers, the buffs and debuffs tied to it, the talents/specs that change it, and a box per number to edit.
 * `edits` holds what was typed (key -> patch); `testing` is what is being tried or proposed already (shown as changed).
 */
export class SkillEditor {
  readonly edits = new Map<string, DataPatch>();
  readonly key = patchKey;

  /** Chips, sections (with options and numbers) and "also changed by" for one skill. */
  skillBody(abilityId: string, testing: Map<string, DataPatch>): HTMLElement {
    const r = el('div');
    r.append(el('div', 'devp-title', ABILITIES[abilityId].name));
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
      if (sec.options) box.append(this.optionsBox(sec.id, sec.options, testing));
      const list = this.fieldList(sec.fields, testing);
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
        if (m.fields.length) li.append(this.fieldList(m.fields, testing));
        ul.append(li);
      }
      box.append(ul);
      r.append(box);
    }
    return r;
  }

  /** A skill's yes/no options (global cooldown, facing, works while stunned...) as tick boxes and its target and school as lists. */
  optionsBox(abilityId: string, o: Options, testing: Map<string, DataPatch>): HTMLElement {
    const box = el('div', 'devp-options');
    for (const f of o.flags) {
      const path = [f.key];
      const k = this.key({ file: 'abilities', id: abilityId, path });
      const changed = () => testing.has(k) || this.edits.has(k);
      const row = el('label', `devp-opt${changed() ? ' changed' : ''}`);
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = Number(this.edits.get(k)?.value ?? testing.get(k)?.value ?? f.value) === 1;
      cb.addEventListener('change', () => {
        this.edits.set(k, { file: 'abilities', id: abilityId, path, value: cb.checked ? 1 : 0 });
        row.classList.add('changed');
      });
      row.append(cb, el('span', '', f.label));
      box.append(row);
    }
    for (const c of o.choices) {
      const path = [c.key];
      const k = this.key({ file: 'abilities', id: abilityId, path });
      const row = el('label', `devp-opt${testing.has(k) || this.edits.has(k) ? ' changed' : ''}`);
      const sel = el('select', 'devp-sel');
      for (const v of c.options) {
        const op = el('option', '', v.replace(/_/g, ' '));
        op.value = v;
        sel.append(op);
      }
      sel.value = String(this.edits.get(k)?.value ?? testing.get(k)?.value ?? c.value);
      sel.addEventListener('change', () => {
        this.edits.set(k, { file: 'abilities', id: abilityId, path, value: sel.value });
        row.classList.add('changed');
      });
      row.append(el('span', '', c.label), sel);
      box.append(row);
    }
    return box;
  }

  /** One row per number: its name and a box to type the new value in (green once changed). */
  fieldList(fields: TunableNumber[], testing: Map<string, DataPatch>): HTMLElement {
    const list = el('div', 'devp-fields');
    for (const t of fields) {
      const k = this.key(t);
      const f = el('label', `devp-field${testing.has(k) || this.edits.has(k) ? ' changed' : ''}`);
      const input = el('input');
      input.type = 'number';
      input.step = 'any';
      input.value = String(this.edits.get(k)?.value ?? testing.get(k)?.value ?? t.value);
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (!Number.isFinite(v)) return;
        this.edits.set(k, { file: t.file, id: t.id, path: t.path, value: v });
        f.classList.add('changed');
      });
      f.append(el('span', '', t.label), input);
      list.append(f);
    }
    return list;
  }

  /** Every number of a class (health, resource, auto-attack), of each of its specs (bonuses, weapon swing) and of every talent. */
  classSections(cls: ClassId, testing: Map<string, DataPatch>): HTMLElement {
    const wrap = el('div');
    const clean = (fields: TunableNumber[], strip: string[]) => fields.map((f) => ({ ...f, label: f.path.filter((k) => !strip.includes(String(k))).join(' · ') }));
    const section = (title: string, sub: string, fields: TunableNumber[], open = false) => {
      const box = el('details', 'devp-sec');
      box.open = open;
      const sum = el('summary', 'devp-sec-head');
      sum.append(el('b', '', title), el('small', 'devp-dim', ` ${sub} · ${fields.length} numbers`));
      box.append(sum, fields.length ? this.fieldList(fields, testing) : el('small', 'devp-dim', 'No numbers to tune.'));
      return box;
    };
    wrap.append(section(`${CLASSES[cls].name}`, 'class: health, resource, auto-attack', clean(tunableNumbers('classes', cls), []), true));
    for (const sp of SPECS[cls]) {
      wrap.append(section(sp.name, 'spec: bonuses and weapon', clean(tunableNumbers('specs', sp.id), ['mods']), true));
    }
    // talents: the shared tiers once, the spec tiers under their spec
    const seen = new Set<string>();
    TALENTS[cls][SPECS[cls][0].id].forEach((tier, ti) => {
      for (const t of tier) {
        const id = t.id;
        if (seen.has(id)) continue;
        seen.add(id);
        wrap.append(section(`${['I', 'II', 'III', 'IV', 'V'][ti]} · ${t.name}`, 'talent', clean(tunableNumbers('talents', id), ['mods', 'ability'])));
      }
    });
    for (const sp of SPECS[cls]) {
      (TALENTS[cls][sp.id] ?? []).forEach((tier, ti) => {
        for (const t of tier) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          wrap.append(section(`${sp.name} · ${['I', 'II', 'III', 'IV', 'V'][ti]} · ${t.name}`, 'talent', clean(tunableNumbers('talents', t.id), ['mods', 'ability'])));
        }
      });
    }
    return wrap;
  }
}
