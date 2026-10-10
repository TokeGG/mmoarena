import { lightMode } from './lightMode';
import * as THREE from 'three';
import { RAIL_THICKNESS, deckPiers, deckRails, heightAt, onRaised } from '@arena/shared';
import type { ArenaDef } from '@arena/shared';
import { KIT_URL, arenaPackUrl, canvasTex, emissiveFromVertexColor, fbm2, jaggedBox, kitMaterial, loadPack, mergeGeometries, pieceMesh, releaseKitMaterial, ringTerrain, rng, rockGeometry, shade, skyDome, smoothstep, worldBox } from './arenaKit';
import type { Pack } from './arenaKit';
import { COVER_WALL_H, LOW_H, lowParts, lowTopParts, partMatrix, pillarParts, scannedObelisk, wallKindOf, wallParts } from './cover';
import type { CoverMat, CoverPart, LowKind, PillarKind, WallKind } from './cover';

/**
 * The arena environment. Every arena is dressed from one kit (arenaKit.ts): the same tiling stone, sand, ice, wood and
 * basalt materials with normal maps, one lighting rig (a warm sun with a fitted shadow map, a sky/ground fill, fog), one
 * skyline, torches, ambient particles and instanced rubble. A theme only picks which materials and props the kit uses.
 * The three arenas built from scanned scenes (cinder, forge, sandstone) also load their pack (crater, rock ring, stadium
 * shell, horns, obelisks) and swap those pieces in when it arrives; until then (or if it cannot be loaded) the built-in
 * dressing of the same theme is what you see.
 * Pure scenery. Gameplay geometry (bounds, pillars, walls, lows, decks, gates) comes from ARENA, so what you see matches
 * what blocks you: every pillar, wall and low drawn here has its collision entry and the other way round.
 */

export interface ArenaEnvironment {
  /** Pillar shafts and wall bodies, used by the camera so it never clips inside a column. */
  pillars: THREE.Mesh[];
  /** Per frame; the camera lets pieces that only look right at player height step aside for a view from above. */
  update(t: number, camera?: THREE.Camera): void;
  /** Under a walkway: the deck above is cut away in a circle of this radius (yards) around x, z so you can see what is going on; radius 0 closes it. */
  setHole(x: number, z: number, radius: number): void;
  /** Start gates are only shown during the prep phase. */
  setPhase(phase: string): void;
  /** Meshes and triangles in the scenery now (for performance checks). */
  stats(): { meshes: number; triangles: number; lights: number };
  /** Resolves when the arena's packs have loaded (or failed); scenery is complete after that. */
  ready: Promise<void>;
  /** Remove everything this environment added to the scene and free its GPU resources. */
  dispose(): void;
}


/** Look of each arena. Gameplay geometry never depends on this; it only changes what you see. */
interface Theme {
  sky: [number, string][];
  fog: { color: number; near: number; far: number };
  hemi: [number, number, number];
  sun: { color: number; intensity: number; pos: [number, number, number] };
  sunGlow: [number, number];
  exposure: number;
  floor: { mat: string; tile: number; tint?: number; glow?: number };
  border?: { mat: string; width: number };
  outer: { mat: string; tint: number };
  wall: { mat: string; tile: number; tint?: number };
  body: { mat: string; tile: number; tint?: number };
  trim: number;
  accent: number;
  ridges: [number, number, number];
  banners: [string, string];
  flame: { glow: number; tongue: number; light: number };
  motes: { color: number; mode: 'drift' | 'fall' | 'rise'; count: number; size: number; opacity: number };
  stands: boolean;
  pillar: PillarKind;
  low: LowKind;
  deck: { top: string; topTint?: number; side: string };
  emblem: { color: string; opacity: number } | null;
  extras: 'none' | 'forest' | 'snow' | 'lava' | 'stadium';
  clouds: [number, number];
  /** Arena pack to load (cinder, forge, sandstone). */
  pack?: string;
  /** Terrain that continues the map to the horizon: a crater wall and lava plain (cinder) or a lava moat and cliffs (forge). */
  surround?: 'crater' | 'cliffs';
  /** Sky dome gradient (zenith 0, horizon 0.5, nadir 1), so the horizon glow sits at the horizon. */
  dome?: [number, string][];
  /** Opacity of the blue / red start-zone tint. */
  zone: number;
}

const THEMES: Record<string, Theme> = {
  colosseum: {
    sky: [[0, '#2b3a6b'], [0.45, '#7a6a9a'], [0.72, '#e8a27a'], [1, '#f6c98a']],
    fog: { color: 0xd8a77c, near: 80, far: 430 },
    hemi: [0xcfd8ff, 0x6a4a38, 0.95],
    sun: { color: 0xffc27a, intensity: 2.8, pos: [-46, 30, 20] },
    sunGlow: [0xffb36a, 0xfff1c8],
    exposure: 1.1,
    floor: { mat: 'sand', tile: 7 },
    border: { mat: 'cobble', width: 2.6 },
    outer: { mat: 'sand', tint: 0xaab4be },
    wall: { mat: 'sandbrick', tile: 6 },
    body: { mat: 'sandbrick', tile: 4 },
    trim: 0xc9b99a,
    accent: 0xd6aa5c,
    ridges: [0x9a7f93, 0x75607f, 0x574864],
    banners: ['#2f6fd0', '#b8322a'],
    flame: { glow: 0xff8a3a, tongue: 0xffd27a, light: 0xff8a3a },
    motes: { color: 0xffe2b0, mode: 'drift', count: 300, size: 0.16, opacity: 0.55 },
    stands: true,
    pillar: 'column',
    low: 'crates',
    deck: { top: 'planks', side: 'sandbrick' },
    emblem: { color: '214,170,92', opacity: 0.8 },
    extras: 'none',
    clouds: [0xffc9a0, 0xd9a8c8],
    zone: 0.14,
  },
  ruins: {
    sky: [[0, '#1d3a40'], [0.45, '#4f8578'], [0.72, '#b9d39a'], [1, '#efe7b0']],
    fog: { color: 0x9ab898, near: 55, far: 320 },
    hemi: [0xd6f0e0, 0x34452c, 1.05],
    sun: { color: 0xfff0b8, intensity: 2.5, pos: [-32, 36, 24] },
    sunGlow: [0xd8e890, 0xfffbd0],
    exposure: 1.05,
    floor: { mat: 'flagstone', tile: 8 },
    outer: { mat: 'dirt', tint: 0x6f8a52 },
    wall: { mat: 'mossbrick', tile: 6 },
    body: { mat: 'mossbrick', tile: 4 },
    trim: 0x8d9478,
    accent: 0x7fb070,
    ridges: [0x6f9a82, 0x4f7c6a, 0x3a5f52],
    banners: ['#2a7f78', '#6a5a2a'],
    flame: { glow: 0x5fe0b0, tongue: 0xd0ffe0, light: 0x5fe0b0 },
    motes: { color: 0xd8ffb0, mode: 'drift', count: 280, size: 0.16, opacity: 0.55 },
    stands: false,
    pillar: 'ruin',
    low: 'rubble',
    deck: { top: 'planks', side: 'mossbrick' },
    emblem: { color: '170,200,140', opacity: 0.45 },
    extras: 'forest',
    clouds: [0xc9f0c0, 0xa8d8c8],
    zone: 0.14,
  },
  frost: {
    sky: [[0, '#050c26'], [0.4, '#16315c'], [0.7, '#3d6ea0'], [1, '#a4cdea']],
    fog: { color: 0x6a90bd, near: 45, far: 300 },
    hemi: [0xbcd8ff, 0x1e2c46, 1.0],
    sun: { color: 0xbcd4ff, intensity: 2.2, pos: [-40, 40, 10] },
    sunGlow: [0x9ac0ff, 0xeaf4ff],
    exposure: 1.15,
    floor: { mat: 'snow', tile: 8 },
    border: { mat: 'ice', width: 2.4 },
    outer: { mat: 'snow', tint: 0xdbe7f4 },
    wall: { mat: 'frostbrick', tile: 6 },
    body: { mat: 'frostbrick', tile: 4 },
    trim: 0xb4c8e0,
    accent: 0x8fd0ff,
    ridges: [0xb4c9e0, 0x869fc2, 0x62799c],
    banners: ['#3a78c8', '#7a3ac8'],
    flame: { glow: 0x62b0ff, tongue: 0xcfeaff, light: 0x62b0ff },
    motes: { color: 0xffffff, mode: 'fall', count: 420, size: 0.2, opacity: 0.8 },
    stands: false,
    pillar: 'crystal',
    low: 'ice',
    deck: { top: 'planks', side: 'frostbrick' },
    emblem: { color: '170,210,255', opacity: 0.5 },
    extras: 'snow',
    clouds: [0x7fb0ff, 0x9a7aff],
    zone: 0.14,
  },
  cinder: {
    sky: [[0, '#150608'], [0.4, '#3a1210'], [0.72, '#8a2c12'], [1, '#e0701c']],
    fog: { color: 0x2c1612, near: 50, far: 340 },
    hemi: [0xffd4b8, 0x6a3a2a, 1.75],
    sun: { color: 0xff8a4a, intensity: 2.1, pos: [-40, 34, -18] },
    sunGlow: [0xff5a1a, 0xffc070],
    exposure: 1.3,
    floor: { mat: 'lavacrack', tile: 15, tint: 0x8c8c96, glow: 0.4 },
    outer: { mat: 'basaltdark', tint: 0x4a3a36 },
    wall: { mat: 'basalt', tile: 6 },
    body: { mat: 'basalt', tile: 4 },
    trim: 0x2c2a2e,
    accent: 0xff6a1c,
    ridges: [0x4a2a28, 0x35201f, 0x241514],
    banners: ['#7a1a12', '#2a2a30'],
    flame: { glow: 0xff5a14, tongue: 0xffc060, light: 0xff6a1c },
    motes: { color: 0xff9a40, mode: 'rise', count: 420, size: 0.2, opacity: 0.9 },
    stands: false,
    pillar: 'spire',
    low: 'basalt',
    deck: { top: 'basalt', topTint: 0x8a8486, side: 'basalt' },
    emblem: { color: '255,110,40', opacity: 0.5 },
    extras: 'lava',
    clouds: [0xff7a38, 0x8a3a2a],
    pack: 'cinder',
    surround: 'crater',
    dome: [[0, '#07020a'], [0.2, '#16060a'], [0.34, '#3c120c'], [0.44, '#8a3410'], [0.5, '#d8681c'], [0.56, '#7a2a10'], [1, '#1a0805']],
    zone: 0.022,
  },
  forge: {
    sky: [[0, '#10070a'], [0.4, '#2e1010'], [0.72, '#7a2410'], [1, '#d85a14']],
    fog: { color: 0x3e1810, near: 45, far: 330 },
    hemi: [0xffd0a8, 0x4a2a1a, 1.35],
    sun: { color: 0xffa060, intensity: 2.2, pos: [30, 38, -26] },
    sunGlow: [0xff6a20, 0xffd080],
    exposure: 1.15,
    floor: { mat: 'greybrick', tile: 7, tint: 0xb8b4b0 },
    border: { mat: 'blackbrick', width: 2.2 },
    outer: { mat: 'blackbrick', tint: 0x4a3c36 },
    wall: { mat: 'blackbrick', tile: 6, tint: 0xd0c8c4 },
    body: { mat: 'blackbrick', tile: 4, tint: 0xe0d8d4 },
    trim: 0x2a2624,
    accent: 0xff7a24,
    ridges: [0x5a2e22, 0x3e221c, 0x2a1814],
    banners: ['#8a2a12', '#2a2420'],
    flame: { glow: 0xff6418, tongue: 0xffc870, light: 0xff7a24 },
    motes: { color: 0xffa04a, mode: 'rise', count: 380, size: 0.2, opacity: 0.9 },
    stands: false,
    pillar: 'chimney',
    low: 'basin',
    deck: { top: 'blackbrick', topTint: 0x9a9494, side: 'blackbrick' },
    emblem: { color: '255,130,50', opacity: 0.4 },
    extras: 'lava',
    clouds: [0xff8a40, 0x8a3a24],
    pack: 'forge',
    surround: 'cliffs',
    dome: [[0, '#0a0508'], [0.2, '#1c0a0a'], [0.34, '#46160c'], [0.44, '#94380e'], [0.5, '#e07018'], [0.56, '#7a2a10'], [1, '#1a0805']],
    zone: 0.03,
  },
  sandstone: {
    sky: [[0, '#274a86'], [0.45, '#6f9fd0'], [0.72, '#cfe0e8'], [1, '#f5e8c8']],
    fog: { color: 0xcfd8d8, near: 90, far: 470 },
    hemi: [0xd8e6ff, 0x8a7458, 1.0],
    sun: { color: 0xfff0d0, intensity: 3.0, pos: [-38, 44, 22] },
    sunGlow: [0xffe0a0, 0xffffe8],
    exposure: 1.08,
    floor: { mat: 'sand', tile: 7 },
    border: { mat: 'cobble', width: 2.4 },
    outer: { mat: 'sand', tint: 0xb8bcc4 },
    wall: { mat: 'sandbrick', tile: 6 },
    body: { mat: 'sandbrick', tile: 4 },
    trim: 0xd2c8b0,
    accent: 0xd6aa5c,
    ridges: [0xa8b4c4, 0x8e9db0, 0x7a8aa0],
    banners: ['#c0392b', '#2a5db0'],
    flame: { glow: 0xff9a40, tongue: 0xffe0a0, light: 0xffa050 },
    motes: { color: 0xfff0c8, mode: 'drift', count: 320, size: 0.16, opacity: 0.5 },
    stands: false,
    pillar: 'obelisk',
    low: 'crates',
    deck: { top: 'sandbrick', topTint: 0xe0d8c4, side: 'sandbrick' },
    emblem: { color: '214,170,92', opacity: 0.7 },
    extras: 'stadium',
    clouds: [0xffffff, 0xe8f0ff],
    pack: 'sandstone',
    zone: 0.14,
  },
};

function skyTexture(stops: [number, string][]) {
  return canvasTex(8, 256, (g) => {
    const grad = g.createLinearGradient(0, 0, 0, 256);
    for (const [at, color] of stops) grad.addColorStop(at, color);
    g.fillStyle = grad;
    g.fillRect(0, 0, 8, 256);
  });
}

function emblemTexture(rgb: string) {
  return canvasTex(512, 512, (g) => {
    g.translate(256, 256);
    g.strokeStyle = `rgba(${rgb},.85)`;
    g.fillStyle = `rgba(${rgb},.85)`;
    g.lineWidth = 7;
    for (const r of [236, 206, 120]) {
      g.beginPath();
      g.arc(0, 0, r, 0, Math.PI * 2);
      g.stroke();
    }
    g.lineWidth = 5;
    for (let i = 0; i < 8; i++) {
      g.save();
      g.rotate((i / 8) * Math.PI * 2);
      g.beginPath();
      g.moveTo(0, -120);
      g.lineTo(18, -170);
      g.lineTo(0, -200);
      g.lineTo(-18, -170);
      g.closePath();
      g.stroke();
      g.restore();
    }
    for (let i = 0; i < 48; i++) {
      g.save();
      g.rotate((i / 48) * Math.PI * 2);
      g.fillRect(-2, -234, 4, i % 4 === 0 ? 22 : 10);
      g.restore();
    }
    g.beginPath();
    g.arc(0, 0, 14, 0, Math.PI * 2);
    g.fill();
  });
}

function bannerTexture(color: string, trim: string) {
  return canvasTex(128, 320, (g) => {
    const grad = g.createLinearGradient(0, 0, 0, 320);
    grad.addColorStop(0, shade(color, 1.15));
    grad.addColorStop(1, shade(color, 0.65));
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 320);
    // woven cloth and folds
    for (let x = 0; x < 128; x += 3) {
      g.fillStyle = x % 6 ? 'rgba(0,0,0,.06)' : 'rgba(255,255,255,.05)';
      g.fillRect(x, 0, 1, 320);
    }
    for (let y = 0; y < 320; y += 4) {
      g.fillStyle = 'rgba(0,0,0,.05)';
      g.fillRect(0, y, 128, 1);
    }
    g.strokeStyle = trim;
    g.lineWidth = 7;
    g.strokeRect(7, 7, 114, 306);
    g.lineWidth = 2;
    g.strokeRect(16, 16, 96, 288);
    g.fillStyle = trim;
    g.beginPath();
    g.arc(64, 116, 34, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = shade(color, 0.8);
    g.beginPath();
    g.arc(64, 116, 22, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = trim;
    g.beginPath();
    g.moveTo(64, 180);
    g.lineTo(92, 260);
    g.lineTo(64, 240);
    g.lineTo(36, 260);
    g.closePath();
    g.fill();
    // frayed hem
    g.clearRect(0, 306, 128, 14);
    for (let x = 0; x < 128; x += 16) {
      g.fillStyle = shade(color, 0.7);
      g.beginPath();
      g.moveTo(x, 306);
      g.lineTo(x + 16, 306);
      g.lineTo(x + 8, 320);
      g.closePath();
      g.fill();
    }
  });
}

function gateTexture() {
  return canvasTex(64, 128, (g) => {
    g.clearRect(0, 0, 64, 128);
    for (let x = 0; x < 64; x += 8) {
      const grad = g.createLinearGradient(0, 0, 0, 128);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, 'rgba(255,255,255,.9)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(x, 0, 3, 128);
    }
    g.fillStyle = 'rgba(255,255,255,.25)';
    g.fillRect(0, 0, 64, 128);
  }, [1, 1]);
}

const glowTexture = (rgb: string) =>
  canvasTex(64, 64, (g) => {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, `rgba(${rgb},1)`);
    grad.addColorStop(0.3, `rgba(${rgb},.55)`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  });

/** Which cover pieces an arena's theme draws (the audit and the tests build the same parts without a renderer). */
export function coverStyle(themeId: string): { pillar: PillarKind; low: LowKind; wall: WallKind; brickWalls: boolean } {
  const th = THEMES[themeId] ?? THEMES.colosseum;
  return { pillar: th.pillar, low: th.low, wall: wallKindOf(th.pillar, th.extras), brickWalls: th.pillar === 'chimney' };
}

const SHARED = 'shared';

export function buildArenaEnvironment(scene: THREE.Scene, renderer: THREE.WebGLRenderer, ARENA: ArenaDef): ArenaEnvironment {
  const th = THEMES[ARENA.theme] ?? THEMES.colosseum;
  const root = new THREE.Group();
  scene.add(root);
  const hole3 = { value: new THREE.Vector3(0, 0, 0) }; // x, z, radius of the cut in the deck
  const rand = rng(1337 + ARENA.id.length * 17);
  const b = ARENA.bounds;
  const w = b.maxX - b.minX;
  const d = b.maxZ - b.minZ;
  const cx = (b.maxX + b.minX) / 2;
  const cz = (b.maxZ + b.minZ) / 2;

  // The materials of this arena, tracked so they can be released; helper to make one.
  const mats: THREE.Material[] = [];
  const M = (name: string, o: Parameters<typeof kitMaterial>[1] = {}) => {
    const m = kitMaterial(name, o);
    mats.push(m);
    return m;
  };
  const plain = (o: THREE.MeshStandardMaterialParameters) => {
    const m = new THREE.MeshStandardMaterial(o);
    mats.push(m);
    return m;
  };

  // ---------------------------------------------------------- atmosphere and light rig
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = lightMode.on ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = th.exposure;
  scene.background = skyTexture(th.sky);
  scene.fog = new THREE.Fog(th.fog.color, th.fog.near, th.fog.far);

  root.add(new THREE.HemisphereLight(th.hemi[0], th.hemi[1], th.hemi[2])); // sky fill against the sun
  const sun = new THREE.DirectionalLight(th.sun.color, th.sun.intensity);
  sun.position.set(cx + th.sun.pos[0], th.sun.pos[1], cz + th.sun.pos[2]);
  sun.target.position.set(cx, 0, cz);
  root.add(sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(lightMode.on ? 1024 : 2048, lightMode.on ? 1024 : 2048);
  // the shadow box is fitted to the arena (and a little beyond, for the rampart and tall props), the same on every map
  const reach = Math.hypot(w, d) / 2 + 6;
  const sc = sun.shadow.camera;
  sc.left = -reach;
  sc.right = reach;
  sc.top = reach * 0.8;
  sc.bottom = -reach * 0.8;
  sc.near = 1;
  sc.far = 190;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  root.add(sun);
  // a cool, shadowless fill from the other side so the dark faces keep their shape
  const fill = new THREE.DirectionalLight(th.hemi[0], 0.35);
  fill.position.set(cx - th.sun.pos[0] * 0.8, 18, cz - th.sun.pos[2] * 0.8);
  root.add(fill);

  // ---------------------------------------------------------- floor
  const fl = th.floor;
  const floorMat = M(fl.mat, { repeat: [w / fl.tile, d / fl.tile], color: fl.tint ?? 0xffffff, roughness: 0.95, glow: fl.glow ?? 1 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, 0, cz);
  floor.receiveShadow = true;
  root.add(floor);

  // a paved border along the rampart so the yard has an edge
  if (th.border) {
    const bw = th.border.width;
    const bm = M(th.border.mat, { repeat: [w / 6, bw / 6], roughness: 0.9 });
    const bmSide = M(th.border.mat, { repeat: [d / 6, bw / 6], roughness: 0.9 });
    for (const [sx, sz, px, pz, mat, rot] of [
      [w, bw, cx, b.minZ + bw / 2, bm, 0], [w, bw, cx, b.maxZ - bw / 2, bm, 0],
      [d - 2 * bw, bw, b.minX + bw / 2, cz, bmSide, Math.PI / 2], [d - 2 * bw, bw, b.maxX - bw / 2, cz, bmSide, Math.PI / 2],
    ] as [number, number, number, number, THREE.Material, number][]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(sx, sz), mat);
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = rot;
      m.position.set(px, 0.012, pz);
      m.receiveShadow = true;
      root.add(m);
    }
  }

  if (th.emblem) {
    const emblem = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 18),
      new THREE.MeshBasicMaterial({ map: emblemTexture(th.emblem.color), transparent: true, depthWrite: false, opacity: th.emblem.opacity, fog: true }),
    );
    emblem.rotation.x = -Math.PI / 2;
    emblem.position.set(cx, 0.02, cz);
    root.add(emblem);
  }

  // team start zones, tinted behind each gate
  const zoneW = Math.max(0, b.maxX - ARENA.gateX);
  ([[0, 0x3b82f6], [1, 0xc0392b]] as const).forEach(([team, color]) => {
    const sign = Math.sign(ARENA.spawns[team][0].x) || (team === 0 ? -1 : 1);
    const zone = new THREE.Mesh(new THREE.PlaneGeometry(zoneW, d), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: th.zone, depthWrite: false }));
    zone.rotation.x = -Math.PI / 2;
    zone.position.set(sign * (ARENA.gateX + zoneW / 2), 0.025, cz);
    root.add(zone);
  });

  // outer ground so the horizon is never void
  const outerMat = M(th.outer.mat, { repeat: [34, 34], color: th.outer.tint, roughness: 1 });
  const outer = new THREE.Mesh(new THREE.CircleGeometry(420, 48), outerMat);
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.05;
  outer.receiveShadow = true;
  root.add(outer);
  const lavaMats: THREE.MeshStandardMaterial[] = [];
  if (th.dome) {
    const dome = skyDome(th.dome);
    root.add(dome);
  }
  if (th.surround) outer.visible = false;

  // ---------------------------------------------------------- rampart
  const WALL_H = th.extras === 'lava' ? 3.6 : 4.2;
  const T = 1.4;
  const hell = th.extras === 'lava';
  const rampart = (len: number, x: number, z: number, alongX: boolean, seed: number) => {
    const segs = hell ? Math.max(1, Math.round(len / 6)) : 1;
    for (let i = 0; i < segs; i++) {
      const sl = len / segs;
      const off = -len / 2 + sl * (i + 0.5);
      const hh = hell ? WALL_H + (rand() - 0.3) * 1.6 : WALL_H;
      const geo = hell ? jaggedBox(alongX ? sl + 0.2 : T, hh, alongX ? T : sl + 0.2, seed + i, 0.22, th.wall.tile) : worldBox(alongX ? len : T, WALL_H, alongX ? T : len, th.wall.tile, th.wall.tile);
      const m = new THREE.Mesh(geo, M(th.wall.mat, { color: th.wall.tint, roughness: 0.9 }));
      m.position.set(alongX ? x + off : x, hh / 2, alongX ? z : z + off);
      m.castShadow = m.receiveShadow = true;
      root.add(m);
      if (!hell) break;
    }
  };
  rampart(w + 2 * T, cx, b.minZ - T / 2, true, 11);
  rampart(w + 2 * T, cx, b.maxZ + T / 2, true, 23);
  rampart(d, b.minX - T / 2, cz, false, 37);
  rampart(d, b.maxX + T / 2, cz, false, 41);

  const dummy = new THREE.Object3D();
  // ---------------------------------------------------------- surroundings: one welded skin of terrain out to the horizon
  if (th.surround) {
    const crater = th.surround === 'crater';
    const r0 = 3, hx = w / 2 + T, hz = d / 2 + T;
    const ax = hx - r0, az = hz - r0;
    const dOf = (x: number, z: number) => Math.hypot(Math.max(Math.abs(x - cx) - ax, 0), Math.max(Math.abs(z - cz) - az, 0)) - r0;
    const SEA = crater ? -3.4 : -2.6;
    // the height of the ground at a point d yards beyond the rampart
    const groundH = (x: number, z: number, dd: number) => {
      const n1 = fbm2(x * 0.045, z * 0.045, 3, 4), n2 = fbm2(x * 0.17, z * 0.17, 8, 3), n3 = fbm2(x * 0.5, z * 0.5, 14, 2);
      const near = smoothstep(0, 12, dd);
      if (crater) {
        // a bowl: the wall climbs to a ragged lip, falls to a basalt plain and then to a lava sea with islands
        const rise = smoothstep(0, 21 + 8 * n1, dd);
        let h = 0.4 + 10.5 * Math.pow(rise, 1.2) + 4.5 * Math.exp(-(((dd - (26 + 6 * n1)) / 8) ** 2));
        h += (n1 - 0.5) * 8 * near + (n2 - 0.5) * 2.4 * smoothstep(0, 6, dd) + (n3 - 0.5) * 0.5;
        const plain = -1.6 + (n1 - 0.35) * 5.5 + (n2 - 0.5) * 1.5;
        h += (plain - h) * smoothstep(34, 82, dd);
        const isl = Math.max(0, fbm2(x * 0.03, z * 0.03, 11, 3) - 0.56) * 34;
        h += (SEA - 1.2 + isl - h) * smoothstep(86, 130, dd);
        return h;
      }
      // a stone ledge round the yard, a lava moat, and a ring of cliffs with a ragged crown
      const ledge = -0.45 + (n3 - 0.5) * 0.15;
      let h = ledge + (SEA - 2.4 - ledge) * smoothstep(3.2, 6.5, dd);
      const wall = smoothstep(33 + 5 * n1, 48 + 6 * n1, dd);
      const crag = 1 - Math.abs(2 * fbm2(x * 0.09, z * 0.09, 17, 3) - 1);
      h += 17 * wall + (n1 - 0.5) * 8 * wall + crag * crag * 9 * wall + (n2 - 0.5) * 5 * wall + (n3 - 0.5) * 1.4 * wall;
      h += (SEA - 3.5 - h) * smoothstep(74, 120, dd);
      return h;
    };
    const dist: number[] = [0];
    for (let v = 1.5; v <= 40; v += 1.5) dist.push(v);
    for (let v = 43; v <= 100; v += 3) dist.push(v);
    for (let v = 112; v <= 340; v += 12) dist.push(v);
    const ring = (color: (x: number, z: number, dd: number, h: number) => [number, number, number]) => ringTerrain({ cx, cz, hx, hz, corner: r0, dist, samples: 360, tile: crater ? 16 : 11, height: groundH, color });
    const heat = (x: number, z: number, h: number) => Math.min(1, Math.max(0, 1 - Math.max(0, h - SEA + 0.8) / 9)) * (0.65 + 0.7 * fbm2(x * 0.2, z * 0.2, 6, 2));
    const geo = ring((x, z, dd, h) => {
      const v = 0.72 + 0.28 * fbm2(x * 0.09, z * 0.09, 5, 3);
      if (crater) {
        // charred rock, lit orange low down by the lava
        const hot = Math.min(1, heat(x, z, h) * 0.9);
        return [(0.95 + 0.6 * hot) * v, (0.9 + 0.2 * hot) * v, (0.9 - 0.1 * hot) * v];
      }
      // cliffs: dark rock lit orange by the lava near the water line, cooling to soot higher up
      const hot = Math.min(1, Math.max(0, 1 - (h - SEA) / 11));
      return [(0.42 + 0.78 * hot) * v, (0.4 + 0.32 * hot) * v, (0.4 + 0.1 * hot) * v];
    });
    const terrainMat = M('basalt', { color: 0xffffff, roughness: 0.95, normalScale: 1.6 });
    terrainMat.vertexColors = true;
    const terrain = new THREE.Mesh(geo, terrainMat);
    terrain.receiveShadow = true;
    root.add(terrain);
    if (crater) {
      // glowing lava veins laid over the rock (additive, strongest low and near the lava, fading up the wall)
      const veinGeo = ring((x, z, dd, h) => {
        const k = Math.pow(heat(x, z, h), 1.5) * 1.1 * (1 - 0.6 * smoothstep(25, 70, dd));
        return [k, k, k];
      });
      const veinMat = M('lavacrack', { color: 0x000000, roughness: 1, glow: 1.5, repeat: [0.66, 0.66] });
      veinMat.transparent = true;
      veinMat.blending = THREE.AdditiveBlending;
      veinMat.depthWrite = false;
      veinMat.polygonOffset = true;
      veinMat.polygonOffsetFactor = -2;
      veinMat.polygonOffsetUnits = -2;
      emissiveFromVertexColor(veinMat);
      const veins = new THREE.Mesh(veinGeo, veinMat);
      veins.renderOrder = 1;
      root.add(veins);
    }
    // the lava (a sea round the whole map; the ground rises out of it)
    const seaMat = M('lavaflow', { repeat: [crater ? 90 : 110, crater ? 90 : 110], color: 0x946a58, roughness: 0.4, glow: crater ? 0.9 : 0.75 });
    lavaMats.push(seaMat);
    const sea = new THREE.Mesh(new THREE.CircleGeometry(690, 48), seaMat);
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(cx, SEA, cz);
    root.add(sea);
    // boulders on the wall and plain, so the slope is not a smooth sheet
    const boulderMat = M('basalt', { color: crater ? 0x8a7a76 : 0xa09088, roughness: 1, flatShading: true });
    const BN = crater ? 120 : 90;
    const boulders = new THREE.InstancedMesh(rockGeometry(1, 909), boulderMat, BN);
    let bn = 0;
    for (let i = 0; i < BN * 3 && bn < BN; i++) {
      const a = rand() * Math.PI * 2, rad = (crater ? 8 + rand() * 80 : 36 + rand() * 40);
      const x = cx + Math.cos(a) * (hx + rad) * (1 + 0.0), z = cz + Math.sin(a) * (hz + rad);
      const dd = dOf(x, z);
      const h = groundH(x, z, dd);
      if (h < SEA + 0.3) continue;
      const sc2 = 0.9 + rand() * rand() * 4.2;
      dummy.position.set(x, h + sc2 * 0.1, z);
      dummy.rotation.set(rand() * 3, rand() * 6, rand() * 3);
      dummy.scale.set(sc2, sc2 * (0.7 + rand() * 0.6), sc2 * (0.8 + rand() * 0.5));
      dummy.updateMatrix();
      boulders.setMatrixAt(bn++, dummy.matrix);
    }
    dummy.scale.set(1, 1, 1);
    boulders.count = bn;
    root.add(boulders);
  }

  // crenellations (stone themes) or jagged teeth (hell)
  if (!hell) {
    const merlonGeo = worldBox(1.1, 0.9, T + 0.1, 1.5);
    const merlonMat = M('sandstone', { color: th.trim, roughness: 0.9 });
    const merlons: { x: number; z: number; rot: number }[] = [];
    for (let x = b.minX - T; x <= b.maxX + T; x += 2.4) merlons.push({ x, z: b.minZ - T / 2, rot: 0 }, { x, z: b.maxZ + T / 2, rot: 0 });
    for (let z = b.minZ; z <= b.maxZ; z += 2.4) merlons.push({ x: b.minX - T / 2, z, rot: Math.PI / 2 }, { x: b.maxX + T / 2, z, rot: Math.PI / 2 });
    const merlonMesh = new THREE.InstancedMesh(merlonGeo, merlonMat, merlons.length);
    merlons.forEach((m, i) => {
      dummy.position.set(m.x, WALL_H + 0.45, m.z);
      dummy.rotation.set(0, m.rot, 0);
      dummy.updateMatrix();
      merlonMesh.setMatrixAt(i, dummy.matrix);
    });
    merlonMesh.castShadow = true;
    root.add(merlonMesh);
  }

  // ---------------------------------------------------------- banners and torches
  const bannerMats = [
    new THREE.MeshBasicMaterial({ map: bannerTexture(th.banners[0], '#d6aa5c'), side: THREE.DoubleSide, transparent: true, alphaTest: 0.1 }),
    new THREE.MeshBasicMaterial({ map: bannerTexture(th.banners[1], '#d6aa5c'), side: THREE.DoubleSide, transparent: true, alphaTest: 0.1 }),
  ];
  const bannerGeo = new THREE.PlaneGeometry(1.6, 4);
  bannerGeo.translate(0, -2, 0);
  const banners: THREE.Mesh[] = [];
  let bi = 0;
  for (const z of [b.minZ, b.maxZ]) {
    const inward = z === b.minZ ? 1 : -1;
    for (let x = b.minX + 6; x <= b.maxX - 5; x += 12) {
      const m = new THREE.Mesh(bannerGeo, bannerMats[bi++ % 2]);
      m.position.set(x, WALL_H - 0.1, z + inward * 0.06);
      m.rotation.y = z === b.minZ ? 0 : Math.PI;
      m.userData.phase = rand() * 6;
      root.add(m);
      banners.push(m);
    }
  }

  const flames: { glow: THREE.Sprite; tongue: THREE.Sprite; light?: THREE.PointLight; base: number; s: number }[] = [];
  const glowTex = glowTexture('255,255,255');
  const flameGlow = new THREE.SpriteMaterial({ map: glowTex, color: th.flame.glow, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const flameTongue = new THREE.SpriteMaterial({ map: glowTex, color: th.flame.tongue, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const metalMat = plain({ color: 0x3d3630, metalness: 0.55, roughness: 0.55 });
  const brazier = (x: number, z: number, withLight: boolean) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 1.3, 8), metalMat);
    stand.position.y = 0.65;
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.25, 0.4, 12), metalMat);
    bowl.position.y = 1.45;
    stand.castShadow = bowl.castShadow = true;
    const coal = new THREE.Mesh(new THREE.CircleGeometry(0.5, 12), new THREE.MeshBasicMaterial({ color: th.flame.glow }));
    coal.rotation.x = -Math.PI / 2;
    coal.position.y = 1.62;
    const glow = new THREE.Sprite(flameGlow);
    glow.position.y = 2.0;
    const tongue = new THREE.Sprite(flameTongue);
    tongue.position.y = 1.95;
    g.add(stand, bowl, coal, glow, tongue);
    let light: THREE.PointLight | undefined;
    if (withLight) {
      light = new THREE.PointLight(th.flame.light, 55, 26, 2);
      light.position.y = 2.4;
      g.add(light);
    }
    root.add(g);
    flames.push({ glow, tongue, light, base: 55, s: 2.2 });
  };
  const bx = b.minX + 2.2, bX = b.maxX - 2.2, bz = b.minZ + 1.6, bZ = b.maxZ - 1.6;
  brazier(bx, bz, true);
  brazier(bX, bz, true);
  brazier(bx, bZ, true);
  brazier(bX, bZ, true);
  for (const x of [-w / 6, w / 6]) {
    brazier(x, bz, false);
    brazier(x, bZ, false);
  }
  // wall torches: an iron bracket and a flickering flame every few yards along the rampart (no extra lights)
  const bracketGeo = new THREE.CylinderGeometry(0.06, 0.09, 0.9, 6);
  const torchSpots: [number, number, number][] = [];
  for (let x = b.minX + 3; x <= b.maxX - 2; x += 6) torchSpots.push([x, b.minZ + 0.1, 0], [x, b.maxZ - 0.1, Math.PI]);
  for (let z = b.minZ + 4; z <= b.maxZ - 3; z += 8) torchSpots.push([b.minX + 0.1, z, Math.PI / 2], [b.maxX - 0.1, z, -Math.PI / 2]);
  const brackets = new THREE.InstancedMesh(bracketGeo, metalMat, torchSpots.length);
  torchSpots.forEach(([x, z, rot], i) => {
    const wallX = Math.abs(rot) === Math.PI / 2;
    const px = wallX ? x + Math.sign(Math.sin(rot)) * 0.25 : x;
    const pz = wallX ? z : z + (rot === 0 ? 0.25 : -0.25);
    dummy.position.set(px, 2.5, pz);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    brackets.setMatrixAt(i, dummy.matrix);
    const glow = new THREE.Sprite(flameGlow);
    glow.position.set(px, 3.25, pz);
    glow.scale.set(1.1, 1.1, 1);
    const tongue = new THREE.Sprite(flameTongue);
    tongue.position.set(px, 3.2, pz);
    root.add(glow, tongue);
    flames.push({ glow, tongue, base: 0, s: 1.1 });
  });
  root.add(brackets);

  // ---------------------------------------------------------- spectator stands (the colosseum)
  const crowdPlaces: { x: number; y: number; z: number }[] = [];
  if (th.stands) {
    const standMat = M('sandbrick', { repeat: [w / 10, 1], color: 0x9a948a, roughness: 0.95 });
    const TIERS = 4;
    for (const side of [-1, 1]) {
      const zWall = side < 0 ? b.minZ - T : b.maxZ + T;
      for (let i = 0; i < TIERS; i++) {
        const depth = 2.6;
        const height = WALL_H - 0.6 + (i + 1) * 1.5;
        const tier = new THREE.Mesh(worldBox(w + 2 * T + 8 - i * 1.5, height, depth, 6), standMat);
        tier.position.set(cx, height / 2, zWall + side * (depth * (i + 0.5)));
        tier.castShadow = true;
        tier.receiveShadow = true;
        root.add(tier);
        for (let x = tier.position.x - (w + 2 * T) / 2 - 2; x < tier.position.x + (w + 2 * T) / 2 + 2; x += 0.95) {
          if (rand() < 0.12) continue;
          crowdPlaces.push({ x: x + rand() * 0.3, y: height + 0.42, z: tier.position.z - side * 0.2 + rand() * 0.4 });
        }
      }
    }
    const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.85, 0.4), plain({ roughness: 0.9 }), Math.max(1, crowdPlaces.length));
    crowd.count = crowdPlaces.length;
    const palette = [0xb8322a, 0x2f6fd0, 0xd6aa5c, 0x5a8a4a, 0x8a5aa8, 0xe0d4b8, 0x3a3a44];
    const col = new THREE.Color();
    crowdPlaces.forEach((p, i) => {
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 0.85 + rand() * 0.3, 1);
      dummy.updateMatrix();
      crowd.setMatrixAt(i, dummy.matrix);
      col.setHex(palette[Math.floor(rand() * palette.length)]);
      crowd.setColorAt(i, col);
    });
    dummy.scale.set(1, 1, 1);
    root.add(crowd);
  }

  // ---------------------------------------------------------- raised walkways: flats, ramps, rails and piers
  if (ARENA.deck) {
    const dk = ARENA.deck;
    const H = dk.height;
    // the deck can be cut away in a circle (a soft, dithered edge) around a viewer standing under it
    const hole = hole3;
    const holeable = <T extends THREE.Material>(m: T): T => {
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uHole = hole;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vHoleW;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvHoleW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vHoleW;\nuniform vec3 uHole;').replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (uHole.z > 0.0) { float hd = distance(vHoleW.xz, uHole.xy); float hn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))); if (hd < uHole.z - 1.2 || (hd < uHole.z && hn < (uHole.z - hd) / 1.2)) discard; }');
      };
      m.customProgramCacheKey = () => 'deckhole';
      return m;
    };
    const topMat = holeable(M(th.deck.top, { color: th.deck.topTint, roughness: 0.9 }));
    const stoneMat = holeable(M(th.deck.side, { roughness: 0.95, side: THREE.DoubleSide }));
    const wedgeMat = holeable(M(th.deck.side, { repeat: [1 / 4, 1 / 4], roughness: 0.95, side: THREE.DoubleSide })); // extruded wedges take their UVs in yards
    const railMat = M(th.deck.side, { color: 0xb0a89c, roughness: 0.95 });
    const shadeMat = new THREE.MeshBasicMaterial({ color: 0x0b0a0d, transparent: true, opacity: 0.35, depthWrite: false });
    mats.push(shadeMat);
    const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: THREE.Material, tile = 4, shadow = true) => {
      const m = new THREE.Mesh(worldBox(x1 - x0, y1 - y0, z1 - z0, tile), mat);
      m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      m.castShadow = shadow;
      m.receiveShadow = true;
      root.add(m);
      return m;
    };
    // a walkway without piers (open ground, clear sight underneath) is drawn as a thicker stone slab so it reads as a viaduct rather than a board in the air
    const slab = deckPiers(ARENA).length ? 0.6 : 1.1;
    for (const f of dk.flats) {
      box(f.x0, f.x1, H - slab, H, f.z0, f.z1, topMat, 3);
      const sh = new THREE.Mesh(new THREE.PlaneGeometry(f.x1 - f.x0, f.z1 - f.z0), shadeMat);
      sh.rotation.x = -Math.PI / 2;
      sh.position.set((f.x0 + f.x1) / 2, 0.03, (f.z0 + f.z1) / 2);
      root.add(sh);
      if (th.extras === 'lava') {
        // a glowing seam under the lip of the slab
        const g = new THREE.Mesh(new THREE.BoxGeometry(f.x1 - f.x0 + 0.06, 0.12, f.z1 - f.z0 + 0.06), new THREE.MeshBasicMaterial({ color: th.accent }));
        g.position.set((f.x0 + f.x1) / 2, H - slab - 0.02, (f.z0 + f.z1) / 2);
        root.add(g);
      }
    }
    for (const p of deckPiers(ARENA)) box(p.x0, p.x1, 0, H - 0.6, p.z0, p.z1, stoneMat, 4);
    for (const r of deckRails(ARENA)) {
      const alongX = r.x1 - r.x0 >= r.z1 - r.z0;
      const len = alongX ? r.x1 - r.x0 : r.z1 - r.z0;
      const rcx = (r.x0 + r.x1) / 2, rcz = (r.z0 + r.z1) / 2;
      const off = RAIL_THICKNESS / 2 + 0.05;
      const ends = alongX ? [{ x: r.x0 + 0.01, z: rcz + r.inward.z * off }, { x: r.x1 - 0.01, z: rcz + r.inward.z * off }] : [{ x: rcx + r.inward.x * off, z: r.z0 + 0.01 }, { x: rcx + r.inward.x * off, z: r.z1 - 0.01 }];
      const h0 = heightAt(ARENA, ends[0].x, ends[0].z, 1), h1 = heightAt(ARENA, ends[1].x, ends[1].z, 1);
      const tilt = Math.atan2(h1 - h0, len);
      const rail = new THREE.Mesh(worldBox(alongX ? Math.hypot(len, h1 - h0) : r.x1 - r.x0, 0.55, alongX ? r.z1 - r.z0 : Math.hypot(len, h1 - h0), 2), railMat);
      rail.position.set(rcx, (h0 + h1) / 2 + 0.275, rcz);
      if (alongX) rail.rotation.z = tilt;
      else rail.rotation.x = -tilt;
      rail.castShadow = true;
      rail.receiveShadow = true;
      root.add(rail);
    }
    for (const r of dk.ramps) {
      const alongX = r.rise[1] === 'x';
      const up = r.rise[0] === '+';
      const L = alongX ? r.x1 - r.x0 : r.z1 - r.z0;
      const W = alongX ? r.z1 - r.z0 : r.x1 - r.x0;
      const slope = Math.atan2(H, L);
      const hyp = Math.hypot(L, H);
      const prof = new THREE.Shape();
      prof.moveTo(0, 0);
      prof.lineTo(L, 0);
      prof.lineTo(L, H);
      prof.closePath();
      const wedge = new THREE.Mesh(new THREE.ExtrudeGeometry(prof, { depth: W, bevelEnabled: false }), wedgeMat);
      if (alongX) {
        if (up) wedge.position.set(r.x0, 0, r.z0);
        else {
          wedge.scale.x = -1;
          wedge.position.set(r.x1, 0, r.z0);
        }
      } else if (up) {
        wedge.rotation.y = -Math.PI / 2;
        wedge.position.set(r.x1, 0, r.z0);
      } else {
        wedge.rotation.y = Math.PI / 2;
        wedge.position.set(r.x0, 0, r.z1);
      }
      wedge.castShadow = wedge.receiveShadow = true;
      root.add(wedge);
      const rcx = (r.x0 + r.x1) / 2, rcz = (r.z0 + r.z1) / 2;
      const planks = new THREE.Mesh(worldBox(alongX ? hyp : W, 0.12, alongX ? W : hyp, 3), topMat);
      planks.position.set(rcx, H / 2 + 0.05, rcz);
      if (alongX) planks.rotation.z = up ? slope : -slope;
      else planks.rotation.x = up ? -slope : slope;
      planks.receiveShadow = true;
      root.add(planks);
    }
  }

  // ---------------------------------------------------------- cover: pillars, walls, barricades
  const pillars: THREE.Mesh[] = [];
  const stone = (name: string, tint?: number) => M(name, { color: tint, roughness: 0.88 });
  const bodyMat = M(th.body.mat, { color: th.body.tint, roughness: 0.88 });
  const trimMat = plain({ color: th.trim, roughness: 0.9 });
  const goldMat = plain({ color: th.accent, metalness: 0.6, roughness: 0.4 });
  const emberMat = new THREE.MeshBasicMaterial({ color: th.accent, transparent: true, opacity: 0.55 });
  mats.push(emberMat);
  const iceMat = plain({ color: 0x9fd8ff, emissive: 0x2a6fa8, emissiveIntensity: 0.9, roughness: 0.15, metalness: 0.1, flatShading: true, transparent: true, opacity: 0.92 });
  const mossMat = M('mossbrick', { color: 0x6f8a58, roughness: 1, flatShading: true });
  const rockMat = M(th.pillar === 'spire' ? 'basalt' : th.body.mat, { color: th.body.tint, roughness: 1, flatShading: true });
  const iceGlow = glowTexture('160,220,255');
  let hornMat: THREE.MeshStandardMaterial | undefined;
  const obeliskSlots: { r: number; x: number; z: number; meshes: THREE.Mesh[] }[] = [];
  const crateMat = M('carved', { repeat: [1, 1], roughness: 0.9 });
  const sandCap = M('sandstone', { roughness: 0.9 });
  const lowStone = M(th.low === 'rubble' ? 'mossbrick' : th.body.mat, { color: th.body.tint, roughness: 0.95 });
  const brickWalls = th.pillar === 'chimney';
  const kitCache = new Map<string, THREE.Material>();
  const memo = (key: string, make: () => THREE.Material) => {
    let m = kitCache.get(key);
    if (!m) kitCache.set(key, (m = make()));
    return m;
  };
  /** The themed material for a cover part (cover.ts says which slot a part is made of). */
  const coverMat = (slot: CoverMat): THREE.Material => {
    switch (slot) {
      case 'shaft':
        return memo('shaft', () => (th.pillar === 'column' ? stone('obeliskstone', 0xe6dcc8) : th.pillar === 'ruin' ? stone('mossbrick', 0xc8d0b8) : stone('blackbrick', 0xe0d8d4)));
      case 'trim': return trimMat;
      case 'gold': return goldMat;
      case 'ember': return emberMat;
      case 'moss': return mossMat;
      case 'rock': return rockMat;
      case 'ice': return iceMat;
      case 'snow': return memo('snow', () => M('snow', { roughness: 0.8 }));
      case 'horn':
        return (hornMat ??= (() => {
          const m = M('lavacrack', { color: 0x9a9aa4, roughness: 0.55, glow: 0.8, normalScale: 1.3 });
          emissiveFromVertexColor(m);
          return m;
        })());
      case 'body': return bodyMat;
      case 'carved': return crateMat;
      case 'cap': return sandCap;
      case 'basinBrick': return memo('basinBrick', () => M('greybrick', { color: 0xc4c0bc, roughness: 0.9 }));
      case 'basinLip': return trimMat;
      case 'lowBasalt': return memo('lowBasalt', () => M('basalt', { roughness: 0.9, flatShading: true }));
      case 'lowIce': return memo('lowIce', () => M('ice', { color: 0xcfe8ff, roughness: 0.2, transparent: true, opacity: 0.94 }));
      case 'lowStone': return lowStone;
      case 'wallRock': return memo('wallRock', () => M(brickWalls ? 'greybrick' : 'basalt', { color: brickWalls ? 0xc0b0a6 : 0xffffff, roughness: 0.95, flatShading: true }));
      case 'obelisk': return memo('obelisk', () => stone('obeliskstone', 0xeee6d6));
      case 'pedestal': return crateMat;
    }
  };
  /** Bake cover parts into one mesh per material (a barricade of fifty blocks costs a draw call or two). */
  const addCover = (parts: CoverPart[]) => {
    const groups = new Map<string, { mat: CoverMat; role: CoverPart['role']; camera: boolean; geos: THREE.BufferGeometry[] }>();
    const slotted = new Map<CoverPart, THREE.Mesh>();
    for (const part of parts) {
      if (part.slot || part.mat === 'horn') {
        // own meshes: the horn carries vertex colours, and the scanned obelisk replaces its slot later
        const m = new THREE.Mesh(part.geo, coverMat(part.mat));
        m.position.set(...part.pos);
        if (part.rot) m.rotation.set(...part.rot);
        m.castShadow = true;
        m.receiveShadow = part.role !== 'decal';
        root.add(m);
        if (part.camera) pillars.push(m);
        slotted.set(part, m);
        continue;
      }
      const key = `${part.mat}/${part.role}/${part.camera ? 1 : 0}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { mat: part.mat, role: part.role, camera: !!part.camera, geos: [] }));
      g.geos.push(part.geo.clone().applyMatrix4(partMatrix(part)));
    }
    for (const g of groups.values()) {
      const m = new THREE.Mesh(g.geos.length === 1 ? g.geos[0] : mergeGeometries(g.geos), coverMat(g.mat));
      m.castShadow = g.role !== 'decal';
      m.receiveShadow = true;
      if (g.mat === 'ember' && g.role === 'decal') (m.material as THREE.MeshBasicMaterial).opacity = 0.22;
      root.add(m);
      if (g.camera) pillars.push(m);
    }
    return slotted;
  };

  const kind = th.pillar;
  for (const [pi, p] of ARENA.pillars.entries()) {
    const parts = pillarParts(kind, { p, i: pi });
    const slotted = addCover(parts);
    if (kind === 'obelisk') obeliskSlots.push({ r: p.r, x: p.x, z: p.z, meshes: [...slotted.values()] });
    if (kind === 'crystal') {
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: iceGlow, color: 0x8fd0ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      glow.position.set(p.x, 1.2, p.z);
      glow.scale.set(p.r * 4.5, p.r * 3, 1);
      root.add(glow);
    } else if (kind === 'chimney') {
      const H = 7.5;
      const fire = new THREE.Sprite(flameGlow);
      fire.position.set(p.x, H + 1.1, p.z);
      const tongue = new THREE.Sprite(flameTongue);
      tongue.position.set(p.x, H + 1.0, p.z);
      root.add(fire, tongue);
      flames.push({ glow: fire, tongue, base: 0, s: 2.6 });
    }
  }

  // walls: a solid straight stone wall with a capstone (jagged rock in the hell halls, stacked carved blocks in the stadium)
  const wallKind = wallKindOf(th.pillar, th.extras);
  for (const [wi, wl] of (ARENA.walls ?? []).entries()) {
    addCover(wallParts(wallKind, wl, wi));
    if (wallKind === 'stone' && (th.pillar === 'ruin' || th.pillar === 'crystal')) {
      const ww = wl.x1 - wl.x0, wd = wl.z1 - wl.z0;
      const c = new THREE.Mesh(rockGeometry(0.5, 400 + wi), th.pillar === 'ruin' ? rockMat : iceMat);
      c.position.set((wl.x0 + wl.x1) / 2 + (rand() - 0.5) * ww, COVER_WALL_H + 0.45, (wl.z0 + wl.z1) / 2 + (rand() - 0.5) * wd);
      c.castShadow = true;
      root.add(c);
    }
  }

  // low barricades: person-high; they block sight on the ground, a jump clears them
  const lavaFlowMat = M('lavaflow', { roughness: 0.35, glow: 1.2 });
  lavaMats.push(lavaFlowMat);
  for (const [li, lw] of (ARENA.lows ?? []).entries()) {
    const ww = lw.x1 - lw.x0, wd = lw.z1 - lw.z0, wx = (lw.x0 + lw.x1) / 2, wz = (lw.z0 + lw.z1) / 2;
    addCover([...lowParts(th.low, lw, li), ...lowTopParts(th.low, lw, li)]);
    if (th.low === 'basin') {
      const surf = new THREE.Mesh(new THREE.PlaneGeometry(ww - 0.5, wd - 0.5), lavaFlowMat);
      surf.rotation.x = -Math.PI / 2;
      surf.position.set(wx, LOW_H + 0.07, wz);
      (surf.material as THREE.MeshStandardMaterial).map?.repeat.set(Math.max(1, (ww - 0.5) / 4), Math.max(1, (wd - 0.5) / 4));
      root.add(surf);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: th.flame.glow, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
      glow.position.set(wx, LOW_H + 0.9, wz);
      glow.scale.set(Math.max(ww, wd) * 1.5, 2.6, 1);
      root.add(glow);
    }
  }

  // ---------------------------------------------------------- start gates
  const gateMats: THREE.MeshBasicMaterial[] = [];
  const gateTexs: THREE.CanvasTexture[] = [];
  const gates: THREE.Group[] = [];
  for (const [team, color] of [[0, 0x4aa0ff], [1, 0xff5a4a]] as const) {
    const sign = Math.sign(ARENA.spawns[team][0].x) || (team === 0 ? -1 : 1);
    const g = new THREE.Group();
    g.position.set(sign * ARENA.gateX, 0, cz);
    const tex = gateTexture();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(d / 4, 1);
    gateTexs.push(tex);
    const mat = new THREE.MeshBasicMaterial({ map: tex, color, transparent: true, opacity: 0.55, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    gateMats.push(mat);
    const barrier = new THREE.Mesh(new THREE.PlaneGeometry(d, 4.2), mat);
    barrier.rotation.y = Math.PI / 2;
    barrier.position.y = 2.1;
    g.add(barrier);
    for (const z of [-d / 2, d / 2]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 5, 10), trimMat);
      post.position.set(0, 2.5, z);
      post.castShadow = true;
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 8), new THREE.MeshBasicMaterial({ color }));
      orb.position.set(0, 5.3, z);
      g.add(post, orb);
    }
    root.add(g);
    gates.push(g);
  }

  // ---------------------------------------------------------- skyline
  const backdrop = new THREE.Group();
  root.add(backdrop);
  const ridge = (radius: number, height: number, color: number, seed: number) => {
    const r2 = rng(seed);
    const ph = [r2() * 6.28, r2() * 6.28, r2() * 6.28, r2() * 6.28];
    const geo = new THREE.CylinderGeometry(radius * 0.86, radius, height, 180, 10, true);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const a = Math.atan2(z, x);
      const t = (pos.getY(i) + height / 2) / height;
      const n = 0.5 + 0.5 * (Math.sin(a * 3 + ph[0]) * 0.45 + Math.sin(a * 7 + ph[1]) * 0.3 + Math.sin(a * 17 + ph[2]) * 0.15 + Math.sin(a * 41 + ph[3]) * 0.1);
      const prof = Math.pow(0.18 + 0.82 * n, 1.4);
      pos.setY(i, -height / 2 + t * height * prof);
    }
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, plain({ color, roughness: 1, flatShading: true, side: THREE.DoubleSide }));
    m.position.y = height / 2 - 4;
    backdrop.add(m);
  };
  ridge(330, 120, th.ridges[0], 71);
  ridge(270, 95, th.ridges[1], 72);
  ridge(215, 60, th.ridges[2], 73);

  const sunDir = sun.position.clone().sub(sun.target.position).normalize();
  const skySprite = (color: number, scale: number, opacity: number, dir: THREE.Vector3, dist: number) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    sp.position.copy(dir).multiplyScalar(dist);
    sp.scale.set(scale, scale, 1);
    root.add(sp);
    return sp;
  };
  skySprite(th.sunGlow[0], 520, 0.55, sunDir, 600);
  skySprite(th.sunGlow[1], 150, 1.0, sunDir, 600);
  for (let i = 0; i < 14; i++) {
    const a = rand() * Math.PI * 2;
    const el = 0.12 + rand() * 0.3;
    const dir = new THREE.Vector3(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el));
    const sp = skySprite(rand() < 0.5 ? th.clouds[0] : th.clouds[1], 220 + rand() * 260, 0.16 + rand() * 0.12, dir, 600);
    sp.scale.y *= 0.28;
  }

  // ---------------------------------------------------------- ambient particles: dust motes, snow or rising embers
  const MOTES = th.motes.count;
  const motePos = new Float32Array(MOTES * 3);
  const moteVel: number[] = [];
  const ceiling = th.motes.mode === 'rise' ? 16 : 10;
  for (let i = 0; i < MOTES; i++) {
    motePos[i * 3] = b.minX + rand() * w;
    motePos[i * 3 + 1] = 0.3 + rand() * ceiling;
    motePos[i * 3 + 2] = b.minZ + rand() * d;
    if (th.motes.mode === 'fall') moteVel.push(0.2 + rand() * 0.35, -(0.6 + rand() * 0.7), (rand() - 0.5) * 0.3);
    else if (th.motes.mode === 'rise') moteVel.push((rand() - 0.3) * 0.5, 0.7 + rand() * 1.1, (rand() - 0.5) * 0.4);
    else moteVel.push(0.1 + rand() * 0.25, 0.04 + rand() * 0.12, (rand() - 0.5) * 0.2);
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
  const moteMat = new THREE.PointsMaterial({ map: glowTex, color: th.motes.color, size: th.motes.size, transparent: true, opacity: th.motes.opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const motes = new THREE.Points(moteGeo, moteMat);
  motes.frustumCulled = false;
  root.add(motes);

  const emberSrc: [number, number][] = [[bx, bz], [bX, bz], [bx, bZ], [bX, bZ]];
  const EMBERS = emberSrc.length * 14;
  const emberPos = new Float32Array(EMBERS * 3);
  const emberLife = new Float32Array(EMBERS);
  const resetEmber = (i: number) => {
    const [ex, ez] = emberSrc[Math.floor(i / 14)];
    emberPos[i * 3] = ex + (rand() - 0.5) * 0.5;
    emberPos[i * 3 + 1] = 1.7;
    emberPos[i * 3 + 2] = ez + (rand() - 0.5) * 0.5;
    emberLife[i] = rand();
  };
  for (let i = 0; i < EMBERS; i++) resetEmber(i);
  const emberGeo = new THREE.BufferGeometry();
  emberGeo.setAttribute('position', new THREE.BufferAttribute(emberPos, 3));
  const embers = new THREE.Points(emberGeo, new THREE.PointsMaterial({ map: glowTex, color: th.flame.glow, size: 0.22, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  embers.frustumCulled = false;
  root.add(embers);
  let lastT = 0;

  // ---------------------------------------------------------- rubble (instanced) and theme dressing
  const rubbleN = 40;
  const rubbleMat = M(th.body.mat, { color: th.body.tint, roughness: 1, flatShading: true });
  const rubble = new THREE.InstancedMesh(rockGeometry(1, 77), rubbleMat, rubbleN);
  let rn = 0;
  for (let i = 0; i < rubbleN; i++) {
    const x = b.minX + 1 + rand() * (w - 2);
    const z = rand() < 0.5 ? b.minZ + 0.6 + rand() * 1.6 : b.maxZ - 0.6 - rand() * 1.6;
    const s = 0.15 + rand() * 0.35;
    if (ARENA.pillars.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + 1) || onRaised(ARENA, x, z)) continue;
    dummy.position.set(x, s * 0.4, z);
    dummy.rotation.set(rand() * 3, rand() * 3, rand() * 3);
    dummy.scale.setScalar(s);
    dummy.updateMatrix();
    rubble.setMatrixAt(rn++, dummy.matrix);
  }
  dummy.scale.set(1, 1, 1);
  rubble.count = rn;
  rubble.castShadow = true;
  root.add(rubble);

  if (th.extras === 'forest') {
    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.5, 3, 6);
    // a layered conifer: four drooping tiers of jittered cones, so the silhouette is not a single cone
    const tiers: THREE.BufferGeometry[] = [];
    const tr = rng(5);
    for (let k = 0; k < 4; k++) {
      const c = new THREE.ConeGeometry(2.7 - k * 0.55, 3.4, 11, 2);
      const pp = c.attributes.position;
      for (let i = 0; i < pp.count; i++) {
        const j = 1 + (tr() - 0.5) * 0.22 * (pp.getY(i) < 1.6 ? 1 : 0.2);
        pp.setX(i, pp.getX(i) * j);
        pp.setZ(i, pp.getZ(i) * j);
      }
      c.translate(0, -3.2 + k * 2.1 + 1.7, 0);
      tiers.push(c);
    }
    const crownGeo = mergeGeometries(tiers);
    crownGeo.computeVertexNormals();
    const trunkMat = plain({ color: 0x4a3a2a, roughness: 1 });
    const crownMat = plain({ color: 0x2f5a3a, roughness: 0.95 });
    const N = 90;
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, N);
    const crowns = new THREE.InstancedMesh(crownGeo, crownMat, N);
    for (let i = 0; i < N; i++) {
      const a = rand() * Math.PI * 2;
      const rx = w / 2 + 9 + rand() * 38, rz = d / 2 + 9 + rand() * 38;
      const s = 0.8 + rand() * 0.9;
      dummy.position.set(cx + Math.cos(a) * rx, 1.5 * s, cz + Math.sin(a) * rz);
      dummy.rotation.set(0, rand() * 6, 0);
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
      dummy.position.y = 7 * s;
      dummy.updateMatrix();
      crowns.setMatrixAt(i, dummy.matrix);
    }
    dummy.scale.set(1, 1, 1);
    crowns.castShadow = true;
    root.add(trunks, crowns);
    const patchMat = new THREE.MeshBasicMaterial({ color: 0x4f7a3a, transparent: true, opacity: 0.3, depthWrite: false });
    mats.push(patchMat);
    for (let i = 0; i < 16; i++) {
      const rr = 1.4 + rand() * 2.8;
      const x = b.minX + 3 + rand() * (w - 6), z = b.minZ + 3 + rand() * (d - 6);
      if (Math.abs(x) > ARENA.gateX - 1) continue;
      const patch = new THREE.Mesh(new THREE.CircleGeometry(rr, 14), patchMat);
      patch.rotation.x = -Math.PI / 2;
      patch.position.set(x, 0.03, z);
      root.add(patch);
    }
  } else if (th.extras === 'snow') {
    const bank = M('snow', { roughness: 1 });
    for (let i = 0; i < 40; i++) {
      const s = 1 + rand() * 2.2;
      const m = new THREE.Mesh(new THREE.SphereGeometry(s, 10, 6), bank);
      m.scale.y = 0.4;
      const north = rand() < 0.5;
      m.position.set(b.minX + rand() * w, 0, north ? b.minZ - 0.6 - rand() * 2 : b.maxZ + 0.6 + rand() * 2);
      m.receiveShadow = true;
      root.add(m);
    }
    // sheets of ice on the floor between the cover
    const sheet = M('ice', { repeat: [3, 3], roughness: 0.2, transparent: true, opacity: 0.55 });
    for (let i = 0; i < 6; i++) {
      const rr = 2.5 + rand() * 2.5;
      const x = b.minX + 6 + rand() * (w - 12), z = b.minZ + 5 + rand() * (d - 10);
      if (Math.abs(x) > ARENA.gateX - 3 || ARENA.pillars.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + rr) || onRaised(ARENA, x, z)) continue;
      const m = new THREE.Mesh(new THREE.CircleGeometry(rr, 18), sheet);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.02, z);
      root.add(m);
    }
    for (let i = 0; i < 4; i++) {
      const dir = new THREE.Vector3(Math.cos(i * 1.7 + 0.5) * 0.6, 0.55 + i * 0.05, Math.sin(i * 1.7 + 0.5) * 0.6);
      const sp = skySprite(i % 2 ? 0x7aa8ff : 0x5dffb8, 700, 0.22, dir.normalize(), 560);
      sp.scale.y *= 0.22;
    }
  } else if (th.extras === 'lava') {
    // glowing cracks run out under the rampart, and a smouldering haze low over the moat
  }

  // ---------------------------------------------------------- packs: the scanned pieces replace the built-in ones when they arrive
  let disposed = false;
  const sharedMeshes: THREE.Mesh[] = [];
  /** Stadium pieces (leaning posts and beams) that look odd from above: hidden while the camera is high. */
  const seenFromBelow: THREE.Mesh[] = [];
  const FROM_BELOW = new Set(['shell_Object_29', 'shell_Object_19', 'shell_Object_21']);
  const addShared = (m: THREE.Mesh | null, parent: THREE.Object3D = root) => {
    if (!m) return null;
    m.userData[SHARED] = true;
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    sharedMeshes.push(m);
    return m;
  };
  const ready: Promise<void> = Promise.all([loadPack(KIT_URL), th.pack ? loadPack(arenaPackUrl(th.pack)) : Promise.resolve<Pack | null>(null)]).then(([, pack]) => {
    if (disposed || !pack || !th.pack) return;
    if (th.pack === 'forge') {
      const grate = addShared(pieceMesh(pack, 'grate'));
      const f = ARENA.deck?.flats[0];
      if (grate && f) {
        grate.position.set((f.x0 + f.x1) / 2, ARENA.deck!.height + 0.01, (f.z0 + f.z1) / 2);
        grate.castShadow = false;
      }
    } else if (th.pack === 'sandstone') {
      backdrop.visible = false;
      for (const [name] of pack.nodes) {
        if (!name.startsWith('shell_')) continue;
        const piece = addShared(pieceMesh(pack, name));
        piece?.position.set(cx, 0, cz);
        if (piece && FROM_BELOW.has(name)) seenFromBelow.push(piece);
      }
      obeliskSlots.forEach((s, i) => {
        const ob = pieceMesh(pack, `prop_obelisk_${i % 2}`);
        if (!ob) return;
        const at = scannedObelisk(s.r);
        ob.scale.set(at.sx, at.sy, at.sx);
        ob.position.set(s.x, at.y, s.z);
        for (const m of s.meshes) m.visible = false;
        addShared(ob);
        (ob.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
      });
    }
  });

  return {
    ready: ready.then(() => undefined),
    dispose() {
      disposed = true;
      scene.remove(root);
      root.traverse((o: THREE.Object3D) => {
        const m = o as THREE.Mesh;
        if (o.userData[SHARED]) return;
        m.geometry?.dispose?.();
        const ms = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        for (const mat of ms) {
          if (mats.includes(mat)) continue; // freed below
          (mat as THREE.MeshStandardMaterial).map?.dispose?.();
          mat.dispose();
        }
      });
      for (const mat of mats) if (!releaseKitMaterial(mat)) {
        (mat as THREE.MeshStandardMaterial).map?.dispose?.();
        mat.dispose();
      }
      for (const t of [...gateTexs]) t.dispose();
      (scene.background as THREE.Texture | null)?.dispose?.();
      scene.background = null;
      scene.fog = null;
    },
    pillars,
    setHole(x, z, radius) {
      hole3.value.set(x, z, radius);
    },
    stats() {
      let meshes = 0, triangles = 0, lights = 0;
      root.traverse((o: THREE.Object3D) => {
        if ((o as THREE.Light).isLight && (o as THREE.PointLight).isPointLight) lights++;
        const m = o as THREE.Mesh;
        if (!m.isMesh && !(o as THREE.Points).isPoints && !(o as THREE.Sprite).isSprite) return;
        if (!o.visible) return;
        let p: THREE.Object3D | null = o;
        while (p && p !== root) { if (!p.visible) return; p = p.parent; }
        meshes++;
        if (m.isMesh) {
          const g = m.geometry;
          const n = (g.index ? g.index.count : g.attributes.position.count) / 3;
          triangles += n * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
        }
      });
      return { meshes, triangles: Math.round(triangles), lights };
    },
    setPhase(phase: string) {
      const show = phase === 'prep';
      for (const g of gates) g.visible = show;
    },
    update(t: number, camera?: THREE.Camera) {
      if (camera && seenFromBelow.length) {
        const high = camera.position.y > 13;
        for (const m of seenFromBelow) m.visible = !high;
      }
      const dt = Math.min(0.1, Math.max(0, t - lastT));
      lastT = t;
      for (let i = 0; i < MOTES; i++) {
        let x = motePos[i * 3] + moteVel[i * 3] * dt + Math.sin(t * 0.5 + i) * 0.004;
        let y = motePos[i * 3 + 1] + moteVel[i * 3 + 1] * dt;
        let z = motePos[i * 3 + 2] + moteVel[i * 3 + 2] * dt;
        if (x > b.maxX) x = b.minX;
        if (x < b.minX) x = b.maxX;
        if (z > b.maxZ) z = b.minZ;
        if (z < b.minZ) z = b.maxZ;
        if (y > ceiling) y = th.motes.mode === 'rise' ? 0.2 : 0.3;
        if (y < 0.1) y = ceiling + rand();
        motePos[i * 3] = x;
        motePos[i * 3 + 1] = y;
        motePos[i * 3 + 2] = z;
      }
      moteGeo.attributes.position.needsUpdate = true;
      for (let i = 0; i < EMBERS; i++) {
        emberLife[i] += dt * 0.5;
        if (emberLife[i] >= 1) resetEmber(i);
        emberPos[i * 3 + 1] += dt * (0.8 + (i % 5) * 0.25);
        emberPos[i * 3] += Math.sin(t * 2 + i * 1.3) * dt * 0.35;
      }
      emberGeo.attributes.position.needsUpdate = true;
      for (const [i, f] of flames.entries()) {
        const k = 0.85 + Math.sin(t * 9 + i * 1.7) * 0.08 + Math.sin(t * 23 + i) * 0.07;
        f.glow.scale.set(f.s * k, f.s * k, 1);
        f.tongue.scale.set((0.8 + Math.sin(t * 17 + i) * 0.1) * (f.s / 2.2 + 0.2), (1.2 + Math.sin(t * 13 + i * 2) * 0.25) * (f.s / 2.2 + 0.2), 1);
        if (f.light) f.light.intensity = f.base * (0.9 + Math.sin(t * 11 + i * 3) * 0.1 + Math.sin(t * 29 + i) * 0.05);
      }
      for (const m of banners) m.rotation.z = Math.sin(t * 1.3 + (m.userData.phase as number)) * 0.04;
      for (const [i, lm] of lavaMats.entries()) {
        if (lm.map) lm.map.offset.set(t * 0.012 * (i % 2 ? -1 : 1), t * 0.008);
        if (lm.emissiveMap) lm.emissiveMap.offset.copy(lm.map?.offset ?? new THREE.Vector2());
        lm.emissiveIntensity = 1.1 + Math.sin(t * 1.7 + i) * 0.15;
      }
      gateTexs.forEach((tex, i) => {
        tex.offset.x = t * 0.15 * (i ? -1 : 1);
        gateMats[i].opacity = 0.5 + Math.sin(t * 3 + i) * 0.08;
      });
    },
  };
}
