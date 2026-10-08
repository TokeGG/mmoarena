import { SAMPLES } from './sampleTable';
import type { SampleDef } from './sampleTable';

/**
 * A small sample player for recorded sounds. The audio engine asks it to play an id; it fetches and decodes the file
 * the first time it is needed (or after unlock for `preload` entries), never blocks anything, and says `false` when it
 * has nothing to play yet (still loading, missing, undecodable, too many samples playing) so the caller plays the
 * synthesised recipe instead. It knows nothing about the page: the context, `fetch` and the random source are
 * parameters, so tests run it with fakes.
 */

/** The little part of the Web Audio API the player uses (so tests can fake it). */
export interface SampleContext {
  currentTime: number;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
  createBufferSource(): AudioBufferSourceNode;
  createGain(): GainNode;
}
export type Fetcher = (url: string) => Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }>;

export const SAMPLE_DIR = '/audio/';
/** Most samples that may sound at once; further requests fall back to the recipe (or stay silent for a layered one). */
export const MAX_SAMPLES = 8;

type State = { s: 'loading' } | { s: 'ready'; buf: AudioBuffer } | { s: 'failed' };

export interface PlayOpts {
  /** The recipe's power, 0.4..1.4. */
  power?: number;
  /** Extra gain on top of the sample's own volume. */
  vol?: number;
}

export class SamplePlayer {
  private cache = new Map<string, State>();
  private active = 0;

  constructor(
    private table: Record<string, SampleDef> = SAMPLES,
    private fetcher: Fetcher = (u) => fetch(u),
    private rnd: () => number = Math.random,
    private dir = SAMPLE_DIR,
  ) {}

  /** How many samples are sounding right now. */
  get playing(): number {
    return this.active;
  }
  has(id: string): boolean {
    return id in this.table;
  }
  /** Is this file decoded and ready? */
  ready(file: string): boolean {
    return this.cache.get(file)?.s === 'ready';
  }
  failed(file: string): boolean {
    return this.cache.get(file)?.s === 'failed';
  }

  /** Fetch + decode a file once. Never throws; a failure is remembered so it is not retried. */
  load(ctx: SampleContext, file: string): void {
    if (this.cache.has(file)) return;
    this.cache.set(file, { s: 'loading' });
    void (async () => {
      try {
        const r = await this.fetcher(this.dir + file);
        if (!r.ok) throw new Error('missing');
        const buf = await ctx.decodeAudioData(await r.arrayBuffer());
        this.cache.set(file, { s: 'ready', buf });
      } catch {
        this.cache.set(file, { s: 'failed' });
      }
    })();
  }

  /** Start loading every `preload` entry (call once the audio engine is unlocked). */
  preload(ctx: SampleContext): void {
    for (const def of Object.values(this.table)) if (def.preload) for (const files of [def.files, ...(def.variants ?? [])]) this.load(ctx, files[0]); // later entries of a list are only fallbacks
  }

  private pickFiles(def: SampleDef, r: number): string[] {
    const all = [def.files, ...(def.variants ?? [])];
    return all[Math.min(all.length - 1, Math.floor(r * all.length))];
  }

  /**
   * Plays the sample for `id` through `dest` (the engine's positional output). True: started, the recipe is not needed
   * (unless the entry is `layer`, which the caller reads from `layered(id)`). False: nothing played, use the recipe.
   */
  play(ctx: SampleContext, dest: AudioNode, id: string, o: PlayOpts = {}): boolean {
    const def = this.table[id];
    if (!def) return false;
    const files = this.pickFiles(def, this.rnd());
    // the first file the browser has decoded; start loading the rest of the list only if an earlier one failed
    let buf: AudioBuffer | null = null;
    for (const f of files) {
      const st = this.cache.get(f);
      if (!st) {
        this.load(ctx, f);
        return false;
      }
      if (st.s === 'ready') {
        buf = st.buf;
        break;
      }
      if (st.s === 'loading') return false;
    }
    if (!buf || this.active >= MAX_SAMPLES) return false;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const jit = (v: number | undefined) => 1 + ((this.rnd() * 2 - 1) * (v ?? 0));
    src.playbackRate.value = Math.max(0.25, (def.rate ?? 1) * jit(def.pitchVar));
    const g = ctx.createGain();
    const pw = def.powerGain ?? 0;
    const power = Math.max(0.4, Math.min(1.4, o.power ?? 1));
    g.gain.value = def.volume * jit(def.volVar) * (1 + (power - 1) * pw) * (o.vol ?? 1);
    src.connect(g).connect(dest);
    this.active++;
    let done = false;
    src.onended = () => {
      if (done) return;
      done = true;
      this.active--;
      try {
        g.disconnect();
      } catch {
        /* already gone */
      }
    };
    src.start();
    return true;
  }

  /** Should the recipe play too when the sample did (a layered entry)? */
  layered(id: string): boolean {
    return !!this.table[id]?.layer;
  }
}
