import * as THREE from 'three';
import { fxNum } from '@arena/shared';
import { newShoutPose, shoutPose } from './shoutPose';

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
  /** 0..1 progress of a shout / roar / breath pose (shoutPose.ts), or -1 / absent when none. It is added on top of everything else. */
  shout?: number;
  /** 0..1 progress of an instant-cast gesture (a flick of the casting hand in the class's own style), or -1 / absent when none. */
  gesture?: number;
}

/**
 * How a class carries itself, on top of the shared walk / jump / cast / strike animation (every number 1 = the shared default, so a model
 * without a style moves as before). The warrior is heavy and braced, the rogue low and quick, the priest upright and gliding.
 */
export interface RigStyle {
  /** Step bounce of the hips. */
  bounce?: number;
  /** Hip and shoulder roll with each step. */
  sway?: number;
  /** Forward lean when running (and into starts and stops). */
  lean?: number;
  /** A standing crouch: 0..0.4 radians of knee bend, the hips lower by the matching amount. */
  crouch?: number;
  /** Arm swing while moving. */
  arms?: number;
  /** Elbows kept bent at rest (radians): a guard. */
  guard?: number;
  /** How far the knees give on landing. */
  landing?: number;
  /** How high the knees tuck in the air. */
  tuck?: number;
  /** A slow hover of the hips at rest and when moving (a glide): metres. */
  float?: number;
  /** How the unit holds itself while casting: 'arms' = both arms forward (shared), 'raise' = staff hand held high and the free hand open, head up, 'brace' = planted wide, fists forward, 'conceal' = crouched, arms drawn in. */
  cast?: 'arms' | 'raise' | 'brace' | 'conceal';
  /** How a melee swing is made: 'slash' = the shared arc, 'stab' = pull back and thrust, 'smite' = both hands up, then down. */
  strike?: 'slash' | 'stab' | 'smite';
}
const STYLE_DEFAULT: Required<RigStyle> = { bounce: 1, sway: 1, lean: 1, crouch: 0, arms: 1, guard: 0, landing: 1, tuck: 1, float: 0, cast: 'arms', strike: 'slash' };

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
  /** Arm pitch while casting (radians, negative = forward): a staff in the right hand is raised only a little so it stays upright instead of pointing like a lance. */
  castR?: number;
  castL?: number;
  /** How far the swinging arm winds up (radians, negative = up and back); a staff is swung less far than a blade. */
  swingArc?: number;
  /** The class's way of moving (see RigStyle). */
  style?: RigStyle;
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
  /** How much of a swing's elbow bend the arms follow (default 1); 0 keeps both hands rigid on the weapon through the arc. */
  elbowArc?: number;
  /**
   * One-handed carry between fights (the greatsword on the shoulder): the right arm's pose while the weapon rests, the left arm
   * moves freely. A swing (or a cast) blends to the two-handed pose above within a fraction of a second and, `grace` seconds
   * after the last one (default 1.2), back (see RigAnimator.grip).
   */
  rest?: { r: { x: number; z: number; e: number }; walk: number; grace?: number };
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
  /** 1 right after landing from a jump, easing out: the knees give and the body drops. */
  private landK = 0;
  /** How far the hips sit lower than usual (a landing, a lunge into a strike). */
  private drop = 0;
  private deadK = 0;
  readonly opts: Required<Omit<RigPoseOpts, 'style'>>;
  readonly style: Required<RigStyle>;
  private lastVf = 0;
  /** Smoothed acceleration along the facing, -1..1 (a start leans the body, a stop leans it back). */
  private accel = 0;
  /** 1 right after leaving the ground, easing out: the body stretches in the take-off. */
  private launch = 0;
  private cp = 0;
  /** Set by the model builder when a two-handed weapon is carried: both arms stay on it. */
  hold: ArmHold | null = null;
  /** 0..1: how far the second hand is on a weapon that rests one-handed (1 = both hands, the only state without `hold.rest`). */
  grip = 1;
  private sinceSwing = 99;
  private readonly sh = newShoutPose();

  /** The Models page's turn of every bone (radians), added to whatever the animation asks for. */
  private readonly adj = new Float32Array(RIG_BONES.length * 3);

  constructor(bones: Record<string, THREE.Object3D>, opts: RigPoseOpts = {}, adjust: Record<string, { rx: number; ry: number; rz: number; size: number }> | null = null) {
    this.bones = RIG_BONES.map((n) => bones[n]);
    this.rest = this.bones.map((b) => b.position.clone());
    this.restQ = this.bones.map((b) => b.quaternion.clone());
    this.parentQ = this.bones.map((b) => (b.parent ? b.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion()));
    this.parentQInv = this.parentQ.map((q) => q.clone().invert());
    this.opts = { armRest: opts.armRest ?? -0.12, elbow: opts.elbow ?? 0.15, stride: opts.stride ?? 0.62, rightSwing: opts.rightSwing ?? 1, armIn: opts.armIn ?? 0, legIn: opts.legIn ?? 0, castR: opts.castR ?? -1.4, castL: opts.castL ?? -1.25, swingArc: opts.swingArc ?? -2.5 };
    this.style = { ...STYLE_DEFAULT, ...opts.style };
    this.cur.fill(0);
    if (adjust) {
      RIG_BONES.forEach((n, i) => {
        const a = adjust[n];
        if (!a) return;
        this.adj[i * 3] = a.rx;
        this.adj[i * 3 + 1] = a.ry;
        this.adj[i * 3 + 2] = a.rz;
        if (a.size !== 1) this.bones[i].scale.multiplyScalar(a.size);
      });
    }
  }

  private t(bone: RigBoneName, axis: 0 | 1 | 2, v: number, rate = 22) {
    const i = B[bone] * 3 + axis;
    this.tgt[i] = v;
    this.rate[i] = rate;
  }

  /** Adds to a bone's target (an overlay on top of the pose) and speeds its smoothing up if needed. */
  private add(bone: RigBoneName, axis: 0 | 1 | 2, v: number, rate: number) {
    const i = B[bone] * 3 + axis;
    this.tgt[i] += v;
    if (this.rate[i] < rate) this.rate[i] = rate;
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
    const sty = this.style;
    // starts lean the body forward and stops lean it back, smoothed so the speed readout's jitter never shows
    this.accel += (clamp((p.vf - this.lastVf) / Math.max(dt, 0.001) / 40, -1, 1) - this.accel) * (1 - Math.exp(-9 * dt));
    this.lastVf = p.vf;
    // the casting stance (a crouch or a planted brace) eases in and out instead of snapping
    const cpT = casting && !p.dead ? (sty.cast === 'conceal' ? 0.28 : sty.cast === 'brace' ? 0.14 : 0) : 0;
    this.cp += (cpT - this.cp) * (1 - Math.exp(-9 * dt));
    this.sign += ((p.vf < -0.6 ? -1 : 1) - this.sign) * (1 - Math.exp(-14 * dt));
    const sin = Math.sin(phase);
    const cos = Math.cos(phase);
    const stride = sin * move * this.sign * fxNum('running', 'armSwing');
    const breathe = Math.sin(time * 2.0);
    const idle = 1 - move;
    const airborne = clamp((p.air - 0.04) * 6, 0, 1);
    this.vy += ((p.air - this.air) / Math.max(dt, 0.001) - this.vy) * (1 - Math.exp(-12 * dt));
    if (this.air > 0.12 && p.air < 0.05 && !p.dead) this.landK = clamp(0.5 + Math.abs(this.vy) * 0.12, 0.5, 1);
    this.landK *= Math.exp(-8 * dt);
    if (this.air <= 0.05 && p.air > 0.05 && !p.dead) this.launch = 1;
    this.launch *= Math.exp(-7 * dt);
    this.air = p.air;
    const land = this.landK * fxNum('jump', 'landingDip') * sty.landing;
    const rise = airborne > 0 ? clamp(this.vy / 3, -1, 1) : 0; // 1 going up, -1 coming down, 0 at the top
    // a strike plants the feet: weight back in the wind-up, then the front leg drives forward (the opposite foot to the striking hand)
    const sq = p.swing;
    const plant = sq >= 0 ? Math.sin(clamp(sq, 0, 1) * Math.PI) * (1 - airborne) * fxNum('attack', 'legPlant') : 0;
    const falling = airborne > 0 && this.vy < 0 ? 1 : 0;
    const walk = move * (1 - airborne);

    // ---- legs: thigh swing, knee bend on the forward swing, foot kept roughly flat
    const sw = o.stride * fxNum('running', 'strideScale');
    const lead = (s: number) => Math.max(0, -cos * s) * walk * this.sign; // knee flexes while the leg swings forward
    for (const s of [1, -1] as const) {
      const l = s === 1 ? 'l' : 'r';
      const a = stride * s * sw * 1.2;
      let thigh = a;
      let knee = 0.08 * move + lead(s) * 0.95 + Math.max(0, a) * 0.2;
      thigh -= sty.crouch + this.cp; // a standing crouch, and the casting stance
      knee += (sty.crouch + this.cp) * 2;
      // in the air: tuck, knees up (a bit more going up than coming down)
      // going up one knee drives high and the other foot trails behind; at the top both tuck; coming down the legs reach for the ground
      const up = Math.max(0, rise), down = Math.max(0, -rise);
      const first = s === 1;
      const jt = (first ? -0.95 : -0.25) * up + (-0.75) * (1 - up - down) + (-0.35) * down;
      const jk = (first ? 1.3 : 1.55) * up + 1.2 * (1 - up - down) + 0.4 * down;
      thigh = lerp(thigh, jt * fxNum('jump', 'legTuck') * sty.tuck, airborne);
      knee = lerp(knee, jk * fxNum('jump', 'legTuck') * sty.tuck, airborne);
      // the take-off: the legs push out straight (one a little ahead of the other) before they tuck
      const lk = this.launch * 0.8;
      thigh = lerp(thigh, first ? -0.2 : 0.3, lk);
      knee = lerp(knee, first ? 0.25 : 0.1, lk);
      // landing: both knees give
      thigh = lerp(thigh, -0.6, land);
      knee = lerp(knee, 1.15, land);
      // striking: the front leg steps in, the back leg pushes
      const front = (p.hand === 0 ? -1 : 1) === s ? 1 : -1;
      thigh += front === 1 ? -0.5 * plant : 0.4 * plant;
      knee += front === 1 ? 0.35 * plant : 0.25 * plant;
      this.t(`thigh_${l}` as RigBoneName, 0, thigh, 34);
      this.t(`shin_${l}` as RigBoneName, 0, knee, 34);
      // heel strike (toes up as the leg reaches forward) and toe-off (toes down as it trails)
      const nn = clamp(a / 0.6, -1, 1) * walk;
      this.t(`foot_${l}` as RigBoneName, 0, -(thigh + knee) * 0.55 + (nn > 0 ? 0.32 * nn : 0.22 * nn), 30);
      // legs stay apart (no scissoring through each other): a touch of outward splay
      this.t(`thigh_${l}` as RigBoneName, 2, s * (0.03 + 0.03 * walk - o.legIn), 20);
    }

    // ---- hips and torso: bob on each step, twist against the legs, roll into strafes, lean into the run
    const lean = (0.1 * fxNum('running', 'lean') * clamp(p.vf / 7, -0.5, 1) + this.accel * 0.09) * sty.lean + breathe * 0.012 * fxNum('idle', 'breathing');
    const roll = -clamp(p.vs / 7, -1, 1) * 0.1 + sin * 0.035 * walk * sty.sway;
    this.t('hips', 1, stride * 0.16 * (s2(this.sign)), 14);
    this.t('hips', 2, sin * 0.045 * walk * sty.sway + Math.sin(time * 0.55) * 0.025 * idle, 14); // a slow shift of weight at rest
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
    this.bob += ((Math.abs(sin) * 0.035 * fxNum('running', 'bounce') * walk * sty.bounce + breathe * 0.006 * fxNum('idle', 'breathing')) - this.bob) * (1 - Math.exp(-16 * dt));
    const dropT = -0.2 * land - 0.07 * plant - (sty.crouch + this.cp) * 0.28 * (1 - airborne) + (casting && sty.cast === 'raise' ? 0.02 : 0);
    this.drop += (dropT - this.drop) * (1 - Math.exp(-(land > 0.05 ? 30 : 16) * dt));
    // at the top of a jump the body curls (a rogue's tuck) or opens (a priest's float); on take-off it arches back
    const curl = (sty.tuck - 1) * 0.5 * airborne * (1 - Math.abs(rise));
    this.t('spine', 0, lean * 0.5 + 0.01 + 0.2 * land + 0.1 * Math.max(0, -rise) * airborne + curl * 0.6 + this.cp * 0.6 - 0.08 * this.launch, 12);
    this.t('chest', 0, lean * 0.5 + breathe * 0.012 + 0.15 * land + curl * 0.6 + this.cp * 0.4 - 0.12 * this.launch, 12);

    // ---- arms
    let tLx = o.armRest - stride * 0.95 * sty.arms + Math.sin(time * 1.3) * 0.02 * idle;
    let tRx = o.armRest + stride * 0.95 * o.rightSwing * sty.arms - Math.sin(time * 1.3) * 0.02 * idle;
    let eL = -(o.elbow + sty.guard + 0.45 * move * (0.5 + 0.5 * Math.max(0, stride * 1)));
    let eR = -(o.elbow + sty.guard + 0.45 * move * (0.5 + 0.5 * Math.max(0, -stride * 1)));
    let tLz = 0.06 + move * 0.04 - o.armIn;
    let tRz = -0.06 - move * 0.04 + o.armIn;
    let armRate = 22;
    let twist = 0;
    let lunge = 0;
    const hold = this.hold;
    // the second hand lets go of a shoulder-carried weapon once no swing has come for a while
    if (p.swing >= 0 || casting) this.sinceSwing = 0;
    else this.sinceSwing += dt;
    const gripT = !hold?.rest || this.sinceSwing < (hold.rest.grace ?? 1.2) ? 1 : 0;
    this.grip += (gripT - this.grip) * (1 - Math.exp(-(gripT ? 26 : 5) * dt));
    if (hold) {
      // both hands on the weapon: a small bob with the stride instead of the arms swinging against each other
      tLx = hold.l.x - Math.abs(stride) * 0.1 * hold.walk + Math.sin(time * 1.3) * 0.015 * idle;
      tRx = hold.r.x - Math.abs(stride) * 0.1 * hold.walk + Math.sin(time * 1.3) * 0.015 * idle;
      eL = hold.l.e;
      eR = hold.r.e;
      tLz = hold.l.z;
      tRz = hold.r.z;
      if (hold.rest && this.grip < 0.999) {
        // resting on the shoulder: the right arm steady (a small bob), the left arm swings like a free one
        const k = this.grip, rr = hold.rest;
        tLx = lerp(o.armRest - stride * 0.95 + Math.sin(time * 1.3) * 0.02 * idle, tLx, k);
        eL = lerp(-(o.elbow + 0.45 * move * (0.5 + 0.5 * Math.max(0, stride))), eL, k);
        tLz = lerp(0.06 + move * 0.04 - o.armIn, tLz, k);
        tRx = lerp(rr.r.x - Math.abs(stride) * 0.1 * rr.walk + Math.sin(time * 1.3) * 0.012 * idle, tRx, k);
        eR = lerp(rr.r.e, eR, k);
        tRz = lerp(rr.r.z, tRz, k);
      }
    }
    // airborne: arms swing up with the take-off, out wide at the top, and drop to balance on the way down
    const armUp = (-0.9 * Math.max(0, rise) - 0.3 * (1 - Math.abs(rise)) + 0.1 * Math.max(0, -rise)) * fxNum('jump', 'armSwing');
    tLx = lerp(tLx, armUp, airborne);
    tRx = lerp(tRx, armUp, airborne);
    tLz = lerp(tLz, 0.65, airborne);
    tRz = lerp(tRz, -0.65, airborne);
    // landing: arms swing down and forward to balance
    tLx = lerp(tLx, -0.35, land);
    tRx = lerp(tRx, -0.35, land);
    if (casting && sty.cast === 'raise') {
      // the staff hand lifts the staff a little, the free hand opens palm out and high, the chest opens and the head tips up
      const pulse = Math.sin(time * 3.2) * 0.05;
      tLx = o.castL + pulse;
      tRx = o.castR - pulse * 0.4;
      eL = -0.3;
      eR = -0.35;
      tLz = 0.5;
      tRz = -0.14;
      armRate = 11;
      this.t('chest', 0, -0.1, 10);
      this.t('spine', 0, -0.03, 10);
      this.t('neck', 0, -0.08, 10);
      this.t('head', 0, -0.2, 10);
      this.t('hand_l', 0, -0.5, 12); // the wrist bends back: the palm faces the target
    } else if (casting && sty.cast === 'brace') {
      // planted wide, both fists forward and a little apart, the body leaning into it
      tLx = -0.95 + Math.sin(time * 16) * 0.02;
      tRx = -0.95 - Math.sin(time * 16) * 0.02;
      eL = -0.95;
      eR = -0.95;
      tLz = 0.14;
      tRz = -0.14;
      armRate = 14;
      this.t('chest', 0, 0.08, 10);
      this.t('head', 0, -0.06, 10);
    } else if (casting && sty.cast === 'conceal') {
      // low, the hands drawn in across the body and the head down: a rogue works close
      tLx = -0.5 + Math.sin(time * 9) * 0.015;
      tRx = -0.7 - Math.sin(time * 9) * 0.015;
      eL = -1.4;
      eR = -1.5;
      tLz = 0.06 - o.armIn - 0.2;
      tRz = -0.06 + o.armIn + 0.2;
      armRate = 14;
      this.t('head', 0, 0.12, 10);
      this.t('neck', 0, 0.06, 10);
    } else if (casting) {
      const shake = Math.sin(time * 16) * 0.02;
      tLx = o.castL + shake;
      tRx = o.castR - shake;
      eL = -0.45;
      eR = -0.35;
      tLz = 0.18;
      tRz = -0.18;
      armRate = 13;
      this.t('chest', 0, -0.06, 10);
      this.t('head', 0, -0.12, 10);
    }
    // an instant cast: one flick of the casting hands in the class's own style (a melee swing in progress takes the arms instead)
    const gq = p.gesture !== undefined && p.gesture >= 0 && p.swing < 0 && !p.dead ? p.gesture : -1;
    if (gq >= 0) {
      const env = gq < 0.28 ? easeOut(gq / 0.28) : 1 - smooth((gq - 0.28) / 0.72);
      if (sty.cast === 'conceal') {
        // a throwing flick of the right hand: back, then forward and out
        const wind = gq < 0.25 ? smooth(gq / 0.25) : 1 - smooth((gq - 0.25) / 0.15);
        const thr = gq < 0.25 ? 0 : gq < 0.5 ? easeOut((gq - 0.25) / 0.25) : 1 - smooth((gq - 0.5) / 0.5);
        tRx = lerp(lerp(tRx, 0.45, clamp(wind, 0, 1)), -1.5, thr);
        eR = lerp(lerp(eR, -1.3, clamp(wind, 0, 1)), -0.1, thr);
        tLx = lerp(tLx, -0.5, env * 0.6);
        this.t('chest', 1, -0.3 * clamp(wind, 0, 1) + 0.5 * thr, 36);
        this.t('spine', 1, -0.15 * clamp(wind, 0, 1) + 0.25 * thr, 36);
        lunge += 0.12 * thr;
      } else if (sty.cast === 'raise') {
        // the free hand pushes the spell out, the staff lifts and the chest opens
        tLx = lerp(tLx, -1.5, env);
        tLz = lerp(tLz, 0.3, env);
        eL = lerp(eL, -0.15, env);
        tRx = lerp(tRx, o.castR - 0.3, env * 0.7);
        this.add('chest', 0, -0.06 * env, 30);
        this.add('head', 0, -0.1 * env, 30);
        this.add('hand_l', 0, -0.6 * env, 30);
      } else {
        // both fists thrust forward
        tLx = lerp(tLx, -1.3, env);
        tRx = lerp(tRx, -1.3, env);
        eL = lerp(eL, -0.3, env);
        eR = lerp(eR, -0.3, env);
        this.add('chest', 0, 0.1 * env, 30);
        lunge += 0.08 * env;
      }
      armRate = Math.max(armRate, 40);
    }
    if (p.swing >= 0) {
      const q = p.swing;
      const eR0 = eR;
      let arc: number, tw: number, el: number;
      if (sty.strike === 'stab' && !hold) {
        // pull the elbow back, then drive the point straight out with the whole body behind it and recover
        if (q < 0.28) {
          const k = easeOut(q / 0.28);
          arc = lerp(o.armRest, 0.45, k);
          tw = -0.4 * k;
          el = lerp(eR, -1.5, k);
        } else if (q < 0.48) {
          const k = (q - 0.28) / 0.2;
          arc = lerp(0.45, -1.4, k * k);
          tw = lerp(-0.4, 0.55, easeOut(k));
          el = lerp(-1.5, -0.12, k);
          lunge = Math.sin(k * Math.PI * 0.5) * 0.3;
        } else {
          const k = smooth((q - 0.48) / 0.52);
          arc = lerp(-1.4, o.armRest, k);
          tw = lerp(0.55, 0, k);
          el = lerp(-0.12, eR, k);
          lunge = 0.3 * (1 - k);
        }
      } else if (sty.strike === 'smite' && !hold) {
        // both hands raise the staff overhead (slowly, it is heavy), then bring it down hard
        if (q < 0.38) {
          const k = easeOut(q / 0.38);
          arc = lerp(o.armRest, o.swingArc, k);
          tw = -0.3 * k;
          el = lerp(eR, -0.7, k);
        } else if (q < 0.56) {
          const k = (q - 0.38) / 0.18;
          arc = lerp(o.swingArc, 0.2, k * k * k);
          tw = lerp(-0.3, 0.3, easeOut(k));
          el = lerp(-0.7, -0.1, k);
          lunge = Math.sin(k * Math.PI * 0.5) * 0.14;
        } else {
          const k = smooth((q - 0.56) / 0.44);
          arc = lerp(0.2, o.armRest, k);
          tw = lerp(0.3, 0, k);
          el = lerp(-0.1, eR, k);
          lunge = 0.14 * (1 - k);
        }
      } else if (q < 0.3) {
        const k = easeOut(q / 0.3);
        arc = lerp(o.armRest, o.swingArc, k);
        tw = -0.5 * k;
        el = lerp(eR, -0.9, k);
      } else if (q < 0.52) {
        const k = (q - 0.3) / 0.22;
        arc = lerp(o.swingArc, 0.35, k * k * k);
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
      arc = o.armRest + (arc - o.armRest) * fxNum('attack', 'armArc');
      tw *= fxNum('attack', 'bodyTwist');
      lunge *= fxNum('attack', 'lunge');
      if (hold) {
        // the weapon stays in both hands: they follow the arc together, around the carried pose
        const k = hold.arc;
        const ke = k * (hold.elbowArc ?? 1);
        tRx += (arc - o.armRest) * k;
        tLx += (arc - o.armRest) * k;
        eR += (el - eR0) * ke;
        eL += (el - eR0) * ke;
        twist = tw;
      } else if (p.hand === 0) {
        tRx = arc;
        eR = el;
        twist = tw;
        tLx = o.armRest - 0.3 + (arc - o.armRest) * -0.2;
        if (sty.strike === 'smite') {
          // the free hand follows the staff up and down
          tLx = lerp(o.armRest, arc, 0.75);
          eL = lerp(eL, el, 0.8);
          tLz = 0.2;
        }
      } else {
        tLx = arc;
        eL = el;
        twist = -tw;
        tRx = o.armRest - 0.3 + (arc - o.armRest) * -0.2;
      }
      armRate = 55;
      this.t('chest', 1, twist, 40);
      this.t('spine', 1, twist * 0.6, 40);
      this.t('hips', 1, -twist * 0.45 * fxNum('attack', 'hipTurn'), 36); // the hips turn the other way into the blow, so the whole body winds and unwinds
      this.t('head', 1, -twist * 0.7, 36); // the eyes stay on the target
      this.t('chest', 0, 0.25 * fxNum('attack', 'lean') * Math.sin(Math.min(1, q * 2) * Math.PI), 30);
      this.t('spine', 2, twist * 0.12, 30);
      // the arm comes from out to the side across the body, not straight over the top
      const side = (q < 0.3 ? q / 0.3 : q < 0.52 ? 1 - (q - 0.3) / 0.22 * 1.6 : -0.6 * (1 - (q - 0.52) / 0.48)) * 0.28;
      if (!hold) { if (p.hand === 0) tRz += -side; else tLz += side; }
    }
    const sh = p.shout !== undefined && p.shout >= 0 ? shoutPose(p.shout, this.sh) : null;
    if (sh) {
      // chest out and head back, then thrust forward (a weapon held in both hands limits how far the arms go)
      const f = hold ? 0.5 : 1;
      tLx += sh.armX * f; tRx += sh.armX * f;
      tLz += sh.armZ * f; tRz -= sh.armZ * f;
      eL += sh.elbow * f; eR += sh.elbow * f;
      armRate = Math.max(armRate, 38);
      lunge += sh.lunge;
    }
    this.t('upperarm_l', 0, tLx, armRate);
    this.t('upperarm_r', 0, tRx, armRate);
    this.t('forearm_l', 0, eL, armRate);
    this.t('forearm_r', 0, eR, armRate);
    this.t('upperarm_l', 2, tLz, 14);
    this.t('upperarm_r', 2, tRz, 14);
    this.t('hand_l', 0, 0.1 * Math.sin(phase + 1) * move, 12);
    this.t('hand_r', 0, 0.1 * Math.sin(phase + 1) * move, 12);
    if (sh) {
      this.add('spine', 0, sh.spine, 36);
      this.add('chest', 0, sh.chest, 36);
      this.add('neck', 0, sh.neck, 36);
      this.add('head', 0, sh.head, 36);
    }
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

    for (let j = 0; j < this.adj.length; j++) this.tgt[j] += this.adj[j];

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
    // a gliding class hovers a little (more at rest than at a run, and not in the air or when dead)
    const hover = this.style.float ? Math.sin(p.time * 1.5) * 0.014 * this.style.float * (1 - 0.5 * move) * (1 - clamp((p.air - 0.04) * 6, 0, 1)) * (1 - this.deadK) : 0;
    hips.position.y = this.rest[0].y + this.bob + this.drop + hover;
  }
}

const s2 = (v: number) => (v < 0 ? -1 : 1);
