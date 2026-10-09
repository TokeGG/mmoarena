import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DASH_ARRIVED, DASH_HOLD_MS, DashTracker, anchorBlend, anchorSnaps } from '../src/dashPath';

const RUN = 7;
/** A charge at 34 yards per second sampled every 50 ms: 1.7 yards a step. */
const feed = (d: DashTracker, from: number, steps: number, controlled = true) => {
  let t = 1000;
  let x = from;
  d.sample(t, x, 0, false, RUN);
  for (let i = 0; i < steps; i++) {
    t += 50;
    x += 1.7;
    d.sample(t, x, 0, controlled, RUN);
  }
  return { t, x };
};

describe('own Charge / Heroic Leap are drawn on the snapshot timeline', () => {
  it('a fast move while the server moves us starts a dash; running or a stun does not', () => {
    const run = new DashTracker();
    let t = 0;
    for (let i = 0; i < 10; i++) run.sample((t += 50), i * 0.35, 0, false, RUN); // 7 yards per second, not controlled
    assert.ok(!run.dashing(t, { x: 3, z: 0 }, { x: 3, z: 0 }, false));
    const stun = new DashTracker();
    t = 0;
    for (let i = 0; i < 10; i++) stun.sample((t += 50), 4, 0, true, RUN); // standing still while held
    assert.ok(!stun.dashing(t, { x: 4, z: 0 }, { x: 4, z: 0 }, true));
    const fear = new DashTracker();
    t = 0;
    for (let i = 0; i < 10; i++) fear.sample((t += 50), i * 0.12, 0, true, RUN); // a fear stumble: 35% of run speed
    assert.ok(!fear.dashing(t, { x: 1, z: 0 }, { x: 1, z: 0 }, true));
    const d = new DashTracker();
    const end = feed(d, 0, 3);
    assert.ok(d.dashing(end.t, { x: end.x - 3, z: 0 }, { x: end.x, z: 0 }, true));
  });

  it('a teleport (Blink) is not a dash: the server does not hold us during it', () => {
    const d = new DashTracker();
    d.sample(1000, 0, 0, false, RUN);
    d.sample(1050, 20, 0, false, RUN);
    assert.ok(!d.dashing(1050, { x: 0, z: 0 }, { x: 20, z: 0 }, false));
  });

  it('after the server lets go, the dash lasts until the drawn position has caught up', () => {
    const d = new DashTracker();
    const end = feed(d, 0, 6);
    // control is over, but the drawn path is still 3 yards behind the server's position
    assert.ok(d.dashing(end.t + 50, { x: end.x - 3, z: 0 }, { x: end.x, z: 0 }, false));
    assert.ok(d.dashing(end.t + 100, { x: end.x - 1, z: 0 }, { x: end.x, z: 0 }, false));
    assert.ok(!d.dashing(end.t + 150, { x: end.x - DASH_ARRIVED / 2, z: 0 }, { x: end.x, z: 0 }, false));
    // and it stays over
    assert.ok(!d.dashing(end.t + 200, { x: end.x - 3, z: 0 }, { x: end.x, z: 0 }, false));
  });

  it('a dash never holds longer than the limit, and a clock that goes back starts afresh', () => {
    const d = new DashTracker();
    const end = feed(d, 0, 6);
    assert.ok(d.dashing(end.t + 10, undefined, { x: end.x, z: 0 }, true));
    assert.ok(!d.dashing(end.t + DASH_HOLD_MS + 10, { x: 0, z: 0 }, { x: end.x, z: 0 }, true));
    const e = new DashTracker();
    feed(e, 0, 6);
    e.sample(10, 0, 0, true, RUN); // a new match: time restarts
    assert.ok(!e.dashing(10, undefined, { x: 0, z: 0 }, true));
  });

  it('a sprint (a faster run) is not a dash, a charge is', () => {
    const d = new DashTracker();
    let t = 0;
    for (let i = 0; i < 6; i++) d.sample((t += 50), i * 0.6, 0, true, RUN * 1.7); // 12 yards per second with a 1.7 speed bonus
    assert.ok(!d.dashing(t, undefined, { x: 3, z: 0 }, true));
  });

  it('the camera anchor follows a dash without lag and never snaps in one', () => {
    assert.equal(anchorBlend(0.016, true, false), 1);
    assert.equal(anchorBlend(0.016, true, true), 1);
    assert.ok(anchorBlend(0.016, false, true) < 0.1, 'a stun keeps the heavy damping');
    assert.ok(anchorBlend(0.016, false, false) > 0.4);
    assert.ok(anchorSnaps(6, false), 'a Blink is a jump');
    assert.ok(!anchorSnaps(6, true), 'a dash is never a jump');
    assert.ok(!anchorSnaps(2, false));
  });

  it('drawn on the timeline, a charge moves every frame by the same step (no blinking back and forth)', () => {
    // the drawn position is the snapshot timeline; at 60 fps and 34 yards per second each frame is 0.57 yards, always forward
    const snaps = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ t: 1000 + i * 50, x: i * 1.7 }));
    const at = (rt: number) => {
      let i = snaps.length - 2;
      while (i > 0 && snaps[i].t > rt) i--;
      const a = snaps[i];
      const b = snaps[i + 1];
      return a.x + (b.x - a.x) * Math.min(1, Math.max(0, (rt - a.t) / (b.t - a.t)));
    };
    let prev = at(1000);
    for (let f = 1; f <= 17; f++) {
      const x = at(1000 + f * (1000 / 60));
      assert.ok(x - prev > 0.5 && x - prev < 0.65, `frame ${f}: ${x - prev}`);
      prev = x;
    }
  });
});
