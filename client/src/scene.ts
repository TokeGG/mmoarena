import { cameraReach } from './camera';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { arenaById, heightAt, onRaised, clamp } from '@arena/shared';
import type { ArenaDef } from '@arena/shared';
import type { ClassId, TeamId } from '@arena/shared';
import { createCharacter, createSheep } from './models';
import { modelVersion } from './riggedModels';
import { buildArenaEnvironment } from './arenaMap';
import type { ArenaEnvironment } from './arenaMap';
import type { Character } from './models';
import { TARGET_COLORS, look as hudLook } from './hudLook';

export interface RenderUnit {
  id: number;
  classId: ClassId;
  team: TeamId;
  x: number;
  z: number;
  /** Height above the ground (jumping). */
  y: number;
  /** Bridge level: 1 on the deck and ramps. */
  lv?: number;
  facing: number;
  alive: boolean;
  stealthed: boolean;
  casting: boolean;
  /** Polymorphed: drawn as a sheep. */
  sheep: boolean;
  /** Gear summary (see gearLook in shared); a change rebuilds the model. */
  look?: string;
  /** Weapon id (warrior specs) — a change rebuilds the model. */
  weapon?: string;
}

interface UnitMesh {
  group: THREE.Group;
  character: Character;
  sheep: Character;
  ring: THREE.Mesh;
  targetRing: THREE.Mesh;
  classId: ClassId;
  look: string;
  weapon: string;
  /** `modelVersion()` the character was built with: a rigged model that loads later triggers a rebuild. */
  modelVer: number;
  lastX: number;
  /** Drawn floor height under the unit: follows ramps directly, drops with gravity off a ledge. */
  baseY?: number;
  fallV?: number;
  lastZ: number;
  phase: number;
  move: number;
  vf: number;
  vs: number;
}


/** Units are low-poly class models from models.ts. Swap those for glTF later. */
const TARGET_RING_GEO: Record<string, THREE.BufferGeometry> = {
  normal: new THREE.RingGeometry(0.95, 1.12, 32),
  thin: new THREE.RingGeometry(1.0, 1.06, 32),
  thick: new THREE.RingGeometry(0.85, 1.2, 32),
  disc: new THREE.CircleGeometry(1.1, 32),
};

export class ArenaScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private meshes = new Map<number, UnitMesh>();
  private pillars: THREE.Mesh[] = [];
  private env: ArenaEnvironment;
  private arena: ArenaDef = arenaById(undefined);
  private phase = 'prep';
  private raycaster = new THREE.Raycaster();
  private tmp = new THREE.Vector3();
  private lastUpdate = performance.now() / 1000;
  /** Bloom + colour grade. Null if the GPU refused it; we then fall back to a plain render. */
  private composer: EffectComposer | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 700);
    this.env = buildArenaEnvironment(this.scene, this.renderer, this.arena);
    this.pillars = this.env.pillars;

    const resize = () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight, false);
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.applyShift(true);
      this.composer?.setPixelRatio(this.renderer.getPixelRatio());
      this.composer?.setSize(window.innerWidth, window.innerHeight);
    };
    this.composer = this.buildComposer();
    window.addEventListener('resize', resize);
    resize();
  }

  private shift = { x: 0, y: 0 };
  /** Slides the whole picture by a fraction of the screen (x right, y down), e.g. to keep the menu model clear of a docked window. */
  setViewShift(x: number, y: number) {
    this.shift.x += (x - this.shift.x) * 0.2;
    this.shift.y += (y - this.shift.y) * 0.2;
    if (Math.abs(this.shift.x - x) < 0.0005) this.shift.x = x;
    if (Math.abs(this.shift.y - y) < 0.0005) this.shift.y = y;
    this.applyShift(false);
  }
  private applied = { x: 0, y: 0 };
  private applyShift(force: boolean) {
    const { x, y } = this.shift;
    if (!force && x === this.applied.x && y === this.applied.y) return;
    this.applied = { x, y };
    const w = window.innerWidth, h = window.innerHeight;
    if (x === 0 && y === 0) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h, -x * w, -y * h, w, h);
    this.camera.updateProjectionMatrix();
  }

  /** Bloom makes torches, runes and spell glows bloom; the grade adds a warm punch and a soft vignette. */
  private buildComposer(): EffectComposer | null {
    try {
      const target = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { type: THREE.HalfFloatType, samples: 4 });
      const composer = new EffectComposer(this.renderer, target);
      composer.addPass(new RenderPass(this.scene, this.camera));
      composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.7, 0.75, 1.5));
      composer.addPass(new OutputPass()); // tone mapping + sRGB
      composer.addPass(
        new ShaderPass({
          uniforms: { tDiffuse: { value: null }, vig: { value: 0.42 }, sat: { value: 1.14 }, contrast: { value: 1.07 } },
          vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader: `uniform sampler2D tDiffuse; uniform float vig; uniform float sat; uniform float contrast; varying vec2 vUv;
            void main(){
              vec4 c = texture2D(tDiffuse, vUv);
              float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
              c.rgb = mix(vec3(l), c.rgb, sat);
              c.rgb = (c.rgb - 0.5) * contrast + 0.5;
              c.rgb *= vec3(1.03, 1.0, 0.95);
              float d = distance(vUv, vec2(0.5));
              c.rgb *= 1.0 - vig * smoothstep(0.35, 0.85, d);
              gl_FragColor = c;
            }`,
        }),
      );
      return composer;
    } catch (e) {
      console.warn('post-processing unavailable, using plain rendering', e);
      return null;
    }
  }

  private createUnitMesh(id: number, classId: ClassId, look: string, weapon: string, x: number, z: number): UnitMesh {
    const group = new THREE.Group();
    const character = createCharacter(classId, look, weapon || undefined);
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
    return { group, character, sheep, ring, targetRing, classId, look, weapon, modelVer: modelVersion(), lastX: x, lastZ: z, phase: 0, move: 0, vf: 0, vs: 0 };
  }

  /** Swap the scenery (and the camera's pillar collision) to another arena. A no-op if it is already showing. */
  setMap(id: string): void {
    if (id === this.arena.id) return;
    this.env.dispose();
    this.arena = arenaById(id);
    this.env = buildArenaEnvironment(this.scene, this.renderer, this.arena);
    this.pillars = this.env.pillars;
    this.env.setPhase(this.phase);
  }

  /** Cosmetic reactions, called from the effects system. */
  swing(id: number, fast = false): void {
    this.meshes.get(id)?.character.swing(fast);
  }
  /** A spell was cast: models with a cast animation play it. */
  cast(id: number): void {
    this.meshes.get(id)?.character.cast?.();
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
        m = this.createUnitMesh(u.id, u.classId, u.look ?? '', u.weapon ?? '', u.x, u.z);
        this.meshes.set(u.id, m);
      } else if (m.classId !== u.classId || m.look !== (u.look ?? '') || m.weapon !== (u.weapon ?? '') || m.modelVer !== modelVersion()) {
        // a different class or different gear (menu preview, or a spectated unit): rebuild the model in place
        m.group.remove(m.character.root);
        m.character = createCharacter(u.classId, u.look ?? '', u.weapon || undefined);
        m.group.add(m.character.root);
        for (const mesh of m.character.meshes) mesh.userData.unitId = u.id;
        m.classId = u.classId;
        m.look = u.look ?? '';
        m.weapon = u.weapon ?? '';
        m.modelVer = modelVersion(); // a rigged model that finished loading replaces the procedural stand-in
      }
      // walk cycle driven by how far the unit actually moved this frame
      const vx = (u.x - m.lastX) / dt;
      const vz = (u.z - m.lastZ) / dt;
      const speed = Math.min(14, Math.hypot(vx, vz));
      m.lastX = u.x;
      m.lastZ = u.z;
      // velocity relative to where the unit faces: forward/back and sideways (towards its left)
      const fwdV = vx * Math.sin(u.facing) + vz * Math.cos(u.facing);
      const sideV = vx * Math.cos(u.facing) - vz * Math.sin(u.facing);
      const k = 1 - Math.exp(-dt * 12);
      m.vf += (fwdV - m.vf) * k;
      m.vs += (sideV - m.vs) * k;
      const target = u.alive && speed > 0.6 && u.y < 0.08 ? Math.min(1, speed / 7) : 0; // legs stop cycling in the air
      m.move += (target - m.move) * k;
      m.phase += Math.hypot(m.vf, m.vs) * dt * 1.5;

      m.group.position.set(u.x, u.y + this.floorY(m, heightAt(this.arena, u.x, u.z, u.lv ? 1 : 0), dt), u.z); // climbs the ramps, falls off a walkway
      m.ring.position.y = 0.04 - u.y; // the team ring stays on the floor
      m.targetRing.position.y = 0.05 - u.y;
      m.group.rotation.y = u.facing;
      const active = u.sheep ? m.sheep : m.character;
      m.character.root.visible = !u.sheep;
      m.sheep.root.visible = u.sheep;
      active.setState(u.alive, u.stealthed);
      active.pose({ phase: m.phase, move: m.move, casting: u.alive && u.casting, time: nowS + u.id, dt, vf: m.vf, vs: m.vs, air: u.y });
      (m.ring.material as THREE.MeshBasicMaterial).color.set(u.team === myTeam ? 0x3fbf5f : 0xc0392b);
      m.ring.visible = u.alive && this.teamRings;
      const isTarget = u.id === targetId && hudLook.targetRing !== 'off';
      m.targetRing.visible = isTarget;
      if (isTarget) {
        const mat = m.targetRing.material as THREE.MeshBasicMaterial;
        mat.color.set(TARGET_COLORS[hudLook.targetColor] ?? (u.team === myTeam ? '#6dff8a' : '#ff5a4a'));
        const geo = TARGET_RING_GEO[hudLook.targetRing] ?? TARGET_RING_GEO.normal;
        if (m.targetRing.geometry !== geo) m.targetRing.geometry = geo;
        mat.transparent = hudLook.targetRing === 'disc';
        mat.opacity = hudLook.targetRing === 'disc' ? 0.4 : 1;
        const base = { sm: 0.9, md: 1.1, lg: 1.4, xl: 1.8 }[hudLook.targetSize] ?? 1.1;
        const pulse = hudLook.targetAnim === 'pulse' ? 1 + 0.1 * Math.sin(nowS * 5) : 1;
        m.targetRing.scale.set(base * pulse, base * pulse, 1);
      }
    }
    for (const [id, m] of this.meshes) {
      if (seen.has(id)) continue;
      this.scene.remove(m.group);
      this.meshes.delete(id);
    }
  }

  /** Smooth a unit's floor height: up a ramp it follows at once; off a ledge (a jump down from a walkway) it falls. */
  private floorY(m: UnitMesh, ground: number, dt: number): number {
    m.baseY = fallToward(m.baseY, ground, dt, m);
    return m.baseY;
  }

  /** The unit the camera follows (hidden while the camera is in first person). */
  followId = -99;
  /** The coloured ring under each unit; off in 1v1, where there is no one to tell apart. */
  teamRings = true;

  /**
   * Third-person orbit camera. Facing `yaw` is the direction the camera looks; pillars, walls and the ground pull it in.
   * When it gets pulled in very close, or `dist` is 0, the camera moves into the character's head (first person) and
   * the character's own model is hidden. Returns true in first person.
   */
  setCamera(fx: number, fz: number, yaw: number, pitch: number, dist: number, fy = 0): boolean {
    const head = new THREE.Vector3(fx, 1.8 + fy, fz);
    const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const h = Math.cos(pitch);
    const offset = new THREE.Vector3(-dir.x * h, Math.sin(pitch), -dir.z * h);

    let d = dist;
    if (d > 0.35) {
      this.raycaster.set(head, offset);
      this.raycaster.far = dist;
      const hits = this.raycaster.intersectObjects(this.pillars, true);
      d = cameraReach(dist, { x: head.x, y: head.y, z: head.z }, { x: offset.x, y: offset.y, z: offset.z }, this.arena.bounds, hits.length ? hits[0].distance : Infinity);
    }
    const first = d < 1.8; // the camera pressed this close to a wall or pillar becomes first person
    const me = this.meshes.get(this.followId);
    if (me) me.group.visible = !first;

    if (first) {
      const look = offset.clone().multiplyScalar(-1);
      const eye = new THREE.Vector3(fx, 1.65 + fy, fz).addScaledVector(look, 0.18);
      this.camera.position.copy(eye);
      this.camera.lookAt(eye.clone().addScaledVector(look, 10));
      return true;
    }
    this.camera.position.copy(head).addScaledVector(offset, d);
    this.camera.lookAt(head);
    return false;
  }

  /**
   * Where the pointer touches the floor, or null when it points at the sky. From above a walkway's deck the ray stops on
   * the deck or ramp it hits (lv 1); from under it (or on open ground) it is the ground.
   */
  groundPoint(clientX: number, clientY: number): { x: number; z: number; lv?: 1 } | null {
    const ndc = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const o = this.raycaster.ray.origin;
    const dv = this.raycaster.ray.direction;
    if (dv.y >= -1e-4) return null;
    const at = (h: number) => ({ x: o.x + dv.x * ((h - o.y) / dv.y), z: o.z + dv.z * ((h - o.y) / dv.y) });
    const deckH = this.arena.deck?.height ?? 0;
    if (deckH > 0 && o.y > deckH) {
      // the first raised surface along the ray: march down from the camera and stop where the ray meets a deck or ramp
      const steps = 120;
      const ground = at(0);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const p = { x: o.x + (ground.x - o.x) * t, z: o.z + (ground.z - o.z) * t };
        const y = o.y + (0 - o.y) * t;
        const h = heightAt(this.arena, p.x, p.z, 1);
        if (h > 0.05 && y <= h && onRaised(this.arena, p.x, p.z)) {
          let q = at(h); // settle on the surface (ramps slope)
          for (let k = 0; k < 3; k++) q = at(heightAt(this.arena, q.x, q.z, 1));
          return onRaised(this.arena, q.x, q.z) ? { ...q, lv: 1 } : { ...p, lv: 1 };
        }
      }
      return ground;
    }
    return at(0);
  }

  /** A ring on the ground showing where an aimed spell would land; null hides it. */
  setReticle(p: { x: number; z: number; lv?: 1 } | null, radius = 5, ok = true): void {
    if (!this.reticle) {
      this.reticle = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 40), new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
      this.reticle.rotation.x = -Math.PI / 2;
      this.scene.add(this.reticle);
      this.reticleDot = new THREE.Mesh(new THREE.CircleGeometry(0.22, 20), new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false, depthTest: false }));
      this.reticleDot.rotation.x = -Math.PI / 2;
      this.reticleDot.renderOrder = 10;
      this.scene.add(this.reticleDot);
    }
    this.reticle.visible = !!p;
    if (this.reticleDot) this.reticleDot.visible = !!p;
    if (p) {
      const gh = heightAt(this.arena, p.x, p.z, p.lv ?? 0);
      this.reticle.position.set(p.x, 0.07 + gh, p.z);
      this.reticle.scale.set(radius, radius, 1);
      this.reticleDot!.position.set(p.x, 0.1 + gh, p.z);
      // amber = can cast here, red = no line of sight / out of reach
      const col = ok ? 0x6dff8a : 0xff4b3e;
      (this.reticle.material as THREE.MeshBasicMaterial).color.setHex(col);
      (this.reticleDot!.material as THREE.MeshBasicMaterial).color.setHex(col);
    }
  }
  private reticle: THREE.Mesh | null = null;
  private reticleDot: THREE.Mesh | null = null;
  /** The level the local player is on, for aiming and ground rings. */
  viewLevel: 0 | 1 = 0;

  /** World point to screen pixels. */
  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    this.tmp.set(x, y, z).project(this.camera);
    return {
      x: ((this.tmp.x + 1) / 2) * window.innerWidth,
      y: ((1 - this.tmp.y) / 2) * window.innerHeight,
      visible: this.tmp.z < 1 && Math.abs(this.tmp.x) < 1.3 && Math.abs(this.tmp.y) < 1.3,
    };
  }

  /**
   * Unit id under the pointer, or null. `selfId` (your own unit) loses to any other unit on the same ray, so your own
   * model can't steal clicks meant for someone behind it, but clicking only yourself targets you.
   */
  /**
   * The unit under the cursor. Your own character is skipped in favour of anyone behind it, and returned only when it is
   * all there is and `allowSelf` (a left click on yourself targets you; a right click never does).
   */
  pick(clientX: number, clientY: number, selfId: number | null = null, allowSelf = true): number | null {
    const ndc = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.far = 200;
    const groups = [...this.meshes.values()].map((m) => m.group);
    const hits = this.raycaster.intersectObjects(groups, true);
    let self = false;
    for (const h of hits) {
      const id = h.object.userData.unitId as number | undefined;
      if (id === undefined) continue;
      if (id !== selfId) return id;
      self = true;
    }
    return self && allowSelf ? selfId : null;
  }

  setPhase(phase: string): void {
    this.phase = phase;
    this.env.setPhase(phase);
  }

  render(): void {
    this.env.update(performance.now() / 1000);
    if (this.composer) {
      try {
        this.composer.render();
        return;
      } catch (e) {
        console.warn('post-processing failed, falling back', e);
        this.composer = null;
      }
    }
    this.renderer.render(this.scene, this.camera);
  }
}

/** A floor height that drops with gravity when the ground falls away by more than a step, and follows it otherwise. */
export function fallToward(cur: number | undefined, ground: number, dt: number, st: { fallV?: number }): number {
  if (cur === undefined || ground >= cur - 0.3 && !st.fallV) {
    st.fallV = 0;
    return ground;
  }
  if (ground >= cur) {
    st.fallV = 0;
    return ground;
  }
  st.fallV = (st.fallV ?? 0) + 30 * dt;
  const next = cur - st.fallV * dt;
  if (next <= ground) {
    st.fallV = 0;
    return ground;
  }
  return next;
}
