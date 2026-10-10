import { ABILITIES, ABILITY_TARGET_TYPES, AURAS, AURA_KIND_IDS, EFFECT_TYPES, SCHOOL_IDS, SPECS, TALENTS, effectSkeleton } from '@arena/shared';
import { el } from './skillView';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** "castTime" -> "Cast time". */
const nice = (k: string) => {
  const w = k.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim().toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/** Effects by their plain names. */
const EFFECT_NAMES: Record<string, string> = {
  damage: 'Damage', heal: 'Heal', shield: 'Shield', reduction: 'Damage reduction', knockback: 'Knockback', aura: 'Buff / debuff', interrupt: 'Interrupt',
  dispel: 'Dispel', gain: 'Resource gain', healMissing: 'Heal (share of missing health)', healMax: 'Heal (share of max health)', pull: 'Pull', leap: 'Leap', blink: 'Blink',
  charge: 'Charge', dashToTarget: 'Dash to target', zone: 'Ground area', cleanse: 'Cleanse', strip: 'Strip effects', smoke: 'Smoke', images: 'Mirror images', flag: 'Banner',
  mindControl: 'Mind control', zoneBuff: 'Area buff', freeMove: 'Free movement', dropCombat: 'Drop combat', dropTargets: 'Drop targets', exsanguinate: 'Exsanguinate', proc: 'Chance to trigger', cast: 'Cast another skill',
};
/** What a "plain" add-effect choice makes: a ready effect, so the dev never has to know an aura's id. */
const QUICK: [string, string, () => Record<string, unknown>][] = [
  ['damage', 'Damage', () => effectSkeleton('damage')],
  ['heal', 'Heal', () => effectSkeleton('heal')],
  ['shield', 'Shield', () => ({ ...effectSkeleton('shield'), amount: 300, duration: 8000, self: true })],
  ['reduction', 'Damage reduction', () => ({ ...effectSkeleton('reduction'), pct: 0.2, duration: 4000, self: true })],
  ['knockback', 'Knockback', () => effectSkeleton('knockback')],
  ['stun', 'Stun', () => ({ type: 'aura', aura: 'concussion_stun', duration: 2000 })],
  ['root', 'Root', () => ({ type: 'aura', aura: 'frostbolt_root', duration: 3000 })],
  ['slow', 'Slow', () => ({ type: 'aura', aura: 'frostbolt_slow', duration: 4000 })],
  ['fear', 'Fear', () => ({ type: 'aura', aura: 'psychic_scream', duration: 5000 })],
  ['incapacitate', 'Incapacitate (breaks on damage)', () => ({ type: 'aura', aura: 'polymorph', duration: 6000 })],
  ['interrupt', 'Interrupt', () => effectSkeleton('interrupt')],
  ['dispel', 'Dispel', () => effectSkeleton('dispel')],
  ['aura', 'Other buff / debuff…', () => effectSkeleton('aura')],
];
/** Plain labels for the fields of an effect (by effect type, else by field). */
const FIELD_LABELS: Record<string, Record<string, string>> = {
  shield: { amount: 'Shield strength', duration: 'Lasts', self: 'On yourself (off: on the target)' },
  reduction: { pct: 'Damage reduced by', duration: 'Lasts', self: 'On yourself (off: on the target)' },
  knockback: { distance: 'Thrown back' },
  damage: { amount: 'Damage' }, heal: { amount: 'Healing' }, gain: { amount: 'Resource gained' },
  aura: { aura: 'Effect', duration: 'Lasts', chance: 'Chance', self: 'On yourself (off: on the target)', stacks: 'Stacks added' },
};
const FIELD_PLAIN: Record<string, string> = { self: 'On yourself', pct: 'Percentage', duration: 'Lasts', lockout: 'Lockout', radius: 'Radius', distance: 'Distance', chance: 'Chance', p: 'Chance', amount: 'Amount' };
/** Fields shown in seconds (stored in ms) and in percent (stored 0 to 1). */
const SECONDS = new Set(['duration', 'lockout', 'delay', 'pulse', 'initial', 'castTime', 'cooldown']);
const PERCENT = new Set(['pct', 'chance', 'p']);
const UNIT: Record<string, string> = { distance: 'yards', radius: 'yards', range: 'yards', stopDistance: 'yards' };

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
  if (typeof o.type === 'string' && /^\d+$/.test(last) && ['shield', 'reduction'].includes(o.type)) return new Map<string, unknown>([['self', true]]);
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
/** The category last used in the add-effect picker (kept while the form is redrawn). */
let lastCat = 'shield';

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
      const f = SECONDS.has(k) ? 1000 : PERCENT.has(k) ? 0.01 : 1; // shown value = stored / f
      const unit = SECONDS.has(k) ? 'seconds' : PERCENT.has(k) ? '%' : UNIT[k] ?? '';
      const i = el('input', 'dform-in') as HTMLInputElement;
      i.type = 'number';
      i.step = 'any';
      i.value = String(Math.round((v / f) * 1000) / 1000);
      i.addEventListener('input', () => {
        if (i.value.trim() !== '' && Number.isFinite(Number(i.value))) {
          (parent as Obj)[key as string] = Math.round(Number(i.value) * f * 1000) / 1000;
          change();
        }
      });
      host.append(i);
      if (unit) host.append(el('small', 'devp-dim', ` ${unit}`));
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

  /** A field's label: its effect's own wording first, then the shared plain wording, then its name made readable. */
  const labelOf = (o: Obj, k: string): string => {
    const t = typeof o.type === 'string' ? o.type : '';
    return FIELD_LABELS[t]?.[k] ?? FIELD_PLAIN[k] ?? nice(k);
  };

  function drawObject(o: Obj, path: string[]): HTMLElement {
    const box = el('div', path.length ? 'dform-box' : 'dform-top');
    const locked = path.length === 0 ? new Set(['id']) : new Set<string>();
    for (const k of Object.keys(o)) {
      const row = el('div', 'dform-row');
      row.append(el('label', 'dform-lab', labelOf(o, k)));
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
      const title = isObj(item) && typeof item.type === 'string' ? `${EFFECT_NAMES[item.type] ?? nice(item.type)}${typeof item.aura === 'string' ? `: ${AURAS[item.aura]?.name ?? item.aura}` : ''}` : `${nice(k)} ${i + 1}`;
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
    const catSel = el('select', 'dform-add');
    const kindSel = el('select', 'dform-add');
    if (k === 'effects') {
      // categories first, then what is in the category: a short list each time, the choice kept while more effects are added
      const byName = (x: [string, string], y: [string, string]) => x[1].localeCompare(y[1]);
      const named = Object.entries(AURAS).filter(([id]) => id !== 'shield' && id !== 'damage_reduction');
      const CC_KINDS = ['stun', 'root', 'slow', 'fear', 'incapacitate'];
      const auraItems = (pick: (a: (typeof AURAS)[string]) => boolean): [string, string][] => named.filter(([, a]) => pick(a)).map(([id, a]): [string, string] => [`a:${id}`, a.name]).sort(byName);
      const types = (ids: string[]): [string, string][] => ids.filter((t) => EFFECT_TYPES.includes(t)).map((t) => [QUICK.some(([q]) => q === t) ? `q:${t}` : `type:${t}`, EFFECT_NAMES[t] ?? nice(t)]);
      const CATS: [string, string, () => [string, string][]][] = [
        ['dmg', 'Damage and healing', () => types(['damage', 'heal', 'healMissing', 'healMax', 'gain', 'zone', 'exsanguinate'])],
        ['shield', 'Shields and protection', () => [['q:shield', 'Shield (you set the strength)'], ['q:reduction', 'Damage reduction (you set the percentage)'], ...auraItems((a) => !a.harmful && (a.kind === 'absorb' || !!a.invulnerable || !!a.mods?.damageTaken))]],
        ['buff', 'Buffs on you or allies', () => auraItems((a) => !a.harmful)],
        ['cc', 'Crowd control', () => [['q:stun', 'Stun'], ['q:root', 'Root'], ['q:slow', 'Slow'], ['q:fear', 'Fear'], ['q:incapacitate', 'Incapacitate (breaks on damage)'], ['type:interrupt', 'Interrupt (locks a school of magic)']]],
        ['debuff', 'Debuffs and damage over time (named effects)', () => auraItems((a) => !!a.harmful && !CC_KINDS.includes(a.kind))],
        ['move', 'Movement', () => types(['knockback', 'pull', 'leap', 'blink', 'charge', 'dashToTarget', 'freeMove'])],
        ['util', 'Utility', () => types(['interrupt', 'dispel', 'cleanse', 'strip', 'smoke', 'images', 'flag', 'mindControl', 'zoneBuff', 'dropCombat', 'dropTargets', 'cast', 'proc'])],
      ];
      for (const [id, name] of CATS) catSel.append(Object.assign(el('option', '', name), { value: id }));
      const fill = () => {
        kindSel.replaceChildren();
        for (const [v, name] of CATS.find(([id]) => id === catSel.value)![2]()) kindSel.append(Object.assign(el('option', '', name), { value: v }));
      };
      catSel.value = lastCat;
      fill();
      catSel.addEventListener('change', () => {
        lastCat = catSel.value;
        fill();
      });
    }
    add.addEventListener('click', () => {
      if (k === 'effects') {
        const v = kindSel.value;
        if (!v) return;
        const q = v.startsWith('q:') ? QUICK.find(([id]) => id === v.slice(2)) : undefined;
        if (q) a.push(q[2]());
        else if (v.startsWith('a:')) {
          // a buff or debuff by name: a buff goes on you, a debuff on the target, and its own time is shown to change
          const def = AURAS[v.slice(2)];
          a.push({ type: 'aura', aura: v.slice(2), ...(def?.harmful ? {} : { self: true }), ...(def?.duration ? { duration: def.duration } : {}) });
        } else a.push(effectSkeleton(v.replace(/^type:/, '')));
      } else if (a.length) a.push(structuredClone(a[a.length - 1]));
      else a.push('');
      structural();
    });
    if (k === 'effects') box.append(el('small', 'devp-dim', 'Add an effect: pick a kind, then which one.'), catSel, kindSel);
    box.append(add);
    return box;
  }

  root.append(drawObject(work, []));
  return root;
}
