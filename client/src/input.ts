import { zoomStep } from './camera';
import type { Action, Keybinds } from './keybinds';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const TURN_SPEED = 2.6; // rad/s for A/D turning

/**
 * WoW-style controls: hold RMB to steer (character faces the camera), LMB-drag to orbit the camera only,
 * A/D turn (or strafe while RMB is held), Q/E strafe, both mouse buttons run forward, scroll to zoom (all the way in = first person).
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
  private jumpQueued = false;
  private mx = 0;
  private my = 0;

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
      if (e.code === 'Space') e.preventDefault(); // never scroll or click a focused button
      if (!e.repeat && this.binds.matches('jump', e)) this.jumpQueued = true;
      if (!e.repeat) this.onKey(e.code, e);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.rmb = this.lmb = false;
    });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // Mouse state is read from `e.buttons` on every event, so a second button pressed while the first is held
    // (or over a HUD element, or while the pointer is locked) is never missed, and a lost mouseup cannot stick.
    const sync = (e: MouseEvent) => {
      if (!(e.buttons & 1)) this.lmb = false;
      if (!(e.buttons & 2)) {
        if (this.rmb && document.pointerLockElement) document.exitPointerLock();
        this.rmb = false;
      }
    };
    window.addEventListener(
      'mousedown',
      (e) => {
        if (!this.enabled) return;
        const other = this.lmb || this.rmb;
        // a press counts when it starts on the scene, or joins a button that is already steering
        if (e.target !== canvas && !other) return;
        if (!other) {
          this.downX = e.clientX;
          this.downY = e.clientY;
          this.dragged = false;
        }
        if (e.button === 0) this.lmb = true;
        if (e.button === 2) {
          this.rmb = true;
          if (!document.pointerLockElement) canvas.requestPointerLock?.();
        }
      },
      true,
    );
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        const wasDown = this.lmb;
        this.lmb = false;
        if (wasDown && this.enabled && !this.dragged && !this.rmb) this.onClick(e.clientX, e.clientY);
      }
      if (e.button === 2) {
        this.rmb = false;
        if (document.pointerLockElement) document.exitPointerLock();
      }
      sync(e);
    });
    window.addEventListener('mousemove', (e) => {
      sync(e);
      if (!document.pointerLockElement) {
        this.mx = e.clientX;
        this.my = e.clientY;
      }
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
        this.dist = zoomStep(this.dist, e.deltaY);
      },
      { passive: false },
    );
  }

  /** Where the cursor is, for aimed spells. While steering with the right button the cursor is locked, so aim at screen centre. */
  cursor(): { x: number; y: number } {
    return document.pointerLockElement ? { x: window.innerWidth / 2, y: window.innerHeight / 2 } : { x: this.mx, y: this.my };
  }

  private down(action: Action): number {
    return this.binds.isHeld(action, this.keys) ? 1 : 0;
  }

  /** Forget held keys, e.g. when a menu opens mid-run so the character does not keep walking. */
  releaseAll() {
    this.keys.clear();
    this.jumpQueued = false;
    this.rmb = this.lmb = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Called once per fixed step. */
  sample(dtSec: number): { fwd: number; strafe: number; facing: number; jump: boolean } {
    const jump = this.jumpQueued;
    this.jumpQueued = false;
    let fwd = this.down('forward') - this.down('back');
    if (this.lmb && this.rmb) fwd = 1; // both mouse buttons held runs forward, like WoW
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
    return { fwd, strafe: clamp(strafe, -1, 1), facing: this.facing, jump };
  }
}
