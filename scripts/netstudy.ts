/**
 * Netcode study harness (measurement only: it changes nothing in the game). See NETCODE.md.
 *
 *   npx tsx scripts/netstudy.ts                 # everything (about 6-10 minutes)
 *   npx tsx scripts/netstudy.ts --quick         # fewer seeds / shorter runs
 *   npx tsx scripts/netstudy.ts --only net,cpu  # sections: net, bw, cpu, timer, rules, bots
 *   npx tsx scripts/netstudy.ts --json out.json # also write the raw numbers
 *
 * How it works: the orchestrator (this process) starts one child process per tick length, because the simulation reads
 * TUNING.tickMs once at load. Each child imports the real ArenaSim / Lobby / Bot from shared/ and server/, sets
 * TUNING.tickMs first, and runs the sections for that tick length.
 *
 * "net": the REAL ArenaSim (queueInput, step, snapshot positions, posAt lag compensation) in virtual time, two scripted
 * players, a simulated WebSocket link (in-order delivery, one-way latency + jitter, loss as TCP head-of-line blocking) and
 * a faithful port of the client's prediction / reconciliation / interpolation (client/src/main.ts, line numbers in the
 * comments below). Everything is virtual time, so it is deterministic and fast.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import fs from 'node:fs';

const SELF = fileURLToPath(import.meta.url);
const childSpec = process.env.NETSTUDY_CHILD ? JSON.parse(process.env.NETSTUDY_CHILD) : null;

// ---------------------------------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------------------------------
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '-');

class Heap {
  private a: { t: number; n: number; fn: () => void }[] = [];
  private n = 0;
  push(t: number, fn: () => void) {
    const a = this.a;
    a.push({ t, n: this.n++, fn });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].t < a[i].t || (a[p].t === a[i].t && a[p].n < a[i].n)) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        const lt = (x: number, y: number) => a[x].t < a[y].t || (a[x].t === a[y].t && a[x].n < a[y].n);
        if (l < a.length && lt(l, m)) m = l;
        if (r < a.length && lt(r, m)) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

// ---------------------------------------------------------------------------------------------------------------------
// config types
// ---------------------------------------------------------------------------------------------------------------------
export interface NetCfg {
  name: string;
  tickMs: number;
  /** ms between snapshots. >= tickMs: every n-th tick. < tickMs: "fill" snapshots in between ticks (positions interpolated between ticks, label one tick behind). */
  snapMs: number;
  /** Interpolation delay in ms, '2snap' = 2 snapshot intervals, 'adaptive' = from measured arrival jitter. */
  delay: number | '2snap' | 'adaptive';
  extrap: boolean;
  clock: 'naive' | 'smooth';
  owd: number;
  jitter: number;
  loss: number;
  fps: number;
  /** Server input-queue policy: 'cap5' = what the game does now (queue of 5, one input consumed per tick); 'cap2' = keep at most 2 (drop the oldest); 'catchup' = when more than 2 are waiting, apply the extra ones in the same tick (emulated here by stepping the unit directly; NOT in the game). */
  qpolicy?: 'cap5' | 'cap2' | 'catchup';
  /** How the own character is drawn between predicted steps: 'lerp' = what main.ts does (blend prevPred->pred, always up to one tick behind); 'ahead' = project the last step forward by the time since the step (what a per-frame prediction would show). */
  own?: 'lerp' | 'ahead';
}

// ---------------------------------------------------------------------------------------------------------------------
// the "net" section: real sim + simulated link + ported client logic
// ---------------------------------------------------------------------------------------------------------------------
type Mods = any;

interface Seg { t0: number; t1: number; fwd: number; strafe: number; facing: number; start?: boolean }
function makeScript(rng: () => number, durMs: number, facing0: number): Seg[] {
  const segs: Seg[] = [];
  let t = 0;
  let face = facing0;
  const j = () => 0.8 + rng() * 0.4;
  const add = (d: number, fwd: number, strafe: number, start = false) => { segs.push({ t0: t, t1: t + d, fwd, strafe, facing: face, start }); t += d; };
  const stopStart = (n: number) => { for (let i = 0; i < n; i++) { add(700 * j(), 1, 0, true); add(800 * j(), 0, 0); } };
  while (t < durMs + 5000) {
    add(300, 0, 0);
    let s = rng() < 0.5 ? 1 : -1;
    for (let i = 0; i < 6; i++, s = -s) add(500 * j(), 1, s); // zig-zag out (strafe flips every 0.5 s)
    face += Math.PI; // mouse flick
    s = 1;
    for (let i = 0; i < 6; i++, s = -s) add(500 * j(), 1, s); // and back
    face += Math.PI + (rng() - 0.5) * 0.6;
    add(2000 * j(), 1, 0); // straight run out
    face += Math.PI;
    add(2000 * j(), 1, 0); // and back
    face += Math.PI;
    stopStart(3); // stop-start out
    face += Math.PI;
    stopStart(3);
    face += (rng() - 0.5) * 0.8;
  }
  return segs;
}

class Link {
  private last = 0;
  constructor(private q: Heap, private owd: number, private jit: number, private loss: number, private rng: () => number) {}
  send(t: number, cb: (arr: number) => void) {
    let arr = t + this.owd + this.rng() * this.jit;
    // a lost TCP segment is resent after about max(200 ms, 2 RTT); everything behind it waits (in-order delivery)
    if (this.loss > 0 && this.rng() < this.loss) arr += Math.max(200, 2 * (2 * this.owd + this.jit));
    arr = Math.max(arr, this.last);
    this.last = arr;
    this.q.push(arr, () => cb(arr));
  }
}

interface SnapU { id: number; x: number; z: number; facing: number; lastSeq: number }
interface NSnap { time: number; units: SnapU[] }

class NetClient {
  // --- prediction state, names as in client/src/main.ts (lines 143-150)
  pred = { x: 0, z: 0 };
  prevPred = { x: 0, z: 0 };
  vis = { x: 0, z: 0, ready: false };
  pending: { seq: number; fwd: number; strafe: number; facing: number }[] = [];
  seq = 0;
  acc = 0;
  lastT = 0;
  snaps: { at: number; snap: NSnap }[] = [];
  latest: NSnap | null = null;
  latestAt = 0;
  // --- clock + delay estimation (new variants)
  offSamples: { at: number; o: number }[] = [];
  offEst = NaN;
  gapDev = 0;
  lastArrival = 0;
  adaptDelay = 100;
  // --- logs
  frames: { W: number; rt: number; x: number; z: number; ex: number }[] = [];
  visLog: { W: number; x: number; z: number }[] = [];
  srvOwn: { W: number; x: number; z: number }[] = [];
  corr: number[] = [];
  nextCastAt: number;
  script: Seg[];
  segI = 0;
  prevDisp: { x: number; z: number } | null = null;
  prevRt = -1;
  pops = 0;
  backwards = 0;
  frameCount = 0;
  extrapFrames = 0;
  underrun = 0;
  disp: { x: number; z: number } | null = null;

  constructor(readonly sh: Shared, readonly id: number, readonly other: number, readonly up: Link, rng: () => number, readonly phase: number) {
    this.script = makeScript(rng, sh.durMs, id === 1 ? 0.3 : 2.9);
    this.nextCastAt = 4000 + rng() * 500;
  }

  keys(W: number): Seg {
    const s = this.script;
    while (this.segI < s.length - 1 && s[this.segI].t1 <= W) this.segI++;
    return s[this.segI];
  }

  get delayMs(): number {
    const c = this.sh.cfg;
    if (c.delay === '2snap') return 2 * c.snapMs;
    if (c.delay === 'adaptive') return this.adaptDelay;
    return c.delay;
  }

  estNow(W: number): number {
    if (this.sh.cfg.clock === 'smooth' && Number.isFinite(this.offEst)) return W + this.offEst;
    return this.latest ? this.latest.time + (W - this.latestAt) : 0; // main.ts:747 estimatedNow()
  }

  /** main.ts:473-505 onSnapshot + reconcile */
  onSnapshot(W: number, snap: NSnap) {
    const cfg = this.sh.cfg;
    this.snaps.push({ at: W, snap });
    if (this.snaps.length > 30) this.snaps.shift();
    this.latest = snap;
    this.latestAt = W;
    // clock estimate (variant)
    this.offSamples.push({ at: W, o: snap.time - W });
    while (this.offSamples.length && W - this.offSamples[0].at > 2000) this.offSamples.shift();
    const target = Math.max(...this.offSamples.map((s) => s.o));
    this.offEst = Number.isFinite(this.offEst) ? this.offEst + 0.1 * (target - this.offEst) : target;
    // arrival jitter (adaptive delay)
    if (this.lastArrival) {
      const gap = W - this.lastArrival;
      this.gapDev += 0.1 * (Math.abs(gap - cfg.snapMs) - this.gapDev);
      this.adaptDelay = Math.min(150, Math.max(1.25 * cfg.snapMs, 1.25 * cfg.snapMs + 3 * this.gapDev));
    }
    this.lastArrival = W;

    const me = snap.units.find((u) => u.id === this.id);
    if (!me) return;
    const ox = this.pred.x, oz = this.pred.z;
    this.pred.x = me.x;
    this.pred.z = me.z;
    if (!this.vis.ready) {
      this.prevPred.x = this.vis.x = me.x;
      this.prevPred.z = this.vis.z = me.z;
    }
    while (this.pending.length && this.pending[0].seq <= me.lastSeq) this.pending.shift();
    for (const i of this.pending) this.applyInput(i);
    this.corr.push(Math.hypot(this.pred.x - ox, this.pred.z - oz));
    this.srvOwn.push({ W, x: me.x, z: me.z });
  }

  /** main.ts:556-566 applyInput (no gate clamp: prepMs is 0 here) */
  applyInput(i: { fwd: number; strafe: number; facing: number }) {
    const { stepMovementL, TUNING, ARENA } = this.sh.M;
    const step = stepMovementL({ x: this.pred.x, z: this.pred.z }, 0, i, TUNING.runSpeed, this.sh.DT, ARENA, 0);
    this.prevPred.x = this.pred.x;
    this.prevPred.z = this.pred.z;
    this.pred.x = step.pos.x;
    this.pred.z = step.pos.z;
  }

  /** main.ts:578-593 fixedStep */
  fixedStep(W: number) {
    if (!this.latest) return;
    const k = this.keys(W);
    const input = { seq: ++this.seq, fwd: k.fwd, strafe: k.strafe, facing: k.facing };
    this.up.send(W, () => {
      const sim = this.sh.server.sim;
      sim.queueInput(this.id, input);
      if (this.sh.cfg.qpolicy === 'cap2') { const u = sim.units.get(this.id); while (u.inputQueue.length > 2) u.inputQueue.shift(); }
    });
    this.pending.push(input);
    if (this.pending.length > 60) this.pending.shift();
    this.applyInput(input);
  }

  /** main.ts:603-621 interpolate(rt), plus optional extrapolation past the newest snapshot */
  interpolate(rt: number, id: number): { x: number; z: number } | null {
    const snaps = this.snaps;
    if (!snaps.length) return null;
    let i = snaps.length - 1;
    while (i > 0 && snaps[i].snap.time > rt) i--;
    const a = snaps[i].snap;
    const b = snaps[Math.min(i + 1, snaps.length - 1)].snap;
    const span = b.time - a.time;
    const ua = a.units.find((u) => u.id === id);
    const ub = b.units.find((u) => u.id === id) ?? ua;
    if (!ua || !ub) return null;
    const newest = snaps[snaps.length - 1].snap;
    if (rt > newest.time) {
      this.underrun++;
      if (this.sh.cfg.extrap && snaps.length >= 2) {
        const prev = snaps[snaps.length - 2].snap;
        const un = newest.units.find((u) => u.id === id)!;
        const up = prev.units.find((u) => u.id === id) ?? un;
        const dt = newest.time - prev.time || 1;
        const ahead = Math.min(rt - newest.time, 100);
        this.extrapFrames++;
        return { x: un.x + ((un.x - up.x) / dt) * ahead, z: un.z + ((un.z - up.z) / dt) * ahead };
      }
    }
    const t = span > 0 ? Math.min(1, Math.max(0, (rt - a.time) / span)) : 0;
    return { x: ua.x + (ub.x - ua.x) * t, z: ua.z + (ub.z - ua.z) * t };
  }

  /** one rendered frame: main.ts frame(): the fixed-step accumulator (:1018-1021), interpolation (:1035) and the own-unit easing (:1038-1068) */
  frame(W: number) {
    const DT = this.sh.DT;
    const dt = Math.min(0.25, (W - this.lastT) / 1000);
    this.lastT = W;
    if (!this.latest) return;
    this.acc += dt;
    while (this.acc >= DT) {
      this.acc -= DT;
      this.fixedStep(W);
    }
    const alpha = Math.min(1, Math.max(0, this.acc / DT));
    const ahead = this.sh.cfg.own === 'ahead';
    const tx = ahead ? this.pred.x + (this.pred.x - this.prevPred.x) * alpha : this.prevPred.x + (this.pred.x - this.prevPred.x) * alpha;
    const tz = ahead ? this.pred.z + (this.pred.z - this.prevPred.z) * alpha : this.prevPred.z + (this.pred.z - this.prevPred.z) * alpha;
    if (!this.vis.ready || Math.hypot(tx - this.vis.x, tz - this.vis.z) > 4) {
      this.vis.x = tx;
      this.vis.z = tz;
      this.vis.ready = true;
    } else {
      const k = 1 - Math.exp(-dt * 38);
      this.vis.x += (tx - this.vis.x) * k;
      this.vis.z += (tz - this.vis.z) * k;
    }
    this.visLog.push({ W, x: this.vis.x, z: this.vis.z });
    const rt = this.estNow(W) - this.delayMs;
    const d = this.interpolate(rt, this.other);
    this.disp = d;
    this.frameCount++;
    if (d) {
      this.frames.push({ W, rt, x: d.x, z: d.z, ex: 0 });
      if (this.prevDisp && Math.hypot(d.x - this.prevDisp.x, d.z - this.prevDisp.z) > 0.3) this.pops++;
      this.prevDisp = d;
    }
    if (this.prevRt >= 0 && rt < this.prevRt - 1e-6) this.backwards++;
    this.prevRt = rt;
    // a cast every ~0.6 s: the client reports what its screen shows (vt = viewTime(), main.ts:733) and how far apart it sees the two units
    if (W >= this.nextCastAt && d) {
      this.nextCastAt = W + 450 + this.sh.rng() * 350;
      const dClient = Math.hypot(this.vis.x - d.x, this.vis.z - d.z);
      const vt = Math.round(rt);
      const caster = this.id, target = this.other;
      this.up.send(W, () => this.sh.server.cast(W, caster, target, vt, dClient));
    }
  }
}

interface Shared { M: Mods; cfg: NetCfg; DT: number; durMs: number; server: NetServer; rng: () => number }

class NetServer {
  sim: any;
  trackX: Record<number, number[]> = { 1: [], 2: [] };
  trackZ: Record<number, number[]> = { 1: [], 2: [] };
  links: Record<number, Link> = {};
  clients: Record<number, NetClient> = {};
  qlens: number[] = [];
  starved = 0;
  dropped = 0;
  consumedTicks = 0;
  casts: { dServer: number; dClient: number; dTrue: number; rewind: number; clamped: boolean; windowClamped: boolean }[] = [];
  serverMoves: { id: number; W: number; x: number; z: number }[] = [];
  lastSeqSeen: Record<number, number> = { 1: 0, 2: 0 };
  constructor(readonly sh: Shared) {
    const { ArenaSim } = sh.M;
    this.sim = new ArenaSim({ seed: 1, prepMs: 0 });
    for (const t of [0, 1]) {
      const u = this.sim.addUnit({ name: `p${t}`, classId: 'warrior', team: t, controller: 'player' });
      u.pos = { x: t === 0 ? -2 : 2, z: 0 };
    }
    for (const id of [1, 2]) {
      const u = this.sim.units.get(id);
      this.trackX[id].push(u.pos.x);
      this.trackZ[id].push(u.pos.z);
    }
  }
  /** position of unit `id` at server time `t` along the recorded per-tick path (linear between ticks) */
  pathAt(id: number, t: number) {
    const T = this.sh.M.TUNING.tickMs;
    const k = Math.max(0, Math.min(this.trackX[id].length - 1, t / T));
    const k0 = Math.floor(k), k1 = Math.min(this.trackX[id].length - 1, k0 + 1), fr = k - k0;
    return { x: this.trackX[id][k0] + (this.trackX[id][k1] - this.trackX[id][k0]) * fr, z: this.trackZ[id][k0] + (this.trackZ[id][k1] - this.trackZ[id][k0]) * fr };
  }
  snapshotFor(label: number, exactOthers: boolean): NSnap {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const units: SnapU[] = [];
    for (const u of this.sim.units.values()) {
      let x = u.pos.x, z = u.pos.z;
      if (!exactOthers) {
        const p = this.pathAt(u.id, label);
        x = p.x; z = p.z; // fill snapshot: positions interpolated between sim ticks
      }
      units.push({ id: u.id, x: r2(x), z: r2(z), facing: Math.round(u.facing * 1000) / 1000, lastSeq: u.lastSeq });
    }
    return { time: label, units };
  }
  /** shared/src/sim.ts:253 + :334 lag compensation, replayed with the real posAt() */
  cast(sentAt: number, caster: number, target: number, vt: number, dClient: number) {
    const sim = this.sim, { TUNING } = this.sh.M;
    const raw = sim.time - vt;
    const rewind = Math.max(0, Math.min(TUNING.maxRewindMs, Math.round(raw)));
    const seen = sim.posAt(sim.units.get(target), sim.time - rewind);
    const me = sim.units.get(caster).pos, now = sim.units.get(target).pos;
    const h = sim.history;
    this.casts.push({
      dServer: Math.hypot(me.x - seen.x, me.z - seen.z), dClient, dTrue: Math.hypot(me.x - now.x, me.z - now.z), rewind,
      clamped: raw > TUNING.maxRewindMs, windowClamped: h.length > 0 && sim.time - rewind <= h[0].time && raw > 0,
    });
  }
}

export interface NetResult {
  age: number[]; stale: number[]; recon: number[]; corr: number[]; corrFreq: number; pops: number; backwards: number; underrun: number;
  c1: number[]; c2: number[]; c3: number[]; castErr: number[]; wrongReject: number; wrongAccept: number; castN: number; falseOld: number;
  rewindMean: number; clampedPct: number; windowClampedPct: number; qlen: number[]; starvedPct: number; droppedPerMin: number; minutes: number;
}

function runNet(M: Mods, cfg: NetCfg, seed: number, durMs: number): NetResult {
  const { TUNING } = M;
  const T = TUNING.tickMs;
  const rng = mulberry(seed * 7919 + 13);
  const q = new Heap();
  const sh: Shared = { M, cfg, DT: T / 1000, durMs, server: null as any, rng };
  const server = new NetServer(sh);
  sh.server = server;
  const link = () => new Link(q, cfg.owd, cfg.jitter, cfg.loss / 100, rng);
  for (const id of [1, 2]) {
    server.links[id] = link(); // server -> client
    server.clients[id] = new NetClient(sh, id, id === 1 ? 2 : 1, link(), rng, rng() * (1000 / cfg.fps));
  }
  const sim = server.sim;
  const K = Math.floor(durMs / T);
  const fill = cfg.snapMs < T - 1e-6;
  const every = fill ? 1 : Math.max(1, Math.round(cfg.snapMs / T));
  // server ticks (shared/src/sim.ts:405 step; server/src/index.ts:250 loop). Inputs that arrived earlier are queued first (heap order).
  const qlenSamples: number[] = [];
  let starved = 0, ticks = 0, dropped = 0;
  const lastSeq: Record<number, number> = { 1: 0, 2: 0 };
  for (let k = 1; k <= K; k++) {
    q.push(k * T - 1e-6, () => {
      for (const id of [1, 2]) qlenSamples.push(sim.units.get(id).inputQueue.length);
      const extra: Record<number, number> = { 1: 0, 2: 0 };
      if (cfg.qpolicy === 'catchup') {
        for (const id of [1, 2]) {
          const u = sim.units.get(id);
          while (u.inputQueue.length > 2) {
            const i = u.inputQueue.shift();
            const r = M.stepMovementL(u.pos, 0, i, TUNING.runSpeed, T / 1000, M.ARENA, 0);
            u.pos = r.pos; u.lastSeq = i.seq; u.lastInput = i; extra[id]++;
          }
        }
      }
      sim.step();
      sim.drainEvents();
      ticks += 2;
      for (const id of [1, 2]) {
        const u = sim.units.get(id);
        server.trackX[id].push(u.pos.x);
        server.trackZ[id].push(u.pos.z);
        if (u.starve > 0) starved++;
        if (u.lastSeq > lastSeq[id]) { dropped += Math.max(0, u.lastSeq - lastSeq[id] - 1 - extra[id]); lastSeq[id] = u.lastSeq; }
      }
      if (!fill && k % every === 0) {
        const t = k * T;
        for (const id of [1, 2]) {
          const s = server.snapshotFor(sim.time, true);
          server.links[id].send(t, (arr) => server.clients[id].onSnapshot(arr, s));
        }
      }
    });
  }
  if (fill) {
    // snapshots between ticks: others' positions interpolated along the sim's own path, labelled one tick behind; own unit exact
    for (let j = 1; j * cfg.snapMs <= K * T; j++) {
      const s = j * cfg.snapMs;
      q.push(s, () => {
        const label = s - T;
        if (label < 0) return;
        for (const id of [1, 2]) {
          const snap = server.snapshotFor(label, false);
          const own = snap.units.find((u) => u.id === id)!;
          const real = sim.units.get(id);
          own.x = Math.round(real.pos.x * 100) / 100; own.z = Math.round(real.pos.z * 100) / 100; own.lastSeq = real.lastSeq;
          server.links[id].send(s, (arr) => server.clients[id].onSnapshot(arr, snap));
        }
      });
    }
  }
  // client frames
  const frameMs = 1000 / cfg.fps;
  for (const id of [1, 2]) {
    const c = server.clients[id];
    const sched = (W: number) => { if (W <= K * T) q.push(W, () => { c.frame(W); sched(W + frameMs); }); };
    sched(c.phase);
  }
  while (q.size) q.pop().fn();

  // ---- post-processing
  const warm = 3000, endW = K * T - 1500;
  const res: NetResult = { age: [], stale: [], recon: [], corr: [], corrFreq: 0, pops: 0, backwards: 0, underrun: 0, c1: [], c2: [], c3: [], castErr: [], wrongReject: 0, wrongAccept: 0, castN: 0, falseOld: 0, rewindMean: 0, clampedPct: 0, windowClampedPct: 0, qlen: qlenSamples, starvedPct: (100 * starved) / Math.max(1, ticks), droppedPerMin: 0, minutes: (2 * durMs) / 60000 };
  let framesN = 0;
  for (const id of [1, 2]) {
    const c = server.clients[id];
    const tgt = c.other;
    for (const fr of c.frames) {
      if (fr.W < warm || fr.W > endW) continue;
      const now = server.pathAt(tgt, fr.W);
      const shown = server.pathAt(tgt, fr.rt);
      res.age.push(fr.W - fr.rt);
      res.stale.push(Math.hypot(fr.x - now.x, fr.z - now.z));
      res.recon.push(Math.hypot(fr.x - shown.x, fr.z - shown.z));
    }
    for (const x of c.corr.slice(Math.floor(c.corr.length * 0.07))) res.corr.push(x);
    res.pops += c.pops; res.backwards += c.backwards; res.underrun += c.underrun; framesN += c.frameCount;
  }
  res.corrFreq = res.corr.length ? res.corr.filter((x) => x > 0.05).length / res.corr.length : 0;
  res.pops /= res.minutes; res.backwards /= res.minutes; res.underrun = (100 * res.underrun) / Math.max(1, framesN);
  // input latency trials: player 1 starts moving from rest (script segments flagged start after a stop)
  const A = server.clients[1], B = server.clients[2];
  const starts = A.script.filter((s) => s.start && s.t0 > warm && s.t0 < endW - 1500 && A.script.some((p) => p.t1 === s.t0 && p.fwd === 0 && p.strafe === 0));
  const firstAfter = <T2 extends { W: number }>(log: T2[], t0: number, far: (e: T2) => boolean) => { for (const e of log) if (e.W >= t0 && far(e)) return e.W - t0; return NaN; };
  for (const s of starts) {
    const rest = A.visLog.find((e) => e.W >= s.t0 - 30)!;
    if (!rest) continue;
    const d = (e: { x: number; z: number }) => Math.hypot(e.x - rest.x, e.z - rest.z);
    const a = firstAfter(A.visLog, s.t0, (e) => d(e) >= 0.1);
    const b = firstAfter(A.srvOwn, s.t0, (e) => d(e) >= 0.1);
    const c = firstAfter(B.frames, s.t0, (e) => Math.hypot(e.x - rest.x, e.z - rest.z) >= 0.1);
    if (Number.isFinite(a)) res.c1.push(a);
    if (Number.isFinite(b)) res.c2.push(b);
    if (Number.isFinite(c)) res.c3.push(c);
  }
  // lag compensation accuracy at range 3.5 (melee + tolerance), only casts that start near that distance
  const R = 3.5;
  const near = server.casts.filter((c) => c.dClient > 1.5 && c.dClient < 6.5);
  res.castN = near.length;
  for (const c of near) {
    res.castErr.push(Math.abs(c.dServer - c.dClient));
    if (c.dClient <= R && c.dServer > R) res.wrongReject++;
    if (c.dClient > R && c.dServer <= R) res.wrongAccept++;
    if (c.dTrue > R && c.dServer <= R) res.falseOld++;
  }
  res.rewindMean = mean(server.casts.map((c) => c.rewind));
  res.clampedPct = (100 * server.casts.filter((c) => c.clamped).length) / Math.max(1, server.casts.length);
  res.windowClampedPct = (100 * server.casts.filter((c) => c.windowClamped).length) / Math.max(1, server.casts.length);
  res.droppedPerMin = dropped / res.minutes;
  return res;
}

function pool(rs: NetResult[]): NetResult {
  const cat = (k: keyof NetResult) => rs.flatMap((r) => r[k] as number[]);
  const avg = (k: keyof NetResult) => mean(rs.map((r) => r[k] as number));
  const sum = (k: keyof NetResult) => rs.reduce((a, r) => a + (r[k] as number), 0);
  return {
    age: cat('age'), stale: cat('stale'), recon: cat('recon'), corr: cat('corr'), corrFreq: avg('corrFreq'), pops: avg('pops'), backwards: avg('backwards'), underrun: avg('underrun'),
    c1: cat('c1'), c2: cat('c2'), c3: cat('c3'), castErr: cat('castErr'), wrongReject: sum('wrongReject'), wrongAccept: sum('wrongAccept'), castN: sum('castN'), falseOld: sum('falseOld'),
    rewindMean: avg('rewindMean'), clampedPct: avg('clampedPct'), windowClampedPct: avg('windowClampedPct'), qlen: cat('qlen'), starvedPct: avg('starvedPct'), droppedPerMin: avg('droppedPerMin'), minutes: sum('minutes'),
  };
}
function summarise(r: NetResult) {
  const cp = r.castN || 1;
  return {
    ageMean: mean(r.age), staleMean: mean(r.stale), staleP95: pct(r.stale, 95), staleMax: Math.max(...r.stale),
    reconMean: mean(r.recon), reconP95: pct(r.recon, 95), reconMax: Math.max(...r.recon),
    corrMean: mean(r.corr), corrP95: pct(r.corr, 95), corrMax: Math.max(0, ...r.corr), corrFreq: 100 * r.corrFreq,
    pops: r.pops, backwards: r.backwards, underrun: r.underrun,
    c1: mean(r.c1), c1p95: pct(r.c1, 95), c2: mean(r.c2), c2p95: pct(r.c2, 95), c3: mean(r.c3), c3p95: pct(r.c3, 95),
    castErrMean: mean(r.castErr), castErrP95: pct(r.castErr, 95), wrongReject: (100 * r.wrongReject) / cp, wrongAccept: (100 * r.wrongAccept) / cp, falseOld: (100 * r.falseOld) / cp,
    rewind: r.rewindMean, clamped: r.clampedPct, windowClamped: r.windowClampedPct, qlen: mean(r.qlen), qlenP95: pct(r.qlen, 95), starved: r.starvedPct, dropped: r.droppedPerMin,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// bandwidth + CPU (real Lobby / Room with fake sockets and bots)
// ---------------------------------------------------------------------------------------------------------------------
async function runRoom(M: Mods, units: 2 | 4 | 6, gameSeconds: number, capture: boolean) {
  const { Lobby } = await import('../server/src/rooms');
  const T = M.TUNING.tickMs;
  const frames: string[] = [];
  let bytes = 0, msgs = 0;
  const sock = { readyState: 1, send(d: string) { if (capture) frames.push(d); bytes += d.length; msgs++; } } as any;
  const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 1e12 });
  const host = lobby.connect(sock, '9.9.9.9');
  const size = units / 2;
  const t = { total: 0, step: 0, bots: 0, ticks: 0 };
  let seq = 0;
  let liveSec = 0;
  let matches = 0;
  // process CPU time (user+system, ms), not wall time: other jobs on a shared machine must not inflate the numbers
  const hr = () => { const c = process.cpuUsage(); return (c.user + c.system) / 1000; };
  const start = () => {
    lobby.handle(host, { t: 'join', name: 'Bench', classId: 'mage', mode: 'practice', size, difficulty: 'hard' } as any);
    const room = host.room!;
    const sim = room.sim;
    const orig = sim.step.bind(sim);
    sim.step = () => { const a = hr(); orig(); t.step += hr() - a; };
    for (const b of room.bots) { const o = b.tick.bind(b); b.tick = () => { const a = hr(); o(); t.bots += hr() - a; }; }
    matches++;
    return room;
  };
  let room = start();
  // warm up the JIT (not measured)
  for (let i = 0; i < Math.round(3000 / T); i++) lobby.tick();
  t.total = t.step = t.bots = 0;
  while (liveSec < gameSeconds) {
    if (!host.room || room.sim.phase === 'ended' || room.closed) {
      lobby.handle(host, { t: 'leave' } as any);
      room = start();
      continue;
    }
    // the human zig-zags like a real client would (one input message per tick)
    const ph = Math.floor((liveSec * 1000) / 500) % 2;
    lobby.handle(host, { t: 'input', seq: ++seq, fwd: 1, strafe: ph ? 1 : -1, facing: 0.5 } as any);
    const a = hr();
    lobby.tick();
    t.total += hr() - a;
    t.ticks++;
    liveSec += T / 1000;
  }
  const n = room.sim.units.size;
  return { units: n, msPerTick: t.total / t.ticks, stepMs: t.step / t.ticks, botMs: t.bots / t.ticks, otherMs: (t.total - t.step - t.bots) / t.ticks, ticks: t.ticks, bytesPerSec: bytes / liveSec, msgsPerSec: msgs / liveSec, frames, matches };
}

function encodeStudy(frames: string[], T: number) {
  const snaps = frames.map((s) => JSON.parse(s)).filter((m) => m.t === 'snapshot');
  const raw = snaps.map((m) => JSON.stringify(m).length);
  const avgRaw = mean(raw);
  // permessage-deflate: per message (no context takeover), and a streaming deflater with context takeover (sync flush per message)
  const noTakeover = mean(frames.slice(0, 600).map((s) => zlib.deflateRawSync(Buffer.from(s)).length));
  const sampleN = Math.min(600, frames.length);
  const d = zlib.createDeflateRaw();
  let outBytes = 0;
  d.on('data', (c: Buffer) => (outBytes += c.length));
  for (const s of frames.slice(0, sampleN)) { d.write(s); d.flush(zlib.constants.Z_SYNC_FLUSH); }
  // flush is async: measured after the loop in the caller
  const cpuT0 = process.hrtime.bigint();
  for (const s of frames.slice(0, sampleN)) zlib.deflateRawSync(Buffer.from(s));
  const deflateUs = Number(process.hrtime.bigint() - cpuT0) / 1e3 / sampleN;
  // what the bytes of one unit are made of (20 Hz order of magnitude; share of the JSON)
  const part: Record<string, number> = { identity: 0, motion: 0, state: 0 };
  const ID = new Set(['name', 'team', 'classId', 'spec', 'look', 'bar', 'trinket', 'stealthSwaps', 'maxHealth', 'resourceMax', 'resourceType', 'id']);
  const MO = new Set(['x', 'z', 'facing', 'y', 'lastSeq']);
  let units = 0;
  for (const m of snaps.slice(0, 200)) for (const u of m.snap.units) {
    units++;
    for (const [k, v] of Object.entries(u)) part[ID.has(k) ? 'identity' : MO.has(k) ? 'motion' : 'state'] += k.length + 4 + JSON.stringify(v).length;
  }
  for (const k of Object.keys(part)) part[k] /= Math.max(1, units);
  return { snaps, avgRaw, noTakeover, d, sampleN, deflateUs, part, getOut: () => outBytes };
}

/** Fast part (positions, facing, height) as fixed binary; slow part (everything else) as JSON diff against the previous sent snapshot. */
function deltaBinary(snaps: any[], T: number) {
  const fastEvery = 1;
  const slowEvery = Math.max(1, Math.round(50 / T)); // slow state is sent at most 20 times a second
  let fastBytes = 0, slowBytes = 0, slowMsgs = 0;
  let prevSlow: any = null;
  let evAcc: any[] = [];
  snaps.forEach((m, i) => {
    const s = m.snap;
    fastBytes += 6 + s.units.length * 9 + 2; // header (type,tick lo 4 B, count) + id,x,z,facing,y,flags per unit + lastSeq of the receiver
    evAcc.push(...m.events);
    if (i % slowEvery !== 0) return;
    const slow: any = {};
    const cur: any = {};
    for (const u of s.units) {
      const { x, z, facing, y, lastSeq, ...rest } = u;
      cur[u.id] = JSON.stringify(rest);
      if (!prevSlow || prevSlow[u.id] !== cur[u.id]) slow[u.id] = rest; // unchanged units are skipped entirely
    }
    prevSlow = cur;
    const body = { u: slow, ev: evAcc, ph: s.phase, w: s.winner, z: s.zones?.length ? s.zones : undefined };
    evAcc = [];
    const js = JSON.stringify(body);
    if (js.length > 40) { slowBytes += js.length; slowMsgs++; } else slowBytes += js.length; // tiny ones still carry a header
  });
  return { fast: fastBytes / snaps.length, slow: slowBytes / snaps.length };
}

// ---------------------------------------------------------------------------------------------------------------------
// timer section: how the server loop of server/src/index.ts:246-262 really ticks in Node
// ---------------------------------------------------------------------------------------------------------------------
async function runTimer(T: number, loopMs: number, seconds: number, busyMs: number) {
  const out: number[] = [];
  let last = performance.now(), acc = 0, lastTick = 0, bursts = 0, cbs = 0;
  await new Promise<void>((resolve) => {
    const t0 = performance.now();
    const h = setInterval(() => {
      const now = performance.now();
      acc += now - last;
      last = now;
      let n = 0;
      while (acc >= T && n < 5) {
        acc -= T; n++;
        const a = performance.now();
        if (lastTick) out.push(a - lastTick);
        lastTick = a;
        if (busyMs) { const e = performance.now() + busyMs; while (performance.now() < e); }
      }
      cbs++;
      if (n > 1) bursts++;
      if (now - t0 > seconds * 1000) { clearInterval(h); resolve(); }
    }, loopMs);
  });
  return { n: out.length, mean: mean(out), sd: Math.sqrt(mean(out.map((x) => (x - mean(out)) ** 2))), p99: pct(out, 99), max: Math.max(...out), burstPct: (100 * bursts) / cbs, gapsPct: (100 * out.filter((x) => x < T * 0.5).length) / out.length };
}

async function wsSendCost() {
  const { WebSocketServer, WebSocket } = await import('ws');
  const wss = new WebSocketServer({ port: 0 });
  const port = (wss.address() as any).port;
  const socks: any[] = [];
  wss.on('connection', (s) => socks.push(s));
  const clients: any[] = [];
  for (let i = 0; i < 6; i++) {
    const c = new WebSocket(`ws://127.0.0.1:${port}`);
    c.on('message', () => {});
    clients.push(c);
    await new Promise((r) => c.once('open', r));
  }
  await new Promise((r) => setTimeout(r, 50));
  const res: Record<number, number> = {};
  for (const size of [1000, 3000]) {
    const msg = 'x'.repeat(size);
    for (let i = 0; i < 2000; i++) for (const s of socks) s.send(msg);
    await new Promise((r) => setTimeout(r, 200));
    const a = process.hrtime.bigint();
    const N = 6000;
    for (let i = 0; i < N / socks.length; i++) for (const s of socks) s.send(msg);
    res[size] = Number(process.hrtime.bigint() - a) / 1e3 / N; // microseconds per send
    await new Promise((r) => setTimeout(r, 300));
  }
  for (const c of clients) c.terminate();
  wss.close();
  return res;
}

// ---------------------------------------------------------------------------------------------------------------------
// rules drift section: same scripted situations at different tick lengths
// ---------------------------------------------------------------------------------------------------------------------
function rulesScenarios(M: Mods) {
  const { ArenaSim, Bot, TUNING } = M;
  const T = TUNING.tickMs;
  const out: Record<string, number> = {};
  const mk = () => new ArenaSim({ seed: 3, prepMs: 0 });
  const add = (sim: any, classId: string, team: number, x: number, z: number, controller = 'player', spec?: string) => {
    const u = sim.addUnit({ name: classId + team, classId, team, controller, ...(spec ? { build: { spec, talents: [], gear: {} } } : {}) });
    u.pos = { x, z };
    return u;
  };
  const runFor = (sim: any, ms: number, each?: (t: number) => void, ev?: (e: any, t: number) => void) => {
    const n = Math.round(ms / T);
    for (let i = 0; i < n; i++) {
      each?.(sim.time);
      sim.step();
      for (const e of sim.drainEvents()) ev?.(e, sim.time);
    }
  };
  // 1. a 1500 ms Frostbolt: ms from pressing to damage
  {
    const sim = mk(); const m = add(sim, 'mage', 0, 0, 0); const w = add(sim, 'warrior', 1, 12, 0, 'dummy');
    sim.step(); sim.drainEvents();
    sim.useAbility(m.id, 'frostbolt', w.id);
    const t0 = sim.time; let hit = NaN;
    runFor(sim, 3000, undefined, (e, t) => { if (e.t === 'damage' && e.ability === 'frostbolt' && Number.isNaN(hit)) hit = t - t0; });
    out['frostbolt press->damage (ms, ideal 1500)'] = hit;
  }
  // 2. Frostbolt chain for 12 s: casts completed (cast time + GCD rounding accumulates)
  {
    const sim = mk(); const m = add(sim, 'mage', 0, 0, 0); const w = add(sim, 'warrior', 1, 12, 0, 'dummy');
    m.resource = 1e6; m.resourceMax = 1e6; w.health = w.maxHealth = 1e9;
    sim.step(); sim.drainEvents();
    let n = 0, at8 = NaN;
    runFor(sim, 14000, () => { sim.useAbility(m.id, 'frostbolt', w.id); }, (e, t) => { if (e.t === 'damage' && e.ability === 'frostbolt' && ++n === 8) at8 = t; });
    out['frostbolt chain: 8th cast lands at (ms, ideal 12000 + press delay)'] = at8;
  }
  // 3. instant on GCD: sinister strike spam for 12 s
  {
    const sim = mk(); const r = add(sim, 'rogue', 0, 0, 0); const w = add(sim, 'warrior', 1, 1.5, 0, 'dummy');
    r.resource = r.resourceMax = 1e6; w.health = w.maxHealth = 1e9;
    sim.step(); sim.drainEvents();
    let n = 0;
    runFor(sim, 12000, () => { sim.useAbility(r.id, 'sinister_strike', w.id); }, (e) => { if (e.t === 'damage' && e.ability === 'sinister_strike') n++; });
    out['sinister strikes in 12 s on 1000 ms GCD (ideal 12)'] = n;
  }
  // 4. Mind Flay channel: ms from press to the last tick, ticks counted
  {
    const sim = mk(); const p = add(sim, 'priest', 0, 0, 0, 'player', 'shadow'); const w = add(sim, 'warrior', 1, 10, 0, 'dummy');
    w.health = w.maxHealth = 1e9;
    sim.step(); sim.drainEvents();
    sim.useAbility(p.id, 'mind_flay', w.id);
    const t0 = sim.time; let n = 0, last = 0;
    runFor(sim, 4000, undefined, (e, t) => { if (e.t === 'damage' && e.ability === 'mind_flay') { n++; last = t - t0; } });
    out['mind flay ticks (ideal 6)'] = n;
    out['mind flay last tick at (ms, ideal 3000)'] = last;
  }
  // 5. Garrote bleed: ticks in 9 s
  {
    const sim = mk(); const r = add(sim, 'rogue', 0, 0, 0, 'player', 'assassination'); const w = add(sim, 'warrior', 1, 1.5, 0, 'dummy');
    w.health = w.maxHealth = 1e9;
    sim.step(); sim.drainEvents();
    sim.useAbility(r.id, 'garrote', w.id);
    let n = 0, total = 0;
    runFor(sim, 9500, undefined, (e) => { if (e.t === 'damage' && e.ability === 'garrote') { n++; total += e.amount; } });
    out['garrote hits in 9.5 s (1 + 8 bleed ticks)'] = n;
    out['garrote total damage'] = total;
  }
  // 6. Kidney shot stun: ms from application to removal
  {
    const sim = mk(); const r = add(sim, 'rogue', 0, 0, 0); const w = add(sim, 'warrior', 1, 1.5, 0, 'dummy');
    r.cp = 3;
    sim.step(); sim.drainEvents();
    sim.useAbility(r.id, 'kidney_shot', w.id);
    const p0 = sim.time;
    let b = NaN;
    runFor(sim, 7000, undefined, (e, t) => { if (e.t === 'aura_removed' && e.aura === 'kidney_shot') b = t - p0; });
    out['kidney shot stun: press -> removed (ms; data says 4400)'] = b;
  }
  // 7. auto attack swings in 20 s (2000 ms interval)
  {
    const sim = mk(); const w = add(sim, 'warrior', 0, 0, 0); const d = add(sim, 'warrior', 1, 1.5, 0, 'dummy');
    d.health = d.maxHealth = 1e9;
    sim.step(); sim.drainEvents();
    sim.setTarget(w.id, d.id); sim.setAutoAttack(w.id, true);
    let n = 0;
    runFor(sim, 20000, () => { w.lastCombatAt = sim.time; }, (e) => { if (e.t === 'damage' && e.src === w.id && e.ability === null) n++; });
    out['auto attacks in 20 s (2000 ms interval, ideal 10)'] = n;
  }
  // 8. running 5 s with one input per tick
  {
    const sim = mk(); const w = add(sim, 'warrior', 0, -20, 0); add(sim, 'warrior', 1, 20, 0, 'dummy');
    sim.step(); sim.drainEvents();
    const x0 = w.pos.x; let seq = 0;
    runFor(sim, 5000, () => sim.queueInput(w.id, { seq: ++seq, fwd: 1, strafe: 0, facing: Math.PI / 2 }));
    out['distance run in 5 s (ideal 35 at speed 7)'] = Math.hypot(w.pos.x - x0, w.pos.z);
  }
  // 9. mana after 10 s of rest
  {
    const sim = mk(); const m = add(sim, 'mage', 0, 0, 0); add(sim, 'warrior', 1, 20, 0, 'dummy');
    sim.step(); sim.drainEvents();
    m.resource = 0;
    runFor(sim, 10000);
    out['mana regained in 10 s'] = m.resource;
  }
  return out;
}

function botMatches(M: Mods, perPair: number) {
  const { ArenaSim, Bot, TUNING, ReplayRecorder, ReplayRunner } = M;
  const T = TUNING.tickMs;
  const pairs: [string, string][] = [['warrior', 'mage'], ['rogue', 'priest'], ['mage', 'rogue'], ['warrior', 'priest']];
  let wins0 = 0, wins1 = 0, draws = 0, dur = 0, dmg = 0, n = 0;
  let replayJson = 0, replayGz = 0, replayN = 0, replayOk = 0, cmdsN = 0;
  for (const [c0, c1] of pairs) {
    for (let s = 1; s <= perPair; s++) {
      const sim = new ArenaSim({ seed: s, prepMs: 0, facing: true });
      const rec = s === 1 ? new ReplayRecorder(sim, { arena: sim.arena.id, seed: s, prepMs: 0 }) : null;
      const bots: any[] = [];
      for (const [i, c] of [c0, c1].entries()) {
        const u = sim.addUnit({ name: c + i, classId: c, team: i, controller: 'bot' });
        bots.push(new Bot(sim, u.id, 'hard', 100 + s * 10 + i));
      }
      let d = 0;
      while (sim.phase !== 'ended' && sim.time < 150000) {
        for (const b of bots) b.tick();
        sim.step();
        for (const e of sim.drainEvents()) if (e.t === 'damage') d += e.amount;
      }
      n++;
      dur += sim.time; dmg += d;
      if (rec) {
        const data = rec.finish([]);
        const js = JSON.stringify(data);
        replayJson += js.length; replayGz += zlib.gzipSync(js).length; cmdsN += data.cmds.length; replayN++;
        const rr = new ReplayRunner(data);
        while (!rr.done) rr.step();
        if (rr.sim.winner === sim.winner && rr.sim.tickNo === sim.tickNo) replayOk++;
      }
      if (sim.winner === 0) wins0++; else if (sim.winner === 1) wins1++; else draws++;
    }
  }
  return { n, team0Wins: wins0, team1Wins: wins1, draws, meanDurS: dur / n / 1000, meanDamage: dmg / n, replayJsonKB: replayJson / replayN / 1024, replayGzKB: replayGz / replayN / 1024, replayCmds: cmdsN / replayN, replayDeterministic: `${replayOk}/${replayN}` };
}

// ---------------------------------------------------------------------------------------------------------------------
// child entry
// ---------------------------------------------------------------------------------------------------------------------
async function childMain() {
  const spec = childSpec;
  const data = await import('../shared/src/data');
  data.TUNING.tickMs = spec.tickMs;
  const M = await import('../shared/src/index');
  if (M.TUNING.tickMs !== spec.tickMs) throw new Error('tickMs override failed');
  const out: any = { tickMs: spec.tickMs };
  const sections: string[] = spec.sections;
  if (sections.includes('net')) {
    out.net = [];
    for (const cfg of spec.cfgs as NetCfg[]) {
      const rs: NetResult[] = [];
      for (let s = 1; s <= spec.seeds; s++) rs.push(runNet(M, cfg, s, spec.durMs));
      out.net.push({ cfg, sum: summarise(pool(rs)) });
    }
  }
  if (sections.includes('cpu') || sections.includes('bw')) {
    out.room = {};
    for (const units of [2, 4, 6] as const) {
      const r = await runRoom(M, units, spec.cpuSeconds, true);
      const enc = encodeStudy(r.frames, spec.tickMs);
      await new Promise((res) => enc.d.flush(() => res(null)));
      await new Promise((res) => setTimeout(res, 20));
      const db = deltaBinary(enc.snaps, spec.tickMs);
      out.room[units] = {
        units: r.units, msPerTick: r.msPerTick, stepMs: r.stepMs, botMs: r.botMs, otherMs: r.otherMs, ticks: r.ticks, matches: r.matches,
        jsonBytesPerSnap: enc.avgRaw, deflateUs: enc.deflateUs, partPerUnit: enc.part, jsonBytesPerSec: enc.avgRaw * (1000 / spec.tickMs), deflateNoTakeoverPerSnap: enc.noTakeover,
        deflateTakeoverPerSnap: enc.getOut() / enc.sampleN, binFast: db.fast, deltaSlow: db.slow, binTotalPerSnap: db.fast + db.slow,
      };
    }
  }
  if (sections.includes('rules')) out.rules = rulesScenarios(M);
  if (sections.includes('bots')) out.bots = botMatches(M, spec.botSeeds);
  process.stdout.write('\nNETSTUDY_RESULT ' + JSON.stringify(out) + '\n');
}

async function timerChild() {
  const out: any = {};
  out.ws = await wsSendCost();
  out.timers = [];
  for (const T of [50, 1000 / 30, 1000 / 60, 1000 / 120]) {
    for (const loopMs of [10, 1]) {
      for (const busy of [0, T * 0.4]) {
        out.timers.push({ T, loopMs, busyMs: busy, ...(await runTimer(T, loopMs, 8, busy)) });
      }
    }
  }
  process.stdout.write('\nNETSTUDY_RESULT ' + JSON.stringify(out) + '\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// orchestrator
// ---------------------------------------------------------------------------------------------------------------------
function runChild(spec: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', SELF], { env: { ...process.env, NETSTUDY_CHILD: JSON.stringify(spec) }, stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.on('close', (code) => {
      const m = buf.match(/NETSTUDY_RESULT (.*)\n/);
      if (!m) return reject(new Error(`child failed (${code}): ${buf.slice(-500)}`));
      resolve(JSON.parse(m[1]));
    });
  });
}

const TICKS: Record<string, number> = { '20 Hz': 50, '30 Hz': 1000 / 30, '60 Hz': 1000 / 60, '120 Hz': 1000 / 120, '128 Hz': 1000 / 128 };
const hz = (T: number) => `${f(1000 / T, 0)} Hz`;

function table(head: string[], rows: (string | number)[][]) {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r: (string | number)[]) => '| ' + r.map((c, i) => String(c).padEnd(w[i])).join(' | ') + ' |';
  return [line(head), '| ' + w.map((x) => '-'.repeat(x)).join(' | ') + ' |', ...rows.map(line)].join('\n');
}

async function orchestrate() {
  const args = process.argv.slice(2);
  const quick = args.includes('--quick');
  const only = (args.includes('--only') ? args[args.indexOf('--only') + 1] : 'net,bw,cpu,timer,rules,bots').split(',');
  const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
  const seeds = quick ? 1 : 3;
  const durMs = quick ? 30000 : 60000;
  const all: any = {};
  const log = (s: string) => console.log(s);

  // ------------------------------------------------ net: table A (current settings across network conditions)
  const base = (over: Partial<NetCfg> = {}): NetCfg => ({ name: 'current', tickMs: 50, snapMs: 50, delay: 100, extrap: false, clock: 'naive', owd: 50, jitter: 10, loss: 1, fps: 60, ...over });
  const cfgsByTick = new Map<number, NetCfg[]>();
  const addCfg = (c: NetCfg) => { const l = cfgsByTick.get(c.tickMs) ?? []; l.push(c); cfgsByTick.set(c.tickMs, l); };
  if (only.includes('net')) {
    for (const owd of [20, 50, 100]) for (const jitter of [0, 10, 30]) for (const loss of [0, 1, 3]) addCfg(base({ name: `A ${owd}/${jitter}/${loss}`, owd, jitter, loss }));
    const nets: [string, number, number, number][] = [['LAN-ish 20/0/0', 20, 0, 0], ['clean 50/10/0', 50, 10, 0], ['lossy 50/10/1', 50, 10, 1], ['bad 100/30/3', 100, 30, 3]];
    for (const [nn, owd, jitter, loss] of nets) {
      const b = (name: string, over: Partial<NetCfg>) => addCfg(base({ name: `B ${nn} | ${name}`, owd, jitter, loss, ...over }));
      b('20/20 d100 (now)', {});
      b('20/20 d100 smooth clock', { clock: 'smooth' });
      b('20/20 d66', { delay: 66 });
      b('20/20 d50', { delay: 50 });
      b('20/20 d50 +extrap', { delay: 50, extrap: true });
      b('20/20 d100 +extrap', { extrap: true });
      b('20/20 adaptive+smooth+extrap', { delay: 'adaptive', clock: 'smooth', extrap: true });
      b('20/20 d100 +input cap2', { qpolicy: 'cap2' });
      b('20/20 d100 +input catch-up', { qpolicy: 'catchup' });
      b('20/20 d66 smooth+extrap+catch-up', { delay: 66, clock: 'smooth', extrap: true, qpolicy: 'catchup' });
      b('20/20 d66 smooth+extrap+catch-up +own-ahead', { delay: 66, clock: 'smooth', extrap: true, qpolicy: 'catchup', own: 'ahead' });
      b('62.5/62.5 d2snap smooth+extrap+catch-up +own-ahead', { tickMs: 16, snapMs: 16, delay: '2snap', clock: 'smooth', extrap: true, qpolicy: 'catchup', own: 'ahead' });
      b('20/40 fill d2snap', { snapMs: 25, delay: '2snap' });
      b('20/60 fill d2snap', { snapMs: 1000 / 60, delay: '2snap' });
      for (const [lab, T] of [['30', 1000 / 30], ['40', 25], ['60', 1000 / 60], ['62.5', 16], ['120', 1000 / 120], ['125', 8], ['128', 1000 / 128]] as [string, number][]) {
        b(`${lab}/${lab} d100`, { tickMs: T, snapMs: T, delay: 100 });
        b(`${lab}/${lab} d2snap`, { tickMs: T, snapMs: T, delay: '2snap' });
        b(`${lab}/${lab} d2snap smooth+extrap`, { tickMs: T, snapMs: T, delay: '2snap', clock: 'smooth', extrap: true });
      }
      b('60/60 d2snap smooth+extrap+catch-up', { tickMs: 1000 / 60, snapMs: 1000 / 60, delay: '2snap', clock: 'smooth', extrap: true, qpolicy: 'catchup' });
      b('120/120 d2snap smooth+extrap+catch-up', { tickMs: 1000 / 120, snapMs: 1000 / 120, delay: '2snap', clock: 'smooth', extrap: true, qpolicy: 'catchup' });
      b('60 sim / 30 snap d2snap', { tickMs: 1000 / 60, snapMs: 1000 / 30, delay: '2snap' });
      b('60 sim / 30 snap d66 smooth', { tickMs: 1000 / 60, snapMs: 1000 / 30, delay: 66, clock: 'smooth' });
      b('120 sim / 60 snap d2snap', { tickMs: 1000 / 120, snapMs: 1000 / 60, delay: '2snap' });
      b('120/120 d2snap, 144 fps', { tickMs: 1000 / 120, snapMs: 1000 / 120, delay: '2snap', fps: 144 });
    }
  }
  const tickSet = new Set<number>([...cfgsByTick.keys()]);
  const need = (s: string) => only.includes(s);
  const roomTicks = need('bw') || need('cpu') ? [50, 1000 / 30, 1000 / 60, 1000 / 120, 1000 / 128] : [];
  const ruleTicks = need("rules") || need("bots") ? [50, 40, 1000 / 30, 25, 20, 1000 / 60, 16, 10, 1000 / 120, 8, 1000 / 128] : [];

  // net + rules + bots children can run in parallel (they measure virtual time); the cpu children run one at a time afterwards
  const jobs: (() => Promise<any>)[] = [];
  const netRes: any[] = [];
  const ruleRes: any[] = [];
  for (const [T, cfgs] of cfgsByTick) jobs.push(() => runChild({ tickMs: T, sections: ['net'], cfgs, seeds, durMs }).then((r) => netRes.push(r)));
  for (const T of ruleTicks) jobs.push(() => runChild({ tickMs: T, sections: [need('rules') ? 'rules' : '', need('bots') ? 'bots' : ''].filter(Boolean), botSeeds: quick ? 3 : 10 }).then((r) => ruleRes.push(r)));
  {
    // at most 3 children at a time
    let next = 0;
    await Promise.all([0, 1, 2].map(async () => { while (next < jobs.length) await jobs[next++](); }));
  }

  // ------------------------------------------------ print net
  if (netRes.length) {
    const rows = netRes.flatMap((r) => r.net).map((x: any) => ({ cfg: x.cfg as NetCfg, s: x.sum }));
    all.net = rows;
    const get = (name: string) => rows.find((r) => r.cfg.name === name);
    log('\n## A. Current setup (20 Hz sim, 20 Hz snapshots, 100 ms interpolation, no extrapolation) across network conditions');
    log('One-way latency / jitter (extra 0..J ms per packet) / loss % each way. Remote unit shown vs the server\'s true position at the same wall-clock instant ("staleness"), and vs the true path at the instant being shown ("reconstruction").\n');
    log(table(['net', 'age ms', 'stale mean', 'p95', 'max', 'recon mean', 'p95', 'corr mean', 'p95', 'max', 'corr >5cm %', 'pops/min', 'rt back/min', 'c1 ms', 'c2 ms', 'c3 ms', 'castErr p95', 'drop/min', 'qlen'],
      rows.filter((r) => r.cfg.name.startsWith('A ')).map((r) => [r.cfg.name.slice(2), f(r.s.ageMean, 0), f(r.s.staleMean), f(r.s.staleP95), f(r.s.staleMax), f(r.s.reconMean), f(r.s.reconP95), f(r.s.corrMean, 3), f(r.s.corrP95, 3), f(r.s.corrMax, 2), f(r.s.corrFreq, 1), f(r.s.pops, 1), f(r.s.backwards, 1), f(r.s.c1, 0), f(r.s.c2, 0), f(r.s.c3, 0), f(r.s.castErrP95), f(r.s.dropped, 1), f(r.s.qlen, 2)])));
    for (const nn of ['LAN-ish 20/0/0', 'clean 50/10/0', 'lossy 50/10/1', 'bad 100/30/3']) {
      log(`\n## B. Hypothetical settings at ${nn} (one-way ms / jitter ms / loss %)\n`);
      log(table(['setting', 'age ms', 'stale mean', 'p95', 'recon mean', 'p95', 'max', 'corr mean', 'p95', 'corr>5cm %', 'pops/min', 'rt back/min', 'underrun %', 'c1 ms', 'c2 ms', 'c3 ms', 'castErr mean', 'p95', 'rej %', 'acc %', 'rewind ms', 'clamp %', 'hist clamp %', 'drop/min', 'qlen', 'starve %'],
        rows.filter((r) => r.cfg.name.startsWith(`B ${nn}`)).map((r) => [r.cfg.name.split(' | ')[1], f(r.s.ageMean, 0), f(r.s.staleMean), f(r.s.staleP95), f(r.s.reconMean), f(r.s.reconP95), f(r.s.reconMax), f(r.s.corrMean, 3), f(r.s.corrP95, 3), f(r.s.corrFreq, 1), f(r.s.pops, 1), f(r.s.backwards, 1), f(r.s.underrun, 1), f(r.s.c1, 0), f(r.s.c2, 0), f(r.s.c3, 0), f(r.s.castErrMean), f(r.s.castErrP95), f(r.s.wrongReject, 1), f(r.s.wrongAccept, 1), f(r.s.rewind, 0), f(r.s.clamped, 1), f(r.s.windowClamped, 1), f(r.s.dropped, 1), f(r.s.qlen, 2), f(r.s.starved, 1)])));
    }
    void get;
  }

  // ------------------------------------------------ cpu / bandwidth (serial, nothing else running)
  if (roomTicks.length) {
    const roomRes: any[] = [];
    for (const T of roomTicks) roomRes.push(await runChild({ tickMs: T, sections: ['cpu'], cpuSeconds: quick ? 20 : 120 }));
    all.room = roomRes;
    log('\n## E. Server CPU: one Room (real Lobby.tick, hard bots, fake sockets) on this machine (Xeon 2.8 GHz)\n');
    const rowsE: (string | number)[][] = [];
    for (const r of roomRes) for (const u of [2, 4, 6]) {
      const x = r.room[u];
      rowsE.push([hz(r.tickMs), x.units, f(x.msPerTick, 4), f(x.stepMs, 4), f(x.botMs, 4), f(x.otherMs, 4), f(x.msPerTick * (1000 / r.tickMs), 1), f((x.msPerTick * (1000 / r.tickMs)) / 10, 2) + ' %']);
    }
    log(table(['tick', 'units', 'ms/tick', 'sim.step', 'bots', 'snapshots+rest', 'ms CPU per s of match', '% of 1 core'], rowsE));
    log('\n## F. Bandwidth per client (current JSON snapshots, one per tick) and cheap improvements, estimated by actually encoding\n');
    const rowsF: (string | number)[][] = [];
    for (const r of roomRes) for (const u of [2, 4, 6]) {
      const x = r.room[u];
      const sps = 1000 / r.tickMs;
      rowsF.push([hz(r.tickMs), x.units, f(x.jsonBytesPerSnap, 0), f((x.jsonBytesPerSec / 1024), 1), f((x.deflateNoTakeoverPerSnap * sps) / 1024, 1), f((x.deflateTakeoverPerSnap * sps) / 1024, 1), f(x.binFast + x.deltaSlow, 0), f(((x.binFast + x.deltaSlow) * sps) / 1024, 1)]);
    }
    log(table(['tick', 'units', 'JSON B/snap', 'JSON KB/s', 'deflate/msg KB/s', 'deflate+ctx KB/s', 'bin+delta B/snap', 'bin+delta KB/s'], rowsF));
  }
  // ------------------------------------------------ timers
  if (need('timer')) {
    const t = await runChild2();
    all.timer = t;
    log('\n## Server loop timing (server/src/index.ts: setInterval(10) + accumulator), Node ' + process.version + '\n');
    log(table(['tick ms', 'setInterval ms', 'busy ms/tick', 'ticks', 'mean gap', 'sd', 'p99 gap', 'max gap', '% callbacks with >1 tick', '% gaps < T/2'], t.timers.map((x: any) => [f(x.T, 2), x.loopMs, f(x.busyMs, 1), x.n, f(x.mean, 2), f(x.sd, 2), f(x.p99, 1), f(x.max, 1), f(x.burstPct, 1), f(x.gapsPct, 1)])));
    log(`\nws.send cost to a loopback client (6 sockets): ${f(t.ws[1000], 1)} us per 1 KB message, ${f(t.ws[3000], 1)} us per 3 KB message`);
  }
  // ------------------------------------------------ rules
  if (ruleRes.length) {
    ruleRes.sort((a, b) => b.tickMs - a.tickMs);
    all.rules = ruleRes;
    if (need('rules')) {
      log('\n## Rules drift: the same scripted situations at different tickMs (sim reads TUNING.tickMs once; nothing else changed)\n');
      const keys = Object.keys(ruleRes[0].rules);
      log(table(['scenario', ...ruleRes.map((r) => `${f(r.tickMs, 2)} ms`)], keys.map((k) => [k, ...ruleRes.map((r) => f(r.rules[k], 1))])));
    }
    if (need('bots')) {
      log('\n## Bot matches per tick length (hard bots, 1v1, 4 class pairs x N seeds)\n');
      log(table(['tickMs', 'matches', 'team0 wins', 'team1 wins', 'draws', 'mean length s', 'mean damage dealt', 'replay cmds', 'replay JSON KB', 'replay gz KB', 'replay re-sim ok'], ruleRes.map((r) => [f(r.tickMs, 2), r.bots.n, r.bots.team0Wins, r.bots.team1Wins, r.bots.draws, f(r.bots.meanDurS, 1), f(r.bots.meanDamage, 0), f(r.bots.replayCmds, 0), f(r.bots.replayJsonKB, 0), f(r.bots.replayGzKB, 1), r.bots.replayDeterministic])));
    }
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(all, null, 1));
}

function runChild2(): Promise<any> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', SELF], { env: { ...process.env, NETSTUDY_CHILD: '', NETSTUDY_TIMER: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.on('close', () => {
      const m = buf.match(/NETSTUDY_RESULT (.*)\n/);
      m ? resolve(JSON.parse(m[1])) : reject(new Error('timer child failed'));
    });
  });
}

if (process.env.NETSTUDY_TIMER) await timerChild();
else if (childSpec) await childMain();
else await orchestrate();
