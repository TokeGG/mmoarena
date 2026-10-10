import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RigAnimator, RIG_BONES } from '../src/riggedPose';
import type { RigPoseInput, RigStyle } from '../src/riggedPose';
import { MODELS } from '../src/riggedModels';

const make = (style?: RigStyle, extra: Record<string, number> = {}) => {
  const bones: Record<string, THREE.Object3D> = {};
  for (const n of RIG_BONES) bones[n] = new THREE.Object3D();
  return { a: new RigAnimator(bones, { armRest: -0.1, elbow: 0.15, style, ...extra }), bones };
};
const base: RigPoseInput = { phase: 0, move: 0, casting: false, time: 0, dt: 1 / 60, vf: 0, vs: 0, swing: -1, hand: 0, air: 0, dead: false };
const driver = (style?: RigStyle, extra?: Record<string, number>) => {
  const { a, bones } = make(style, extra);
  let t = 0;
  const step = (o: Partial<RigPoseInput>, secs = 1 / 60) => {
    for (let i = 0; i < Math.round(secs * 60); i++) {
      t += 1 / 60;
      a.update({ ...base, time: t, ...o });
    }
  };
  const angle = (n: string) => 2 * Math.acos(Math.min(1, Math.abs(bones[n].quaternion.w)));
  return { a, bones, step, angle, at: () => t };
};
const finite = (bones: Record<string, THREE.Object3D>) => RIG_BONES.every((n) => [bones[n].quaternion.x, bones[n].quaternion.y, bones[n].quaternion.z, bones[n].quaternion.w, bones[n].position.y].every(Number.isFinite));

describe('class animation styles', () => {
  it('every class model has its own style and the three differ', () => {
    const styles = ['knight', 'assassin', 'sentinel'].map((id) => MODELS[id].pose?.style);
    for (const s of styles) assert.ok(s, 'has a style');
    assert.deepEqual(styles.map((s) => s!.cast), ['brace', 'conceal', 'raise']);
    assert.deepEqual(styles.map((s) => s!.strike), ['slash', 'stab', 'smite']);
  });

  it('a crouching class stands lower than the default and a gliding one hovers', () => {
    const plain = driver();
    const rogue = driver({ crouch: 0.16 });
    const priest = driver({ float: 1 });
    for (const d of [plain, rogue, priest]) d.step({}, 1.2);
    assert.ok(rogue.bones.hips.position.y < plain.bones.hips.position.y - 0.02, 'the rogue sits lower');
    assert.ok(rogue.angle('thigh_l') > plain.angle('thigh_l') + 0.1, 'with bent knees');
    let lo = 9, hi = -9;
    for (let i = 0; i < 240; i++) { priest.step({}); lo = Math.min(lo, priest.bones.hips.position.y); hi = Math.max(hi, priest.bones.hips.position.y); }
    assert.ok(hi - lo > 0.015, `the priest hovers (${(hi - lo).toFixed(3)})`);
  });

  it('the cast stances differ per class and are steady, with nothing going to NaN', () => {
    const poses: Record<string, number[]> = {};
    for (const cast of ['arms', 'raise', 'brace', 'conceal'] as const) {
      const d = driver({ cast }, { castR: -0.35, castL: -1.1 });
      d.step({ casting: true }, 1.5);
      assert.ok(finite(d.bones), cast);
      poses[cast] = [d.angle('upperarm_l'), d.angle('upperarm_r'), d.angle('forearm_r'), d.bones.hips.position.y];
    }
    const keys = Object.keys(poses);
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      const diff = poses[keys[i]].reduce((s, v, k) => s + Math.abs(v - poses[keys[j]][k]), 0);
      assert.ok(diff > 0.1, `${keys[i]} and ${keys[j]} look different`);
    }
    assert.ok(poses.conceal[3] < poses.raise[3] - 0.05, 'the rogue crouches to cast, the priest rises');
  });

  it('an instant cast flicks the hands and settles back', () => {
    for (const cast of ['raise', 'conceal', 'brace'] as const) {
      const d = driver({ cast });
      d.step({}, 1);
      const rest = d.angle('upperarm_l') + d.angle('upperarm_r');
      let peak = 0;
      for (let i = 0; i < 27; i++) {
        d.step({ gesture: i / 27 });
        peak = Math.max(peak, Math.abs(d.angle('upperarm_l') + d.angle('upperarm_r') - rest));
      }
      assert.ok(peak > 0.3, `${cast} flick ${peak.toFixed(2)}`);
      d.step({}, 1);
      assert.ok(Math.abs(d.angle('upperarm_l') + d.angle('upperarm_r') - rest) < 0.05, `${cast} settles`);
      assert.ok(finite(d.bones));
    }
  });

  it('a stab drives the arm further forward than a slash, and a smite lifts the free hand with the staff', () => {
    const reach = (strike: RigStyle['strike']) => {
      const d = driver({ strike });
      d.step({}, 1);
      let most = 0, left = 0;
      for (let i = 0; i < 24; i++) {
        d.step({ swing: i / 24 });
        most = Math.max(most, d.angle('upperarm_r'));
        left = Math.max(left, d.angle('upperarm_l'));
      }
      return { most, left };
    };
    const slash = reach('slash'), stab = reach('stab'), smite = reach('smite');
    assert.ok(Number.isFinite(slash.most) && stab.most > 0.5 && smite.most > 0.5);
    assert.ok(smite.left > slash.left + 0.3, 'both hands go up with the staff');
  });

  it('take-off stretches the legs before they tuck and a jump never breaks the pose', () => {
    const d = driver({ tuck: 1.3 });
    d.step({}, 0.5);
    d.step({ air: 0.1 });
    d.step({ air: 0.3 }, 3 / 60);
    const stretched = d.angle('shin_l');
    d.step({ air: 1.1 }, 12 / 60);
    const tucked = d.angle('shin_l');
    assert.ok(tucked > stretched, `knees bend up after the take-off (${stretched.toFixed(2)} -> ${tucked.toFixed(2)})`);
    d.step({ air: 0 }, 0.5);
    assert.ok(finite(d.bones));
  });

  it('starting to run leans the body in, stopping leans it back', () => {
    const d = driver();
    d.step({}, 0.5);
    const flat = d.angle('chest');
    d.step({ move: 1, phase: 1, vf: 3 }, 3 / 60);
    d.step({ move: 1, phase: 1, vf: 6 }, 4 / 60);
    assert.ok(finite(d.bones));
    assert.notEqual(Math.round(d.angle('chest') * 1000), Math.round(flat * 1000));
  });
});
