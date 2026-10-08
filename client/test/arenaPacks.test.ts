import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ARENAS } from '@arena/shared';
import { unpackModel } from '../src/modelPack';
import { CREDITS } from '../src/credits';

const dir = (f: string) => fileURLToPath(new URL(`../public/models/arenas/${f}`, import.meta.url));
function readPack(name: string) {
  const buf = Buffer.from(unpackModel(readFileSync(dir(name + '.pak'))));
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  return { json, size: statSync(dir(name + '.pak')).size };
}
const CREDIT_IDS = ['hell-arena', 'hell-arena-lake', 'stadium-arena'];

describe('arena packs', () => {
  it('every theme with a model has a pack, and each pack stays under 6 MB', () => {
    for (const name of ['kit', 'cinder', 'forge', 'sandstone']) {
      const p = readPack(name);
      assert.ok(p.size < 6 * 1024 * 1024, `${name}.pak is ${(p.size / 1048576).toFixed(1)} MB`);
      assert.ok(p.json.nodes.length > 3, `${name}: has nodes`);
    }
    for (const id of ['cinder', 'forge', 'sandstone']) assert.ok(ARENAS.some((a) => a.id === id && a.theme === id), `${id} arena uses its pack`);
  });

  it('carry the nodes the scenery looks for', () => {
    const names = (n: string) => new Set<string>(readPack(n).json.nodes.map((x: any) => x.name));
    const kit = names('kit');
    for (const m of ['sand', 'sandbrick', 'cobble', 'carved', 'sandstone', 'snow', 'ice', 'frostbrick', 'mossbrick', 'flagstone', 'planks', 'dirt']) assert.ok(kit.has('mat_' + m), `kit: ${m}`);
    const cinder = names('cinder');
    for (const n of ['mat_lavacrack', 'mat_basalt', 'mat_basaltdark', 'mat_lavaflow']) assert.ok(cinder.has(n), `cinder: ${n}`);
    const forge = names('forge');
    for (const n of ['grate', 'mat_greybrick', 'mat_blackbrick', 'mat_basalt', 'mat_lavaflow']) assert.ok(forge.has(n), `forge: ${n}`);
    const sand = names('sandstone');
    assert.ok(sand.has('prop_obelisk_0') && sand.has('prop_obelisk_1'));
    assert.ok([...sand].some((n) => n.startsWith('shell_')));
  });

  it('are credited exactly as the source files say, in the pack and in the game credits', () => {
    const want = CREDIT_IDS.map((id) => CREDITS.find((c) => c.id === id)!);
    for (const c of want) assert.ok(c, 'credited in the game');
    assert.deepEqual(want.map((c) => [c.title, c.author, c.url]), [
      ['HELL ARENA', '3DMAN (https://sketchfab.com/3dmanx888)', 'https://sketchfab.com/3d-models/hell-arena-9db7838c98ab4ae5a6a783dda03115eb'],
      ['Hell arena', '3DMAN (https://sketchfab.com/3dmanx888)', 'https://sketchfab.com/3d-models/hell-arena-14b8a6e3cba342f5a952ca5488180489'],
      ['Arena', 'lombardirowchik (https://sketchfab.com/lombardirowchik)', 'https://sketchfab.com/3d-models/arena-0f990d29a01f4ef5b2c5013797ea32fc'],
    ]);
    const bySource = new Map(want.map((c) => [c.url!, c]));
    const used: Record<string, string[]> = { kit: [want[2].url!], cinder: [want[0].url!, want[1].url!], forge: [want[1].url!], sandstone: [want[2].url!] };
    for (const [name, urls] of Object.entries(used)) {
      const credits = readPack(name).json.asset.extras.credits as { title: string; author: string; source: string; license: string }[];
      assert.deepEqual(credits.map((c) => c.source), urls, `${name}: credited sources`);
      for (const c of credits) {
        const g = bySource.get(c.source)!;
        assert.equal(c.title, g.title);
        assert.equal(c.author, g.author);
        assert.match(c.license, /^CC-BY-4\.0/);
      }
    }
  });
});
