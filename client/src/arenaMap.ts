import * as THREE from 'three';
import { RAIL_THICKNESS, deckPiers, deckRails, heightAt, onRaised } from '@arena/shared';
import type { ArenaDef } from '@arena/shared';

/**
 * The arena environment: flagstone floor with a central emblem, team start zones, stone ramparts with braziers
 * and banners, spectator stands, carved pillars, start-gate barriers, distant mountains and a dusk sky.
 * Pure scenery. Gameplay geometry (bounds, pillars, gates) comes from ARENA, so what you see matches what blocks you.
 */

export interface ArenaEnvironment {
  /** Pillar shafts, used by the camera so it never clips inside a column. */
  pillars: THREE.Mesh[];
  update(t: number): void;
  /** Start gates are only shown during the prep phase. */
  setPhase(phase: string): void;
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
  floor: string;
  wall: string;
  merlon: number;
  outer: number;
  ridges: [number, number, number];
  banners: [string, string];
  flame: { glow: number; tongue: number; light: number };
  motes: { color: number; mode: 'drift' | 'fall' };
  stands: boolean;
  pillar: 'column' | 'ruin' | 'crystal';
  /** Extra dressing outside and inside the walls. */
  extras: 'none' | 'forest' | 'snow';
  clouds: [number, number];
}

const THEMES: Record<string, Theme> = {
  colosseum: {
    sky: [[0, '#2b3a6b'], [0.45, '#7a6a9a'], [0.72, '#e8a27a'], [1, '#f6c98a']],
    fog: { color: 0xd8a77c, near: 80, far: 430 },
    hemi: [0xcfd8ff, 0x6a4a38, 0.95],
    sun: { color: 0xffc27a, intensity: 2.8, pos: [-46, 30, 20] },
    sunGlow: [0xffb36a, 0xfff1c8],
    exposure: 1.1,
    floor: '#b79b72',
    wall: '#8d8274',
    merlon: 0x9a8f80,
    outer: 0x8a7458,
    ridges: [0x9a7f93, 0x75607f, 0x574864],
    banners: ['#2f6fd0', '#b8322a'],
    flame: { glow: 0xff8a3a, tongue: 0xffd27a, light: 0xff8a3a },
    motes: { color: 0xffe2b0, mode: 'drift' },
    stands: true,
    pillar: 'column',
    extras: 'none',
    clouds: [0xffc9a0, 0xd9a8c8],
  },
  ruins: {
    sky: [[0, '#1d3a40'], [0.45, '#4f8578'], [0.72, '#b9d39a'], [1, '#efe7b0']],
    fog: { color: 0x9ab898, near: 55, far: 320 },
    hemi: [0xd6f0e0, 0x34452c, 1.05],
    sun: { color: 0xfff0b8, intensity: 2.5, pos: [-32, 36, 24] },
    sunGlow: [0xd8e890, 0xfffbd0],
    exposure: 1.05,
    floor: '#7c8a68',
    wall: '#6c7a60',
    merlon: 0x75866a,
    outer: 0x4d6a3d,
    ridges: [0x6f9a82, 0x4f7c6a, 0x3a5f52],
    banners: ['#2a7f78', '#6a5a2a'],
    flame: { glow: 0x5fe0b0, tongue: 0xd0ffe0, light: 0x5fe0b0 },
    motes: { color: 0xd8ffb0, mode: 'drift' },
    stands: false,
    pillar: 'ruin',
    extras: 'forest',
    clouds: [0xc9f0c0, 0xa8d8c8],
  },
  frost: {
    sky: [[0, '#050c26'], [0.4, '#16315c'], [0.7, '#3d6ea0'], [1, '#a4cdea']],
    fog: { color: 0x6a90bd, near: 45, far: 300 },
    hemi: [0xbcd8ff, 0x1e2c46, 1.0],
    sun: { color: 0xbcd4ff, intensity: 2.2, pos: [-40, 40, 10] },
    sunGlow: [0x9ac0ff, 0xeaf4ff],
    exposure: 1.15,
    floor: '#a9b9cf',
    wall: '#8397b2',
    merlon: 0xa8bad0,
    outer: 0xdbe7f4,
    ridges: [0xb4c9e0, 0x869fc2, 0x62799c],
    banners: ['#3a78c8', '#7a3ac8'],
    flame: { glow: 0x62b0ff, tongue: 0xcfeaff, light: 0x62b0ff },
    motes: { color: 0xffffff, mode: 'fall' },
    stands: false,
    pillar: 'crystal',
    extras: 'snow',
    clouds: [0x7fb0ff, 0x9a7aff],
  },
};

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat?: [number, number]): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
    t.anisotropy = 8;
  }
  return t;
}

const shade = (hex: string, k: number) => {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
};

/** Stone blocks. `bond` offsets alternate rows (walls, columns); false gives square flagstones. */
function stoneTexture(size: number, base: string, rows: number, cols: number, bond: boolean, seed: number, repeat: [number, number]) {
  return canvasTex(
    size,
    size,
    (g) => {
      const r = rng(seed);
      g.fillStyle = shade(base, 0.7);
      g.fillRect(0, 0, size, size);
      const bh = size / rows;
      const bw = size / cols;
      for (let y = 0; y < rows; y++) {
        const off = bond && y % 2 ? bw / 2 : 0;
        for (let x = -1; x < cols; x++) {
          const k = 0.85 + r() * 0.3;
          g.fillStyle = shade(base, k);
          g.fillRect(x * bw + off + 2, y * bh + 2, bw - 4, bh - 4);
          // bevel
          g.fillStyle = 'rgba(255,255,255,.07)';
          g.fillRect(x * bw + off + 2, y * bh + 2, bw - 4, 3);
          g.fillStyle = 'rgba(0,0,0,.12)';
          g.fillRect(x * bw + off + 2, y * bh + bh - 5, bw - 4, 3);
        }
      }
      for (let i = 0; i < size * 3; i++) {
        g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,.07)' : 'rgba(255,255,255,.05)';
        g.fillRect(r() * size, r() * size, 1 + r() * 2, 1 + r() * 2);
      }
      g.strokeStyle = 'rgba(0,0,0,.18)';
      g.lineWidth = 1;
      for (let i = 0; i < 6; i++) {
        g.beginPath();
        let x = r() * size;
        let y = r() * size;
        g.moveTo(x, y);
        for (let s = 0; s < 4; s++) {
          x += (r() - 0.5) * 30;
          y += (r() - 0.5) * 30;
          g.lineTo(x, y);
        }
        g.stroke();
      }
    },
    repeat,
  );
}

function skyTexture(stops: [number, string][]) {
  return canvasTex(8, 256, (g) => {
    const grad = g.createLinearGradient(0, 0, 0, 256);
    for (const [at, color] of stops) grad.addColorStop(at, color);
    g.fillStyle = grad;
    g.fillRect(0, 0, 8, 256);
  });
}

function emblemTexture() {
  return canvasTex(512, 512, (g) => {
    g.translate(256, 256);
    g.strokeStyle = 'rgba(214,170,92,.85)';
    g.fillStyle = 'rgba(214,170,92,.85)';
    g.lineWidth = 7;
    for (const r of [236, 206, 120]) {
      g.beginPath();
      g.arc(0, 0, r, 0, Math.PI * 2);
      g.stroke();
    }
    g.lineWidth = 4;
    // eight-point compass star
    g.beginPath();
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 ? 60 : 200;
      g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.closePath();
    g.stroke();
    // tick marks between the rings
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

function bannerTexture(color: string) {
  return canvasTex(64, 160, (g) => {
    const grad = g.createLinearGradient(0, 0, 0, 160);
    grad.addColorStop(0, shade(color, 1.1));
    grad.addColorStop(1, shade(color, 0.7));
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 160);
    g.strokeStyle = '#d6aa5c';
    g.lineWidth = 4;
    g.strokeRect(3, 3, 58, 154);
    g.fillStyle = '#d6aa5c';
    g.beginPath();
    g.arc(32, 58, 17, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = shade(color, 0.8);
    g.beginPath();
    g.arc(32, 58, 11, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#d6aa5c';
    g.beginPath();
    g.moveTo(32, 90);
    g.lineTo(46, 130);
    g.lineTo(32, 120);
    g.lineTo(18, 130);
    g.closePath();
    g.fill();
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

export function buildArenaEnvironment(scene: THREE.Scene, renderer: THREE.WebGLRenderer, ARENA: ArenaDef): ArenaEnvironment {
  const th = THEMES[ARENA.theme] ?? THEMES.colosseum;
  const root = new THREE.Group();
  scene.add(root);
  const rand = rng(1337);
  const b = ARENA.bounds;
  const w = b.maxX - b.minX;
  const d = b.maxZ - b.minZ;
  const cx = (b.maxX + b.minX) / 2;
  const cz = (b.maxZ + b.minZ) / 2;

  // ---------------------------------------------------------- atmosphere
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = th.exposure;
  scene.background = skyTexture(th.sky);
  scene.fog = new THREE.Fog(th.fog.color, th.fog.near, th.fog.far);

  root.add(new THREE.HemisphereLight(th.hemi[0], th.hemi[1], th.hemi[2])); // cool sky fill vs warm sun
  const sun = new THREE.DirectionalLight(th.sun.color, th.sun.intensity);
  sun.position.set(...th.sun.pos);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -48;
  sc.right = 48;
  sc.top = 38;
  sc.bottom = -38;
  sc.near = 1;
  sc.far = 170;
  sun.shadow.bias = -0.0006;
  root.add(sun);

  // ---------------------------------------------------------- floor
  const floorMat = new THREE.MeshStandardMaterial({ map: stoneTexture(512, th.floor, 4, 4, false, 11, [w / 8, d / 8]), roughness: 0.95, metalness: 0 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, 0, cz);
  floor.receiveShadow = true;
  root.add(floor);

  const emblem = new THREE.Mesh(
    new THREE.PlaneGeometry(18, 18),
    new THREE.MeshBasicMaterial({ map: emblemTexture(), transparent: true, depthWrite: false, opacity: ARENA.theme === 'colosseum' ? 0.85 : 0.5 }),
  );
  emblem.rotation.x = -Math.PI / 2;
  emblem.position.set(cx, 0.02, cz);
  root.add(emblem);

  // team start zones, tinted behind each gate
  const zoneW = Math.max(0, b.maxX - ARENA.gateX);
  ([[0, 0x3b82f6], [1, 0xc0392b]] as const).forEach(([team, color]) => {
    const sign = Math.sign(ARENA.spawns[team][0].x) || (team === 0 ? -1 : 1);
    const zone = new THREE.Mesh(
      new THREE.PlaneGeometry(zoneW, d),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false }),
    );
    zone.rotation.x = -Math.PI / 2;
    zone.position.set(sign * (ARENA.gateX + zoneW / 2), 0.025, cz);
    root.add(zone);
  });

  // outer ground so the horizon is never void
  const outer = new THREE.Mesh(new THREE.CircleGeometry(420, 48), new THREE.MeshStandardMaterial({ color: th.outer, roughness: 1 }));
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.05;
  root.add(outer);

  // ---------------------------------------------------------- ramparts
  const wallTex = stoneTexture(512, th.wall, 8, 4, true, 21, [w / 6, 1]);
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9 });
  const wallTexSide = stoneTexture(512, th.wall, 8, 4, true, 22, [d / 6, 1]);
  const wallMatSide = new THREE.MeshStandardMaterial({ map: wallTexSide, roughness: 0.9 });
  const WALL_H = 4.2;
  const wall = (sx: number, sz: number, x: number, z: number, mat: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, WALL_H, sz), mat);
    m.position.set(x, WALL_H / 2, z);
    m.castShadow = true;
    m.receiveShadow = true;
    root.add(m);
  };
  const T = 1.4;
  wall(w + 2 * T, T, cx, b.minZ - T / 2, wallMat);
  wall(w + 2 * T, T, cx, b.maxZ + T / 2, wallMat);
  wall(T, d, b.minX - T / 2, cz, wallMatSide);
  wall(T, d, b.maxX + T / 2, cz, wallMatSide);

  // crenellations
  const merlonGeo = new THREE.BoxGeometry(1.1, 0.9, T + 0.1);
  const merlonMat = new THREE.MeshStandardMaterial({ color: th.merlon, roughness: 0.9 });
  const merlons: { x: number; z: number; rot: number }[] = [];
  for (let x = b.minX - T; x <= b.maxX + T; x += 2.4) {
    merlons.push({ x, z: b.minZ - T / 2, rot: 0 }, { x, z: b.maxZ + T / 2, rot: 0 });
  }
  for (let z = b.minZ; z <= b.maxZ; z += 2.4) {
    merlons.push({ x: b.minX - T / 2, z, rot: Math.PI / 2 }, { x: b.maxX + T / 2, z, rot: Math.PI / 2 });
  }
  const merlonMesh = new THREE.InstancedMesh(merlonGeo, merlonMat, merlons.length);
  const dummy = new THREE.Object3D();
  merlons.forEach((m, i) => {
    dummy.position.set(m.x, WALL_H + 0.45, m.z);
    dummy.rotation.set(0, m.rot, 0);
    dummy.updateMatrix();
    merlonMesh.setMatrixAt(i, dummy.matrix);
  });
  merlonMesh.castShadow = true;
  root.add(merlonMesh);

  // ---------------------------------------------------------- banners
  const bannerMats = [
    new THREE.MeshBasicMaterial({ map: bannerTexture(th.banners[0]), side: THREE.DoubleSide }),
    new THREE.MeshBasicMaterial({ map: bannerTexture(th.banners[1]), side: THREE.DoubleSide }),
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

  // ---------------------------------------------------------- braziers with real light
  const flames: { glow: THREE.Sprite; tongue: THREE.Sprite; light?: THREE.PointLight; base: number }[] = [];
  const glowTex = canvasTex(64, 64, (g) => {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.3, 'rgba(255,255,255,.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  });
  const bowlMat = new THREE.MeshStandardMaterial({ color: 0x3d3630, metalness: 0.5, roughness: 0.6 });
  const brazier = (x: number, z: number, withLight: boolean) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 1.3, 8), bowlMat);
    stand.position.y = 0.65;
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.25, 0.4, 12), bowlMat);
    bowl.position.y = 1.45;
    stand.castShadow = bowl.castShadow = true;
    const coal = new THREE.Mesh(new THREE.CircleGeometry(0.5, 12), new THREE.MeshBasicMaterial({ color: th.flame.glow }));
    coal.rotation.x = -Math.PI / 2;
    coal.position.y = 1.62;
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: th.flame.glow, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.y = 2.0;
    glow.scale.set(2.2, 2.2, 1);
    const tongue = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: th.flame.tongue, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    tongue.position.y = 1.95;
    tongue.scale.set(0.9, 1.4, 1);
    g.add(stand, bowl, coal, glow, tongue);
    let light: THREE.PointLight | undefined;
    if (withLight) {
      light = new THREE.PointLight(th.flame.light, 55, 26, 2);
      light.position.y = 2.4;
      g.add(light);
    }
    root.add(g);
    flames.push({ glow, tongue, light, base: 55 });
  };
  const bx = b.minX + 2.2;
  const bX = b.maxX - 2.2;
  const bz = b.minZ + 1.6;
  const bZ = b.maxZ - 1.6;
  brazier(bx, bz, true);
  brazier(bX, bz, true);
  brazier(bx, bZ, true);
  brazier(bX, bZ, true);
  for (const x of [-w / 6, w / 6]) {
    brazier(x, bz, false);
    brazier(x, bZ, false);
  }

  // ---------------------------------------------------------- spectator stands (only in the colosseum)
  const standMat = new THREE.MeshStandardMaterial({ map: stoneTexture(256, '#6f6558', 4, 2, true, 31, [w / 10, 1]), roughness: 0.95 });
  const TIERS = 4;
  const crowdGeo = new THREE.BoxGeometry(0.5, 0.85, 0.4);
  const crowdMat = new THREE.MeshStandardMaterial({ roughness: 0.9 });
  const crowdPlaces: { x: number; y: number; z: number }[] = [];
  for (const side of th.stands ? [-1, 1] : []) {
    const zWall = side < 0 ? b.minZ - T : b.maxZ + T;
    for (let i = 0; i < TIERS; i++) {
      const depth = 2.6;
      const height = WALL_H - 0.6 + (i + 1) * 1.5;
      const tier = new THREE.Mesh(new THREE.BoxGeometry(w + 2 * T + 8 - i * 1.5, height, depth), standMat);
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
  const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, Math.max(1, crowdPlaces.length));
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
  crowd.castShadow = false;
  root.add(crowd);

  // ---------------------------------------------------------- raised walkways: flats, ramps, rails and piers
  if (ARENA.deck) {
    const dk = ARENA.deck;
    const H = dk.height;
    const plankTex = stoneTexture(256, '#8a6a43', 8, 2, false, 77, [4, 1]);
    const woodMat = new THREE.MeshStandardMaterial({ map: plankTex, color: 0xb38a55, roughness: 0.95 });
    const stoneMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(th.floor).multiplyScalar(0.85), roughness: 0.95, side: THREE.DoubleSide });
    const railMat = new THREE.MeshStandardMaterial({ color: 0x5e4630, roughness: 1 });
    const shadeMat = new THREE.MeshBasicMaterial({ color: 0x0b0a0d, transparent: true, opacity: 0.35, depthWrite: false });
    const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: THREE.Material, shadow = true) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat);
      m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      m.castShadow = shadow;
      m.receiveShadow = true;
      root.add(m);
      return m;
    };
    // flat pieces: a plank deck, and a dark patch on the ground below so the shade under it reads
    for (const f of dk.flats) {
      box(f.x0, f.x1, H - 0.6, H, f.z0, f.z1, woodMat);
      const sh = new THREE.Mesh(new THREE.PlaneGeometry(f.x1 - f.x0, f.z1 - f.z0), shadeMat);
      sh.rotation.x = -Math.PI / 2;
      sh.position.set((f.x0 + f.x1) / 2, 0.03, (f.z0 + f.z1) / 2);
      root.add(sh);
    }
    for (const p of deckPiers(ARENA)) box(p.x0, p.x1, 0, H - 0.6, p.z0, p.z1, stoneMat);
    // rails along every open edge (low lips you can jump over), sloped where they run beside a ramp
    for (const r of deckRails(ARENA)) {
      const alongX = r.x1 - r.x0 >= r.z1 - r.z0;
      const len = alongX ? r.x1 - r.x0 : r.z1 - r.z0;
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
      const off = RAIL_THICKNESS / 2 + 0.05; // sample the deck just inside the rail
      const ends = alongX ? [{ x: r.x0 + 0.01, z: cz + r.inward.z * off }, { x: r.x1 - 0.01, z: cz + r.inward.z * off }] : [{ x: cx + r.inward.x * off, z: r.z0 + 0.01 }, { x: cx + r.inward.x * off, z: r.z1 - 0.01 }];
      const h0 = heightAt(ARENA, ends[0].x, ends[0].z, 1), h1 = heightAt(ARENA, ends[1].x, ends[1].z, 1);
      const tilt = Math.atan2(h1 - h0, len);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(alongX ? Math.hypot(len, h1 - h0) : r.x1 - r.x0, 0.55, alongX ? r.z1 - r.z0 : Math.hypot(len, h1 - h0)), railMat);
      rail.position.set(cx, (h0 + h1) / 2 + 0.275, cz);
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
      // stone wedge under the planks
      const prof = new THREE.Shape();
      prof.moveTo(0, 0);
      prof.lineTo(L, 0);
      prof.lineTo(L, H);
      prof.closePath();
      const wedge = new THREE.Mesh(new THREE.ExtrudeGeometry(prof, { depth: W, bevelEnabled: false }), stoneMat);
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
      // plank surface (the rails beside it are drawn with the others above)
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
      const planks = new THREE.Mesh(new THREE.BoxGeometry(alongX ? hyp : W, 0.12, alongX ? W : hyp), woodMat);
      planks.position.set(cx, H / 2 + 0.05, cz);
      if (alongX) planks.rotation.z = up ? slope : -slope;
      else planks.rotation.x = up ? -slope : slope;
      planks.receiveShadow = true;
      root.add(planks);
    }
  }

  // ---------------------------------------------------------- pillars
  const pillarTex = stoneTexture(256, '#a89a86', 6, 3, true, 41, [3, 2]);
  const pillarMat = new THREE.MeshStandardMaterial({ map: pillarTex, roughness: 0.85 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x7d7264, roughness: 0.9 });
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xd6aa5c, metalness: 0.6, roughness: 0.4 });
  const pillars: THREE.Mesh[] = [];
  const PILLAR_H = 8;
  const mossMat = new THREE.MeshStandardMaterial({ color: 0x5f8a4a, roughness: 1, flatShading: true });
  const brokenMat = new THREE.MeshStandardMaterial({ map: pillarTex, color: 0x9fb08a, roughness: 0.95 });
  const iceMat = new THREE.MeshStandardMaterial({ color: 0x9fd8ff, emissive: 0x2a6fa8, emissiveIntensity: 0.9, roughness: 0.15, metalness: 0.1, flatShading: true, transparent: true, opacity: 0.92 });
  const iceGlowTex = canvasTex(64, 64, (g) => {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(160,220,255,.9)');
    grad.addColorStop(1, 'rgba(160,220,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  });
  for (const [pi, p] of ARENA.pillars.entries()) {
    if (th.pillar === 'column') {
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 0.94, p.r, PILLAR_H, 24), pillarMat);
      shaft.position.set(p.x, PILLAR_H / 2, p.z);
      shaft.castShadow = shaft.receiveShadow = true;
      root.add(shaft);
      pillars.push(shaft);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 1.12, p.r * 1.2, 0.7, 24), trimMat);
      base.position.set(p.x, 0.35, p.z);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 1.25, p.r * 0.98, 0.8, 24), trimMat);
      cap.position.set(p.x, PILLAR_H + 0.1, p.z);
      const ring1 = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 1.04, p.r * 1.04, 0.16, 24), goldMat);
      ring1.position.set(p.x, PILLAR_H - 1.3, p.z);
      const ring2 = ring1.clone();
      ring2.position.y = 1.6;
      base.castShadow = cap.castShadow = true;
      root.add(base, cap, ring1, ring2);
    } else if (th.pillar === 'ruin') {
      // broken stone: each shaft a different height, a jagged top of fallen chunks, moss at the foot
      const big = p.r > 3;
      const h = big ? 10.5 : 4.5 + rand() * 3.5;
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 0.9, p.r, h, 14), brokenMat);
      shaft.position.set(p.x, h / 2, p.z);
      shaft.castShadow = shaft.receiveShadow = true;
      root.add(shaft);
      pillars.push(shaft);
      const jag = new THREE.Mesh(new THREE.DodecahedronGeometry(p.r * 0.85, 0), brokenMat);
      jag.scale.set(1, 0.5, 1);
      jag.position.set(p.x, h + 0.1, p.z);
      jag.rotation.set(rand() * 2, rand() * 6, rand());
      jag.castShadow = true;
      const moss = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 1.2, p.r * 1.3, 0.6, 14), mossMat);
      moss.position.set(p.x, 0.3, p.z);
      root.add(jag, moss);
      for (let k = 0; k < 5; k++) {
        const a = rand() * Math.PI * 2;
        const rr = p.r * (1.3 + rand() * 0.8);
        const s = 0.25 + rand() * 0.45;
        const c = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), brokenMat);
        c.position.set(p.x + Math.cos(a) * rr, s * 0.5, p.z + Math.sin(a) * rr);
        c.rotation.set(rand() * 3, rand() * 3, rand() * 3);
        c.castShadow = true;
        root.add(c);
      }
    } else {
      // ice spire: a faceted shard with smaller shards leaning out of its base and a cold glow
      const h = 8 + (pi % 3) * 1.2;
      const spire = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 0.12, p.r * 0.95, h, 6), iceMat);
      spire.position.set(p.x, h / 2, p.z);
      spire.castShadow = true;
      root.add(spire);
      pillars.push(spire);
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + pi;
        const sh = 2 + rand() * 2.5;
        const shard = new THREE.Mesh(new THREE.ConeGeometry(p.r * 0.28, sh, 5), iceMat);
        shard.position.set(p.x + Math.cos(a) * p.r * 0.85, sh * 0.5, p.z + Math.sin(a) * p.r * 0.85);
        shard.rotation.set(Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35);
        root.add(shard);
      }
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: iceGlowTex, color: 0x8fd0ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      glow.position.set(p.x, 1.2, p.z);
      glow.scale.set(p.r * 4.5, p.r * 3, 1);
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

  // ---------------------------------------------------------- distant mountain ranges (continuous ridgelines)
  const ridge = (radius: number, height: number, color: number, seed: number, snow: boolean) => {
    const r2 = rng(seed);
    const ph = [r2() * 6.28, r2() * 6.28, r2() * 6.28, r2() * 6.28];
    const geo = new THREE.CylinderGeometry(radius * 0.86, radius, height, 180, 10, true);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const a = Math.atan2(z, x);
      const t = (pos.getY(i) + height / 2) / height;
      const n = 0.5 + 0.5 * (Math.sin(a * 3 + ph[0]) * 0.45 + Math.sin(a * 7 + ph[1]) * 0.3 + Math.sin(a * 17 + ph[2]) * 0.15 + Math.sin(a * 41 + ph[3]) * 0.1);
      const prof = Math.pow(0.18 + 0.82 * n, 1.4);
      pos.setY(i, -height / 2 + t * height * prof);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true, side: THREE.DoubleSide });
    const m = new THREE.Mesh(geo, mat);
    m.position.y = height / 2 - 4;
    root.add(m);
    void snow;
  };
  ridge(330, 120, th.ridges[0], 71, true);
  ridge(270, 95, th.ridges[1], 72, false);
  ridge(215, 60, th.ridges[2], 73, false);

  // big low sun and soft clouds painted into the sky
  const sunDir = sun.position.clone().normalize();
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

  // ---------------------------------------------------------- drifting dust motes and brazier embers
  const sparkTex = glowTex;
  const MOTES = 260;
  const motePos = new Float32Array(MOTES * 3);
  const moteVel: number[] = [];
  for (let i = 0; i < MOTES; i++) {
    motePos[i * 3] = b.minX + rand() * w;
    motePos[i * 3 + 1] = 0.3 + rand() * 9;
    motePos[i * 3 + 2] = b.minZ + rand() * d;
    if (th.motes.mode === 'fall') moteVel.push(0.2 + rand() * 0.35, -(0.6 + rand() * 0.7), (rand() - 0.5) * 0.3);
    else moteVel.push(0.1 + rand() * 0.25, 0.04 + rand() * 0.12, (rand() - 0.5) * 0.2);
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
  const motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({ map: sparkTex, color: th.motes.color, size: th.motes.mode === 'fall' ? 0.22 : 0.16, transparent: true, opacity: th.motes.mode === 'fall' ? 0.8 : 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  motes.frustumCulled = false;
  root.add(motes);

  const emberSrc = flames.length ? [[bx, bz], [bX, bz], [bx, bZ], [bX, bZ]] : [];
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
  const embers = new THREE.Points(emberGeo, new THREE.PointsMaterial({ map: sparkTex, color: th.flame.glow, size: 0.22, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  embers.frustumCulled = false;
  root.add(embers);
  let lastT = 0;

  // ---------------------------------------------------------- rubble
  const rubbleMat = new THREE.MeshStandardMaterial({ color: 0x8d8274, roughness: 1, flatShading: true });
  for (let i = 0; i < 26; i++) {
    const x = b.minX + 1 + rand() * (w - 2);
    const z = rand() < 0.5 ? b.minZ + 0.6 + rand() * 1.6 : b.maxZ - 0.6 - rand() * 1.6;
    if (ARENA.pillars.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + 1) || onRaised(ARENA, x, z)) continue;
    const s = 0.15 + rand() * 0.35;
    const m = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), rubbleMat);
    m.position.set(x, s * 0.5, z);
    m.rotation.set(rand() * 3, rand() * 3, rand() * 3);
    m.castShadow = true;
    root.add(m);
  }

  // ---------------------------------------------------------- walls: straight stone walls with a capstone
  const SW_H = 5;
  for (const wl of ARENA.walls ?? []) {
    const ww = wl.x1 - wl.x0;
    const wd = wl.z1 - wl.z0;
    const wx = (wl.x0 + wl.x1) / 2;
    const wz = (wl.z0 + wl.z1) / 2;
    const body = new THREE.Mesh(new THREE.BoxGeometry(ww, SW_H, wd), pillarMat);
    body.position.set(wx, SW_H / 2, wz);
    body.castShadow = body.receiveShadow = true;
    root.add(body);
    pillars.push(body); // the camera treats it like a pillar
    const capStone = new THREE.Mesh(new THREE.BoxGeometry(ww + 0.25, 0.4, wd + 0.25), trimMat);
    capStone.position.set(wx, SW_H + 0.2, wz);
    capStone.castShadow = true;
    const foot = new THREE.Mesh(new THREE.BoxGeometry(ww + 0.3, 0.5, wd + 0.3), trimMat);
    foot.position.set(wx, 0.25, wz);
    const band = new THREE.Mesh(new THREE.BoxGeometry(ww + 0.08, 0.14, wd + 0.08), goldMat);
    band.position.set(wx, SW_H - 0.7, wz);
    root.add(capStone, foot, band);
  }

  // ---------------------------------------------------------- low barricades: chest-high stone with a wooden top (jump them; you see over them)
  const lowStone = new THREE.MeshStandardMaterial({ map: pillarTex, color: new THREE.Color(th.floor).lerp(new THREE.Color(ARENA.theme === 'frost' ? 0xe4f2ff : 0x9a8f80), 0.5), roughness: 0.95 });
  const lowWood = new THREE.MeshStandardMaterial({ color: ARENA.theme === 'frost' ? 0xf4f9ff : 0x6b4c2e, roughness: ARENA.theme === 'frost' ? 0.6 : 1 });
  for (const lw of ARENA.lows ?? []) {
    const ww = lw.x1 - lw.x0;
    const wd = lw.z1 - lw.z0;
    const wx = (lw.x0 + lw.x1) / 2;
    const wz = (lw.z0 + lw.z1) / 2;
    const LOW_H = 1.15;
    const body = new THREE.Mesh(new THREE.BoxGeometry(ww, LOW_H, wd), lowStone);
    body.position.set(wx, LOW_H / 2, wz);
    body.castShadow = body.receiveShadow = true;
    const top = new THREE.Mesh(new THREE.BoxGeometry(ww + 0.16, 0.14, wd + 0.16), lowWood);
    top.position.set(wx, LOW_H + 0.07, wz);
    top.castShadow = true;
    root.add(body, top);
    // short wooden stakes along the top so it reads as a barricade, not a step
    const n = Math.max(2, Math.round(Math.max(ww, wd) / 1.4));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const stake = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.42, 5), lowWood);
      stake.position.set(ww > wd ? lw.x0 + ww * t : wx, LOW_H + 0.35, ww > wd ? wz : lw.z0 + wd * t);
      root.add(stake);
    }
  }

  // ---------------------------------------------------------- theme dressing outside and inside the walls
  if (th.extras === 'forest') {
    // a ring of dark conifers beyond the walls and moss patches on the floor
    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.5, 3, 6);
    const crownGeo = new THREE.ConeGeometry(2.6, 8, 7);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 1 });
    const crownMat = new THREE.MeshStandardMaterial({ color: 0x2f5a3a, roughness: 1, flatShading: true });
    const N = 90;
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, N);
    const crowns = new THREE.InstancedMesh(crownGeo, crownMat, N);
    for (let i = 0; i < N; i++) {
      const a = rand() * Math.PI * 2;
      const rx = w / 2 + 9 + rand() * 38;
      const rz = d / 2 + 9 + rand() * 38;
      const s = 0.8 + rand() * 0.9;
      dummy.position.set(cx + Math.cos(a) * rx, 1.5 * s, cz + Math.sin(a) * rz);
      dummy.rotation.set(0, rand() * 6, 0);
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
      dummy.position.y = (3 + 4) * s;
      dummy.updateMatrix();
      crowns.setMatrixAt(i, dummy.matrix);
    }
    dummy.scale.set(1, 1, 1);
    crowns.castShadow = true;
    root.add(trunks, crowns);
    const patchMat = new THREE.MeshBasicMaterial({ color: 0x4f7a3a, transparent: true, opacity: 0.38, depthWrite: false });
    for (let i = 0; i < 16; i++) {
      const rr = 1.4 + rand() * 2.8;
      const x = b.minX + 3 + rand() * (w - 6);
      const z = b.minZ + 3 + rand() * (d - 6);
      if (Math.abs(x) > ARENA.gateX - 1) continue;
      const patch = new THREE.Mesh(new THREE.CircleGeometry(rr, 14), patchMat);
      patch.rotation.x = -Math.PI / 2;
      patch.position.set(x, 0.03, z);
      root.add(patch);
    }
  } else if (th.extras === 'snow') {
    // snow banks against the walls, drifting aurora ribbons overhead
    const bankMat = new THREE.MeshStandardMaterial({ color: 0xeef5ff, roughness: 1 });
    for (let i = 0; i < 40; i++) {
      const s = 1 + rand() * 2.2;
      const bank = new THREE.Mesh(new THREE.SphereGeometry(s, 10, 6), bankMat);
      bank.scale.y = 0.4;
      const north = rand() < 0.5;
      bank.position.set(b.minX + rand() * w, 0, north ? b.minZ - 0.6 - rand() * 2 : b.maxZ + 0.6 + rand() * 2);
      bank.receiveShadow = true;
      root.add(bank);
    }
    for (let i = 0; i < 4; i++) {
      const dir = new THREE.Vector3(Math.cos(i * 1.7 + 0.5) * 0.6, 0.55 + i * 0.05, Math.sin(i * 1.7 + 0.5) * 0.6);
      const sp = skySprite(i % 2 ? 0x7aa8ff : 0x5dffb8, 700, 0.22, dir.normalize(), 560);
      sp.scale.y *= 0.22;
    }
  }

  return {
    dispose() {
      scene.remove(root);
      root.traverse((o: THREE.Object3D) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        for (const mat of mats) {
          (mat as THREE.MeshStandardMaterial).map?.dispose?.();
          mat.dispose();
        }
      });
      (scene.background as THREE.Texture | null)?.dispose?.();
      scene.background = null;
      scene.fog = null;
    },
    pillars,
    setPhase(phase: string) {
      const show = phase === 'prep';
      for (const g of gates) g.visible = show;
    },
    update(t: number) {
      const dt = Math.min(0.1, Math.max(0, t - lastT));
      lastT = t;
      for (let i = 0; i < MOTES; i++) {
        let x = motePos[i * 3] + moteVel[i * 3] * dt + Math.sin(t * 0.5 + i) * 0.004;
        let y = motePos[i * 3 + 1] + moteVel[i * 3 + 1] * dt;
        const z = motePos[i * 3 + 2] + moteVel[i * 3 + 2] * dt;
        if (x > b.maxX) x = b.minX;
        if (y > 10) y = 0.3;
        if (y < 0.1) y = 10 + rand();
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
        f.glow.scale.set(2.2 * k, 2.2 * k, 1);
        f.tongue.scale.set(0.8 + Math.sin(t * 17 + i) * 0.1, 1.2 + Math.sin(t * 13 + i * 2) * 0.25, 1);
        if (f.light) f.light.intensity = f.base * (0.9 + Math.sin(t * 11 + i * 3) * 0.1 + Math.sin(t * 29 + i) * 0.05);
      }
      for (const m of banners) m.rotation.z = Math.sin(t * 1.3 + (m.userData.phase as number)) * 0.04;
      gateTexs.forEach((tex, i) => {
        tex.offset.x = t * 0.15 * (i ? -1 : 1);
        gateMats[i].opacity = 0.5 + Math.sin(t * 3 + i) * 0.08;
      });
    },
  };
}
