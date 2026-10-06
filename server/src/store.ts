/**
 * Tiny key-value + sorted-set store behind accounts. Production uses Upstash Redis over its REST API (so nothing to
 * install on Render); without credentials it falls back to memory, which works but forgets everything on restart.
 */

export interface Store {
  readonly kind: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, exSeconds?: number): Promise<void>;
  /** Set only if the key does not exist. Returns whether it was set. */
  setNx(key: string, value: string): Promise<boolean>;
  del(key: string): Promise<void>;
  zadd(key: string, score: number, member: string): Promise<void>;
  /** Highest scores first. */
  ztop(key: string, count: number): Promise<{ member: string; score: number }[]>;
}

export class MemoryStore implements Store {
  readonly kind = 'memory';
  private kv = new Map<string, { v: string; exp: number }>();
  private z = new Map<string, Map<string, number>>();

  private live(key: string) {
    const e = this.kv.get(key);
    if (e && e.exp && e.exp < Date.now()) {
      this.kv.delete(key);
      return undefined;
    }
    return e;
  }
  async get(key: string) {
    return this.live(key)?.v ?? null;
  }
  async set(key: string, value: string, exSeconds?: number) {
    this.kv.set(key, { v: value, exp: exSeconds ? Date.now() + exSeconds * 1000 : 0 });
  }
  async setNx(key: string, value: string) {
    if (this.live(key)) return false;
    this.kv.set(key, { v: value, exp: 0 });
    return true;
  }
  async del(key: string) {
    this.kv.delete(key);
  }
  async zadd(key: string, score: number, member: string) {
    if (!this.z.has(key)) this.z.set(key, new Map());
    this.z.get(key)!.set(member, score);
  }
  async ztop(key: string, count: number) {
    return [...(this.z.get(key) ?? new Map<string, number>()).entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, count);
  }
}

export class UpstashStore implements Store {
  readonly kind = 'upstash';
  constructor(private url: string, private token: string) {}

  private async cmd(args: (string | number)[]): Promise<unknown> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!res.ok || body.error) throw new Error(`upstash: ${body.error ?? res.status}`);
    return body.result;
  }
  async get(key: string) {
    return ((await this.cmd(['GET', key])) as string | null) ?? null;
  }
  async set(key: string, value: string, exSeconds?: number) {
    await this.cmd(exSeconds ? ['SET', key, value, 'EX', exSeconds] : ['SET', key, value]);
  }
  async setNx(key: string, value: string) {
    return (await this.cmd(['SET', key, value, 'NX'])) === 'OK';
  }
  async del(key: string) {
    await this.cmd(['DEL', key]);
  }
  async zadd(key: string, score: number, member: string) {
    await this.cmd(['ZADD', key, score, member]);
  }
  async ztop(key: string, count: number) {
    const flat = ((await this.cmd(['ZREVRANGE', key, 0, count - 1, 'WITHSCORES'])) as string[]) ?? [];
    const out: { member: string; score: number }[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) out.push({ member: flat[i], score: Number(flat[i + 1]) });
    return out;
  }
}

/** Upstash credentials from the environment (both the Upstash and the Vercel-KV variable names work). */
export function createStore(env: NodeJS.ProcessEnv = process.env): Store {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) return new UpstashStore(url, token);
  return new MemoryStore();
}
