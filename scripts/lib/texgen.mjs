// Seamless procedural textures for the arena kit (scripts/prep-arena.mjs). Everything tiles, everything is deterministic
// (seeded), and every texture comes with a height field the caller turns into a normal map.
// A texture is { w, h, rgb: Float32Array (0..1, 3 per pixel), height: Float32Array (0..1) }.

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise on a `period` x `period` lattice, returned as a function of (u, v) in 0..1. */
function lattice(period, seed) {
  const r = rng(seed);
  const g = new Float32Array(period * period);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const s = (t) => t * t * (3 - 2 * t);
  return (u, v) => {
    const x = u * period, y = v * period;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = s(x - x0), fy = s(y - y0);
    const a = g[(y0 % period) * period + (x0 % period)], b = g[(y0 % period) * period + ((x0 + 1) % period)];
    const c = g[((y0 + 1) % period) * period + (x0 % period)], d = g[((y0 + 1) % period) * period + ((x0 + 1) % period)];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

/** fBm over tileable lattices: `base` cells across at the first octave. Optional stretch (sx, sy) for grain. */
export function fbm(w, h, { base = 4, octaves = 5, gain = 0.5, seed = 1, sx = 1, sy = 1 } = {}) {
  const layers = [];
  let amp = 1, tot = 0;
  for (let o = 0; o < octaves; o++) {
    layers.push({ n: lattice(Math.max(2, Math.round(base * 2 ** o)), seed * 131 + o * 17), amp });
    tot += amp;
    amp *= gain;
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (const l of layers) v += l.n(((x / w) * sx) % 1, ((y / h) * sy) % 1) * l.amp;
      out[y * w + x] = v / tot;
    }
  return out;
}

/** Tileable cellular noise: returns { f1, f2 } distances (in cell units) to the nearest two feature points. */
export function voronoi(w, h, cells, seed = 1, jitter = 0.9) {
  const r = rng(seed);
  const pts = new Float32Array(cells * cells * 2);
  for (let i = 0; i < cells * cells; i++) {
    pts[i * 2] = 0.5 + (r() - 0.5) * jitter;
    pts[i * 2 + 1] = 0.5 + (r() - 0.5) * jitter;
  }
  const f1 = new Float32Array(w * h), f2 = new Float32Array(w * h), id = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const px = (x / w) * cells, py = (y / h) * cells;
      const cx = Math.floor(px), cy = Math.floor(py);
      let a = 9, b = 9, who = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const gx = cx + dx, gy = cy + dy;
          const k = (((gy % cells) + cells) % cells) * cells + (((gx % cells) + cells) % cells);
          const d = Math.hypot(gx + pts[k * 2] - px, gy + pts[k * 2 + 1] - py);
          if (d < a) { b = a; a = d; who = k; } else if (d < b) b = d;
        }
      f1[y * w + x] = a;
      f2[y * w + x] = b;
      id[y * w + x] = (who * 0.61803398875) % 1;
    }
  return { f1, f2, id };
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const hex = (s) => [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255];
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function blank(w, h) {
  return { w, h, rgb: new Float32Array(w * h * 3), height: new Float32Array(w * h) };
}

/** A running-bond brick or block wall. rows x cols bricks per tile; every brick gets its own tint and a chipped, bevelled face. */
export function bricks(w, h, { rows = 6, cols = 3, bond = true, mortar = 0.06, colors = ['#8d8274', '#a89a86'], mortarColor = '#4a443c', variation = 0.18, seed = 1, grain = 0.12, extra } = {}) {
  const t = blank(w, h);
  const n1 = fbm(w, h, { base: 6, octaves: 5, seed });
  const n2 = fbm(w, h, { base: 24, octaves: 3, seed: seed + 5 });
  const r = rng(seed * 977);
  const tint = new Float32Array(rows * (cols + 1));
  for (let i = 0; i < tint.length; i++) tint[i] = r();
  const c0 = hex(colors[0]), c1 = hex(colors[1]), cm = hex(mortarColor);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = (y / h) * rows;
      const row = Math.floor(v);
      const off = bond && row % 2 ? 0.5 : 0;
      const u = (x / w) * cols + off;
      const col = Math.floor(u);
      const fu = u - col, fv = v - row;
      // distance to the nearest brick edge (in brick units)
      const e = Math.min(fu * (w / cols) , (1 - fu) * (w / cols), fv * (h / rows), (1 - fv) * (h / rows)) / (h / rows);
      const bevel = smooth(mortar, mortar + 0.07, e);
      const mort = smooth(mortar * 0.6, mortar, e);
      const k = tint[row * (cols + 1) + (((col % cols) + cols) % cols)];
      const i = y * w + x;
      const g = (n1[i] - 0.5) * grain * 2 + (n2[i] - 0.5) * grain;
      let col3 = mix(c0, c1, clamp01(k * 0.7 + n1[i] * 0.5 + (r() - 0.5) * 0.02));
      col3 = col3.map((c) => clamp01(c * (1 + (k - 0.5) * variation * 2 + g)));
      col3 = mix(cm, col3, mort);
      t.rgb.set(col3, i * 3);
      t.height[i] = mort * (0.5 + 0.5 * bevel) * (0.8 + 0.2 * n2[i]) * (0.88 + 0.12 * n1[i]);
    }
  extra?.(t, { n1, n2 });
  return t;
}

/** Irregular slabs (flagstones, cobbles, basalt plates) from cellular noise. */
export function slabs(w, h, { cells = 7, colors = ['#7d7a72', '#a39f93'], mortarColor = '#3b3833', mortar = 0.05, seed = 1, variation = 0.2, extra } = {}) {
  const t = blank(w, h);
  const v = voronoi(w, h, cells, seed, 0.85);
  const n1 = fbm(w, h, { base: 5, octaves: 5, seed: seed + 3 });
  const n2 = fbm(w, h, { base: 32, octaves: 3, seed: seed + 9 });
  const c0 = hex(colors[0]), c1 = hex(colors[1]), cm = hex(mortarColor);
  for (let i = 0; i < w * h; i++) {
    const edge = v.f2[i] - v.f1[i];
    const mort = smooth(mortar * 0.5, mortar + 0.02, edge);
    const bevel = smooth(mortar, mortar + 0.14, edge);
    let c = mix(c0, c1, clamp01(v.id[i] * 0.6 + n1[i] * 0.6));
    c = c.map((x) => clamp01(x * (1 + (v.id[i] - 0.5) * variation * 2 + (n2[i] - 0.5) * 0.25)));
    t.rgb.set(mix(cm, c, mort), i * 3);
    t.height[i] = mort * (0.55 + 0.45 * bevel) * (0.85 + 0.15 * n2[i]);
  }
  extra?.(t, { n1, n2, v });
  return t;
}

/** Wooden boards laid across the tile (`boards` rows), grain along x, a nail at each end. */
export function planks(w, h, { boards = 8, colors = ['#6a4a2c', '#9a7448'], gap = '#1f160e', seed = 1 } = {}) {
  const t = blank(w, h);
  const grainA = fbm(w, h, { base: 3, octaves: 5, seed, sx: 1, sy: 24 });
  const grainB = fbm(w, h, { base: 8, octaves: 3, seed: seed + 4, sx: 1, sy: 40 });
  const r = rng(seed * 31);
  const tint = Array.from({ length: boards }, () => r());
  const shift = Array.from({ length: boards }, () => r());
  const c0 = hex(colors[0]), c1 = hex(colors[1]), cg = hex(gap);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const b = Math.floor((y / h) * boards);
      const fv = (y / h) * boards - b;
      const i = y * w + x;
      const edge = Math.min(fv, 1 - fv);
      const g = smooth(0.012, 0.04, edge);
      const joint = Math.abs(((x / w + shift[b]) % 1) - 0.5) > 0.495 ? 0.45 : 1; // butt joints
      let c = mix(c0, c1, clamp01(tint[b] * 0.5 + grainA[i] * 0.7 + (grainB[i] - 0.5) * 0.35));
      c = c.map((v) => clamp01(v * (0.88 + 0.24 * grainB[i])));
      t.rgb.set(mix(cg, c, g * joint), i * 3);
      t.height[i] = g * joint * (0.7 + 0.3 * grainB[i]);
    }
  return t;
}

/** Plain noisy ground: dirt, sand, snow. */
export function ground(w, h, { colors = ['#8a7350', '#b79b72'], seed = 1, pebbles = 0, pebbleColor = '#5b5043', fine = 0.18, ridge = 0 } = {}) {
  const t = blank(w, h);
  const n1 = fbm(w, h, { base: 3, octaves: 6, seed });
  const n2 = fbm(w, h, { base: 64, octaves: 2, seed: seed + 11 });
  const c0 = hex(colors[0]), c1 = hex(colors[1]);
  const v = pebbles ? voronoi(w, h, pebbles, seed + 5, 0.95) : null;
  const pc = hex(pebbleColor);
  for (let i = 0; i < w * h; i++) {
    let c = mix(c0, c1, clamp01(n1[i] * 1.3 - 0.15));
    c = c.map((x) => clamp01(x * (1 + (n2[i] - 0.5) * fine * 2)));
    let hgt = n1[i] * 0.5 + n2[i] * 0.2;
    if (ridge) hgt += Math.abs(Math.sin((n1[i] * 9 + (i % w) / w * 3) * Math.PI)) * ridge * 0.25;
    if (v) {
      const pb = smooth(0.3, 0.15, v.f1[i]) * (v.id[i] > 0.55 ? 1 : 0);
      c = mix(c, c.map((x, k) => x * 0.55 + pc[k] * (0.5 + 0.5 * v.id[i])), pb * 0.8);
      hgt += pb * 0.45;
    }
    t.rgb.set(c, i * 3);
    t.height[i] = clamp01(hgt);
  }
  return t;
}

/** Blue-white ice with veined cracks. */
export function ice(w, h, { seed = 1, deep = '#4f8fc4', pale = '#d6efff' } = {}) {
  const t = blank(w, h);
  const n1 = fbm(w, h, { base: 3, octaves: 6, seed });
  const n2 = fbm(w, h, { base: 14, octaves: 4, seed: seed + 2 });
  const v = voronoi(w, h, 6, seed + 7, 0.9), v2 = voronoi(w, h, 14, seed + 8, 0.9);
  const cd = hex(deep), cp = hex(pale);
  for (let i = 0; i < w * h; i++) {
    const crack = smooth(0.06, 0.0, v.f2[i] - v.f1[i]) * 0.9 + smooth(0.04, 0.0, v2.f2[i] - v2.f1[i]) * 0.35;
    let c = mix(cd, cp, clamp01(n1[i] * 1.2 + (n2[i] - 0.5) * 0.4));
    c = mix(c, [0.93, 0.98, 1], clamp01(crack));
    t.rgb.set(c, i * 3);
    t.height[i] = clamp01(0.35 + n2[i] * 0.3 - crack * 0.5);
  }
  return t;
}

/** Overlay: moss (or frost / snow) settling in crevices and on ridges of an existing texture. */
export function overlay(t, { color = '#4d7a35', amount = 0.5, seed = 9, scale = 6, onlyLow = true, specks = 0.2 } = {}) {
  const n = fbm(t.w, t.h, { base: scale, octaves: 6, seed });
  const n2 = fbm(t.w, t.h, { base: 40, octaves: 2, seed: seed + 1 });
  const c = hex(color);
  for (let i = 0; i < t.w * t.h; i++) {
    const low = onlyLow ? 1 - t.height[i] : t.height[i];
    const m = smooth(1 - amount - 0.08, 1 - amount + 0.08, n[i] * 0.75 + low * 0.35 + (n2[i] - 0.5) * specks);
    const cc = c.map((v, k) => v * (0.7 + 0.6 * n2[i]) * (k === 1 ? 1 : 0.95));
    const o = i * 3;
    t.rgb[o] = lerp(t.rgb[o], cc[0], m);
    t.rgb[o + 1] = lerp(t.rgb[o + 1], cc[1], m);
    t.rgb[o + 2] = lerp(t.rgb[o + 2], cc[2], m);
    t.height[i] = clamp01(t.height[i] + m * (n2[i] - 0.4) * 0.12);
  }
  return t;
}

/** Tangent-space normal map (RGBA bytes, +Y up) from a height field; tiles. */
export function normalMap(height, w, h, strength = 3) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const g = (xx, yy) => height[((yy + h) % h) * w + ((xx + w) % w)];
      const dx = (g(x + 1, y - 1) + 2 * g(x + 1, y) + g(x + 1, y + 1)) - (g(x - 1, y - 1) + 2 * g(x - 1, y) + g(x - 1, y + 1));
      const dy = (g(x - 1, y + 1) + 2 * g(x, y + 1) + g(x + 1, y + 1)) - (g(x - 1, y - 1) + 2 * g(x, y - 1) + g(x + 1, y - 1));
      let nx = -dx * strength, ny = dy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const o = (y * w + x) * 4;
      out[o] = Math.round((nx * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
  return out;
}

/** Wrapped (tiling) box blur of one float channel, `passes` times (3 passes approximate a Gaussian). */
export function blurChannel(src, w, h, radius, passes = 3) {
  let a = Float32Array.from(src), b = new Float32Array(w * h);
  const win = radius * 2 + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += a[y * w + ((k + w) % w)];
      for (let x = 0; x < w; x++) {
        b[y * w + x] = acc / win;
        acc += a[y * w + ((x + radius + 1) % w)] - a[y * w + ((x - radius + w) % w)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += b[((k + h) % h) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc / win;
        acc += b[((y + radius + 1) % h) * w + x] - b[((y - radius + h) % h) * w + x];
      }
    }
  }
  return a;
}

/** Unsharp mask on RGBA bytes (wraps, so tiles stay seamless): sources that are only 256-512 px come out crisper when enlarged. */
export function sharpen(rgba, w, h, { amount = 0.9, radius = 2 } = {}) {
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) ch[i] = rgba[i * 4 + c];
    const bl = blurChannel(ch, w, h, radius);
    for (let i = 0; i < w * h; i++) rgba[i * 4 + c] = Math.max(0, Math.min(255, ch[i] + (ch[i] - bl[i]) * amount));
  }
  return rgba;
}

/**
 * A generated detail layer over a photo tile: brightness modulated by mid- and fine-scale noise (a different scale from the
 * photo's own features), so close-ups keep fine structure instead of going soft. Tiles.
 */
export function addDetail(rgba, w, h, { amount = 0.1, seed = 5, scale = 40 } = {}) {
  const mid = fbm(w, h, { base: scale, octaves: 3, seed, gain: 0.6 });
  const fine = fbm(w, h, { base: scale * 4, octaves: 2, seed: seed + 3, gain: 0.7 });
  for (let i = 0; i < w * h; i++) {
    const k = 1 + ((mid[i] - 0.5) * 0.9 + (fine[i] - 0.5) * 0.8) * amount * 2;
    rgba[i * 4] = Math.min(255, rgba[i * 4] * k);
    rgba[i * 4 + 1] = Math.min(255, rgba[i * 4 + 1] * k);
    rgba[i * 4 + 2] = Math.min(255, rgba[i * 4 + 2] * k);
  }
  return rgba;
}

/** Fine frost dusting: a thin rime on the raised parts, pale crystal specks and a few glints (no big blotches). */
export function frostDust(t, { color = '#eef5ff', amount = 0.5, seed = 9 } = {}) {
  const n = fbm(t.w, t.h, { base: 96, octaves: 3, seed, gain: 0.5 });
  const g = fbm(t.w, t.h, { base: 12, octaves: 2, seed: seed + 2 });
  const r = rng(seed * 7 + 1);
  const c = hex(color);
  for (let i = 0; i < t.w * t.h; i++) {
    // dust gathers on the brick faces' upper bevels (height) and where a slow gradient says so, but at a fine grain
    const cover = smooth(0.35, 0.8, t.height[i]) * (0.35 + 0.65 * g[i]);
    const rime = smooth(0.38, 0.74, n[i]) * cover;
    const speck = r() < 0.05 * amount ? 0.55 * (0.4 + 0.6 * r()) : 0;
    const m = clamp01(rime * amount * 0.6 + speck * (0.3 + cover));
    const o = i * 3;
    t.rgb[o] = lerp(t.rgb[o], c[0], m);
    t.rgb[o + 1] = lerp(t.rgb[o + 1], c[1], m);
    t.rgb[o + 2] = lerp(t.rgb[o + 2], c[2], m);
    t.height[i] = clamp01(t.height[i] + m * 0.05);
  }
  return t;
}

/** RGBA bytes from a texture. */
export function toRgba(t) {
  const out = new Uint8Array(t.w * t.h * 4);
  for (let i = 0; i < t.w * t.h; i++) {
    out[i * 4] = Math.round(clamp01(t.rgb[i * 3]) * 255);
    out[i * 4 + 1] = Math.round(clamp01(t.rgb[i * 3 + 1]) * 255);
    out[i * 4 + 2] = Math.round(clamp01(t.rgb[i * 3 + 2]) * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * Height field (0..1) of RGBA bytes for a normal map: the luminance, but mostly its high-pass (the relief, not the colour
 * patches) plus a little fine noise, so normal maps of enlarged photos carry crisp grain instead of a smeared bump.
 */
export function heightFromRgba(rgba, w, h, { hp = true, seed = 7, noise = 0.04 } = {}) {
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255;
  if (!hp) return out;
  const low = blurChannel(out, w, h, 7);
  const n = noise ? fbm(w, h, { base: 160, octaves: 2, seed, gain: 0.6 }) : null;
  for (let i = 0; i < w * h; i++) out[i] = clamp01(0.4 * out[i] + 0.6 * (0.5 + (out[i] - low[i]) * 1.8) + (n ? (n[i] - 0.5) * noise : 0));
  return out;
}

/**
 * Make a small photo texture crisp at a larger size: bicubic-ish resize (done by the caller), then seamless blend so it tiles,
 * and add fine grain modulated by the image so close-ups do not go soft. Works in place on RGBA bytes.
 */
export function addGrain(rgba, w, h, amount = 0.12, seed = 3) {
  const n = fbm(w, h, { base: 128, octaves: 2, seed, gain: 0.6 });
  const m = fbm(w, h, { base: 48, octaves: 2, seed: seed + 1 });
  for (let i = 0; i < w * h; i++) {
    const k = 1 + ((n[i] - 0.5) * 0.9 + (m[i] - 0.5) * 0.5) * amount * 2;
    rgba[i * 4] = Math.min(255, rgba[i * 4] * k);
    rgba[i * 4 + 1] = Math.min(255, rgba[i * 4 + 1] * k);
    rgba[i * 4 + 2] = Math.min(255, rgba[i * 4 + 2] * k);
  }
  return rgba;
}

/** Cross-fade the borders so an image tiles (blend each edge band with the opposite side). */
export function makeSeamless(rgba, w, h, band = 0.12) {
  const out = new Uint8Array(rgba);
  const bw = Math.floor(w * band), bh = Math.floor(h * band);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < bw; x++) {
      const t = 0.5 * (1 - x / bw); // 0.5 at the edge, 0 inside
      for (const [xa, xb] of [[x, w - 1 - x]]) {
        for (let c = 0; c < 3; c++) {
          const a = rgba[(y * w + xa) * 4 + c], b = rgba[(y * w + xb) * 4 + c];
          out[(y * w + xa) * 4 + c] = a * (1 - t) + b * t;
          out[(y * w + xb) * 4 + c] = b * (1 - t) + a * t;
        }
      }
    }
  const mid = new Uint8Array(out);
  for (let x = 0; x < w; x++)
    for (let y = 0; y < bh; y++) {
      const t = 0.5 * (1 - y / bh);
      for (let c = 0; c < 3; c++) {
        const a = mid[(y * w + x) * 4 + c], b = mid[((h - 1 - y) * w + x) * 4 + c];
        out[(y * w + x) * 4 + c] = a * (1 - t) + b * t;
        out[((h - 1 - y) * w + x) * 4 + c] = b * (1 - t) + a * t;
      }
    }
  return out;
}
