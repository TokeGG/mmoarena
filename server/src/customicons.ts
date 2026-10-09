import { CUSTOM_ICON_SLUG, setCustomIcons, validPackId } from '@arena/shared';
import type { IconDef, IconPack } from '@arena/shared';
import type { AdminLog } from './adminlog';
import type { Store } from './store';

/**
 * Icon packs uploaded in the Icon edit window by the owner or a dev. They live in the server's store only (not in the
 * repository): each picture is kept as base64 WebP under `icon:<pack>/<name>`, each pack as a record under `iconpack:<pack>`, and
 * `iconpacks` lists the pack ids. The server serves them at /icons/<pack>/<name>.webp when the file is not in the static folder,
 * and lists them at GET /api/icons/custom. The library the server validates icon choices against (setCustomIcons) includes them.
 */
export const CUSTOM_LIMITS = {
  /** One 128x128 WebP. */
  iconBytes: 24 * 1024,
  /** All pictures of one upload. */
  uploadBytes: 4 * 1024 * 1024,
  /** Pictures in one upload. */
  perUpload: 400,
  packs: 20,
  icons: 2000,
};

interface PackRecord {
  id: string;
  name: string;
  license: string;
  by: string;
  at: number;
  icons: { slug: string; name: string; tags: string[] }[];
}

export interface CustomList {
  packs: { id: string; name: string; count: number; license: string }[];
  icons: { id: string; pack: string; name: string; file: string; tags: string[] }[];
}

export type CustomResult = { ok: true; pack: string; count: number } | { ok: false; status: number; text: string };

const INDEX = 'iconpacks';
const packKey = (id: string) => `iconpack:${id}`;
const iconKey = (pack: string, slug: string) => `icon:${pack}/${slug}`;

/** The width and height of a WebP file, or null when the bytes are not one (RIFF "WEBP" with a VP8, VP8L or VP8X chunk). */
export function webpSize(b: Buffer): { w: number; h: number } | null {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP' || b.readUInt32LE(4) + 8 !== b.length) return null;
  const kind = b.toString('latin1', 12, 16);
  if (kind === 'VP8X') return { w: (b.readUIntLE(24, 3) + 1), h: (b.readUIntLE(27, 3) + 1) };
  if (kind === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/** A readable name for the grid: markup and control characters out, 1 to 40 characters. */
export const cleanIconName = (s: unknown): string => String(s ?? '').replace(/[<>&/\\"'`\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
/** The file name part of an icon from its name. */
export const iconSlug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const prettyPack = (id: string) => id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

export class CustomIcons {
  private packs = new Map<string, PackRecord>();
  /** Resolves once the stored packs are read and added to the library. */
  ready: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private store: Store, private log?: AdminLog) {
    this.ready = this.load();
  }

  async load(): Promise<void> {
    try {
      const ids = JSON.parse((await this.store.get(INDEX)) ?? '[]') as unknown;
      const got = Array.isArray(ids) ? await this.store.mget(ids.filter(validPackId).map(packKey)) : [];
      this.packs.clear();
      for (const raw of got) {
        const r = raw ? (JSON.parse(raw) as PackRecord) : null;
        if (r && validPackId(r.id) && Array.isArray(r.icons)) this.packs.set(r.id, r);
      }
    } catch {
      // an unreadable store: no custom icons until it is back
    }
    this.apply();
  }

  /** The list the client merges into its library. */
  list(): CustomList {
    const packs: CustomList['packs'] = [];
    const icons: CustomList['icons'] = [];
    for (const p of this.packs.values()) {
      packs.push({ id: p.id, name: p.name, count: p.icons.length, license: p.license });
      for (const i of p.icons) icons.push({ id: `${p.id}/${i.slug}`, pack: p.id, name: i.name, file: `/icons/${p.id}/${i.slug}.webp`, tags: i.tags });
    }
    return { packs, icons };
  }

  private apply(): void {
    const l = this.list();
    setCustomIcons(l.packs as IconPack[], l.icons as IconDef[]);
  }

  private count = () => [...this.packs.values()].reduce((n, p) => n + p.icons.length, 0);

  /** The WebP bytes of a custom icon, or null. */
  async file(pack: string, slug: string): Promise<Buffer | null> {
    await this.ready;
    if (!validPackId(pack) || !CUSTOM_ICON_SLUG.test(slug) || !this.packs.get(pack)?.icons.some((i) => i.slug === slug)) return null;
    const raw = await this.store.get(iconKey(pack, slug));
    return raw ? Buffer.from(raw, 'base64') : null;
  }

  /** Add a new pack. `icons` carry a name and the base64 of a 128x128 WebP; everything is checked here, not trusted from the browser. */
  upload(by: string, body: unknown): Promise<CustomResult> {
    const run = this.chain.then(() => this.doUpload(by, body));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doUpload(by: string, body: unknown): Promise<CustomResult> {
    await this.ready;
    const fail = (status: number, text: string): CustomResult => ({ ok: false, status, text });
    const b = (body && typeof body === 'object' ? body : {}) as { pack?: unknown; icons?: unknown };
    if (!validPackId(b.pack)) return fail(400, 'The pack name needs 2 to 24 of a-z, 0-9 and dashes (not a built-in pack name).');
    const id = b.pack;
    if (this.packs.has(id)) return fail(409, `A custom pack called "${id}" already exists. Pick another name.`);
    if (this.packs.size >= CUSTOM_LIMITS.packs) return fail(400, `At most ${CUSTOM_LIMITS.packs} custom packs: delete one first.`);
    if (!Array.isArray(b.icons) || !b.icons.length) return fail(400, 'No pictures in that upload.');
    if (b.icons.length > CUSTOM_LIMITS.perUpload) return fail(400, `At most ${CUSTOM_LIMITS.perUpload} pictures per upload.`);
    if (this.count() + b.icons.length > CUSTOM_LIMITS.icons) return fail(400, `The server keeps at most ${CUSTOM_LIMITS.icons} custom icons.`);
    const used = new Set<string>();
    const rows: { slug: string; name: string; data: Buffer }[] = [];
    let total = 0;
    for (const raw of b.icons as unknown[]) {
      const r = (raw && typeof raw === 'object' ? raw : {}) as { name?: unknown; webp?: unknown };
      if (typeof r.webp !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(r.webp)) return fail(400, 'A picture is not base64.');
      const data = Buffer.from(r.webp, 'base64');
      const size = webpSize(data);
      if (!size) return fail(400, 'A picture is not a WebP file.');
      if (size.w !== 128 || size.h !== 128) return fail(400, 'Pictures must be 128 x 128.');
      if (data.length > CUSTOM_LIMITS.iconBytes) return fail(400, `A picture is over ${CUSTOM_LIMITS.iconBytes / 1024} KB.`);
      total += data.length;
      if (total > CUSTOM_LIMITS.uploadBytes) return fail(413, `That upload is over ${CUSTOM_LIMITS.uploadBytes / 1024 / 1024} MB.`);
      const name = cleanIconName(r.name) || `Icon ${rows.length + 1}`;
      let slug = iconSlug(name) || `icon-${rows.length + 1}`;
      for (let n = 2; used.has(slug); n++) slug = `${iconSlug(name).slice(0, 44) || 'icon'}-${n}`;
      used.add(slug);
      rows.push({ slug, name, data });
    }
    const rec: PackRecord = {
      id,
      name: prettyPack(id),
      license: `Uploaded by ${by}: licence unknown (custom icons live on this server only)`,
      by,
      at: Date.now(),
      icons: rows.map((r) => ({ slug: r.slug, name: r.name, tags: [id] })),
    };
    for (const r of rows) await this.store.set(iconKey(id, r.slug), r.data.toString('base64'));
    await this.store.set(packKey(id), JSON.stringify(rec));
    await this.store.set(INDEX, JSON.stringify([...this.packs.keys(), id]));
    this.packs.set(id, rec);
    this.apply();
    await this.log?.add(by, 'uploaded an icon pack', id, `${rows.length} icons, ${Math.round(total / 1024)} KB`);
    return { ok: true, pack: id, count: rows.length };
  }

  /** Delete a custom pack and its pictures. */
  remove(by: string, id: string): Promise<CustomResult> {
    const run = this.chain.then(async (): Promise<CustomResult> => {
      await this.ready;
      const rec = this.packs.get(id);
      if (!rec) return { ok: false, status: 404, text: 'No such custom pack.' };
      this.packs.delete(id);
      await this.store.set(INDEX, JSON.stringify([...this.packs.keys()]));
      await this.store.del(packKey(id));
      for (const i of rec.icons) await this.store.del(iconKey(id, i.slug));
      this.apply();
      await this.log?.add(by, 'deleted an icon pack', id, `${rec.icons.length} icons`);
      return { ok: true, pack: id, count: rec.icons.length };
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}
