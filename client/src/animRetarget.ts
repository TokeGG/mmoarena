import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

/**
 * Animations from a file, played on the game's own characters. A .glb or .fbx with a skeleton and an animation (Mixamo and most
 * humanoid exports) is read, its bones are matched by name to the character's (hips, spine, chest, neck, head, shoulder / upperarm /
 * forearm / hand and thigh / shin / foot, left and right), and the clip is retargeted onto the character's own skeleton, so it moves
 * the way the clip does whatever size the model is. Used by the Models window to see how a model reacts, and by the characters to
 * play a clip in place of the built-in walk, run, swing, cast or jump.
 */

export const CANON = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulder_l', 'upperarm_l', 'forearm_l', 'hand_l', 'shoulder_r', 'upperarm_r', 'forearm_r', 'hand_r', 'thigh_l', 'shin_l', 'foot_l', 'thigh_r', 'shin_r', 'foot_r'] as const;

/** The canonical bone a name from another rig stands for, or null. */
export function canonicalOf(raw: string): string | null {
  let n = raw.toLowerCase().replace(/^.*[:|]/, '').replace(/^mixamorig/, '').replace(/^(bip001|bip01|bn_|b_|def-|def_|mch-|mch_|org-)/, '').replace(/[\s.\-]+/g, '_');
  if ((CANON as readonly string[]).includes(n)) return n;
  const side = /(^|_)(l|left)(_|$)|^left|left$|_l$|\.l$/.test(n) || /^l_/.test(n) ? 'l' : /(^|_)(r|right)(_|$)|^right|right$|_r$|\.r$/.test(n) || /^r_/.test(n) ? 'r' : '';
  n = n.replace(/^(left|right)_?/, '').replace(/_?(left|right)$/, '').replace(/^(l|r)_/, '').replace(/_(l|r)$/, '').replace(/(left|right)/, '');
  const base = n.replace(/_/g, '');
  const pair = (b: string) => (side ? `${b}_${side}` : null);
  if (/^(hips|pelvis|root|hip)$/.test(base)) return 'hips';
  if (/^(spine|spine0|spine1|spinelower|spinemid|abdomen)$/.test(base)) return 'spine';
  if (/^(spine2|spine3|chest|upperchest|spineupper|torso)$/.test(base)) return 'chest';
  if (/^(neck|neck1)$/.test(base)) return 'neck';
  if (/^(head)$/.test(base)) return 'head';
  if (/^(shoulder|clavicle|collar)$/.test(base)) return pair('shoulder');
  if (/^(arm|upperarm|uparm|armupper|upperarm1)$/.test(base)) return pair('upperarm');
  if (/^(forearm|lowerarm|armlower|elbow)$/.test(base)) return pair('forearm');
  if (/^(hand|wrist)$/.test(base)) return pair('hand');
  if (/^(upleg|upperleg|thigh|legupper)$/.test(base)) return pair('thigh');
  if (/^(leg|lowerleg|calf|shin|leglower|knee)$/.test(base)) return pair('shin');
  if (/^(foot|ankle)$/.test(base)) return pair('foot');
  return null;
}

export interface LoadedClip {
  /** What the file called it, for the list. */
  name: string;
  source: THREE.Object3D;
  clips: THREE.AnimationClip[];
}

/** Read a .glb, .gltf or .fbx the dev picked or dropped. Throws a readable message when it has no animation. */
export async function readAnimationFile(file: File): Promise<LoadedClip> {
  const buf = await file.arrayBuffer();
  const ext = file.name.toLowerCase().replace(/^.*\./, '');
  let source: THREE.Object3D;
  let clips: THREE.AnimationClip[];
  if (ext === 'fbx') {
    source = new FBXLoader().parse(buf, '');
    clips = (source as THREE.Object3D & { animations: THREE.AnimationClip[] }).animations ?? [];
  } else if (ext === 'glb' || ext === 'gltf') {
    const g = await new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>((res, rej) => new GLTFLoader().parse(buf, '', res as never, rej));
    source = g.scene;
    clips = g.animations;
  } else throw new Error('Use a .glb or .fbx file with a skeleton and an animation.');
  if (!clips.length) throw new Error('That file has no animation in it.');
  return { name: file.name.replace(/\.[a-z0-9]+$/i, ''), source, clips };
}

function skinnedOf(root: THREE.Object3D): THREE.SkinnedMesh | null {
  let found: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    if (!found && (o as THREE.SkinnedMesh).isSkinnedMesh) found = o as THREE.SkinnedMesh;
  });
  return found;
}

/** The skeleton's bone names by canonical name (the first bone of each kind). */
function boneNames(mesh: THREE.SkinnedMesh): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of mesh.skeleton.bones) {
    const c = canonicalOf(b.name);
    if (c && !out[c]) out[c] = b.name;
  }
  return out;
}

export interface Retargeted {
  clip: THREE.AnimationClip;
  /** Canonical bones the file and the character have in common. */
  matched: number;
  missing: string[];
}

/** The clip as the character's own skeleton would play it, matched by bone name. Null when too few bones are alike to move it. */
export function retarget(target: THREE.Object3D, loaded: LoadedClip, clipIndex = 0): Retargeted | null {
  const tm = skinnedOf(target);
  const sm = skinnedOf(loaded.source);
  if (!tm || !sm) return null;
  const tn = boneNames(tm);
  const sn = boneNames(sm);
  const names: Record<string, string> = {};
  const missing: string[] = [];
  for (const c of CANON) {
    if (tn[c] && sn[c]) names[tn[c]] = sn[c];
    else missing.push(c);
  }
  const matched = Object.keys(names).length;
  if (matched < 6) return null;
  const clip = SkeletonUtils.retargetClip(tm, sm, loaded.clips[Math.min(clipIndex, loaded.clips.length - 1)], { names, hip: sn.hips ?? 'hips', useFirstFramePosition: true, preserveBoneMatrix: false, preserveBonePositions: false } as never);
  return { clip, matched, missing };
}

/** The mixer that plays a retargeted clip on a character (the clip loops; `weight` 1 replaces what the built-in pose did to those bones). */
export function playOn(target: THREE.Object3D, clip: THREE.AnimationClip): { mixer: THREE.AnimationMixer; action: THREE.AnimationAction } {
  const mixer = new THREE.AnimationMixer(target);
  const action = mixer.clipAction(clip);
  action.play();
  return { mixer, action };
}
