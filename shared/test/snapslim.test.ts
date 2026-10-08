import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArenaSim, SlimEncoder, SnapMerger } from '../src/index';

function match() {
  const sim = new ArenaSim({ seed: 3, prepMs: 0 });
  sim.addUnit({ name: 'Ann', classId: 'mage', team: 0 });
  sim.addUnit({ name: 'Bob', classId: 'warrior', team: 1 });
  sim.step();
  return sim;
}
const wire = (o: unknown) => JSON.parse(JSON.stringify(o));

describe('snapshot diet', () => {
  it('round trips: merged slim snapshots equal the full ones, with identity sent once', () => {
    const sim = match();
    const enc = new SlimEncoder();
    const merger = new SnapMerger();
    let infoSent = 0;
    let slimBytes = 0;
    let fullBytes = 0;
    for (let i = 0; i < 30; i++) {
      sim.step();
      const full = sim.snapshot(0);
      const { snap, info } = enc.encode(full);
      infoSent += info.length;
      const msg = wire({ snap, info: info.length ? info : undefined });
      slimBytes += JSON.stringify(msg).length;
      fullBytes += JSON.stringify(full).length;
      assert.deepEqual(wire(merger.merge(msg.snap, msg.info)), wire(full));
    }
    assert.equal(infoSent, 2, 'each unit identity once');
    assert.ok(slimBytes < fullBytes * 0.8, `${slimBytes} vs ${fullBytes}`);
  });

  it('sends identity again when it changes (a rebuilt unit) and learns it on the client', () => {
    const sim = match();
    const enc = new SlimEncoder();
    const merger = new SnapMerger();
    const first = enc.encode(sim.snapshot());
    merger.merge(wire(first.snap), wire(first.info));
    sim.rebuildUnit(1, 'rogue', undefined);
    sim.step();
    const full = sim.snapshot();
    const next = enc.encode(full);
    assert.deepEqual(next.info.map((i) => i.id), [1]);
    assert.equal(wire(merger.merge(wire(next.snap), wire(next.info))).units[0].classId, 'rogue');
  });

  it('a unit that first becomes visible later brings its identity with it; allInfo serves a recipient who has seen nothing', () => {
    const sim = match();
    const enc = new SlimEncoder();
    const full = sim.snapshot();
    const hiddenFirst = { ...full, units: full.units.filter((u) => u.id === 1) };
    assert.equal(enc.encode(hiddenFirst).info.length, 1);
    const both = enc.encode(full);
    assert.deepEqual(both.info.map((i) => i.id), [2]);
    assert.equal(both.allInfo.length, 2);
    const late = new SnapMerger().merge(wire(both.snap), wire(both.allInfo));
    assert.deepEqual(late.units.map((u) => u.name), ['Ann', 'Bob']);
  });

  it('full units (spectators, replays, paused frames) pass through and teach identity; unknown slim units are dropped', () => {
    const sim = match();
    const full = sim.snapshot();
    const merger = new SnapMerger();
    assert.deepEqual(wire(merger.merge(wire(full))), wire(full));
    const enc = new SlimEncoder();
    const { snap } = enc.encode(full);
    assert.equal(merger.merge(wire(snap)).units.length, 2, 'learned from the full frame');
    assert.equal(new SnapMerger().merge(wire(snap)).units.length, 0);
  });
});
