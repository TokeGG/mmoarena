import { ABILITIES, AURAS, CLASSES, FX, ICONS, MODELS_DATA, SOUNDS, SPECS, TALENTS, TUNING } from './data';
import { MODELS_ID, modelBounds } from './modeldata';
import { SOUND_FIELD_BOUNDS, SOUND_ID, isSoundFile } from './sounds';
import { FX_ID, fxField } from './fx';
import { ICON_TABLE, fileIconIdFor, iconExists, iconIdFor } from './iconlib';
import type { IconKind } from './iconlib';

/**
 * Dev tuning: a change to one number in the game data, e.g. Fireball's damage or Frost Nova's root duration. Dev
 * testers try patches in a match against bots (only in their room), and a saved patch is applied for everyone (and
 * proposed for the data files as a pull request).
 */
export type PatchFile = 'abilities' | 'auras' | 'specs' | 'talents' | 'classes' | 'tuning' | 'fx' | 'icons' | 'sounds' | 'models';
/** Every data file a patch can name (the game options, shared/data/tuning.json, are one flat object with the id 'game'). */
export const PATCH_FILES: readonly PatchFile[] = ['abilities', 'auras', 'specs', 'talents', 'classes', 'tuning', 'fx', 'icons', 'sounds', 'models'];
/** The id of the one object in tuning.json. */
export const TUNING_ID = 'game';

export interface DataPatch {
  file: PatchFile;
  /** The ability, aura, spec or talent id (a talent in several specs is changed in all of them); 'game' for the game options. */
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

/** The yes/no options of an aura (patched as 1 or 0). */
export const AURA_FLAGS: Record<string, string> = {
  harmful: 'Harmful (a debuff)',
  dispellable: 'Can be dispelled',
  breaksOnDamage: 'Breaks when the target takes damage',
  unique: 'Only one at a time on a target',
  bleed: 'Counts as a bleed',
  invulnerable: 'Target takes no damage and is immune to control',
  untargetable: 'Target cannot be targeted',
  blocksDebuffs: 'Harmful effects cannot take hold',
  uninterruptible: 'Cannot be interrupted',
  locksAbilities: 'Target cannot use skills',
  noCast: 'Target cannot cast',
  silence: 'Silences the target',
  disarm: 'Disarms the target',
  flee: 'Target runs away',
  canTurn: 'Target can still turn',
  perCp: 'Scales with combo points',
};

/** What a stat bonus (`mods.<key>`) does nothing by (its neutral value): a multiplier is 1, an added amount is 0. */
export const MOD_SCALAR_DEFAULT: Record<string, number> = {
  damageDone: 1, healingDone: 1, healingTaken: 1, damageTaken: 1, maxHealth: 1, castTime: 1, gcd: 1, regen: 1, moveSpeed: 1, autoSpeed: 1, cpPower: 1, rage: 1, maxCp: 0, lifesteal: 0,
};
/** A skill change (`mods.ability.<skill>.<key>`): the neutral value of each number. */
export const MOD_ABILITY_DEFAULT: Record<string, number> = {
  damage: 1, heal: 1, cooldown: 1, castTime: 1, cost: 1, gain: 1, stored: 0, cpChance: 0, shadowProc: 0, range: 0, charges: 0, shieldPct: 0, echo: 0,
};
/** The yes/no changes a spec, talent or buff can make to a skill. */
export const MOD_ABILITY_FLAGS: readonly string[] = ['castWhileMoving', 'free', 'castDuring', 'allyOk'];
/** Game options a patch may not touch (the length of a server step changes how every match is played back). */
const TUNING_LOCKED = new Set(['tickMs']);

/** Fields that are ids, flags or structure, never balance numbers. */
const NOT_TUNABLE = new Set(['id', 'class', 'school', 'target', 'type', 'name', 'kind', 'dr', 'aura', 'icon']);
const MAX_ABS = 1_000_000;

/** The data as the files have it, copied before any patch can be applied (for "the file's value" next to the live one). */
type Source = { ABILITIES: typeof ABILITIES; AURAS: typeof AURAS; CLASSES: typeof CLASSES; SPECS: typeof SPECS; TALENTS: typeof TALENTS; TUNING: typeof TUNING; FX: typeof FX; ICONS: typeof ICONS; SOUNDS: typeof SOUNDS; MODELS: typeof MODELS_DATA };
const PRISTINE = structuredClone({ ABILITIES, AURAS, CLASSES, SPECS, TALENTS, TUNING, FX, ICONS, SOUNDS, MODELS: MODELS_DATA }) as unknown as Source;
const LIVE: Source = { ABILITIES, AURAS, CLASSES, SPECS, TALENTS, TUNING, FX, ICONS, SOUNDS, MODELS: MODELS_DATA };

/** Every object an id names in a data file: one ability or aura, a spec, or a talent (the same talent sits in each spec's tree). */
function roots(file: DataPatch['file'], id: string, src: Source = LIVE): Record<string, unknown>[] {
  if (file === 'abilities' || file === 'auras') {
    const table = (file === 'abilities' ? src.ABILITIES : src.AURAS) as Record<string, unknown>;
    return Object.hasOwn(table, id) ? [table[id] as Record<string, unknown>] : [];
  }
  if (file === 'tuning') return id === TUNING_ID ? [src.TUNING as unknown as Record<string, unknown>] : [];
  if (file === 'fx') return id === FX_ID ? [src.FX as unknown as Record<string, unknown>] : [];
  if (file === 'models') return id === MODELS_ID ? [src.MODELS as unknown as Record<string, unknown>] : [];
  if (file === 'sounds') return id === SOUND_ID ? [src.SOUNDS as unknown as Record<string, unknown>] : [];
  if (file === 'icons') return []; // an icon is set by its kind (path ['ability'] or ['aura']), see locateAll
  const found = new Set<Record<string, unknown>>();
  if (file === 'classes') {
    return Object.hasOwn(src.CLASSES, id) ? [(src.CLASSES as unknown as Record<string, Record<string, unknown>>)[id]] : [];
  } else if (file === 'specs') {
    for (const specs of Object.values(src.SPECS)) for (const s of specs) if (s.id === id) found.add(s as unknown as Record<string, unknown>);
  } else if (file === 'talents') {
    for (const bySpec of Object.values(src.TALENTS)) for (const tiers of Object.values(bySpec)) for (const tier of tiers) for (const t of tier) if (t.id === id) found.add(t as unknown as Record<string, unknown>);
  } else return [];
  return [...found];
}

type PatchAt = Pick<DataPatch, 'file' | 'id' | 'path'>;

// ------------------------------------------------------------------ the data editor: a whole entry as JSON

/** The path that stands for "the whole entry": the patch's value is then the entry as JSON text (the dev panel's data editor). */
export const ENTITY = '$entity';
export const isEntityPatch = (p: PatchAt): boolean => p.path.length === 1 && p.path[0] === ENTITY;
/** The longest entry the data editor takes. */
export const MAX_ENTITY_CHARS = 12000;
const ENTITY_FILES: readonly PatchFile[] = ['abilities', 'auras', 'specs', 'talents'];
export const canEditAsData = (file: PatchFile): boolean => ENTITY_FILES.includes(file);

/** Every effect type a skill can have (what the sim knows how to run). */
export const EFFECT_TYPES: readonly string[] = ['damage', 'heal', 'healMissing', 'aura', 'exsanguinate', 'interrupt', 'dispel', 'dashToTarget', 'healMax', 'leap', 'pull', 'flag', 'charge', 'blink', 'gain', 'zone', 'smoke', 'cleanse', 'freeMove', 'dropCombat', 'proc', 'cast', 'strip', 'dropTargets', 'mindControl', 'images', 'zoneBuff', 'shield', 'reduction', 'knockback'];
export const ABILITY_TARGET_TYPES: readonly string[] = ['self', 'enemy', 'ally', 'ally_or_self', 'any', 'aoe_enemy', 'aoe_all', 'ground'];
export const SCHOOL_IDS: readonly string[] = ['physical', 'fire', 'frost', 'arcane', 'holy', 'shadow', 'nature'];
export const AURA_KIND_IDS: readonly string[] = ['stun', 'incapacitate', 'fear', 'root', 'slow', 'speed', 'absorb', 'stealth', 'buff', 'dot', 'mark'];
/** The fields an effect cannot do without (the rest are optional): a missing one would stop the sim. */
const EFFECT_NEEDS: Record<string, readonly string[]> = { damage: ['amount'], heal: ['amount'], healMissing: ['pct'], healMax: ['pct'], aura: ['aura'], proc: ['p', 'effects'], cast: ['ability'], mindControl: ['duration'], images: ['count', 'duration', 'damage'], strip: ['kinds'], zoneBuff: ['aura', 'radius', 'duration'], shield: ['amount', 'duration'], reduction: ['pct', 'duration'], knockback: ['distance'], interrupt: ['lockout'] };

/** A new effect of a type with the fields it cannot do without filled in (the data editor's "add an effect"). */
export function effectSkeleton(type: string, aura?: string, ability?: string): Record<string, unknown> {
  const fill: Record<string, unknown> = { amount: 100, pct: 0.1, aura: aura ?? 'pw_shield', p: 0.2, effects: [], ability: ability ?? 'fireball', duration: 3000, count: 2, damage: 20, kinds: ['slow'], radius: 6, distance: 8, lockout: 4000 };
  const e: Record<string, unknown> = { type };
  for (const need of EFFECT_NEEDS[type] ?? []) e[need] = fill[need];
  return e;
}

/** An entry's object as it is now (or in the data file, before any patch), the first one when a talent sits in several specs. */
function entityObject(file: PatchFile, id: string, pristine = false): Record<string, unknown> | undefined {
  return roots(file, id, pristine ? (PRISTINE as unknown as Source) : LIVE)[0];
}

/** An entry as the editor shows it: formatted JSON (undefined when there is no such entry, or its kind cannot be edited as data). */
export function entityText(file: PatchFile, id: string, pristine = false): string | undefined {
  if (!canEditAsData(file)) return undefined;
  const o = entityObject(file, id, pristine);
  return o ? JSON.stringify(o, null, 2) : undefined;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** What is wrong with an entry typed into the data editor, in plain words (an empty list: it can be used). */
export function entityProblems(file: PatchFile, id: string, text: string): string[] {
  if (!canEditAsData(file)) return ['This kind of entry cannot be edited as data.'];
  if (typeof text !== 'string' || !text.trim()) return ['Nothing there.'];
  if (text.length > MAX_ENTITY_CHARS) return [`Too long: at most ${MAX_ENTITY_CHARS} characters.`];
  if (!entityObject(file, id)) return ['That entry does not exist.'];
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return [`Not valid JSON: ${(e as Error).message}`];
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return ['It must be one object: { ... }.'];
  const out: string[] = [];
  const walk = (x: unknown, where: string, depth: number) => {
    if (depth > 12) return void out.push(`${where}: nested too deeply.`);
    if (typeof x === 'string') {
      if (x.length > 600) out.push(`${where}: text longer than 600 characters.`);
    } else if (typeof x === 'number') {
      if (!Number.isFinite(x) || Math.abs(x) > MAX_ABS) out.push(`${where}: ${x} is not a sane number.`);
    } else if (Array.isArray(x)) {
      if (x.length > 60) out.push(`${where}: more than 60 items.`);
      x.forEach((y, i) => walk(y, `${where}[${i}]`, depth + 1));
    } else if (x && typeof x === 'object') {
      const keys = Object.keys(x);
      if (keys.length > 80) out.push(`${where}: more than 80 fields.`);
      for (const k of keys) {
        if (FORBIDDEN_KEYS.has(k)) out.push(`${where}: the name ${k} is not allowed.`);
        else walk((x as Record<string, unknown>)[k], where ? `${where}.${k}` : k, depth + 1);
      }
    }
  };
  walk(v, '', 0);
  if (out.length) return out;
  const o = v as Record<string, unknown>;
  const str = (k: string, max = 60) => {
    if (typeof o[k] !== 'string' || !(o[k] as string).trim() || (o[k] as string).length > max) out.push(`"${k}" must be a short piece of text.`);
  };
  const effect = (e: unknown, where: string, depth: number) => {
    if (depth > 4) return void out.push(`${where}: effects nested too deeply.`);
    if (!e || typeof e !== 'object' || Array.isArray(e)) return void out.push(`${where}: an effect is an object with a "type".`);
    const r = e as Record<string, unknown>;
    if (typeof r.type !== 'string' || !EFFECT_TYPES.includes(r.type)) return void out.push(`${where}: "type" must be one of ${EFFECT_TYPES.join(', ')}.`);
    for (const need of EFFECT_NEEDS[r.type] ?? []) if (r[need] === undefined) out.push(`${where}: a ${r.type} effect needs "${need}".`);
    if (typeof r.aura === 'string' && !Object.hasOwn(AURAS, r.aura)) out.push(`${where}: there is no buff or debuff called "${r.aura}".`);
    if (r.type === 'cast' && typeof r.ability === 'string' && !Object.hasOwn(ABILITIES, r.ability)) out.push(`${where}: there is no skill called "${r.ability}".`);
    if (r.type === 'proc') {
      if (typeof r.p !== 'number' || r.p < 0 || r.p > 1) out.push(`${where}: "p" is a chance from 0 to 1.`);
      if (Array.isArray(r.effects)) r.effects.forEach((x, i) => effect(x, `${where}.effects[${i}]`, depth + 1));
      else out.push(`${where}: "effects" must be a list.`);
    }
  };
  if (file === 'abilities') {
    if (o.id !== id) out.push(`"id" must stay "${id}".`);
    str('name', 40);
    str('class', 20);
    if (typeof o.school !== 'string' || !SCHOOL_IDS.includes(o.school)) out.push(`"school" must be one of ${SCHOOL_IDS.join(', ')}.`);
    if (typeof o.target !== 'string' || !ABILITY_TARGET_TYPES.includes(o.target)) out.push(`"target" must be one of ${ABILITY_TARGET_TYPES.join(', ')}.`);
    for (const k of ['castTime', 'cooldown', 'cost', 'range']) if (o[k] !== undefined && (typeof o[k] !== 'number' || (o[k] as number) < 0)) out.push(`"${k}" must be a number, 0 or more.`);
    if (!Array.isArray(o.effects)) out.push('"effects" must be a list.');
    else {
      if (o.effects.length > 12) out.push('At most 12 effects.');
      o.effects.forEach((e, i) => effect(e, `effects[${i}]`, 0));
    }
  } else if (file === 'auras') {
    str('name', 40);
    if (typeof o.kind !== 'string' || !AURA_KIND_IDS.includes(o.kind)) out.push(`"kind" must be one of ${AURA_KIND_IDS.join(', ')}.`);
    if (o.duration !== undefined && (typeof o.duration !== 'number' || o.duration < 0)) out.push('"duration" must be a number of milliseconds, 0 or more.');
  } else if (file === 'talents') {
    if (o.id !== id) out.push(`"id" must stay "${id}".`);
    str('name', 40);
    str('desc', 400);
    if (o.mods !== undefined && (typeof o.mods !== 'object' || !o.mods || Array.isArray(o.mods))) out.push('"mods" must be an object.');
    const sw = o.swap as Record<string, unknown> | undefined;
    if (sw !== undefined) {
      if (!sw || typeof sw !== 'object' || typeof sw.to !== 'string' || !Object.hasOwn(ABILITIES, sw.to)) out.push('"swap.to" must be an existing skill.');
      if (sw && typeof sw === 'object' && typeof sw.from !== 'string') out.push('"swap.from" must be the id of the skill it replaces.');
    }
  } else if (file === 'specs') {
    if (o.id !== id) out.push(`"id" must stay "${id}".`);
    str('name', 40);
    const was = entityObject('specs', id, true)?.bar as string[] | undefined;
    if (!Array.isArray(o.bar) || !o.bar.every((a) => typeof a === 'string' && Object.hasOwn(ABILITIES, a))) out.push('"bar" must be a list of existing skills.');
    else if (was && o.bar.length !== was.length) out.push(`"bar" must keep its ${was.length} slots.`);
  }
  return out;
}

/** Put an entry's fields back as they were, or replace them (the same object stays, so everything that holds it sees the change). Returns the undo. */
function replaceEntity(obj: Record<string, unknown>, next: Record<string, unknown>): () => void {
  const was = { ...obj };
  for (const k of Object.keys(obj)) delete obj[k];
  Object.assign(obj, next);
  return () => {
    for (const k of Object.keys(obj)) delete obj[k];
    Object.assign(obj, was);
  };
}

/** What kind of stat change a path inside `mods` is (a spec, talent or buff that does not have it yet can be given it), with the value that does nothing. */
export function modSlot(p: PatchAt): { kind: 'number' | 'flag'; def: number } | null {
  if (p.file !== 'specs' && p.file !== 'talents' && p.file !== 'auras') return null;
  const [top, a, b, c] = p.path;
  if (top !== 'mods' || typeof a !== 'string') return null;
  if (p.path.length === 2) return Object.hasOwn(MOD_SCALAR_DEFAULT, a) ? { kind: 'number', def: MOD_SCALAR_DEFAULT[a] } : null;
  if (p.path.length === 3 && (a === 'auraDuration' || a === 'auraExtend')) return typeof b === 'string' && Object.hasOwn(AURAS, b) ? { kind: 'number', def: a === 'auraDuration' ? 1 : 0 } : null;
  if (p.path.length === 4 && a === 'ability' && typeof b === 'string' && Object.hasOwn(ABILITIES, b) && typeof c === 'string') {
    if (Object.hasOwn(MOD_ABILITY_DEFAULT, c)) return { kind: 'number', def: MOD_ABILITY_DEFAULT[c] };
    if (MOD_ABILITY_FLAGS.includes(c)) return { kind: 'flag', def: 0 };
  }
  return null;
}

/** True when the patch is a yes/no switch (patched as 1 or 0). */
export function isSwitch(p: PatchAt): boolean {
  if (p.file === 'sounds') return p.path.length === 2 && p.path[1] === 'off';
  if (p.path.length === 1 && p.file === 'abilities') return Object.hasOwn(ABILITY_FLAGS, String(p.path[0]));
  if (p.path.length === 1 && p.file === 'auras') return Object.hasOwn(AURA_FLAGS, String(p.path[0]));
  return modSlot(p)?.kind === 'flag';
}

interface Loc { obj: Record<string | number, unknown>; key: string | number; /** Keys below `key` that do not exist yet (a stat change the file does not have): they are made when the patch applies. */ rest: (string | number)[] }

/** Where a patch points: the parent object and key in every copy of the thing it names (empty when the path does not lead to a number). */
function locateAll(p: PatchAt, src: Source = LIVE): Loc[] {
  if (!PATCH_FILES.includes(p.file)) return [];
  if (!Array.isArray(p.path) || p.path.length < 1 || p.path.length > 10) return [];
  // a skill's yes/no options and choices sit right on the ability; an aura's options on the aura
  if (p.path.length === 1 && typeof p.path[0] === 'string') {
    const k = p.path[0];
    if (p.file === 'abilities' && (Object.hasOwn(ABILITY_FLAGS, k) || Object.hasOwn(ABILITY_CHOICES, k))) {
      const a = roots('abilities', p.id, src)[0];
      return a ? [{ obj: a, key: k, rest: [] }] : [];
    }
    if (p.file === 'auras' && Object.hasOwn(AURA_FLAGS, k)) {
      const a = roots('auras', p.id, src)[0];
      return a ? [{ obj: a, key: k, rest: [] }] : [];
    }
  }
  // a sound: one of the four settings (file, volume, pitch, off) of a sound id
  if (p.file === 'sounds') {
    const [sid, key] = p.path;
    if (p.id !== SOUND_ID || p.path.length !== 2 || typeof sid !== 'string' || typeof key !== 'string' || !['file', 'volume', 'pitch', 'off'].includes(key) || !Object.hasOwn(src.SOUNDS, sid)) return [];
    return [{ obj: (src.SOUNDS as unknown as Record<string, Record<string, unknown>>)[sid], key, rest: [] }];
  }
  // an icon: the table entry of the skill or buff (a buff with no entry of its own gets one made)
  if (p.file === 'icons') {
    const kind = p.path[0];
    if (p.path.length !== 1 || typeof kind !== 'string' || !Object.hasOwn(ICON_TABLE, kind) || typeof p.id !== 'string') return [];
    const known = kind === 'ability' ? Object.hasOwn(src.ABILITIES, p.id) : kind === 'aura' ? Object.hasOwn(src.AURAS, p.id) : kind === 'class' ? Object.hasOwn(src.CLASSES, p.id) : Object.values(src.SPECS).some((l) => l.some((s) => s.id === p.id));
    return known ? [{ obj: src.ICONS[ICON_TABLE[kind as IconKind]] as Record<string, unknown>, key: p.id, rest: [] }] : [];
  }
  const slot = modSlot(p);
  const out: Loc[] = [];
  for (const start of roots(p.file, p.id, src)) {
    let obj: unknown = start;
    for (let i = 0; i < p.path.length; i++) {
      const k = p.path[i];
      if (typeof k === 'string' && (k === '__proto__' || k === 'constructor' || k === 'prototype' || NOT_TUNABLE.has(k) || ((p.file === 'specs' || p.file === 'classes') && (k === 'bar' || k === 'weapon')))) return [];
      if (p.file === 'tuning' && i === 0 && typeof k === 'string' && TUNING_LOCKED.has(k)) return [];
      if (typeof k !== 'string' && !(typeof k === 'number' && Number.isInteger(k) && k >= 0)) return [];
      if (!obj || typeof obj !== 'object') return [];
      if (!Object.hasOwn(obj, k)) {
        // a stat change this spec, talent or buff does not have yet: it can be added
        if (!slot || Array.isArray(obj)) return [];
        out.push({ obj: obj as Record<string | number, unknown>, key: k, rest: p.path.slice(i + 1) });
        break;
      }
      const v = (obj as Record<string | number, unknown>)[k];
      if (i === p.path.length - 1) {
        if (typeof v !== 'number' && !(typeof v === 'boolean' && isSwitch(p))) return [];
        out.push({ obj: obj as Record<string | number, unknown>, key: k, rest: [] });
        break;
      }
      obj = v;
    }
  }
  return out;
}

const locate = (p: PatchAt) => locateAll(p)[0] ?? null;

/** What a patch's value must look like at its spot: a yes/no is 1 or 0, a choice is one of its words, anything else a sane number. */
function valueFits(p: DataPatch): boolean {
  const k = p.path.length === 1 && p.file === 'abilities' ? String(p.path[0]) : '';
  if (k && Object.hasOwn(ABILITY_FLAGS, k)) return p.value === 0 || p.value === 1;
  if (k && Object.hasOwn(ABILITY_CHOICES, k)) return typeof p.value === 'string' && ABILITY_CHOICES[k].options.includes(p.value);
  if (isSwitch(p)) return p.value === 0 || p.value === 1;
  if (p.file === 'models') {
    const b = modelBounds(p.path, MODELS_DATA);
    return !!b && typeof p.value === 'number' && Number.isFinite(p.value) && p.value >= b.min && p.value <= b.max;
  }
  if (p.file === 'sounds') {
    const key = p.path[1];
    if (key === 'file') return isSoundFile(p.value);
    const b = key === 'volume' || key === 'pitch' ? SOUND_FIELD_BOUNDS[key] : null;
    return !!b && typeof p.value === 'number' && Number.isFinite(p.value) && p.value >= b.min && p.value <= b.max;
  }
  if (p.file === 'icons') return iconExists(p.value); // only an icon the library has
  if (p.file === 'fx') {
    // an animation number stays inside the bounds of its page (a picture cannot be broken from the panel)
    const b = fxField(p.path);
    return !!b && typeof p.value === 'number' && Number.isFinite(p.value) && p.value >= b.min && p.value <= b.max;
  }
  return typeof p.value === 'number' && Number.isFinite(p.value) && Math.abs(p.value) <= MAX_ABS;
}

/** True when the patch names an existing number (or option), or a stat change that can be added, and sets it to something sane. */
export function validPatch(p: DataPatch): boolean {
  if (p && Array.isArray(p.path) && isEntityPatch(p)) return typeof p.id === 'string' && typeof p.value === 'string' && entityProblems(p.file, p.id, p.value).length === 0;
  return !!p && typeof p.id === 'string' && Array.isArray(p.path) && valueFits(p) && locate(p) !== null;
}

/** The value at a located spot: a switch reads 1 or 0, a stat change the data does not have reads as the value that does nothing. */
function readAt(at: Loc, p: PatchAt): number | string | undefined {
  if (at.rest.length || !Object.hasOwn(at.obj, at.key)) {
    const slot = modSlot(p);
    if (slot) return slot.def;
    return isSwitch(p) ? 0 : undefined;
  }
  const v = at.obj[at.key];
  return typeof v === 'boolean' ? (v ? 1 : 0) : (v as number | string);
}

/** The value a patch would change, as it is now (a yes/no option reads 1 or 0; a stat change the data does not have reads as the value that does nothing). */
export function currentValue(p: PatchAt): number | string | undefined {
  if (isEntityPatch(p)) return entityText(p.file, p.id);
  if (p.file === 'icons') return locate(p) ? iconIdFor(p.path[0] as IconKind, p.id) ?? '' : undefined;
  const at = locate(p);
  return at ? readAt(at, p) : undefined;
}

/** The value the data FILE has for a patch's spot, before any patch (undefined when the spot is not in the file; a stat change it lacks reads as the neutral value). */
export function fileDefault(p: PatchAt): number | string | undefined {
  if (isEntityPatch(p)) return entityText(p.file, p.id, true);
  if (p.file === 'icons') return locate(p) ? fileIconIdFor(p.path[0] as IconKind, p.id) ?? '' : undefined;
  const at = locateAll(p, PRISTINE as unknown as Source)[0];
  return at ? readAt(at, p) : undefined;
}

/** True when the data file has no such entry yet (a stat change the patch would add). */
export function isAddition(p: PatchAt): boolean {
  if (isEntityPatch(p)) return false;
  const at = locateAll(p, PRISTINE as unknown as Source)[0];
  return !!at && (at.rest.length > 0 || !Object.hasOwn(at.obj, at.key));
}

/** Apply patches to the live data; returns a function that puts every number back as it was. Invalid patches are skipped. */
export function applyPatches(patches: readonly DataPatch[]): () => void {
  const undo: { obj: Record<string | number, unknown>; key: string | number; was: unknown; had: boolean }[] = [];
  // whole entries first (the data editor), so a number patch to the same entry lands on the new one
  const entityUndo: (() => void)[] = [];
  for (const p of patches) {
    if (!isEntityPatch(p) || !validPatch(p)) continue;
    const next = JSON.parse(p.value as string) as Record<string, unknown>;
    for (const root of roots(p.file, p.id)) entityUndo.push(replaceEntity(root, structuredClone(next)));
  }
  for (const p of patches) {
    if (isEntityPatch(p) || !validPatch(p)) continue;
    const sw = isSwitch(p);
    const value = sw ? p.value === 1 : p.value;
    for (const at of locateAll(p)) {
      if (!at.rest.length) {
        undo.push({ obj: at.obj, key: at.key, was: at.obj[at.key], had: Object.hasOwn(at.obj, at.key) });
        at.obj[at.key] = value;
        continue;
      }
      // a stat change the data does not have: make the missing levels (undone by removing the first one made)
      if (sw && !value) continue; // switching off what is not there
      undo.push({ obj: at.obj, key: at.key, was: undefined, had: false });
      let cur: Record<string | number, unknown> = {};
      at.obj[at.key] = cur;
      for (let i = 0; i < at.rest.length - 1; i++) {
        const next: Record<string | number, unknown> = {};
        cur[at.rest[i]] = next;
        cur = next;
      }
      cur[at.rest[at.rest.length - 1]] = value;
    }
  }
  return () => {
    for (let i = undo.length - 1; i >= 0; i--) {
      const u = undo[i];
      if (u.had) u.obj[u.key] = u.was;
      else delete u.obj[u.key];
    }
    for (let i = entityUndo.length - 1; i >= 0; i--) entityUndo[i]();
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
      if (NOT_TUNABLE.has(k) || (file === 'tuning' && depth === 0 && TUNING_LOCKED.has(k))) continue;
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
