import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CAM_MAX, CAM_MIN } from '../src/camera';
import { DOUBLE_TAP_MS, ORBIT_PER_PX, PITCH_MAX, PITCH_MIN, TAP_MS, TAP_SLOP, TouchGestures, lightModeDefault, orbitBy, pinchZoom, pixelRatioCap, pixelRatioFor } from '../src/touch';

describe('one finger', () => {
  it('a quick touch that stays put is a tap', () => {
    const g = new TouchGestures();
    g.down(1, 100, 100, 0);
    assert.deepEqual(g.move(1, 103, 102, 20), []);
    assert.deepEqual(g.up(1, 120), [{ kind: 'tap', x: 103, y: 102 }]);
  });

  it('a long press is not a tap', () => {
    const g = new TouchGestures();
    g.down(1, 100, 100, 0);
    assert.deepEqual(g.up(1, TAP_MS + 50), []);
  });

  it('dragging past the slop orbits, by the distance moved since the last event', () => {
    const g = new TouchGestures();
    g.down(1, 100, 100, 0);
    assert.deepEqual(g.move(1, 100 + TAP_SLOP - 2, 100, 10), []); // still inside the slop: could be a tap
    const out = g.move(1, 140, 110, 20);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'orbit');
    const o = out[0] as { dx: number; dy: number };
    assert.equal(o.dx, 140 - (100 + TAP_SLOP - 2));
    assert.equal(o.dy, 10);
    assert.deepEqual(g.move(1, 150, 110, 30), [{ kind: 'orbit', dx: 10, dy: 0 }]);
    assert.deepEqual(g.up(1, 40), []); // a drag never ends in a tap
  });

  it('a drag that comes back to where it began is still not a tap', () => {
    const g = new TouchGestures();
    g.down(1, 100, 100, 0);
    g.move(1, 160, 100, 10);
    g.move(1, 100, 100, 20);
    assert.deepEqual(g.up(1, 30), []);
  });

  it('two quick taps in the same place are a tap and then a double tap', () => {
    const g = new TouchGestures();
    g.down(1, 200, 150, 0);
    assert.equal(g.up(1, 60)[0].kind, 'tap');
    g.down(2, 205, 152, 150);
    const out = g.up(2, 200);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'doubletap');
    // the pair is used up: a third tap starts over
    g.down(3, 205, 152, 260);
    assert.equal(g.up(3, 300)[0].kind, 'tap');
  });

  it('taps too far apart or too slow are two single taps', () => {
    const g = new TouchGestures();
    g.down(1, 50, 50, 0);
    g.up(1, 40);
    g.down(2, 300, 50, 100);
    assert.equal(g.up(2, 140)[0].kind, 'tap');
    g.down(3, 300, 50, 140 + DOUBLE_TAP_MS + 100);
    assert.equal(g.up(3, 140 + DOUBLE_TAP_MS + 140)[0].kind, 'tap');
  });
});

describe('two fingers', () => {
  it('moving apart is a pinch with a scale above one, about the midpoint', () => {
    const g = new TouchGestures();
    g.down(1, 100, 200, 0);
    g.down(2, 200, 200, 5);
    const out = g.move(2, 250, 200, 10);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { kind: 'pinch', scale: 150 / 100, cx: 175, cy: 200 });
  });

  it('moving together is a scale below one', () => {
    const g = new TouchGestures();
    g.down(1, 100, 200, 0);
    g.down(2, 300, 200, 5);
    const o = g.move(1, 200, 200, 10)[0] as { scale: number };
    assert.equal(o.scale, 0.5);
  });

  it('never ends in a tap, and the finger left behind does not jump the camera', () => {
    const g = new TouchGestures();
    g.down(1, 100, 100, 0);
    g.down(2, 140, 100, 10);
    assert.deepEqual(g.up(2, 50), []);
    assert.deepEqual(g.up(1, 60), []);
    // the remaining finger of a lifted pinch is not an orbit until it moves, and then only by its own movement
    g.down(3, 10, 10, 1000);
    g.down(4, 50, 10, 1000);
    g.up(4, 1100);
    assert.deepEqual(g.move(3, 40, 10, 1110), [{ kind: 'orbit', dx: 30, dy: 0 }]);
  });

  it('a cancelled finger is forgotten', () => {
    const g = new TouchGestures();
    g.down(1, 0, 0, 0);
    g.cancel(1);
    assert.equal(g.count, 0);
    assert.deepEqual(g.move(1, 50, 50, 10), []);
  });
});

describe('camera maths', () => {
  it('dragging right turns the view left and dragging down tilts it, like the mouse', () => {
    const o = orbitBy(1, 0.5, 100, 50);
    assert.ok(Math.abs(o.yaw - (1 - 100 * ORBIT_PER_PX)) < 1e-9);
    assert.ok(Math.abs(o.pitch - (0.5 + 50 * ORBIT_PER_PX)) < 1e-9);
  });

  it('the tilt stays between looking up a little and looking down from above', () => {
    assert.equal(orbitBy(0, 0, 0, 5000).pitch, PITCH_MAX);
    assert.equal(orbitBy(0, 0, 0, -5000).pitch, PITCH_MIN);
  });

  it('the sensitivity setting scales the turn', () => {
    assert.ok(Math.abs(orbitBy(0, 0.3, 10, 0, 2).yaw - -10 * ORBIT_PER_PX * 2) < 1e-9);
  });

  it('pinching apart zooms in, together zooms out, and both stop at the limits', () => {
    assert.ok(pinchZoom(12, 2) < 12);
    assert.ok(pinchZoom(12, 0.5) > 12);
    assert.equal(pinchZoom(12, 100), CAM_MIN);
    assert.equal(pinchZoom(12, 0.001), CAM_MAX);
    assert.equal(pinchZoom(12, 0), 12);
    assert.equal(pinchZoom(12, NaN), 12);
    assert.equal(pinchZoom(0, 0.5), CAM_MIN * 2); // from first person a pinch in steps out from the nearest third-person view
  });
});

describe('light mode', () => {
  const phone = { coarse: true, screenMin: 390 };
  const desktop = { coarse: false, screenMin: 1080 };
  it('is on by itself for a touch screen or a small screen, off for a desktop', () => {
    assert.equal(lightModeDefault(phone), true);
    assert.equal(lightModeDefault({ coarse: false, screenMin: 500 }), true);
    assert.equal(lightModeDefault(desktop), false);
  });

  it('an old low-memory device starts light too', () => {
    assert.equal(lightModeDefault({ ...desktop, memoryGb: 2 }), true);
    assert.equal(lightModeDefault({ ...desktop, memoryGb: 8 }), false);
    assert.equal(lightModeDefault({ ...desktop, memoryGb: 0 }), false);
  });

  it('a saved choice always wins', () => {
    assert.equal(lightModeDefault({ ...phone, saved: '0' }), false);
    assert.equal(lightModeDefault({ ...desktop, saved: '1' }), true);
    assert.equal(lightModeDefault({ ...phone, saved: 'auto' }), true);
    assert.equal(lightModeDefault({ ...phone, saved: null }), true);
  });

  it('caps the pixel ratio lower in light mode and never below 1', () => {
    assert.equal(pixelRatioCap(true), 1.5);
    assert.equal(pixelRatioCap(false), 2);
    assert.equal(pixelRatioFor(3, true), 1.5);
    assert.equal(pixelRatioFor(3, false), 2);
    assert.equal(pixelRatioFor(1, true), 1);
    assert.equal(pixelRatioFor(0, true), 1);
    assert.equal(pixelRatioFor(1.25, true), 1.25);
  });
});
