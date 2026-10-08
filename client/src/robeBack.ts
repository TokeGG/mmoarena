import * as THREE from 'three';
import type { CosmeticItem } from '@arena/shared';
import { capeSkinFor } from './capeModels';

/**
 * The mage's cloaks. The Old Wizard already wears a hooded, cloak-like robe, so a cloak cosmetic does not add a second cloth over it
 * (the shared cape of capeModels.ts is for the other classes): it recolours the BACK HALF of his own robe, hood included, in the
 * cloak's colours and pattern. Models list the sub-meshes this applies to in `ModelDef.robeBack`.
 *
 * Per vertex, once per geometry (`robeBackAttribute`): `aBack = (mask, along, 0)`. `mask` is 1 behind the robe's mid-plane and 0 in
 * front of it, easing across the sides over a few inches (the mid-plane is measured per height from the robe's own front and back, so
 * the hood, the body and the hem train are each cut through their middle); sleeves (arm-weighted vertices) stay as they were.
 * `along` runs 0 at the collar to 1 at the hem. Both are computed from the rest pose and ride along as a vertex attribute, so the
 * region follows every animation. The fragment shader (`ROBE_BACK_GLSL`, spliced into the dye shader in models.ts) then replaces the
 * hue of the robe's baked texture by the cloak's, keeping its luminance (folds and stitching survive, exactly like the dye does):
 * a collar-to-hem gradient, a trim colour along the hem, and a procedural pattern (stars, embers, frost) from the rest-pose position.
 *
 * With a dye worn too (`tint` slot): the dye (or the spec's own robe tint) keeps the FRONT half; the back half is always the cloak.
 */

export interface RobeBackLook {
  /** Colour at the collar and at the hem (a cloak keeps its colour; it is scaled by the robe's baked brightness). */
  top: number;
  bottom: number;
  /** Trim along the hem, as a fraction of the robe's height. */
  trim: number;
  trimW: number;
  /** 0 plain, 1 stars, 2 embers, 3 frost. */
  pattern: number;
  /** Emissive strength of the pattern and the trim (0 = lit only), and its colour. */
  glow: number;
  glowColor: number;
}

const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
/** Bright cloaks are held back like bright dyes (a white albedo blows out in the sun). */
function hold(c: number, cap = 0.3): THREE.Color {
  const col = new THREE.Color(c);
  const l = lum(col);
  if (l > cap) col.multiplyScalar(cap / l + (1 - cap / l) * 0.35);
  return col;
}

/** The robe look of one cloak item: its cape skin's colours (capeModels.ts), so it matches the cloth the other classes wear. */
export function robeBackLook(item: Pick<CosmeticItem, 'id' | 'style' | 'color'>): RobeBackLook {
  const s = capeSkinFor(item);
  if (item.style === 'starcloak') return { top: 0x1c2a70, bottom: 0x0a1030, trim: 0x7f9ae0, trimW: 0.018, pattern: 1, glow: 1, glowColor: s.glowColor };
  if (item.style === 'embercloak') return { top: 0x5c1810, bottom: 0x2a0a08, trim: 0xff7a1a, trimW: 0.05, pattern: 2, glow: 1, glowColor: 0xff8a2a };
  if (item.id === 'cloak_midnight') return { top: 0x1c2250, bottom: 0x0b0d26, trim: s.trim, trimW: 0.024, pattern: 0, glow: 0, glowColor: s.trim };
  return { top: s.top, bottom: s.bottom, trim: s.trim, trimW: 0.024, pattern: item.id === 'cloak_snow' ? 3 : 0, glow: item.id === 'cloak_snow' ? 0.35 : 0, glowColor: item.id === 'cloak_snow' ? 0xcfe4ff : s.trim };
}

export interface RobeBackUniforms {
  uBTop: { value: THREE.Color };
  uBBot: { value: THREE.Color };
  uBTrim: { value: THREE.Color };
  uBGlowCol: { value: THREE.Color };
  uBTrimW: { value: number };
  uBPat: { value: number };
  uBGlow: { value: number };
  uBLift: { value: number };
  uBGain: { value: number };
  uBFloor: { value: number };
  uBTime: { value: number };
  /** 1 while alive, 0 when dead. */
  uBOn: { value: number };
}

export function robeBackUniforms(look: RobeBackLook): RobeBackUniforms {
  const snow = look.pattern === 3;
  return {
    uBTop: { value: hold(look.top, snow ? 0.8 : 0.3) },
    uBBot: { value: hold(look.bottom, snow ? 0.7 : 0.3) },
    uBTrim: { value: hold(look.trim, 0.5) },
    uBGlowCol: { value: new THREE.Color(look.glowColor) },
    uBTrimW: { value: look.trimW },
    uBPat: { value: look.pattern },
    uBGlow: { value: look.glow },
    uBLift: { value: 0.14 },
    uBGain: { value: 2.3 },
    uBFloor: { value: snow ? 0.22 : 0.12 },
    uBTime: { value: 0 },
    uBOn: { value: 1 },
  };
}

// ------------------------------------------------------------------ the mask

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Half-width of the blend across the sides, in the model file's units (the wizard is ~70 tall for 2.15 m: 3 units = 9 cm). */
const SIDE = 2.2;

/**
 * The `aBack` attribute of a skinned robe mesh (cached on its geometry, which every unit shares). Positions are taken in the skeleton's
 * bind space (`bindMatrix`), +y up and +z forward (`front` is -1 for a file that faces -z, as the wizard's does); the model's sleeves, found from the skin weights of the arm bones, are left out.
 */
export function robeBackAttribute(mesh: THREE.SkinnedMesh, front: 1 | -1 = 1): THREE.BufferAttribute {
  const geo = mesh.geometry;
  const have = geo.getAttribute('aBack');
  if (have) return have as THREE.BufferAttribute;
  const pos = geo.getAttribute('position');
  const si = geo.getAttribute('skinIndex');
  const sw = geo.getAttribute('skinWeight');
  const names = mesh.skeleton.bones.map((b) => b.name);
  const arm = names.map((n) => /Arm|Hand|Finger|Sleeve/.test(n));
  const n = pos.count;
  const P = new Float32Array(n * 3);
  const armW = new Float32Array(n);
  const v = new THREE.Vector3();
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix);
    P[i * 3] = v.x;
    P[i * 3 + 1] = v.y;
    P[i * 3 + 2] = v.z * front;
    y0 = Math.min(y0, v.y);
    y1 = Math.max(y1, v.y);
    let a = 0;
    if (si && sw) for (let k = 0; k < 4; k++) if (arm[si.getComponent(i, k)]) a += sw.getComponent(i, k);
    armW[i] = a;
  }
  // where the robe's middle is at each height: halfway between its front and its back (sleeves left out), smoothed over a few bands
  const BIN = 2;
  const nb = Math.ceil((y1 - y0) / BIN) + 1;
  const lo = new Float32Array(nb).fill(Infinity);
  const hi = new Float32Array(nb).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    if (armW[i] > 0.5) continue;
    const b = Math.floor((P[i * 3 + 1] - y0) / BIN);
    lo[b] = Math.min(lo[b], P[i * 3 + 2]);
    hi[b] = Math.max(hi[b], P[i * 3 + 2]);
  }
  const mid = new Float32Array(nb);
  const known: number[] = [];
  for (let b = 0; b < nb; b++) if (lo[b] <= hi[b]) known.push(b);
  for (let b = 0; b < nb; b++) {
    let a = known.filter((k) => k <= b).pop();
    let c = known.find((k) => k >= b);
    if (a === undefined) a = c!;
    if (c === undefined) c = a;
    const ma = (lo[a] + hi[a]) / 2;
    const mc = (lo[c] + hi[c]) / 2;
    mid[b] = a === c ? ma : ma + ((mc - ma) * (b - a)) / (c - a);
  }
  const sm = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    let s = 0;
    let w = 0;
    for (let d = -3; d <= 3; d++) {
      const k = Math.min(nb - 1, Math.max(0, b + d));
      s += mid[k];
      w++;
    }
    sm[b] = s / w;
  }
  const collar = y1 - (y1 - y0) * 0.1; // the shoulders / neck: the gradient starts here
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const y = P[i * 3 + 1];
    const f = Math.min(nb - 1.001, Math.max(0, (y - y0) / BIN - 0.5));
    const b = Math.floor(f);
    const c = sm[b] + (sm[b + 1] - sm[b]) * (f - b);
    const behind = 1 - smooth(c - SIDE, c + SIDE, P[i * 3 + 2]);
    out[i * 3] = behind * (1 - smooth(0.25, 0.75, armW[i]));
    out[i * 3 + 1] = Math.min(1, Math.max(0, (collar - y) / (collar - y0)));
  }
  const attr = new THREE.BufferAttribute(out, 3);
  geo.setAttribute('aBack', attr);
  // the pattern is laid out on the rest-pose position (bind space), not the raw file position, so a node transform cannot change its size
  geo.setAttribute('aBackPos', new THREE.BufferAttribute(P, 3));
  return attr;
}

// ------------------------------------------------------------------ the shader

export const ROBE_BACK_GLSL = {
  vertDecl: 'attribute vec3 aBack; attribute vec3 aBackPos; varying vec3 vBack; varying vec3 vBackPos;',
  vertMain: 'vBack = aBack; vBackPos = aBackPos;',
  fragDecl: `
uniform vec3 uBTop; uniform vec3 uBBot; uniform vec3 uBTrim; uniform vec3 uBGlowCol; uniform float uBTrimW; uniform float uBPat;
uniform float uBGlow; uniform float uBLift; uniform float uBGain; uniform float uBFloor; uniform float uBTime; uniform float uBOn;
varying vec3 vBack; varying vec3 vBackPos;
float backLum = 0.0; vec3 backGlow = vec3(0.0); vec3 backFloor = vec3(0.0);
vec3 rbH(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
// one dot per cell at most, kept inside it so the neighbours need no look-up: density, radius (in cells), twinkle speed
float rbDots(vec3 p, float dens, float rad, float flick) {
  vec3 ip = floor(p);
  vec3 h = rbH(ip);
  if (h.x > dens) return 0.0;
  vec3 c = vec3(0.5) + (rbH(ip + 17.3) - 0.5) * 0.4;
  float d = length(fract(p) - c);
  float tw = 0.55 + 0.45 * sin(uBTime * flick * (0.6 + h.y) + h.z * 40.0);
  return (smoothstep(rad, rad * 0.2, d) + 0.25 * smoothstep(rad * 2.4, 0.0, d)) * tw;
}
float rbNoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rbH(i).x, rbH(i + vec3(1,0,0)).x, f.x), mix(rbH(i + vec3(0,1,0)).x, rbH(i + vec3(1,1,0)).x, f.x), f.y),
             mix(mix(rbH(i + vec3(0,0,1)).x, rbH(i + vec3(1,0,1)).x, f.x), mix(rbH(i + vec3(0,1,1)).x, rbH(i + vec3(1,1,1)).x, f.x), f.y), f.z);
}`,
  /** Before the dye block: remember the robe's own brightness. */
  fragLum: `{ float bl = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)); backLum = bl / (1.0 + max(0.0, bl - 0.28) * 5.0); }`, // the baked glyphs are bright: soft-capped so they do not show through
  /** After the dye block: the cloak's colours over the back half. */
  fragColor: `
{
  backM = vBack.x * uBOn;
  if (backM > 0.002) {
    float al = clamp(vBack.y, 0.0, 1.0);
    vec3 col = mix(uBTop, uBBot, smoothstep(0.05, 0.9, al));
    float sh = clamp(uBLift + uBGain * pow(backLum, 0.8), 0.0, 1.0);
    vec3 tgt = col * sh;
    vec3 gl = vec3(0.0);
    vec3 p = vBackPos;
    if (uBPat < 1.5 && uBPat > 0.5) {
      // small white-silver stars, twinkling, in two sizes
      float s = rbDots(p / 3.2, 0.34, 0.16, 2.6) + 0.8 * rbDots(p / 1.7 + 5.0, 0.4, 0.14, 3.4);
      s = clamp(s, 0.0, 1.0);
      tgt = mix(tgt, vec3(0.88, 0.93, 1.0), s * 0.9);
      gl += uBGlowCol * s * 1.3;
    } else if (uBPat > 1.5 && uBPat < 2.5) {
      // ember specks drifting in the dark cloth, hotter and denser towards the hem
      float s = rbDots(p / 2.6, 0.2 + 0.4 * al * al, 0.17, 5.0);
      float n = rbNoise(p / 4.0 + vec3(0.0, uBTime * 0.15, 0.0));
      float heat = smoothstep(0.76, 1.0, al) * (0.55 + 0.9 * n);
      tgt = mix(tgt, vec3(1.0, 0.55, 0.16), clamp(s, 0.0, 1.0) * 0.9);
      gl += uBGlowCol * (clamp(s, 0.0, 1.0) * 1.5 + heat * 0.9 * (0.8 + 0.4 * sin(uBTime * 3.0 + p.x)));
      tgt = mix(tgt, uBTrim, clamp(heat * 0.6, 0.0, 0.6));
    } else if (uBPat > 2.5) {
      // frost: a faint cold shimmer and a few ice glints
      float n = rbNoise(p / 3.0);
      float s = rbDots(p / 2.4, 0.22, 0.12, 2.0);
      tgt *= 0.94 + 0.12 * n;
      tgt = mix(tgt, vec3(0.95, 0.99, 1.0), clamp(s, 0.0, 1.0) * 0.8);
      gl += uBGlowCol * (clamp(s, 0.0, 1.0) * 0.9 + 0.05 * n);
    }
    // the trim along the (ragged) hem
    float tm = smoothstep(1.0 - uBTrimW - 0.025, 1.0 - uBTrimW, al);
    if (uBPat < 0.5 || uBPat > 2.5) tgt = mix(tgt, uBTrim * (0.3 + 0.8 * sh), tm);
    else if (uBPat < 1.5) tgt = mix(tgt, uBTrim * (0.6 + 0.6 * sh), tm * 0.9);
    gl += uBGlowCol * tm * (uBPat > 1.5 && uBPat < 2.5 ? 1.2 : 0.35);
    diffuseColor.rgb = mix(diffuseColor.rgb, tgt, backM);
    backGlow = gl * uBGlow;
    backFloor = col * uBFloor * (0.4 + 0.6 * sh);
  }
}`,
  /** Emissive stage: the robe's own glow (red trim) and the dye's floor give way to the cloak's. */
  fragEmissiveFirst: 'totalEmissiveRadiance *= 1.0 - backM;',
  fragEmissive: 'totalEmissiveRadiance += backM * (backGlow + backFloor);',
};
