// Small glTF "pack" builder for scripts/prep-arena.mjs: named materials (textures as JPEG), named mesh nodes, credit in asset.extras.
import { GlbWriter } from './glb.mjs';
import { encodeJpeg } from './mesh.mjs';

export class Pack {
  constructor(extras, generator = 'scripts/prep-arena.mjs') {
    this.w = new GlbWriter();
    this.extras = extras;
    this.generator = generator;
    this.materials = [];
    this.matIndex = new Map();
    this.textures = [];
    this.images = [];
    this.meshes = [];
    this.nodes = [];
    this.bytesImages = 0;
  }
  /** Add a JPEG texture from RGBA bytes; returns the texture index. */
  tex(rgba, width, height, quality = 80, name = '') {
    const jpg = encodeJpeg(rgba, width, height, quality);
    this.bytesImages += jpg.length;
    const bv = this.w.addBytes(jpg);
    this.images.push({ bufferView: bv, mimeType: 'image/jpeg', name });
    this.textures.push({ sampler: 0, source: this.images.length - 1 });
    return this.textures.length - 1;
  }
  /** A named material. base/normal/emissive are { rgba, w, h } or null. */
  material(name, { base, normal, emissive, quality = 80, roughness = 0.9, metalness = 0, emissiveFactor, color, double = true } = {}) {
    if (this.matIndex.has(name)) return this.matIndex.get(name);
    const pbr = { metallicFactor: metalness, roughnessFactor: roughness };
    if (base) pbr.baseColorTexture = { index: this.tex(base.rgba, base.w, base.h, quality, name + '.base') };
    if (color) pbr.baseColorFactor = color;
    const m = { name, doubleSided: double, pbrMetallicRoughness: pbr };
    if (normal) m.normalTexture = { index: this.tex(normal.rgba, normal.w, normal.h, Math.min(90, quality + 8), name + '.normal') };
    if (emissive) {
      m.emissiveTexture = { index: this.tex(emissive.rgba, emissive.w, emissive.h, quality, name + '.emissive') };
      m.emissiveFactor = emissiveFactor ?? [1, 1, 1];
    }
    this.materials.push(m);
    this.matIndex.set(name, this.materials.length - 1);
    return this.materials.length - 1;
  }
  /** A named mesh node. geo = { pos, nrm, uv, idx } typed arrays. */
  mesh(name, geo, material, { translation, scale, rotation } = {}) {
    const w = this.w;
    const attributes = {
      POSITION: w.addAccessor(geo.pos, 'VEC3', { target: 34962, minmax: true }),
      NORMAL: w.addAccessor(geo.nrm, 'VEC3', { target: 34962 }),
      TEXCOORD_0: w.addAccessor(geo.uv, 'VEC2', { target: 34962 }),
    };
    const n = geo.pos.length / 3;
    const idx = n > 65535 ? new Uint32Array(geo.idx) : new Uint16Array(geo.idx);
    this.meshes.push({ name, primitives: [{ attributes, indices: w.addAccessor(idx, 'SCALAR', { target: 34963 }), material: this.matIndex.get(material), mode: 4 }] });
    const node = { name, mesh: this.meshes.length - 1 };
    if (translation) node.translation = translation;
    if (scale) node.scale = scale;
    if (rotation) node.rotation = rotation;
    this.nodes.push(node);
    return this.nodes.length - 1;
  }
  /** A unit quad carrying a material, so loaders keep the material (kit packs). */
  swatch(name, material) {
    return this.mesh(name, { pos: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]), nrm: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), uv: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), idx: new Uint16Array([0, 2, 1, 0, 3, 2]) }, material);
  }
  build() {
    const json = {
      asset: { version: '2.0', generator: this.generator, extras: this.extras },
      scene: 0,
      scenes: [{ nodes: this.nodes.map((_, i) => i) }],
      nodes: this.nodes,
      meshes: this.meshes,
      materials: this.materials,
      textures: this.textures,
      images: this.images,
      samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    };
    return this.w.build(json);
  }
}
