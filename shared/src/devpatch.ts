import { ABILITIES, AURAS } from './data';

/**
 * Dev tuning: a change to one number in the game data, e.g. Fireball's damage or Frost Nova's root duration. Dev
 * testers try patches in a match against bots (only in their room), and a saved patch is applied for everyone (and
 * proposed for the data files as a pull request).
 */
export interface DataPatch {
  file: 'abilities' | 'auras';
  /** The ability or aura id. */
  id: string;
  /** Where the number sits inside it, e.g. ['effects', 0, 'amount'] or ['cooldown']. */
  path: (string | number)[];
  value: number;
}

/** Fields that are ids, flags or structure, never balance numbers. */
const NOT_TUNABLE = new Set(['id', 'class', 'school', 'target', 'type', 'name', 'kind', 'dr', 'aura', 'icon']);
const MAX_ABS = 1_000_000;

const root = (file: DataPatch['file'], id: string): Record<string, unknown> | undefined =>
  Object.hasOwn(file === 'abilities' ? ABILITIES : AURAS, id) ? ((file === 'abilities' ? ABILITIES : AURAS) as Record<string, unknown>)[id] as Record<string, unknown> : undefined;

/** The parent object and key a patch points at, or null when the path does not lead to a number. */
function locate(p: Pick<DataPatch, 'file' | 'id' | 'path'>): { obj: Record<string | number, unknown>; key: string | number } | null {
  if (p.file !== 'abilities' && p.file !== 'auras') return null;
  if (!Array.isArray(p.path) || p.path.length < 1 || p.path.length > 5) return null;
  let obj: unknown = root(p.file, p.id);
  for (let i = 0; i < p.path.length; i++) {
    const k = p.path[i];
    if (typeof k === 'string' && (k === '__proto__' || k === 'constructor' || k === 'prototype' || NOT_TUNABLE.has(k))) return null;
    if (typeof k !== 'string' && !(typeof k === 'number' && Number.isInteger(k) && k >= 0)) return null;
    if (!obj || typeof obj !== 'object' || !Object.hasOwn(obj, k)) return null;
    if (i === p.path.length - 1) return typeof (obj as Record<string | number, unknown>)[k] === 'number' ? { obj: obj as Record<string | number, unknown>, key: k } : null;
    obj = (obj as Record<string | number, unknown>)[k];
  }
  return null;
}

/** True when the patch names an existing number and sets it to a sane finite value. */
export function validPatch(p: DataPatch): boolean {
  return !!p && typeof p.id === 'string' && Number.isFinite(p.value) && Math.abs(p.value) <= MAX_ABS && locate(p) !== null;
}

/** The number a patch would change, as it is now. */
export function currentValue(p: Pick<DataPatch, 'file' | 'id' | 'path'>): number | undefined {
  const at = locate(p);
  return at ? (at.obj[at.key] as number) : undefined;
}

/** Apply patches to the live data; returns a function that puts every number back as it was. Invalid patches are skipped. */
export function applyPatches(patches: readonly DataPatch[]): () => void {
  const undo: { obj: Record<string | number, unknown>; key: string | number; was: unknown }[] = [];
  for (const p of patches) {
    if (!validPatch(p)) continue;
    const at = locate(p)!;
    undo.push({ obj: at.obj, key: at.key, was: at.obj[at.key] });
    at.obj[at.key] = p.value;
  }
  return () => {
    for (let i = undo.length - 1; i >= 0; i--) undo[i].obj[undo[i].key] = undo[i].was;
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
    if (depth > 4 || !obj || typeof obj !== 'object') return;
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
  const obj = root(file, id);
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
