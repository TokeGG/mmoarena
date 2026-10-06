import type { Action, Keybinds } from './keybinds';

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
  /** False while a menu is open: keys and mouse steering are ignored (Escape still reaches `onKey`). */
  enabled = true;
  /** Mouse look sensitivity multiplier. */
  sens = 1;
  private downX = 0;
  private downY = 0;
  private dragged = false;

  onClick: (x: number, y: number) => void = () => {};
  onKey: (code: string, e: KeyboardEvent) => void = () => {};

  constructor(canvas: HTMLCanvasElement, private binds: Keybinds) {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT') return;
      if (e.code === 'Tab') e.preventDefault();
      if (!this.enabled) {
        if (e.code === 'Escape' && !e.repeat) this.onKey(e.code, e);
        return;
      }
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
      if (!this.enabled) return;
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
        const wasDown = this.lmb;
        this.lmb = false;
        if (wasDown && this.enabled && !this.dragged) this.onClick(e.clientX, e.clientY);
      }
      if (e.button === 2) {
        this.rmb = false;
        if (document.pointerLockElement) document.exitPointerLock();
      }
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled || (!this.lmb && !this.rmb)) return;
      if (Math.abs(e.clientX - this.downX) + Math.abs(e.clientY - this.downY) > 4) this.dragged = true;
      this.yaw -= e.movementX * 0.005 * this.sens;
      this.pitch = clamp(this.pitch + e.movementY * 0.005 * this.sens, -0.15, 1.35);
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (!this.enabled) return;
        this.dist = clamp(this.dist * Math.exp(e.deltaY * 0.001), 3, 30);
      },
      { passive: false },
    );
  }

  private down(action: Action): number {
    return this.binds.codes(action).some((c) => this.keys.has(c)) ? 1 : 0;
  }

  /** Forget held keys, e.g. when a menu opens mid-run so the character does not keep walking. */
  releaseAll() {
    this.keys.clear();
    this.rmb = this.lmb = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Called once per fixed step. */
  sample(dtSec: number): { fwd: number; strafe: number; facing: number } {
    const fwd = this.down('forward') - this.down('back');
    const turn = this.down('turnLeft') - this.down('turnRight');
    let strafe = this.down('strafeRight') - this.down('strafeLeft');

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
