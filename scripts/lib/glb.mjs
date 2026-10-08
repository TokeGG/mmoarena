// Minimal GLB (glTF 2.0 binary) reader and writer for the character rigging pipeline. No dependencies.
import { readFileSync, writeFileSync } from 'node:fs';

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const TYPE_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Parse a GLB into { json, bin }. */
export function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB file');
  let off = 12;
  let json;
  let bin;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len;
  }
  return { json, bin };
}

/** Read an accessor as a typed array (copied, de-interleaved) plus its component count. */
export function readAccessor({ json, bin }, index) {
  const acc = json.accessors[index];
  const view = json.bufferViews[acc.bufferView];
  const Arr = COMPONENT[acc.componentType];
  const n = TYPE_SIZE[acc.type];
  const stride = view.byteStride || n * Arr.BYTES_PER_ELEMENT;
  const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const out = new Arr(acc.count * n);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const get = { 5126: 'getFloat32', 5125: 'getUint32', 5123: 'getUint16', 5121: 'getUint8', 5122: 'getInt16', 5120: 'getInt8' }[acc.componentType];
  for (let i = 0; i < acc.count; i++) for (let k = 0; k < n; k++) out[i * n + k] = dv[get](base + i * stride + k * Arr.BYTES_PER_ELEMENT, true);
  return { data: out, n, count: acc.count, normalized: !!acc.normalized };
}

export function readGlbFile(path) {
  return parseGlb(readFileSync(path));
}

/**
 * Incremental GLB writer: add typed arrays as buffer views/accessors, then `build()` the file.
 * Returned indices go straight into the JSON you assemble.
 */
export class GlbWriter {
  constructor() {
    this.chunks = [];
    this.size = 0;
    this.bufferViews = [];
    this.accessors = [];
  }
  _view(bytes, target) {
    const pad = (4 - (this.size % 4)) % 4;
    if (pad) {
      this.chunks.push(Buffer.alloc(pad));
      this.size += pad;
    }
    const view = { buffer: 0, byteOffset: this.size, byteLength: bytes.length };
    if (target) view.target = target;
    this.chunks.push(bytes);
    this.size += bytes.length;
    this.bufferViews.push(view);
    return this.bufferViews.length - 1;
  }
  /** Raw bytes in a buffer view (images). */
  addBytes(bytes) {
    return this._view(Buffer.from(bytes));
  }
  /** A typed array as an accessor. `type` is SCALAR/VEC2/VEC3/VEC4/MAT4. */
  addAccessor(arr, type, { target, normalized, minmax } = {}) {
    const ct = Object.entries(COMPONENT).find(([, A]) => arr instanceof A)[0];
    const view = this._view(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength), target);
    const n = TYPE_SIZE[type];
    const acc = { bufferView: view, componentType: +ct, count: arr.length / n, type };
    if (normalized) acc.normalized = true;
    if (minmax) {
      const min = new Array(n).fill(Infinity);
      const max = new Array(n).fill(-Infinity);
      for (let i = 0; i < arr.length; i++) {
        min[i % n] = Math.min(min[i % n], arr[i]);
        max[i % n] = Math.max(max[i % n], arr[i]);
      }
      acc.min = min;
      acc.max = max;
    }
    this.accessors.push(acc);
    return this.accessors.length - 1;
  }
  /** Assemble the final GLB; `json` is your glTF object (this fills in buffers, bufferViews and accessors). */
  build(json) {
    json.buffers = [{ byteLength: this.size }];
    json.bufferViews = this.bufferViews;
    json.accessors = this.accessors;
    let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
    jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
    let bin = Buffer.concat(this.chunks);
    bin = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
    const total = 12 + 8 + jsonBuf.length + 8 + bin.length;
    const head = Buffer.alloc(12);
    head.writeUInt32LE(0x46546c67, 0);
    head.writeUInt32LE(2, 4);
    head.writeUInt32LE(total, 8);
    const ch = (len, type) => {
      const b = Buffer.alloc(8);
      b.writeUInt32LE(len, 0);
      b.writeUInt32LE(type, 4);
      return b;
    };
    return Buffer.concat([head, ch(jsonBuf.length, 0x4e4f534a), jsonBuf, ch(bin.length, 0x004e4942), bin]);
  }
}

export const writeFile = writeFileSync;
