import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { fittedPart, fittedWeapon, maskedGeometry } from '../src/customModels';
import { partAnchor } from '../src/customParts';

const box = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o);
const mesh = (w: number, h: number, d: number) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial());

describe('uploaded models: fitting', () => {
  it('a part is centred and scaled so its largest side is the size asked', () => {
    const src = new THREE.Group();
    const m = mesh(4, 2, 1);
    m.position.set(10, 5, 0);
    src.add(m);
    const out = fittedPart(src, 0.3);
    out.updateMatrixWorld(true);
    const b = box(out);
    const s = b.getSize(new THREE.Vector3());
    assert.ok(Math.abs(Math.max(s.x, s.y, s.z) - 0.3) < 1e-6);
    const c = b.getCenter(new THREE.Vector3());
    assert.ok(c.length() < 1e-6);
  });

  it('a weapon is stood along y at the length asked with its bottom end at the origin, whichever way it lay', () => {
    for (const dims of [[5, 0.2, 0.2], [0.2, 5, 0.2], [0.2, 0.2, 5]] as const) {
      const src = new THREE.Group();
      src.add(mesh(...dims));
      const out = fittedWeapon(src, 1.2);
      out.updateMatrixWorld(true);
      const b = box(out);
      assert.ok(Math.abs(b.min.y) < 1e-6, `bottom ${dims}`);
      assert.ok(Math.abs(b.max.y - 1.2) < 1e-6, `top ${dims}`);
    }
  });
});

describe('uploaded models: cutting the original away', () => {
  const geo = () => {
    // two triangles: one on bone 0, one on bone 1
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0], 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
    g.setIndex([0, 1, 2, 3, 4, 5]);
    return g;
  };
  it('drops the triangles that belong to a hidden bone and shares the attributes', () => {
    const g = geo();
    const out = maskedGeometry(g, ['hand_r', 'chest'], new Set(['hand_r']));
    assert.deepEqual(Array.from(out.index!.array), [3, 4, 5]);
    assert.equal(out.getAttribute('position'), g.getAttribute('position'));
    assert.equal(maskedGeometry(g, ['hand_r', 'chest'], new Set(['hand_r'])), out); // one cut geometry per set
    assert.equal(maskedGeometry(g, ['hand_r', 'chest'], new Set()), g);
  });
});

describe('uploaded models: where a part sits', () => {
  it('is between a bone and the next, on the head centre, below a hand', () => {
    const rest = { forearm_r: new THREE.Vector3(0, 1, 0), hand_r: new THREE.Vector3(0, 0, 0), head: new THREE.Vector3(0, 1.6, 0) };
    const meta = { headCenter: [0.1, 1.7, 0.05] as [number, number, number] };
    assert.deepEqual(partAnchor('forearm_r', rest, meta)!.toArray(), [0, 0.5, 0]);
    assert.deepEqual(partAnchor('head', rest, meta, 0.1)!.toArray(), [0, 1.7, 0.05]);
    assert.ok(Math.abs(partAnchor('hand_r', rest, meta)!.y + 0.07) < 1e-9);
    assert.equal(partAnchor('shin_l', rest, meta), null);
  });
});
