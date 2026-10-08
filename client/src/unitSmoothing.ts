/** The per-unit state the scene smooths over frames: speed from the last position, the animation blend and the floor height. */
export interface UnitSmoothing {
  lastX: number;
  lastZ: number;
  baseY?: number;
  fallV?: number;
  phase: number;
  move: number;
  vf: number;
  vs: number;
}

/**
 * Put a unit's smoothing state where it stands now: no speed (a unit that was moved by the scene, not by walking, must not
 * look like it sprinted), no walk blend, and the floor height right under it instead of a stale one from the old map.
 */
export function snapUnit(m: UnitSmoothing, x: number, z: number, ground: number): void {
  m.lastX = x;
  m.lastZ = z;
  m.baseY = ground;
  m.fallV = 0;
  m.phase = 0;
  m.move = 0;
  m.vf = 0;
  m.vs = 0;
}
