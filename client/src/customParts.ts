import * as THREE from 'three';
import { MODELS_DATA, PART_SIZE } from '@arena/shared';
import { customScene, fittedPart, maskedGeometry } from './customModels';
import type { RigInstance, RigMeta } from './riggedModels';

/**
 * Body parts of the dev's own (models.json characters.<id>.parts.<bone>): an uploaded model is scaled to the size of the part, put at
 * the part's place on the skeleton, nudged and turned by the numbers of the part, and rides on its bone. When `hide` is on, the
 * triangles of the game's own model that belong to that bone are cut away so the new part replaces it instead of sitting inside it.
 * A part whose model has not loaded yet is skipped: the characters are rebuilt when it arrives.
 */

const CHILD: Record<string, string> = { hips: 'spine', spine: 'chest', chest: 'neck', neck: 'head', shoulder_l: 'upperarm_l', shoulder_r: 'upperarm_r', upperarm_l: 'forearm_l', upperarm_r: 'forearm_r', forearm_l: 'hand_l', forearm_r: 'hand_r', thigh_l: 'shin_l', thigh_r: 'shin_r', shin_l: 'foot_l', shin_r: 'foot_r' };
const rad = (d: number) => (d * Math.PI) / 180;

/** Where a part's middle is at rest (character space): between a bone and the next one, on the head's centre, a little below a hand and ahead of a foot. */
export function partAnchor(bone: string, rest: Record<string, THREE.Vector3>, meta: Pick<RigMeta, 'headCenter'>, centerX = 0): THREE.Vector3 | null {
  const p = rest[bone];
  if (!p) return null;
  if (bone === 'head') return new THREE.Vector3(meta.headCenter[0] - centerX, meta.headCenter[1], meta.headCenter[2]);
  const child = CHILD[bone] && rest[CHILD[bone]];
  if (child) return p.clone().lerp(child, 0.5);
  if (bone.startsWith('hand')) return p.clone().add(new THREE.Vector3(0, -0.07, 0));
  if (bone.startsWith('foot')) return p.clone().add(new THREE.Vector3(0, -0.04, 0.07));
  return p.clone();
}

export function applyCustomParts(b: { mats: THREE.MeshStandardMaterial[]; meshes: THREE.Mesh[] }, charId: string, inst: RigInstance, meta: RigMeta): void {
  const parts = MODELS_DATA.characters[charId]?.parts;
  if (!parts) return;
  const hide = new Set<string>();
  for (const [bone, fit] of Object.entries(parts)) {
    if (!fit.file) continue;
    const host = inst.bones[bone];
    const src = customScene(fit.file);
    const at = host && partAnchor(bone, inst.rest, meta, (inst.root.userData.centerX as number) ?? 0);
    if (!host || !src || !at) continue;
    if (fit.hide) hide.add(host.name);
    const holder = new THREE.Group();
    holder.name = `custom-part:${bone}`;
    new THREE.Matrix4().copy(host.matrixWorld).invert().multiply(new THREE.Matrix4().makeTranslation(at.x, at.y, at.z)).decompose(holder.position, holder.quaternion, holder.scale);
    const shaped = fittedPart(src, (PART_SIZE[bone] ?? 0.3) * fit.scale);
    shaped.position.set(fit.x, fit.y, fit.z);
    shaped.rotation.set(rad(fit.rx), rad(fit.ry), rad(fit.rz));
    shaped.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const own = (m: THREE.Material) => {
        const c = m.clone() as THREE.MeshStandardMaterial;
        c.userData.base = c.color?.clone();
        c.userData.glow = c.emissiveMap ? 1 : 0;
        b.mats.push(c);
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(own) : own(o.material);
      b.meshes.push(o);
    });
    holder.add(shaped);
    host.add(holder);
  }
  if (!hide.size) return;
  for (const list of Object.values(inst.parts)) for (const m of list) m.geometry = maskedGeometry(m.geometry, m.skeleton.bones.map((x) => x.name), hide);
}
