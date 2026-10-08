import * as THREE from 'three';

/**
 * Procedural animation for rigged (skinned) character models. Every frame the bones' rotations are driven from the same
 * inputs the procedural models use (walk phase, move amount, strafe, casting, a swing in progress, height above the ground),
 * smoothed per channel so nothing ever snaps. Bone names are the ones scripts/rig-model.mjs writes. Rotation.x < 0 swings a
 * limb forward (the character faces +z); +x is the character's left. No allocations in the frame loop.
 */

export const RIG_BONES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'shoulder_l', 'upperarm_l', 'forearm_l', 'hand_l', 'shoulder_r', 'upperarm_r', 'forearm_r', 'hand_r',
  'thigh_l', 'shin_l', 'foot_l', 'thigh_r', 'shin_r', 'foot_r',
] as const;
export type RigBoneName = (typeof RIG_BONES)[number];

const B: Record<string, number> = Object.fromEntries(RIG_BONES.map((n, i) => [n, i]));
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smooth = (x: number) => {
  const k = clamp(x, 0, 1);
  return k * k * (3 - 2 * k);
};
const easeOut = (x: number) => 1 - (1 - clamp(x, 0, 1)) ** 3;
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

export interface RigPoseInput {
  phase: number;
  move: number;
  casting: boolean;
  time: number;
  dt: number;
  vf: number;
  vs: number;
  /** 0..1 progress of a melee swing, or -1 when none. `hand` 0 = right, 1 = left. */
  swing: number;
  hand: number;
  /** Height above the ground. */
  air: number;
  dead: boolean;
}

export interface RigPoseOpts {
  /** Resting arm pitch and elbow bend per weapon kind. */
  armRest?: number;
  elbow?: number;
  /** Pulls the arms in toward the body (radians): for a model whose bind pose holds the arms out (an A-pose). */
  armIn?: number;
  /** Brings the legs closer together at rest (radians per leg): for a model that stands with a wide stance. */
  legIn?: number;
  /** Walk stride amplitude scale (long coats limit it). */
  stride?: number;
  /** Scale of the right arm's swing (a heavy weapon built into the model is held steadier). */
  rightSwing?: number;
}

/**
 * How the arms carry a two-handed weapon (see weaponModels.ts): per arm the pitch (x, negative = forward), roll (z, away from the
 * body when positive on the left arm) and elbow bend while holding it; `walk` scales how much the arms still swing with the stride,
 * `arc` how much of a melee swing's arc they follow (both arms move together).
 */
export interface ArmHold {
  r: { x: number; z: number; e: number };
  l: { x: number; z: number; e: number };
  walk: number;
  arc: number;
}

export class RigAnimator {
  private readonly bones: THREE.Object3D[];
  private readonly rest: THREE.Vector3[];
  /** Rest rotation of each bone and its parent's rest world rotation (and inverse): deltas are applied in character space, so any bind pose works. */
  private readonly restQ: THREE.Quaternion[];
  private readonly parentQ: THREE.Quaternion[];
  private readonly parentQInv: THREE.Quaternion[];
  private readonly qd = new THREE.Quaternion();
  private readonly eul = new THREE.Euler();
  /** Current and target rotation per bone and axis, then three extra scalars. */
  private readonly cur = new Float32Array(RIG_BONES.length * 3);
  private readonly tgt = new Float32Array(RIG_BONES.length * 3);
  private readonly rate = new Float32Array(RIG_BONES.length * 3);
  private sign = 1;
  private bob = 0;
  private lunge = 0;
  private air = 0;
  private vy = 0;
  private deadK = 0;
  readonly opts: Required<RigPoseOpts>;
  /** Set by the model builder when a two-handed weapon is carried: both arms stay on it. */
  hold: ArmHold | null = null;

  constructor(bones: Record<string, THREE.Object3D>, opts: RigPoseOpts = {}) {
    this.bones = RIG_BONES.map((n) => bones[n]);
    this.rest = this.bones.map((b) => b.position.clone());
    this.restQ = this.bones.map((b) => b.quaternion.clone());
    this.parentQ = this.bones.map((b) => (b.parent ? b.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion()));
    this.parentQInv = this.parentQ.map((q) => q.clone().invert());
    this.opts = { armRest: opts.armRest ?? -0.12, elbow: opts.elbow ?? 0.15, stride: opts.stride ?? 0.62, rightSwing: opts.rightSwing ?? 1, armIn: opts.armIn ?? 0, legIn: opts.legIn ?? 0 };
    this.cur.fill(0);
  }

  private t(bone: RigBoneName, axis: 0 | 1 | 2, v: number, rate = 22) {
    const i = B[bone] * 3 + axis;
    this.tgt[i] = v;
    this.rate[i] = rate;
  }

  /** Forward z offset of the whole body (a lunge into a strike). */
  get lungeZ() {
    return this.lunge;
  }

  update(p: RigPoseInput): void {
    this.tgt.fill(0);
    this.rate.fill(14);
    const { phase, move, casting, time, dt } = p;
    const o = this.opts;
    this.sign += ((p.vf < -0.6 ? -1 : 1) - this.sign) * (1 - Math.exp(-14 * dt));
    const sin = Math.sin(phase);
    const cos = Math.cos(phase);
    const stride = sin * move * this.sign;
    const breathe = Math.sin(time * 2.0);
    const idle = 1 - move;
    const airborne = clamp((p.air - 0.04) * 6, 0, 1);
    this.vy += ((p.air - this.air) / Math.max(dt, 0.001) - this.vy) * (1 - Math.exp(-12 * dt));
    this.air = p.air;
    const falling = airborne > 0 && this.vy < 0 ? 1 : 0;
    const walk = move * (1 - airborne);

    // ---- legs: thigh swing, knee bend on the forward swing, foot kept roughly flat
    const sw = o.stride;
    const lead = (s: number) => Math.max(0, -cos * s) * walk * this.sign; // knee flexes while the leg swings forward
    for (const s of [1, -1] as const) {
      const l = s === 1 ? 'l' : 'r';
      const a = stride * s * sw * 1.2;
      let thigh = a;
      let knee = 0.08 * move + lead(s) * 0.95 + Math.max(0, a) * 0.2;
      // in the air: tuck, knees up (a bit more going up than coming down)
      thigh = lerp(thigh, -0.45 - (s === 1 ? 0.12 : -0.1) - falling * 0.15, airborne);
      knee = lerp(knee, 1.0 - falling * 0.35 + (s === 1 ? 0 : 0.15), airborne);
      this.t(`thigh_${l}` as RigBoneName, 0, thigh, 34);
      this.t(`shin_${l}` as RigBoneName, 0, knee, 34);
      this.t(`foot_${l}` as RigBoneName, 0, -(thigh + knee) * 0.55, 30);
      // legs stay apart (no scissoring through each other): a touch of outward splay
      this.t(`thigh_${l}` as RigBoneName, 2, s * (0.03 + 0.03 * walk - o.legIn), 20);
    }

    // ---- hips and torso: bob on each step, twist against the legs, roll into strafes, lean into the run
    const lean = 0.1 * clamp(p.vf / 7, -0.5, 1) + breathe * 0.012;
    const roll = -clamp(p.vs / 7, -1, 1) * 0.1 + sin * 0.035 * walk;
    this.t('hips', 1, stride * 0.16 * (s2(this.sign)), 14);
    this.t('hips', 2, sin * 0.045 * walk, 14);
    this.t('spine', 0, lean * 0.5 + 0.01, 10);
    this.t('chest', 0, lean * 0.5 + breathe * 0.012, 10);
    this.t('spine', 2, roll * 0.5 + Math.sin(time * 0.8) * 0.012 * idle, 10);
    this.t('chest', 2, roll * 0.5, 10);
    this.t('spine', 1, -stride * 0.1, 12);
    this.t('chest', 1, -stride * 0.12, 12);
    this.t('neck', 0, -lean * 0.4, 8);
    this.t('head', 0, -lean * 0.6 + Math.sin(time * 0.7) * 0.02 * idle, 8);
    this.t('head', 1, Math.sin(time * 0.45) * 0.07 * idle + stride * 0.08, 6);
    this.t('shoulder_l', 2, 0.02 + 0.012 * breathe, 10);
    this.t('shoulder_r', 2, -0.02 - 0.012 * breathe, 10);
    this.bob += ((Math.abs(sin) * 0.035 * walk + breathe * 0.006) - this.bob) * (1 - Math.exp(-16 * dt));

    // ---- arms
    let tLx = o.armRest - stride * 0.95 + Math.sin(time * 1.3) * 0.02 * idle;
    let tRx = o.armRest + stride * 0.95 * o.rightSwing - Math.sin(time * 1.3) * 0.02 * idle;
    let eL = -(o.elbow + 0.45 * move * (0.5 + 0.5 * Math.max(0, stride * 1)));
    let eR = -(o.elbow + 0.45 * move * (0.5 + 0.5 * Math.max(0, -stride * 1)));
    let tLz = 0.06 + move * 0.04 - o.armIn;
    let tRz = -0.06 - move * 0.04 + o.armIn;
    let armRate = 22;
    let twist = 0;
    let lunge = 0;
    const hold = this.hold;
    if (hold) {
      // both hands on the weapon: a small bob with the stride instead of the arms swinging against each other
      tLx = hold.l.x - Math.abs(stride) * 0.1 * hold.walk + Math.sin(time * 1.3) * 0.015 * idle;
      tRx = hold.r.x - Math.abs(stride) * 0.1 * hold.walk + Math.sin(time * 1.3) * 0.015 * idle;
      eL = hold.l.e;
      eR = hold.r.e;
      tLz = hold.l.z;
      tRz = hold.r.z;
    }
    // airborne: arms out and up a little
    tLx = lerp(tLx, -0.5, airborne);
    tRx = lerp(tRx, -0.5, airborne);
    tLz = lerp(tLz, 0.55, airborne);
    tRz = lerp(tRz, -0.55, airborne);
    if (casting) {
      const shake = Math.sin(time * 16) * 0.02;
      tLx = -1.25 + shake;
      tRx = -1.4 - shake;
      eL = -0.45;
      eR = -0.35;
      tLz = 0.18;
      tRz = -0.18;
      armRate = 13;
      this.t('chest', 0, -0.06, 10);
      this.t('head', 0, -0.12, 10);
    }
    if (p.swing >= 0) {
      const q = p.swing;
      const eR0 = eR;
      let arc: number, tw: number, el: number;
      if (q < 0.3) {
        const k = easeOut(q / 0.3);
        arc = lerp(o.armRest, -2.5, k);
        tw = -0.5 * k;
        el = lerp(eR, -0.9, k);
      } else if (q < 0.52) {
        const k = (q - 0.3) / 0.22;
        arc = lerp(-2.5, 0.35, k * k * k);
        tw = lerp(-0.5, 0.45, easeOut(k));
        el = lerp(-0.9, -0.1, k);
        lunge = Math.sin(k * Math.PI * 0.5) * 0.2;
      } else {
        const k = smooth((q - 0.52) / 0.48);
        arc = lerp(0.35, o.armRest, k);
        tw = lerp(0.45, 0, k);
        el = lerp(-0.1, eR, k);
        lunge = 0.2 * (1 - k);
      }
      if (hold) {
        // the weapon stays in both hands: they follow the arc together, around the carried pose
        const k = hold.arc;
        tRx = hold.r.x + (arc - o.armRest) * k;
        tLx = hold.l.x + (arc - o.armRest) * k;
        eR = hold.r.e + (el - eR0) * k;
        eL = hold.l.e + (el - eR0) * k;
        twist = tw;
      } else if (p.hand === 0) {
        tRx = arc;
        eR = el;
        twist = tw;
        tLx = o.armRest - 0.3 + (arc - o.armRest) * -0.2;
      } else {
        tLx = arc;
        eL = el;
        twist = -tw;
        tRx = o.armRest - 0.3 + (arc - o.armRest) * -0.2;
      }
      armRate = 55;
      this.t('chest', 1, twist, 40);
      this.t('spine', 1, twist * 0.6, 40);
      this.t('chest', 0, 0.12 * Math.sin(Math.min(1, q * 2) * Math.PI), 30);
    }
    this.t('upperarm_l', 0, tLx, armRate);
    this.t('upperarm_r', 0, tRx, armRate);
    this.t('forearm_l', 0, eL, armRate);
    this.t('forearm_r', 0, eR, armRate);
    this.t('upperarm_l', 2, tLz, 14);
    this.t('upperarm_r', 2, tRz, 14);
    this.t('hand_l', 0, 0.1 * Math.sin(phase + 1) * move, 12);
    this.t('hand_r', 0, 0.1 * Math.sin(phase + 1) * move, 12);
    this.lunge += (lunge - this.lunge) * (1 - Math.exp(-30 * dt));

    // ---- dead: limbs go limp (the whole body lies down through the root rotation)
    this.deadK += ((p.dead ? 1 : 0) - this.deadK) * (1 - Math.exp(-6 * dt));
    if (this.deadK > 0.001) {
      const k = this.deadK;
      const set = (bone: RigBoneName, axis: 0 | 1 | 2, v: number) => {
        const i = B[bone] * 3 + axis;
        this.tgt[i] = lerp(this.tgt[i], v, k);
        this.rate[i] = lerp(this.rate[i], 7, k);
      };
      set('upperarm_l', 0, 0.2); set('upperarm_r', 0, 0.35);
      set('upperarm_l', 2, 0.55); set('upperarm_r', 2, -0.7);
      set('forearm_l', 0, -0.25); set('forearm_r', 0, -0.5);
      set('thigh_l', 0, 0.1); set('thigh_r', 0, -0.05);
      set('thigh_l', 2, 0.15); set('thigh_r', 2, -0.2);
      set('shin_l', 0, 0.05); set('shin_r', 0, 0.2);
      set('foot_l', 0, 0); set('foot_r', 0, 0);
      set('head', 0, -0.2); set('head', 1, 0.3);
      set('chest', 0, 0); set('spine', 0, 0); set('chest', 1, 0); set('spine', 1, 0);
      set('chest', 2, 0); set('spine', 2, 0); set('hips', 1, 0); set('hips', 2, 0);
    }

    // ---- smooth every channel toward its target and write the bones
    const n = RIG_BONES.length;
    for (let i = 0; i < n; i++) {
      const bone = this.bones[i];
      for (let a = 0; a < 3; a++) {
        const j = i * 3 + a;
        const c = this.cur[j] + (this.tgt[j] - this.cur[j]) * (1 - Math.exp(-this.rate[j] * dt));
        this.cur[j] = c;
      }
      // local = parentRest^-1 * delta * parentRest * localRest  (delta in character space)
      this.qd.setFromEuler(this.eul.set(this.cur[i * 3], this.cur[i * 3 + 1], this.cur[i * 3 + 2]));
      bone.quaternion.copy(this.parentQInv[i]).multiply(this.qd).multiply(this.parentQ[i]).multiply(this.restQ[i]);
    }
    const hips = this.bones[0];
    hips.position.y = this.rest[0].y + this.bob;
  }
}

const s2 = (v: number) => (v < 0 ? -1 : 1);
