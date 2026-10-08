import * as THREE from 'three';
import type { ArmHold, RigPoseInput } from './riggedPose';
import { newShoutPose, shoutPose } from './shoutPose';

/**
 * Clip-driven animation for rigged models that ship real animation clips (ModelDef.clips, written by scripts/prep-character.mjs).
 * It is the counterpart of RigAnimator (riggedPose.ts, procedural bones) and takes the same per-frame input, so the Character code
 * does not care which one drives a model. One THREE.AnimationMixer per unit on its own skeleton clone; the clips themselves are
 * shared between units.
 *
 *  - base state (weights cross-fade linearly in `blend` seconds): idle, a walk/run cycle blended by speed (the walk and run
 *    cycles are phase-locked while they overlap; backing up runs the cycle backwards), or the death clip
 *  - attack layer: the attack clip, added on top of the base. Its upper-body tracks (everything but legs and pelvis) are a layer of
 *    their own, so a mage can cast while running; the lower-body tracks only play when the unit stands still. Casting winds up to
 *    `windup` seconds into the clip and holds there until the cast ends, then plays on to the end (the release); a swing / instant
 *    cast plays the whole clip.
 *  - death: the death clip runs up to `deathHold` seconds and is held there (the clip's own last frame is a standing pose with the
 *    arms out, not a corpse); the body then topples forward onto the ground.
 *
 * Layers are mixed with three.js' running weighted average per property: the base weights always sum to 1 and a layer of strength a
 * gets the weight a / (1 - a), which averages out to exactly a of the layer and 1 - a of the base. No allocations per frame.
 */

export interface ClipOpts {
  /** Clip names in the file (default: the same words). */
  idle?: string;
  walk?: string;
  run?: string;
  attack?: string;
  death?: string;
  /** Speed (yd/s) that plays the walk and run cycles at the clips' own pace; the cycle rate scales with the real speed. */
  walkSpeed?: number;
  runSpeed?: number;
  /** Seconds into the attack clip where a cast is held until it finishes. */
  windup?: number;
  /** Seconds into the death clip where the pose is held. */
  deathHold?: number;
  /** Cross-fade seconds. */
  blend?: number;
  /** Bone name pattern (regex source) of the lower body: those tracks are not part of the attack's upper layer. */
  lower?: string;
  /** How much of the shout pose (shoutPose.ts) the clip skeleton takes (default 0.9). */
  shoutGain?: number;
  /**
   * A standing correction for a model whose own clips are stooped or leaning (radians about the character's left axis, positive tips the
   * top forward), turned onto the spine, chest, neck and head after the mixer every frame. It fades out while the body topples and a
   * little in a cast (the cast clip already throws the body about), so the animations still read.
   */
  posture?: { spine?: number; chest?: number; neck?: number; head?: number; run?: number };
}

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const layerWeight = (a: number) => {
  const k = clamp(a, 0, 0.97);
  return k / (1 - k);
};
const _pq = new THREE.Quaternion();
const _pqi = new THREE.Quaternion();
const _rq = new THREE.Quaternion();
const _rqi = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _eul = new THREE.Euler();
const easeOut = (x: number) => 1 - (1 - clamp(x, 0, 1)) ** 3;

const find = (clips: THREE.AnimationClip[], name: string) => {
  const c = clips.find((x) => x.name === name);
  if (!c) throw new Error(`clip "${name}" missing (have ${clips.map((x) => x.name).join(', ')})`);
  return c;
};

/** Split a clip by bone: the tracks of bones matching `lower` and the rest. */
function splitClip(clip: THREE.AnimationClip, lower: RegExp) {
  const up: THREE.KeyframeTrack[] = [];
  const low: THREE.KeyframeTrack[] = [];
  for (const t of clip.tracks) (lower.test(t.name.split('.')[0]) ? low : up).push(t);
  return [new THREE.AnimationClip(`${clip.name}:upper`, clip.duration, up), new THREE.AnimationClip(`${clip.name}:lower`, clip.duration, low)] as const;
}

export class ClipAnimator {
  /** Same fields as RigAnimator, so the Character code treats both alike (a clip model holds its weapon in the clips). */
  hold: ArmHold | null = null;
  lungeZ = 0;
  /** The death sequence (clip, then the fall) belongs to this animator: the Character leaves the body upright. */
  readonly ownDeath = true;
  readonly castable = true;
  /** The model's body group, turned and laid down by the animator (strafe lean, the fall). */
  readonly body: THREE.Object3D;
  readonly mixer: THREE.AnimationMixer;
  private readonly o: Required<ClipOpts>;
  private readonly idle: THREE.AnimationAction;
  private readonly walk: THREE.AnimationAction;
  private readonly run: THREE.AnimationAction;
  private readonly death: THREE.AnimationAction;
  private readonly atkUp: THREE.AnimationAction;
  private readonly atkLow: THREE.AnimationAction;
  private readonly attackDur: number;
  private readonly walkDur: number;
  private readonly runDur: number;
  /** Base weights: idle, walk, run, death. */
  private readonly w = [1, 0, 0, 0];
  private readonly tw = [1, 0, 0, 0];
  private atk: 'none' | 'wind' | 'hold' | 'release' | 'full' = 'none';
  private atkT = 0;
  private atkW = 0;
  private cycle = 0;
  private deathT = 0;
  private fall = 0;
  private yaw = 0;
  private lastSwing = -1;
  private wasDead = false;
  private lastCasting = false;
  /** The canonical bones (set by the model builder) that the shout overlay turns after the mixer has run; without them the overlay is skipped. */
  bones: Record<string, THREE.Object3D> | null = null;
  private readonly sh = newShoutPose();

  constructor(body: THREE.Object3D, clips: THREE.AnimationClip[], opts: ClipOpts = {}) {
    this.body = body;
    this.o = {
      idle: 'idle', walk: 'walk', run: 'run', attack: 'attack', death: 'death',
      walkSpeed: 2.6, runSpeed: 4.7, windup: 0.4, deathHold: 1.0, blend: 0.2, shoutGain: 0.9,
      lower: 'Pelvis|Thigh|Calf|Foot|Toe|Bip01_01$',
      posture: {},
      ...opts,
    };
    this.mixer = new THREE.AnimationMixer(body);
    const act = (c: THREE.AnimationClip, loop: THREE.AnimationActionLoopStyles = THREE.LoopRepeat) => {
      const a = this.mixer.clipAction(c);
      a.setLoop(loop, Infinity);
      a.clampWhenFinished = true;
      a.play();
      a.setEffectiveWeight(0);
      return a;
    };
    this.idle = act(find(clips, this.o.idle));
    this.walk = act(find(clips, this.o.walk));
    this.run = act(find(clips, this.o.run));
    this.death = act(find(clips, this.o.death), THREE.LoopOnce);
    const attack = find(clips, this.o.attack);
    const [up, low] = splitClip(attack, new RegExp(this.o.lower));
    this.atkUp = act(up);
    this.atkLow = act(low);
    this.attackDur = attack.duration;
    this.walkDur = this.walk.getClip().duration;
    this.runDur = this.run.getClip().duration;
    for (const a of [this.walk, this.run, this.death, this.atkUp, this.atkLow]) a.timeScale = 0; // times are set by hand
    this.idle.setEffectiveWeight(1);
    this.mixer.update(0); // the idle pose at t = 0: anchors are measured from it
  }

  /** Current weights of the base clips and the attack layer (tests, debugging). */
  state() {
    return { idle: this.w[0], walk: this.w[1], run: this.w[2], death: this.w[3], attack: this.atkW, phase: this.atk, fall: this.fall };
  }

  /** The attack clip's own pace: a trigger (swing, instant cast) while nothing is going on plays all of it. */
  private trigger() {
    if (this.atk === 'wind' || this.atk === 'hold') this.atk = 'release';
    else {
      this.atk = 'full';
      this.atkT = 0;
    }
  }

  update(p: RigPoseInput) {
    const dt = clamp(p.dt, 0.001, 0.1);
    // ---- what the unit is doing
    const speed = Math.hypot(p.vf, p.vs) * (p.air > 0.08 ? 0 : 1);
    const dead = p.dead;
    if (dead && !this.wasDead) this.deathT = 0;
    if (!dead && this.wasDead) {
      this.fall = 0;
      this.atk = 'none';
    }
    this.wasDead = dead;
    if (p.swing >= 0 && this.lastSwing < 0 && !dead) this.trigger();
    this.lastSwing = p.swing;
    if (!dead) {
      if (p.casting && !this.lastCasting && this.atk !== 'wind' && this.atk !== 'hold') {
        this.atk = 'wind';
        this.atkT = 0;
      } else if (!p.casting && this.lastCasting && (this.atk === 'wind' || this.atk === 'hold')) this.atk = 'release';
    }
    this.lastCasting = p.casting;

    // ---- base weights
    const walkAmt = speed < 0.5 ? 0 : clamp((speed - 0.5) / 1.0, 0, 1);
    const runAmt = clamp((speed - 3.6) / 2.0, 0, 1);
    this.tw[0] = dead ? 0 : 1 - walkAmt;
    this.tw[1] = dead ? 0 : walkAmt * (1 - runAmt);
    this.tw[2] = dead ? 0 : walkAmt * runAmt;
    this.tw[3] = dead ? 1 : 0;
    const step = dt / this.o.blend;
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      this.w[i] += clamp(this.tw[i] - this.w[i], -step, step);
      sum += this.w[i];
    }
    if (sum < 1e-4) this.w[dead ? 3 : 0] = sum = 1;
    for (let i = 0; i < 4; i++) this.w[i] /= sum;

    // ---- the walk / run cycle (phase locked, reversed when backing up)
    if (speed > 0.3) {
      const rate = clamp(0.26 * speed * (speed < 4 ? 1 : 0.9), 0.35, 1.9); // cycles per second
      this.cycle = (this.cycle + (p.vf < -0.6 ? -1 : 1) * rate * dt + 1) % 1;
    }
    this.walk.time = this.cycle * this.walkDur;
    this.run.time = this.cycle * this.runDur;

    // ---- death: run to the hold point, then topple
    if (dead) {
      this.deathT = Math.min(this.deathT + dt, this.o.deathHold);
      if (this.deathT >= this.o.deathHold) this.fall = Math.min(1, this.fall + dt / 0.5);
    }
    this.death.time = this.deathT;

    // ---- attack layer
    const was = this.atk;
    if (this.atk === 'wind') {
      this.atkT += dt * 1.6;
      if (this.atkT >= this.o.windup) {
        this.atkT = this.o.windup;
        this.atk = 'hold';
      }
    } else if (this.atk === 'hold') {
      this.atkT = this.o.windup + 0.05 * Math.sin(p.time * 7); // a slight tremble while the spell gathers
    } else if (this.atk === 'release' || this.atk === 'full') {
      this.atkT += dt * (this.atk === 'full' ? 1.3 : 1.4);
      if (this.atkT >= this.attackDur) {
        this.atkT = this.attackDur;
        this.atk = 'none';
      }
    }
    void was;
    const target = this.atk === 'none' || dead ? 0 : this.atk === 'wind' ? clamp(this.atkT / 0.15, 0, 1) : this.atk === 'release' || this.atk === 'full' ? clamp((this.attackDur - this.atkT) / 0.2, 0, 1) : 1;
    this.atkW += clamp(target - this.atkW, -dt / 0.12, dt / 0.12);
    const stillness = 1 - walkAmt;
    this.atkUp.time = this.atkLow.time = this.atkT;
    this.atkUp.setEffectiveWeight(layerWeight(this.atkW));
    this.atkLow.setEffectiveWeight(layerWeight(this.atkW * stillness));

    this.idle.setEffectiveWeight(this.w[0]);
    this.walk.setEffectiveWeight(this.w[1]);
    this.run.setEffectiveWeight(this.w[2]);
    this.death.setEffectiveWeight(this.w[3]);
    this.idle.timeScale = 1;

    // ---- body: lean into a strafe, lie down after death
    const dir = Math.atan2(p.vs, Math.max(Math.abs(p.vf), 0.5));
    this.yaw += (clamp(dir, -1, 1) * 0.4 * (p.vf < -0.6 ? -1 : 1) * clamp(speed / 3, 0, 1) - this.yaw) * (1 - Math.exp(-10 * dt));
    this.body.rotation.y = this.yaw;
    const f = easeOut(this.fall);
    this.body.rotation.x = f * (Math.PI / 2);
    this.body.position.y = f * 0.2;
    this.body.position.z = -f * 0.9;
    this.mixer.update(dt);
    const po = this.o.posture;
    const posture = !!this.bones && !!(po.spine || po.chest || po.neck || po.head);
    // the correction belongs to standing and walking; a run leans forward on purpose (`run` is the share kept), a cast and the fall take it away
    const pg = posture ? (1 - this.w[3]) * (1 - 0.45 * this.atkW) * (1 - (1 - (po.run ?? 1)) * this.w[2]) : 0;
    if (!dead && this.bones && p.shout !== undefined && p.shout >= 0) this.overlayShout(p.shout, pg);
    else if (pg > 0.001) {
      this.lungeZ = 0;
      this.overlayShout(-1, pg);
    } else {
      this.lungeZ = 0;
      if (this.rebased.size) this.releaseOverlay();
    }
  }

  /** Per bone: its rotation before the overlay and the one the overlay wrote (a bone no clip keys is not rewritten by the mixer, so the overlay would add up frame after frame). */
  private readonly rebased = new Map<string, { base: THREE.Quaternion; out: THREE.Quaternion }>();

  /** Puts a bone back to what the clips (or the rest pose) say, undoing last frame's overlay, and notes it. */
  private rebase(name: string, b: THREE.Object3D) {
    let e = this.rebased.get(name);
    if (!e) this.rebased.set(name, (e = { base: b.quaternion.clone(), out: b.quaternion.clone() }));
    else if (b.quaternion.equals(e.out)) b.quaternion.copy(e.base);
    else e.base.copy(b.quaternion);
  }

  /** After a shout: every bone the overlay turned goes back to its base rotation. */
  private releaseOverlay() {
    for (const [name, e] of this.rebased) {
      const b = this.bones?.[name];
      if (b && b.quaternion.equals(e.out)) b.quaternion.copy(e.base);
    }
    this.rebased.clear();
  }

  /** Turns a bone by a rotation given in character space (x = the character's left, +z forward), on top of what the clips just wrote. */
  private turn(name: string, x: number, y: number, z: number) {
    const b = this.bones?.[name];
    if (!b || !b.parent) return;
    this.rebase(name, b);
    b.parent.getWorldQuaternion(_pq);
    _pqi.copy(_pq).invert();
    this.body.parent?.getWorldQuaternion(_rq);
    _rqi.copy(_rq).invert();
    // local' = parentWorld^-1 * (root * delta * root^-1) * parentWorld * local
    _dq.setFromEuler(_eul.set(x, y, z)).premultiply(_rq).multiply(_rqi);
    b.quaternion.premultiply(_pqi.multiply(_dq).multiply(_pq));
    this.rebased.get(name)!.out.copy(b.quaternion);
  }

  /** The shout pose (shoutPose.ts) on the spine, head and arms. Applies after the mixer: the clips own the bones every frame, so nothing accumulates. */
  private overlayShout(q: number, pg = 0) {
    const sh = shoutPose(Math.max(q, 0), this.sh);
    const g = q < 0 ? 0 : this.o.shoutGain;
    for (const k of ['spine', 'chest', 'neck', 'head', 'armX', 'armZ', 'elbow'] as const) sh[k] *= g;
    if (q < 0) sh.lunge = 0;
    const po = this.o.posture;
    sh.spine += (po.spine ?? 0) * pg;
    sh.chest += (po.chest ?? 0) * pg;
    sh.neck += (po.neck ?? 0) * pg;
    sh.head += (po.head ?? 0) * pg;
    this.body.updateMatrixWorld(true);
    this.turn('spine', sh.spine, 0, 0);
    this.turn('chest', sh.chest, 0, 0);
    this.turn('neck', sh.neck, 0, 0);
    this.turn('head', sh.head, 0, 0);
    this.turn('upperarm_l', sh.armX, 0, sh.armZ);
    this.turn('upperarm_r', sh.armX, 0, -sh.armZ);
    this.turn('forearm_l', sh.elbow, 0, 0);
    this.turn('forearm_r', sh.elbow, 0, 0);
    this.lungeZ = sh.lunge;
    this.body.updateMatrixWorld(true);
  }
}
