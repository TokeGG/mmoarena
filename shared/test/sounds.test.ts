import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { SOUNDS, SOUND_ID, SOUND_LIBRARY, applyPatches, currentValue, entryFor, isSoundFile, navFor, soundList, soundSetting, validPatch } from '../src/index';

const dir = new URL('../../client/public/audio/', import.meta.url);

describe('sounds', () => {
  it('every sound id is in shared/data/sounds.json (run `npx tsx scripts/gen-sounds.ts` after adding a skill) and nothing else is', () => {
    const ids = soundList().map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, 'ids are unique');
    for (const id of ids) assert.ok(SOUNDS[id], `${id} is missing from sounds.json`);
    for (const id of Object.keys(SOUNDS)) assert.ok(ids.includes(id), `${id} in sounds.json is not a sound of the game`);
  });

  it('every recording a sound uses exists and the library files are all there', () => {
    for (const f of SOUND_LIBRARY) assert.ok(existsSync(new URL(f.file, dir)), `${f.file} is missing`);
    for (const [id, s] of Object.entries(SOUNDS)) {
      if (!s.file) continue;
      assert.ok(isSoundFile(s.file), `${id}: ${s.file} is not a known recording`);
      assert.ok(existsSync(new URL(s.file, dir)), `${id}: ${s.file} is not in client/public/audio`);
    }
  });

  it('the Sounds page lists every sound, with recording, volume, pitch and a silent switch, and the library to listen to', () => {
    const nav = navFor('sounds');
    assert.equal(nav.flatMap((g) => g.entries).filter((e) => !e.id.startsWith('lib:')).length, soundList().length);
    assert.equal(nav[nav.length - 1].entries.length, SOUND_LIBRARY.length);
    const e = entryFor('sounds', 'ui-click')!;
    assert.deepEqual(e.groups[0].fields.map((f) => [f.path[1], f.kind]), [['file', 'choice'], ['volume', 'number'], ['pitch', 'number'], ['off', 'switch']]);
    assert.ok(entryFor('sounds', `lib:${SOUND_LIBRARY[0].file}`));
  });

  it('a dev can change the recording, volume, pitch and the off switch, within bounds, and undo it', () => {
    const p = (key: string, value: number | string) => ({ file: 'sounds' as const, id: SOUND_ID, path: ['jump', key], value });
    assert.ok(validPatch(p('volume', 1.5)) && !validPatch(p('volume', 5)) && !validPatch(p('pitch', 0.1)));
    assert.ok(validPatch(p('file', 'lib/move-jump-03.mp3')) && validPatch(p('file', '')) && validPatch(p('file', 'custom/my-boom.mp3')));
    assert.ok(!validPatch(p('file', '../../etc/passwd')) && !validPatch(p('file', 'custom/Bad Name.mp3')));
    assert.ok(validPatch(p('off', 1)) && !validPatch(p('off', 2)));
    assert.ok(!validPatch({ file: 'sounds', id: SOUND_ID, path: ['no-such-sound', 'volume'], value: 1 }));
    const before = soundSetting('jump');
    const undo = applyPatches([p('volume', 2), p('off', 1), p('file', 'custom/my-boom.mp3')]);
    assert.equal(soundSetting('jump').volume, 2);
    assert.equal(soundSetting('jump').off, true);
    assert.equal(soundSetting('jump').file, 'custom/my-boom.mp3');
    assert.equal(currentValue({ file: 'sounds', id: SOUND_ID, path: ['jump', 'off'] }), 1);
    undo();
    assert.deepEqual(soundSetting('jump'), before);
  });
});
