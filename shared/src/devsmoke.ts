import { ArenaSim } from './sim';
import { ABILITIES } from './data';
import { CLASS_IDS } from './data';
import { applyPatches, isEntityPatch } from './devpatch';
import type { DataPatch } from './devpatch';
import type { ClassId, TeamId } from './types';

/**
 * Runs a short fight with the changes in place (every class, every skill the changes touch cast again and again) and says what broke, in
 * plain words, or null when it ran. An entry rewritten as data can pass the shape checks and still stop the sim (a missing field, a loop);
 * this is what keeps that out of a live match and out of the repository.
 */
export function smokeProblem(patches: readonly DataPatch[]): string | null {
  if (!patches.some(isEntityPatch)) return null;
  const undo = applyPatches(patches);
  try {
    const touched = new Set(patches.filter((p) => p.file === 'abilities').map((p) => p.id));
    const sim = new ArenaSim({ seed: 5, prepMs: 0 });
    CLASS_IDS.forEach((c: ClassId, i) => {
      const u = sim.addUnit({ name: c, classId: c, team: (i % 2) as TeamId, controller: 'dummy' });
      u.pos = { x: (i - 1.5) * 4, z: i % 2 ? 6 : -6 };
      u.maxHealth = u.health = 1e6;
    });
    for (let t = 0; t < 240; t++) {
      for (const u of sim.units.values()) {
        const ids = u.bar.filter((a) => touched.has(a) || t % 20 === 0);
        for (const a of ids) {
          const foe = [...sim.units.values()].find((x) => x.team !== u.team);
          if (ABILITIES[a]) sim.useAbility(u.id, a, foe?.id);
        }
        // a skill the changes added to a bar of its own class
        for (const a of touched) if (ABILITIES[a]?.class === u.classId && !u.bar.includes(a)) sim.useAbility(u.id, a, [...sim.units.values()].find((x) => x.team !== u.team)?.id);
      }
      sim.step();
      sim.drainEvents();
    }
    return null;
  } catch (e) {
    return `That change breaks the game when it runs: ${(e as Error).message}`;
  } finally {
    undo();
  }
}
