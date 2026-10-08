import * as THREE from 'three';
import { fireballShape, fireballTailScale } from './skillVisuals';
import type { FireballLook, FireballShape } from './skillVisuals';

/**
 * The persistent part of a flipbook fireball (Fireball, Pyroblast), built in readable layers: a dark red body (normal blending, so
 * the fire has a darker edge and depth), three large flame tongues of different sizes that lick round the ball and trail back, a few
 * small flames close to the core, a yellow-white flame body with a white-hot core, two glow halos, a continuous tapered ribbon for
 * the tail (orange to red to nothing, plus a longer dark smoke ribbon in normal blending), two stretched flame sprites on it, a few
 * faint heat-shimmer sprites rising above the tail and a soft light on the ground. It only moves sprites it was given by the host
 * (the Effects sprite pool) and two small ribbon meshes it owns, so nothing is created per frame; the particles shed along the path
 * and the impact burst are emitted by Effects. Used for the flight and, at a smaller `energy` and `sizeMul`, for the ball that grows
 * in the caster's hand during the cast time.
 */

export interface RigHost {
  scene: THREE.Scene;
  /** A pooled additive (or normal) sprite, already in the scene. */
  sprite(tex: 'glow' | 'spark' | 'flame', color: number, additive?: boolean): THREE.Sprite;
  /** Hands a sprite back to the pool (and takes it out of the scene). */
  release(s: THREE.Sprite): void;
  /** The 25 fire flipbook frames, or null while it loads / when it is missing (the canvas flame is used then). */
  frames(): THREE.Texture[] | null;
  glowTex: THREE.Texture;
  discGeo: THREE.BufferGeometry;
  /** Soft-edged strip texture for the tail ribbon (alpha across its width); without it the ribbon has hard edges. */
  ribbonTex?: THREE.Texture;
}

export const FIRE_FRAME_COUNT = 25;

const _u1 = new THREE.Vector3();
const _u2 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Color();
const _b = new THREE.Color();
const _s = new THREE.Vector3();
const _w = new THREE.Vector3();
/** Segments of each tail ribbon. */
const RIB_N = 18;
const smooth = (x: number) => {
  const k = Math.max(0, Math.min(1, x));
  return k * k * (3 - 2 * k);
};

/** A soft-edged strip: opaque along the middle, fading to nothing at both long edges. Built from raw data, so it works without a canvas. */
export function makeRibbonTexture(): THREE.DataTexture {
  const n = 16;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const x = Math.abs(((i + 0.5) / n) * 2 - 1);
    data.set([255, 255, 255, Math.round(255 * (1 - x * x) * (1 - x * x))], i * 4);
  }
  const t = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Colours of the fireball for a heat 0..1 (0 = bright orange Fireball, 1 = deep red Pyroblast). */
export function fireballColors(heat: number) {
  const mix = (hot: number, dark: number) => _a.set(hot).lerp(_b.set(dark), heat).getHex();
  return {
    core: mix(0xfff6d6, 0xffc888),
    halo: mix(0xff8a2a, 0xd8200c),
    halo2: mix(0xff4a14, 0x8a0c06),
    shellA: mix(0xffd9a0, 0xff7048),
    shellB: mix(0xff8a40, 0xd02412),
    body: mix(0xffe9a8, 0xffa860),
    tongueA: mix(0xff8a2a, 0xe83a14),
    tongueB: mix(0xff5a18, 0xa81206),
    outer: mix(0x9a2a08, 0x4c0a06),
    tailHot: mix(0xff9a3a, 0xff5a28),
    tailMid: mix(0xff4a14, 0xb01808),
    tailDark: mix(0x7a1a08, 0x3c0806),
    tailEnd: mix(0x6a1408, 0x300604),
    ember: mix(0xffc060, 0xff7a30),
    smoke: 0x1c1512,
    ground: mix(0xff6a1a, 0xe02a10),
    ringBase: mix(0xe8500e, 0xb01408),
    ringHot: mix(0xffa040, 0xff4a20),
  };
}

interface Lick {
  sp: THREE.Sprite;
  /** Angular speed, phase, orbit radius (x shell), length (x shell), width (x length), flipbook frame offset and speed. */
  w: number;
  ph: number;
  r: number;
  len: number;
  wid: number;
  fps: number;
  frame: number;
  /** Large tongue (tip turned away from the ball and back along the flight) or small lick close to the core. */
  tongue: boolean;
  op: number;
}
interface Streak {
  sp: THREE.Sprite;
  len: number;
  wid: number;
  op: number;
  frame: number;
  fps: number;
}
interface Ribbon {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  pos: Float32Array;
  geo: THREE.BufferGeometry;
  /** Per station: distance along the ribbon (0..1) and the half width factor. */
  taper: Float32Array;
  ph: number;
}

/** Fills one ribbon's colours (rgb plus alpha per station, both edges alike) from `stops` = [u, hex, alpha]. */
function paintRibbon(rb: Ribbon, stops: [number, number, number][]) {
  const col = rb.geo.getAttribute('color') as THREE.BufferAttribute;
  for (let i = 0; i <= RIB_N; i++) {
    const u = i / RIB_N;
    let k = 0;
    while (k < stops.length - 2 && u > stops[k + 1][0]) k++;
    const [u0, c0, a0] = stops[k];
    const [u1, c1, a1] = stops[k + 1];
    const f = smooth((u - u0) / Math.max(1e-4, u1 - u0));
    _a.set(c0).lerp(_b.set(c1), f);
    const a = a0 + (a1 - a0) * f;
    for (const v of [i * 2, i * 2 + 1]) col.setXYZW(v, _a.r, _a.g, _a.b, a);
  }
  col.needsUpdate = true;
}

export class FireballRig {
  readonly shape: FireballShape;
  private heat: number;
  readonly colors: ReturnType<typeof fireballColors>;
  /** Screen-space angle that points a flame sprite's tip backwards along the flight, and how much of the flight is seen side-on (0 = head on). Set by `place`. */
  backRot = 0;
  fore = 0;
  /** Scales everything the ball is made of (the hand-held ball is kept small when the camera is close). */
  sizeMul = 1;
  /** Yards the flight will cover: a short throw gets a shorter tail (`tailScale`, see skillVisuals). Infinity = unknown. */
  range = Infinity;
  /** The tail length now in use (yards), for the particles shed along it. */
  tailLen = 0;
  private core: THREE.Sprite;
  private spark: THREE.Sprite;
  private halo: THREE.Sprite;
  private halo2: THREE.Sprite;
  private body: THREE.Sprite;
  private dark: THREE.Sprite[] = [];
  private licks: Lick[] = [];
  private streaks: Streak[] = [];
  private shimmer: THREE.Sprite[] = [];
  private smokeRib: Ribbon;
  private fireRib: Ribbon;
  private ground: THREE.Mesh;
  private groundMat: THREE.MeshBasicMaterial;
  private origin = new THREE.Vector3();
  private started = false;
  private alive = true;

  constructor(private host: RigHost, look: FireballLook) {
    this.shape = fireballShape(look.size, look.heat);
    this.heat = look.heat;
    const c = (this.colors = fireballColors(look.heat));
    const order = (sp: THREE.Sprite, o: number) => {
      sp.renderOrder = o;
      return sp;
    };
    this.halo2 = host.sprite('glow', c.halo2);
    this.halo = host.sprite('glow', c.halo);
    // the dark red body: normal blending, so the bright flames sit on a darker, redder mass
    for (let i = 0; i < 2; i++) {
      const sp = order(host.sprite('glow', c.outer, false), 2);
      this.dark.push(sp);
    }
    // the tongues (large, different sizes and rates) and the small licks close to the core
    const n = this.shape.shellSprites;
    const tg = this.shape.tongues;
    const T: [number, number, number, number, number][] = [
      // [angular speed, orbit radius, length, width/length, phase]
      [2.3, 1.05, 5.8, 0.5, 0.4],
      [-3.4, 0.9, 4.6, 0.45, 2.6],
      [4.2, 1.15, 3.6, 0.42, 4.5],
    ];
    for (let i = 0; i < n; i++) {
      const tongue = i < tg;
      const t = T[i % T.length];
      const sp = order(host.sprite('flame', tongue ? (i % 2 ? c.tongueB : c.tongueA) : i % 2 ? c.shellB : c.shellA), tongue ? 3 : 4);
      this.licks.push({
        sp,
        w: tongue ? t[0] : (i % 2 ? -1 : 1) * (6 + (i * 2.3) % 5),
        ph: tongue ? t[4] : (i / n) * Math.PI * 2,
        r: tongue ? t[1] : 0.25 + 0.3 * ((i * 0.37) % 1),
        len: tongue ? t[2] : 1.9 + 0.5 * ((i * 0.53) % 1),
        wid: tongue ? t[3] : 0.8,
        fps: 15 + (i * 3) % 11,
        frame: (i * 7) % FIRE_FRAME_COUNT,
        tongue,
        op: tongue ? 0.95 : 0.8,
      });
    }
    this.body = order(host.sprite('flame', c.body), 5);
    const dims: [number, number, number][] = [[1.0, 0.3, 0.55], [0.55, 0.22, 0.8]];
    const cols = [c.tailMid, c.tailHot];
    dims.forEach(([len, wid, op], i) => {
      const sp = order(host.sprite('flame', cols[i]), 4);
      this.streaks.push({ sp, len: len * this.shape.tail, wid: wid * this.shape.shell * 6.5, op, frame: i * 9, fps: 18 + i * 3 });
    });
    for (let i = 0; i < 4; i++) {
      const sp = order(host.sprite('glow', 0xffb27a), 1);
      this.shimmer.push(sp);
    }
    this.spark = order(host.sprite('spark', 0xffffff), 6);
    this.core = order(host.sprite('glow', c.core), 6);
    this.smokeRib = this.makeRibbon(false, 1);
    this.fireRib = this.makeRibbon(true, 2);
    paintRibbon(this.smokeRib, [[0, c.smoke, 0], [0.12, c.smoke, 0.34], [0.5, c.smoke, 0.46], [1, c.smoke, 0]]);
    paintRibbon(this.fireRib, [[0, c.tailHot, 0.95], [0.3, c.tailHot, 0.8], [0.58, c.tailMid, 0.55], [0.82, c.tailDark, 0.28], [1, c.tailDark, 0]]);
    this.groundMat = new THREE.MeshBasicMaterial({ color: c.ground, map: host.glowTex, transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending });
    this.ground = new THREE.Mesh(host.discGeo, this.groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    host.scene.add(this.ground);
  }

  private makeRibbon(additive: boolean, order: number): Ribbon {
    const verts = (RIB_N + 1) * 2;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const taper = new Float32Array(RIB_N + 1);
    const idx: number[] = [];
    for (let i = 0; i <= RIB_N; i++) {
      const u = i / RIB_N;
      uv.set([0, u, 1, u], i * 4);
      // the fire ribbon narrows to a point; the smoke one swells as it drifts and thins out at the end
      taper[i] = additive ? Math.pow(1 - u, 0.85) * (0.55 + 0.45 * smooth(u * 4)) : (0.6 + 0.9 * Math.sqrt(u)) * (1 - u * u * u);
      if (i < RIB_N) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(verts * 4), 4));
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, map: this.host.ribbonTex ?? null,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, fog: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    mesh.visible = false;
    this.host.scene.add(mesh);
    return { mesh, mat, pos, geo, taper, ph: additive ? 0 : 2.1 };
  }

  private setFrame(sp: THREE.Sprite, frames: THREE.Texture[] | null, f: number) {
    if (frames) (sp.material as THREE.SpriteMaterial).map = frames[f % FIRE_FRAME_COUNT];
  }

  /** Writes a camera-facing strip from `p` back along `dir` for `len` yards, `width` wide at the head (no allocation). */
  private layRibbon(rb: Ribbon, p: THREE.Vector3, dir: THREE.Vector3, len: number, width: number, t: number, cam: THREE.Camera | null, wob: number, rise: number) {
    const pos = rb.pos;
    const m = cam ? cam.matrixWorld.elements : null;
    for (let i = 0; i <= RIB_N; i++) {
      const u = i / RIB_N;
      const s = len * Math.pow(u, 1.15);
      const lat = Math.sin(t * 8 + u * 6 + rb.ph) * wob * u;
      const x = p.x - dir.x * s + _u1.x * lat;
      const y = p.y - dir.y * s + _u1.y * lat + rise * u * u;
      const z = p.z - dir.z * s + _u1.z * lat;
      if (m) _s.set(x - m[12], y - m[13], z - m[14]).cross(dir);
      else _s.set(0, 0, 0);
      if (_s.lengthSq() < 1e-6) _s.copy(_u1);
      else _s.normalize();
      const w = width * rb.taper[i];
      pos[i * 6] = x - _s.x * w;
      pos[i * 6 + 1] = y - _s.y * w;
      pos[i * 6 + 2] = z - _s.z * w;
      pos[i * 6 + 3] = x + _s.x * w;
      pos[i * 6 + 4] = y + _s.y * w;
      pos[i * 6 + 5] = z + _s.z * w;
    }
    (rb.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Screen-space angle that turns a flame's tip (up in the flipbook) to point along the world vector `v`; 0 when there is no camera. */
  private tipRot(v: THREE.Vector3, cam: THREE.Camera | null): number {
    if (!cam) return 0;
    const m = cam.matrixWorldInverse.elements;
    const cx = m[0] * v.x + m[4] * v.y + m[8] * v.z;
    const cy = m[1] * v.x + m[5] * v.y + m[9] * v.z;
    return Math.hypot(cx, cy) > 1e-3 ? Math.atan2(-cx, cy) : 0;
  }

  /**
   * Puts the ball at `p` flying along the unit vector `dir`, `t` seconds old, `energy` 0..1 (how grown it is), `moving` when the
   * tail should show. `cam` (optional) lets the tail point along the flight as seen on screen. No allocation.
   */
  place(p: THREE.Vector3, dir: THREE.Vector3, t: number, energy: number, moving: boolean, cam: THREE.Camera | null, groundY: number) {
    if (!this.alive) return;
    const sh = this.shape;
    const k = this.sizeMul;
    const e = Math.max(0.05, Math.min(1, energy));
    const frames = this.host.frames();
    const pulse = 1 + Math.sin(t * 34) * 0.07 + Math.sin(t * 13.7) * 0.05;
    if (moving && !this.started) {
      this.started = true;
      this.origin.copy(p);
    }

    // the way the tail points on screen
    this.fore = 1;
    this.backRot = 0;
    if (cam) {
      const m = cam.matrixWorldInverse.elements;
      const cx = m[0] * dir.x + m[4] * dir.y + m[8] * dir.z;
      const cy = m[1] * dir.x + m[5] * dir.y + m[9] * dir.z;
      this.fore = Math.min(1, Math.hypot(cx, cy));
      if (this.fore > 0.02) this.backRot = Math.atan2(cx, -cy);
    }

    this.halo2.position.copy(p);
    this.halo.position.copy(p);
    this.core.position.copy(p);
    this.spark.position.copy(p);
    this.body.position.copy(p);
    const h2 = sh.halo * 2.8 * (0.4 + 0.6 * e) * pulse * k;
    this.halo2.scale.set(h2, h2, 1);
    (this.halo2.material as THREE.SpriteMaterial).opacity = 0.18 + 0.06 * Math.sin(t * 9);
    const h1 = sh.halo * 1.5 * (0.45 + 0.55 * e) * pulse * k;
    this.halo.scale.set(h1, h1, 1);
    (this.halo.material as THREE.SpriteMaterial).opacity = 0.4;
    // the white-hot core is smaller and tighter than before, so the flames around it stay readable
    const cs = sh.core * 2.0 * (0.4 + 0.6 * e) * (1 + Math.sin(t * 51) * 0.08) * k;
    this.core.scale.set(cs, cs, 1);
    const ss = sh.core * 1.2 * e * (1 + Math.sin(t * 29 + 1) * 0.1) * k;
    this.spark.scale.set(ss, ss, 1);
    (this.spark.material as THREE.SpriteMaterial).opacity = 0.95;
    // the yellow-white body of the flame round the core
    const bs = sh.shell * 2.7 * (0.35 + 0.65 * e) * (1 + Math.sin(t * 11) * 0.06) * k;
    this.body.scale.set(bs * 0.85, bs, 1);
    const bm = this.body.material as THREE.SpriteMaterial;
    bm.rotation = moving ? this.backRot : Math.sin(t * 3) * 0.2;
    bm.opacity = 0.85;
    this.setFrame(this.body, frames, (Math.floor(t * 21) + 3) % FIRE_FRAME_COUNT);
    // the dark red outer body
    for (let i = 0; i < this.dark.length; i++) {
      const d = this.dark[i];
      const back = moving ? sh.shell * (0.45 + 0.35 * i) : 0;
      d.position.set(p.x - dir.x * back, p.y - dir.y * back + 0.05 * i, p.z - dir.z * back);
      const ds = sh.shell * (i ? 4.4 : 5.6) * (0.35 + 0.65 * e) * (1 + Math.sin(t * 5 + i * 2) * 0.07) * k;
      d.scale.set(ds, ds, 1);
      (d.material as THREE.SpriteMaterial).opacity = (i ? 0.5 : 0.36) * (0.5 + 0.5 * e);
    }

    // two axes across the flight to roll the licks round
    _u1.crossVectors(dir, _up);
    if (_u1.lengthSq() < 1e-4) _u1.set(1, 0, 0);
    _u1.normalize();
    _u2.crossVectors(dir, _u1);
    for (const s of this.licks) {
      const ang = t * s.w + s.ph;
      const r = sh.shell * s.r * (0.8 + 0.2 * Math.sin(t * 3.1 + s.ph)) * (0.3 + 0.7 * e) * k;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const back = moving ? sh.shell * (s.tongue ? 0.3 : 0.15) * (1 + Math.sin(ang * 0.7)) * k : 0;
      s.sp.position.set(
        p.x + (_u1.x * ca + _u2.x * sa) * r - dir.x * back,
        p.y + (_u1.y * ca + _u2.y * sa) * r - dir.y * back,
        p.z + (_u1.z * ca + _u2.z * sa) * r - dir.z * back,
      );
      // held in a hand the flames are shorter, so it reads as a ball and does not reach down to the floor
      const len = sh.shell * s.len * (moving ? 1 : 0.55) * (0.3 + 0.7 * e) * (1 + Math.sin(t * 6.3 + s.ph * 2) * 0.12) * k;
      const m = s.sp.material as THREE.SpriteMaterial;
      if (s.tongue) {
        // the tip points away from the centre and back along the flight: a tongue licking round the ball
        _w.set(
          (_u1.x * ca + _u2.x * sa) * 0.7 - dir.x * (moving ? 0.9 : -0.1),
          (_u1.y * ca + _u2.y * sa) * 0.7 - dir.y * (moving ? 0.9 : -0.1) + (moving ? 0 : 0.5),
          (_u1.z * ca + _u2.z * sa) * 0.7 - dir.z * (moving ? 0.9 : -0.1),
        );
        s.sp.scale.set(len * s.wid, len, 1);
        m.rotation = this.tipRot(_w, cam) + Math.sin(t * 7 + s.ph) * 0.12;
      } else {
        s.sp.scale.set(len * s.wid, len, 1);
        m.rotation = (moving ? this.backRot : 0) + Math.sin(ang) * 0.6;
      }
      m.opacity = s.op - 0.2 * this.heat;
      this.setFrame(s.sp, frames, (s.frame + Math.floor(t * s.fps)) % FIRE_FRAME_COUNT);
    }

    // the tail: shorter on a short throw, and never longer than what has been flown so far
    const tl = fireballTailScale(this.range, sh.tail);
    const flown = this.started ? Math.hypot(p.x - this.origin.x, p.y - this.origin.y, p.z - this.origin.z) : 0;
    const tail = moving ? Math.min(sh.tail * tl, flown + 0.5) * Math.min(1, 0.6 + 0.4 * e) * k : 0;
    this.tailLen = tail;
    for (const kk of this.streaks) {
      const sp = kk.sp;
      sp.visible = moving && tail > 0.1;
      if (!sp.visible) continue;
      const len = kk.len * (tail / Math.max(0.01, sh.tail)) * (0.9 + 0.1 * Math.sin(t * 23 + kk.frame));
      const wid = kk.wid * (0.55 + 0.45 * tl) * k;
      const screenLen = Math.max(wid * 0.9, len * this.fore);
      const m = sp.material as THREE.SpriteMaterial;
      sp.scale.set(wid * (0.9 + 0.1 * Math.sin(t * 17 + kk.frame)), screenLen, 1);
      m.rotation = this.backRot;
      m.opacity = kk.op * 0.85 * (0.5 + 0.5 * e);
      const off = len * 0.3;
      sp.position.set(p.x - dir.x * off, p.y - dir.y * off, p.z - dir.z * off);
      this.setFrame(sp, frames, (kk.frame + Math.floor(t * kk.fps)) % FIRE_FRAME_COUNT);
    }
    const showRib = moving && tail > 0.1;
    this.fireRib.mesh.visible = this.smokeRib.mesh.visible = showRib;
    if (showRib) {
      const wid = sh.shell * 1.5 * (0.6 + 0.4 * tl) * (0.5 + 0.5 * e) * k;
      this.layRibbon(this.fireRib, p, dir, tail * 1.1, wid, t, cam, sh.shell * 0.25, 0.25);
      this.layRibbon(this.smokeRib, p, dir, tail * 1.9, wid * 1.35, t, cam, sh.shell * 0.5, 0.7);
      this.fireRib.mat.opacity = this.smokeRib.mat.opacity = 1;
    }
    // heat shimmer: a few large, very faint soft sprites rising and wobbling over the tail
    for (let i = 0; i < this.shimmer.length; i++) {
      const sp = this.shimmer[i];
      sp.visible = showRib;
      if (!showRib) continue;
      const ph = (t * 0.7 + i * 0.25) % 1;
      const along = tail * (0.15 + 0.85 * (i / this.shimmer.length)) + sh.shell * 0.5;
      const wob = Math.sin(t * 5 + i * 1.7) * sh.shell * 0.5;
      sp.position.set(p.x - dir.x * along + _u1.x * wob, p.y - dir.y * along + sh.shell * 1.2 + ph * 1.1 + _u1.y * wob, p.z - dir.z * along + _u1.z * wob);
      const hs = sh.shell * (3.4 + 2.2 * ph) * k;
      sp.scale.set(hs, hs * 0.8, 1);
      (sp.material as THREE.SpriteMaterial).opacity = 0.075 * Math.sin(Math.PI * ph) * (0.5 + 0.5 * e);
    }

    // the light the ball throws on the ground below it: smaller and fainter the higher it is
    const h = Math.max(0, p.y - groundY);
    const gs = sh.halo * 1.6 * (0.5 + 0.5 * e) * (1 + Math.sin(t * 21) * 0.06) * k;
    this.ground.position.set(p.x, groundY + 0.06, p.z);
    this.ground.scale.set(gs, gs, 1);
    this.groundMat.opacity = Math.max(0.1, 0.34 - h * 0.08) * (0.4 + 0.6 * e);
  }

  dispose() {
    if (!this.alive) return;
    this.alive = false;
    const all = [this.halo2, this.halo, this.body, ...this.dark, ...this.licks.map((s) => s.sp), ...this.streaks.map((s) => s.sp), ...this.shimmer, this.spark, this.core];
    for (const sp of all) {
      sp.renderOrder = 0;
      this.host.release(sp);
    }
    this.host.scene.remove(this.ground);
    this.groundMat.dispose();
    for (const rb of [this.fireRib, this.smokeRib]) {
      this.host.scene.remove(rb.mesh);
      rb.geo.dispose();
      rb.mat.dispose();
    }
  }
}
