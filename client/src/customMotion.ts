import * as THREE from 'three';
import { MODELS_DATA } from '@arena/shared';
import { customGltf } from './customModels';
import { retarget } from './animRetarget';

/**
 * Motions of the dev's own (models.json characters.<id>.anims.<stand|walk|run|swing|cast|jump>: an uploaded .glb whose first
 * animation clip is played in place of the built-in motion). The clip is retargeted onto the character's skeleton by bone name
 * (animRetarget.ts) and played on top of the built-in pose, so the bones it moves follow it and the rest keep the built-in motion.
 * Stand, walk, run and cast loop; a swing starts over each time one is made; a jump plays once from where it starts.
 */

export type Motion = 'stand' | 'walk' | 'run' | 'swing' | 'cast' | 'jump';
export const MOTIONS: [Motion, string][] = [['stand', 'Standing'], ['walk', 'Walking'], ['run', 'Running'], ['swing', 'Melee swing'], ['cast', 'Casting'], ['jump', 'Jumping']];

/** The motion a pose call is in (the same order the model view's buttons use). */
export function motionOf(s: { dead: boolean; swinging: boolean; air: number; casting: boolean; move: number }): Motion | null {
  if (s.dead) return null;
  if (s.swinging) return 'swing';
  if (s.air > 0.05) return 'jump';
  if (s.casting) return 'cast';
  return s.move > 0.75 ? 'run' : s.move > 0.05 ? 'walk' : 'stand';
}

export interface MotionPlayer {
  /** Advance the motion; true while an uploaded clip drives the bones this frame. `kick` changes whenever a swing or jump starts. */
  update(dt: number, mode: Motion | null, kick: number): boolean;
}

export function createMotion(root: THREE.Object3D, charId: string): MotionPlayer | null {
  const anims = MODELS_DATA.characters[charId]?.anims;
  if (!anims || !Object.values(anims).some(Boolean)) return null;
  let mixer: THREE.AnimationMixer | null = null;
  const actions = new Map<Motion, THREE.AnimationAction | null>();
  let current: THREE.AnimationAction | null = null;
  let lastMode: Motion | null = null;
  let lastKick = 0;
  const actionFor = (m: Motion): THREE.AnimationAction | null => {
    if (actions.has(m)) return actions.get(m) ?? null;
    const file = anims[m];
    const g = file ? customGltf(file) : null;
    if (!file) {
      actions.set(m, null);
      return null;
    }
    if (!g) return null; // still downloading: asked again next frame
    const r = retarget(root, { name: file, source: g.scene, clips: g.animations });
    let a: THREE.AnimationAction | null = null;
    if (r) {
      mixer ??= new THREE.AnimationMixer(root);
      a = mixer.clipAction(r.clip);
      if (m === 'swing' || m === 'jump') {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
    }
    actions.set(m, a);
    return a;
  };
  return {
    update(dt, mode, kick) {
      if (!mode) return false;
      const a = actionFor(mode);
      if (!a || !mixer) {
        if (current) current.fadeOut(0.15);
        current = null;
        lastMode = mode;
        return false;
      }
      if (mode !== lastMode || (kick !== lastKick && (mode === 'swing' || mode === 'jump'))) {
        if (current && current !== a) current.fadeOut(0.15);
        a.reset().fadeIn(0.12).play();
        current = a;
      }
      lastMode = mode;
      lastKick = kick;
      mixer.update(dt);
      return true;
    },
  };
}
