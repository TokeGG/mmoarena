import { ABILITIES, AURAS, CLASSES, SPECS, TALENTS } from './data';

/**
 * Dev tuning: a change to one number in the game data, e.g. Fireball's damage or Frost Nova's root duration. Dev
 * testers try patches in a match against bots (only in their room), and a saved patch is applied for everyone (and
 * proposed for the data files as a pull request).
 */
export interface DataPatch {
  file: 'abilities' | 'auras' | 'specs' | 'talents' | 'classes';
  /** The ability, aura, spec or talent id (a talent in several specs is changed in all of them). */
  id: string;
  /** Where the number sits inside it, e.g. ['effects', 0, 'amount'] or ['cooldown']. */
  path: (string | number)[];
  /** A number; or, for the skill options below, 1/0 for a yes/no option and a word for a choice (target, school). */
  value: number | string;
}

/** The yes/no options of a skill a dev can switch (patched as 1 or 0). */
export const ABILITY_FLAGS: Record<string, string> = {
  gcd: 'Uses the global cooldown',
  unmissable: 'Works without facing the target',
  castWhileMoving: 'Can be cast while moving',
  ignoresControl: 'Works while stunned, feared or incapacitated',
  ignoresLockout: 'Ignores school lockouts',
  unstoppable: 'Cannot be interrupted, shrugs off control',
  allowWhileRooted: 'Works while rooted',
  requiresStealth: 'Needs stealth',
  outOfCombatOnly: 'Out of combat only',
  keepsStealth: 'Keeps stealth when used',
  prepOk: 'Usable before the gates open',
  noBreak: 'Does not break fear',
  requiresTargetCasting: 'Needs a casting target',
};
/** The choices of a skill a dev can switch (patched as the word). */
export const ABILITY_CHOICES: Record<string, { label: string; options: string[] }> = {
  target: { label: 'Target', options: ['self', 'enemy', 'ally', 'ally_or_self', 'any', 'aoe_enemy', 'aoe_all', 'ground'] },
  school: { label: 'School', options: ['physical', 'fire', 'frost', 'arcane', 'holy', 'shadow', 'nature'] },
};

/** Fields that are ids, flags or structure, never balance numbers. */
const NOT_TUNABLE = new Set(['id', 'class', 'school', 'target', 'type', 'name', 'kind', 'dr', 'aura', 'icon']);
const MAX_ABS = 1_000_000;

/** Every object an id names in a data file: one ability or aura, a spec, or a talent (the same talent sits in each spec's tree). */
function roots(file: DataPatch['file'], id: string): Record<string, unknown>[] {
  if (file === 'abilities' || file === 'auras') {
    const table = (file === 'abilities' ? ABILITIES : AURAS) as Record<string, unknown>;
    return Object.hasOwn(table, id) ? [table[id] as Record<string, unknown>] : [];
  }
  const found = new Set<Record<string, unknown>>();
  if (file === 'classes') {
    return Object.hasOwn(CLASSES, id) ? [(CLASSES as unknown as Record<string, Record<string, unknown>>)[id]] : [];
  } else if (file === 'specs') {
    for (const specs of Object.values(SPECS)) for (const s of specs) if (s.id === id) found.add(s as unknown as Record<string, unknown>);
  } else if (file === 'talents') {
    for (const bySpec of Object.values(TALENTS)) for (const tiers of Object.values(bySpec)) for (const tier of tiers) for (const t of tier) if (t.id === id) found.add(t as unknown as Record<string, unknown>);
  } else return [];
  return [...found];
}

const FILES = ['abilities', 'auras', 'specs', 'talents', 'classes'];

/** Where a patch points: the parent object and key in every copy of the thing it names (empty when the path does not lead to a number). */
function locateAll(p: Pick<DataPatch, 'file' | 'id' | 'path'>): { obj: Record<string | number, unknown>; key: string | number }[] {
  if (!FILES.includes(p.file)) return [];
  if (!Array.isArray(p.path) || p.path.length < 1 || p.path.length > 10) return [];
  const out: { obj: Record<string | number, unknown>; key: string | number }[] = [];
  // a skill's yes/no options and choices sit right on the ability
  if (p.file === 'abilities' && p.path.length === 1 && typeof p.path[0] === 'string' && (Object.hasOwn(ABILITY_FLAGS, p.path[0]) || Object.hasOwn(ABILITY_CHOICES, p.path[0]))) {
    const a = roots('abilities', p.id)[0];
    return a ? [{ obj: a, key: p.path[0] }] : [];
  }
  for (const start of roots(p.file, p.id)) {
    let obj: unknown = start;
    for (let i = 0; i < p.path.length; i++) {
      const k = p.path[i];
      if (typeof k === 'string' && (k === '__proto__' || k === 'constructor' || k === 'prototype' || NOT_TUNABLE.has(k) || ((p.file === 'specs' || p.file === 'classes') && (k === 'bar' || k === 'weapon')))) return [];
      if (typeof k !== 'string' && !(typeof k === 'number' && Number.isInteger(k) && k >= 0)) return [];
      if (!obj || typeof obj !== 'object' || !Object.hasOwn(obj, k)) return [];
      if (i === p.path.length - 1) {
        if (typeof (obj as Record<string | number, unknown>)[k] !== 'number') return [];
        out.push({ obj: obj as Record<string | number, unknown>, key: k });
        break;
      }
      obj = (obj as Record<string | number, unknown>)[k];
    }
  }
  return out;
}

const locate = (p: Pick<DataPatch, 'file' | 'id' | 'path'>) => locateAll(p)[0] ?? null;

/** What a patch's value must look like at its spot: a yes/no is 1 or 0, a choice is one of its words, anything else a sane number. */
function valueFits(p: DataPatch): boolean {
  const k = p.path.length === 1 && p.file === 'abilities' ? String(p.path[0]) : '';
  if (k && Object.hasOwn(ABILITY_FLAGS, k)) return p.value === 0 || p.value === 1;
  if (k && Object.hasOwn(ABILITY_CHOICES, k)) return typeof p.value === 'string' && ABILITY_CHOICES[k].options.includes(p.value);
  return typeof p.value === 'number' && Number.isFinite(p.value) && Math.abs(p.value) <= MAX_ABS;
}

/** True when the patch names an existing number (or option) and sets it to something sane. */
export function validPatch(p: DataPatch): boolean {
  return !!p && typeof p.id === 'string' && valueFits(p) && locate(p) !== null;
}

/** The value a patch would change, as it is now (a yes/no option reads 1 or 0). */
export function currentValue(p: Pick<DataPatch, 'file' | 'id' | 'path'>): number | string | undefined {
  const at = locate(p);
  if (!at) return undefined;
  const v = at.obj[at.key];
  return typeof v === 'boolean' || v === undefined ? (v ? 1 : 0) : (v as number | string);
}

const isFlag = (p: DataPatch) => p.file === 'abilities' && p.path.length === 1 && Object.hasOwn(ABILITY_FLAGS, String(p.path[0]));

/** Apply patches to the live data; returns a function that puts every number back as it was. Invalid patches are skipped. */
export function applyPatches(patches: readonly DataPatch[]): () => void {
  const undo: { obj: Record<string | number, unknown>; key: string | number; was: unknown; had: boolean }[] = [];
  for (const p of patches) {
    if (!validPatch(p)) continue;
    for (const at of locateAll(p)) {
      undo.push({ obj: at.obj, key: at.key, was: at.obj[at.key], had: Object.hasOwn(at.obj, at.key) });
      at.obj[at.key] = isFlag(p) ? p.value === 1 : p.value;
    }
  }
  return () => {
    for (let i = undo.length - 1; i >= 0; i--) {
      const u = undo[i];
      if (u.had) u.obj[u.key] = u.was;
      else delete u.obj[u.key];
    }
  };
}

/** Run `fn` with the patches applied, then restore the data (a room's test numbers, only while that room runs). */
export function withPatches<T>(patches: readonly DataPatch[], fn: () => T): T {
  if (!patches.length) return fn();
  const undo = applyPatches(patches);
  try {
    return fn();
  } finally {
    undo();
  }
}

/** Later patches to the same number replace earlier ones. */
export function mergePatches(a: readonly DataPatch[], b: readonly DataPatch[]): DataPatch[] {
  const key = (p: DataPatch) => `${p.file}:${p.id}:${p.path.join('.')}`;
  const m = new Map<string, DataPatch>();
  for (const p of [...a, ...b]) m.set(key(p), p);
  return [...m.values()];
}

export interface TunableNumber { file: DataPatch['file']; id: string; path: (string | number)[]; label: string; value: number }

/** Every tunable number on one ability or aura, labelled by where it sits ("damage · amount", "slowPct"). */
export function tunableNumbers(file: DataPatch['file'], id: string, prefix = ''): TunableNumber[] {
  const out: TunableNumber[] = [];
  const walk = (obj: unknown, path: (string | number)[], label: string, depth: number) => {
    if (depth > 9 || !obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (NOT_TUNABLE.has(k)) continue;
      const key: string | number = Array.isArray(obj) ? Number(k) : k;
      const here = [...path, key];
      const name = Array.isArray(obj) ? `${label}${label ? ' ' : ''}#${Number(k) + 1}` : `${label}${label ? ' · ' : ''}${k}`;
      if (typeof v === 'number') out.push({ file, id, path: here, label: name, value: v });
      else if (k === 'effects' && Array.isArray(v)) walk(v, here, label, depth + 1); // "damage · amount", not "effects · damage · amount"
      else if (v && typeof v === 'object') {
        // an effect is labelled by its type ("damage amount", "aura duration")
        const t = (v as { type?: string }).type;
        walk(v, here, t ? `${label}${label ? ' · ' : ''}${t}` : name, depth + 1);
      }
    }
  };
  const obj = roots(file, id)[0];
  if (obj) walk(obj, [], prefix, 0);
  return out;
}

/** Every number on an ability worth tuning, and on the auras it applies (durations, absorbs, slows, ticks). */
export function tunables(abilityId: string): TunableNumber[] {
  const def = ABILITIES[abilityId];
  if (!def) return [];
  const out = tunableNumbers('abilities', abilityId);
  const auras = new Set<string>();
  for (const e of def.effects) if (e.type === 'aura') auras.add(e.aura);
  for (const a of auras) if (AURAS[a]) out.push(...tunableNumbers('auras', a, AURAS[a].name));
  return out;
}
