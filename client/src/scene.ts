import * as THREE from 'three';
import { ARENA } from '@arena/shared';
import type { ClassId, TeamId } from '@arena/shared';
import { createCharacter, createSheep } from './models';
import { buildArenaEnvironment } from './arenaMap';
import type { ArenaEnvironment } from './arenaMap';
import type { Character } from './models';

export interface RenderUnit {
  id: number;
  classId: ClassId;
  team: TeamId;
  x: number;
  z: number;
  facing: number;
  alive: boolean;
  stealthed: boolean;
  casting: boolean;
  /** Polymorphed: drawn as a sheep. */
  sheep: boolean;
}

interface UnitMesh {
  group: THREE.Group;
  character: Character;
  sheep: Character;
  ring: THREE.Mesh;
  targetRing: THREE.Mesh;
  classId: ClassId;
  lastX: number;
  lastZ: number;
  phase: number;
  move: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Units are low-poly class models from models.ts. Swap those for glTF later. */
export class ArenaScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private meshes = new Map<number, UnitMesh>();
  private pillars: THREE.Mesh[] = [];
  private env: ArenaEnvironment;
  private raycaster = new THREE.Raycaster();
  private tmp = new THREE.Vector3();
  private lastUpdate = performance.now() / 1000;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 700);
    this.env = buildArenaEnvironment(this.scene, this.renderer);
    this.pillars = this.env.pillars;

    const resize = () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight, false);
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', resize);
    resize();
  }

  private createUnitMesh(id: number, classId: ClassId, x: number, z: number): UnitMesh {
    const group = new THREE.Group();
    const character = createCharacter(classId);
    const sheep = createSheep();
    sheep.root.visible = false;
    group.add(character.root, sheep.root);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.85, 32), new THREE.MeshBasicMaterial({ color: 0x3fbf5f, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    const targetRing = new THREE.Mesh(new THREE.RingGeometry(0.95, 1.12, 32), new THREE.MeshBasicMaterial({ color: 0xf1c40f, side: THREE.DoubleSide }));
    targetRing.rotation.x = -Math.PI / 2;
    targetRing.position.y = 0.05;
    targetRing.visible = false;
    group.add(ring, targetRing);
    for (const mesh of [...character.meshes, ...sheep.meshes, ring, targetRing]) mesh.userData.unitId = id;
    this.scene.add(group);
    return { group, character, sheep, ring, targetRing, classId, lastX: x, lastZ: z, phase: 0, move: 0 };
  }

  /** Cosmetic reactions, called from the effects system. */
  swing(id: number): void {
    this.meshes.get(id)?.character.swing();
  }
  flash(id: number): void {
    const m = this.meshes.get(id);
    m?.character.flash();
    m?.sheep.flash();
  }

  update(units: RenderUnit[], myTeam: TeamId, targetId: number | null): void {
    const nowS = performance.now() / 1000;
    const dt = Math.min(0.1, Math.max(0.001, nowS - this.lastUpdate));
    this.lastUpdate = nowS;
    const seen = new Set<number>();
    for (const u of units) {
      seen.add(u.id);
      let m = this.meshes.get(u.id);
      if (!m) {
        m = this.createUnitMesh(u.id, u.classId, u.x, u.z);
        this.meshes.set(u.id, m);
      }
      // walk cycle driven by how far the unit actually moved this frame
      const speed = Math.hypot(u.x - m.lastX, u.z - m.lastZ) / dt;
      m.lastX = u.x;
      m.lastZ = u.z;
      const target = u.alive && speed > 0.6 ? Math.min(1, speed / 7) : 0;
      m.move += (target - m.move) * Math.min(1, dt * 12);
      m.phase += speed * dt * 1.5;

      m.group.position.set(u.x, 0, u.z);
      m.group.rotation.y = u.facing;
      const active = u.sheep ? m.sheep : m.character;
      m.character.root.visible = !u.sheep;
      m.sheep.root.visible = u.sheep;
      active.setState(u.alive, u.stealthed);
      active.pose({ phase: m.phase, move: m.move, casting: u.alive && u.casting, time: nowS + u.id, dt });
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
    const groups = [...this.meshes.values()].map((m) => m.group);
    const hit = this.raycaster.intersectObjects(groups, true)[0];
    return hit ? (hit.object.userData.unitId as number) : null;
  }

  setPhase(phase: string): void {
    this.env.setPhase(phase);
  }

  render(): void {
    this.env.update(performance.now() / 1000);
    this.renderer.render(this.scene, this.camera);
  }
}
