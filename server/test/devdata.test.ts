import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { entityText } from '@arena/shared';
import { patchJsonText } from '../src/devtools';

describe('committing a whole entry written as data', () => {
  it('replaces the entry in the data file and leaves the rest and the layout alone', () => {
    const text = readFileSync(new URL('../../shared/data/abilities.json', import.meta.url), 'utf8');
    const o = JSON.parse(entityText('abilities', 'fireball')!);
    o.effects.push({ type: 'aura', aura: 'pw_shield' });
    const out = patchJsonText(text, 'abilities', [{ file: 'abilities', id: 'fireball', path: ['$entity'], value: JSON.stringify(o, null, 2) }]);
    const data = JSON.parse(out) as { id: string; effects: unknown[] }[];
    assert.equal(data.find((a) => a.id === 'fireball')!.effects.at(-1) !== undefined, true);
    assert.equal(JSON.stringify(data.find((a) => a.id === 'fireball')!.effects.at(-1)), JSON.stringify({ type: 'aura', aura: 'pw_shield' }));
    assert.equal(data.length, (JSON.parse(text) as unknown[]).length);
    assert.equal(out.endsWith('\n'), text.endsWith('\n'));
  });
});
