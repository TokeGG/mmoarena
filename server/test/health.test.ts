import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HEALTH_HOURS } from '@arena/shared';
import { MemoryStore } from '../src/store';
import { ServerHealth, cleanHealth } from '../src/health';
import { TickMeter } from '../src/tickmeter';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 9, 13, 0, 0);

describe('server health record', () => {
  it('adds what the tick meter counted to the current hour and starts a new record each hour', async () => {
    let now = T0;
    const h = new ServerHealth(new MemoryStore(), 50, () => now);
    h.record({ ticks: 20, late: 1, busyMs: 100, maxMs: 12 }, 3);
    h.record({ ticks: 20, late: 0, busyMs: 60, maxMs: 30 }, 5);
    now += HOUR;
    h.record({ ticks: 20, late: 2, busyMs: 40, maxMs: 8 }, 2);
    const list = await h.list();
    assert.equal(list.length, 2);
    assert.deepEqual({ ...list[0], h: 0 }, { h: 0, ticks: 40, busyMs: 160, late: 1, maxMs: 30, peakOnline: 5, stepMs: 50 });
    assert.equal(list[1].late, 2);
    assert.equal(list[1].h, list[0].h + 1);
  });

  it('is kept in the store, merged with what an earlier run wrote, and limited to three days', async () => {
    const store = new MemoryStore();
    let now = T0;
    const a = new ServerHealth(store, 50, () => now);
    a.record({ ticks: 10, late: 1, busyMs: 50, maxMs: 9 }, 4);
    await a.flush();
    const b = new ServerHealth(store, 50, () => now + 1000);
    b.record({ ticks: 10, late: 0, busyMs: 50, maxMs: 20 }, 2);
    const list = await b.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].ticks, 20);
    assert.equal(list[0].late, 1);
    assert.equal(list[0].maxMs, 20);
    assert.equal(list[0].peakOnline, 4);
    const many = Array.from({ length: HEALTH_HOURS + 20 }, (_, i) => ({ h: 1000 + i, ticks: 1, busyMs: 1, late: 0, maxMs: 1, peakOnline: 1, stepMs: 50 }));
    assert.equal(cleanHealth(many).length, HEALTH_HOURS);
    assert.deepEqual(cleanHealth('nonsense'), []);
    assert.deepEqual(cleanHealth([{ h: -5, ticks: 'x' }, null]), []);
  });

  it('the tick meter hands over its counts once and starts again', () => {
    const m = new TickMeter(50, () => 0);
    m.record(0, 10);
    m.record(50, 70); // longer than a step: late
    assert.deepEqual(m.drain(), { ticks: 2, late: 1, busyMs: 80, maxMs: 70 });
    assert.deepEqual(m.drain(), { ticks: 0, late: 0, busyMs: 0, maxMs: 0 });
  });
});
