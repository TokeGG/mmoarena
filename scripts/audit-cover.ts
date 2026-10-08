/**
 * Cover audit: for every pillar, wall and low barricade of every arena, how far does the DRAWN piece reach beyond (or fall
 * short of) the shape the sim blocks with, at 0.1 / 0.5 / 1.0 / 1.4 (chest) / 2.0 / 2.5 yards?
 *   npx tsx scripts/audit-cover.ts          # a table per arena plus every problem (exit code 1 if there is one)
 *   npx tsx scripts/audit-cover.ts --rows   # also every measured row
 * Pillars are circles (r), walls and lows are boxes; a pillar must be drawn between r - 0.1 and r + 0.04 at every height,
 * a wall or low within 0.1 of its rect. See DEVELOPING.md, "Cover: what you see is what blocks".
 */
import { ARENAS } from '@arena/shared';
import { auditArena } from '../client/src/coverAudit';

const rows = process.argv.includes('--rows');
let bad = 0;
const f = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(2);
console.log('arena        pillars (worst over / under)   walls (over / under)   lows (over / under)   problems');
for (const a of ARENAS) {
  const r = auditArena(a);
  const worst = (list: { over: number; under: number }[]) => [Math.max(0, ...list.map((x) => x.over)), Math.max(0, ...list.map((x) => x.under))] as const;
  const [po, pu] = worst(r.pillars), [wo, wu] = worst(r.walls), [lo, lu] = worst(r.lows);
  console.log(`${a.id.padEnd(12)} ${f(po)} / -${pu.toFixed(2)}`.padEnd(48) + `${r.walls.length ? `${f(wo)} / -${wu.toFixed(2)}` : '-'}`.padEnd(23) + `${r.lows.length ? `${f(lo)} / -${lu.toFixed(2)}` : '-'}`.padEnd(22) + r.problems.length);
  if (rows) for (const x of [...r.pillars, ...r.walls, ...r.lows]) console.log('   ', JSON.stringify(x));
  for (const p of r.problems) console.log(`  ! ${a.id}: ${p}`);
  bad += r.problems.length;
}
if (bad) {
  console.log(`\n${bad} problem(s).`);
  process.exit(1);
}
console.log('\nEvery pillar, wall and low is drawn within tolerance of what blocks.');
