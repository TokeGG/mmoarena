import * as THREE from 'three';
import type { ArenaDef } from '@arena/shared';
import { buildArenaEnvironment } from './arenaMap';
import type { ArenaEnvironment } from './arenaMap';

/**
 * The map editor's 3D view: the arena drawn by the game's own scenery builder (arenaMap.ts), so what is seen here is what a match
 * shows, with the real depth of walkways, ramps, walls and pillars. Orbit with the left button, pan with the right, zoom with the
 * wheel; the start spots are marked with cones (blue: team 1, red: team 2). It has a renderer of its own and runs only while shown.
 */
export class MapView3D {
  readonly canvas = document.createElement('canvas');
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 1, 0.1, 900);
  private env: ArenaEnvironment | null = null;
  private marks = new THREE.Group();
  private arena: ArenaDef | null = null;
  private builtFor = '';
  private target = new THREE.Vector3();
  private yaw = 0.6;
  private pitch = 0.75;
  private dist = 60;
  private raf = 0;
  private running = false;
  private rebuild = 0;
  private failed = false;

  constructor() {
    this.canvas.className = 'mape-3d';
    this.canvas.tabIndex = 0;
    this.scene.add(this.marks);
    this.wire();
  }

  /** Is WebGL available here? (a failed start shows a note instead of a blank picture) */
  get unavailable(): boolean {
    return this.failed;
  }

  private ensureRenderer(): THREE.WebGLRenderer | null {
    if (this.renderer || this.failed) return this.renderer;
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    } catch {
      this.failed = true;
    }
    return this.renderer;
  }

  /** The map to show (rebuilt shortly after the last call, so typing and dragging stay smooth). */
  set(a: ArenaDef): void {
    this.arena = a;
    if (!this.running) return;
    window.clearTimeout(this.rebuild);
    this.rebuild = window.setTimeout(() => this.build(), 250);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (!this.ensureRenderer()) return;
    this.build();
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.rebuild);
  }

  /** Free everything (the window closed). */
  dispose(): void {
    this.stop();
    this.env?.dispose();
    this.env = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.builtFor = '';
  }

  private build(): void {
    const a = this.arena;
    const r = this.renderer;
    if (!a || !r) return;
    const key = JSON.stringify(a);
    if (key === this.builtFor) return;
    this.builtFor = key;
    try {
      this.env?.dispose();
      this.env = buildArenaEnvironment(this.scene, r, a);
    } catch {
      this.env = null; // a half-typed number (NaN) can make a piece unbuildable for a moment
      return;
    }
    this.marks.clear();
    const b = a.bounds;
    this.target.set((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    if (!Number.isFinite(span)) return;
    if (this.dist === 60 || this.dist > span * 3) this.dist = Math.max(20, span * 1.15);
    a.spawns.forEach((team, t) => {
      const mat = new THREE.MeshBasicMaterial({ color: t === 0 ? 0x3a78ff : 0xff4a3e, transparent: true, opacity: 0.85 });
      for (const [i, p] of team.entries()) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.6, 12), mat);
        cone.position.set(p.x, 0.8, p.z);
        this.marks.add(cone);
        void i;
      }
    });
    // the gates: a thin line across the arena at each start line
    for (const x of [-a.gateX, a.gateX]) {
      const line = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, b.maxZ - b.minZ), new THREE.MeshBasicMaterial({ color: 0xffe08a }));
      line.position.set(x, 0.1, (b.minZ + b.maxZ) / 2);
      this.marks.add(line);
    }
  }

  private frame(): void {
    const r = this.renderer;
    if (!r) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w > 0 && h > 0 && (this.canvas.width !== Math.round(w * r.getPixelRatio()) || this.canvas.height !== Math.round(h * r.getPixelRatio()))) {
      r.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    const cp = Math.cos(this.pitch);
    this.camera.position.set(this.target.x + Math.sin(this.yaw) * cp * this.dist, this.target.y + Math.sin(this.pitch) * this.dist, this.target.z + Math.cos(this.yaw) * cp * this.dist);
    this.camera.lookAt(this.target);
    this.env?.update(performance.now() / 1000, this.camera);
    r.render(this.scene, this.camera);
  }

  /** Camera presets: from above, along the length of the arena, and a corner. */
  view(kind: 'top' | 'side' | 'corner'): void {
    this.yaw = kind === 'corner' ? 0.6 : 0;
    this.pitch = kind === 'top' ? 1.5 : kind === 'side' ? 0.28 : 0.75;
  }

  private wire(): void {
    const c = this.canvas;
    let drag: { x: number; y: number; pan: boolean } | null = null;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.focus();
      c.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.pan) {
        // slide the target along the ground, in the direction the camera looks
        const k = this.dist * 0.0016;
        const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
        const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
        this.target.x += (-dx * rx + dy * fx) * k;
        this.target.z += (-dx * rz + dy * fz) * k;
      } else {
        this.yaw -= dx * 0.008;
        this.pitch = Math.max(0.08, Math.min(1.5, this.pitch + dy * 0.006));
      }
    });
    const end = () => (drag = null);
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.dist = Math.max(8, Math.min(220, this.dist * (e.deltaY > 0 ? 1.1 : 0.9)));
      },
      { passive: false },
    );
  }
}
