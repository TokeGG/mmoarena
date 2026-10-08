import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { CosmeticItem } from '@arena/shared';
import { fetchModel } from './modelPack';

/**
 * The shared cape: every cape / cloak back cosmetic is the SAME skinned cloth (client/public/models/cape.glb, scripts/prep-cape.mjs,
 * credit in CREDITS.md) with its own SKIN, a canvas texture painted in the cloth's UV layout (gradient, lining, trim along the hem,
 * collar and sides, an emblem, glowing parts) that is multiplied onto the original's neutral drape shading. A cape is worn on any
 * character model through a `CapeFit` (where the collar sits in the torso's frame and how big the cloth is) and moved by a small
 * cloth simulation: its five chains of ten bones are damped springs that swing from the wearer's speed, strafing, turning,
 * acceleration, a little wind, and gravity (blended between the body's down and the world's down so it follows a stoop).
 * Until the file has loaded (or if it fails) models.ts keeps drawing the old plank capes, and rebuilds when `capeModelVersion()` changes.
 */

export const CAPE_URL = '/models/cape.glb';
/** Back cosmetics with these `style`s are capes (the same cloth, different skins). Wings, ribbons, banners and the rift are not. */
export const CAPE_STYLES = ['cloak', 'starcloak', 'embercloak'] as const;
export const isCapeItem = (item: { style?: string } | undefined) => !!item && (CAPE_STYLES as readonly string[]).includes(item.style ?? '');

// ------------------------------------------------------------------ the asset

const CHAINS = ['cape_R2', 'cape_R1', 'cape', 'cape_L1', 'cape_L2'] as const; // from the character's right (-x) to its left
const CHAIN_BONES = 11; // 00 is the unweighted anchor, 01..10 carry the skin

export interface CapeAsset {
  scene: THREE.Group;
  /** The neutral drape-shading image (UV layout of the cloth). */
  shading: CanvasImageSource | undefined;
  credit: Record<string, string>;
  island: IslandMask;
}

let asset: CapeAsset | undefined;
let version = 0;

/** Changes whenever the cape model is loaded or dropped; added to riggedModels' `modelVersion` so scenes rebuild their characters. */
export const capeModelVersion = () => version;
export const capeAsset = () => asset;

const MASK = 256;
/** Where the cloth is in its texture: the mask of the outer face and the hem / collar / side edges per column and row (in 0..1 of the texture). */
interface IslandMask {
  hem: Float32Array; // per column: v of the lowest covered pixel (or -1)
  top: Float32Array;
  left: Float32Array; // per row: u of the leftmost / rightmost covered pixel (or -1)
  right: Float32Array;
  covered: (u: number, v: number) => boolean;
}

/** Rasterise the outer face's UV triangles (the lining island is the small one at the top right) to find the cloth's edges. */
function islandMask(geo: THREE.BufferGeometry): IslandMask {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const index = geo.index!;
  const m = new Uint8Array(MASK * MASK);
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
    const cu = (uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3;
    const cv = (uv.getY(a) + uv.getY(b) + uv.getY(c)) / 3;
    if (cu > 0.68 && cv < 0.4) continue; // the lining
    const px = [a, b, c].map((i) => [uv.getX(i) * MASK, uv.getY(i) * MASK]);
    const x0 = Math.max(0, Math.floor(Math.min(px[0][0], px[1][0], px[2][0]))), x1 = Math.min(MASK - 1, Math.ceil(Math.max(px[0][0], px[1][0], px[2][0])));
    const y0 = Math.max(0, Math.floor(Math.min(px[0][1], px[1][1], px[2][1]))), y1 = Math.min(MASK - 1, Math.ceil(Math.max(px[0][1], px[1][1], px[2][1])));
    const [[ax, ay], [bx, by], [cx, cy]] = px;
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-9) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const l1 = ((by - cy) * (x + 0.5 - cx) + (cx - bx) * (y + 0.5 - cy)) / den;
      const l2 = ((cy - ay) * (x + 0.5 - cx) + (ax - cx) * (y + 0.5 - cy)) / den;
      if (l1 >= -0.02 && l2 >= -0.02 && 1 - l1 - l2 >= -0.02) m[y * MASK + x] = 1;
    }
  }
  const hem = new Float32Array(MASK).fill(-1), top = new Float32Array(MASK).fill(-1);
  const left = new Float32Array(MASK).fill(-1), right = new Float32Array(MASK).fill(-1);
  for (let y = 0; y < MASK; y++) for (let x = 0; x < MASK; x++) {
    if (!m[y * MASK + x]) continue;
    if (top[x] < 0) top[x] = y / MASK;
    hem[x] = (y + 1) / MASK;
    if (left[y] < 0) left[y] = x / MASK;
    right[y] = (x + 1) / MASK;
  }
  return { hem, top, left, right, covered: (u, v) => !!m[Math.min(MASK - 1, Math.max(0, Math.floor(v * MASK))) * MASK + Math.min(MASK - 1, Math.max(0, Math.floor(u * MASK)))] };
}

function finish(gltf: { scene: THREE.Group }) {
  let mesh: THREE.SkinnedMesh | undefined;
  gltf.scene.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh) mesh = o;
  });
  if (!mesh) throw new Error('cape: no skinned mesh');
  for (const c of CHAINS) for (let j = 0; j < CHAIN_BONES; j++) {
    const n = `${c}_${String(j).padStart(2, '0')}`;
    if (!gltf.scene.getObjectByName(n)) throw new Error(`cape: no bone ${n}`);
  }
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  const mat = mesh.material as THREE.MeshStandardMaterial;
  const credit = (gltf as unknown as { parser?: { json?: { asset?: { extras?: Record<string, string> } } } }).parser?.json?.asset?.extras ?? {};
  asset = { scene: gltf.scene, shading: mat.map?.image as CanvasImageSource | undefined, credit, island: islandMask(mesh.geometry) };
  skinCache.clear();
  version++;
}

/** Parse the cape GLB from memory (tests, or a fetched pack). */
export function registerCapeModel(data: ArrayBuffer): Promise<CapeAsset> {
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

export function forgetCapeModel() {
  asset = undefined;
  skinCache.clear();
  version++;
}

/** Load the cape in the background; a failure is logged and the old plank capes stay. */
export function preloadCapeModel(): Promise<void> {
  return fetchModel(CAPE_URL)
    .then((data) => registerCapeModel(data))
    .then(() => undefined)
    .catch((e) => console.warn('cape model failed to load, keeping the plain capes', e));
}

// ------------------------------------------------------------------ skins

export interface CapeSkin {
  id: string;
  /** Outer cloth colour at the collar and at the hem (a vertical gradient). */
  top: number;
  bottom: number;
  lining: number;
  trim: number;
  /** Trim widths as fractions of the texture: hem, collar, sides. */
  hemW: number;
  collarW: number;
  sideW: number;
  emblem: 'none' | 'crest' | 'waves' | 'moon' | 'leaf' | 'rune' | 'flake' | 'stars' | 'embers';
  /** The trim and emblem glow (emissive map, pulsing). 0 = no glow. */
  glow: number;
  glowColor: number;
  /** Pattern seeds / densities for the star and ember skins. */
  pattern?: 'stars' | 'embers';
}

const hex = (c: string) => parseInt(c.replace('#', ''), 16) || 0x888888;
const mix = (a: number, b: number, k: number) => new THREE.Color(a).lerp(new THREE.Color(b), k).getHex();

const CLOAK_LOOK: Record<string, { trim: number; emblem: CapeSkin['emblem']; dark?: number }> = {
  cloak_crimson: { trim: 0xf0c53a, emblem: 'crest' },
  cloak_azure: { trim: 0xdcecff, emblem: 'waves' },
  cloak_midnight: { trim: 0x9aa4d8, emblem: 'moon' },
  cloak_verdant: { trim: 0xe8d27c, emblem: 'leaf' },
  cloak_violet: { trim: 0xf0c53a, emblem: 'rune' },
  cloak_snow: { trim: 0x7fa6d8, emblem: 'flake', dark: 0.1 },
};
const EMBLEMS: CapeSkin['emblem'][] = ['crest', 'waves', 'moon', 'leaf', 'rune', 'flake'];

/** The look of one cape item (pure data, so it can be compared and tested without a canvas). */
export function capeSkinFor(item: Pick<CosmeticItem, 'id' | 'style' | 'color'>): CapeSkin {
  const c = hex(item.color);
  if (item.style === 'starcloak') {
    return { id: item.id, top: mix(0x0a1030, c, 0.12), bottom: mix(0x040612, c, 0.1), lining: 0x151a4a, trim: mix(c, 0xffffff, 0.35), hemW: 0.03, collarW: 0.035, sideW: 0.012, emblem: 'stars', glow: 1.2, glowColor: mix(c, 0xffffff, 0.45), pattern: 'stars' };
  }
  if (item.style === 'embercloak') {
    return { id: item.id, top: mix(c, 0x3a2a30, 0.35), bottom: mix(c, 0x1a0c08, 0.2), lining: 0x2a0e08, trim: 0xff7a1a, hemW: 0.05, collarW: 0.03, sideW: 0.014, emblem: 'embers', glow: 1.5, glowColor: 0xff8a2a, pattern: 'embers' };
  }
  const look = CLOAK_LOOK[item.id] ?? { trim: mix(c, 0xffffff, 0.75), emblem: EMBLEMS[hashOf(item.id) % EMBLEMS.length] };
  const dk = look.dark ?? 0;
  return {
    id: item.id,
    top: mix(mix(c, 0xffffff, 0.08), 0x000000, dk),
    bottom: mix(c, 0x000000, 0.3 + dk),
    lining: mix(c, 0x000000, 0.62),
    trim: look.trim,
    hemW: 0.04,
    collarW: 0.03,
    sideW: 0.012,
    emblem: look.emblem,
    glow: 0,
    glowColor: look.trim,
  };
}

function hashOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const css = (c: number, a = 1) => `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;

const S = 512;
const AXIS = 0.52; // the cloth's centre line in u
const EMBLEM_AT = 0.36; // v of the emblem's centre (the collar is hidden by the neck and shoulders)

type Ctx = CanvasRenderingContext2D;

function drawEmblem(ctx: Ctx, kind: CapeSkin['emblem'], color: number, R: number, x: number, y: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = css(color, 0.95);
  ctx.fillStyle = css(color, 0.95);
  ctx.lineWidth = R * 0.14;
  ctx.lineCap = ctx.lineJoin = 'round';
  switch (kind) {
    case 'crest':
      ctx.beginPath();
      ctx.moveTo(0, -R * 1.2);
      ctx.lineTo(R * 0.8, 0);
      ctx.lineTo(0, R * 1.2);
      ctx.lineTo(-R * 0.8, 0);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -R * 0.5);
      ctx.lineTo(R * 0.32, 0);
      ctx.lineTo(0, R * 0.5);
      ctx.lineTo(-R * 0.32, 0);
      ctx.closePath();
      ctx.fill();
      break;
    case 'waves':
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        for (let k = 0; k <= 24; k++) {
          const px = (k / 24 - 0.5) * R * 2.2;
          const py = i * R * 0.5 + Math.sin(k / 24 * Math.PI * 4) * R * 0.14;
          k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.stroke();
      }
      break;
    case 'moon':
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(R * 0.5, -R * 0.12, R * 0.82, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'leaf':
      ctx.beginPath();
      ctx.moveTo(0, R * 1.2);
      ctx.quadraticCurveTo(R * 1.1, R * 0.1, 0, -R * 1.2);
      ctx.quadraticCurveTo(-R * 1.1, R * 0.1, 0, R * 1.2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, R * 1.35);
      ctx.lineTo(0, -R * 0.6);
      ctx.stroke();
      break;
    case 'rune':
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = -Math.PI / 2 + (k * 2 * Math.PI * 2) / 5;
        const px = Math.cos(a) * R * 0.78, py = Math.sin(a) * R * 0.78;
        k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.stroke();
      break;
    case 'flake':
      for (let k = 0; k < 6; k++) {
        ctx.save();
        ctx.rotate((k * Math.PI) / 3);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -R * 1.15);
        ctx.moveTo(0, -R * 0.62);
        ctx.lineTo(R * 0.3, -R * 0.9);
        ctx.moveTo(0, -R * 0.62);
        ctx.lineTo(-R * 0.3, -R * 0.9);
        ctx.stroke();
        ctx.restore();
      }
      break;
    default:
      break;
  }
  ctx.restore();
}

function star(ctx: Ctx, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const rr = k % 2 ? r * 0.28 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

const canvasOf = (): HTMLCanvasElement | undefined => (typeof document === 'undefined' ? undefined : document.createElement('canvas'));

function paintSkin(skin: CapeSkin, a: CapeAsset): { map: THREE.CanvasTexture; emissive?: THREE.CanvasTexture } | undefined {
  const cv = canvasOf();
  if (!cv) return undefined;
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  if (!ctx) return undefined;
  const isl = a.island;
  const glowCv = skin.glow ? canvasOf()! : undefined;
  const gctx = glowCv?.getContext('2d') ?? undefined;
  if (glowCv && gctx) {
    glowCv.width = glowCv.height = S;
    gctx.fillStyle = '#000';
    gctx.fillRect(0, 0, S, S);
  }
  const rand = rng(hashOf(skin.id));
  // cloth gradient (collar -> hem), the lining island on top
  const grad = ctx.createLinearGradient(0, 0.03 * S, 0, 0.97 * S);
  grad.addColorStop(0, css(skin.top));
  grad.addColorStop(1, css(skin.bottom));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, S, S);
  // star and ember patterns (inside the cloth only)
  if (skin.pattern === 'stars') {
    for (let i = 0; i < 90; i++) {
      const u = 0.1 + rand() * 0.82, v = 0.05 + rand() * 0.9;
      if (!isl.covered(u, v)) continue;
      const r = (0.8 + rand() * rand() * 4.2) * (S / 512);
      const bright = rand() > 0.35;
      ctx.fillStyle = css(bright ? 0xffffff : mix(skin.glowColor, 0xffffff, 0.3), 0.55 + rand() * 0.45);
      star(ctx, u * S, v * S, r);
      if (gctx) {
        gctx.fillStyle = css(bright ? 0xffffff : skin.glowColor, 0.5 + rand() * 0.5);
        star(gctx, u * S, v * S, r);
      }
    }
    // a constellation on the shoulder blades
    const pts: [number, number][] = [[-0.11, -0.05], [-0.04, 0.02], [0.03, -0.03], [0.1, 0.05], [0.04, 0.12], [-0.05, 0.1]];
    for (const g of [ctx, gctx]) {
      if (!g) continue;
      g.strokeStyle = css(skin.trim, g === ctx ? 0.5 : 0.7);
      g.lineWidth = 1.2;
      g.beginPath();
      pts.forEach(([du, dv], k) => (k ? g.lineTo((AXIS + du) * S, (EMBLEM_AT + dv) * S) : g.moveTo((AXIS + du) * S, (EMBLEM_AT + dv) * S)));
      g.stroke();
      g.fillStyle = css(0xffffff, 0.95);
      for (const [du, dv] of pts) star(g, (AXIS + du) * S, (EMBLEM_AT + dv) * S, 5);
    }
  } else if (skin.pattern === 'embers') {
    // glowing cracks climbing from the hem, and a hot haze along the bottom
    const hot = ctx.createLinearGradient(0, 0.55 * S, 0, 0.97 * S);
    hot.addColorStop(0, css(0xff6a10, 0));
    hot.addColorStop(1, css(0xff6a10, 0.55));
    ctx.fillStyle = hot;
    ctx.fillRect(0, 0.55 * S, S, 0.45 * S);
    if (gctx) {
      const hg = gctx.createLinearGradient(0, 0.6 * S, 0, 0.97 * S);
      hg.addColorStop(0, css(0xff5a10, 0));
      hg.addColorStop(1, css(0xff5a10, 0.5));
      gctx.fillStyle = hg;
      gctx.fillRect(0, 0.6 * S, S, 0.4 * S);
    }
    for (let i = 0; i < 16; i++) {
      let u = 0.18 + rand() * 0.68, v = 0.93 - rand() * 0.1;
      if (!isl.covered(u, v)) continue;
      const pts: [number, number][] = [[u, v]];
      const len = 4 + Math.floor(rand() * 7);
      for (let k = 0; k < len; k++) {
        u += (rand() - 0.5) * 0.045;
        v -= 0.02 + rand() * 0.035;
        pts.push([u, v]);
      }
      for (const [g, col, w] of [[ctx, 0xffb04a, 2.2], [gctx, 0xff8a2a, 3.2]] as const) {
        if (!g) continue;
        g.strokeStyle = css(col, 0.95);
        g.lineWidth = w;
        g.lineCap = 'round';
        g.beginPath();
        pts.forEach(([pu, pv], k) => (k ? g.lineTo(pu * S, pv * S) : g.moveTo(pu * S, pv * S)));
        g.stroke();
      }
    }
    for (let i = 0; i < 40; i++) {
      const u = 0.12 + rand() * 0.8, v = 0.45 + rand() * 0.5;
      if (!isl.covered(u, v)) continue;
      for (const [g, col] of [[ctx, 0xffd27a], [gctx, 0xff9a3a]] as const) {
        if (!g) continue;
        g.fillStyle = css(col, 0.5 + rand() * 0.5);
        g.beginPath();
        g.arc(u * S, v * S, 1 + rand() * 1.8, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  // emblem between the shoulder blades
  if (skin.emblem !== 'none' && skin.emblem !== 'stars' && skin.emblem !== 'embers') {
    drawEmblem(ctx, skin.emblem, skin.trim, 0.07 * S, AXIS * S, EMBLEM_AT * S);
    if (gctx && skin.glow) drawEmblem(gctx, skin.emblem, skin.glowColor, 0.07 * S, AXIS * S, EMBLEM_AT * S);
  }
  // trim along the hem, the collar and the two side edges (they follow the cloth's own outline)
  const bands = (g: Ctx, col: number, k = 1) => {
    g.fillStyle = css(col, k);
    for (let x = 0; x < MASK; x++) {
      const px = (x / MASK) * S;
      if (isl.hem[x] >= 0) {
        g.fillRect(px, (isl.hem[x] - skin.hemW) * S, S / MASK + 0.6, skin.hemW * S + 2);
        g.fillRect(px, isl.top[x] * S - 1, S / MASK + 0.6, skin.collarW * S + 1);
      }
    }
    // the side edges are a hint, not a cord: half strength and out of the glow map (seen edge-on a bright line reads as a rope)
    g.fillStyle = css(col, k * (g === ctx ? 0.5 : 0));
    for (let y = 0; y < MASK; y++) {
      const py = (y / MASK) * S;
      if (isl.left[y] >= 0 && y / MASK > 0.12) {
        g.fillRect(isl.left[y] * S - 1, py, skin.sideW * S + 1, S / MASK + 0.6);
        g.fillRect(isl.right[y] * S - skin.sideW * S, py, skin.sideW * S + 1, S / MASK + 0.6);
      }
    }
  };
  bands(ctx, skin.trim);
  if (gctx && skin.glow) bands(gctx, skin.glowColor, 0.9);
  // lining island
  ctx.fillStyle = css(skin.lining);
  ctx.fillRect(0.66 * S, 0, 0.34 * S, 0.42 * S);
  // the original's drape shading on top of everything
  if (a.shading) {
    ctx.globalCompositeOperation = 'multiply';
    try {
      ctx.drawImage(a.shading, 0, 0, S, S);
    } catch {
      /* no usable image: flat colours */
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  const tex = (c: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(c);
    t.flipY = false;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  return { map: tex(cv), emissive: glowCv ? tex(glowCv) : undefined };
}

interface SkinMaterial {
  skin: CapeSkin;
  material: THREE.MeshStandardMaterial;
}
const skinCache = new Map<string, SkinMaterial>();

/** The shared material of a cape item (one per item id, textures painted once). Units clone it when they need a colour of their own. */
export function capeMaterial(item: Pick<CosmeticItem, 'id' | 'style' | 'color'>): SkinMaterial | undefined {
  if (!asset) return undefined;
  let s = skinCache.get(item.id);
  if (!s) {
    const skin = capeSkinFor(item);
    const painted = paintSkin(skin, asset);
    const src = (asset.scene.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh).material as THREE.MeshStandardMaterial;
    const material = new THREE.MeshStandardMaterial({
      name: `cape:${item.id}`,
      map: painted?.map ?? src.map,
      color: painted ? 0xffffff : mix(skin.top, skin.bottom, 0.4),
      roughness: 0.86,
      metalness: 0,
      side: THREE.DoubleSide,
      emissiveMap: painted?.emissive ?? null,
      emissive: skin.glow ? 0xffffff : 0x000000,
      emissiveIntensity: skin.glow,
    });
    material.userData.glow = skin.glow;
    material.userData.base = new THREE.Color(material.color);
    material.userData.noDye = true;
    s = { skin, material };
    skinCache.set(item.id, s);
  }
  return s;
}

// ------------------------------------------------------------------ fit

/** Where a cape hangs on a character model, in the frame of its torso anchor (the chest bone's, axes aligned with the character). */
export interface CapeFit {
  /** Collar position: y up from the anchor's origin, z behind it (positive = behind the chest's centre line). */
  y: number;
  z: number;
  /** Cloth scale: across, down and out. The cloth is 0.9 wide at the hem and 1.26 long at scale 1. */
  sx: number;
  sy: number;
  sz: number;
  /** Extra forward / backward lean of the whole cloth (radians, positive swings the hem backwards). */
  tilt: number;
  /** How far the hem may swing towards the body (radians, negative = towards the front): keeps the cloth off the back. */
  minPitch: number;
  /** 0..1: how much the hanging direction follows the world's down instead of the body's (a stooped body drops the cloth straight). */
  worldDown: number;
}

export const DEFAULT_CAPE_FIT: CapeFit = { y: 0.74, z: 0.2, sx: 1.5, sy: 0.85, sz: 0.8, tilt: 0.05, minPitch: -0.04, worldDown: 0.3 };

export interface CapeInput {
  dt: number;
  /** Speed along the facing direction and sideways (positive = to the character's left), units per second. */
  vf: number;
  vs: number;
  move: number;
  time: number;
  air?: number;
  /** A dead unit's cloth goes limp. */
  dead: boolean;
  /** The wearer is casting (wings flare). */
  casting?: boolean;
}

export interface CapeRig {
  /** The unit's own cape group (under the torso anchor). */
  group: THREE.Group;
  mesh: THREE.SkinnedMesh;
  skin: CapeSkin;
  material: THREE.MeshStandardMaterial;
  bones: THREE.Bone[][];
  /** Swing of each chain bone: pitch (hem backwards) and roll (hem towards the left), radians. For tests and debugging. */
  state: { pitch: Float32Array; roll: Float32Array };
  update(p: CapeInput): void;
}

/** The most the hem may stream out behind (radians from hanging): about 45 degrees at a full run. */
const MAX_SWING = 0.8;
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _e = new THREE.Vector3();

/** Hang the item's cape from `parent` (a torso anchor) with this fit. Undefined while the cape model is not loaded. */
export function buildCape(item: Pick<CosmeticItem, 'id' | 'style' | 'color'>, fit: CapeFit, parent: THREE.Object3D): CapeRig | undefined {
  const a = asset;
  const sm = capeMaterial(item);
  if (!a || !sm) return undefined;
  const group = new THREE.Group();
  group.name = `cape:${item.id}`;
  group.position.set(0, fit.y, -fit.z);
  group.rotation.x = fit.tilt;
  group.scale.set(fit.sx, fit.sy, fit.sz);
  const root = cloneSkinned(a.scene) as THREE.Group;
  group.add(root);
  parent.add(group);
  let mesh!: THREE.SkinnedMesh;
  root.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh) mesh = o;
  });
  const material = sm.material.clone();
  material.userData = { ...sm.material.userData, base: new THREE.Color(0xffffff) };
  mesh.material = material;
  mesh.frustumCulled = false;
  const bones: THREE.Bone[][] = CHAINS.map((c) => Array.from({ length: CHAIN_BONES }, (_, j) => root.getObjectByName(`${c}_${String(j).padStart(2, '0')}`) as THREE.Bone));
  const rootBone = root.getObjectByName('cape_root') as THREE.Bone;
  // rest frames: the world rotation (inside the cape group) of every bone's parent, and the bone's own rest rotation
  const parentQ: THREE.Quaternion[][] = [];
  const parentInv: THREE.Quaternion[][] = [];
  const restQ: THREE.Quaternion[][] = [];
  bones.forEach((chain) => {
    const pq: THREE.Quaternion[] = [], pi: THREE.Quaternion[] = [], rq: THREE.Quaternion[] = [];
    let w = rootBone.quaternion.clone();
    chain.forEach((b) => {
      pq.push(w.clone());
      pi.push(w.clone().invert());
      rq.push(b.quaternion.clone());
      w = w.clone().multiply(b.quaternion);
    });
    parentQ.push(pq);
    parentInv.push(pi);
    restQ.push(rq);
  });
  const N = CHAINS.length * CHAIN_BONES;
  const state = { pitch: new Float32Array(N), roll: new Float32Array(N) };
  const pv = new Float32Array(N), rv = new Float32Array(N);
  const sim = { lastVf: 0, lastVs: 0, yaw: NaN, yawRate: 0, init: false, ap0: NaN, ar0: NaN };
  const swing = { f: 0, s: 0, accel: 0, accelS: 0 };
  const glowBase = sm.skin.glow;

  const apply = () => {
    for (let c = 0; c < CHAINS.length; c++) {
      for (let j = 1; j < CHAIN_BONES; j++) {
        const i = c * CHAIN_BONES + j;
        const hp = state.pitch[i] * 0.5, hr = state.roll[i] * 0.5;
        // R = Rz(roll) * Rx(pitch), moved into the bone's frame: local = P^-1 R P * rest
        _qa.set(Math.sin(hp), 0, 0, Math.cos(hp));
        _qb.set(0, 0, Math.sin(hr), Math.cos(hr));
        _qc.multiplyQuaternions(_qb, _qa);
        _qa.multiplyQuaternions(parentInv[c][j], _qc);
        _qb.multiplyQuaternions(_qa, parentQ[c][j]);
        bones[c][j].quaternion.multiplyQuaternions(_qb, restQ[c][j]);
      }
    }
  };

  const step = (h: number, p: CapeInput, gx: number, gz: number, speed: number) => {
    const t = p.time;
    for (let c = 0; c < CHAINS.length; c++) {
      const side = (c - 2) / 2; // -1 (the outer right) .. +1 (the outer left)
      let cumP = 0;
      for (let j = 1; j < CHAIN_BONES; j++) {
        const i = c * CHAIN_BONES + j;
        const k = j / (CHAIN_BONES - 1); // 0 at the collar, 1 at the hem
        const stiff = (p.dead ? 26 : 70 * (1 - 0.8 * k) + 16) * (j === 1 ? 2.5 : 1);
        const damp = p.dead ? 7 : 5.2 + 2 * (1 - k);
        const wave = Math.sin(t * 1.9 + c * 0.7 + j * 0.45) * (0.3 + 0.7 * k);
        const flutter = Math.sin(t * 11 + j * 0.9 + c * 1.3) * p.move * (0.3 + 0.7 * k);
        cumP += state.pitch[i];
        // pitch: gravity (towards the hanging direction), wind from running, inertia, idle wind
        let tp = -22 * Math.sin(cumP - gz) * (1.1 - 0.5 * k);
        if (!p.dead) tp += (swing.f * (3 + 5 * k) + swing.accel * 1.2 * (0.3 + k)) * (1 - 0.15 * Math.abs(side)) + wave * 2.4 + flutter * 3.5 * speed;
        tp -= stiff * state.pitch[i];
        // neighbours pull towards each other so the cloth stays one surface
        const nb = (cc: number) => (cc >= 0 && cc < CHAINS.length ? state.pitch[cc * CHAIN_BONES + j] : state.pitch[i]);
        tp += 14 * ((nb(c - 1) + nb(c + 1)) * 0.5 - state.pitch[i]);
        pv[i] += (tp - damp * pv[i]) * h;
        // roll: strafing and turning swing the hem sideways, the outer chains flare out when moving
        let tr = -16 * Math.sin(state.roll[i] - gx) * (0.8 - 0.4 * k);
        if (!p.dead) tr += (-swing.s * (2.5 + 5.5 * k) - sim.yawRate * 2.6 * k - swing.accelS * 0.9 * k + side * (1.5 + 4.5 * k) * speed + wave * 1.4 * side + flutter * 2.2 * side) * 1;
        tr -= stiff * 0.8 * state.roll[i];
        const nr = (cc: number) => (cc >= 0 && cc < CHAINS.length ? state.roll[cc * CHAIN_BONES + j] : state.roll[i]);
        tr += 10 * ((nr(c - 1) + nr(c + 1)) * 0.5 - state.roll[i]);
        rv[i] += (tr - damp * 1.1 * rv[i]) * h;
        state.pitch[i] += pv[i] * h;
        state.roll[i] += rv[i] * h;
        // limits: the hem cannot swing into the body, and the cloth cannot fold over on itself
        state.pitch[i] = p.dead ? Math.min(0.7, Math.max(-0.5, state.pitch[i])) : Math.min(0.55, Math.max(-0.2, state.pitch[i]));
        state.roll[i] = Math.min(0.5, Math.max(-0.5, state.roll[i]));
        let cum = 0;
        for (let q = 1; q <= j; q++) cum += state.pitch[c * CHAIN_BONES + q];
        const maxSwing = p.dead ? 1.6 : MAX_SWING;
        if (cum > maxSwing) {
          state.pitch[i] -= cum - maxSwing;
          if (pv[i] > 0) pv[i] = 0;
        }
        const minP = p.dead ? -1.4 : fit.minPitch;
        if (cum < minP) {
          state.pitch[i] += minP - cum;
          if (pv[i] < 0) pv[i] = 0;
        }
      }
    }
  };

  const update = (p: CapeInput) => {
    const dt = Math.min(Math.max(p.dt, 0.001), 1 / 30);
    // the unit's heading in the world: its turning drags the cloth (the matrix is a frame old, which is fine for a difference)
    group.updateWorldMatrix(true, false);
    const e = group.matrixWorld.elements;
    const yaw = Math.atan2(e[8], e[10]);
    if (Number.isNaN(sim.yaw)) sim.yaw = yaw;
    let dy = yaw - sim.yaw;
    if (dy > Math.PI) dy -= Math.PI * 2;
    if (dy < -Math.PI) dy += Math.PI * 2;
    sim.yaw = yaw;
    const rawRate = Math.max(-9, Math.min(9, dy / Math.max(p.dt, 0.001)));
    sim.yawRate += (rawRate - sim.yawRate) * (1 - Math.exp(-14 * dt));
    if (!sim.init) {
      sim.init = true;
      sim.lastVf = p.vf;
      sim.lastVs = p.vs;
    }
    const f = Math.max(-1, Math.min(1.3, p.vf / 7));
    const s = Math.max(-1, Math.min(1, p.vs / 7));
    swing.f += (f - swing.f) * (1 - Math.exp(-9 * dt));
    swing.s += (s - swing.s) * (1 - Math.exp(-9 * dt));
    const af = Math.max(-30, Math.min(30, (p.vf - sim.lastVf) / dt));
    const as = Math.max(-30, Math.min(30, (p.vs - sim.lastVs) / dt));
    swing.accel += (Math.max(-1.2, Math.min(1.2, -af / 7)) - swing.accel) * (1 - Math.exp(-12 * dt)); // forward acceleration leaves the cloth behind (positive swing)
    swing.accelS += (Math.max(-1.2, Math.min(1.2, as / 7)) - swing.accelS) * (1 - Math.exp(-12 * dt));
    sim.lastVf = p.vf;
    sim.lastVs = p.vs;
    // the hanging direction: world down as the group sees it, measured against how it looked the first time (the fit's rest pose is
    // designed for the idle stance); a body that bends forward drops the cloth straight down by `worldDown` of that bend
    const m = e;
    const sc = group.scale;
    _e.set(-m[1] / sc.x, -m[5] / sc.y, -m[9] / sc.z).normalize();
    const ap = Math.atan2(-_e.z, -_e.y);
    const ar = Math.atan2(_e.x, -_e.y);
    if (Number.isNaN(sim.ap0)) {
      sim.ap0 = ap;
      sim.ar0 = ar;
    }
    // a dead body lies in any pose: the cloth then simply falls towards the ground (full world gravity, wide limits)
    const wd = p.dead ? 1 : fit.worldDown;
    const lim = p.dead ? 1.3 : 0.5;
    const gPitch = Math.max(-lim, Math.min(lim, (ap - sim.ap0) * wd));
    const gRoll = Math.max(-lim, Math.min(lim, (ar - sim.ar0) * wd));
    const speed = Math.min(1, Math.abs(swing.f) + Math.abs(swing.s) * 0.6);
    const sub = dt > 1 / 55 ? 2 : 1;
    for (let k = 0; k < sub; k++) step(dt / sub, p, gRoll, gPitch, speed);
    apply();
    // glow: the stars and embers breathe
    if (glowBase > 0 && !p.dead) material.emissiveIntensity = glowBase * (0.82 + 0.18 * Math.sin(p.time * 2.3 + 1));
  };

  return { group, mesh, skin: sm.skin, material, bones, state, update };
}

