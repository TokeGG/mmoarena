/**
 * Scramble every client/public/models/**.glb into a .pak the game can read (client/src/modelPack.ts) and move the plain
 * file out of the served folder into assets-src/models (kept out of git, see .gitignore), so only the packs are served.
 * Run after rigging or prepping a model:  npx tsx scripts/pack-models.ts
 * `--unpack` writes the plain files back from the packs (to work on a model again).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packModel, unpackModel } from '../client/src/modelPack';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'client/public/models');
const src = path.join(root, 'assets-src/models');

const walk = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);

if (process.argv.includes('--unpack')) {
  for (const f of walk(pub).filter((x) => x.endsWith('.pak'))) {
    const out = path.join(src, path.relative(pub, f).replace(/\.pak$/, '.glb'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(unpackModel(fs.readFileSync(f))));
    console.log('unpacked', path.relative(root, out));
  }
} else {
  for (const f of walk(pub).filter((x) => x.endsWith('.glb'))) {
    const rel = path.relative(pub, f);
    fs.writeFileSync(f.replace(/\.glb$/, '.pak'), packModel(fs.readFileSync(f)));
    const keep = path.join(src, rel);
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    fs.renameSync(f, keep);
    console.log('packed', rel);
  }
}
