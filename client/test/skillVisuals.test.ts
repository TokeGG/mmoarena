import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, AURAS } from '@arena/shared';
import * as THREE from 'three';
import { ABILITY_VISUAL, AURA_VISUAL, CONE_EDGE, LayerBook, SHOUT_ABILITIES, TAIL_FULL_AT, WINDUP_CAP, auraVisualsOf, coneShape, coneSpawnAngle, dotAurasFor, fireballLookFor, fireballShape, fireballTailScale, isDotTick, layerAlpha, visualFor, windupScale } from '../src/skillVisuals';
import { FIRE_FRAME_COUNT, FireballRig, fireballColors, makeRibbonTexture } from '../src/fireballFx';
import type { RigHost } from '../src/fireballFx';
import { RIG_BONES, RigAnimator } from '../src/riggedPose';
import { SHOUT_DUR, SHOUT_RELEASE, newShoutPose, shoutPose } from '../src/shoutPose';
import type { AuraStyle, VisualClass } from '../src/skillVisuals';

const live = Object.values(ABILITIES).filter((a) => !a.retired);

describe('ability visual classes', () => {
  it('lists every non-retired ability exactly once, and nothing unknown', () => {
    const missing = live.filter((a) => !ABILITY_VISUAL[a.id]).map((a) => a.id);
    assert.deepEqual(missing, []);
    const unknown = Object.keys(ABILITY_VISUAL).filter((id) => !ABILITIES[id]);
    assert.deepEqual(unknown, []);
    const retired = Object.keys(ABILITY_VISUAL).filter((id) => ABILITIES[id]?.retired);
    assert.deepEqual(retired, []);
  });
  it('only genuinely flying things are projectiles', () => {
    const proj = live.filter((a) => visualFor(a).cls === 'projectile').map((a) => a.id).sort();
    assert.deepEqual(proj, ['arcane_blast', 'axe_throw', 'fireball', 'frostbolt', 'pyroblast', 'smite']);
  });
  it('scorch erupts under the target and is no projectile', () => {
    const v = visualFor(ABILITIES.scorch);
    assert.equal(v.cls, 'onTarget');
    assert.deepEqual(v.hit, { kind: 'fire', style: 'eruption' });
  });
  it('priest damage-over-time spells apply an aura', () => {
    for (const id of ['plague_bloom', 'shadow_word_death']) assert.equal(visualFor(ABILITIES[id]).cls, 'aura');
  });
  it('instant damage at range lands on the target, not as a bolt', () => {
    for (const a of live) {
      if (a.target !== 'enemy' || a.range <= 6 || a.channel) continue;
      const cls: VisualClass = visualFor(a).cls;
      if (a.castTime === 0 && !['fireball', 'axe_throw'].includes(a.id)) assert.notEqual(cls, 'projectile', a.id);
    }
  });
  it('onTarget and aura entries say what to draw; nothing else does', () => {
    for (const a of live) {
      const v = visualFor(a);
      assert.equal(!!v.hit, v.cls === 'onTarget' || v.cls === 'aura', a.id);
    }
  });
  it('guesses a sane class for retired abilities', () => {
    for (const a of Object.values(ABILITIES).filter((x) => x.retired)) assert.ok(visualFor(a).cls, a.id);
  });
});

describe('aura visuals', () => {
  it('every damage-over-time aura has a visual', () => {
    const dots = Object.entries(AURAS).filter(([, d]) => d.dot).map(([id]) => id);
    assert.ok(dots.length >= 6);
    assert.deepEqual(dots.filter((id) => !AURA_VISUAL[id]), []);
  });
  it('only refers to real auras with known styles and sane strength', () => {
    const styles: AuraStyle[] = ['shadow', 'bleed', 'burn', 'frost', 'holy', 'poison'];
    for (const [id, v] of Object.entries(AURA_VISUAL)) {
      assert.ok(AURAS[id], id);
      assert.ok(styles.includes(v.style), id);
      assert.ok(v.strength > 0 && v.strength <= 1.5, id);
    }
  });
  it('maps the examples to the right looks', () => {
    assert.equal(AURA_VISUAL.plague_bloom.style, 'shadow');
    assert.equal(AURA_VISUAL.garrote_bleed.style, 'bleed');
    assert.equal(AURA_VISUAL.burn.style, 'burn');
    assert.equal(AURA_VISUAL.frost_nova_root.style, 'frost');
    assert.equal(AURA_VISUAL.renew.style, 'holy');
    assert.ok(AURA_VISUAL.penance_barrier.bubble);
  });
  it('finds the visuals of a unit', () => {
    assert.deepEqual(auraVisualsOf(['stealth', 'burn', 'renew']).map((x) => x.id), ['burn', 'renew']);
  });
});

describe('damage ticks', () => {
  it('knows which aura a tick belongs to', () => {
    assert.deepEqual(dotAurasFor('plague_bloom'), ['plague_bloom']);
    assert.deepEqual(dotAurasFor(null), []);
  });
  it('the direct hit of a cast is not a tick; later hits while the aura is up are', () => {
    assert.equal(isDotTick('plague_bloom', ['plague_bloom'], 0), null);
    assert.equal(isDotTick('plague_bloom', ['plague_bloom'], 1), 'plague_bloom');
    assert.equal(isDotTick('plague_bloom', [], 1), null);
    assert.equal(isDotTick('fireball', ['burn'], 1), 'burn');
    assert.equal(isDotTick('frostbolt', ['burn'], 1), null);
  });
});

describe('layer lifetime', () => {
  it('fades in and out', () => {
    assert.equal(layerAlpha(0, null), 0);
    assert.equal(layerAlpha(1, null), 1);
    assert.ok(layerAlpha(1, 0.2) < 1 && layerAlpha(1, 0.2) > 0);
    assert.equal(layerAlpha(1, 0.5), 0);
  });
  it('keeps wanted layers and disposes each gone one exactly once', () => {
    const book = new LayerBook();
    assert.deepEqual(book.step(new Set(['1:a', '2:b']), 0.016), []);
    assert.equal(book.size, 2);
    assert.equal(book.goneFor('1:a'), null);
    assert.deepEqual(book.step(new Set(['2:b']), 0.2), []);
    assert.equal(book.goneFor('1:a'), 0.2);
    assert.deepEqual(book.step(new Set(['2:b']), 0.3), ['1:a']);
    assert.deepEqual(book.step(new Set(['2:b']), 0.3), []);
    assert.equal(book.size, 1);
  });
  it('a layer that comes back stops fading', () => {
    const book = new LayerBook();
    book.step(new Set(['x']), 0.016);
    book.step(new Set(), 0.3);
    assert.deepEqual(book.step(new Set(['x']), 0.016), []);
    assert.equal(book.goneFor('x'), null);
  });
  it('everything is disposed when the unit dies or leaves', () => {
    const book = new LayerBook();
    book.step(new Set(['1:a', '1:b', '1:c']), 0.016);
    const out = book.step(new Set(), 1);
    assert.deepEqual(out.sort(), ['1:a', '1:b', '1:c']);
    assert.equal(book.size, 0);
  });
});

describe('cones of flame match the real cone', () => {
  it('Dragon\'s Breath and Dragon Roar are cones of their own range and width', () => {
    for (const id of ['dragons_breath', 'dragon_roar', 'reel_in']) {
      const def = ABILITIES[id];
      const c = coneShape(def)!;
      assert.ok(c, id);
      assert.equal(c.range, def.radius);
      assert.equal(c.deg, def.coneDeg);
      assert.ok(Math.abs(c.half * 2 - (def.coneDeg! * Math.PI) / 180) < 1e-9, id);
    }
  });
  it('full circles are no cones', () => {
    for (const id of ['frost_nova', 'holy_nova', 'intimidating_shout', 'psychic_scream', 'whirlwind']) assert.equal(coneShape(ABILITIES[id]), null, id);
  });
  it('every flame is spawned inside the cone', () => {
    for (const id of ['dragons_breath', 'dragon_roar']) {
      const { half } = coneShape(ABILITIES[id])!;
      for (let i = -20; i <= 20; i++) assert.ok(Math.abs(coneSpawnAngle(i / 20, half)) <= half * CONE_EDGE + 1e-9);
      assert.ok(Math.abs(coneSpawnAngle(5, half)) <= half, 'out of range input is clamped');
    }
  });
});

describe('shout pose', () => {
  it('shouting abilities exist, are live and are warrior, priest, mage shouts and breaths', () => {
    for (const id of SHOUT_ABILITIES) assert.ok(ABILITIES[id] && !ABILITIES[id].retired, id);
  });
  it('leans back, snaps forward on release and settles to nothing', () => {
    const sh = newShoutPose();
    shoutPose(SHOUT_RELEASE / SHOUT_DUR - 0.001, sh);
    assert.ok(sh.chest < -0.2 && sh.head < -0.2 && sh.spine < 0, 'back at the end of the wind-up');
    assert.ok(sh.armZ > 0.3, 'arms out');
    shoutPose((SHOUT_RELEASE + 0.14) / SHOUT_DUR + 0.001, sh);
    assert.ok(sh.chest > 0.1 && sh.head > 0.1, 'forward after the release');
    shoutPose(0.999, sh);
    assert.ok(Math.abs(sh.chest) < 0.01 && Math.abs(sh.armX) < 0.01 && Math.abs(sh.lunge) < 0.01, 'settled');
    shoutPose(-1, sh);
    assert.deepEqual(sh, newShoutPose());
    shoutPose(1, sh);
    assert.deepEqual(sh, newShoutPose());
  });
  it('turns the rig\'s bones and gives them back', () => {
    const bones: Record<string, THREE.Object3D> = {};
    let parent: THREE.Object3D = new THREE.Object3D();
    for (const n of RIG_BONES) {
      const b = new THREE.Bone();
      b.name = n;
      parent.add(b);
      bones[n] = b;
    }
    const rig = new RigAnimator(bones, {});
    const input = { phase: 0, move: 0, casting: false, time: 0, dt: 1 / 60, vf: 0, vs: 0, swing: -1, hand: 0, air: 0, dead: false };
    const settle = (shout: number | undefined, frames: number) => {
      for (let i = 0; i < frames; i++) rig.update({ ...input, time: i / 60, shout });
    };
    settle(undefined, 120);
    const rest = ['chest', 'head', 'upperarm_l', 'upperarm_r'].map((n) => bones[n].quaternion.clone());
    // wind-up end: chest, head and arms are away from the rest pose
    for (let i = 0; i < 15; i++) rig.update({ ...input, time: i / 60, shout: i / 60 / SHOUT_DUR });
    const moved = ['chest', 'head', 'upperarm_l', 'upperarm_r'].map((n, i) => bones[n].quaternion.angleTo(rest[i]));
    for (const a of moved) assert.ok(a > 0.1, `bone turned ${a}`);
    // and back at rest once the pose is over
    settle(undefined, 180);
    ['chest', 'head', 'upperarm_l', 'upperarm_r'].forEach((n, i) => assert.ok(bones[n].quaternion.angleTo(rest[i]) < 0.06, `${n} back at rest`));
  });
});

describe('flipbook fireball', () => {
  it('Fireball and Pyroblast pick the look from the data row; nothing else does', () => {
    const ids = Object.keys(ABILITY_VISUAL).filter((id) => ABILITY_VISUAL[id].proj);
    assert.deepEqual(ids.sort(), ['fireball', 'pyroblast']);
    for (const id of ids) {
      assert.equal(ABILITY_VISUAL[id].cls, 'projectile', id);
      assert.equal(ABILITIES[id].school, 'fire', id);
      assert.equal(fireballLookFor(id)?.look, 'fireball');
    }
    assert.equal(fireballLookFor('frostbolt'), null);
    assert.equal(fireballLookFor(null), null);
  });

  it('Pyroblast is bigger, redder and more intense than Fireball', () => {
    const f = fireballLookFor('fireball')!;
    const p = fireballLookFor('pyroblast')!;
    assert.ok(p.size > f.size && p.heat > f.heat);
    const a = fireballShape(f.size, f.heat);
    const b = fireballShape(p.size, p.heat);
    for (const k of ['core', 'shell', 'halo', 'tail', 'flare', 'flames', 'embers', 'smoke', 'ring'] as const) assert.ok(b[k] > a[k], k);
    assert.ok(a.shellSprites >= 5 && b.shellSprites >= a.shellSprites, 'a rolling shell of several sprites');
    assert.ok(a.tailSpacing > 0.05 && a.tailSpacing < 0.5 && a.embersPerSec > 0);
    // a darker, redder palette at full heat
    const cool = new THREE.Color(fireballColors(0).halo);
    const hot = new THREE.Color(fireballColors(1).halo);
    assert.ok(hot.g < cool.g && hot.r <= cool.r, 'redder halo');
  });

  it('the rig uses pooled sprites only: nothing is created per frame and everything is handed back', () => {
    const live = new Set<THREE.Sprite>();
    let made = 0;
    const scene = new THREE.Scene();
    const host: RigHost = {
      scene,
      sprite: () => {
        made++;
        const sp = new THREE.Sprite(new THREE.SpriteMaterial());
        live.add(sp);
        return sp;
      },
      release: (sp) => void live.delete(sp),
      frames: () => Array.from({ length: FIRE_FRAME_COUNT }, () => new THREE.Texture()),
      glowTex: new THREE.Texture(),
      discGeo: new THREE.CircleGeometry(1, 8),
    };
    const rig = new FireballRig(host, fireballLookFor('pyroblast')!);
    const sprites = made;
    assert.ok(sprites >= 10, 'core, halos, shell and tail');
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    cam.position.set(5, 2, 0);
    cam.lookAt(0, 1.5, 10);
    cam.updateMatrixWorld(true);
    const p = new THREE.Vector3(0, 1.5, 0);
    const dir = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < 120; i++) {
      p.z += 0.5;
      rig.place(p, dir, i / 60, Math.min(1, i / 30), i > 10, i % 2 ? cam : null, 0);
      assert.ok(Number.isFinite(rig.backRot) && rig.fore >= 0 && rig.fore <= 1);
    }
    assert.equal(made, sprites, 'no sprite made while it flies');
    // seen from the side, the tail points straight back on screen; head on it is foreshortened to nothing
    cam.position.set(5, 1.5, p.z);
    cam.lookAt(0, 1.5, p.z);
    cam.updateMatrixWorld(true);
    rig.place(p, dir, 1, 1, true, cam, 0);
    assert.ok(rig.fore > 0.95, `side-on ${rig.fore}`);
    cam.position.set(0, 1.5, p.z - 5);
    cam.lookAt(0, 1.5, p.z);
    cam.updateMatrixWorld(true);
    rig.place(p, dir, 1, 1, true, cam, 0);
    assert.ok(rig.fore < 0.1, `head-on ${rig.fore}`);
    rig.dispose();
    rig.dispose();
    assert.equal(live.size, 0, 'every sprite handed back');
    assert.equal(scene.children.length, 0, 'the ground glow is out of the scene');
  });
});

describe('fireball polish', () => {
  it('a short throw gets a shorter tail, a long one the full tail', () => {
    const f = fireballShape(1, 0);
    assert.equal(fireballTailScale(40, f.tail), 1);
    assert.equal(fireballTailScale(f.tail * TAIL_FULL_AT, f.tail), 1);
    assert.equal(fireballTailScale(Infinity, f.tail), 1, 'unknown range: full');
    const short = fireballTailScale(5, f.tail);
    assert.ok(short >= 0.4 && short < 0.5, `5 yd ${short}`);
    assert.ok(f.tail * short < 5 * 0.4, 'the tail stays well under half of a 5 yd throw');
    let last = 0;
    for (const r of [1, 3, 5, 8, 12, 16, 30]) {
      const k = fireballTailScale(r, f.tail);
      assert.ok(k >= last && k <= 1 && k >= 0.4, `monotonic at ${r}`);
      last = k;
    }
  });

  it('the ball in the hand never takes more than a share of the screen', () => {
    const p = fireballShape(1.7, 1);
    const radius = p.shell * 2.6 * 0.71;
    assert.equal(windupScale(40, radius), 1, 'far camera: unchanged');
    for (const d of [0.5, 1, 2, 3, 5, 8]) {
      const k = windupScale(d, radius);
      assert.ok(k > 0.1 && k <= 1, `scale ${k} at ${d}`);
      if (k > 0.15) assert.ok((radius * k) / d <= WINDUP_CAP + 1e-9, `apparent size at ${d} yd`);
    }
    assert.ok(windupScale(2, radius) < windupScale(6, radius), 'closer = smaller');
    assert.equal(windupScale(5, 0), 1);
    assert.equal(windupScale(0, 1), 1);
  });

  it('the rig is built in layers, keeps its tail short on a short throw and scales down with sizeMul', () => {
    const live = new Set<THREE.Sprite>();
    let made = 0;
    const scene = new THREE.Scene();
    const host: RigHost = {
      scene,
      sprite: () => {
        made++;
        const sp = new THREE.Sprite(new THREE.SpriteMaterial());
        live.add(sp);
        return sp;
      },
      release: (sp) => void live.delete(sp),
      frames: () => Array.from({ length: FIRE_FRAME_COUNT }, () => new THREE.Texture()),
      glowTex: new THREE.Texture(),
      discGeo: new THREE.CircleGeometry(1, 8),
      ribbonTex: makeRibbonTexture(),
    };
    const look = fireballLookFor('fireball')!;
    const sh = fireballShape(look.size, look.heat);
    assert.ok(sh.tongues >= 2 && sh.tongues < sh.shellSprites, 'a few large tongues among smaller licks');
    const meshes = () => scene.children.filter((o) => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.getAttribute('color'));
    const fly = (range: number, size = 1) => {
      const rig = new FireballRig(host, look);
      rig.range = range;
      rig.sizeMul = size;
      const p = new THREE.Vector3(0, 1.5, 0);
      const dir = new THREE.Vector3(0, 0, 1);
      const sprites = made;
      for (let i = 0; i < 90; i++) {
        p.z += 0.6;
        rig.place(p, dir, i / 60, 1, true, null, 0);
      }
      assert.equal(made, sprites, 'nothing made while it flies');
      return rig;
    };
    const near = fly(5);
    const far = fly(40);
    assert.ok(near.tailLen > 0.5 && near.tailLen < far.tailLen * 0.55, `tail ${near.tailLen} at 5 yd vs ${far.tailLen} at 40 yd`);
    assert.ok(far.tailLen <= sh.tail * 1.001);
    const small = fly(40, 0.4);
    assert.ok(small.tailLen < far.tailLen * 0.5, 'sizeMul scales the tail');
    // two ribbons per ball (fire and smoke), one geometry each, with a soft colour and alpha per vertex
    assert.equal(meshes().length, 6);
    const rib = meshes()[1] as THREE.Mesh; // the fire ribbon (the smoke one is made first)
    const pos = rib.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = rib.geometry.getAttribute('color') as THREE.BufferAttribute;
    assert.equal(col.itemSize, 4);
    assert.ok(Array.from(pos.array).every(Number.isFinite), 'finite ribbon');
    // it starts at the head, ends at nothing
    assert.ok(col.getW(0) > 0.5 && col.getW(pos.count - 1) === 0, 'bright at the head, gone at the end');
    // at rest the tail is hidden
    const rest = new FireballRig(host, look);
    rest.place(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(0, 0, 1), 0.5, 0.5, false, null, 0);
    assert.equal(rest.tailLen, 0);
    for (const r of [near, far, small, rest]) r.dispose();
    assert.equal(live.size, 0, 'every sprite handed back');
    assert.equal(scene.children.length, 0, 'ribbons and ground glow out of the scene');
  });

  it('pooled sprites come back with their render order reset', () => {
    const pool: THREE.Sprite[] = [];
    const scene = new THREE.Scene();
    const host: RigHost = {
      scene,
      sprite: () => pool.pop() ?? new THREE.Sprite(new THREE.SpriteMaterial()),
      release: (sp) => void pool.push(sp),
      frames: () => null,
      glowTex: new THREE.Texture(),
      discGeo: new THREE.CircleGeometry(1, 8),
    };
    const rig = new FireballRig(host, fireballLookFor('pyroblast')!);
    rig.place(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(0, 0, 1), 0.1, 1, true, null, 0);
    rig.dispose();
    assert.ok(pool.length >= 15, 'layers handed back');
    assert.ok(pool.every((s) => s.renderOrder === 0), 'render order reset for the next user of the pool');
    assert.equal(scene.children.length, 0);
  });
});
