import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { CosmeticItem } from '@arena/shared';
import { fetchModel } from './modelPack';
import type { CapeInput } from './capeModels';

/**
 * The shared wings: every item in the `wings` slot is the SAME feathered pair (client/public/models/wings.glb, scripts/prep-wings.mjs, credit in
 * CREDITS.md: 5.7k triangles of feather cards on a small skeleton, `wing_L` > `wing_L_m` > `wing_L_t` and the mirror image) restyled by its
 * `WingStyle`: a gradient map over the feather shading (shadow, body, highlight colours), a root-to-tip colour shift, a glowing outline of every
 * feather, a size, the resting raise and sweep, optionally a second smaller layer in other colours, a halo or sun rays behind, and drifting
 * particles (feathers, embers, frost, void wisps, lightning, petals, stars). The wings flutter at rest, sweep back and beat when the wearer
 * runs or jumps, flare when it casts and fold when it dies. Add a style by adding an item to cosmetics.json (a `style` listed in
 * `WING_STYLES`, or none to get the plain look from the item's colour) and, for a new look, a row in `WING_STYLES` (see DEVELOPING.md).
 * Until the file has loaded (or if it fails) no wings are drawn; models.ts rebuilds when `wingModelVersion()` changes.
 */

export const WINGS_URL = '/models/wings.glb';
const BONES = ['wing_root', 'wing_L', 'wing_L_m', 'wing_L_t', 'wing_R', 'wing_R_m', 'wing_R_t'] as const;

// ------------------------------------------------------------------ the asset

export interface WingAsset {
  scene: THREE.Group;
  /** The neutral feather shading (grey, with the feather cut-out in alpha), as pixels: 512 x 512 RGBA. Undefined without a canvas (tests). */
  pixels: { data: Uint8ClampedArray; size: number } | undefined;
  /** How close each pixel is to the cut-out's edge, 0..1 (the outline of every feather glows). */
  edge: Float32Array | undefined;
  credit: Record<string, string>;
  /** Spots on the feathers (bind pose, both wings) where particles come off: the outer and lower tips. */
  tips: Float32Array;
  triangles: number;
}

let asset: WingAsset | undefined;
let version = 0;
const styleCache = new Map<string, StyleAssets>();

/** Changes whenever the wing model is loaded or dropped; added to riggedModels' `modelVersion` so scenes rebuild their characters. */
export const wingModelVersion = () => version;
export const wingAsset = () => asset;

const canvasOf = (size = 512): HTMLCanvasElement | undefined => {
  if (typeof document === 'undefined') return undefined;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
};

function readPixels(img: CanvasImageSource | undefined): WingAsset['pixels'] {
  const cv = canvasOf();
  const ctx = cv?.getContext('2d', { willReadFrequently: true });
  if (!cv || !ctx || !img) return undefined;
  try {
    ctx.drawImage(img, 0, 0, 512, 512);
    return { data: ctx.getImageData(0, 0, 512, 512).data, size: 512 };
  } catch {
    return undefined;
  }
}

/** 1 on the cut-out's rim, falling to 0 four pixels inside it. */
function edgeMap(px: NonNullable<WingAsset['pixels']>): Float32Array {
  const S = px.size, a = px.data;
  const out = new Float32Array(S * S);
  const solid = (x: number, y: number) => x < 0 || y < 0 || x >= S || y >= S || a[(y * S + x) * 4 + 3] > 115;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (a[(y * S + x) * 4 + 3] <= 115) continue;
    let d = 5;
    for (let r = 1; r < 5 && d > r; r++) for (const [dx, dy] of dirs) if (!solid(x + dx * r, y + dy * r)) { d = r; break; }
    out[y * S + x] = d >= 5 ? 0 : 1 - (d - 1) / 4;
  }
  return out;
}

function finish(gltf: { scene: THREE.Group }) {
  let mesh: THREE.SkinnedMesh | undefined;
  gltf.scene.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh) mesh = o;
  });
  if (!mesh) throw new Error('wings: no skinned mesh');
  for (const n of BONES) if (!gltf.scene.getObjectByName(n)) throw new Error(`wings: no bone ${n}`);
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  const mat = mesh.material as THREE.MeshStandardMaterial;
  const credit = (gltf as unknown as { parser?: { json?: { asset?: { extras?: Record<string, string> } } } }).parser?.json?.asset?.extras ?? {};
  const pixels = readPixels(mat.map?.image as CanvasImageSource | undefined);
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const picked: number[] = [];
  for (let i = 0; i < pos.count; i += 1) {
    const x = Math.abs(pos.getX(i)), y = pos.getY(i);
    if (x * 0.6 - y > 0.75 || y < -0.38) picked.push(pos.getX(i), y, pos.getZ(i));
  }
  asset = { scene: gltf.scene, pixels, edge: pixels ? edgeMap(pixels) : undefined, credit, tips: new Float32Array(picked), triangles: (mesh.geometry.index?.count ?? 0) / 3 };
  styleCache.clear();
  version++;
}

/** Parse the wings GLB from memory (tests, or a fetched pack). */
export function registerWingModel(data: ArrayBuffer): Promise<WingAsset> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(data, '', (g) => {
      try {
        finish(g);
        resolve(asset!);
      } catch (e) {
        reject(e);
      }
    }, reject);
  });
}

export function forgetWingModel() {
  asset = undefined;
  styleCache.clear();
  version++;
}

/** Load the wings in the background; a failure is logged and nobody gets wings. */
export function preloadWingModel(): Promise<void> {
  return fetchModel(WINGS_URL)
    .then((data) => registerWingModel(data))
    .then(() => undefined)
    .catch((e) => console.warn('wing model failed to load, wings will not show', e));
}

// ------------------------------------------------------------------ styles

export type FxKind = 'feathers' | 'embers' | 'frost' | 'wisps' | 'bolts' | 'petals' | 'stars' | 'motes';

export interface WingLayer {
  /** Size relative to the main layer, and how it sits: pushed back (z), raised and swept further than the main layer (radians). */
  scale: number;
  dz: number;
  raise: number;
  open: number;
  ramp: [number, number, number];
  tip?: number;
  glowColor?: number;
}

export interface WingStyle {
  id: string;
  /** Gradient map over the feather shading: shadow, body and highlight colours. */
  ramp: [number, number, number];
  /** Colour multiplied in at the root and at the tips of the wing (white = the ramp's own colours). */
  root: number;
  tip: number;
  /** Outline glow of every feather (colour, strength of the rim, how much of the feather's body glows) and the emissive intensity. */
  glowColor: number;
  glowEdge: number;
  glowFill: number;
  glow: number;
  /** Size of one wing (1 = about 0.9 wide next to a torso of 0.6), the rest raise (tips up) and sweep back (radians), how strongly they flutter. */
  size: number;
  raise: number;
  open: number;
  flutter: number;
  /** A second layer behind the first (archon, void). */
  layer?: WingLayer;
  /** Hue cycling over time (aurora). */
  cycle?: number;
  /** A disc behind the wings: a ring of light, a dark core (eclipse) or rays turning slowly (solar). */
  disc?: { kind: 'ring' | 'rays' | 'eclipse'; color: number; r: number; y: number };
  fx?: { kind: FxKind; color: number; color2: number; n: number; size: number };
}

const hex = (c: string) => parseInt(c.replace('#', ''), 16) || 0x888888;
const mix = (a: number, b: number, k: number) => new THREE.Color(a).lerp(new THREE.Color(b), k).getHex();
const lighter = (c: number, k = 0.5) => mix(c, 0xffffff, k);
const darker = (c: number, k = 0.5) => mix(c, 0x000000, k);

/** What each `style` of the catalog changes on top of the plain look an item's colour gives. */
const STYLE_ROWS: Record<string, (c: number) => Partial<WingStyle>> = {
  angel: (c) => ({ ramp: [mix(c, 0xa8b8d8, 0.45), c, 0xffffff], glowColor: 0xfff0c0, glowEdge: 0.35, glow: 0.7, fx: { kind: 'feathers', color: 0xffffff, color2: 0xfff3d0, n: 10, size: 0.05 } }),
  dusk: (c) => ({ ramp: [darker(c, 0.8), darker(c, 0.2), mix(c, 0xb08ad0, 0.5)], tip: 0xc8a8ff, glowColor: 0x9a6aff, glowEdge: 0.8, glow: 0.8, size: 1.05, raise: 0.3, open: 0.5, flutter: 1.3, fx: { kind: 'motes', color: 0x9a6aff, color2: 0x5a3a9a, n: 8, size: 0.05 } }),
  phoenix: (c) => ({ ramp: [0x7a1208, mix(c, 0xff3a10, 0.35), 0xffe6a0], root: 0xffdc7a, tip: 0xff4a18, glowColor: 0xff8a2a, glowEdge: 1, glowFill: 0.12, glow: 1.4, size: 1.05, fx: { kind: 'embers', color: 0xff9a2a, color2: 0xffe08a, n: 22, size: 0.05 } }),
  verdant: (c) => ({ ramp: [darker(c, 0.6), c, 0xe6ffcf], tip: 0xe8ff9a, glowColor: 0x9aff7a, glowEdge: 0.5, glow: 0.7, fx: { kind: 'petals', color: 0x7acf5a, color2: 0xc8ff8a, n: 14, size: 0.075 } }),
  ember: (c) => ({ ramp: [0x120808, 0x3a1812, mix(c, 0xff8a2a, 0.55)], tip: 0xff8a40, glowColor: 0xff6a1a, glowEdge: 1.2, glowFill: 0.05, glow: 1.5, flutter: 1.15, fx: { kind: 'embers', color: 0xff7a1a, color2: 0xffd27a, n: 30, size: 0.05 } }),
  frost: (c) => ({ ramp: [mix(c, 0x3a5a9a, 0.55), c, 0xffffff], tip: 0xdff6ff, glowColor: 0xbfefff, glowEdge: 0.9, glow: 1, fx: { kind: 'frost', color: 0xdff8ff, color2: 0x8fdcff, n: 16, size: 0.04 } }),
  storm: (c) => ({ ramp: [0x1a2a70, 0x6a86e0, 0xe8f0ff], root: 0xdde4ff, tip: 0xfff2a0, glowColor: 0xfff07a, glowEdge: 1.2, glow: 1.5, flutter: 1.3, size: 1.05, fx: { kind: 'bolts', color: 0xfff6a8, color2: 0x9ac8ff, n: 26, size: 0.028 } }),
  blossom: (c) => ({ ramp: [mix(c, 0x9a4a7a, 0.45), mix(c, 0xffffff, 0.35), 0xffffff], tip: 0xffc8e0, glowColor: 0xffb0d0, glowEdge: 0.5, glow: 0.7, fx: { kind: 'petals', color: 0xff9ec7, color2: 0xffe0ee, n: 18, size: 0.08 } }),
  void: (c) => ({ ramp: [0x080414, mix(c, 0x1a0a30, 0.6), mix(c, 0xe0c8ff, 0.5)], tip: 0xc890ff, glowColor: 0xb06aff, glowEdge: 1.1, glow: 1.3, size: 1.1, raise: 0.22, flutter: 1.2, layer: { scale: 0.82, dz: 0.03, raise: 0.5, open: 0.1, ramp: [0x04020c, 0x2a1050, 0x7a3ac0], glowColor: 0xe08aff }, fx: { kind: 'wisps', color: 0x2a0a50, color2: 0xb06aff, n: 14, size: 0.12 } }),
  solar: (c) => ({ ramp: [0xb04a08, mix(c, 0xffb02a, 0.4), 0xfff4b8], root: 0xfff0b0, tip: 0xffa020, glowColor: 0xffd24a, glowEdge: 1.1, glowFill: 0.16, glow: 1.6, size: 1.12, raise: 0.3, disc: { kind: 'rays', color: 0xffd24a, r: 0.95, y: -0.04 }, fx: { kind: 'motes', color: 0xffe08a, color2: 0xffa020, n: 14, size: 0.045 } }),
  archon: (c) => ({ ramp: [mix(c, 0xa06a10, 0.5), c, 0xfffbe0], root: 0xfff4c8, glowColor: 0xffe28a, glowEdge: 1, glowFill: 0.1, glow: 1.3, size: 1.12, raise: 0.3, layer: { scale: 0.85, dz: 0.035, raise: 0.55, open: 0.08, ramp: [0xd0a030, 0xfff0a8, 0xffffff], glowColor: 0xfff6c8 }, disc: { kind: 'ring', color: 0xffd76a, r: 0.55, y: 0.52 }, fx: { kind: 'feathers', color: 0xfff0b0, color2: 0xffd76a, n: 12, size: 0.09 } }),
  eclipse: (c) => ({ ramp: [0x050210, 0x1a0d30, mix(c, 0x6a3ac0, 0.4)], tip: 0xb08cff, glowColor: 0xb08cff, glowEdge: 1.3, glow: 1.5, size: 1.1, raise: 0.3, disc: { kind: 'eclipse', color: 0xb08cff, r: 0.82, y: -0.02 }, fx: { kind: 'wisps', color: 0x1a0a30, color2: 0xb08cff, n: 12, size: 0.12 } }),
  aurora: (c) => ({ ramp: [mix(c, 0x1a4a8a, 0.55), c, 0xf0fff8], root: 0x8affd0, tip: 0xc890ff, glowColor: 0x7affc8, glowEdge: 1, glowFill: 0.1, glow: 1.3, cycle: 0.35, size: 1.08, raise: 0.38, fx: { kind: 'motes', color: 0x7affc8, color2: 0xc890ff, n: 20, size: 0.05 } }),
  stars: (c) => ({ ramp: [0x080c24, 0x1a2260, mix(c, 0xffffff, 0.3)], tip: 0x9ac0ff, glowColor: 0xbcd8ff, glowEdge: 1, glow: 1.4, size: 1.08, raise: 0.34, fx: { kind: 'stars', color: 0xffffff, color2: 0x9ac0ff, n: 30, size: 0.09 } }),
};

/** The look of one wing item (pure data, so it can be compared and tested without a canvas). */
export function wingStyleFor(item: Pick<CosmeticItem, 'id' | 'style' | 'color'>): WingStyle {
  const c = hex(item.color);
  const base: WingStyle = {
    id: item.id,
    ramp: [darker(c, 0.5), c, lighter(c, 0.6)],
    root: 0xffffff,
    tip: 0xffffff,
    glowColor: lighter(c, 0.4),
    glowEdge: 0.3,
    glowFill: 0,
    glow: 0.6,
    size: 1,
    raise: 0.24,
    open: 0.42,
    flutter: 1,
  };
  return { ...base, ...(STYLE_ROWS[item.style]?.(c) ?? {}), id: item.id };
}

export const WING_STYLE_IDS = Object.keys(STYLE_ROWS);

// ------------------------------------------------------------------ materials

interface StyleAssets {
  geometry: THREE.BufferGeometry;
  materials: THREE.MeshStandardMaterial[];
}

const channel = (c: number) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

/** The painted map and the glow map of one colour ramp (browser only: needs a canvas). */
function paintRamp(a: WingAsset, ramp: [number, number, number], glowColor: number, glowEdge: number, glowFill: number): { map: THREE.CanvasTexture; emissive?: THREE.CanvasTexture } | undefined {
  const px = a.pixels, edge = a.edge;
  const cv = canvasOf(), gv = canvasOf();
  const ctx = cv?.getContext('2d'), gctx = gv?.getContext('2d');
  if (!px || !edge || !cv || !ctx) return undefined;
  const S = px.size;
  const out = ctx.createImageData(S, S), glow = gctx?.createImageData(S, S);
  const [c0, c1, c2] = ramp.map(channel);
  const gc = channel(glowColor);
  for (let i = 0; i < S * S; i++) {
    const g = px.data[i * 4] / 255;
    const al = px.data[i * 4 + 3];
    const k = Math.min(1, Math.max(0, 0.5 + (g - 0.86) * 2.8)); // the neutral map's mean is 0.86: that lands on the body colour
    const lo = k < 0.5;
    const t = lo ? k * 2 : (k - 0.5) * 2;
    for (let j = 0; j < 3; j++) out.data[i * 4 + j] = lo ? c0[j] + (c1[j] - c0[j]) * t : c1[j] + (c2[j] - c1[j]) * t;
    out.data[i * 4 + 3] = al;
    if (glow) {
      const e = Math.min(1, edge[i] * glowEdge + glowFill * (0.4 + 0.6 * k));
      for (let j = 0; j < 3; j++) glow.data[i * 4 + j] = gc[j] * e;
      glow.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  gctx?.putImageData(glow!, 0, 0);
  const tex = (c: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(c);
    t.flipY = false;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  return { map: tex(cv), emissive: gv ? tex(gv) : undefined };
}

/** The geometry with this style's root-to-tip colour shift, and one material per layer (shared by every unit wearing the item). */
function styleAssets(style: WingStyle, a: WingAsset): StyleAssets {
  let s = styleCache.get(style.id);
  if (s) return s;
  const mesh = a.scene.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
  const geometry = mesh.geometry.clone();
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const root = new THREE.Color(style.root), tip = new THREE.Color(style.tip), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = Math.abs(pos.getX(i)), y = pos.getY(i);
    const k = Math.min(1, Math.max(0, (x - 0.1) / 1.8 * 0.75 + (-y / 0.58) * 0.35));
    c.copy(root).lerp(tip, k * k * (3 - 2 * k));
    col.set([c.r, c.g, c.b], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const src = mesh.material as THREE.MeshStandardMaterial;
  const make = (ramp: [number, number, number], glowColor: number, tag: string) => {
    const painted = paintRamp(a, ramp, glowColor, style.glowEdge, style.glowFill);
    const m = new THREE.MeshStandardMaterial({
      name: `wings:${style.id}:${tag}`,
      map: painted?.map ?? src.map,
      color: painted ? 0xffffff : ramp[1],
      vertexColors: true,
      roughness: 0.7,
      metalness: 0,
      side: THREE.DoubleSide,
      alphaTest: 0.45,
      alphaToCoverage: true,
      emissiveMap: painted?.emissive ?? null,
      emissive: style.glow ? (painted ? 0xffffff : glowColor) : 0x000000,
      emissiveIntensity: painted ? style.glow : style.glow * 0.25,
    });
    m.userData.glow = m.emissiveIntensity;
    m.userData.base = new THREE.Color(m.color);
    m.userData.noDye = true;
    return m;
  };
  const materials = [make(style.ramp, style.glowColor, 'main')];
  if (style.layer) materials.push(make(style.layer.ramp, style.layer.glowColor ?? style.glowColor, 'layer'));
  s = { geometry, materials };
  styleCache.set(style.id, s);
  return s;
}

// ------------------------------------------------------------------ fit

/** Where wings grow on a character model, in the frame of its torso anchor: between the shoulder blades, behind where a cape hangs. */
export interface WingFit {
  /** The shoulder joint's height (y up from the anchor's origin) and how far behind the chest's centre line the wings sit. */
  y: number;
  z: number;
  /** Size of the pair (1 = the wing's own size, about 1.9 wide at style size 1) and a stretch across for broad shoulders. */
  scale: number;
  sx: number;
  /** Lean of the whole pair (radians, positive tips the wing tops backwards), and extra raise / sweep on top of the style's. */
  tilt: number;
  raise: number;
  open: number;
}

export const DEFAULT_WING_FIT: WingFit = { y: 0.74, z: 0.3, scale: 0.5, sx: 1, tilt: 0.08, raise: 0, open: 0 };

export type WingInput = CapeInput;

export interface WingRig {
  /** The unit's own wing group (under the torso anchor). */
  group: THREE.Group;
  meshes: THREE.SkinnedMesh[];
  style: WingStyle;
  materials: THREE.MeshStandardMaterial[];
  /** Every extra drawn object (particles, halo, rays): hidden with the unit like glows. */
  fx: THREE.Object3D[];
  /** Pose of the first layer's wings, radians: hinge (tips back), raise (tips up) and the bend of the outer joints. For tests and debugging. */
  state: { open: number; raise: number; bend: number; flap: number };
  update(p: WingInput): void;
}

// ------------------------------------------------------------------ particles

const SHAPES: Record<FxKind, number> = { feathers: 3, embers: 0, frost: 1, wisps: 5, bolts: 6, petals: 4, stars: 2, motes: 0 };

const POINT_VERT = /* glsl */ `
attribute float aSize; attribute float aAlpha; attribute float aRot; attribute vec3 aColor;
uniform float uViewH; varying float vAlpha; varying float vRot; varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(1.0, aSize * projectionMatrix[1][1] * uViewH * 0.3 / max(0.05, -mv.z));
  vAlpha = aAlpha; vRot = aRot; vColor = aColor;
}`;
const POINT_FRAG = /* glsl */ `
uniform float uShape; varying float vAlpha; varying float vRot; varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float c = cos(vRot), s = sin(vRot);
  p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  float a;
  if (uShape < 0.5) a = smoothstep(0.5, 0.05, length(p));
  else if (uShape < 1.5) a = smoothstep(0.5, 0.35, abs(p.x) * 1.0 + abs(p.y) * 0.6);          // diamond
  else if (uShape < 2.5) { float d = min(abs(p.x), abs(p.y)); a = smoothstep(0.5, 0.0, max(abs(p.x), abs(p.y))) * smoothstep(0.12, 0.0, d) + smoothstep(0.2, 0.0, length(p)); } // sparkle
  else if (uShape < 3.5) { float e = length(vec2(p.x * 5.0, p.y * 0.9)); a = smoothstep(0.5, 0.3, e); } // feather
  else if (uShape < 4.5) { float e = length(vec2(p.x * 1.8, (p.y + 0.12 * p.x * p.x * 6.0) * 1.0)); a = smoothstep(0.5, 0.3, e); }       // petal
  else if (uShape < 5.5) a = smoothstep(0.5, 0.0, length(p)) * 0.7;                                // soft wisp
  else a = smoothstep(0.5, 0.1, length(p));                                                         // bolt spark
  gl_FragColor = vec4(vColor, a * vAlpha);
  if (gl_FragColor.a < 0.01) discard;
}`;

class Particles {
  readonly points: THREE.Points;
  private readonly n: number;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly v: Float32Array;
  private readonly spin: Float32Array;
  private readonly seed: Float32Array;
  private readonly pos: THREE.BufferAttribute;
  private readonly size: THREE.BufferAttribute;
  private readonly alpha: THREE.BufferAttribute;
  private readonly rot: THREE.BufferAttribute;
  private readonly color: THREE.BufferAttribute;
  private readonly c1: THREE.Color;
  private readonly c2: THREE.Color;
  private readonly tmp = new THREE.Color();
  private bolt = 0;
  private born = false;
  private readonly view = new THREE.Vector2();

  constructor(private readonly kind: FxKind, color: number, color2: number, n: number, private readonly base: number) {
    this.n = n;
    this.age = new Float32Array(n);
    this.life = new Float32Array(n).fill(1);
    this.v = new Float32Array(n * 3);
    this.spin = new Float32Array(n);
    this.seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.age[i] = 1; // spawns on the first update (the life is 1 until then), already part-way through its life
      this.seed[i] = Math.random();
    }
    this.c1 = new THREE.Color(color);
    this.c2 = new THREE.Color(color2);
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.size = new THREE.BufferAttribute(new Float32Array(n), 1);
    this.alpha = new THREE.BufferAttribute(new Float32Array(n), 1);
    this.rot = new THREE.BufferAttribute(new Float32Array(n), 1);
    this.color = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    g.setAttribute('position', this.pos);
    g.setAttribute('aSize', this.size);
    g.setAttribute('aAlpha', this.alpha);
    g.setAttribute('aRot', this.rot);
    g.setAttribute('aColor', this.color);
    const dark = kind === 'wisps';
    const uniforms = { uViewH: { value: 800 }, uShape: { value: SHAPES[kind] } };
    const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: POINT_VERT, fragmentShader: POINT_FRAG, transparent: true, depthWrite: false, blending: dark ? THREE.NormalBlending : THREE.AdditiveBlending });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.raycast = () => {};
    this.points.name = `wingfx:${kind}`;
    this.points.onBeforeRender = (r) => {
      r.getDrawingBufferSize(this.view);
      uniforms.uViewH.value = this.view.y;
    };
  }

  /** Move every particle `dt` on; `spawn` gives a fresh starting spot in the wings' frame; `wind` is how the wearer's motion drags them (x, z per second). */
  update(dt: number, t: number, spawn: (out: THREE.Vector3) => void, wx: number, wz: number, visible: boolean) {
    const p = this.pos.array as Float32Array;
    const v = this.v;
    const out = new THREE.Vector3();
    if (!visible) {
      for (let i = 0; i < this.n; i++) this.alpha.setX(i, 0);
      this.alpha.needsUpdate = true;
      return;
    }
    if (this.kind === 'bolts') this.updateBolts(dt, t, spawn);
    const first = !this.born;
    this.born = true;
    for (let i = this.kind === 'bolts' ? this.boltCount() : 0; i < this.n; i++) {
      let a = this.age[i];
      a += dt;
      if (a >= this.life[i]) {
        spawn(out);
        p.set([out.x, out.y, out.z], i * 3);
        const sd = this.seed[i] = Math.random();
        switch (this.kind) {
          case 'embers': v.set([(Math.random() - 0.5) * 0.12, 0.35 + Math.random() * 0.35, (Math.random() - 0.5) * 0.12], i * 3); this.life[i] = 1.2 + Math.random() * 1.2; break;
          case 'frost': v.set([(Math.random() - 0.5) * 0.1, -0.12 - Math.random() * 0.12, (Math.random() - 0.5) * 0.1], i * 3); this.life[i] = 2 + Math.random() * 1.6; break;
          case 'feathers': v.set([(Math.random() - 0.5) * 0.16, -0.14 - Math.random() * 0.1, -0.03 - Math.random() * 0.06], i * 3); this.life[i] = 2.6 + Math.random() * 1.6; break;
          case 'petals': v.set([(Math.random() - 0.5) * 0.18, -0.16 - Math.random() * 0.12, -0.04 - Math.random() * 0.08], i * 3); this.life[i] = 2.4 + Math.random() * 1.6; break;
          case 'wisps': v.set([(Math.random() - 0.5) * 0.1, 0.1 + Math.random() * 0.14, -0.06 - Math.random() * 0.06], i * 3); this.life[i] = 1.8 + Math.random() * 1.4; break;
          case 'stars': v.set([(Math.random() - 0.5) * 0.06, (Math.random() - 0.4) * 0.06, -0.02 - Math.random() * 0.03], i * 3); this.life[i] = 1.2 + Math.random() * 1.6; break;
          case 'bolts':
          case 'motes': v.set([(Math.random() - 0.5) * 0.08, 0.1 + Math.random() * 0.14, -0.04 - Math.random() * 0.04], i * 3); this.life[i] = 1.4 + Math.random() * 1.4; break;
          default: break;
        }
        this.spin[i] = (Math.random() - 0.5) * (this.kind === 'feathers' || this.kind === 'petals' ? 3 : 1.2);
        this.rot.setX(i, Math.random() * 6.28);
        this.tmp.copy(this.c1).lerp(this.c2, sd);
        this.color.setXYZ(i, this.tmp.r, this.tmp.g, this.tmp.b);
        a = first ? Math.random() * this.life[i] : 0;
      }
      this.age[i] = a;
      const k = a / this.life[i];
      const s = this.seed[i];
      // drifting and swaying; the wearer's own speed leaves them behind
      p[i * 3] += (v[i * 3] + Math.sin(t * 1.7 + s * 20) * (this.kind === 'feathers' || this.kind === 'petals' ? 0.07 : 0.02)) * dt - wx * dt * 0.8;
      p[i * 3 + 1] += v[i * 3 + 1] * dt;
      p[i * 3 + 2] += v[i * 3 + 2] * dt - wz * dt * 0.8;
      this.rot.setX(i, this.rot.getX(i) + this.spin[i] * dt);
      const fade = Math.min(1, k * 6) * Math.min(1, (1 - k) * 2.5);
      switch (this.kind) {
        case 'embers': this.size.setX(i, this.base * (0.5 + 0.8 * (1 - k)) * (0.6 + s)); this.alpha.setX(i, fade * 0.95); break;
        case 'stars': this.size.setX(i, this.base * (0.5 + 1.0 * s) * (0.5 + 0.5 * Math.sin(t * 5 + s * 30))); this.alpha.setX(i, fade); break;
        case 'wisps': this.size.setX(i, this.base * (0.7 + 1.2 * k) * (0.7 + 0.6 * s)); this.alpha.setX(i, fade * 0.4); break;
        case 'frost': this.size.setX(i, this.base * (0.6 + 0.8 * s)); this.alpha.setX(i, fade * 0.9); break;
        default: this.size.setX(i, this.base * (0.7 + 0.6 * s)); this.alpha.setX(i, fade * 0.85);
      }
    }
    this.pos.needsUpdate = this.size.needsUpdate = this.alpha.needsUpdate = this.rot.needsUpdate = this.color.needsUpdate = true;
  }

  private boltCount() {
    return Math.min(this.n, 18);
  }

  /** Lightning: a few jagged chains of bright sparks along the feather tips, re-rolled in quick flickers. */
  private updateBolts(dt: number, t: number, spawn: (out: THREE.Vector3) => void) {
    const p = this.pos.array as Float32Array;
    this.bolt -= dt;
    const chains = 3, len = 6;
    if (this.bolt <= 0) {
      this.bolt = 0.06 + Math.random() * 0.14;
      const o = new THREE.Vector3(), d = new THREE.Vector3();
      for (let c = 0; c < chains; c++) {
        spawn(o);
        d.set((Math.random() - 0.5) * 0.4, (Math.random() - 0.2) * 0.3, -Math.random() * 0.15);
        for (let k = 0; k < len; k++) {
          const i = c * len + k;
          p.set([o.x + d.x * (k / (len - 1)) + (Math.random() - 0.5) * 0.06, o.y + d.y * (k / (len - 1)) + (Math.random() - 0.5) * 0.06, o.z + d.z * (k / (len - 1))], i * 3);
          this.tmp.copy(this.c1).lerp(this.c2, k / len);
          this.color.setXYZ(i, this.tmp.r, this.tmp.g, this.tmp.b);
          this.rot.setX(i, 0);
        }
      }
    }
    const lit = Math.sin(t * 40) > -0.4 ? 1 : 0.2;
    for (let i = 0; i < this.boltCount(); i++) {
      this.size.setX(i, this.base * (0.8 + 0.6 * Math.abs(Math.sin(i * 1.7 + t * 30))));
      this.alpha.setX(i, Math.max(0, (this.bolt / 0.2) * lit + 0.2));
    }
  }
}

// ------------------------------------------------------------------ the disc behind the wings (rays, a ring of light, an eclipse)

function discTexture(kind: 'ring' | 'rays' | 'eclipse', color: number): THREE.CanvasTexture | undefined {
  const cv = canvasOf(256);
  const ctx = cv?.getContext('2d');
  if (!cv || !ctx) return undefined;
  const [r, g, b] = channel(color);
  const css = (a: number) => `rgba(${r},${g},${b},${a})`;
  ctx.translate(128, 128);
  if (kind === 'rays') {
    const grad = ctx.createRadialGradient(0, 0, 10, 0, 0, 126);
    grad.addColorStop(0, css(0.85));
    grad.addColorStop(1, css(0));
    ctx.fillStyle = grad;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2, w = i % 2 ? 0.1 : 0.17;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a - w) * 126, Math.sin(a - w) * 126);
      ctx.lineTo(Math.cos(a + w) * 126, Math.sin(a + w) * 126);
      ctx.closePath();
      ctx.fill();
    }
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 56);
    core.addColorStop(0, css(0.6));
    core.addColorStop(1, css(0));
    ctx.fillStyle = core;
    ctx.fillRect(-128, -128, 256, 256);
  } else {
    if (kind === 'eclipse') {
      ctx.fillStyle = 'rgba(8,2,20,0.72)';
      ctx.beginPath();
      ctx.arc(0, 0, 96, 0, Math.PI * 2);
      ctx.fill();
    }
    const halo = ctx.createRadialGradient(0, 0, 84, 0, 0, 126);
    halo.addColorStop(0, css(0));
    halo.addColorStop(0.3, css(0.35));
    halo.addColorStop(1, css(0));
    ctx.fillStyle = halo;
    ctx.fillRect(-128, -128, 256, 256);
    ctx.strokeStyle = css(0.95);
    ctx.lineWidth = kind === 'ring' ? 5 : 7;
    ctx.beginPath();
    ctx.arc(0, 0, kind === 'ring' ? 100 : 96, 0, Math.PI * 2);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ------------------------------------------------------------------ the rig

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const damp = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

interface LayerRig {
  group: THREE.Group;
  bones: { L: THREE.Bone[]; R: THREE.Bone[] };
  def: { scale: number; dz: number; raise: number; open: number; lag: number };
}

/** Put the item's wings on `parent` (a torso anchor) with this fit. Undefined while the wing model is not loaded. */
export function buildWings(item: Pick<CosmeticItem, 'id' | 'style' | 'color'>, fit: WingFit, parent: THREE.Object3D): WingRig | undefined {
  const a = asset;
  if (!a) return undefined;
  const style = wingStyleFor(item);
  const sa = styleAssets(style, a);
  const group = new THREE.Group();
  group.name = `wings:${item.id}`;
  group.position.set(0, fit.y, -fit.z);
  group.rotation.x = fit.tilt;
  const size = fit.scale * style.size;
  group.scale.set(size * fit.sx, size, size);
  parent.add(group);
  const meshes: THREE.SkinnedMesh[] = [];
  const materials: THREE.MeshStandardMaterial[] = [];
  const layers: LayerRig[] = [];
  const defs = [{ scale: 1, dz: 0, raise: 0, open: 0, lag: 0 }];
  if (style.layer) defs.push({ scale: style.layer.scale, dz: style.layer.dz, raise: style.layer.raise, open: style.layer.open, lag: 0.5 });
  defs.forEach((def, li) => {
    const lg = new THREE.Group();
    lg.name = `wings:layer${li}`;
    lg.scale.setScalar(def.scale);
    lg.position.z = -def.dz / Math.max(0.01, size) - li * 0.01;
    const root = cloneSkinned(a.scene) as THREE.Group;
    lg.add(root);
    group.add(lg);
    let mesh!: THREE.SkinnedMesh;
    root.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh) mesh = o;
    });
    const mat = sa.materials[Math.min(li, sa.materials.length - 1)].clone();
    mat.userData = { ...sa.materials[0].userData, base: new THREE.Color(0xffffff), glow: sa.materials[Math.min(li, sa.materials.length - 1)].userData.glow };
    mesh.geometry = sa.geometry;
    mesh.material = mat;
    mesh.frustumCulled = false;
    mesh.castShadow = li === 0;
    meshes.push(mesh);
    materials.push(mat);
    const get = (n: string) => root.getObjectByName(n) as THREE.Bone;
    layers.push({ group: lg, bones: { L: [get('wing_L'), get('wing_L_m'), get('wing_L_t')], R: [get('wing_R'), get('wing_R_m'), get('wing_R_t')] }, def });
  });

  const fx: THREE.Object3D[] = [];
  // the disc behind: rays, a ring, an eclipse
  let disc: THREE.Mesh | undefined;
  if (style.disc) {
    const tex = discTexture(style.disc.kind, style.disc.color);
    if (tex) {
      const dm = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: style.disc.kind === 'eclipse' ? THREE.NormalBlending : THREE.AdditiveBlending, fog: false });
      disc = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), dm);
      disc.name = 'wings:disc';
      disc.raycast = () => {};
      disc.scale.setScalar(style.disc.r * 2 / size);
      disc.position.set(0, style.disc.y / size, 0.22 / size); // on the body side of the wings (the camera behind the wearer sees it around the back)
      group.add(disc);
      fx.push(disc);
    }
  }
  // particles come off the feather tips of the main layer and live in the torso anchor's frame
  let particles: Particles | undefined;
  if (style.fx) {
    particles = new Particles(style.fx.kind, style.fx.color, style.fx.color2, style.fx.n, style.fx.size);
    parent.add(particles.points);
    fx.push(particles.points);
  }

  const state = { open: 0, raise: 0, bend: 0, flap: 0 };
  const sim = { flapPhase: 0, flapAmp: 0, flare: 0, move: 0, dead: 0, vf: 0, vs: 0, t: 0, init: false };
  const tips = a.tips;
  const _v = new THREE.Vector3();
  const spawnAt = (out: THREE.Vector3) => {
    // a random feather tip, carried by the wing's current hinge / raise (the outer joints' bend is ignored)
    const i = tips.length >= 3 ? Math.floor(Math.random() * (tips.length / 3)) * 3 : 0;
    const sd = tips[i] >= 0 ? 1 : -1;
    out.set(tips[i] - sd * 0.1, tips[i + 1], tips[i + 2] + 0.02);
    _e.set(0, sd * state.open, sd * state.raise, 'YZX');
    out.applyQuaternion(_q.setFromEuler(_e));
    out.x += sd * 0.1;
    out.multiplyScalar(size).multiply(_v.set(fit.sx, 1, 1));
    out.applyEuler(_e.set(fit.tilt, 0, 0));
    out.add(group.position);
    out.x += (Math.random() - 0.5) * 0.03;
  };

  const update = (p: WingInput) => {
    const dt = Math.min(Math.max(p.dt, 0.001), 1 / 20);
    const t = p.time;
    const dead = p.dead;
    const mv = clamp(p.move, 0, 1);
    const air = p.air ?? 0;
    sim.move = damp(sim.move, mv, 6, dt);
    sim.dead = damp(sim.dead, dead ? 1 : 0, dead ? 5 : 10, dt);
    sim.flare = damp(sim.flare, p.casting && !dead ? 1 : 0, 7, dt);
    sim.flapAmp = damp(sim.flapAmp, air > 0.1 && !dead ? 1 : 0, 7, dt);
    sim.flapPhase += dt * (11 + 3 * sim.flapAmp);
    const fl = style.flutter;
    const beat = Math.sin(sim.flapPhase) * sim.flapAmp;
    const flap = beat * (1 - sim.dead);
    const living = 1 - sim.dead;
    // rest, then breathing, running (swept back and lifted), casting (flared up), flapping (a big beat), dying (folded and drooping)
    const open = (style.open + fit.open + 0.2 * sim.move + 0.16 * sim.flare + Math.sin(t * 1.3) * 0.03 * fl) * living - 0.1 * sim.dead + 0.28 * flap;
    const raise = (style.raise + fit.raise + 0.12 * sim.move + 0.14 * sim.flare + Math.sin(t * 1.3 + 0.8) * 0.025 * fl) * living - 1.15 * sim.dead + 0.5 * flap;
    const bend = (0.04 * fl * Math.sin(t * 1.9) + 0.1 * flap + 0.06 * sim.flare) * living - 0.55 * sim.dead;
    state.open = open;
    state.raise = raise;
    state.bend = bend;
    state.flap = flap;
    for (const l of layers) {
      for (const side of ['L', 'R'] as const) {
        const sd = side === 'L' ? 1 : -1;
        const [b0, b1, b2] = l.bones[side];
        _e.set(0, sd * (open + l.def.open), sd * (raise + l.def.raise), 'YZX');
        b0.quaternion.setFromEuler(_e);
        // the outer joints lag behind and ripple: a standing wing breathes, a running one flutters, a dead one droops
        const rip = (ph: number) => Math.sin(t * (6 + 4 * sim.move) + ph + l.def.lag * 3) * (0.02 + 0.07 * sim.move) * fl * living;
        const lag = (k: number) => Math.sin(sim.flapPhase - k) * 0.22 * sim.flapAmp * living;
        _e.set(0, 0, sd * (bend + rip(0.8) - lag(0.7) * 0.5), 'XYZ');
        b1.quaternion.setFromEuler(_e);
        _e.set(0, sd * 0.1 * Math.sin(sim.flapPhase - 1.4) * sim.flapAmp * living, sd * (bend * 1.3 + rip(1.7) - lag(1.4)), 'XYZ');
        b2.quaternion.setFromEuler(_e);
      }
    }
    if (disc) {
      disc.rotation.z = style.disc!.kind === 'rays' ? t * 0.25 : 0;
      const pulse = 0.85 + 0.15 * Math.sin(t * 2.1);
      (disc.material as THREE.MeshBasicMaterial).opacity = (dead ? 0 : 1) * pulse;
      disc.visible = !dead;
    }
    if (style.cycle && !dead) {
      const h = (t * style.cycle * 0.2) % 1;
      for (const m of materials) m.color.setHSL(h, 0.55, 0.78);
    }
    if (particles) {
      // only a living, visible unit sheds particles; their world-fixed drag follows the wearer's speed (right-hand side of the wearer = -x)
      particles.update(dt, t, spawnAt, p.vs, p.vf, !dead);
    }
  };

  return { group, meshes, style, materials, fx, state, update };
}
