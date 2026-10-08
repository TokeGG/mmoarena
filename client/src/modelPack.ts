/**
 * Model files are not served as plain .glb files: the build scrambles them into .pak files that only the game knows how
 * to read, so a player cannot just download a model from the web server or the game folder and open it in a viewer.
 * This is a deterrent, not real protection: the key is in the game's code and the graphics card still receives the
 * meshes. It needs no browser features (works over plain http and inside a desktop wrapper), and the same code packs
 * (scripts/pack-models.ts) and unpacks.
 */
const MAGIC = [0x41, 0x52, 0x4e, 0x50]; // "ARNP"
const KEY = 'arena/model-pack/v1/' + [0x9e37, 0x79b9, 0x85eb, 0xca6b, 0xc2b2, 0xae35].map((n) => n.toString(36)).join('-');
const HEADER = 12;

/** A small fast generator (sfc32) seeded from the key: the same bytes come out of it on every machine. */
function keystream(): () => number {
  let a = 0x9e3779b9, b = 0x243f6a88, c = 0xb7e15162, d = 0x85ebca6b;
  for (let i = 0; i < KEY.length; i++) {
    const k = KEY.charCodeAt(i);
    a = Math.imul(a ^ k, 0x85ebca6b) >>> 0;
    b = Math.imul(b ^ (k << 3), 0xc2b2ae35) >>> 0;
    c = (c + Math.imul(a ^ b, 0x27d4eb2f)) >>> 0;
    d = (d ^ (c >>> 13)) >>> 0;
  }
  return () => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t;
  };
}

function checksum(data: Uint8Array): number {
  let s1 = 1, s2 = 0;
  for (let i = 0; i < data.length; i++) {
    s1 = (s1 + data[i]) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  return ((s2 << 16) | s1) >>> 0;
}

function scramble(data: Uint8Array, out: Uint8Array, offset: number) {
  const next = keystream();
  let word = 0;
  for (let i = 0; i < data.length; i++) {
    if ((i & 3) === 0) word = next();
    out[offset + i] = data[i] ^ ((word >>> ((i & 3) * 8)) & 0xff);
  }
}

/** Scramble a model file's bytes (used by the build script). */
export function packModel(plain: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER + plain.length);
  out.set(MAGIC, 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, plain.length, true);
  view.setUint32(8, checksum(plain), true);
  scramble(plain, out, HEADER);
  return out;
}

/** Undo packModel. Throws when the file is not a model pack or is damaged. */
export function unpackModel(pak: ArrayBuffer | Uint8Array): ArrayBuffer {
  const bytes = pak instanceof Uint8Array ? pak : new Uint8Array(pak);
  if (bytes.length < HEADER || MAGIC.some((m, i) => bytes[i] !== m)) throw new Error('not a model pack');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = view.getUint32(4, true);
  if (HEADER + len !== bytes.length) throw new Error('model pack is the wrong size');
  const plain = new Uint8Array(len);
  scramble(bytes.subarray(HEADER), plain, 0);
  if (checksum(plain) !== view.getUint32(8, true)) throw new Error('model pack is damaged');
  return plain.buffer;
}

/** The .pak next to a model's declared .glb url. */
export const packUrl = (glbUrl: string) => glbUrl.replace(/\.glb$/, '.pak');

/** Download and unscramble a model. */
export async function fetchModel(glbUrl: string): Promise<ArrayBuffer> {
  const r = await fetch(packUrl(glbUrl));
  if (!r.ok) throw new Error(`${packUrl(glbUrl)}: ${r.status}`);
  return unpackModel(await r.arrayBuffer());
}
