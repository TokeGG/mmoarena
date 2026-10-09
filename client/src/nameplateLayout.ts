/**
 * Nameplate profiles and their layout: pure logic, no DOM and no storage (see nameplateStore.ts / nameplateView.ts).
 *
 * There are three profiles, one per relation to the viewer: your own plate (`me`), allies and enemies (enemy players and
 * bots, neutral units and dummies alike). A profile holds every look option of a plate and how its parts hang together:
 * each part (marks, avatar, name, title, health bar, resource bar, cast bar, buff row) is attached to the plate or to
 * another part (above / below / left / right / over it) with a small offset, so moving or resizing one part carries the
 * parts attached to it, and the plate itself sits at the unit's head or feet.
 */

export type PlateKind = 'me' | 'ally' | 'enemy';
export const PLATE_KINDS: PlateKind[] = ['me', 'ally', 'enemy'];
export const PLATE_KIND_LABEL: Record<PlateKind, string> = { me: 'Me', ally: 'Ally', enemy: 'Enemy' };

export type PartId = 'marks' | 'icon' | 'name' | 'title' | 'bar' | 'res' | 'cast' | 'auras';
export const PART_IDS: PartId[] = ['marks', 'icon', 'name', 'title', 'bar', 'res', 'cast', 'auras'];
export const PART_LABEL: Record<PartId, string> = { marks: 'Raid mark and target arrow', icon: 'Avatar', name: 'Name', title: 'Title', bar: 'Health bar', res: 'Resource bar', cast: 'Cast bar', auras: 'Buff and debuff icons' };

export type Side = 'above' | 'below' | 'left' | 'right' | 'over';
export const SIDES: Side[] = ['above', 'below', 'left', 'right', 'over'];
export const SIDE_LABEL: Record<Side, string> = { above: 'Above', below: 'Below', left: 'Left of', right: 'Right of', over: 'On top of (centred)' };

export type AnchorPoint = 'head' | 'feet';

/** Where a part sits: against `side` of `to` (the plate or another part), moved by the offset (unscaled pixels, y down). */
export interface Attach {
  to: 'plate' | PartId;
  side: Side;
  dx: number;
  dy: number;
}

export interface PlateProfile {
  show: boolean;
  scaleW: number;
  scaleH: number;
  anchor: AnchorPoint;
  /** Pixels the plate is moved up from its anchor (negative: down). */
  offsetY: number;
  fade: { on: boolean; near: number; far: number };
  distScale: boolean;
  name: { show: boolean; size: number; weight: 'normal' | 'bold' | 'heavy'; color: 'team' | 'class' | 'custom'; custom: string; outline: 'none' | 'soft' | 'strong' };
  title: { show: boolean };
  icon: { show: boolean; size: number };
  bar: { w: number; h: number; color: 'team' | 'class' | 'health' | 'custom'; custom: string; border: 'none' | 'thin' | 'thick'; text: 'none' | 'percent' | 'value' | 'both'; textSize: number };
  res: { show: boolean; h: number };
  auras: { show: boolean; which: 'debuffs' | 'mine' | 'all' | 'cc'; size: number; max: number; layout: 'wrap' | 'columns'; width: number; cols: number; duration: boolean; stacks: boolean };
  cast: { show: boolean; h: number };
  target: { arrow: boolean; glow: 'glow' | 'bright' | 'off' };
  parts: Record<PartId, Attach>;
}

// ------------------------------------------------------------------ schema

export type FieldKind = 'bool' | 'num' | 'choice' | 'color';
export interface Field {
  /** Dotted path into the profile, e.g. `bar.h`. */
  path: string;
  label: string;
  group: string;
  kind: FieldKind;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  choices?: [value: string, label: string][];
}

const f = (path: string, label: string, group: string, kind: FieldKind, extra: Partial<Field> = {}): Field => ({ path, label, group, kind, ...extra });
const WEIGHTS: [string, string][] = [['normal', 'Normal'], ['bold', 'Bold'], ['heavy', 'Heavy']];

/** Every option of a profile (the parts' attachments are edited separately), in the order the editor lists them. */
export const PLATE_FIELDS: Field[] = [
  f('show', 'Show this nameplate', 'Plate', 'bool'),
  f('scaleW', 'Width scale', 'Plate', 'num', { min: 0.4, max: 3, step: 0.05, unit: '×' }),
  f('scaleH', 'Height scale', 'Plate', 'num', { min: 0.4, max: 3, step: 0.05, unit: '×' }),
  f('anchor', 'Anchored at', 'Plate', 'choice', { choices: [['head', 'The head (above the model)'], ['feet', 'The feet (on the ground)']] }),
  f('offsetY', 'Height offset', 'Plate', 'num', { min: -150, max: 150, step: 1, unit: 'px' }),
  f('fade.on', 'Fade with distance', 'Plate', 'bool'),
  f('fade.near', 'Fully visible up to', 'Plate', 'num', { min: 3, max: 80, step: 1, unit: 'm' }),
  f('fade.far', 'Gone at', 'Plate', 'num', { min: 8, max: 150, step: 1, unit: 'm' }),
  f('distScale', 'Shrink with distance', 'Plate', 'bool'),

  f('name.show', 'Show the name', 'Name', 'bool'),
  f('name.size', 'Text size', 'Name', 'num', { min: 6, max: 32, step: 1, unit: 'px' }),
  f('name.weight', 'Weight', 'Name', 'choice', { choices: WEIGHTS }),
  f('name.color', 'Colour', 'Name', 'choice', { choices: [['team', 'Team colour'], ['class', 'Class colour'], ['custom', 'Custom']] }),
  f('name.custom', 'Custom colour', 'Name', 'color'),
  f('name.outline', 'Outline', 'Name', 'choice', { choices: [['none', 'None'], ['soft', 'Soft shadow'], ['strong', 'Strong outline']] }),
  f('title.show', 'Show the title', 'Name', 'bool'),
  f('icon.show', 'Show the avatar', 'Name', 'bool'),
  f('icon.size', 'Avatar size', 'Name', 'num', { min: 12, max: 64, step: 1, unit: 'px' }),

  f('bar.w', 'Width', 'Health bar', 'num', { min: 30, max: 320, step: 1, unit: 'px' }),
  f('bar.h', 'Height', 'Health bar', 'num', { min: 2, max: 44, step: 1, unit: 'px' }),
  f('bar.color', 'Colour', 'Health bar', 'choice', { choices: [['team', 'Ally / enemy colours'], ['class', 'Class colour'], ['health', 'Green to red by health'], ['custom', 'Custom']] }),
  f('bar.custom', 'Custom colour', 'Health bar', 'color'),
  f('bar.border', 'Border', 'Health bar', 'choice', { choices: [['none', 'None'], ['thin', 'Thin'], ['thick', 'Thick']] }),
  f('bar.text', 'Text', 'Health bar', 'choice', { choices: [['none', 'Hidden'], ['percent', 'Percent'], ['value', 'Value'], ['both', 'Value and percent']] }),
  f('bar.textSize', 'Text size', 'Health bar', 'num', { min: 6, max: 24, step: 1, unit: 'px' }),

  f('res.show', 'Show mana / energy / rage', 'Resource bar', 'bool'),
  f('res.h', 'Height', 'Resource bar', 'num', { min: 1, max: 24, step: 1, unit: 'px' }),

  f('auras.show', 'Show effect icons', 'Buffs and debuffs', 'bool'),
  f('auras.which', 'Which', 'Buffs and debuffs', 'choice', { choices: [['debuffs', 'Debuffs only'], ['all', 'Buffs and debuffs'], ['mine', 'Only mine'], ['cc', 'Crowd control only']] }),
  f('auras.size', 'Icon size', 'Buffs and debuffs', 'num', { min: 8, max: 44, step: 1, unit: 'px' }),
  f('auras.max', 'Most icons', 'Buffs and debuffs', 'num', { min: 1, max: 16, step: 1 }),
  f('auras.layout', 'Layout', 'Buffs and debuffs', 'choice', { choices: [['wrap', 'Rows that wrap at a width'], ['columns', 'Fixed columns']] }),
  f('auras.width', 'Row width (wrap)', 'Buffs and debuffs', 'num', { min: 20, max: 400, step: 1, unit: 'px' }),
  f('auras.cols', 'Columns', 'Buffs and debuffs', 'num', { min: 1, max: 8, step: 1 }),
  f('auras.duration', 'Show time left', 'Buffs and debuffs', 'bool'),
  f('auras.stacks', 'Show stacks', 'Buffs and debuffs', 'bool'),

  f('cast.show', 'Show cast bar', 'Cast bar', 'bool'),
  f('cast.h', 'Height', 'Cast bar', 'num', { min: 4, max: 32, step: 1, unit: 'px' }),

  f('target.arrow', 'Arrow over the target', 'Target highlight', 'bool'),
  f('target.glow', 'Health bar highlight', 'Target highlight', 'choice', { choices: [['glow', 'Glow'], ['bright', 'Bright outline'], ['off', 'Off']] }),
];

export const FIELD_GROUPS: string[] = [...new Set(PLATE_FIELDS.map((x) => x.group))];

// ------------------------------------------------------------------ defaults

/** The attachments of a head-anchored plate: the bar's bottom edge sits on the anchor, the rest stacks around it. */
export function defaultParts(anchor: AnchorPoint): Record<PartId, Attach> {
  const a = (to: Attach['to'], side: Side, dx = 0, dy = 0): Attach => ({ to, side, dx, dy });
  if (anchor === 'feet') {
    return {
      bar: a('plate', 'below', 0, 2),
      res: a('bar', 'below', 0, 1),
      name: a('res', 'below', 0, 2),
      title: a('name', 'below', 0, 0),
      icon: a('title', 'below', 0, 2),
      cast: a('icon', 'below', 0, 2),
      auras: a('cast', 'below', 0, 2),
      marks: a('auras', 'below', 0, 2),
    };
  }
  return {
    bar: a('plate', 'above', 0, 0),
    res: a('bar', 'below', 0, 1),
    cast: a('res', 'below', 0, 2),
    auras: a('cast', 'below', 0, 2),
    title: a('bar', 'above', 0, -1),
    name: a('title', 'above', 0, 0),
    icon: a('name', 'above', 0, -2),
    marks: a('icon', 'above', 0, 0),
  };
}

/** What a plate looked like before profiles: 110 px wide, 7 px bar, 11 px names, debuffs under the bars. */
export function defaultProfile(): PlateProfile {
  return {
    show: true,
    scaleW: 1,
    scaleH: 1,
    anchor: 'head',
    offsetY: 0,
    fade: { on: false, near: 25, far: 60 },
    distScale: false,
    name: { show: true, size: 11, weight: 'bold', color: 'team', custom: '#ffffff', outline: 'soft' },
    title: { show: true },
    icon: { show: true, size: 30 },
    bar: { w: 110, h: 7, color: 'team', custom: '#3fbf5f', border: 'thin', text: 'none', textSize: 9 },
    res: { show: true, h: 4 },
    auras: { show: true, which: 'debuffs', size: 17, max: 6, layout: 'wrap', width: 120, cols: 3, duration: true, stacks: true },
    cast: { show: true, h: 11 },
    target: { arrow: true, glow: 'glow' },
    parts: defaultParts('head'),
  };
}

export const cloneProfile = (p: PlateProfile): PlateProfile => JSON.parse(JSON.stringify(p)) as PlateProfile;

export function defaultProfiles(): Record<PlateKind, PlateProfile> {
  return { me: defaultProfile(), ally: defaultProfile(), enemy: defaultProfile() };
}

// ------------------------------------------------------------------ validation

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v);

export function getPath(o: unknown, path: string): unknown {
  let cur: unknown = o;
  for (const k of path.split('.')) {
    if (!isDict(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

export function setPath(o: Dict, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur: Dict = o;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isDict(cur[keys[i]])) cur[keys[i]] = {};
    cur = cur[keys[i]] as Dict;
  }
  cur[keys[keys.length - 1]] = value;
}

export const HEX = /^#[0-9a-fA-F]{6}$/;

/** One field's value made valid: numbers clamped and rounded to the step, choices checked, anything else the default. */
export function cleanValue(field: Field, raw: unknown, fallback: unknown): unknown {
  switch (field.kind) {
    case 'bool':
      return typeof raw === 'boolean' ? raw : fallback;
    case 'num': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
      const step = field.step ?? 1;
      const v = Math.round(raw / step) * step;
      const c = Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, v));
      return Math.round(c * 1000) / 1000;
    }
    case 'choice':
      return typeof raw === 'string' && field.choices?.some(([v]) => v === raw) ? raw : fallback;
    case 'color':
      return typeof raw === 'string' && HEX.test(raw) ? raw.toLowerCase() : fallback;
  }
}

const numIn = (raw: unknown, lo: number, hi: number, fb: number): number => (typeof raw === 'number' && Number.isFinite(raw) ? Math.round(Math.min(hi, Math.max(lo, raw)) * 100) / 100 : fb);

/** Parts must hang from the plate through other parts, never in a loop; a part caught in one goes back to the plate. */
export function breakCycles(parts: Record<PartId, Attach>): void {
  for (const id of PART_IDS) {
    const seen = new Set<string>([id]);
    let cur: Attach['to'] = parts[id].to;
    while (cur !== 'plate') {
      if (seen.has(cur)) {
        parts[id].to = 'plate';
        break;
      }
      seen.add(cur);
      cur = parts[cur].to;
    }
  }
}

export function cleanParts(raw: unknown, fallback: Record<PartId, Attach>): Record<PartId, Attach> {
  const out = {} as Record<PartId, Attach>;
  const src = isDict(raw) ? raw : {};
  for (const id of PART_IDS) {
    const r = src[id];
    const fb = fallback[id];
    if (!isDict(r)) {
      out[id] = { ...fb };
      continue;
    }
    const to = r.to === 'plate' || (typeof r.to === 'string' && (PART_IDS as string[]).includes(r.to) && r.to !== id) ? (r.to as Attach['to']) : fb.to;
    const side = typeof r.side === 'string' && (SIDES as string[]).includes(r.side) ? (r.side as Side) : fb.side;
    out[id] = { to: to === id ? 'plate' : to, side, dx: numIn(r.dx, -500, 500, fb.dx), dy: numIn(r.dy, -500, 500, fb.dy) };
  }
  breakCycles(out);
  return out;
}

/** A stored or pasted profile made valid. Missing or wrong values fall back to `base` (the defaults, or the migrated old look). */
export function sanitizeProfile(raw: unknown, base: PlateProfile = defaultProfile()): PlateProfile {
  const out = cloneProfile(base);
  if (!isDict(raw)) return out;
  for (const field of PLATE_FIELDS) setPath(out as unknown as Dict, field.path, cleanValue(field, getPath(raw, field.path), getPath(base, field.path)));
  // the far fade distance stays beyond the near one
  if (out.fade.far <= out.fade.near) out.fade.far = Math.min(150, out.fade.near + 5);
  // parts left out (a compact save) are the anchor's own arrangement
  out.parts = cleanParts(raw.parts, out.anchor === base.anchor ? base.parts : defaultParts(out.anchor));
  return out;
}

/**
 * What is worth saving of a profile: only the options that differ from the classic look (and the parts arranged other than
 * the anchor's default), so the saved text stays tiny (all settings of an account share one size limit).
 * `sanitizeProfile(compactProfile(p))` gives `p` back.
 */
export function compactProfile(p: PlateProfile): Record<string, unknown> {
  const d = defaultProfile();
  const out: Dict = {};
  for (const field of PLATE_FIELDS) {
    const v = getPath(p, field.path);
    if (v !== getPath(d, field.path)) setPath(out, field.path, v);
  }
  const base = defaultParts(p.anchor);
  const parts: Dict = {};
  for (const id of PART_IDS) {
    const a = p.parts[id];
    const b = base[id];
    if (a.to !== b.to || a.side !== b.side || a.dx !== b.dx || a.dy !== b.dy) parts[id] = { ...a };
  }
  if (Object.keys(parts).length) out.parts = parts;
  return out;
}

// ------------------------------------------------------------------ migration of the old single-profile look

/** The old nameplate options of the HUD look (stored in `arena.hud.look.v1`), turned into one profile used by all three kinds. */
export function migrateOldLook(old: unknown): Record<PlateKind, PlateProfile> {
  const o = isDict(old) ? old : {};
  const str = (k: string, fb: string) => (typeof o[k] === 'string' ? (o[k] as string) : fb);
  const p = defaultProfile();
  p.bar.w = ({ narrow: 64, normal: 110, wide: 130, xwide: 170 } as Record<string, number>)[str('plateWidth', 'normal')] ?? 110;
  const bar = str('plateBar', 'normal');
  p.bar.h = ({ thin: 4, normal: 7, thick: 11, huge: 16 } as Record<string, number>)[bar] ?? 7;
  p.res.h = ({ thin: 3, normal: 4, thick: 6, huge: 8 } as Record<string, number>)[bar] ?? 4;
  const hp = str('plateHp', 'none');
  p.bar.text = bar === 'thin' ? 'none' : hp === 'percent' || hp === 'value' ? hp : 'none';
  const col = str('plateColor', 'team');
  p.bar.color = col === 'class' || col === 'health' ? col : 'team';
  p.name.show = str('plateName', 'show') !== 'hide';
  p.name.size = ({ sm: 9, md: 11, lg: 14 } as Record<string, number>)[str('plateText', 'md')] ?? 11;
  p.res.show = str('plateRes', 'show') !== 'hide';
  p.cast.show = str('plateCast', 'show') !== 'hide';
  p.auras.show = str('plateDebuffs', 'show') !== 'hide';
  const tb = str('targetBars', 'glow');
  p.target.glow = tb === 'bright' || tb === 'off' ? tb : 'glow';
  p.target.arrow = str('targetArrow', 'arrow') !== 'off';
  const mode = str('plates', 'all');
  const out = { me: cloneProfile(p), ally: cloneProfile(p), enemy: cloneProfile(p) };
  out.me.show = out.ally.show = mode === 'all' || mode === 'allies';
  out.enemy.show = mode === 'all' || mode === 'enemies';
  return out;
}

// ------------------------------------------------------------------ which profile

/** Own plate, ally or enemy. When watching a match (`spectating`), nobody is "me". Neutral units, dummies and bots count as their team says. */
export function plateKind(u: { id: number; enemy: boolean }, you: number, spectating = false): PlateKind {
  if (!spectating && u.id === you) return 'me';
  return u.enemy ? 'enemy' : 'ally';
}

// ------------------------------------------------------------------ geometry

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What is on the plate right now (the layout leaves out parts that are empty). */
export interface PlateContext {
  hasMark: boolean;
  hasArrow: boolean;
  hasAvatar: boolean;
  hasTitle: boolean;
  hasRes: boolean;
  hasCast: boolean;
  auraCount: number;
}

export interface PartRect extends Rect {
  visible: boolean;
}

export interface PlateLayout {
  /** The plate's own box: as wide as the health bar, no height, centred on the anchor point. */
  plate: Rect;
  parts: Record<PartId, PartRect>;
  /** All visible parts together. */
  bounds: Rect | null;
}

export const AURA_GAP = 2;
const MARK_SIZE = 26;
const ARROW_SIZE = 22;

export interface AuraGrid {
  perRow: number;
  rows: number;
  w: number;
  h: number;
}

/** How `n` icons are laid out in the buff row: `perRow` icons to a row (by the row width, or the fixed column count). */
export function auraGrid(p: PlateProfile, n: number): AuraGrid {
  if (n <= 0) return { perRow: 0, rows: 0, w: 0, h: 0 };
  const s = p.auras.size * p.scaleH;
  const gap = AURA_GAP * p.scaleH;
  const perRow = p.auras.layout === 'columns' ? p.auras.cols : Math.max(1, Math.floor((p.auras.width * p.scaleW + gap) / (s + gap)));
  const per = Math.min(n, perRow);
  const rows = Math.ceil(n / perRow);
  return { perRow, rows, w: per * s + (per - 1) * gap, h: rows * s + (rows - 1) * gap };
}

function sizeOf(id: PartId, p: PlateProfile, c: PlateContext): { w: number; h: number } | null {
  const sw = p.scaleW;
  const sh = p.scaleH;
  switch (id) {
    case 'marks':
      return c.hasMark || (c.hasArrow && p.target.arrow) ? { w: MARK_SIZE * sh, h: ((c.hasMark ? MARK_SIZE : 0) + (c.hasArrow && p.target.arrow ? ARROW_SIZE : 0)) * sh } : null;
    case 'icon':
      return p.icon.show && c.hasAvatar ? { w: p.icon.size * sh, h: p.icon.size * sh } : null;
    case 'name':
      return p.name.show ? { w: p.bar.w * sw, h: Math.ceil(p.name.size * 1.25) * sh } : null;
    case 'title':
      return p.name.show && p.title.show && c.hasTitle ? { w: p.bar.w * sw, h: Math.ceil(titleSize(p) * 1.25) * sh } : null;
    case 'bar':
      return { w: p.bar.w * sw, h: p.bar.h * sh };
    case 'res':
      return p.res.show && c.hasRes ? { w: p.bar.w * sw, h: p.res.h * sh } : null;
    case 'cast':
      return p.cast.show && c.hasCast ? { w: p.bar.w * sw, h: p.cast.h * sh } : null;
    case 'auras': {
      if (!p.auras.show || c.auraCount <= 0) return null;
      const g = auraGrid(p, Math.min(c.auraCount, p.auras.max));
      return { w: g.w, h: g.h };
    }
  }
}

/** The font size of the title line, following the name. */
export const titleSize = (p: PlateProfile): number => Math.max(6, Math.round(p.name.size * 0.82));

/** Place `r` (width and height set) against `side` of `t`. */
export function place(side: Side, t: Rect, w: number, h: number): { x: number; y: number } {
  const cx = t.x + t.w / 2;
  const cy = t.y + t.h / 2;
  switch (side) {
    case 'above': return { x: cx - w / 2, y: t.y - h };
    case 'below': return { x: cx - w / 2, y: t.y + t.h };
    case 'left': return { x: t.x - w, y: cy - h / 2 };
    case 'right': return { x: t.x + t.w, y: cy - h / 2 };
    default: return { x: cx - w / 2, y: cy - h / 2 };
  }
}

/** Every part's box, in unscaled-plate pixels relative to the anchor point (x right, y down), for the parts that are shown. */
export function layoutPlate(p: PlateProfile, c: PlateContext): PlateLayout {
  const plate: Rect = { x: -(p.bar.w * p.scaleW) / 2, y: 0, w: p.bar.w * p.scaleW, h: 0 };
  const done = new Map<PartId, PartRect>();
  const visit = (id: PartId, depth: number): PartRect => {
    const known = done.get(id);
    if (known) return known;
    const at = p.parts[id];
    const size = sizeOf(id, p, c);
    const w = size?.w ?? 0;
    const h = size?.h ?? 0;
    const target = at.to === 'plate' || depth > PART_IDS.length ? plate : visit(at.to, depth + 1);
    const pos = place(at.side, target, w, h);
    // a part that is not shown takes no space and ignores its offset, so what hangs from it keeps the line
    const r: PartRect = { x: pos.x + (size ? at.dx * p.scaleW : 0), y: pos.y + (size ? at.dy * p.scaleH : 0), w, h, visible: !!size };
    done.set(id, r);
    return r;
  };
  const parts = {} as Record<PartId, PartRect>;
  for (const id of PART_IDS) parts[id] = visit(id, 0);
  return { plate, parts, bounds: unionOf(PART_IDS.filter((id) => parts[id].visible).map((id) => parts[id])) };
}

export function unionOf(rs: Rect[]): Rect | null {
  if (!rs.length) return null;
  const x0 = Math.min(...rs.map((r) => r.x));
  const y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.w));
  const y1 = Math.max(...rs.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The parts that hang from `id`, directly or through other parts (they move with it). */
export function descendants(parts: Record<PartId, Attach>, id: PartId): PartId[] {
  const out: PartId[] = [];
  const grow = (from: string) => {
    for (const q of PART_IDS) if (parts[q].to === from && !out.includes(q) && q !== id) {
      out.push(q);
      grow(q);
    }
  };
  grow(id);
  return out;
}

/** Whether `id` may be attached to `to` without a loop. */
export function canAttach(parts: Record<PartId, Attach>, id: PartId, to: Attach['to']): boolean {
  return to === 'plate' || (to !== id && !descendants(parts, id).includes(to));
}

/**
 * Attach a part somewhere else without it jumping: the new offset is whatever keeps its box where it is now (or 0,0 with
 * `snapTo`, to make it sit flush against the new side). Returns false when the attachment would make a loop.
 */
export function reattach(p: PlateProfile, c: PlateContext, id: PartId, to: Attach['to'], side: Side, snapTo = false): boolean {
  if (!canAttach(p.parts, id, to)) return false;
  const before = layoutPlate(p, c).parts[id];
  p.parts[id] = { to, side, dx: 0, dy: 0 };
  if (!snapTo && before.visible) {
    const flush = layoutPlate(p, c).parts[id];
    p.parts[id].dx = Math.round(((before.x - flush.x) / p.scaleW) * 10) / 10;
    p.parts[id].dy = Math.round(((before.y - flush.y) / p.scaleH) * 10) / 10;
  }
  return true;
}

/** Move a part by a screen-pixel step: its offset changes by the step in plate pixels. */
export function nudgePart(p: PlateProfile, id: PartId, dx: number, dy: number): void {
  const a = p.parts[id];
  a.dx = Math.round(Math.min(500, Math.max(-500, a.dx + dx / p.scaleW)) * 10) / 10;
  a.dy = Math.round(Math.min(500, Math.max(-500, a.dy + dy / p.scaleH)) * 10) / 10;
}

export function sameParts(a: Record<PartId, Attach>, b: Record<PartId, Attach>): boolean {
  return PART_IDS.every((id) => a[id].to === b[id].to && a[id].side === b[id].side && a[id].dx === b[id].dx && a[id].dy === b[id].dy);
}

/** The part relations of the other anchor, kept when the player had not rearranged anything. Switches the anchor either way. */
export function setAnchor(p: PlateProfile, anchor: AnchorPoint): void {
  if (p.anchor === anchor) return;
  const untouched = sameParts(p.parts, defaultParts(p.anchor));
  p.anchor = anchor;
  if (untouched) p.parts = defaultParts(anchor);
}

/** Put the buff row above or below the rest of the plate: `below` hangs it under the last bar, `above` over the name. */
export function setAuraSide(p: PlateProfile, side: 'above' | 'below'): void {
  const d = defaultParts(p.anchor);
  if (p.anchor === 'head') {
    if (side === 'above') {
      p.parts.auras = { to: 'icon', side: 'above', dx: 0, dy: -2 };
      p.parts.marks = { to: 'auras', side: 'above', dx: 0, dy: 0 };
    } else {
      p.parts.auras = { ...d.auras };
      p.parts.marks = { ...d.marks };
    }
  } else if (side === 'above') {
    p.parts.auras = { to: 'plate', side: 'above', dx: 0, dy: -2 };
    p.parts.marks = { to: 'auras', side: 'above', dx: 0, dy: 0 };
  } else {
    p.parts.auras = { ...d.auras };
    p.parts.marks = { ...d.marks };
  }
  breakCycles(p.parts);
}

export const auraSide = (p: PlateProfile): 'above' | 'below' => (p.parts.auras.side === 'above' ? 'above' : 'below');

// ------------------------------------------------------------------ snapping

export interface Guide {
  axis: 'x' | 'y';
  /** The coordinate of the line (x for a vertical line, y for a horizontal one). */
  at: number;
  from: number;
  to: number;
}

export interface Snap {
  dx: number;
  dy: number;
  guides: Guide[];
}

/** The lines of a box along one axis a part can snap to: its start, middle and end. */
const lines = (a: number, len: number): number[] => [a, a + len / 2, a + len];

function bestSnap(mine: number[], theirs: number[], threshold: number): { delta: number; at: number } | null {
  let best: { delta: number; at: number } | null = null;
  for (const m of mine) {
    for (const t of theirs) {
      const d = t - m;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.delta) - 1e-9)) best = { delta: d, at: t };
    }
  }
  return best;
}

/**
 * Snap a box being moved to the edges and centres of the other boxes and to extra lines (the plate's anchor line and
 * centre). Each axis snaps on its own; a guide is returned for every line that ended up shared, spanning the boxes on it.
 */
export function snapMove(r: Rect, others: Rect[], extra: { x?: number[]; y?: number[] }, threshold: number): Snap {
  const xs = [...(extra.x ?? []), ...others.flatMap((o) => lines(o.x, o.w))];
  const ys = [...(extra.y ?? []), ...others.flatMap((o) => lines(o.y, o.h))];
  const sx = bestSnap(lines(r.x, r.w), xs, threshold);
  const sy = bestSnap(lines(r.y, r.h), ys, threshold);
  const dx = sx?.delta ?? 0;
  const dy = sy?.delta ?? 0;
  const moved: Rect = { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
  const guides: Guide[] = [];
  const eq = (a: number, b: number) => Math.abs(a - b) < 0.01;
  if (sx) {
    const on = others.filter((o) => lines(o.x, o.w).some((l) => eq(l, sx.at)));
    const all = [moved, ...on];
    guides.push({ axis: 'x', at: sx.at, from: Math.min(...all.map((o) => o.y)) - 6, to: Math.max(...all.map((o) => o.y + o.h)) + 6 });
  }
  if (sy) {
    const on = others.filter((o) => lines(o.y, o.h).some((l) => eq(l, sy.at)));
    const all = [moved, ...on];
    guides.push({ axis: 'y', at: sy.at, from: Math.min(...all.map((o) => o.x)) - 6, to: Math.max(...all.map((o) => o.x + o.w)) + 6 });
  }
  return { dx, dy, guides };
}

/** Snap one moving edge (or centre line) at `pos` to the nearest of `targets`; the returned value is what to add to `pos`. */
export function snapEdge(pos: number, targets: number[], threshold: number): { delta: number; at: number } | null {
  return bestSnap([pos], targets, threshold);
}

// ------------------------------------------------------------------ resizing

export function clampField(path: string, value: number): number {
  const field = PLATE_FIELDS.find((x) => x.path === path);
  return field ? (cleanValue(field, value, value) as number) : value;
}

/** Set a numeric option from a dragged size, clamped and rounded the way the editor's number boxes are. */
export function setNum(p: PlateProfile, path: string, value: number): void {
  setPath(p as unknown as Dict, path, clampField(path, value));
}

/** A whole-plate resize: both scales follow the dragged corner (`keepRatio` keeps the shape). */
export function resizePlate(p: PlateProfile, start: { scaleW: number; scaleH: number; w: number; h: number }, dw: number, dh: number, keepRatio: boolean): void {
  const kw = start.w > 0 ? (start.w + dw) / start.w : 1;
  const kh = start.h > 0 ? (start.h + dh) / start.h : 1;
  if (keepRatio) {
    const k = Math.abs(kw - 1) > Math.abs(kh - 1) ? kw : kh;
    setNum(p, 'scaleW', start.scaleW * k);
    setNum(p, 'scaleH', start.scaleH * k);
  } else {
    setNum(p, 'scaleW', start.scaleW * kw);
    setNum(p, 'scaleH', start.scaleH * kh);
  }
}

// ------------------------------------------------------------------ the unit's anchor in the world and on screen

/** Height of the head anchor above the model's origin (as before profiles). */
export const HEAD_HEIGHT = 2.7;
/** A hair above the ground so the feet plate is not cut by the floor. */
export const FEET_LIFT = 0.02;

/** World height the plate is projected from: above the model's real height `unitY` (jumps, decks), or at its feet. */
export const anchorWorldY = (anchor: AnchorPoint, unitY: number): number => unitY + (anchor === 'head' ? HEAD_HEIGHT : FEET_LIFT);

/** Opacity of a plate at camera distance `d` metres: 1 up to the near distance, falling to 0 at the far one. */
export function fadeAlpha(p: PlateProfile, d: number): number {
  if (!p.fade.on) return 1;
  if (d <= p.fade.near) return 1;
  if (d >= p.fade.far) return 0;
  return 1 - (d - p.fade.near) / (p.fade.far - p.fade.near);
}

/** Size factor at camera distance `d` (1 when the option is off): shrinks past 18 m down to 0.6, never grows. */
export function distanceScale(p: PlateProfile, d: number): number {
  if (!p.distScale || d <= 18) return 1;
  return Math.max(0.6, 18 / d);
}

/** Stacking order so a nearer plate is drawn over a farther one, and the target's over everyone's. */
export function plateZ(d: number, targeted: boolean): number {
  return (targeted ? 500 : 10) + Math.max(0, 400 - Math.round(Math.min(d, 400)));
}

// ------------------------------------------------------------------ which effect icons

export interface AuraLike {
  id: string;
  src?: number;
  stacks?: number;
  expiresAt: number;
}

const CC_KINDS = ['stun', 'incapacitate', 'fear', 'root'];

/** The effects a plate shows: by the profile's `which`, at most `max`. `info` says whether an aura is harmful and its kind. */
export function pickAuras<T extends AuraLike>(p: PlateProfile['auras'], auras: readonly T[], info: (id: string) => { harmful: boolean; kind?: string } | undefined, you: number): T[] {
  if (!p.show) return [];
  const keep = auras.filter((a) => {
    const i = info(a.id);
    switch (p.which) {
      case 'all': return true;
      case 'mine': return a.src === you;
      case 'cc': return !!i?.harmful && !!i.kind && CC_KINDS.includes(i.kind);
      default: return !!i?.harmful;
    }
  });
  return keep.slice(0, p.max);
}

/** The text of the health bar. */
export function barText(mode: PlateProfile['bar']['text'], health: number, max: number): string {
  const pct = max > 0 ? `${Math.round((health / max) * 100)}%` : '0%';
  switch (mode) {
    case 'percent': return pct;
    case 'value': return `${health}`;
    case 'both': return `${health} · ${pct}`;
    default: return '';
  }
}

// ------------------------------------------------------------------ presets

export interface PlatePreset {
  id: string;
  name: string;
  desc: string;
  make(): PlateProfile;
}

const preset = (id: string, name: string, desc: string, edit: (p: PlateProfile) => void): PlatePreset => ({
  id,
  name,
  desc,
  make: () => {
    const p = defaultProfile();
    edit(p);
    return sanitizeProfile(p);
  },
});

export const PLATE_PRESETS: PlatePreset[] = [
  preset('classic', 'Classic', 'The nameplate as it has always looked.', () => {}),
  preset('minimal', 'Minimal', 'A thin bar and a small name; no avatar, title or resource bar.', (p) => {
    p.bar.w = 80;
    p.bar.h = 4;
    p.name.size = 9;
    p.name.weight = 'normal';
    p.icon.show = false;
    p.title.show = false;
    p.res.show = false;
    p.cast.h = 7;
    p.auras.size = 13;
    p.auras.max = 4;
    p.auras.duration = false;
  }),
  preset('bold', 'Big and bold', 'Large heavy names, a tall bar with its percent, big effect icons.', (p) => {
    p.scaleW = 1.2;
    p.scaleH = 1.2;
    p.bar.h = 12;
    p.bar.text = 'percent';
    p.bar.textSize = 10;
    p.bar.border = 'thick';
    p.name.size = 15;
    p.name.weight = 'heavy';
    p.name.outline = 'strong';
    p.res.h = 6;
    p.cast.h = 14;
    p.auras.size = 24;
    p.auras.max = 5;
  }),
  preset('raid', 'Raid-style', 'Wide flat bars coloured by health with their percent, effects in a column beside the bar.', (p) => {
    p.bar.w = 96;
    p.bar.h = 14;
    p.bar.color = 'health';
    p.bar.text = 'percent';
    p.bar.textSize = 9;
    p.name.size = 10;
    p.name.outline = 'strong';
    p.icon.show = false;
    p.title.show = false;
    p.res.h = 3;
    p.auras.size = 14;
    p.auras.layout = 'columns';
    p.auras.cols = 1;
    p.parts.auras = { to: 'bar', side: 'right', dx: 3, dy: 0 };
    p.parts.cast = { to: 'res', side: 'below', dx: 0, dy: 2 };
  }),
];

/** The target arrow points at the unit: a plate under the feet gets the arrow turned up. */
export function arrowGlyph(glyph: string, anchor: AnchorPoint): string {
  if (anchor !== 'feet') return glyph;
  return ({ '▼': '▲', '⌄': '⌃' } as Record<string, string>)[glyph] ?? glyph;
}

// ------------------------------------------------------------------ copying and resetting

/** A profile with one part put back: its size options and its attachment. */
export function resetPart(p: PlateProfile, id: PartId): void {
  const d = defaultProfile();
  p.parts[id] = { ...defaultParts(p.anchor)[id] };
  switch (id) {
    case 'name': p.name = { ...d.name }; break;
    case 'title': p.title = { ...d.title }; break;
    case 'icon': p.icon = { ...d.icon }; break;
    case 'bar': p.bar = { ...d.bar }; break;
    case 'res': p.res = { ...d.res }; break;
    case 'cast': p.cast = { ...d.cast }; break;
    case 'auras': p.auras = { ...d.auras }; break;
    case 'marks': p.target = { ...d.target }; break;
  }
}
