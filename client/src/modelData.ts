import { MODELS_DATA } from '@arena/shared';
import type { CharacterData, HandData, ModelsFile, WeaponData } from '@arena/shared';
import { DEFAULT_CAPE_FIT } from './capeModels';
import { DEFAULT_WING_FIT } from './wingModels';
import { MODELS, bumpModelData } from './riggedModels';
import type { ModelDef } from './riggedModels';
import { WEAPONS } from './weaponModels';
import type { HandHold, WeaponDef } from './weaponModels';

/**
 * shared/data/models.json over the model registry. The registry (riggedModels.ts MODELS, weaponModels.ts WEAPONS) keeps the numbers
 * the code was written with; `applyModelData` writes the file's numbers over them (the file is in degrees, the registry in radians) and
 * is called once at start and again whenever a dev changes one on the Models page. A model or weapon the file does not list stays as
 * the code has it, and a number the file lacks stays too. `codeDefaults` is what the code says before any of that (the generator
 * scripts/gen-models.ts writes it out as the starting file).
 */

const RAD = Math.PI / 180;
const rad = (d: number) => d * RAD;
const RADIAN_POSE = new Set(['armRest', 'elbow', 'armIn', 'legIn', 'castR', 'castL', 'swingArc']);

type Snapshot = { characters: Record<string, ModelDef>; weapons: Record<string, WeaponDef> };
let defaults: Snapshot | null = null;

/** The registry as the code has it, copied once before the first apply. */
function snapshot(): Snapshot {
  defaults ??= structuredClone({ characters: MODELS, weapons: WEAPONS }) as unknown as Snapshot;
  return defaults;
}

export interface CodeDefaults {
  characters: Record<string, ModelDef & { cape: Record<string, number>; wings: Record<string, number>; style?: Record<string, number> }>;
  weapons: Record<string, WeaponDef>;
}
export function codeDefaults(): CodeDefaults {
  const s = snapshot();
  const characters: CodeDefaults['characters'] = {};
  for (const [id, m] of Object.entries(s.characters)) characters[id] = { ...m, cape: { ...DEFAULT_CAPE_FIT, ...(m.cape ?? {}) } as unknown as Record<string, number>, wings: { ...DEFAULT_WING_FIT, ...(m.wings ?? {}) } as unknown as Record<string, number>, style: (m.pose?.style ?? {}) as Record<string, number> };
  return { characters, weapons: s.weapons };
}

const hold = (h: HandData, was: HandHold): HandHold => ({ ...was, rot: [rad(h.rot[0]), rad(h.rot[1]), rad(h.rot[2])], pos: [h.pos[0], h.pos[1], h.pos[2]], lift: rad(h.lift), out: rad(h.out) });

function applyCharacter(def: ModelDef, was: ModelDef, c: CharacterData): void {
  if (c.pose || c.style) {
    const pose: NonNullable<ModelDef['pose']> = { ...(was.pose ?? {}) };
    for (const [k, v] of Object.entries(c.pose ?? {})) (pose as Record<string, unknown>)[k] = RADIAN_POSE.has(k) ? rad(v) : v;
    if (c.style) pose.style = { ...(was.pose?.style ?? {}), ...c.style } as NonNullable<ModelDef['pose']>['style'];
    def.pose = pose;
  }
  if (c.helm && was.helm) def.helm = { ...c.helm };
  if (c.cape) def.cape = { ...(was.cape ?? {}), ...c.cape };
  if (c.wings) def.wings = { ...(was.wings ?? {}), ...c.wings };
}

function applyWeapon(def: WeaponDef, was: WeaponDef, w: WeaponData): void {
  def.right = hold(w.right, was.right);
  if (w.left && was.left) def.left = hold(w.left, was.left);
  def.mid = w.mid;
  if (w.hold && was.hold) {
    const t = (a: number[]) => ({ x: rad(a[0]), z: rad(a[1]), e: rad(a[2]) });
    def.hold = { ...was.hold, r: t(w.hold.r), l: t(w.hold.l), walk: w.hold.walk, arc: w.hold.arc, elbowArc: w.hold.elbowArc };
  }
  if (w.rest && was.rest) def.rest = { ...was.rest, rot: [rad(w.rest.rot[0]), rad(w.rest.rot[1]), rad(w.rest.rot[2])] };
}

export function applyModelData(data: ModelsFile = MODELS_DATA): void {
  const base = snapshot();
  for (const [id, c] of Object.entries(data.characters)) if (MODELS[id] && base.characters[id]) applyCharacter(MODELS[id], base.characters[id], c);
  for (const [id, w] of Object.entries(data.weapons)) if (WEAPONS[id] && base.weapons[id]) applyWeapon(WEAPONS[id], base.weapons[id], w);
  bumpModelData();
}

/** The bone adjustments of a model in radians, with the size, for the animator (null: the model has none). */
export function boneAdjust(modelId: string): Record<string, { rx: number; ry: number; rz: number; size: number }> | null {
  const b = MODELS_DATA.characters[modelId]?.bones;
  if (!b) return null;
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { rx: rad(v.rx), ry: rad(v.ry), rz: rad(v.rz), size: v.size }]));
}

/** Where a kind of cosmetic sits relative to where the model builder put it. */
export function slotPlacement(slot: string): { x: number; y: number; z: number; scale: number; rotY: number } {
  const s = MODELS_DATA.cosmetics[slot];
  return s ? { ...s, rotY: rad(s.rotY) } : { x: 0, y: 0, z: 0, scale: 1, rotY: 0 };
}
