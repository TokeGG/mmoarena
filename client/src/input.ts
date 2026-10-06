const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const TURN_SPEED = 2.6; // rad/s for A/D turning

/**
 * WoW-style controls: hold RMB to steer (character faces the camera), LMB-drag to orbit the camera only,
 * A/D turn (or strafe while RMB is held), Q/E strafe, scroll to zoom.
 */
export class Controls {
  private keys = new Set<string>();
  yaw = 0;
  pitch = 0.35;
  dist = 12;
  /** Direction the character faces. Sent to the server with every input. */
  facing = 0;
  rmb = false;
  private lmb = false;
  private downX = 0;
  private downY = 0;
  private dragged = false;

  onClick: (x: number, y: number) => void = () => {};
  onKey: (code: string, e: KeyboardEvent) => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.code === 'Tab') e.preventDefault();
      if (!e.repeat) this.onKey(e.code, e);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.rmb = this.lmb = false;
    });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => {
      this.downX = e.clientX;
      this.downY = e.clientY;
      this.dragged = false;
      if (e.button === 0) this.lmb = true;
      if (e.button === 2) {
        this.rmb = true;
        canvas.requestPointerLock?.();
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        this.lmb = false;
        if (!this.dragged) this.onClick(e.clientX, e.clientY);
      }
      if (e.button === 2) {
        this.rmb = false;
        if (document.pointerLockElement) document.exitPointerLock();
      }
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.lmb && !this.rmb) return;
      if (Math.abs(e.clientX - this.downX) + Math.abs(e.clientY - this.downY) > 4) this.dragged = true;
      this.yaw -= e.movementX * 0.005;
      this.pitch = clamp(this.pitch + e.movementY * 0.005, -0.15, 1.35);
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.dist = clamp(this.dist * Math.exp(e.deltaY * 0.001), 3, 30);
      },
      { passive: false },
    );
  }

  private down(...codes: string[]): number {
    return codes.some((c) => this.keys.has(c)) ? 1 : 0;
  }

  /** Called once per fixed step. */
  sample(dtSec: number): { fwd: number; strafe: number; facing: number } {
    const fwd = this.down('KeyW', 'ArrowUp') - this.down('KeyS', 'ArrowDown');
    const turn = this.down('KeyA', 'ArrowLeft') - this.down('KeyD', 'ArrowRight');
    let strafe = this.down('KeyE') - this.down('KeyQ');

    if (this.rmb) {
      strafe -= turn; // A/D strafe while steering
      this.facing = this.yaw;
    } else if (turn !== 0) {
      this.yaw += turn * TURN_SPEED * dtSec;
      this.facing = this.yaw;
    } else if (fwd !== 0 || strafe !== 0) {
      this.facing = this.yaw; // moving snaps the character to the camera heading
    }
    return { fwd, strafe: clamp(strafe, -1, 1), facing: this.facing };
  }
}
