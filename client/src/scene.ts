import * as THREE from 'three';
import { ARENA, CLASSES } from '@arena/shared';
import type { ClassId, TeamId } from '@arena/shared';

export interface RenderUnit {
  id: number;
  classId: ClassId;
  team: TeamId;
  x: number;
  z: number;
  facing: number;
  alive: boolean;
  stealthed: boolean;
}

interface UnitMesh {
  group: THREE.Group;
  body: THREE.Mesh;
  ring: THREE.Mesh;
  targetRing: THREE.Mesh;
  classId: ClassId;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Capsules per class for now. Swap `createUnitMesh` for a glTF loader once the sim feels good. */
export class ArenaScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private meshes = new Map<number, UnitMesh>();
  private pillars: THREE.Mesh[] = [];
  private raycaster = new THREE.Raycaster();
  private tmp = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
    this.scene.background = new THREE.Color(0x0b0d12);
    this.scene.fog = new THREE.Fog(0x0b0d12, 45, 110);

    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x20242e, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(-20, 40, 15);
    this.scene.add(sun);

    const b = ARENA.bounds;
    const w = b.maxX - b.minX;
    const d = b.maxZ - b.minZ;
    const cx = (b.maxX + b.minX) / 2;
    const cz = (b.maxZ + b.minZ) / 2;

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ color: 0x1a1f2b, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0, cz);
    this.scene.add(floor);
    const grid = new THREE.GridHelper(Math.max(w, d), Math.max(w, d) / 2, 0x2a3140, 0x232938);
    grid.position.set(cx, 0.01, cz);
    this.scene.add(grid);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a3140 });
    const wall = (sx: number, sz: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, 5, sz), wallMat);
      m.position.set(x, 2.5, z);
      this.scene.add(m);
    };
    wall(w + 2, 1, cx, b.minZ - 0.5);
    wall(w + 2, 1, cx, b.maxZ + 0.5);
    wall(1, d, b.minX - 0.5, cz);
    wall(1, d, b.maxX + 0.5, cz);

    // Start gates (only enforced during the prep phase).
    for (const gx of [-ARENA.gateX, ARENA.gateX]) {
      const gate = new THREE.Mesh(
        new THREE.PlaneGeometry(0.2, d),
        new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
      );
      gate.rotation.x = -Math.PI / 2;
      gate.position.set(gx, 0.03, cz);
      this.scene.add(gate);
    }

    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x3a4258, roughness: 0.9 });
    for (const p of ARENA.pillars) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r, 8, 28), pillarMat);
      m.position.set(p.x, 4, p.z);
      this.scene.add(m);
      this.pillars.push(m);
    }

    const resize = () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight, false);
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', resize);
    resize();
  }

  private createUnitMesh(id: number, classId: ClassId): UnitMesh {
    const group = new THREE.Group();
    const color = new THREE.Color(CLASSES[classId].color);
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.45, 1.1, 4, 12),
      new THREE.MeshStandardMaterial({ color, roughness: 0.6 }),
    );
    body.position.y = 1.0;
    body.userData.unitId = id;
    // A small nub marks the front so facing is readable.
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 0.4), new THREE.MeshStandardMaterial({ color: 0xffffff }));
    nose.position.set(0, 1.5, 0.5);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.85, 32), new THREE.MeshBasicMaterial({ color: 0x3fbf5f, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    const targetRing = new THREE.Mesh(new THREE.RingGeometry(0.95, 1.12, 32), new THREE.MeshBasicMaterial({ color: 0xf1c40f, side: THREE.DoubleSide }));
    targetRing.rotation.x = -Math.PI / 2;
    targetRing.position.y = 0.05;
    targetRing.visible = false;
    group.add(body, nose, ring, targetRing);
    this.scene.add(group);
    return { group, body, ring, targetRing, classId };
  }

  update(units: RenderUnit[], myTeam: TeamId, targetId: number | null): void {
    const seen = new Set<number>();
    for (const u of units) {
      seen.add(u.id);
      let m = this.meshes.get(u.id);
      if (!m) {
        m = this.createUnitMesh(u.id, u.classId);
        this.meshes.set(u.id, m);
      }
      m.group.position.set(u.x, 0, u.z);
      m.group.rotation.y = u.facing;
      const mat = m.body.material as THREE.MeshStandardMaterial;
      if (u.alive) {
        m.body.rotation.x = 0;
        m.body.position.y = 1.0;
        mat.color.set(CLASSES[u.classId].color);
      } else {
        m.body.rotation.x = Math.PI / 2;
        m.body.position.y = 0.45;
        mat.color.set(0x555555);
      }
      mat.transparent = u.stealthed;
      mat.opacity = u.stealthed ? 0.35 : 1;
      (m.ring.material as THREE.MeshBasicMaterial).color.set(u.team === myTeam ? 0x3fbf5f : 0xc0392b);
      m.ring.visible = u.alive;
      m.targetRing.visible = u.id === targetId;
    }
    for (const [id, m] of this.meshes) {
      if (seen.has(id)) continue;
      this.scene.remove(m.group);
      this.meshes.delete(id);
    }
  }

  /** Third-person orbit camera. Facing `yaw` is the direction the camera looks; pillars pull it in. */
  setCamera(fx: number, fz: number, yaw: number, pitch: number, dist: number): void {
    const head = new THREE.Vector3(fx, 1.8, fz);
    const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const h = Math.cos(pitch);
    const offset = new THREE.Vector3(-dir.x * h, Math.sin(pitch), -dir.z * h);

    this.raycaster.set(head, offset);
    this.raycaster.far = dist;
    const hits = this.raycaster.intersectObjects(this.pillars, false);
    const d = hits.length ? Math.max(1.5, hits[0].distance - 0.4) : dist;

    const pos = head.clone().addScaledVector(offset, d);
    const b = ARENA.bounds;
    pos.x = clamp(pos.x, b.minX + 0.5, b.maxX - 0.5);
    pos.z = clamp(pos.z, b.minZ + 0.5, b.maxZ - 0.5);
    pos.y = Math.max(0.5, pos.y);
    this.camera.position.copy(pos);
    this.camera.lookAt(head);
  }

  /** World point to screen pixels. */
  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    this.tmp.set(x, y, z).project(this.camera);
    return {
      x: ((this.tmp.x + 1) / 2) * window.innerWidth,
      y: ((1 - this.tmp.y) / 2) * window.innerHeight,
      visible: this.tmp.z < 1 && Math.abs(this.tmp.x) < 1.3 && Math.abs(this.tmp.y) < 1.3,
    };
  }

  /** Unit id under the pointer, or null. */
  pick(clientX: number, clientY: number): number | null {
    const ndc = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.far = 200;
    const bodies = [...this.meshes.values()].map((m) => m.body);
    const hit = this.raycaster.intersectObjects(bodies, false)[0];
    return hit ? (hit.object.userData.unitId as number) : null;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
