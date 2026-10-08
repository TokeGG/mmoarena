import * as THREE from 'three';
import { FIRE_FRAME_COUNT, fireballColors } from './fireballFx';
import type { RigHost } from './fireballFx';
import { FIRE_VISIBLE } from './skillVisuals';
import type { FireFieldShape } from './skillVisuals';

/**
 * A field of flame tongues in the same look as the flipbook Fireball (fireballFx.ts), for the fire skills that burn on the ground or on a
 * body: Flamestrike (`zone`), Scorch (`burst`) and the burning aura (`body`). Built in the same readable layers, back to front:
 * a soft orange glow on the ground over a darker scorch mark that builds up, a dark red body behind every tongue (normal blending, so the
 * fire has a darker edge and depth), a large flipbook tongue and a smaller, hotter one inside it (each with its own size, lick cycle and
 * frame phase, tips leaning along the swirl), a yellow-white flame body with a white-hot core in the middle, and two glow halos.
 * It only moves sprites it was given by the host (the Effects sprite pool) and three small ground meshes it owns, so nothing is created
 * per frame; embers, smoke and sparks are emitted by `Effects` (`fireTongue`, `emberShower`, `smokeWisps`, `fireGroundGlow`, `fireFlash`).
 * Without the flipbook the host's canvas flame is used. Every tongue stays inside `shape.radius` (see `reach`).
 */

export interface FirePlace {
  /** Centre of the field (the foot of a body field). */
  x: number;
  y: number;
  z: number;
  /** Seconds old, for the motion. */
  t: number;
  /** 0..1: how far the fire has grown (the gathering phase of a zone is small, a body field follows its aura's fade-in). */
  build: number;
  /** 0..1 overall opacity (the fade-out at the end). */
  fade: number;
  /** 1 right after a damage tick, decays to 0: the tongues jump and the ground flares. */
  flare: number;
  /** 1 when the fire is lit, decays to 0: a white-hot pillar in the middle. */
  flash: number;
  /** 0..1: how dark the scorch mark on the ground is. */
  scorch: number;
  /** Scale of the whole field (a unit's size for a body field, otherwise 1). */
  sc: number;
}

export const newFirePlace = (): FirePlace => ({ x: 0, y: 0, z: 0, t: 0, build: 1, fade: 1, flare: 0, flash: 0, scorch: 0, sc: 1 });

const _w = new THREE.Vector3();
const smooth = (x: number) => {
  const k = Math.max(0, Math.min(1, x));
  return k * k * (3 - 2 * k);
};
const GOLDEN = 2.39996;

/** Screen-space angle that turns a flipbook flame's tip (up in the sheet) to point along the world vector `v`; 0 without a camera. */
export function tipRotation(v: THREE.Vector3, cam: THREE.Camera | null): number {
  if (!cam) return 0;
  const m = cam.matrixWorldInverse.elements;
  const cx = m[0] * v.x + m[4] * v.y + m[8] * v.z;
  const cy = m[1] * v.x + m[5] * v.y + m[9] * v.z;
  return Math.hypot(cx, cy) > 1e-3 ? Math.atan2(-cx, cy) : 0;
}

interface Tongue {
  under: THREE.Sprite;
  outer: THREE.Sprite;
  inner: THREE.Sprite;
  a0: number;
  /** 0..1 share of the spread: the tongues fill the disc evenly (a sunflower spiral). */
  k: number;
  /** Height share, lick cycle (phase, rate), frame offset and speed, spin direction, yards up the body (body field). */
  hs: number;
  /** Width multiplier: low tongues between the tall ones are broader, so the fire fills the ground. */
  wm: number;
  ph: number;
  rate: number;
  frame: number;
  fps: number;
  dir: number;
  baseY: number;
}

export class FireField {
  readonly colors: ReturnType<typeof fireballColors>;
  /** The farthest a flame reached from the centre in the last `place`, counting half its visible width (yards, at sc 1). */
  reach = 0;
  private tongues: Tongue[] = [];
  private core: THREE.Sprite;
  private hot: THREE.Sprite;
  private halo: THREE.Sprite;
  private halo2: THREE.Sprite;
  private gAdd: THREE.Mesh;
  private gOra: THREE.Mesh;
  private gDark: THREE.Mesh;
  private mats: THREE.MeshBasicMaterial[] = [];
  private alive = true;

  constructor(private host: RigHost, readonly shape: FireFieldShape, heat = 0) {
    const c = (this.colors = fireballColors(heat));
    const order = (sp: THREE.Sprite, o: number) => {
      sp.renderOrder = o;
      return sp;
    };
    const flat = (color: number, additive: boolean, y: number) => {
      const mat = new THREE.MeshBasicMaterial({ color, map: host.glowTex, transparent: true, opacity: 0, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
      const mesh = new THREE.Mesh(host.discGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 1;
      mesh.position.y = y;
      host.scene.add(mesh);
      this.mats.push(mat);
      return mesh;
    };
    this.gDark = flat(0x0e0705, false, 0.045);
    this.gOra = flat(c.ringBase, false, 0.052);
    this.gAdd = flat(c.ground, true, 0.058);
    this.halo2 = order(host.sprite('glow', c.halo2), 2);
    this.halo = order(host.sprite('glow', c.halo), 2);
    const n = shape.tongues;
    for (let i = 0; i < n; i++) {
      const low = shape.kind !== 'body' && i % 2 === 1;
      const under = order(host.sprite('glow', c.outer, false), 3);
      const outer = order(host.sprite('flame', i % 2 ? c.tongueB : c.tongueA), 4);
      const inner = order(host.sprite('flame', i % 3 ? c.shellA : c.body), 5);
      this.tongues.push({
        under, outer, inner,
        a0: i * GOLDEN,
        k: Math.sqrt((i + 0.5) / n),
        hs: low ? 0.4 + 0.12 * ((i * 0.618) % 1) : 0.7 + 0.3 * (((i * 0.618) % 1) ** 0.8),
        wm: low ? 1.4 : 1,
        ph: (i * 0.37) % 1,
        rate: 0.9 + 0.8 * ((i * 0.43) % 1),
        frame: (i * 7) % FIRE_FRAME_COUNT,
        fps: 14 + ((i * 3) % 11),
        dir: shape.kind === 'body' ? 1 : i % 4 === 3 ? -1 : 1,
        baseY: shape.baseLow + (shape.baseHigh - shape.baseLow) * ((i * 0.381966) % 1),
      });
    }
    this.hot = order(host.sprite('flame', c.body), 6);
    this.core = order(host.sprite('glow', c.core), 7);
  }

  private setFrame(sp: THREE.Sprite, frames: THREE.Texture[] | null, f: number) {
    if (frames) (sp.material as THREE.SpriteMaterial).map = frames[f % FIRE_FRAME_COUNT];
  }

  /** Puts the field at `p` and moves every sprite; no allocation. `cam` lets the tips lean along the swirl as seen on screen. */
  place(p: FirePlace, cam: THREE.Camera | null) {
    if (!this.alive) return;
    const sh = this.shape;
    const c = this.colors;
    const body = sh.kind === 'body';
    const sc = p.sc;
    const t = p.t;
    const frames = this.host.frames();
    const fade = Math.max(0, p.fade);
    let reach = 0;

    for (let i = 0; i < this.tongues.length; i++) {
      const q = this.tongues[i];
      const ang = q.a0 + t * sh.swirl * q.dir * (body ? 1 : 1.5 - 0.9 * q.k);
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const rn = (body ? sh.spread * (0.82 + 0.18 * Math.sin(t * 1.7 + q.ph * 6)) : sh.spread * q.k * (1 + 0.03 * Math.sin(t * 2 + q.ph * 6))) * sc;
      const px = p.x + ca * rn;
      const pz = p.z + sa * rn;
      const by = p.y + (body ? q.baseY * sc : 0);
      // grows from the centre outwards, then licks: each tongue rises and sinks on its own cycle
      const g = smooth((p.build * 1.25 - (body ? 0 : q.k * 0.25)) / 0.5);
      const u = (t * q.rate + q.ph) % 1;
      const lick = 0.62 + 0.38 * Math.pow(Math.sin(Math.PI * u), 0.8);
      const flick = 1 + 0.07 * Math.sin(t * 23 + q.ph * 9);
      const hh = sh.height * q.hs * sc * g * fade * lick * flick * (1 + p.flare * 0.5);
      const show = hh > 0.02;
      q.under.visible = q.outer.visible = q.inner.visible = show;
      if (!show) continue;
      const w = hh * sh.wid * q.wm;
      reach = Math.max(reach, rn / sc + (w * 0.5 * FIRE_VISIBLE) / sc);
      // the tip leans along the swirl and a little outwards
      _w.set(-sa * q.dir * 0.35 + ca * 0.12, 1, ca * q.dir * 0.35 + sa * 0.12);
      const rot = tipRotation(_w, cam) + Math.sin(t * 6 + q.ph * 6) * 0.1;
      const op = Math.min(1, g * 2) * fade;

      const us = q.under.material as THREE.SpriteMaterial;
      q.under.position.set(px, by + hh * 0.32, pz);
      q.under.scale.set(w * 1.5, hh * 1.05, 1);
      us.opacity = (body ? 0.17 : 0.34) * op;

      const om = q.outer.material as THREE.SpriteMaterial;
      q.outer.position.set(px, by + hh * 0.4, pz);
      q.outer.scale.set(w, hh, 1);
      om.rotation = rot;
      om.opacity = 0.92 * op;
      this.setFrame(q.outer, frames, q.frame + Math.floor(t * q.fps));

      const im = q.inner.material as THREE.SpriteMaterial;
      q.inner.position.set(px, by + hh * 0.3, pz);
      q.inner.scale.set(w * 0.62, hh * 0.68, 1);
      im.rotation = rot * 0.8;
      im.opacity = 0.82 * op;
      this.setFrame(q.inner, frames, q.frame + 9 + Math.floor(t * (q.fps + 3)));
    }
    this.reach = reach;

    // the white-hot middle: a yellow-white flame body with a hot core, tall and bright when the fire is lit
    const cr = sh.core * sc;
    const lit = Math.max(0, p.flash);
    const bld = Math.max(0.15, p.build);
    const hs = cr * 2.6 * (0.35 + 0.65 * bld) * (1 + 1.2 * lit) + sh.height * 1.5 * lit * sc;
    const cy = body ? p.y + 1.15 * sc : p.y;
    this.hot.visible = this.core.visible = this.halo.visible = this.halo2.visible = fade > 0.01;
    this.hot.position.set(p.x, cy + hs * 0.4, p.z);
    this.hot.scale.set(cr * 2.2 * (0.7 + 0.3 * bld) * (1 + 0.5 * lit), hs, 1);
    const hm = this.hot.material as THREE.SpriteMaterial;
    hm.opacity = (body ? 0.4 : 0.8) * fade * Math.min(1, bld * 2);
    hm.rotation = Math.sin(t * 3) * 0.12;
    this.setFrame(this.hot, frames, 3 + Math.floor(t * 21));
    const cs = cr * 2.0 * (0.4 + 0.6 * bld) * (1 + 0.6 * lit) * (1 + Math.sin(t * 51) * 0.08);
    this.core.position.set(p.x, cy + cr * (body ? 0 : 0.8), p.z);
    this.core.scale.set(cs, cs, 1);
    (this.core.material as THREE.SpriteMaterial).opacity = Math.min(1, (body ? 0.35 : 0.55) + lit * 0.5) * fade;
    const hr = sh.radius * sc * (body ? 1.4 : 1.25) * (0.7 + 0.3 * bld) * (1 + Math.sin(t * 9) * 0.05);
    this.halo.position.set(p.x, p.y + (body ? 1.1 * sc : 0.9 * sc), p.z);
    this.halo.scale.set(hr, hr * (body ? 1.3 : 0.8), 1);
    (this.halo.material as THREE.SpriteMaterial).opacity = ((body ? 0.18 : 0.13) + 0.25 * lit + 0.2 * p.flare) * fade * bld;
    this.halo2.position.copy(this.halo.position);
    this.halo2.scale.set(hr * 1.5, hr * 1.2, 1);
    (this.halo2.material as THREE.SpriteMaterial).opacity = (0.08 + 0.12 * lit + 0.08 * p.flare) * fade * bld;

    // the ground: an orange glow (normal blending under an additive one, so it stays orange on a light floor) over a dark scorch mark
    const gr = sh.radius * sc * (body ? 1.0 : 1.1);
    for (const m of [this.gDark, this.gOra, this.gAdd]) {
      m.position.x = p.x;
      m.position.z = p.z;
      m.scale.set(gr, gr, 1);
    }
    this.gDark.position.y = p.y + 0.045;
    this.gOra.position.y = p.y + 0.052;
    this.gAdd.position.y = p.y + 0.058;
    const gb = Math.max(0.1, p.build) * fade;
    this.mats[0].opacity = 0.62 * p.scorch * (body ? 0 : 1);
    this.mats[1].opacity = (body ? 0.12 : 0.42) * gb + 0.12 * p.flare * fade;
    this.mats[2].opacity = ((body ? 0.16 : 0.4) + 0.08 * Math.sin(t * 9) + 0.3 * p.flare + 0.3 * lit) * gb;
  }

  /** Hands every sprite back and removes the ground meshes. Safe to call twice. */
  dispose() {
    if (!this.alive) return;
    this.alive = false;
    const all = [this.halo2, this.halo, this.hot, this.core, ...this.tongues.flatMap((q) => [q.under, q.outer, q.inner])];
    for (const sp of all) {
      sp.renderOrder = 0;
      this.host.release(sp);
    }
    for (const m of [this.gDark, this.gOra, this.gAdd]) this.host.scene.remove(m);
    for (const m of this.mats) m.dispose();
  }
}
