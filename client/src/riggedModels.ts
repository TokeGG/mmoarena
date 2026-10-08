import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { ClassId } from '@arena/shared';

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
  /** Animation tuning. */
  pose?: { armRest?: number; elbow?: number; stride?: number; rightSwing?: number };
}

export const MODELS: Record<string, ModelDef> = {
  knight: { url: '/models/warrior.glb', pose: { armRest: -0.1, elbow: 0.12, stride: 0.55 } },
  // already-rigged brute with its own axe (scripts/convert-skinned.mjs); drop a better texture next to the GLB and list it under `textures` to override
  brute: { url: '/models/warrior-brute.glb', ownWeapon: true, pose: { armRest: -0.1, elbow: 0.2, stride: 0.5, rightSwing: 0.3 } },
};

export interface ClassModels {
  default: string;
  /** By weapon kind ('dual', 'twohand', 'polearm', ...), which is what tells the specs apart on the client. */
  byWeapon?: Record<string, string>;
  /** Alternative model ids a player or the owner may pick for preview (?warriormodel=, localStorage "arena.model.<class>"). */
  alternatives?: string[];
}

export const CLASS_MODEL: Partial<Record<ClassId, ClassModels>> = {
  // the knight (helm on) for Warbringer (dual swords) and Rampager (greatsword); the brute with its axe for the Barbarian (polearm spec)
  warrior: { default: 'knight', byWeapon: { polearm: 'brute' }, alternatives: ['brute'] },
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
  [k: string]: unknown;
}

export interface RigAsset {
  id: string;
  def: ModelDef;
  scene: THREE.Group;
  meta: RigMeta;
}

const assets = new Map<string, RigAsset>();
let version = 0;

/** Changes whenever a model finishes loading. Scenes compare it to the version their characters were built with. */
export const modelVersion = () => version;

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

function finish(id: string, def: ModelDef, gltf: { scene: THREE.Group }): RigAsset {
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
  const asset = { id, def, scene, meta };
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

/** Start loading every registered model; resolves when all have finished (failures are logged and leave the procedural model in place). */
export function preloadRiggedModels(): Promise<void> {
  const loader = new GLTFLoader();
  const tex = new THREE.TextureLoader();
  return Promise.all(
    Object.entries(MODELS).map(
      ([id, def]) =>
        new Promise<void>((resolve) => {
          loader.load(
            def.url,
            (g) => {
              try {
                const asset = finish(id, def, g);
                applyTextureOverrides(asset, tex);
              } catch (e) {
                console.warn(`model ${id}:`, e);
              }
              resolve();
            },
            undefined,
            (e) => {
              console.warn(`model ${id} failed to load, keeping the procedural model`, e);
              resolve();
            },
          );
        }),
    ),
  ).then(() => undefined);
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
  /** Rest-pose world position of every bone, in character units. */
  rest: Record<string, THREE.Vector3>;
  attach: Record<string, THREE.Object3D>;
}

/** A private skeleton for one unit: geometry, materials and textures stay shared with the asset. */
export function instantiate(asset: RigAsset): RigInstance {
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
