import { ABILITIES, ABILITY_TARGET_TYPES, AURAS, AURA_KIND_IDS, EFFECT_TYPES, SCHOOL_IDS, SPECS, TALENTS, effectSkeleton } from '@arena/shared';
import { el } from './skillView';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** "castTime" -> "Cast time". */
const nice = (k: string) => {
  const w = k.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim().toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/** Every field name used by the entries of a kind in the game (with an example value), so "add a field" offers what the game knows. */
function known(objs: unknown[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const o of objs) if (isObj(o)) for (const [k, v] of Object.entries(o)) if (!out.has(k)) out.set(k, v);
  return out;
}
const allEffects = () => Object.values(ABILITIES).flatMap((a) => a.effects as unknown[]);
const allTalents = () => Object.values(TALENTS).flatMap((bySpec) => (Object.values(bySpec) as unknown[][][]).flat(2)) as unknown[];

/** The fields offered for an object at a place in the entry. */
function suggestions(file: string, path: string[], o: Obj): Map<string, unknown> {
  const last = path[path.length - 1];
  if (last === undefined) {
    if (file === 'abilities') return known(Object.values(ABILITIES));
    if (file === 'auras') return known(Object.values(AURAS));
    if (file === 'talents') return known(allTalents());
    return known(Object.values(SPECS).flat());
  }
  if (typeof o.type === 'string' && /^\d+$/.test(last)) return known(allEffects().filter((e) => isObj(e) && e.type === o.type));
  if (last === 'mods') return known(allTalents().map((t) => (t as Obj).mods));
  return new Map();
}

const CHOICES: Record<string, () => [string, string][]> = {
  aura: () => Object.entries(AURAS).map(([id, a]) => [id, a.name]),
  ability: () => Object.entries(ABILITIES).map(([id, a]) => [id, a.name]),
  to: () => Object.entries(ABILITIES).map(([id, a]) => [id, a.name]),
  from: () => Object.entries(ABILITIES).map(([id, a]) => [id, a.name]),
  school: () => SCHOOL_IDS.map((s) => [s, nice(s)]),
  target: () => ABILITY_TARGET_TYPES.map((s) => [s, nice(s)]),
  type: () => EFFECT_TYPES.map((s) => [s, nice(s)]),
  kind: () => AURA_KIND_IDS.map((s) => [s, nice(s)]),
};

/**
 * The data editor as a form: every field of an entry as a labelled box, with ✕ to remove one and ＋ to add one the game knows
 * (a shield, a damage effect, a talent bonus). `work` is changed in place; `changed` is called after every edit.
 */
export function dataForm(file: string, work: Obj, changed: () => void, redraw: () => void): HTMLElement {
  const root = el('div', 'dform');
  const change = () => changed();
  const structural = () => {
    changed();
    redraw();
  };

  const drawValue = (host: HTMLElement, parent: Obj | unknown[], key: string | number, path: string[]): void => {
    const v = (parent as Obj)[key as string];
    const k = String(key);
    if (typeof v === 'number') {
      const i = el('input', 'dform-in') as HTMLInputElement;
      i.type = 'number';
      i.step = 'any';
      i.value = String(v);
      i.addEventListener('input', () => {
        if (i.value.trim() !== '' && Number.isFinite(Number(i.value))) {
          (parent as Obj)[key as string] = Number(i.value);
          change();
        }
      });
      host.append(i);
    } else if (typeof v === 'boolean') {
      const i = el('input') as HTMLInputElement;
      i.type = 'checkbox';
      i.checked = v;
      i.addEventListener('change', () => {
        (parent as Obj)[key as string] = i.checked;
        change();
      });
      host.append(i);
    } else if (typeof v === 'string') {
      const choices = CHOICES[k]?.();
      if (choices) {
        const s = el('select', 'dform-in');
        for (const [id, name] of choices) {
          const o = el('option', '', name);
          o.value = id;
          s.append(o);
        }
        if (!choices.some(([id]) => id === v)) {
          const o = el('option', '', v);
          o.value = v;
          s.append(o);
        }
        s.value = v;
        s.addEventListener('change', () => {
          (parent as Obj)[key as string] = s.value;
          // a different effect type starts with the fields it needs
          if (k === 'type' && /^\d+$/.test(path[path.length - 1] ?? '')) Object.assign(parent as Obj, { ...effectSkeleton(s.value), ...(parent as Obj), type: s.value });
          structural();
        });
        host.append(s);
      } else {
        const i = el('input', 'dform-in') as HTMLInputElement;
        i.value = v;
        i.addEventListener('input', () => {
          (parent as Obj)[key as string] = i.value;
          change();
        });
        host.append(i);
      }
    } else if (Array.isArray(v)) {
      host.append(drawList(v, [...path, k], k));
    } else if (isObj(v)) {
      host.append(drawObject(v, [...path, k]));
    }
  };

  const remove = (onClick: () => void, title: string) => {
    const b = el('button', 'mm-small dform-x', '✕');
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  };

  function drawObject(o: Obj, path: string[]): HTMLElement {
    const box = el('div', path.length ? 'dform-box' : 'dform-top');
    const locked = path.length === 0 ? new Set(['id']) : new Set<string>();
    for (const k of Object.keys(o)) {
      const row = el('div', 'dform-row');
      row.append(el('label', 'dform-lab', nice(k)));
      const val = el('div', 'dform-val');
      drawValue(val, o, k, path);
      row.append(val);
      if (!locked.has(k)) row.append(remove(() => { delete o[k]; structural(); }, 'Remove this field'));
      box.append(row);
    }
    const sugg = [...suggestions(file, path, o)].filter(([k]) => !(k in o));
    if (sugg.length) {
      const add = el('select', 'dform-add');
      const first = el('option', '', '＋ Add a field…');
      first.value = '';
      add.append(first);
      for (const [k] of sugg) {
        const o2 = el('option', '', nice(k));
        o2.value = k;
        add.append(o2);
      }
      add.addEventListener('change', () => {
        if (!add.value) return;
        const ex = sugg.find(([k]) => k === add.value)?.[1];
        o[add.value] = structuredClone(ex);
        structural();
      });
      box.append(add);
    }
    return box;
  }

  function drawList(a: unknown[], path: string[], k: string): HTMLElement {
    const box = el('div', 'dform-list');
    a.forEach((item, i) => {
      const row = el('div', 'dform-item');
      const head = el('div', 'dform-itemhead');
      const title = isObj(item) && typeof item.type === 'string' ? `${nice(item.type)}${typeof item.aura === 'string' ? `: ${AURAS[item.aura]?.name ?? item.aura}` : ''}` : `${nice(k)} ${i + 1}`;
      head.append(el('b', '', k === 'effects' ? `Effect ${i + 1}: ${title}` : title), remove(() => { a.splice(i, 1); structural(); }, 'Remove'));
      row.append(head);
      if (isObj(item)) row.append(drawObject(item, [...path, String(i)]));
      else {
        const holder = el('div', 'dform-val');
        drawValue(holder, a, i, path);
        row.append(holder);
      }
      box.append(row);
    });
    const add = el('button', 'mm-small', k === 'effects' ? '＋ Add effect' : `＋ Add to ${nice(k).toLowerCase()}`);
    const kindSel = el('select', 'dform-add');
    if (k === 'effects') {
      for (const t of EFFECT_TYPES) {
        const o = el('option', '', t === 'aura' ? 'Buff / debuff / shield' : nice(t));
        o.value = t;
        kindSel.append(o);
      }
      kindSel.value = 'aura';
    }
    add.addEventListener('click', () => {
      if (k === 'effects') a.push(effectSkeleton(kindSel.value));
      else if (a.length) a.push(structuredClone(a[a.length - 1]));
      else a.push('');
      structural();
    });
    if (k === 'effects') box.append(kindSel);
    box.append(add);
    return box;
  }

  root.append(drawObject(work, []));
  return root;
}
