import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FREE_MARGIN, FREE_MAX_H, FREE_MIN_H, FREE_PITCH, FreeCam, NO_INPUT, SLOW_MULT, FAST_MULT, canFreeCam, clampPos, lookDir, speedSetting, wheelSpeed, WHEEL_MAX, WHEEL_MIN } from '../src/freeCam';

const B = { minX: -30, maxX: 30, minZ: -20, maxZ: 20 };
const flat = () => 0;
const mk = (pose = { x: 0, y: 10, z: 0, yaw: 0, pitch: 0 }) => {
  const c = new FreeCam();
  c.enter(pose, B, flat);
  return c;
};
const run = (c: FreeCam, seconds: number, fps: number, input = {}) => {
  const n = Math.round(seconds * fps);
  for (let i = 0; i < n; i++) c.update(1 / fps, { ...NO_INPUT, ...input }, B, flat);
};

describe('free camera: who gets it', () => {
  it('rank rule table', () => {
    const t = (dead: boolean, spectating: boolean, ranked: boolean) => canFreeCam({ dead, spectating, ranked });
    assert.equal(t(false, false, false), false); // alive: never
    assert.equal(t(false, false, true), false);
    assert.equal(t(true, false, false), true); // dead in practice, party, duel
    assert.equal(t(true, false, true), false); // dead in ranked: only follows teammates
    assert.equal(t(false, true, false), true); // spectators always
    assert.equal(t(false, true, true), true);
    assert.equal(t(true, true, true), true);
  });
});

describe('free camera: movement', () => {
  it('forward goes along the look direction including pitch', () => {
    const c = mk({ x: 0, y: 20, z: 0, yaw: Math.PI / 2, pitch: 0.5 });
    run(c, 1, 60, { forward: 1 });
    const d = lookDir(Math.PI / 2, 0.5);
    const moved = { x: c.pose.x, y: c.pose.y - 20, z: c.pose.z };
    const len = Math.hypot(moved.x, moved.y, moved.z);
    assert.ok(len > 3);
    assert.ok(Math.abs(moved.x / len - d.x) < 1e-6 && Math.abs(moved.y / len - d.y) < 1e-6 && Math.abs(moved.z / len - d.z) < 1e-6);
    assert.ok(c.pose.y < 20); // looking down: it descends
  });
  it('right is to the right of the view and up is world up', () => {
    const c = mk({ x: 0, y: 10, z: 0, yaw: 0, pitch: 0 }); // looking along +z: right is -x (as the orbit camera)
    run(c, 0.5, 60, { right: 1 });
    assert.ok(c.pose.x < -1 && Math.abs(c.pose.z) < 1e-9);
    const u = mk();
    run(u, 0.5, 60, { up: 1 });
    assert.ok(u.pose.y > 11 && Math.abs(u.pose.x) < 1e-9);
  });
  it('diagonals are no faster than straight', () => {
    const a = mk(); run(a, 1, 60, { forward: 1 });
    const b = mk(); run(b, 1, 60, { forward: 1, right: 1 });
    assert.ok(Math.hypot(b.pose.x, b.pose.z) <= Math.hypot(a.pose.x, a.pose.z) + 1e-6);
  });
  it('shift is faster, alt/z slower, wheel and setting scale the speed', () => {
    const dist = (input: object, setup?: (c: FreeCam) => void) => {
      const c = mk({ x: -25, y: 10, z: 0, yaw: Math.PI / 2, pitch: 0 }); setup?.(c);
      run(c, 0.6, 60, input);
      return c.pose.x + 25;
    };
    const base = dist({ forward: 1 });
    assert.ok(Math.abs(dist({ forward: 1, fast: true }) / base - FAST_MULT) < 1e-6);
    assert.ok(Math.abs(dist({ forward: 1, slow: true }) / base - SLOW_MULT) < 1e-6);
    assert.ok(Math.abs(dist({ forward: 1 }, (c) => (c.setting = 2)) / base - 2) < 1e-6);
    assert.ok(Math.abs(dist({ forward: 1 }, (c) => (c.wheel = 0.5)) / base - 0.5) < 1e-6);
  });
  it('wheel changes the factor within limits', () => {
    assert.ok(wheelSpeed(1, -100) > 1);
    assert.ok(wheelSpeed(1, 100) < 1);
    assert.equal(wheelSpeed(1, -1e6), WHEEL_MAX);
    assert.equal(wheelSpeed(1, 1e6), WHEEL_MIN);
  });
  it('eases up to speed and coasts to a stop', () => {
    const c = mk();
    c.update(1 / 60, { ...NO_INPUT, forward: 1 }, B, flat);
    const first = Math.hypot(c.pose.x, c.pose.z);
    assert.ok(first < c.speed / 60 * 0.5, 'first frame is a fraction of full speed');
    run(c, 1, 60, { forward: 1 });
    const x0 = c.pose.z;
    run(c, 0.05, 60);
    assert.ok(c.pose.z > x0); // still gliding
    run(c, 2, 60);
    const x1 = c.pose.z;
    run(c, 1, 60);
    assert.ok(Math.abs(c.pose.z - x1) < 1e-3); // stopped
  });
  it('covers the same distance at 30 and 144 fps', () => {
    const at = (fps: number) => { const c = mk(); run(c, 1, fps, { forward: 1 }); run(c, 0.5, fps); return c.pose.z; };
    assert.ok(Math.abs(at(30) - at(144)) < 1e-6);
    assert.ok(Math.abs(at(60) - at(144)) < 1e-6);
  });
});

describe('free camera: limits', () => {
  it('stays inside the walls plus the margin', () => {
    const c = mk({ x: 0, y: 10, z: 0, yaw: Math.PI / 2, pitch: 0 });
    run(c, 10, 60, { forward: 1, fast: true });
    assert.equal(c.pose.x, B.maxX + FREE_MARGIN);
    const d = mk({ x: 0, y: 10, z: 0, yaw: Math.PI, pitch: 0 });
    run(d, 10, 60, { forward: 1, fast: true });
    assert.equal(d.pose.z, B.minZ - FREE_MARGIN);
  });
  it('stays above the ground and below the ceiling', () => {
    const c = mk();
    run(c, 10, 60, { up: -1, fast: true });
    assert.ok(Math.abs(c.pose.y - FREE_MIN_H) < 1e-9);
    run(c, 10, 60, { up: 1, fast: true });
    assert.equal(c.pose.y, FREE_MAX_H);
  });
  it('follows raised ground', () => {
    const hill = (x: number) => (x > 0 ? 4 : 0);
    const c = new FreeCam();
    c.enter({ x: -5, y: 3, z: 0, yaw: Math.PI / 2, pitch: 0 }, B, hill);
    for (let i = 0; i < 300; i++) c.update(1 / 60, { ...NO_INPUT, forward: 1 }, B, hill);
    assert.ok(c.pose.y >= 4 + FREE_MIN_H - 1e-9);
    assert.equal(clampPos({ x: 1, y: -3, z: 0 }, B, hill).y, 4 + FREE_MIN_H);
  });
  it('limits the pitch so the view never flips', () => {
    const c = mk();
    c.look(0, 5);
    assert.equal(c.pose.pitch, FREE_PITCH);
    c.look(0, -5);
    assert.equal(c.pose.pitch, -FREE_PITCH);
    assert.ok(FREE_PITCH < Math.PI / 2);
  });
  it('wraps the heading', () => {
    const c = mk();
    c.look(Math.PI * 3.5, 0);
    assert.ok(Math.abs(c.pose.yaw - -Math.PI / 2) < 1e-9);
  });
});

describe('free camera: enter and exit', () => {
  it('enter keeps the pose (no jump) and starts at rest', () => {
    const from = { x: 12.5, y: 7.25, z: -3, yaw: 1.2, pitch: 0.7 };
    const c = new FreeCam();
    c.enter(from, B, flat);
    assert.deepEqual(c.pose, from);
    c.update(1 / 60, NO_INPUT, B, flat);
    assert.deepEqual(c.pose, from);
    assert.equal(c.active, true);
  });
  it('first person pitch (looking up) is kept inside the limit', () => {
    const c = new FreeCam();
    c.enter({ x: 0, y: 3, z: 0, yaw: 0, pitch: -3 }, B, flat);
    assert.equal(c.pose.pitch, -FREE_PITCH);
  });
  it('exit stops it and drops the speed; idle updates do nothing', () => {
    const c = mk();
    run(c, 1, 60, { forward: 1 });
    c.exit();
    const z = c.pose.z;
    c.update(1, { ...NO_INPUT, forward: 1 }, B, flat);
    assert.equal(c.pose.z, z);
    assert.equal(c.active, false);
    c.enter(c.pose, B, flat);
    c.update(1 / 60, NO_INPUT, B, flat);
    assert.equal(c.pose.z, z); // no leftover velocity
  });
});

describe('free camera: settings', () => {
  it('parses and clamps the fly speed', () => {
    assert.equal(speedSetting(null), 1);
    assert.equal(speedSetting(''), 1);
    assert.equal(speedSetting('abc'), 1);
    assert.equal(speedSetting('0.1'), 0.5);
    assert.equal(speedSetting('9'), 3);
    assert.equal(speedSetting('1.5'), 1.5);
  });
  it('the hint names the speed', () => {
    const c = mk();
    c.setting = 2;
    assert.match(c.hint(), /2\.0× speed/);
  });
});
