import * as THREE from 'three';
import { ARENA } from '@arena/shared';

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
}

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

function skyTexture() {
  return canvasTex(8, 256, (g) => {
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#2b3a6b');
    grad.addColorStop(0.45, '#7a6a9a');
    grad.addColorStop(0.72, '#e8a27a');
    grad.addColorStop(1, '#f6c98a');
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

export function buildArenaEnvironment(scene: THREE.Scene, renderer: THREE.WebGLRenderer): ArenaEnvironment {
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
  renderer.toneMappingExposure = 1.1;
  scene.background = skyTexture();
  scene.fog = new THREE.Fog(0xd8a77c, 80, 430);

  scene.add(new THREE.HemisphereLight(0xffe6c4, 0x5d4d3f, 1.15));
  const sun = new THREE.DirectionalLight(0xffd7a0, 2.4);
  sun.position.set(-28, 46, 22);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -48;
  sc.right = 48;
  sc.top = 38;
  sc.bottom = -38;
  sc.near = 1;
  sc.far = 140;
  sun.shadow.bias = -0.0006;
  scene.add(sun);

  // ---------------------------------------------------------- floor
  const floorMat = new THREE.MeshStandardMaterial({ map: stoneTexture(512, '#b79b72', 4, 4, false, 11, [w / 8, d / 8]), roughness: 0.95, metalness: 0 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, 0, cz);
  floor.receiveShadow = true;
  scene.add(floor);

  const emblem = new THREE.Mesh(
    new THREE.PlaneGeometry(18, 18),
    new THREE.MeshBasicMaterial({ map: emblemTexture(), transparent: true, depthWrite: false, opacity: 0.85 }),
  );
  emblem.rotation.x = -Math.PI / 2;
  emblem.position.set(cx, 0.02, cz);
  scene.add(emblem);

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
    scene.add(zone);
  });

  // outer ground so the horizon is never void
  const outer = new THREE.Mesh(new THREE.CircleGeometry(420, 48), new THREE.MeshStandardMaterial({ color: 0x8a7458, roughness: 1 }));
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.05;
  scene.add(outer);

  // ---------------------------------------------------------- ramparts
  const wallTex = stoneTexture(512, '#8d8274', 8, 4, true, 21, [w / 6, 1]);
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9 });
  const wallTexSide = stoneTexture(512, '#8d8274', 8, 4, true, 22, [d / 6, 1]);
  const wallMatSide = new THREE.MeshStandardMaterial({ map: wallTexSide, roughness: 0.9 });
  const WALL_H = 4.2;
  const wall = (sx: number, sz: number, x: number, z: number, mat: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, WALL_H, sz), mat);
    m.position.set(x, WALL_H / 2, z);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
  };
  const T = 1.4;
  wall(w + 2 * T, T, cx, b.minZ - T / 2, wallMat);
  wall(w + 2 * T, T, cx, b.maxZ + T / 2, wallMat);
  wall(T, d, b.minX - T / 2, cz, wallMatSide);
  wall(T, d, b.maxX + T / 2, cz, wallMatSide);

  // crenellations
  const merlonGeo = new THREE.BoxGeometry(1.1, 0.9, T + 0.1);
  const merlonMat = new THREE.MeshStandardMaterial({ color: 0x9a8f80, roughness: 0.9 });
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
  scene.add(merlonMesh);

  // ---------------------------------------------------------- banners
  const bannerMats = [
    new THREE.MeshBasicMaterial({ map: bannerTexture('#2f6fd0'), side: THREE.DoubleSide }),
    new THREE.MeshBasicMaterial({ map: bannerTexture('#b8322a'), side: THREE.DoubleSide }),
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
      scene.add(m);
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
    const coal = new THREE.Mesh(new THREE.CircleGeometry(0.5, 12), new THREE.MeshBasicMaterial({ color: 0xff7a2a }));
    coal.rotation.x = -Math.PI / 2;
    coal.position.y = 1.62;
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff8a3a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.y = 2.0;
    glow.scale.set(2.2, 2.2, 1);
    const tongue = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffd27a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    tongue.position.y = 1.95;
    tongue.scale.set(0.9, 1.4, 1);
    g.add(stand, bowl, coal, glow, tongue);
    let light: THREE.PointLight | undefined;
    if (withLight) {
      light = new THREE.PointLight(0xff8a3a, 55, 26, 2);
      light.position.y = 2.4;
      g.add(light);
    }
    scene.add(g);
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
  for (const x of [-10, 10]) {
    brazier(x, bz, false);
    brazier(x, bZ, false);
  }

  // ---------------------------------------------------------- spectator stands
  const standMat = new THREE.MeshStandardMaterial({ map: stoneTexture(256, '#6f6558', 4, 2, true, 31, [w / 10, 1]), roughness: 0.95 });
  const TIERS = 4;
  const crowdGeo = new THREE.BoxGeometry(0.5, 0.85, 0.4);
  const crowdMat = new THREE.MeshStandardMaterial({ roughness: 0.9 });
  const crowdPlaces: { x: number; y: number; z: number }[] = [];
  for (const side of [-1, 1]) {
    const zWall = side < 0 ? b.minZ - T : b.maxZ + T;
    for (let i = 0; i < TIERS; i++) {
      const depth = 2.6;
      const height = WALL_H - 0.6 + (i + 1) * 1.5;
      const tier = new THREE.Mesh(new THREE.BoxGeometry(w + 2 * T + 8 - i * 1.5, height, depth), standMat);
      tier.position.set(cx, height / 2, zWall + side * (depth * (i + 0.5)));
      tier.castShadow = true;
      tier.receiveShadow = true;
      scene.add(tier);
      for (let x = tier.position.x - (w + 2 * T) / 2 - 2; x < tier.position.x + (w + 2 * T) / 2 + 2; x += 0.95) {
        if (rand() < 0.12) continue;
        crowdPlaces.push({ x: x + rand() * 0.3, y: height + 0.42, z: tier.position.z - side * 0.2 + rand() * 0.4 });
      }
    }
  }
  const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, crowdPlaces.length);
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
  scene.add(crowd);

  // ---------------------------------------------------------- pillars
  const pillarTex = stoneTexture(256, '#a89a86', 6, 3, true, 41, [3, 2]);
  const pillarMat = new THREE.MeshStandardMaterial({ map: pillarTex, roughness: 0.85 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x7d7264, roughness: 0.9 });
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xd6aa5c, metalness: 0.6, roughness: 0.4 });
  const pillars: THREE.Mesh[] = [];
  const PILLAR_H = 8;
  for (const p of ARENA.pillars) {
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 0.94, p.r, PILLAR_H, 24), pillarMat);
    shaft.position.set(p.x, PILLAR_H / 2, p.z);
    shaft.castShadow = shaft.receiveShadow = true;
    scene.add(shaft);
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
    scene.add(base, cap, ring1, ring2);
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
    scene.add(g);
    gates.push(g);
  }

  // ---------------------------------------------------------- distant mountains
  const mountainMat = new THREE.MeshStandardMaterial({ color: 0x6a566a, roughness: 1, flatShading: true });
  const mountainFar = new THREE.MeshStandardMaterial({ color: 0x8b6f78, roughness: 1, flatShading: true });
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + rand() * 0.2;
    const far = rand() < 0.5;
    const r = (far ? 300 : 210) + rand() * 40;
    const h = 40 + rand() * 70;
    const m = new THREE.Mesh(new THREE.ConeGeometry(30 + rand() * 40, h, 6 + Math.floor(rand() * 3)), far ? mountainFar : mountainMat);
    m.position.set(Math.cos(a) * r, h / 2 - 2, Math.sin(a) * r);
    m.rotation.y = rand() * 3;
    scene.add(m);
  }

  // ---------------------------------------------------------- rubble
  const rubbleMat = new THREE.MeshStandardMaterial({ color: 0x8d8274, roughness: 1, flatShading: true });
  for (let i = 0; i < 26; i++) {
    const x = b.minX + 1 + rand() * (w - 2);
    const z = rand() < 0.5 ? b.minZ + 0.6 + rand() * 1.6 : b.maxZ - 0.6 - rand() * 1.6;
    if (ARENA.pillars.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + 1)) continue;
    const s = 0.15 + rand() * 0.35;
    const m = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), rubbleMat);
    m.position.set(x, s * 0.5, z);
    m.rotation.set(rand() * 3, rand() * 3, rand() * 3);
    m.castShadow = true;
    scene.add(m);
  }

  return {
    pillars,
    setPhase(phase: string) {
      const show = phase === 'prep';
      for (const g of gates) g.visible = show;
    },
    update(t: number) {
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
