import { CUSTOM_SOUND_LIMIT_BYTES } from '@arena/shared';
import type { AdminLog } from './adminlog';
import type { Store } from './store';

/**
 * Recordings uploaded on the Sounds page of the dev panel by the owner or a dev. They live in the server's store only (not in the
 * repository): each file is kept as base64 under `soundfile:<name>` and the list under `soundlist`. The server serves them at
 * /audio/custom/<name> (the client's sample player fetches /audio/<file>), and lists them at GET /api/sounds/custom.
 */
export interface SoundRecord { name: string; label: string; type: 'mp3' | 'ogg' | 'wav'; by: string; at: number }
export type SoundResult = { ok: true; file: string } | { ok: false; status: number; text: string };

const LIST = 'soundlist';
const MAX_FILES = 80;
const key = (name: string) => `soundfile:${name}`;
export const MIME: Record<SoundRecord['type'], string> = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav' };

/** What the bytes are, from their first bytes (the file name is not trusted). */
export function soundType(b: Buffer): SoundRecord['type'] | null {
  if (b.length < 12) return null;
  if (b.toString('latin1', 0, 4) === 'OggS') return 'ogg';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  return null;
}

const slug = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const cleanLabel = (s: string) => s.replace(/\.[a-z0-9]+$/i, '').replace(/[<>&/\\"'`\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Recording';

export class CustomSounds {
  private list: SoundRecord[] = [];
  ready: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private store: Store, private log?: AdminLog) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      const raw = JSON.parse((await this.store.get(LIST)) ?? '[]') as unknown;
      this.list = Array.isArray(raw) ? (raw as SoundRecord[]).filter((r) => r && typeof r.name === 'string' && /^[a-z0-9-]{1,48}$/.test(r.name) && r.type in MIME) : [];
    } catch {
      this.list = [];
    }
  }

  /** The list the client offers in every Recording menu. */
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

  add(by: string, body: unknown): Promise<SoundResult> {
    const run = this.chain.then(() => this.doAdd(by, body));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doAdd(by: string, body: unknown): Promise<SoundResult> {
    await this.ready;
    const b = body as { name?: unknown; data?: unknown } | null;
    if (!b || typeof b.name !== 'string' || typeof b.data !== 'string') return { ok: false, status: 400, text: 'That upload is not readable.' };
    if (this.list.length >= MAX_FILES) return { ok: false, status: 400, text: `There are already ${MAX_FILES} uploaded recordings. Delete some first.` };
    const buf = Buffer.from(b.data, 'base64');
    if (!buf.length || buf.length > CUSTOM_SOUND_LIMIT_BYTES) return { ok: false, status: 413, text: `A recording can be at most ${Math.round(CUSTOM_SOUND_LIMIT_BYTES / 1000)} KB.` };
    const type = soundType(buf);
    if (!type) return { ok: false, status: 400, text: 'That is not an mp3, ogg or wav recording.' };
    let name = slug(b.name) || 'recording';
    for (let n = 2; this.list.some((r) => r.name === name); n++) name = `${slug(b.name) || 'recording'}-${n}`.slice(0, 48);
    await this.store.set(key(name), buf.toString('base64'));
    this.list = [...this.list, { name, label: cleanLabel(b.name), type, by, at: Date.now() }];
    await this.store.set(LIST, JSON.stringify(this.list));
    void this.log?.add(by, 'uploaded a sound', name, `${cleanLabel(b.name)} (${Math.round(buf.length / 1000)} KB)`);
    return { ok: true, file: `custom/${name}.${type}` };
  }

  remove(by: string, file: string): Promise<SoundResult> {
    const run = this.chain.then(async (): Promise<SoundResult> => {
      await this.ready;
      const m = /^([a-z0-9-]{1,48})(?:\.(mp3|ogg|wav))?$/.exec(file);
      const r = m && this.list.find((x) => x.name === m[1]);
      if (!r) return { ok: false, status: 404, text: 'That recording is gone.' };
      this.list = this.list.filter((x) => x !== r);
      await this.store.del(key(r.name));
      await this.store.set(LIST, JSON.stringify(this.list));
      void this.log?.add(by, 'deleted a sound', r.name);
      return { ok: true, file: `custom/${r.name}.${r.type}` };
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}
