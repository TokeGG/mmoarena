import { resolveCollisions, heightAt, PLAYER_RADIUS, type ArenaDef } from '@arena/shared';

/** How far apart the menu's party members stand, in yards. */
export const MENU_SLOT_GAP = 2.4;

/** The i-th place beside the spawn: 0 is the middle, then alternately one side and the other. */
export const slotOffset = (i: number) => (i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * MENU_SLOT_GAP);

/** A spot is usable when the sim's own collision would leave a unit standing there, on the ground (the spawn pens sit behind the gate line, so that line is no limit here). */
export function freeGround(arena: ArenaDef, x: number, z: number): boolean {
  const p = resolveCollisions({ x, z }, arena, 0);
  return Math.hypot(p.x - x, p.z - z) < 0.01 && heightAt(arena, x, z, 0) === 0;
}

/**
 * Where the menu stands the unit in slot `i` (0 = you, 1.. = party mates) on `arena`: beside the first spawn along its
 * row, on free ground. A slot that lands inside a wall, pillar, ramp or barricade tries closer to you and then the other
 * side; null when nothing is free (the mate is then left out). The first spawn itself is always returned for slot 0.
 */
export function menuSpot(arena: ArenaDef, i: number): { x: number; z: number } | null {
  const s = arena.spawns[0][0];
  if (i === 0) return { x: s.x, z: s.z };
  const f = arena.spawnFacing[0];
  const right = { x: Math.cos(f), z: -Math.sin(f) };
  const want = slotOffset(i);
  for (const k of [1, 0.75, 0.5, -0.5, -0.75, -1]) {
    const o = want * k;
    const x = s.x + right.x * o;
    const z = s.z + right.z * o;
    if (freeGround(arena, x, z)) return { x, z };
  }
  return null;
}

/** Positions for you and up to `mates` party members; members that find no free ground are dropped (undefined entries are never returned). */
export function menuSpots(arena: ArenaDef, mates: number): ({ x: number; z: number } | null)[] {
  const out: ({ x: number; z: number } | null)[] = [];
  const taken: { x: number; z: number }[] = [];
  for (let i = 0; i <= mates; i++) {
    const p = menuSpot(arena, i);
    // never stack two units on the same spot
    out.push(p && taken.every((t) => Math.hypot(t.x - p.x, t.z - p.z) > PLAYER_RADIUS * 1.5) ? p : null);
    if (out[i]) taken.push(out[i]!);
  }
  return out;
}
