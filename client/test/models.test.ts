import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CLASS_IDS, COSMETICS, SLOT_IDS, gearLook, itemsForSlot } from '@arena/shared';
import { createCharacter, createSheep, REPLACEABLE_SLOTS } from '../src/models';

/** Every mesh below `o` (the tree itself, not the picking list). */
const meshesIn = (o: THREE.Object3D) => {
  const out: THREE.Object3D[] = [];
  o.traverse((c) => c instanceof THREE.Mesh && out.push(c));
  return out;
};

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

  it('every class has a built-in part tagged for each replaceable slot (except where it has none)', () => {
    const expected: Record<string, string[]> = { warrior: ['head', 'shoulders', 'back'], mage: ['head', 'shoulders'], priest: ['head', 'shoulders', 'back'], rogue: ['head', 'shoulders', 'back'] };
    for (const cls of CLASS_IDS) {
      const ch = createCharacter(cls);
      assert.deepEqual(Object.keys(ch.parts).sort(), [...expected[cls]].sort(), `${cls} base parts`);
    }
  });

  it('a cosmetic in a slot replaces the base part; none keeps it; never both', () => {
    for (const cls of CLASS_IDS) {
      const bare = createCharacter(cls);
      for (const slot of REPLACEABLE_SLOTS) {
        for (const part of bare.parts[slot] ?? []) {
          assert.equal(part.visible, true);
          assert.ok(bare.root.getObjectById(part.id), `${cls} ${slot} base part is on the model`);
        }
        for (const item of itemsForSlot(slot)) {
          const ch = createCharacter(cls, gearLook({ [slot]: item.id }));
          for (const [s, parts] of Object.entries(ch.parts)) {
            for (const part of parts) {
              const worn = s === slot;
              assert.equal(!!ch.root.getObjectById(part.id), !worn, `${cls}: ${s} base part with ${item.id} in ${slot}`);
              assert.equal(part.visible, !worn);
              // nothing of a replaced part stays pickable
              const inTree = new Set(meshesIn(ch.root));
              for (const m of meshesIn(part)) assert.equal(inTree.has(m) || ch.meshes.includes(m as THREE.Mesh), !worn);
            }
          }
        }
      }
    }
  });

  it('switching items repeatedly never leaves a stale or doubled base part', () => {
    for (const cls of CLASS_IDS) {
      const seq = ['void_horns', '', 'founder_crown', '', 'crown_gold'];
      let last: ReturnType<typeof createCharacter> | undefined;
      for (const id of seq) {
        last = createCharacter(cls, gearLook(id ? { head: id } : {}));
        const parts = last.parts.head ?? [];
        for (const p of parts) assert.equal(!!last.root.getObjectById(p.id), !id, `${cls} head part with ${id || 'none'}`);
        last.pose({ phase: 1, move: 1, casting: false, time: 1, dt: 0.05 });
      }
    }
  });

  it('the warrior keeps its height, and the polymorph form has no base parts to replace', () => {
    const top = (ch: ReturnType<typeof createCharacter>) => new THREE.Box3().setFromObject(ch.root).max.y;
    const plain = top(createCharacter('warrior'));
    assert.ok(plain > 1.9 && plain < 2.6, `warrior height ${plain}`);
    assert.deepEqual(createSheep().parts, {});
  });
});
