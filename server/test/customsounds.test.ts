import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CustomSounds, soundType } from '../src/customsounds';
import { MemoryStore } from '../src/store';

const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40, 1)]);
const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(20)]);

describe('custom sounds', () => {
  it('recognises mp3, ogg and wav by their bytes, not their name', () => {
    assert.equal(soundType(mp3), 'mp3');
    assert.equal(soundType(wav), 'wav');
    assert.equal(soundType(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(20)])), 'ogg');
    assert.equal(soundType(Buffer.from('<html>not a sound at all</html>')), null);
  });

  it('keeps an upload, lists it, serves it and deletes it; names stay unique and files are checked', async () => {
    const s = new CustomSounds(new MemoryStore());
    const a = await s.add('dev', { name: 'My Boom!.mp3', data: mp3.toString('base64') });
    assert.deepEqual(a, { ok: true, file: 'custom/my-boom.mp3' });
    const b = await s.add('dev', { name: 'My Boom.wav', data: wav.toString('base64') });
    assert.deepEqual(b, { ok: true, file: 'custom/my-boom-2.wav' });
    assert.deepEqual((await s.files()).map((f) => f.file), ['custom/my-boom.mp3', 'custom/my-boom-2.wav']);
    assert.equal((await s.file('my-boom', 'mp3'))?.buf.equals(mp3), true);
    assert.equal(await s.file('my-boom', 'wav'), null);
    const bad = await s.add('dev', { name: 'x.mp3', data: Buffer.from('nothing like a sound file').toString('base64') });
    assert.equal(bad.ok, false);
    const big = await s.add('dev', { name: 'big.mp3', data: Buffer.concat([mp3, Buffer.alloc(2_000_000)]).toString('base64') });
    assert.equal(big.ok, false);
    assert.equal((await s.remove('dev', 'my-boom')).ok, true);
    assert.deepEqual((await s.files()).map((f) => f.file), ['custom/my-boom-2.wav']);
  });
});
