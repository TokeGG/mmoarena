import { CUSTOM_ICON_SLUG, ICON_PACKS, setCustomIcons, validPackId } from '@arena/shared';
import type { IconDef, IconPack } from '@arena/shared';

/**
 * Custom icon packs: an owner or dev drops images (or a zip of them) on the Icon edit window, the browser turns each into a
 * 128 x 128 WebP and uploads them to the server, which keeps them in its store (GET /api/icons/custom lists them, /icons/<pack>/<name>.webp
 * serves them). Everything here that needs no DOM (names, the zip reader, the file filter, merging the list into the library) is plain
 * functions so it can be tested; the browser parts (image decoding, the upload) are at the bottom.
 */

export const DROP_LIMITS = {
  /** All the bytes of one drop (a zip counts what it unpacks to). */
  totalBytes: 8 * 1024 * 1024,
  /** Pictures in one drop. */
  images: 400,
  /** One resized WebP. */
  iconBytes: 24 * 1024,
  /** All the WebP of one upload (the server's limit too). */
  uploadBytes: 4 * 1024 * 1024,
};

// ------------------------------------------------------------------ names

/** Why a pack name is not allowed, or null when it is. `taken` are the ids already in the library. */
export function packNameProblem(name: string, taken: Iterable<string> = ICON_PACKS.map((p) => p.id)): string | null {
  if (name.length < 2 || name.length > 24) return 'Use 2 to 24 characters.';
  if (!/^[a-z0-9-]+$/.test(name)) return 'Only a-z, 0-9 and dashes.';
  if (/^-|-$/.test(name)) return 'Do not start or end with a dash.';
  for (const t of taken) if (t === name) return 'There is a pack with that name already.';
  return validPackId(name) ? null : 'That name is not allowed.';
}

/** A pack name from a zip or folder name ("My Icons (v2).zip" -> "my-icons-v2"), made unique among `taken`. */
export function suggestPackName(raw: string, taken: Iterable<string> = ICON_PACKS.map((p) => p.id)): string {
  const used = new Set(taken);
  let base = raw.replace(/\.[a-z0-9]{1,5}$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20).replace(/-+$/, '');
  if (base.length < 2) base = 'my-icons';
  let name = base;
  for (let n = 2; used.has(name) || packNameProblem(name, []) !== null; n++) name = `${base}-${n}`;
  return name;
}

/** The display name of a picture from its file name ("fire_ball-2.png" -> "fire ball 2"). */
export const iconNameOf = (path: string): string => (path.split('/').pop() ?? path).replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'icon';

// ------------------------------------------------------------------ which files count

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
export const isImageName = (name: string): boolean => IMAGE_EXT.test(name);
export const isZipName = (name: string): boolean => /\.zip$/i.test(name);
/** Hidden files and the junk macOS leaves in zips: a path with a segment that starts with a dot, or __MACOSX. */
export const isHiddenPath = (path: string): boolean => path.split('/').some((s) => s.startsWith('.') || s === '__MACOSX');

export interface Filtered {
  /** The image paths to use, in order. */
  keep: string[];
  /** Skipped: not an image, hidden, or a folder. */
  skipped: number;
  /** A zip inside the drop (not opened). */
  nested: number;
  /** Images beyond the limit of one drop. */
  over: number;
}

/** Sort a list of dropped names or zip entries into the images to use and the rest. */
export function filterPaths(paths: readonly string[], limit = DROP_LIMITS.images): Filtered {
  const out: Filtered = { keep: [], skipped: 0, nested: 0, over: 0 };
  for (const p of paths) {
    if (p.endsWith('/') || isHiddenPath(p)) out.skipped += p.endsWith('/') ? 0 : 1;
    else if (isZipName(p)) out.nested++;
    else if (!isImageName(p)) out.skipped++;
    else if (out.keep.length >= limit) out.over++;
    else out.keep.push(p);
  }
  return out;
}

// ------------------------------------------------------------------ zip

export interface ZipEntry {
  name: string;
  /** 0 stored, 8 deflate. */
  method: number;
  size: number;
  compressed: number;
  offset: number;
  encrypted: boolean;
}

/** Read the central directory of a zip (not zip64). Throws a readable Error for anything that is not a plain zip. */
export function parseZipDirectory(b: Uint8Array): ZipEntry[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('That is not a zip file.');
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new Error('Zip64 files are not supported.');
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || v.getUint32(p, true) !== 0x02014b50) throw new Error('The zip is damaged.');
    const flags = v.getUint16(p + 8, true);
    const nameLen = v.getUint16(p + 28, true);
    const skip = nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    if (p + 46 + skip > b.length) throw new Error('The zip is damaged.');
    // names are UTF-8 when bit 11 is set, else CP437: close enough to latin1 for the file names that matter here
    const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'latin1').decode(b.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/');
    out.push({ name, method: v.getUint16(p + 10, true), compressed: v.getUint32(p + 20, true), size: v.getUint32(p + 24, true), offset: v.getUint32(p + 42, true), encrypted: !!(flags & 1) });
    p += 46 + skip;
  }
  return out;
}

/** The bytes of one entry (stored, or deflate through DecompressionStream). `max` stops a zip bomb. */
export async function readZipEntry(b: Uint8Array, e: ZipEntry, max = DROP_LIMITS.totalBytes): Promise<Uint8Array> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (e.offset + 30 > b.length || v.getUint32(e.offset, true) !== 0x04034b50) throw new Error('The zip is damaged.');
  const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
  if (e.size > max) throw new Error('A file in the zip is too big.');
  const raw = b.subarray(start, start + e.compressed);
  if (raw.length !== e.compressed) throw new Error('The zip is damaged.');
  if (e.method === 0) return raw.slice();
  if (e.method !== 8) throw new Error('The zip uses a compression this page cannot read.');
  const ds = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = ds.getReader();
  const parts: Uint8Array[] = [];
  let len = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    len += r.value.length;
    if (len > Math.min(max, e.size + 1)) {
      void reader.cancel();
      throw new Error('A file in the zip is bigger than it says.');
    }
    parts.push(r.value);
  }
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface Picture {
  /** The path inside the drop (zip path or file name). */
  path: string;
  bytes: Uint8Array;
}

export interface Unpacked {
  pictures: Picture[];
  skipped: number;
  nested: number;
  over: number;
  /** A zip's or folder's name (the default pack name), when there is one. */
  from: string;
  /** Why nothing was taken, when so. */
  error?: string;
}

/** Open a zip and take its images (nested zips are refused, hidden and non-image files skipped, at most `limits.images` of at most `limits.totalBytes`). */
export async function unzipImages(zip: Uint8Array, limits = DROP_LIMITS): Promise<Pick<Unpacked, 'pictures' | 'skipped' | 'nested' | 'over'>> {
  const dir = parseZipDirectory(zip);
  const usable = dir.filter((e) => !e.encrypted);
  const f = filterPaths(usable.map((e) => e.name), limits.images);
  const keep = new Set(f.keep);
  const pictures: Picture[] = [];
  let total = 0;
  let over = f.over;
  for (const e of usable) {
    if (!keep.has(e.name)) continue;
    total += e.size;
    if (total > limits.totalBytes) {
      over++;
      continue;
    }
    pictures.push({ path: e.name, bytes: await readZipEntry(zip, e, limits.totalBytes) });
  }
  return { pictures, skipped: f.skipped + (dir.length - usable.length), nested: f.nested, over };
}

// ------------------------------------------------------------------ the library

export interface CustomList {
  packs: { id: string; name: string; count: number; license: string }[];
  icons: { id: string; pack: string; name: string; file: string; tags: string[] }[];
}

/** The server's answer as far as it is well formed (anything else is left out). */
export function parseCustomList(j: unknown): CustomList {
  const o = (j && typeof j === 'object' ? j : {}) as { packs?: unknown; icons?: unknown };
  const str = (x: unknown) => (typeof x === 'string' ? x : '');
  const packs: CustomList['packs'] = [];
  const icons: CustomList['icons'] = [];
  for (const p of Array.isArray(o.packs) ? (o.packs as Record<string, unknown>[]) : []) if (p && validPackId(p.id)) packs.push({ id: p.id, name: str(p.name) || p.id, count: Number(p.count) || 0, license: str(p.license) });
  const ok = new Set(packs.map((p) => p.id));
  for (const i of Array.isArray(o.icons) ? (o.icons as Record<string, unknown>[]) : []) {
    if (!i || typeof i.id !== 'string' || typeof i.pack !== 'string' || !ok.has(i.pack) || !i.id.startsWith(`${i.pack}/`) || !CUSTOM_ICON_SLUG.test(i.id.slice(i.pack.length + 1))) continue;
    icons.push({ id: i.id, pack: i.pack, name: str(i.name) || i.id, file: `/icons/${i.id}.webp`, tags: Array.isArray(i.tags) ? i.tags.filter((t): t is string => typeof t === 'string') : [] });
  }
  return { packs, icons };
}

/** Put the custom packs into the library (the grid, the search, the chips and validation all read it). */
export function mergeCustom(list: CustomList): void {
  setCustomIcons(list.packs as IconPack[], list.icons as IconDef[]);
}

/** How many custom icons the library has now (to see whether a load changed anything). */
let loadedIcons = 0;
export const customLoaded = (): number => loadedIcons;

/** Ask the server for its custom packs and merge them in; resolves to whether the library changed. A failed request leaves it as it was. */
export async function loadCustomIcons(): Promise<boolean> {
  try {
    const r = await fetch('/api/icons/custom', { cache: 'no-store' });
    if (!r.ok) return false;
    const list = parseCustomList(await r.json());
    const before = JSON.stringify(ICON_PACKS.filter((p) => p.custom).map((p) => [p.id, p.count]));
    mergeCustom(list);
    loadedIcons = list.icons.length;
    return before !== JSON.stringify(ICON_PACKS.filter((p) => p.custom).map((p) => [p.id, p.count]));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ browser: pictures in, WebP out, upload

const sessionToken = (): string => {
  try {
    return localStorage.getItem('arena.session.v1') ?? ''; // accountUi.ts SESSION_KEY
  } catch {
    return '';
  }
};

/** Square centre-crop to 128 x 128 and encode as WebP, lowering the quality until it fits `DROP_LIMITS.iconBytes`. A GIF gives its first frame. */
export async function toWebp128(bytes: Uint8Array, path: string): Promise<Uint8Array | null> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: path.toLowerCase().endsWith('.png') ? 'image/png' : '' }));
  } catch {
    return null;
  }
  const s = Math.min(bmp.width, bmp.height);
  if (!s) return null;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 128, 128);
  bmp.close();
  for (const q of [0.88, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]) {
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/webp', q));
    if (!blob || blob.type !== 'image/webp') return null; // this browser cannot write WebP
    if (blob.size <= DROP_LIMITS.iconBytes) return new Uint8Array(await blob.arrayBuffer());
  }
  return null;
}

export const toBase64 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

export interface Staged {
  from: string;
  icons: { name: string; webp: Uint8Array }[];
  notes: string[];
}

/** Read what was dropped (images, a zip, or a folder's files) and make the 128 x 128 WebP of each. Notes say what was skipped. */
export async function stageFiles(files: { file: File; path: string }[], progress?: (done: number, of: number) => void): Promise<Staged> {
  const notes: string[] = [];
  const pics: Picture[] = [];
  let from = '';
  let total = 0;
  let skipped = 0;
  let nested = 0;
  let over = 0;
  const zips = files.filter((f) => isZipName(f.path));
  if (zips.length > 1) notes.push('Only the first zip was opened.');
  const plain = filterPaths(files.filter((f) => !isZipName(f.path)).map((f) => f.path));
  skipped += plain.skipped;
  nested += plain.nested;
  over += plain.over;
  if (zips[0]) {
    if (zips[0].file.size > DROP_LIMITS.totalBytes) throw new Error('That zip is over 8 MB.');
    from = zips[0].file.name;
    try {
      const z = await unzipImages(new Uint8Array(await zips[0].file.arrayBuffer()));
      pics.push(...z.pictures);
      skipped += z.skipped;
      nested += z.nested;
      over += z.over;
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : 'Could not open that zip.');
    }
  }
  const keep = new Set(plain.keep);
  for (const f of files) {
    if (!keep.has(f.path)) continue;
    total += f.file.size;
    if (total > DROP_LIMITS.totalBytes || pics.length >= DROP_LIMITS.images) {
      over++;
      continue;
    }
    pics.push({ path: f.path, bytes: new Uint8Array(await f.file.arrayBuffer()) });
  }
  if (!from) from = files.find((f) => f.path.includes('/'))?.path.split('/')[0] ?? (files.length === 1 ? files[0].file.name : '');
  const icons: Staged['icons'] = [];
  let failed = 0;
  let bytes = 0;
  for (const [i, p] of pics.entries()) {
    progress?.(i, pics.length);
    const w = await toWebp128(p.bytes, p.path);
    if (!w) failed++;
    else if (bytes + w.length > DROP_LIMITS.uploadBytes) over++;
    else {
      bytes += w.length;
      icons.push({ name: iconNameOf(p.path), webp: w });
    }
  }
  if (nested) notes.push(`${nested} zip${nested === 1 ? '' : 's'} inside the drop ${nested === 1 ? 'was' : 'were'} not opened.`);
  if (skipped) notes.push(`${skipped} file${skipped === 1 ? '' : 's'} skipped (not images, or hidden).`);
  if (failed) notes.push(`${failed} image${failed === 1 ? '' : 's'} could not be read.`);
  if (over) notes.push(`${over} image${over === 1 ? '' : 's'} left out (limits: ${DROP_LIMITS.images} images, 8 MB, 4 MB of icons).`);
  return { from, icons, notes };
}

export type UploadResult = { ok: true; count: number } | { ok: false; text: string };

/** Send a staged pack to the server (owner or dev). */
export async function uploadPack(pack: string, icons: Staged['icons']): Promise<UploadResult> {
  try {
    const r = await fetch('/api/icons/custom', { method: 'POST', headers: { authorization: `Bearer ${sessionToken()}`, 'content-type': 'application/json' }, body: JSON.stringify({ pack, icons: icons.map((i) => ({ name: i.name, webp: toBase64(i.webp) })) }) });
    const j = (await r.json().catch(() => ({}))) as { count?: number; text?: string };
    return r.ok ? { ok: true, count: j.count ?? icons.length } : { ok: false, text: j.text ?? `The server said ${r.status}.` };
  } catch {
    return { ok: false, text: 'Could not reach the server.' };
  }
}

/** Delete a custom pack (owner only: the server checks). */
export async function deletePack(pack: string): Promise<UploadResult> {
  try {
    const r = await fetch(`/api/icons/custom/${encodeURIComponent(pack)}`, { method: 'DELETE', headers: { authorization: `Bearer ${sessionToken()}` } });
    const j = (await r.json().catch(() => ({}))) as { count?: number; text?: string };
    return r.ok ? { ok: true, count: j.count ?? 0 } : { ok: false, text: j.text ?? `The server said ${r.status}.` };
  } catch {
    return { ok: false, text: 'Could not reach the server.' };
  }
}

/** The files of a drop, with folders opened (webkitGetAsEntry): each with its path below the dropped folder. */
export async function filesOfDrop(dt: DataTransfer): Promise<{ file: File; path: string }[]> {
  const out: { file: File; path: string }[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (out.length > DROP_LIMITS.images * 3) return;
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  const entries = [...dt.items].map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() ?? null : null));
  if (entries.some(Boolean)) {
    for (const e of entries) if (e) await walk(e, '');
    return out;
  }
  return [...dt.files].map((file) => ({ file, path: file.name }));
}
