import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CUSTOM_MODEL_LIMIT_BYTES, customModels, setCustomModels } from '@arena/shared';

/**
 * Models the owner or a dev uploaded on the Models page (server/src/custommodels.ts keeps them; they are served at /models/<file>).
 * This file lists them, loads them on demand and shapes them to fit: a body part is scaled to the size of that part and centred, a
 * weapon is stood along y at the length of the one it replaces, and the triangles of the game's own model that belong to a part are
 * cut away when the part is replaced. Nothing here touches a match.
 */

interface Loaded { scene: THREE.Group; animations: THREE.AnimationClip[] }
const loaded = new Map<string, Loaded>();
const pending = new Map<string, Promise<void>>();
const failed = new Map<string, string>();
let version = 0;

/** Changes whenever an uploaded model finishes loading (added to riggedModels' `modelVersion`, so scenes rebuild their characters). */
export const customModelVersion = () => version;

/** The loaded model of an upload (starting its download the first time it is asked for), or null while it is still coming. */
export function customScene(file: string): THREE.Group | null {
  return customGltf(file)?.scene ?? null;
}
export function customGltf(file: string): Loaded | null {
  const got = loaded.get(file);
  if (got) return got;
  if (!pending.has(file) && !failed.has(file)) {
    pending.set(
      file,
      fetch(`/models/${file}`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`the server has no ${file}`))))
        .then((buf) => new Promise<void>((res, rej) => new GLTFLoader().parse(buf, '', (g) => {
          g.scene.traverse((o) => {
            if (o instanceof THREE.Mesh) o.castShadow = true;
          });
          loaded.set(file, { scene: g.scene, animations: g.animations });
          version++;
          res();
        }, rej)))
        .catch((e) => void failed.set(file, (e as Error).message ?? 'it could not be read'))
        .finally(() => pending.delete(file)),
    );
  }
  return null;
}
/** Why an upload could not be used (empty when it has not failed). */
export const customModelError = (file: string): string => failed.get(file) ?? '';
export function forgetCustomModel(file: string): void {
  loaded.delete(file);
  failed.delete(file);
  version++;
}

const token = (): string => {
  try {
    return localStorage.getItem('arena.session.v1') ?? ''; // accountUi.ts SESSION_KEY
  } catch {
    return '';
  }
};

let listed = false;
/** Ask the server for the uploaded models and offer them in every model list. True when the list changed. */
export async function loadCustomModelList(force = false): Promise<boolean> {
  if (listed && !force) return false;
  listed = true;
  try {
    const r = await fetch('/api/models/custom', { cache: 'no-store' });
    if (!r.ok) return false;
    const j = (await r.json()) as { models?: { file: string; label: string }[] };
    const before = JSON.stringify(customModels());
    setCustomModels(Array.isArray(j.models) ? j.models : []);
    return before !== JSON.stringify(customModels());
  } catch {
    return false;
  }
}

const toBase64 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

export type UploadResult = { ok: true; file: string } | { ok: false; text: string };

export async function uploadModel(f: File): Promise<UploadResult> {
  if (!/\.glb$/i.test(f.name)) return { ok: false, text: 'Use a .glb file (a binary glTF).' };
  if (f.size > CUSTOM_MODEL_LIMIT_BYTES) return { ok: false, text: `That file is too big (${(f.size / 1e6).toFixed(1)} MB; the limit is ${CUSTOM_MODEL_LIMIT_BYTES / 1e6} MB). Reduce its textures or polygons.` };
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const r = await fetch('/api/models/custom', { method: 'POST', headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: f.name, data: toBase64(bytes) }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; file?: string; text?: string };
    if (!r.ok || !j.ok || !j.file) return { ok: false, text: j.text ?? 'The upload did not work.' };
    await loadCustomModelList(true);
    return { ok: true, file: j.file };
  } catch {
    return { ok: false, text: 'The server could not be reached.' };
  }
}

export async function deleteModel(file: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/models/custom/${encodeURIComponent(file.replace(/^custom\//, ''))}`, { method: 'DELETE', headers: { authorization: `Bearer ${token()}` } });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; text?: string };
    if (!r.ok || !j.ok) return j.text ?? 'That did not work.';
    forgetCustomModel(file);
    await loadCustomModelList(true);
    return null;
  } catch {
    return 'The server could not be reached.';
  }
}

// ------------------------------------------------------------------ shaping

/** A copy that is plain meshes (a skinned mesh is taken as it stands in its rest pose), sharing geometry and materials with the original. */
function plainCopy(src: THREE.Object3D): THREE.Group {
  const out = new THREE.Group();
  src.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(src.matrixWorld).invert();
  src.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const m = new THREE.Mesh(o.geometry, o.material);
    m.castShadow = true;
    new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld).decompose(m.position, m.quaternion, m.scale);
    out.add(m);
  });
  return out;
}

const boxOf = (o: THREE.Object3D): THREE.Box3 => new THREE.Box3().setFromObject(o);

/** A body part: centred on its own middle and scaled so its largest side is `size` yards. */
export function fittedPart(src: THREE.Object3D, size: number): THREE.Group {
  const inner = plainCopy(src);
  const box = boxOf(inner);
  const dim = box.getSize(new THREE.Vector3());
  const k = size / Math.max(dim.x, dim.y, dim.z, 1e-6);
  const c = box.getCenter(new THREE.Vector3());
  inner.position.set(-c.x * k, -c.y * k, -c.z * k);
  inner.scale.setScalar(k);
  const out = new THREE.Group();
  out.add(inner);
  return out;
}

/** A weapon: its longest side stood along +y, `length` yards long, with its bottom end at the origin (the fist) and centred across. */
export function fittedWeapon(src: THREE.Object3D, length: number): THREE.Group {
  const inner = plainCopy(src);
  const dim = boxOf(inner).getSize(new THREE.Vector3());
  const stand = new THREE.Group();
  stand.add(inner);
  if (dim.x >= dim.y && dim.x >= dim.z) stand.rotation.z = Math.PI / 2;
  else if (dim.z >= dim.y && dim.z >= dim.x) stand.rotation.x = -Math.PI / 2;
  const box = boxOf(stand);
  const size = box.getSize(new THREE.Vector3());
  const k = length / Math.max(size.y, 1e-6);
  const c = box.getCenter(new THREE.Vector3());
  const out = new THREE.Group();
  stand.scale.setScalar(k);
  stand.position.set(-c.x * k, -box.min.y * k, -c.z * k);
  out.add(stand);
  return out;
}

const masked = new WeakMap<THREE.BufferGeometry, Map<string, THREE.BufferGeometry>>();

/**
 * The geometry without the triangles that belong to the named bones (where, on average, more than half of a triangle's weight sits on
 * them). The attributes are shared with the original, only the index is new, so every unit with the same cut shares one geometry.
 */
export function maskedGeometry(geo: THREE.BufferGeometry, boneNames: readonly string[], hide: ReadonlySet<string>): THREE.BufferGeometry {
  const si = geo.getAttribute('skinIndex');
  const sw = geo.getAttribute('skinWeight');
  if (!si || !sw || !hide.size) return geo;
  const key = [...hide].sort().join(',');
  let per = masked.get(geo);
  const got = per?.get(key);
  if (got) return got;
  const hidden = boneNames.map((n) => hide.has(n));
  const vertexHidden = (v: number): number => {
    let w = 0;
    for (let k = 0; k < 4; k++) if (hidden[si.getComponent(v, k)]) w += sw.getComponent(v, k);
    return w;
  };
  const count = geo.index ? geo.index.count : geo.getAttribute('position').count;
  const at = (i: number) => (geo.index ? geo.index.getX(i) : i);
  const ranges = geo.groups.length ? geo.groups.map((g) => ({ start: g.start, count: g.count, materialIndex: g.materialIndex })) : [{ start: 0, count, materialIndex: undefined as number | undefined }];
  const kept: number[] = [];
  const groups: { start: number; count: number; materialIndex: number }[] = [];
  for (const r of ranges) {
    const from = kept.length;
    for (let i = r.start; i + 2 < r.start + r.count; i += 3) {
      const a = at(i), b = at(i + 1), c = at(i + 2);
      if ((vertexHidden(a) + vertexHidden(b) + vertexHidden(c)) / 3 > 0.5) continue;
      kept.push(a, b, c);
    }
    if (r.materialIndex !== undefined) groups.push({ start: from, count: kept.length - from, materialIndex: r.materialIndex });
  }
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes)) out.setAttribute(name, attr);
  out.setIndex(kept);
  for (const g of groups) out.addGroup(g.start, g.count, g.materialIndex);
  if (!per) masked.set(geo, (per = new Map()));
  per.set(key, out);
  return out;
}
