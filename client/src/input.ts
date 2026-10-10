import { clamp } from '@arena/shared';
import { zoomStep } from './camera';
import { TouchGestures, orbitBy, pinchZoom } from './touch';
import type { Action, Keybinds } from './keybinds';
import { isTyping } from './popups';

const TURN_SPEED = 2.6; // rad/s for A/D turning
const CLICK_MS = 350;

/**
 * WoW-style controls: hold RMB to steer (character faces the camera), LMB-drag to orbit the camera only,
 * A/D turn (or strafe while RMB is held), Q/E strafe, both mouse buttons run forward, scroll to zoom (all the way in = first person).
 */
/** What keeps its clicks while a ground spell is being aimed: the action bar, menus and windows, and form controls. */
const AIM_KEEPS = '.slot, #menu, .mm-modal, .mm-specpop, .devp, .mapw, .mwin, .announce, input, select, textarea, button, a, [data-aim-keep]';

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
  /** When the first button went down: holding a button to steer or orbit is never a click, however little the mouse moved. */
  private downAt = 0;
  private travel = 0; // pointer distance moved since a button went down (works under pointer lock)
  private jumpQueued = false;
  private mx = 0;
  private my = 0;

  private swallowUp = false;
  /** Both buttons were down in this gesture (steering): releasing one is never a click. */
  private multi = false;
  onClick: (x: number, y: number) => void = () => {};
  /** True while a ground spell waits for a click; the left press then places it instead of steering the camera. */
  aimActive: () => boolean = () => false;
  private swallowClick = false;
  /** How many times a move key has been pressed (not held down): a cast made on the move lets go of the walk at the next press. */
  movePresses = 0;
  onAimPress: () => void = () => {};
  /** A right-button click that did not turn the camera (WoW: target and auto-attack). */
  onRightClick: (x: number, y: number) => void = () => {};
  onKey: (code: string, e: KeyboardEvent) => void = () => {};
  /** Two quick taps on the scene (touch): when watching, the next unit to follow. */
  onDoubleTap: (x: number, y: number) => void = () => {};
  private touch = new TouchGestures();
  /** When a finger last touched the scene: the mouse events a browser makes up after a tap are ignored for a moment. */
  private touchAt = -1e9;
  /** True while playing or watching a match: then every bound key is the game's, not the browser's. */
  inMatch: () => boolean = () => false;

  constructor(canvas: HTMLCanvasElement, private binds: Keybinds) {
    window.addEventListener('keydown', (e) => {
      // typing in a text box is not playing; a focused slider or checkbox does not swallow the game's keys (Escape included)
      if (isTyping(e.target)) return;
      if (e.code === 'Tab') e.preventDefault();
      if (!this.enabled) {
        if (e.code === 'Escape' && !e.repeat) this.onKey(e.code, e);
        return;
      }
      if (e.code === 'Space') e.preventDefault(); // never scroll or click a focused button
      // in a match a bound key belongs to the game: Ctrl+R with R bound must not reload the page, Ctrl+S not save it
      if (this.inMatch() && this.binds.actionForEvent(e)) e.preventDefault();
      if (!e.repeat && this.binds.matches('jump', e)) this.jumpQueued = true;
      if (!e.repeat && (['forward', 'back', 'strafeLeft', 'strafeRight', 'turnLeft', 'turnRight'] as const).some((a) => this.binds.matches(a, e))) this.movePresses++;
      if (!e.repeat) this.onKey(e.code, e);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.rmb = this.lmb = false;
    });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.bindTouch(canvas);
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
        if (!this.enabled || this.fromTouch()) return;
        const other = this.lmb || this.rmb;
        // while a ground spell is being aimed, a left press over any frame, nameplate, chat or other HUD part places it (only the action bar,
        // menus and windows, and form controls keep their clicks)
        if (e.button === 0 && !other && e.target !== canvas && this.aimActive() && !(e.target as Element | null)?.closest?.(AIM_KEEPS)) {
          this.onAimPress();
          this.swallowUp = true;
          this.swallowClick = true;
          return;
        }
        // a press counts when it starts on the scene, or joins a button that is already steering
        if (e.target !== canvas && !other) return;
        if (e.button === 0 && e.target === canvas && this.aimActive()) {
          this.onAimPress();
          this.swallowUp = true;
          return;
        }
        this.multi = other;
        if (!other) {
          this.downX = e.clientX;
          this.downY = e.clientY;
          this.dragged = false;
          this.travel = 0;
          this.downAt = performance.now();
        }
        if (e.button === 0) this.lmb = true;
        if (e.button === 2) {
          this.rmb = true;
          if (!document.pointerLockElement) canvas.requestPointerLock?.();
        }
      },
      true,
    );
    // the click that follows a press the aim took must not also select, target or open what is under the cursor
    window.addEventListener(
      'click',
      (e) => {
        if (!this.swallowClick) return;
        this.swallowClick = false;
        e.stopPropagation();
        e.preventDefault();
      },
      true,
    );
    window.addEventListener('mouseup', (e) => {
      if (this.fromTouch()) return;
      if (e.button === 0 && this.swallowUp) {
        this.swallowUp = false;
        window.setTimeout(() => (this.swallowClick = false), 80);
        sync(e);
        return;
      }
      if (e.button === 0) {
        const wasDown = this.lmb;
        this.lmb = false;
        if (wasDown && this.enabled && !this.dragged && !this.rmb && !this.multi && this.quick()) this.onClick(e.clientX, e.clientY);
      }
      if (e.button === 2) {
        const wasDown = this.rmb;
        this.rmb = false;
        if (document.pointerLockElement) document.exitPointerLock();
        if (wasDown && this.enabled && !this.dragged && !this.lmb && !this.multi && this.quick()) this.onRightClick(this.downX, this.downY);
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
      this.travel += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (this.travel > 4) this.dragged = true;
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

  private fromTouch(): boolean {
    return performance.now() - this.touchAt < 800;
  }

  /**
   * Fingers on the scene: one finger drags the camera around, two pinch to zoom, a tap picks a unit and a double tap
   * is the "next" gesture. Nothing here needs a mouse, a keyboard or pointer lock, so watching works on a phone.
   */
  private bindTouch(canvas: HTMLCanvasElement) {
    const run = (gs: ReturnType<TouchGestures['move']>) => {
      for (const g of gs) {
        if (!this.enabled) continue;
        if (g.kind === 'orbit') {
          const o = orbitBy(this.yaw, this.pitch, g.dx, g.dy, this.sens);
          this.yaw = o.yaw;
          this.pitch = o.pitch;
        } else if (g.kind === 'pinch') this.dist = pinchZoom(this.dist, g.scale);
        else if (g.kind === 'tap') {
          if (this.aimActive()) this.onAimPress();
          else this.onClick(g.x, g.y);
        } else if (g.kind === 'doubletap') this.onDoubleTap(g.x, g.y);
      }
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      this.touchAt = performance.now();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* a finger that is already gone */
      }
      run(this.touch.down(e.pointerId, e.clientX, e.clientY, e.timeStamp));
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch') return;
      this.touchAt = performance.now();
      run(this.touch.move(e.pointerId, e.clientX, e.clientY, e.timeStamp));
    });
    const end = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      this.touchAt = performance.now();
      run(this.touch.up(e.pointerId, e.timeStamp));
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', (e) => {
      if (e.pointerType === 'touch') this.touch.cancel(e.pointerId);
    });
  }

  /** A click is a tap: a button held longer than this was steering or turning the camera, even without moving the mouse. */
  private quick(): boolean {
    return performance.now() - this.downAt <= CLICK_MS;
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
