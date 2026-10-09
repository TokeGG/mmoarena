/**
 * Our own character during a Charge or a Heroic Leap. While the server moves us (`controlled`) our position is the server's, which
 * arrives as a snapshot every tick; the old code drew it between our last two snapshots by the time since our own 20 Hz step (a clock
 * unrelated to when the snapshots arrived) and let the camera anchor follow it with a heavy damping meant for stuns. At 34 yards per
 * second the anchor then lagged far enough behind to trip the "more than 4 yards away: jump to it" guard over and over, which looked
 * like blinking along the way. A dash is instead drawn exactly like everyone else is: on the snapshot timeline (continuous, see
 * interpolate() in main.ts), with the anchor following it without lag and never snapping, until the drawn position has caught up with
 * the server's. This tracker only decides WHEN that applies. Pure; unit tested in client/test/dashPath.test.ts.
 */

/** Faster than this many times our run speed (while the server moves us) is a dash, not a stumble or a slow. */
export const DASH_SPEED_FACTOR = 1.6;
/** The drawn position counts as arrived once it is this close (yards) to where the server has us. */
export const DASH_ARRIVED = 0.35;
/** A dash is never held longer than this (ms of server time) after the last fast snapshot. */
export const DASH_HOLD_MS = 1500;

export class DashTracker {
  private lastT = NaN;
  private lastX = 0;
  private lastZ = 0;
  private fastAt = -Infinity;
  private active = false;

  reset(): void {
    this.lastT = NaN;
    this.fastAt = -Infinity;
    this.active = false;
  }

  /** Feed every snapshot: server time (ms), our position in it, whether the server is moving us, our run speed (yards/s, bonuses included). */
  sample(t: number, x: number, z: number, controlled: boolean, runSpeed: number): void {
    if (!(t > this.lastT)) this.reset(); // the clock went back (a new match, a rewind)
    if (Number.isFinite(this.lastT) && controlled && runSpeed > 0) {
      const v = Math.hypot(x - this.lastX, z - this.lastZ) / ((t - this.lastT) / 1000);
      if (v > runSpeed * DASH_SPEED_FACTOR) {
        this.active = true;
        this.fastAt = t;
      }
    }
    this.lastT = t;
    this.lastX = x;
    this.lastZ = z;
  }

  /**
   * Every frame: is our own character drawn along the snapshot timeline? `shown` is where that timeline has us, `server` the newest
   * snapshot's position. A dash goes on while the server moves us and, after it ends, until the drawn position reaches the server's.
   */
  dashing(snapT: number, shown: { x: number; z: number } | undefined, server: { x: number; z: number }, controlled: boolean): boolean {
    if (!this.active) return false;
    if (snapT - this.fastAt > DASH_HOLD_MS) this.active = false;
    else if (!controlled && snapT > this.fastAt && (!shown || Math.hypot(shown.x - server.x, shown.z - server.z) < DASH_ARRIVED)) this.active = false;
    return this.active;
  }
}

/**
 * The share of the way the camera anchor moves to the drawn position this frame: all of it (no lag) in a dash (the path is already smooth, any damping
 * only makes it fall behind), heavily damped while the server holds us (stun, fear), nearly instant otherwise.
 */
export function anchorBlend(dtSec: number, dashing: boolean, held: boolean): number {
  return dashing ? 1 : 1 - Math.exp(-dtSec * (held ? 5 : 38));
}

/** Whether the anchor should jump to the target instead of gliding: a far-off target is a teleport (Blink), never a dash. */
export function anchorSnaps(distance: number, dashing: boolean): boolean {
  return !dashing && distance > 4;
}
