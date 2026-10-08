import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NetClock, RttEstimator, percentile } from '../src/netClock';
import { InterpDelay, IntervalTracker, RenderTime, poseAt, targetDelay } from '../src/interpDelay';
import { NetStats } from '../src/netStats';
import { ownAhead } from '../src/ownAhead';

/** Deterministic pseudo random numbers. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** Snapshots every 50 ms of server time, arriving after owd + U(0, jitter); returns them in arrival order. */
function link(n: number, owd: number, jitter: number, seed = 1, offset = 123456) {
  const r = rng(seed);
  const out: { server: number; at: number }[] = [];
  for (let i = 0; i < n; i++) {
    const server = i * 50;
    out.push({ server, at: server - offset + owd + r() * jitter });
  }
  return out.sort((a, b) => a.at - b.at);
}

describe('NetClock', () => {
  it('never runs backwards under heavy jitter and reordering, polled every 4 ms', () => {
    const clock = new NetClock();
    const pkts = link(600, 40, 80, 7);
    let last = -Infinity;
    let k = 0;
    for (let t = pkts[0].at; t < pkts[pkts.length - 1].at; t += 4) {
      while (k < pkts.length && pkts[k].at <= t) clock.sample(pkts[k].server, pkts[k++].at);
      const v = clock.now(t);
      assert.ok(v >= last, `${v} < ${last}`);
      last = v;
    }
  });

  it('tracks server time within the minimum network delay, and far smoother than the raw last-snapshot estimate', () => {
    const clock = new NetClock();
    const pkts = link(400, 50, 30, 3);
    let k = 0;
    const err: number[] = [];
    const raw: number[] = [];
    let latest = pkts[0];
    for (let t = pkts[0].at; t < pkts[pkts.length - 1].at; t += 16) {
      while (k < pkts.length && pkts[k].at <= t) {
        clock.sample(pkts[k].server, pkts[k].at);
        latest = pkts[k++];
      }
      if (t < pkts[0].at + 2500) continue; // warm-up
      const trueServer = t + 123456; // server time at local t, with zero delay
      err.push(trueServer - clock.now(t));
      raw.push(trueServer - (latest.server + (t - latest.at)));
    }
    const sd = (a: number[]) => { const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
    // behind the true time by about the shortest one-way delay (50 ms) plus a little
    const mean = err.reduce((s, v) => s + v, 0) / err.length;
    assert.ok(mean > 45 && mean < 85, `mean lag ${mean}`);
    assert.ok(sd(err) < sd(raw), `smoothed sd ${sd(err)} should beat raw ${sd(raw)}`);
    assert.ok(sd(err) < 6, `sd ${sd(err)}`);
  });

  it('a fast snapshot moves the clock by at most a tenth of the change, not all at once', () => {
    const clock = new NetClock();
    for (let i = 0; i < 40; i++) clock.sample(i * 50, i * 50 + 80); // steady 80 ms delay
    const before = clock.now(2000);
    clock.sample(2000, 2000 + 20); // one snapshot 60 ms faster
    const after = clock.now(2000);
    assert.ok(after - before > 0 && after - before <= 6.5, `${after - before}`);
  });

  it('adopts a new clock at once after reset (another match) or a big jump forward', () => {
    const clock = new NetClock();
    for (let i = 0; i < 20; i++) clock.sample(100000 + i * 50, i * 50);
    clock.reset();
    clock.sample(0, 1000);
    clock.sample(50, 1050);
    assert.ok(Math.abs(clock.now(1050) - 50) < 5, `${clock.now(1050)}`);
    clock.sample(5000, 1100); // the server clock is 5 s further ahead than we thought
    assert.ok(Math.abs(clock.now(1100) - 5000) < 5, `${clock.now(1100)}`);
  });

  it('reports the lateness of the link', () => {
    const quiet = new NetClock();
    const noisy = new NetClock();
    for (const p of link(200, 50, 2, 1)) quiet.sample(p.server, p.at);
    for (const p of link(200, 50, 60, 1)) noisy.sample(p.server, p.at);
    assert.ok(quiet.latenessP95() < 5);
    assert.ok(noisy.latenessP95() > 30);
    assert.equal(percentile([], 0.5), 0);
  });
});

describe('RttEstimator', () => {
  it('smooths and measures jitter, ignores junk', () => {
    const r = new RttEstimator();
    r.add(NaN);
    r.add(-5);
    assert.ok(Number.isNaN(r.rtt));
    for (let i = 0; i < 40; i++) r.add(100 + (i % 2 ? 10 : -10));
    assert.ok(Math.abs(r.rtt - 100) < 5);
    assert.ok(r.jitter > 5 && r.jitter < 25);
  });
});

describe('adaptive interpolation delay', () => {
  it('stays at about 1.5 intervals on a quiet link and grows with jitter, inside 60..200 ms', () => {
    assert.equal(targetDelay(50, 0), 75);
    assert.ok(targetDelay(50, 40) >= 100);
    assert.equal(targetDelay(50, 500), 200);
    assert.equal(targetDelay(10, 0), 60);
  });

  it('rises quickly and falls slowly', () => {
    const d = new InterpDelay();
    for (let i = 0; i < 100; i++) d.update(50, 0);
    assert.ok(d.delay < 80, `${d.delay}`);
    for (let i = 0; i < 5; i++) d.update(50, 80);
    const up = d.delay;
    assert.ok(up > 100, `${up}`);
    for (let i = 0; i < 5; i++) d.update(50, 0);
    assert.ok(up - d.delay < 8, 'falls slowly');
  });

  it('tracks the snapshot interval', () => {
    const t = new IntervalTracker();
    for (let i = 0; i < 10; i++) t.add(i * 50);
    assert.equal(t.mean, 50);
  });

  it('the delay chosen from a jittery link leaves almost no frame past the newest snapshot', () => {
    for (const [jitter, limit] of [[0, 0.5], [30, 4], [80, 12]] as const) {
      const clock = new NetClock();
      const iv = new IntervalTracker();
      const d = new InterpDelay();
      const pkts = link(1200, 50, jitter, 11);
      let k = 0;
      let newest = -1;
      let frames = 0;
      let under = 0;
      for (let t = pkts[0].at; t < pkts[pkts.length - 1].at; t += 16) {
        while (k < pkts.length && pkts[k].at <= t) {
          const p = pkts[k++];
          clock.sample(p.server, p.at);
          iv.add(p.server);
          d.update(iv.mean, clock.latenessP95());
          newest = Math.max(newest, p.server);
        }
        if (t < pkts[0].at + 5000) continue;
        frames++;
        if (clock.now(t) - d.delay > newest) under++;
      }
      assert.ok((100 * under) / frames < limit, `jitter ${jitter}: ${((100 * under) / frames).toFixed(2)}% underrun`);
    }
  });
});

describe('poseAt', () => {
  const a = { t: 1000, x: 0, z: 0, y: 0, facing: 0 };
  const b = { t: 1050, x: 1, z: 0, y: 0, facing: 0.5 };
  it('interpolates between snapshots', () => {
    const p = poseAt(a, b, 1025);
    assert.ok(Math.abs(p.x - 0.5) < 1e-9);
    assert.equal(p.extrapolated, false);
  });
  it('extrapolates past the newest snapshot, fading out, max 100 ms', () => {
    const p50 = poseAt(a, b, 1100);
    const p100 = poseAt(a, b, 1150);
    const p500 = poseAt(a, b, 1550);
    assert.ok(p50.extrapolated && p50.x > 1);
    assert.ok(p100.x > p50.x);
    // v = 20 u/s; over 100 ms the damped distance is v * 50 ms = 1.0
    assert.ok(Math.abs(p100.x - 2) < 1e-9, `${p100.x}`);
    assert.equal(p500.x, p100.x, 'capped');
    assert.equal(p500.facing, 0.5);
  });
  it('does not extrapolate a teleport', () => {
    const p = poseAt(a, { ...b, x: 30 }, 1100);
    assert.equal(p.x, 30);
    assert.equal(p.extrapolated, false);
  });
});

describe('ownAhead', () => {
  it('projects the last step forward by the time since it was taken', () => {
    const p = ownAhead({ x: 1, z: 0 }, { x: 0.65, z: 0 }, 0.025, 0.05, 1);
    assert.ok(Math.abs(p.x - 1.175) < 1e-9);
  });
  it('is the plain prediction right after a step and never more than one step ahead', () => {
    assert.deepEqual(ownAhead({ x: 1, z: 2 }, { x: 0.5, z: 2 }, 0, 0.05, 1), { x: 1, z: 2 });
    const p = ownAhead({ x: 1, z: 0 }, { x: 0.5, z: 0 }, 1, 0.05, 1);
    assert.ok(Math.abs(p.x - 1.5) < 1e-9);
  });
  it('does not project a correction or teleport', () => {
    assert.deepEqual(ownAhead({ x: 10, z: 0 }, { x: 0, z: 0 }, 0.04, 0.05, 1), { x: 10, z: 0 });
  });
  it('stands still when not moving', () => {
    assert.deepEqual(ownAhead({ x: 3, z: 3 }, { x: 3, z: 3 }, 0.04, 0.05, 1), { x: 3, z: 3 });
  });
});

describe('NetStats', () => {
  it('estimates loss from tick gaps and the spacing of arrivals', () => {
    const s = new NetStats();
    for (let i = 0; i < 100; i++) if (i % 10 !== 5) s.snapshot(i * 50, i);
    assert.ok(Math.abs(s.lossPct() - 10) < 2, `${s.lossPct()}`);
    assert.ok(s.spacing().mean > 50);
    s.rtt.add(42);
    s.frame(true);
    s.frame(false);
    assert.match(s.lines().join('\n'), /ping 42 ms/);
    assert.match(s.lines().join('\n'), /stalls 50.0%/);
  });
  it('ignores reordered or repeated ticks', () => {
    const s = new NetStats();
    s.snapshot(0, 5);
    s.snapshot(50, 4);
    s.snapshot(100, 6);
    assert.equal(s.lossPct(), 0);
  });
});

describe('RenderTime', () => {
  it('never goes back when the delay grows', () => {
    const r = new RenderTime();
    assert.equal(r.next(1000, 75), 925);
    assert.equal(r.next(1016, 110), 925, 'paused, not rewound');
    assert.equal(r.next(1100, 110), 990);
  });
});
