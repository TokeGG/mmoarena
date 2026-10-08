import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { MAX_SAMPLES, SamplePlayer } from '../src/samples';
import type { Fetcher, SampleContext } from '../src/samples';
import { SAMPLES } from '../src/sampleTable';
import type { SampleDef } from '../src/sampleTable';

/** A fake AudioContext that records what is started with which rate and gain. */
function fake() {
  const started: { buffer: unknown; rate: number; gain: number; dest: unknown }[] = [];
  const ended: (() => void)[] = [];
  const dest = {} as AudioNode;
  const ctx = {
    currentTime: 0,
    decodeAudioData: async (d: ArrayBuffer) => ({ duration: d.byteLength }) as unknown as AudioBuffer,
    createGain() {
      const g = { gain: { value: 1 }, connect: (n: unknown) => n, disconnect() {} };
      return g as unknown as GainNode;
    },
    createBufferSource() {
      const rec = { buffer: null as unknown, rate: 1, gain: 1, dest: null as unknown };
      let target: { gain: { value: number } } | null = null;
      const src = {
        set buffer(b: unknown) { rec.buffer = b; },
        playbackRate: { set value(v: number) { rec.rate = v; } },
        onended: null as null | (() => void),
        connect(g: { gain: { value: number }; connect(n: unknown): unknown }) { target = g; g.connect(dest); rec.dest = dest; return g; },
        start() { rec.gain = target?.gain.value ?? 1; started.push(rec); ended.push(() => src.onended?.()); },
      };
      return src as unknown as AudioBufferSourceNode;
    },
  };
  return { ctx: ctx as unknown as SampleContext, dest, started, ended };
}
const bytes = (n: number) => new ArrayBuffer(n);
const okFetch = (log: string[] = []): Fetcher => async (u) => {
  log.push(u);
  return { ok: true, arrayBuffer: async () => bytes(100) };
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const table = (extra: Partial<SampleDef> = {}): Record<string, SampleDef> => ({ boom: { files: ['a.mp3'], volume: 0.5, ...extra } });

test('not loaded: false, and the fetch starts once', async () => {
  const f = fake();
  const log: string[] = [];
  const p = new SamplePlayer(table(), okFetch(log), () => 0.5);
  assert.equal(p.play(f.ctx, f.dest, 'boom'), false);
  assert.equal(p.play(f.ctx, f.dest, 'boom'), false);
  assert.deepEqual(log, ['/audio/a.mp3']);
  await tick();
  assert.equal(p.ready('a.mp3'), true);
  assert.equal(p.play(f.ctx, f.dest, 'boom'), true);
  assert.equal(f.started.length, 1);
  assert.equal(log.length, 1);
});

test('unknown ids are not ours', () => {
  const f = fake();
  assert.equal(new SamplePlayer(table(), okFetch()).play(f.ctx, f.dest, 'nope'), false);
});

test('a missing or undecodable file falls back (false) and is not retried', async () => {
  const f = fake();
  let calls = 0;
  const p = new SamplePlayer(table(), async () => (calls++, { ok: false, arrayBuffer: async () => bytes(0) }));
  p.play(f.ctx, f.dest, 'boom');
  await tick();
  assert.equal(p.failed('a.mp3'), true);
  assert.equal(p.play(f.ctx, f.dest, 'boom'), false);
  assert.equal(calls, 1);
  const bad = fake();
  bad.ctx.decodeAudioData = async () => { throw new Error('EncodingError'); };
  const q = new SamplePlayer(table(), okFetch());
  q.play(bad.ctx, bad.dest, 'boom');
  await tick();
  assert.equal(q.play(bad.ctx, bad.dest, 'boom'), false);
  const thrown = new SamplePlayer(table(), async () => { throw new Error('offline'); });
  thrown.play(f.ctx, f.dest, 'boom');
  await tick();
  assert.equal(thrown.failed('a.mp3'), true);
});

test('the next file in the list is used when the first cannot be decoded', async () => {
  const f = fake();
  const log: string[] = [];
  const p = new SamplePlayer(table({ files: ['a.ogg', 'a.mp3'] }), async (u) => (log.push(u), { ok: !u.endsWith('.ogg'), arrayBuffer: async () => bytes(10) }), () => 0);
  p.play(f.ctx, f.dest, 'boom');
  await tick();
  assert.equal(p.play(f.ctx, f.dest, 'boom'), false); // starts loading the second
  await tick();
  assert.equal(p.play(f.ctx, f.dest, 'boom'), true);
  assert.deepEqual(log, ['/audio/a.ogg', '/audio/a.mp3']);
});

test('pitch, volume jitter and power stay inside their spreads', async () => {
  const f = fake();
  let r = 0;
  const p = new SamplePlayer(table({ rate: 0.8, pitchVar: 0.1, volVar: 0.2, powerGain: 1 }), okFetch(), () => r);
  p.preload(f.ctx); // not flagged: nothing loads
  p.play(f.ctx, f.dest, 'boom');
  await tick();
  for (const [x, rate, gain] of [[0, 0.72, 0.4 * 0.8], [1, 0.88, 0.6 * 0.8], [0.5, 0.8, 0.5 * 0.8]] as const) {
    r = x;
    p.play(f.ctx, f.dest, 'boom', { power: 0.8 });
    const s = f.started[f.started.length - 1];
    assert.ok(Math.abs(s.rate - rate) < 1e-9, `rate ${s.rate}`);
    assert.ok(Math.abs(s.gain - gain) < 1e-9, `gain ${s.gain}`);
    f.ended.pop()?.();
  }
});

test('variants are picked by the random source', async () => {
  const f = fake();
  const log: string[] = [];
  const p = new SamplePlayer(table({ variants: [['b.mp3']], preload: true }), okFetch(log), () => 0.99);
  p.preload(f.ctx);
  await tick();
  assert.deepEqual(log.sort(), ['/audio/a.mp3', '/audio/b.mp3']);
  p.play(f.ctx, f.dest, 'boom');
  assert.equal(f.started.length, 1);
});

test('at most MAX_SAMPLES at once, and the slot frees when a sample ends', async () => {
  const f = fake();
  const p = new SamplePlayer(table(), okFetch(), () => 0.5);
  p.play(f.ctx, f.dest, 'boom');
  await tick();
  for (let i = 0; i < MAX_SAMPLES; i++) assert.equal(p.play(f.ctx, f.dest, 'boom'), true);
  assert.equal(p.playing, MAX_SAMPLES);
  assert.equal(p.play(f.ctx, f.dest, 'boom'), false);
  f.ended[0]();
  f.ended[0]();
  assert.equal(p.playing, MAX_SAMPLES - 1, 'ending twice counts once');
  assert.equal(p.play(f.ctx, f.dest, 'boom'), true);
});

test('the shipped table points at real, small files and the fireball uses them', () => {
  for (const [id, d] of Object.entries(SAMPLES)) {
    assert.ok(d.volume > 0 && d.volume <= 1.4, id);
    for (const f of [...d.files, ...(d.variants ?? []).flat()]) {
      const path = new URL(`../public/audio/${f}`, import.meta.url);
      assert.ok(existsSync(path), `${id}: ${f} is missing`);
      assert.ok(statSync(path).size <= 60 * 1024, `${f} is over 60 KB`);
    }
  }
  assert.ok(SAMPLES['c-fireball'] && SAMPLES['hit-fireball'] && SAMPLES['c-pyroblast']);
  assert.ok(readFileSync(new URL('../public/audio/fireball-launch.mp3', import.meta.url)).length > 1000);
});
