import { CUSTOM_MODEL_LIMIT_BYTES } from '@arena/shared';
import type { AdminLog } from './adminlog';
import type { Store } from './store';

/**
 * Models uploaded on the Sounds page of the dev panel by the owner or a dev. They live in the server's store only (not in the
 * repository): each file is kept as base64 under `modelfile:<name>` and the list under `modellist`. The server serves them at
 * /models/custom/<name> (the client's loader fetches /models/<file>), and lists them at GET /api/sounds/custom.
 */
export interface ModelRecord { name: string; label: string; type: 'glb'; by: string; at: number }
export type ModelResult = { ok: true; file: string } | { ok: false; status: number; text: string };

const LIST = 'modellist';
const MAX_FILES = 40;
const key = (name: string) => `modelfile:${name}`;
export const MIME: Record<ModelRecord['type'], string> = { glb: 'model/gltf-binary' };

/** A binary glTF starts with "glTF" and version 2 (the file name is not trusted). */
export function modelType(b: Buffer): ModelRecord['type'] | null {
  return b.length > 20 && b.toString('latin1', 0, 4) === 'glTF' && b.readUInt32LE(4) === 2 ? 'glb' : null;
}

const slug = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const cleanLabel = (s: string) => s.replace(/\.[a-z0-9]+$/i, '').replace(/[<>&/\\"'`\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Model';

export class CustomModels {
  private list: ModelRecord[] = [];
  ready: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private store: Store, private log?: AdminLog) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      const raw = JSON.parse((await this.store.get(LIST)) ?? '[]') as unknown;
      this.list = Array.isArray(raw) ? (raw as ModelRecord[]).filter((r) => r && typeof r.name === 'string' && /^[a-z0-9-]{1,48}$/.test(r.name) && r.type in MIME) : [];
    } catch {
      this.list = [];
    }
  }

  /** The list the client offers in every Model menu. */
  async files(): Promise<{ file: string; label: string }[]> {
    await this.ready;
    return this.list.map((r) => ({ file: `custom/${r.name}.${r.type}`, label: r.label }));
  }

  async file(name: string, ext: string): Promise<{ buf: Buffer; mime: string } | null> {
    await this.ready;
    const r = this.list.find((x) => x.name === name && x.type === ext);
    if (!r) return null;
    const raw = await this.store.get(key(name));
    return raw ? { buf: Buffer.from(raw, 'base64'), mime: MIME[r.type] } : null;
  }

  add(by: string, body: unknown): Promise<ModelResult> {
    const run = this.chain.then(() => this.doAdd(by, body));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doAdd(by: string, body: unknown): Promise<ModelResult> {
    await this.ready;
    const b = body as { name?: unknown; data?: unknown } | null;
    if (!b || typeof b.name !== 'string' || typeof b.data !== 'string') return { ok: false, status: 400, text: 'That upload is not readable.' };
    if (this.list.length >= MAX_FILES) return { ok: false, status: 400, text: `There are already ${MAX_FILES} uploaded models. Delete some first.` };
    const buf = Buffer.from(b.data, 'base64');
    if (!buf.length || buf.length > CUSTOM_MODEL_LIMIT_BYTES) return { ok: false, status: 413, text: `A model can be at most ${Math.round(CUSTOM_MODEL_LIMIT_BYTES / 1000)} KB.` };
    const type = modelType(buf);
    if (!type) return { ok: false, status: 400, text: 'That is not a .glb model (a binary glTF 2.0 file).' };
    let name = slug(b.name) || 'model';
    for (let n = 2; this.list.some((r) => r.name === name); n++) name = `${slug(b.name) || 'model'}-${n}`.slice(0, 48);
    await this.store.set(key(name), buf.toString('base64'));
    this.list = [...this.list, { name, label: cleanLabel(b.name), type, by, at: Date.now() }];
    await this.store.set(LIST, JSON.stringify(this.list));
    void this.log?.add(by, 'uploaded a model', name, `${cleanLabel(b.name)} (${Math.round(buf.length / 1000)} KB)`);
    return { ok: true, file: `custom/${name}.${type}` };
  }

  remove(by: string, file: string): Promise<ModelResult> {
    const run = this.chain.then(async (): Promise<ModelResult> => {
      await this.ready;
      const m = /^([a-z0-9-]{1,48})(?:\.(glb))?$/.exec(file);
      const r = m && this.list.find((x) => x.name === m[1]);
      if (!r) return { ok: false, status: 404, text: 'That model is gone.' };
      this.list = this.list.filter((x) => x !== r);
      await this.store.del(key(r.name));
      await this.store.set(LIST, JSON.stringify(this.list));
      void this.log?.add(by, 'deleted a model', r.name);
      return { ok: true, file: `custom/${r.name}.${r.type}` };
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}
