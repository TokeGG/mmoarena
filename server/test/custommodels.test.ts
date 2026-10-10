import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CustomModels, modelType } from '../src/custommodels';
import { MemoryStore } from '../src/store';

const header = (n: number) => {
  const b = Buffer.alloc(n);
  b.write('glTF', 0, 'latin1');
  b.writeUInt32LE(2, 4);
  b.writeUInt32LE(n, 8);
  return b;
};

describe('custom models', () => {
  it('recognises a binary glTF 2.0 by its bytes, not its name', () => {
    assert.equal(modelType(header(64)), 'glb');
    assert.equal(modelType(Buffer.from('<html>not a model at all, really not</html>')), null);
  });

  it('keeps an upload, lists it, serves it and deletes it; names stay unique and files are checked', async () => {
    const s = new CustomModels(new MemoryStore());
    const g = header(64);
    const a = await s.add('dev', { name: 'My Hand!.glb', data: g.toString('base64') });
    assert.deepEqual(a, { ok: true, file: 'custom/my-hand.glb' });
    const b = await s.add('dev', { name: 'My Hand.glb', data: g.toString('base64') });
    assert.deepEqual(b, { ok: true, file: 'custom/my-hand-2.glb' });
    assert.deepEqual((await s.files()).map((f) => f.file), ['custom/my-hand.glb', 'custom/my-hand-2.glb']);
    assert.equal((await s.file('my-hand', 'glb'))?.buf.equals(g), true);
    assert.equal((await s.add('dev', { name: 'x.glb', data: Buffer.from('nothing like a model file at all').toString('base64') })).ok, false);
    assert.equal((await s.add('dev', { name: 'big.glb', data: header(9_000_000).toString('base64') })).ok, false);
    assert.equal((await s.remove('dev', 'my-hand')).ok, true);
    assert.deepEqual((await s.files()).map((f) => f.file), ['custom/my-hand-2.glb']);
  });
});
