import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARENAS, DECK_THICKNESS, slabReach } from '../src/index';

describe('the camera under and over a platform', () => {
  const arena = ARENAS.find((a) => a.deck && a.deck.flats.length)!;
  const dk = arena.deck!;
  const f = dk.flats[0];
  const cx = (f.x0 + f.x1) / 2, cz = (f.z0 + f.z1) / 2;
  it('is pulled in under a deck instead of rising through it', () => {
    const head = { x: cx, y: 1.8, z: cz };
    const up = { x: 0, y: Math.sin(0.5), z: -Math.cos(0.5) }; // behind and above
    const d = slabReach(arena, head, up, 14);
    assert.ok(d < 14, `reach ${d}`);
    const y = head.y + up.y * d;
    assert.ok(y < dk.height - DECK_THICKNESS, `the camera stays under the deck (y=${y.toFixed(2)})`);
  });
  it('stays above the deck when you stand on it and look down', () => {
    const head = { x: cx, y: dk.height + 1.8, z: cz };
    const down = { x: 0, y: -Math.sin(1.0), z: -Math.cos(1.0) };
    const d = slabReach(arena, head, down, 14);
    assert.ok(head.y + down.y * d >= dk.height - 0.01, 'not below the deck top');
  });
  it('leaves open ground alone', () => {
    const head = { x: arena.bounds.minX + 3, y: 1.8, z: arena.bounds.minZ + 3 };
    assert.equal(slabReach(arena, head, { x: 0, y: 0.3, z: 0.95 }, 10), 10);
  });
});
