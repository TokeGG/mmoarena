import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { fetchModel } from './modelPack';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { ClassId } from '@arena/shared';
import { preloadWeaponModels, weaponModelVersion } from './weaponModels';
import { preloadCapeModel, capeModelVersion } from './capeModels';
import { preloadWingModel, wingModelVersion } from './wingModels';
import type { WingFit } from './wingModels';
import type { CapeFit } from './capeModels';
import { ClipAnimator } from './riggedClips';
import type { ClipOpts } from './riggedClips';
import type { RigPoseInput, ArmHold, RigStyle } from './riggedPose';

/**
 * Registry and loader for rigged (skinned) character models, written by scripts/rig-model.mjs (see DEVELOPING.md,
 * "Character models"). To give another class or spec its own model: add a ModelDef to MODELS, point CLASS_MODEL at it
 * (optionally per weapon kind, i.e. per spec), and rig the GLB. Until a model has loaded (or if it fails to load) the
 * class keeps its procedural model; `modelVersion()` changes whenever the set of loaded models does, so scenes rebuild.
 */

export interface ModelDef {
  url: string;
  /** Optional texture overrides, applied to the GLB's materials by name ("body", "axe"): drop the file in public/models and it is picked up. */
  textures?: Record<string, { map?: string; emissiveMap?: string; emissive?: number }>;
  /** Weapons are the model's own (an axe held in the fist): the spec weapons are not attached. */
  ownWeapon?: boolean;
  /** Where the shared cape cosmetics (capeModels.ts) hang on this model, measured against its torso: overrides on top of the defaults computed from the rig metadata. */
  cape?: Partial<CapeFit>;
  /**
   * Sub-meshes (`part_body__<name>`) that already are a cloak: a cloak cosmetic recolours their back half (robeBack.ts) instead of
   * hanging the shared cape over them. The mage's robe has a hood and a back that fall like one.
   */
  robeBack?: string[];
  /** Which way the model faces along the file's z axis in its rest pose (default +1; the Old Wizard's file faces -z: his beard hangs at lower z than his head). */
  robeFront?: 1 | -1;
  /** Where the shared wings (wingModels.ts) grow on this model: overrides on top of the defaults computed from the rig metadata. */
  wings?: Partial<WingFit>;
  /**
   * The model's own helm stays on when a head cosmetic is worn: the cosmetic is fitted on top of it instead (crowns above the crest,
   * horns over the helm's own). `helm` measures that helm in head-anchor units (head centre at y = 0.99): where its crest ends, its
   * skull radius and the brow line, which is what every head cosmetic is placed against.
   */
  keepHead?: boolean;
  /** The model's own head mesh is hidden and models.ts builds a head in its place (sentinelHead). */
  ownHead?: boolean;
  helm?: { top: number; r: number; brow: number };
  /** The helm's own horns, as a region of its head mesh (model space): a horns cosmetic cuts them away and grows its own in their place. */
  helmHorns?: { yMin: number; xMin: number };
  /**
   * The model brings its own animation clips (scripts/prep-character.mjs) and the skeleton hierarchy stays intact: it is driven by a
   * THREE.AnimationMixer (riggedClips.ts) instead of procedural bone rotations. The value tunes the clips; the bone names the
   * cosmetics anchor to come from the file (rig.bones: canonical name -> the file's bone name).
   */
  clips?: ClipOpts;
  /** Sub-meshes (the part after `__` in their names) that armor dyes tint; the others (skin, beard) keep their colours. Default: all. */
  dye?: string[];
  /** Animation tuning. */
  pose?: { armRest?: number; elbow?: number; stride?: number; rightSwing?: number; armIn?: number; legIn?: number; castR?: number; castL?: number; swingArc?: number; /** How the class carries itself (riggedPose.ts RigStyle). */ style?: RigStyle };
}

/** The warrior is heavy and braced: short bounce, a stiff chest, arms that stay near the weapon, knees that give hard on a landing. */
const KNIGHT_STYLE: RigStyle = { bounce: 0.8, sway: 0.7, lean: 0.75, arms: 0.8, landing: 1.35, tuck: 0.8, cast: 'brace', strike: 'slash' };
/** The rogue is low and quick: a standing crouch, the elbows tucked, a strong lean into the run, a tight tuck in the air, stabs and close casting. */
const ASSASSIN_STYLE: RigStyle = { bounce: 1.1, sway: 1.25, lean: 1.5, crouch: 0.16, arms: 0.7, guard: 0.3, landing: 1.1, tuck: 1.3, cast: 'conceal', strike: 'stab' };
/** The priest is upright and gliding: little bounce, a long soft sway, a slow hover, a floaty jump, a raised staff in a cast and a two-handed smite. */
const SENTINEL_STYLE: RigStyle = { bounce: 0.45, sway: 1.3, lean: 0.5, arms: 0.55, float: 1, landing: 0.7, tuck: 0.65, cast: 'raise', strike: 'smite' };

export const MODELS: Record<string, ModelDef> = {
  knight: { url: '/models/warrior.glb', keepHead: true, helm: { top: 1.3, r: 0.165, brow: 1.03 }, helmHorns: { yMin: 2.1, xMin: 0.07 }, pose: { armRest: -0.1, elbow: 0.12, stride: 0.55, style: KNIGHT_STYLE }, cape: { tilt: -0.08, sy: 0.95 } },
  // the mage's Old Wizard: already rigged with real clips (idle / walk / run / attack / death), see scripts/prep-character.mjs
  wizard: { url: '/models/mage-wizard.glb', clips: { windup: 0.4, deathHold: 1.0, posture: { chest: 0.2, neck: 0.22, head: 0.08, run: 0.5 } }, dye: ['robe'],
    // a cloak recolours the back of his own robe (robeBack); this fit is only where ribbons and the rift hang
    robeBack: ['robe'],
    robeFront: -1,
    cape: { tilt: -0.12, sx: 1.3, sy: 1.1, sz: 1.0, z: 0.12 },
    // the pair grows out of the upper back, smaller than the default so the span is about 1.7 times the shoulders
    wings: { scale: 0.4, z: 0.22, y: 0.58, sx: 1 } },
  // the rogue's hooded assassin (rigged by scripts/rig-model.mjs from an unrigged mesh): the hood is part of the head and stays under head cosmetics
  assassin: { url: '/models/rogue.glb', keepHead: true, helm: { top: 1.15, r: 0.15, brow: 1.03 }, pose: { armRest: -0.1, elbow: 0.15, stride: 0.6, armIn: 0.3, style: ASSASSIN_STYLE }, cape: { tilt: -0.08, sy: 0.95 } },
  // the priest's Abyssal Sentinel (rigged by scripts/rig-model.mjs from an unrigged mesh): the horned helm is part of the head and stays under head cosmetics
  sentinel: { url: '/models/priest.glb', keepHead: true, ownHead: true, helm: { top: 1.19, r: 0.15, brow: 1.03 }, pose: { armRest: -0.1, elbow: 0.15, stride: 0.35, armIn: 0.3, castR: -0.35, castL: -1.1, swingArc: -1.6, rightSwing: 0.3, style: SENTINEL_STYLE }, cape: { tilt: -0.08, sy: 0.95 } },
  // already-rigged brute with its own axe (scripts/convert-skinned.mjs); drop a better texture next to the GLB and list it under `textures` to override
  brute: { url: '/models/warrior-brute.glb', ownWeapon: true, pose: { armRest: -0.1, elbow: 0.2, stride: 0.5, rightSwing: 0.3, armIn: 0.6, legIn: 0.08 } },
};

export interface ClassModels {
  default: string;
  /** By weapon kind ('dual', 'twohand', 'polearm', ...), which is what tells the specs apart on the client. */
  byWeapon?: Record<string, string>;
  /** Alternative model ids a player or the owner may pick for preview (?warriormodel=, localStorage "arena.model.<class>"). */
  alternatives?: string[];
}

export const CLASS_MODEL: Partial<Record<ClassId, ClassModels>> = {
  // the gold knight for every warrior spec (dual swords, greatsword, polearm); the brute with its own axe is only an optional alternative (?warriormodel=brute)
  warrior: { default: 'knight', alternatives: ['brute'] },
  // every mage spec wears the Old Wizard; the spec staff (weaponModels.ts) and the robe tint tell the specs apart
  mage: { default: 'wizard' },
  // every rogue spec wears the hooded assassin with twin daggers in both hands
  rogue: { default: 'assassin' },
  // every priest spec wears the Abyssal Sentinel; the staff (weaponModels.ts) tells the specs apart
  priest: { default: 'sentinel' },
};

export interface RigMeta {
  height: number;
  headCenter: [number, number, number];
  headR: number;
  shoulderJoint: [number, number, number];
  chestBackZ: number;
  torsoW: number;
  deadY?: number;
  skin?: number;
  /** Clip models: the file's names for the canonical bones, and how its own staff was held (axis, fist offset from the grip bone, in character space). */
  bones?: Record<string, string>;
  hold?: { axis: [number, number, number]; grip: [number, number, number]; length: number; along: number };
  headTop?: number;
  [k: string]: unknown;
}

export interface RigAsset {
  id: string;
  def: ModelDef;
  scene: THREE.Group;
  meta: RigMeta;
  /** The file's animation clips (clip models only), shared by every unit. */
  clips?: THREE.AnimationClip[];
}

/** What drives a unit's bones each frame: the procedural RigAnimator or the ClipAnimator. */
export interface RigDriver {
  hold: ArmHold | null;
  lungeZ: number;
  /** 0..1 grip of the second hand on a shoulder-carried weapon (RigAnimator only). */
  readonly grip?: number;
  /** The driver plays the death itself (the Character leaves the body upright). */
  readonly ownDeath?: boolean;
  /** A cast (Character.cast) plays an animation: the clip models. */
  readonly castable?: boolean;
  update(p: RigPoseInput): void;
}

const assets = new Map<string, RigAsset>();
let version = 0;

/** Changes whenever a model finishes loading. Scenes compare it to the version their characters were built with. */
/** Bumped when the Models page's numbers (shared/data/models.json) are merged again: scenes rebuild their characters. */
let dataRev = 0;
export const bumpModelData = (): void => void dataRev++;
export const modelVersion = () => version + dataRev + weaponModelVersion() + capeModelVersion() + wingModelVersion(); // the weapon, cape and wing models count too

const queryModel = (cls: string): string | null => {
  try {
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get(`${cls}model`) : null;
    if (q) return q;
  } catch {
    /* no location */
  }
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(`arena.model.${cls}`) : null;
  } catch {
    return null;
  }
};

/** The model id a class (and weapon kind) is meant to wear, or undefined for the procedural model. */
export function modelIdFor(classId: ClassId, weapon?: string): string | undefined {
  const c = CLASS_MODEL[classId];
  if (!c) return undefined;
  const picked = queryModel(classId);
  if (picked === 'procedural') return undefined;
  if (picked && (picked === c.default || c.alternatives?.includes(picked)) && MODELS[picked]) return picked;
  return (weapon && c.byWeapon?.[weapon]) || c.default;
}

/** The loaded asset for a class, or undefined while it is still loading (or failed): the caller then builds the procedural model. */
export function riggedAssetFor(classId: ClassId, weapon?: string): RigAsset | undefined {
  const id = modelIdFor(classId, weapon);
  return id ? assets.get(id) : undefined;
}

function finish(id: string, def: ModelDef, gltf: { scene: THREE.Group; animations: THREE.AnimationClip[] }): RigAsset {
  const scene = gltf.scene;
  let meta: RigMeta | undefined;
  scene.traverse((o) => {
    if (o.userData?.rig && !meta) meta = o.userData.rig as RigMeta;
  });
  if (!meta) throw new Error(`${id}: no rig metadata (was it written by scripts/rig-model.mjs?)`);
  scene.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh) {
      o.frustumCulled = false;
      o.castShadow = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m instanceof THREE.MeshStandardMaterial) m.side = THREE.DoubleSide;
    }
  });
  const asset: RigAsset = { id, def, scene, meta };
  if (def.clips) asset.clips = gltf.animations;
  assets.set(id, asset);
  version++;
  return asset;
}

/** Parse a GLB that is already in memory (tests, or a fetched ArrayBuffer). */
export function registerRiggedModel(id: string, data: ArrayBuffer, def: ModelDef = MODELS[id] ?? { url: '' }): Promise<RigAsset> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(data, '', (g) => {
      try {
        resolve(finish(id, def, g));
      } catch (e) {
        reject(e);
      }
    }, reject);
  });
}

export function forgetRiggedModels() {
  assets.clear();
  version++;
}

let settled = false;
/**
 * True once the character models have finished loading (or failed, or took too long). Until then the scene keeps characters
 * hidden instead of showing the procedural stand-ins, so a refresh does not flash the old models for a few seconds.
 */
export const modelsSettled = (): boolean => settled;

/** Start loading every registered model; resolves when all have finished (failures are logged and leave the procedural model in place). */
export function preloadRiggedModels(): Promise<void> {
  window.setTimeout(() => { settled = true; }, 12000); // never keep characters hidden forever on a slow link
  const loader = new GLTFLoader();
  const tex = new THREE.TextureLoader();
  const weapons = Promise.all([preloadWeaponModels(), preloadCapeModel(), preloadWingModel()]).then(() => undefined); // the weapon and cape models load alongside the characters that wear them
  // an alternative that nobody picked (the brute, 1.3 MB) is not downloaded: only defaults, per-weapon models and the preview choice
  const wanted = (id: string) => Object.entries(CLASS_MODEL).some(([cls, c]) => !!c && (c.default === id || Object.values(c.byWeapon ?? {}).includes(id) || queryModel(cls as ClassId) === id));
  return Promise.all(
    Object.entries(MODELS).filter(([id]) => wanted(id)).map(
      ([id, def]) =>
        fetchModel(def.url)
          .then(
            (data) =>
              new Promise<void>((resolve) => {
                loader.parse(data, '', (g) => {
                  try {
                    const asset = finish(id, def, g);
                    applyTextureOverrides(asset, tex);
                  } catch (e) {
                    console.warn(`model ${id}:`, e);
                  }
                  resolve();
                }, (e) => {
                  console.warn(`model ${id} could not be read, keeping the procedural model`, e);
                  resolve();
                });
              }),
          )
          .catch((e) => console.warn(`model ${id} failed to load, keeping the procedural model`, e)),
    ),
  ).then(() => weapons).finally(() => { settled = true; });
}

/** Optional per-material texture files declared in the registry (an owner can drop one next to the GLB later). */
function applyTextureOverrides(asset: RigAsset, loader: THREE.TextureLoader) {
  const over = asset.def.textures;
  if (!over) return;
  asset.scene.traverse((o) => {
    if (!(o instanceof THREE.SkinnedMesh)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      const t = over[m.name];
      if (!t || !(m instanceof THREE.MeshStandardMaterial)) continue;
      const load = (url: string, apply: (tx: THREE.Texture) => void) => {
        loader.load(url, (tx) => {
          tx.colorSpace = THREE.SRGBColorSpace;
          tx.flipY = false;
          apply(tx);
          m.needsUpdate = true;
          version++;
        }, undefined, () => undefined);
      };
      if (t.map) load(t.map, (tx) => (m.map = tx));
      if (t.emissiveMap) load(t.emissiveMap, (tx) => ((m.emissiveMap = tx), (m.emissive = new THREE.Color(t.emissive ?? 0xffffff))));
    }
  });
}

export interface RigInstance {
  root: THREE.Group;
  bones: Record<string, THREE.Bone>;
  /** Skinned meshes per cosmetic part name (body, head, shoulders, back). */
  parts: Record<string, THREE.SkinnedMesh[]>;
  /** Clip models: the unit's own animator (already on its idle pose, so the rest positions below are measured from that pose). */
  anim?: ClipAnimator;
  /** Rest-pose world position of every bone, in character units. */
  rest: Record<string, THREE.Vector3>;
  attach: Record<string, THREE.Object3D>;
}

/** A private skeleton for one unit: geometry, materials and textures stay shared with the asset. */
export function instantiate(asset: RigAsset): RigInstance {
  if (asset.clips) return instantiateClips(asset);
  const src = cloneSkinned(asset.scene) as THREE.Group;
  const root = new THREE.Group();
  root.name = 'rigged';
  const bones: Record<string, THREE.Bone> = {};
  const attach: Record<string, THREE.Object3D> = {};
  const parts: Record<string, THREE.SkinnedMesh[]> = {};
  const meshes: THREE.SkinnedMesh[] = [];
  src.traverse((o) => {
    if (o instanceof THREE.Bone) bones[o.name] = o;
    else if (o.name.startsWith('attach_')) attach[o.name] = o;
    if (o instanceof THREE.SkinnedMesh) meshes.push(o);
  });
  for (const m of meshes) {
    m.removeFromParent();
    (parts[m.name.replace(/^part_/, '').split('__')[0]] ??= []).push(m);
  }
  const skeletonRoot = src.children.find((c) => c instanceof THREE.Bone) ?? bones.root;
  root.add(skeletonRoot);
  root.updateMatrixWorld(true);
  const rest: Record<string, THREE.Vector3> = {};
  for (const [n, b] of Object.entries(bones)) rest[n] = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
  return { root, bones, parts, rest, attach };
}

/**
 * Clip models keep their whole node hierarchy (the skeleton sits under scaled and rotated ancestors that the clips rely on), so the
 * clone is added as it is under a body group. Bones are listed under the file's names and under the canonical ones (meta.bones);
 * the sub-meshes are named `part_<slot>__<what>` like the procedural-bone models'.
 */
function instantiateClips(asset: RigAsset): RigInstance {
  const src = cloneSkinned(asset.scene) as THREE.Group;
  const root = new THREE.Group();
  root.name = 'rigged';
  const body = new THREE.Group();
  body.name = 'body';
  body.add(src);
  root.add(body);
  const bones: Record<string, THREE.Bone> = {};
  const parts: Record<string, THREE.SkinnedMesh[]> = {};
  src.traverse((o) => {
    if (o instanceof THREE.Bone) bones[o.name] = o;
    if (o instanceof THREE.SkinnedMesh) (parts[o.name.replace(/^part_/, '').split('__')[0]] ??= []).push(o);
  });
  for (const [canon, name] of Object.entries(asset.meta.bones ?? {})) if (bones[name]) bones[canon] = bones[name];
  const anim = new ClipAnimator(body, asset.clips!, asset.def.clips);
  anim.bones = bones;
  root.updateMatrixWorld(true);
  // a model that stands beside its origin (the wizard's hips are 0.17 to the left of it) is moved onto it: the unit turns, aims and wears
  // its cosmetics about the middle of its body, not about a point next to it
  const hips = bones.hips;
  const cx = hips ? new THREE.Vector3().setFromMatrixPosition(hips.matrixWorld).x : 0;
  if (Math.abs(cx) > 0.02) {
    body.position.x = -cx;
    root.updateMatrixWorld(true);
  }
  root.userData.centerX = Math.abs(cx) > 0.02 ? cx : 0;
  const rest: Record<string, THREE.Vector3> = {};
  for (const [n, b] of Object.entries(bones)) rest[n] = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
  return { root, bones, parts, rest, attach: {}, anim };
}
