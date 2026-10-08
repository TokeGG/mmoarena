import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLASS_IDS, COSMETICS, SLOT_IDS, gearLook, itemsForSlot } from '@arena/shared';
import { createCharacter } from '../src/models';

describe('cosmetic models', () => {
  it('every item can be worn by every class and animates without errors', () => {
    for (const cls of CLASS_IDS) for (const item of COSMETICS.items) {
      const look = gearLook({ [item.slot]: item.id });
      const ch = createCharacter(cls, look);
      for (let i = 0; i < 4; i++) ch.pose({ phase: i, move: i % 2, casting: false, time: i * 0.37, dt: 0.05 });
      ch.setState(false, false);
      ch.pose({ phase: 0, move: 0, casting: false, time: 2, dt: 0.05 });
    }
  });
  it('every owner-only item has a shape of its own: no other item uses its style in the same slot', () => {
    for (const slot of SLOT_IDS) {
      const items = itemsForSlot(slot);
      for (const o of items.filter((i) => i.owner)) {
        const same = items.filter((i) => i !== o && i.style === o.style);
        assert.deepEqual(same.map((i) => i.id), [], `${o.id} shares the ${o.style} model`);
      }
    }
  });
});
