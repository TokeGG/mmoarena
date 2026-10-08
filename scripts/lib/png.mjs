// Minimal PNG decoder (8-bit, non-interlaced; greyscale, RGB, palette, grey+alpha, RGBA) and a box/bilinear resizer.
// Enough for texture bytes embedded in glTF files; uses only node:zlib.
import { inflateSync } from 'node:zlib';

/** Decode PNG bytes to { width, height, data: Uint8Array RGBA }. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  let plte = null, trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const d = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') [width, height, depth, ctype, interlace] = [d.readUInt32BE(0), d.readUInt32BE(4), d[8], d[9], d[12]];
    else if (type === 'PLTE') plte = d;
    else if (type === 'tRNS') trns = d;
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error(`unsupported PNG (depth ${depth}, interlace ${interlace})`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const stride = width * ch;
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[y * stride + x - ch] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= ch && y ? px[(y - 1) * stride + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * ch, o = i * 4;
    if (ctype === 0) out.set([px[s], px[s], px[s], 255], o);
    else if (ctype === 2) out.set([px[s], px[s + 1], px[s + 2], 255], o);
    else if (ctype === 3) out.set([plte[px[s] * 3], plte[px[s] * 3 + 1], plte[px[s] * 3 + 2], trns && px[s] < trns.length ? trns[px[s]] : 255], o);
    else if (ctype === 4) out.set([px[s], px[s], px[s], px[s + 1]], o);
    else out.set([px[s], px[s + 1], px[s + 2], px[s + 3]], o);
  }
  return { width, height, data: out };
}

/** Area-average downscale (or bilinear upscale) of an RGBA image to w x h. */
export function resize(img, w, h) {
  if (img.width === w && img.height === h) return img;
  const out = new Uint8Array(w * h * 4);
  const sx = img.width / w, sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = y * sy, y1 = Math.min(img.height, (y + 1) * sy);
    for (let x = 0; x < w; x++) {
      const x0 = x * sx, x1 = Math.min(img.width, (x + 1) * sx);
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wt = wy * (Math.min(xx + 1, x1) - Math.max(xx, x0));
          const i = (yy * img.width + xx) * 4;
          r += img.data[i] * wt; g += img.data[i + 1] * wt; b += img.data[i + 2] * wt; a += img.data[i + 3] * wt;
          wsum += wt;
        }
      }
      out.set([r / wsum, g / wsum, b / wsum, a / wsum], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data: out };
}
