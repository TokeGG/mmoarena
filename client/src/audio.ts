import { ABILITIES, AURAS } from '@arena/shared';
import type { School, SimEvent } from '@arena/shared';
import { ACTION_VOICE, STEP_SURFACE, castVoice, hitVoice, startVoice } from './voices';
import type { Recipe } from './voices';
import { SamplePlayer } from './samples';

/**
 * All sound is synthesised here with the Web Audio API (no audio files to ship or license).
 * Every sound is a small recipe of oscillators and filtered noise; positional sounds are panned and attenuated by where
 * the source is relative to the camera. The engine stays silent until the first click or key press (browser rule).
 */

type Bus = 'sfx' | 'amb';
export interface Spatial {
  /** 0..1 loudness from distance (and who is involved). */
  gain: number;
  /** -1 (left) .. 1 (right). */
  pan: number;
}
const NEAR: Spatial = { gain: 1, pan: 0 };

const KEY = { master: 'arena.vol.master', sfx: 'arena.vol.sfx', amb: 'arena.vol.amb', mute: 'arena.vol.mute' } as const;
const DEFAULTS = { master: 0.7, sfx: 1, amb: 0.5 };

const read = (k: string): string => {
  try {
    return localStorage.getItem(k) ?? '';
  } catch {
    return '';
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
};
const num = (k: string, d: number) => {
  const v = read(k);
  const n = v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d;
};

interface ToneOpts {
  f: number;
  to?: number;
  type?: OscillatorType;
  a?: number;
  d: number;
  vol?: number;
  delay?: number;
  detune?: number;
  /** Optional low-pass for darker tones. */
  lp?: number;
}
interface NoiseOpts {
  d: number;
  f: number;
  to?: number;
  q?: number;
  type?: BiquadFilterType;
  a?: number;
  vol?: number;
  delay?: number;
}

export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private buses!: Record<Bus, GainNode>;
  private noiseBuf!: AudioBuffer;
  private vol = { master: num(KEY.master, DEFAULTS.master), sfx: num(KEY.sfx, DEFAULTS.sfx), amb: num(KEY.amb, DEFAULTS.amb) };
  private muted = read(KEY.mute) === '1';
  private last = new Map<string, number>();
  /** Recorded sounds (sampleTable.ts) that take over from a recipe of the same id once they are loaded. */
  private samples = new SamplePlayer();
  private ambNodes: { stop(): void }[] = [];
  private ambTimers: number[] = [];
  private theme = '';
  onMute: (muted: boolean) => void = () => {};

  constructor() {
    const unlock = () => {
      this.ensure();
      if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') void this.ctx.resume();
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
    // iPhone Safari only lets audio start from the end of a tap (touchend or click), not from the first touch
    window.addEventListener('touchend', unlock, { passive: true });
    window.addEventListener('click', unlock, { passive: true });
    // every button in the interface gets a click sound
    document.addEventListener(
      'click',
      (e) => {
        const t = e.target as HTMLElement | null;
        if (t?.closest('button, .opt, .mm-spec, .mm-slot, .live-row')) this.ui('click');
      },
      true,
    );
  }

  get volumes() {
    return { ...this.vol };
  }
  get isMuted() {
    return this.muted;
  }

  setVolume(kind: keyof typeof DEFAULTS, v: number) {
    this.vol[kind] = Math.min(1, Math.max(0, v));
    write(KEY[kind], String(this.vol[kind]));
    this.applyVolumes();
  }

  setMuted(m: boolean) {
    this.muted = m;
    write(KEY.mute, m ? '1' : '0');
    this.applyVolumes();
    this.onMute(m);
  }

  private applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.vol.master, t, 0.03);
    // the recipes are written quietly so layers never clip; these make the sliders' full range a comfortable level
    this.buses.sfx.gain.setTargetAtTime(this.vol.sfx * 2.6, t, 0.03);
    this.buses.amb.gain.setTargetAtTime(this.vol.amb * 2.2, t, 0.03);
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    this.master = ctx.createGain();
    this.master.connect(comp).connect(ctx.destination);
    this.buses = { sfx: ctx.createGain(), amb: ctx.createGain() };
    this.buses.sfx.connect(this.master);
    this.buses.amb.connect(this.master);
    // two seconds of white noise, reused by every noise-based sound
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.applyVolumes();
    if (this.theme) this.ambience(this.theme);
    this.samples.preload(ctx); // small clips, fetched in the background; until they are decoded the recipes play
    return ctx;
  }

  // ------------------------------------------------------------------ primitives

  /** Gate: sound is off until unlocked, and the same sound cannot machine-gun. */
  private ok(id: string, minGap = 30): AudioContext | null {
    const ctx = this.ensure();
    if (!ctx || ctx.state !== 'running' || this.muted) return null;
    const now = ctx.currentTime * 1000;
    if (now - (this.last.get(id) ?? -1e9) < minGap) return null;
    this.last.set(id, now);
    return ctx;
  }

  private out(ctx: AudioContext, sp: Spatial, bus: Bus = 'sfx', vol = 1): GainNode {
    const g = ctx.createGain();
    g.gain.value = vol * sp.gain;
    let node: AudioNode = g;
    if (sp.pan !== 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, sp.pan));
      g.connect(p);
      node = p;
    }
    node.connect(this.buses[bus]);
    return g;
  }

  private tone(ctx: AudioContext, dest: AudioNode, o: ToneOpts) {
    const t0 = ctx.currentTime + (o.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.f, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + o.d);
    if (o.detune) osc.detune.value = o.detune;
    const g = ctx.createGain();
    const a = o.a ?? 0.005;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.vol ?? 0.3), t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + o.d);
    let tail: AudioNode = osc;
    if (o.lp) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.lp;
      osc.connect(f);
      tail = f;
    }
    tail.connect(g).connect(dest);
    osc.start(t0);
    osc.stop(t0 + a + o.d + 0.05);
  }

  private noise(ctx: AudioContext, dest: AudioNode, o: NoiseOpts) {
    const t0 = ctx.currentTime + (o.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = o.type ?? 'bandpass';
    f.frequency.setValueAtTime(o.f, t0);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t0 + o.d);
    f.Q.value = o.q ?? 0.8;
    const g = ctx.createGain();
    const a = o.a ?? 0.004;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, (o.vol ?? 0.3) * 2.2), t0 + a); // filtered noise loses most of its energy
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + o.d);
    src.connect(f).connect(g).connect(dest);
    src.start(t0, Math.random());
    src.stop(t0 + a + o.d + 0.05);
  }

  // ------------------------------------------------------------------ recipes (see voices.ts)

  /** Plays a recipe through the same panning and loudness as every other positional sound. */
  private play(id: string, r: Recipe, sp: Spatial, power = 1, minGap = 40, vol = 0.7): void {
    const ctx = this.ok(id, minGap);
    if (!ctx) return;
    const o = this.out(ctx, sp, 'sfx', vol);
    // a recorded sample of this id replaces the recipe (or adds to it when the entry is layered); not loaded yet or undecodable: the recipe
    if (this.samples.has(id) && this.samples.play(ctx, o, id, { power }) && !this.samples.layered(id)) return;
    r({ tone: (t) => this.tone(ctx, o, t), noise: (n) => this.noise(ctx, o, n) }, Math.max(0.4, Math.min(1.4, power)));
  }

  /** When each unit last released each ability, to tell a fresh hit from a damage-over-time or channel tick. */
  private castAt = new Map<string, number>();
  private heartAt = 0;

  /** Call every frame with your health fraction: a heartbeat that speeds up as you get low. */
  lowHealth(frac: number, alive: boolean): void {
    if (!alive || frac >= 0.3) return;
    const now = performance.now();
    const gap = 650 + frac * 2600; // 650 ms at the brink, about 1.4 s at 30%
    if (now - this.heartAt < gap) return;
    this.heartAt = now;
    this.play('heart', ACTION_VOICE.heartbeat, NEAR, 1.2 - frac, 200, 0.8);
  }

  jumpLand(sp: Spatial = NEAR): void {
    this.play('jumpland', ACTION_VOICE.jumpLand, sp, 1, 150, 0.6);
  }

  /** A cooldown or proc lighting up (Hot Streak and friends). */
  proc(): void {
    this.play('proc', ACTION_VOICE.proc, NEAR, 1, 200, 0.7);
  }

  // ------------------------------------------------------------------ sounds

  ui(kind: 'click' | 'error' | 'ping' | 'select'): void {
    const ctx = this.ok(`ui-${kind}`, 40);
    if (!ctx) return;
    const o = this.out(ctx, NEAR, 'sfx', 0.8);
    if (kind === 'click') this.tone(ctx, o, { f: 1400, to: 900, d: 0.05, vol: 0.45, type: 'triangle' });
    else if (kind === 'select') this.tone(ctx, o, { f: 720, to: 960, d: 0.05, vol: 0.2 });
    else if (kind === 'error') this.tone(ctx, o, { f: 150, to: 110, d: 0.14, vol: 0.28, type: 'square', lp: 700 });
    else {
      this.tone(ctx, o, { f: 1175, d: 0.25, vol: 0.2, type: 'triangle' });
      this.tone(ctx, o, { f: 1568, d: 0.3, vol: 0.18, type: 'triangle', delay: 0.09 });
    }
  }

  private hit(school: School, amount: number, sp: Spatial): void {
    const ctx = this.ok(`hit-${school}`, 35);
    if (!ctx) return;
    const power = Math.min(1, 0.45 + Math.sqrt(Math.max(1, amount)) / 28);
    const o = this.out(ctx, sp, 'sfx', power);
    switch (school) {
      case 'physical':
        this.noise(ctx, o, { d: 0.13, f: 2200, to: 300, type: 'lowpass', vol: 0.5 });
        this.tone(ctx, o, { f: 150, to: 55, d: 0.14, vol: 0.55 });
        break;
      case 'fire':
        this.noise(ctx, o, { d: 0.28, f: 1100, to: 350, q: 0.5, vol: 0.5 });
        this.tone(ctx, o, { f: 200, to: 70, d: 0.22, vol: 0.4, type: 'sawtooth', lp: 600 });
        break;
      case 'frost':
        this.noise(ctx, o, { d: 0.12, f: 5000, type: 'highpass', vol: 0.35 });
        this.tone(ctx, o, { f: 2100, to: 1000, d: 0.16, vol: 0.28, type: 'triangle' });
        this.tone(ctx, o, { f: 3100, to: 1500, d: 0.1, vol: 0.18, type: 'triangle', delay: 0.02 });
        break;
      case 'arcane':
        this.tone(ctx, o, { f: 880, to: 440, d: 0.16, vol: 0.3, type: 'square', lp: 2500 });
        this.tone(ctx, o, { f: 1320, to: 660, d: 0.14, vol: 0.2, detune: 18 });
        break;
      case 'holy':
        this.tone(ctx, o, { f: 988, to: 1480, d: 0.2, vol: 0.3, type: 'triangle' });
        this.noise(ctx, o, { d: 0.1, f: 4000, type: 'highpass', vol: 0.15 });
        break;
      case 'shadow':
        this.tone(ctx, o, { f: 120, to: 50, d: 0.34, vol: 0.5, type: 'sawtooth', lp: 500 });
        this.noise(ctx, o, { d: 0.22, f: 600, to: 200, vol: 0.3 });
        break;
      default:
        this.noise(ctx, o, { d: 0.14, f: 900, to: 300, vol: 0.4 });
        this.tone(ctx, o, { f: 260, to: 130, d: 0.15, vol: 0.3, type: 'triangle' });
    }
  }

  private castStart(school: School, sp: Spatial): void {
    const ctx = this.ok(`cs-${school}`, 80);
    if (!ctx) return;
    const o = this.out(ctx, sp, 'sfx', 0.55);
    switch (school) {
      case 'fire':
        this.noise(ctx, o, { d: 0.35, a: 0.1, f: 500, to: 1600, q: 0.7, vol: 0.3 });
        this.tone(ctx, o, { f: 150, to: 320, d: 0.35, a: 0.1, vol: 0.2, type: 'sawtooth', lp: 700 });
        break;
      case 'frost':
        this.tone(ctx, o, { f: 1400, to: 2600, d: 0.38, a: 0.08, vol: 0.2, type: 'triangle' });
        this.tone(ctx, o, { f: 1750, to: 3300, d: 0.34, a: 0.1, vol: 0.12, type: 'triangle', delay: 0.04 });
        break;
      case 'arcane':
        this.tone(ctx, o, { f: 400, to: 900, d: 0.36, a: 0.08, vol: 0.2, type: 'square', lp: 1800 });
        this.tone(ctx, o, { f: 405, to: 910, d: 0.36, a: 0.08, vol: 0.15, type: 'square', lp: 1800, detune: 14 });
        break;
      case 'holy':
        for (const [i, f] of [523, 659, 784].entries()) this.tone(ctx, o, { f, d: 0.45, a: 0.12, vol: 0.14, type: 'triangle', delay: i * 0.05 });
        break;
      case 'shadow':
        this.tone(ctx, o, { f: 85, to: 130, d: 0.45, a: 0.12, vol: 0.28, type: 'sawtooth', lp: 400 });
        this.noise(ctx, o, { d: 0.4, a: 0.12, f: 300, to: 700, vol: 0.18 });
        break;
      default:
        this.noise(ctx, o, { d: 0.09, f: 500, type: 'lowpass', vol: 0.3 });
    }
  }

  private cast(school: School, melee: boolean, sp: Spatial): void {
    const ctx = this.ok(`c-${school}-${melee}`, 60);
    if (!ctx) return;
    const o = this.out(ctx, sp, 'sfx', 0.6);
    if (melee) {
      this.noise(ctx, o, { d: 0.11, f: 500, to: 1900, q: 1.2, vol: 1.2 });
      return;
    }
    switch (school) {
      case 'fire':
        this.noise(ctx, o, { d: 0.26, f: 700, to: 2200, vol: 1.0 });
        break;
      case 'frost':
        this.noise(ctx, o, { d: 0.18, f: 3500, to: 6500, q: 2, vol: 0.8 });
        this.tone(ctx, o, { f: 2400, to: 3600, d: 0.12, vol: 0.18, type: 'triangle' });
        break;
      case 'arcane':
        this.tone(ctx, o, { f: 1100, to: 300, d: 0.2, vol: 0.28, type: 'square', lp: 2200 });
        break;
      case 'holy':
        this.tone(ctx, o, { f: 988, d: 0.4, vol: 0.2, type: 'triangle' });
        this.tone(ctx, o, { f: 1976, d: 0.3, vol: 0.1, type: 'sine' });
        break;
      case 'shadow':
        this.noise(ctx, o, { d: 0.3, f: 900, to: 150, vol: 1.0 });
        break;
      default:
        this.noise(ctx, o, { d: 0.15, f: 800, to: 1600, vol: 0.7 });
    }
  }

  private heal(amount: number, sp: Spatial): void {
    const ctx = this.ok('heal', 90);
    if (!ctx) return;
    const o = this.out(ctx, sp, 'sfx', Math.min(1, 0.4 + amount / 600));
    this.tone(ctx, o, { f: 660, to: 880, d: 0.18, vol: 0.22, type: 'triangle' });
    this.tone(ctx, o, { f: 990, to: 1320, d: 0.24, vol: 0.18, type: 'triangle', delay: 0.07 });
  }

  private control(kind: string, sp: Spatial): void {
    const ctx = this.ok(`cc-${kind}`, 120);
    if (!ctx) return;
    const o = this.out(ctx, sp, 'sfx', 0.8);
    switch (kind) {
      case 'stun':
        this.tone(ctx, o, { f: 220, to: 70, d: 0.2, vol: 0.5 });
        this.noise(ctx, o, { d: 0.1, f: 1500, type: 'lowpass', vol: 0.3 });
        break;
      case 'incapacitate':
        this.tone(ctx, o, { f: 300, to: 900, d: 0.14, vol: 0.28, type: 'triangle' });
        this.tone(ctx, o, { f: 900, to: 260, d: 0.22, vol: 0.28, type: 'triangle', delay: 0.14 });
        break;
      case 'fear':
        this.tone(ctx, o, { f: 880, to: 840, d: 0.5, a: 0.04, vol: 0.2, type: 'sawtooth', lp: 1400 });
        this.tone(ctx, o, { f: 932, to: 880, d: 0.5, a: 0.04, vol: 0.2, type: 'sawtooth', lp: 1400 });
        break;
      case 'root':
        this.noise(ctx, o, { d: 0.2, f: 4200, to: 2200, q: 1.5, vol: 0.35 });
        this.tone(ctx, o, { f: 1700, to: 800, d: 0.15, vol: 0.2, type: 'triangle' });
        break;
    }
  }

  private misc(kind: 'interrupt' | 'dispel' | 'dodge', sp: Spatial): void {
    const ctx = this.ok(`m-${kind}`, 80);
    if (!ctx) return;
    const o = this.out(ctx, sp, 'sfx', 0.8);
    if (kind === 'interrupt') {
      this.tone(ctx, o, { f: 320, to: 200, d: 0.07, vol: 0.4, type: 'square', lp: 1800 });
      this.noise(ctx, o, { d: 0.06, f: 4000, type: 'highpass', vol: 0.3 });
    } else if (kind === 'dispel') {
      this.tone(ctx, o, { f: 2200, d: 0.35, vol: 0.22 });
      this.tone(ctx, o, { f: 3300, d: 0.25, vol: 0.1, delay: 0.03 });
    } else this.noise(ctx, o, { d: 0.16, f: 900, to: 2800, q: 1.2, vol: 1.0 });
  }

  private death(isYou: boolean, sp: Spatial): void {
    const ctx = this.ok('death', 200);
    if (!ctx) return;
    const o = this.out(ctx, sp, 'sfx', isYou ? 1 : 0.7);
    this.tone(ctx, o, { f: 220, to: 45, d: isYou ? 0.9 : 0.55, vol: 0.5, type: 'sawtooth', lp: 650 });
    this.noise(ctx, o, { d: 0.35, f: 800, to: 120, type: 'lowpass', vol: 0.3 });
  }

  jump(sp: Spatial = NEAR): void {
    const ctx = this.ok('jump', 150);
    if (!ctx) return;
    const o = this.out(ctx, sp, 'sfx', 0.5);
    this.tone(ctx, o, { f: 200, to: 340, d: 0.12, vol: 0.25 });
    this.noise(ctx, o, { d: 0.1, f: 700, to: 1400, vol: 0.5 });
  }

  /** A step; the floor of the current arena decides what it sounds like. */
  footstep(theme = ''): void {
    const ctx = this.ok('step', 120);
    if (!ctx) return;
    const sf = STEP_SURFACE[theme] ?? STEP_SURFACE.colosseum;
    const o = this.out(ctx, NEAR, 'sfx', 0.55);
    const j = 0.85 + Math.random() * 0.3;
    this.noise(ctx, o, { d: 0.07, f: sf.f * j, type: sf.lp > 1 ? 'bandpass' : 'lowpass', vol: 0.5 });
    this.tone(ctx, o, { f: sf.thud * j, to: sf.thud * 0.65, d: 0.08, vol: 0.4 });
  }

  /** The three-two-one before a match: pass the seconds left. */
  countdown(secondsLeft: number): void {
    const ctx = this.ok('count', 300);
    if (!ctx) return;
    const o = this.out(ctx, NEAR, 'sfx', 1.6);
    this.tone(ctx, o, { f: secondsLeft <= 1 ? 1175 : 880, d: 0.14, vol: 0.3, type: 'triangle' });
  }

  matchStart(): void {
    const ctx = this.ok('start', 500);
    if (!ctx) return;
    const o = this.out(ctx, NEAR, 'sfx', 0.9);
    this.tone(ctx, o, { f: 110, d: 1.0, a: 0.03, vol: 0.4, type: 'sawtooth', lp: 900 });
    this.tone(ctx, o, { f: 165, d: 0.9, a: 0.03, vol: 0.3, type: 'sawtooth', lp: 900 });
    this.tone(ctx, o, { f: 220, d: 0.8, a: 0.03, vol: 0.25, type: 'sawtooth', lp: 1100 });
  }

  result(won: boolean | null): void {
    const ctx = this.ok('result', 800);
    if (!ctx) return;
    const o = this.out(ctx, NEAR, 'sfx', 0.9);
    const notes = won ? [523, 659, 784, 1047] : won === false ? [392, 349, 294, 220] : [440, 440];
    notes.forEach((f, i) => this.tone(ctx, o, { f, d: won ? 0.4 : 0.5, a: 0.02, vol: 0.28, type: won ? 'triangle' : 'sawtooth', lp: won ? undefined : 900, delay: i * 0.14 }));
  }

  // ------------------------------------------------------------------ events from the simulation

  /** `sp(id)` says how loud and where a unit's sounds are; null means too far or off screen entirely. */
  event(ev: SimEvent, you: number, myTeam: number, sp: (id: number) => Spatial | null): void {
    switch (ev.t) {
      case 'cast_start': {
        const s = sp(ev.unit);
        const def = ABILITIES[ev.ability];
        if (!s || !def || def.castTime <= 0) break;
        const v = startVoice(def);
        if (v) this.play(`cs-${def.id}`, v, s, 1, 80, 0.6);
        else this.castStart(def.school, s);
        break;
      }
      case 'cast': {
        const s = sp(ev.unit);
        const def = ABILITIES[ev.ability];
        if (!def) break;
        this.castAt.set(`${ev.unit}|${ev.ability}`, performance.now());
        if (this.castAt.size > 300) this.castAt.clear();
        if (!s) break;
        const v = castVoice(def);
        if (v) this.play(`c-${def.id}`, v, s, 1, 60, 0.7);
        else this.cast(def.school, def.range <= 6 && def.school === 'physical', s);
        break;
      }
      case 'damage': {
        const s0 = sp(ev.tgt);
        if (!s0) break;
        const s = ev.tgt === you ? { ...s0, gain: Math.max(s0.gain, 0.9) } : s0;
        if (ev.amount <= 0) {
          if (ev.absorbed > 0) this.play('absorb', ACTION_VOICE.absorb, s, 0.9, 80);
          break;
        }
        const power = 0.45 + Math.sqrt(Math.max(1, ev.amount)) / 28;
        if (!ev.ability) {
          // a swing of the weapon: a light whoosh and thud for physical, the school sound for anything else
          if (ev.school === 'physical') this.play('auto', ACTION_VOICE.autoHit, s, power, 90, 0.6);
          else this.hit(ev.school, ev.amount, s);
          break;
        }
        const def = ABILITIES[ev.ability];
        const fresh = performance.now() - (this.castAt.get(`${ev.src}|${ev.ability}`) ?? -1e9) < 350;
        if (!fresh) {
          this.play(`tick-${ev.ability}`, ACTION_VOICE.tick, s, power, 140, 0.55); // damage over time and channel ticks
          break;
        }
        const hv = hitVoice(def);
        if (hv) this.play(`hit-${ev.ability}`, hv, s, power, 35, 0.75);
        else this.hit(ev.school, ev.amount, s);
        if (ev.amount >= 320) this.play('big', ACTION_VOICE.land, s, 0.8, 150, 0.4); // a heavy blow gets a low boom under it
        break;
      }
      case 'heal': {
        const s = sp(ev.tgt);
        if (s && ev.amount > 0) this.heal(ev.amount, s);
        break;
      }
      case 'aura': {
        const def = AURAS[ev.aura];
        const s = sp(ev.tgt);
        if (!s || !def) break;
        if (['stun', 'incapacitate', 'fear', 'root'].includes(def.kind)) this.control(def.kind, s);
        else if (def.kind === 'stealth') this.play('stealth-in', ACTION_VOICE.stealthIn, s, 1, 200, 0.5);
        else if (def.kind === 'speed') this.play('speed', ACTION_VOICE.speed, s, 1, 150, 0.5);
        else if (def.kind === 'slow') this.play('slow', ACTION_VOICE.slow, s, 1, 150, 0.5);
        else if (def.kind === 'buff' && !def.harmful && ev.tgt === you) this.play('buff', ACTION_VOICE.buff, s, 1, 200, 0.45);
        if (def.kind === 'buff' && ev.tgt === you && ev.aura === 'hot_streak') this.proc();
        break;
      }
      case 'aura_removed': {
        const def = AURAS[ev.aura];
        const s = sp(ev.tgt);
        if (!s || !def) break;
        if (def.kind === 'absorb' && ev.reason !== 'expired') this.play('shield-break', ACTION_VOICE.shieldBreak, s, 1, 150, 0.6);
        else if (def.kind === 'stealth') this.play('stealth-out', ACTION_VOICE.stealthOut, s, 1, 200, 0.5);
        break;
      }
      case 'leap': {
        const s = sp(ev.unit);
        if (s) this.play('leap', ACTION_VOICE.leap, s, 1, 200, 0.7);
        break;
      }
      case 'leap_land': {
        const s = sp(ev.unit);
        if (s) this.play('land', ACTION_VOICE.land, s, 1, 200, 0.8);
        break;
      }
      case 'immune': {
        const s = sp(ev.tgt);
        if (s) this.play('immune', ACTION_VOICE.immune, s, 1, 200, 0.6);
        break;
      }
      case 'miss': {
        const s = sp(ev.src);
        if (s) this.play('miss', ACTION_VOICE.miss, s, 1, 150, 0.5);
        break;
      }
      case 'interrupt': {
        const s = sp(ev.tgt);
        if (s) this.misc('interrupt', s);
        break;
      }
      case 'dispel': {
        const s = sp(ev.tgt);
        if (s) this.misc('dispel', s);
        break;
      }
      case 'dodge': {
        const s = sp(ev.unit);
        if (s) this.misc('dodge', s);
        break;
      }
      case 'death': {
        const s = sp(ev.unit);
        if (s) this.death(ev.unit === you, s);
        break;
      }
      case 'phase':
        if (ev.phase === 'live') this.matchStart();
        else if (ev.phase === 'ended') this.result(ev.winner === 'draw' || ev.winner === null ? null : ev.winner === myTeam);
        break;
      case 'cast_fail':
        if (ev.unit === you && ev.reason !== 'moved') this.ui('error');
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ ambience

  /** Looping arena atmosphere for a map theme; call with '' (or stopAmbience) when leaving a match. */
  ambience(theme: string): void {
    this.theme = theme;
    this.stopAmbience(false);
    const ctx = this.ctx;
    if (!ctx || !theme) return;
    const bus = this.buses.amb;
    const loop = (f: number, q: number, type: BiquadFilterType, vol: number, lfoHz: number, lfoDepth: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const filt = ctx.createBiquadFilter();
      filt.type = type;
      filt.frequency.value = f;
      filt.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = vol;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = lfoHz;
      const depth = ctx.createGain();
      depth.gain.value = vol * lfoDepth;
      lfo.connect(depth).connect(g.gain);
      src.connect(filt).connect(g).connect(bus);
      src.start();
      lfo.start();
      this.ambNodes.push({ stop: () => { src.stop(); lfo.stop(); g.disconnect(); } });
    };
    const drone = (f: number, vol: number) => {
      for (const d of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f;
        o.detune.value = d;
        const g = ctx.createGain();
        g.gain.value = vol;
        o.connect(g).connect(bus);
        o.start();
        this.ambNodes.push({ stop: () => { o.stop(); g.disconnect(); } });
      }
    };
    const every = (minMs: number, maxMs: number, fn: () => void) => {
      const go = () => {
        fn();
        this.ambTimers.push(window.setTimeout(go, minMs + Math.random() * (maxMs - minMs)));
      };
      this.ambTimers.push(window.setTimeout(go, minMs));
    };
    const quiet = this.out(ctx, NEAR, 'amb', 0.6);
    if (theme === 'frost') {
      loop(700, 0.9, 'bandpass', 0.07, 0.11, 0.7);
      loop(2400, 2.5, 'bandpass', 0.025, 0.07, 0.9);
      drone(73.4, 0.012);
      every(5000, 12000, () => this.tone(ctx, quiet, { f: 2900, to: 2600, d: 0.5, vol: 0.05, type: 'sine' })); // distant ice creak
    } else if (theme === 'ruins') {
      loop(260, 0.6, 'lowpass', 0.09, 0.08, 0.5);
      drone(55, 0.018);
      every(1400, 4200, () => {
        const f = 1300 + Math.random() * 500;
        this.tone(ctx, quiet, { f, to: f * 0.6, d: 0.09, vol: 0.14 });
        this.tone(ctx, quiet, { f: f * 0.98, to: f * 0.58, d: 0.12, vol: 0.06, delay: 0.16 });
      }); // water dripping
    } else if (theme === 'cinder' || theme === 'forge') {
      loop(140, 0.7, 'lowpass', 0.11, 0.07, 0.5); // the roar of the lava below
      loop(900, 1.2, 'bandpass', 0.03, 0.17, 0.9);
      drone(41, 0.02);
      every(180, 1100, () => this.noise(ctx, quiet, { d: 0.02 + Math.random() * 0.04, f: 2500 + Math.random() * 3500, type: 'highpass', vol: 0.16 })); // embers popping
    } else {
      loop(520, 0.5, 'bandpass', 0.05, 0.13, 0.6); // crowd murmur
      loop(350, 0.4, 'lowpass', 0.05, 0.05, 0.8);
      drone(55, 0.015);
      every(250, 1500, () => this.noise(ctx, quiet, { d: 0.03 + Math.random() * 0.05, f: 3000 + Math.random() * 3000, type: 'highpass', vol: 0.12 })); // brazier crackle
    }
  }

  stopAmbience(forget = true): void {
    if (forget) this.theme = '';
    for (const t of this.ambTimers) clearTimeout(t);
    this.ambTimers = [];
    for (const n of this.ambNodes) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
    }
    this.ambNodes = [];
  }
}
