/**
 * Models: the numbers that decide how the player models stand, move and hold things (shared/data/models.json): the gait and arm
 * pose of each character, the way each part of the body is turned and sized, where a helm, cape and wings sit, how each weapon sits
 * in the hands, and where each kind of cosmetic sits. Looks only: never part of the simulation or its content hash. The dev panel's
 * Models page edits it with a live preview; the client merges it over the model registry (client/src/modelData.ts) every time it
 * changes. Angles are in degrees here.
 */

export const MODELS_ID = 'models';

export type Triple = [number, number, number];
export interface BoneAdjust { rx: number; ry: number; rz: number; size: number }
export interface HandData { rot: Triple; pos: Triple; lift: number; out: number }
/** One body part replaced by a model of the dev's own (a .glb in the server's store), fitted to its bone. */
export interface PartFit { file: string; x: number; y: number; z: number; rx: number; ry: number; rz: number; scale: number; hide: number }
export const NEUTRAL_PART: PartFit = { file: '', x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 1, hide: 1 };

export interface CharacterData {
  /** A whole replacement body: a rigged .glb made like the game's own models (see DEVELOPING.md). Empty keeps the game's. */
  body?: { file: string };
  /** Motions of the dev's own, per motion: an uploaded .glb whose first animation plays in place of the built-in one (empty keeps the game's). */
  anims?: Record<string, string>;
  parts?: Record<string, PartFit>;
  pose?: Record<string, number>;
  style?: Record<string, number>;
  helm?: { top: number; r: number; brow: number };
  cape?: Record<string, number>;
  wings?: Record<string, number>;
  bones?: Record<string, BoneAdjust>;
}
export interface WeaponData {
  /** A model of the dev's own for this weapon (empty keeps the game's). It is used whole and held where the grip point is at its middle. */
  file?: string;
  right: HandData;
  left?: HandData;
  mid: number;
  hold?: { r: Triple; l: Triple; walk: number; arc: number; elbowArc: number };
  rest?: { rot: Triple };
}
export interface SlotData { x: number; y: number; z: number; scale: number; rotY: number }
export interface ModelsFile { characters: Record<string, CharacterData>; weapons: Record<string, WeaponData>; cosmetics: Record<string, SlotData> }

export const COSMETIC_SLOTS = ['head', 'wings', 'back', 'weapon'] as const;
export const BONE_NAMES = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulder_l', 'upperarm_l', 'forearm_l', 'hand_l', 'shoulder_r', 'upperarm_r', 'forearm_r', 'hand_r', 'thigh_l', 'shin_l', 'foot_l', 'thigh_r', 'shin_r', 'foot_r'] as const;

/** The parts of the body the Models page groups the bones by. */
export const BODY_PARTS: { title: string; sub: string; bones: string[] }[] = [
  { title: 'Head and neck', sub: 'the head and the neck under it', bones: ['neck', 'head'] },
  { title: 'Torso', sub: 'hips, spine and chest', bones: ['hips', 'spine', 'chest'] },
  { title: 'Right arm', sub: 'shoulder, upper arm, forearm and hand', bones: ['shoulder_r', 'upperarm_r', 'forearm_r', 'hand_r'] },
  { title: 'Left arm', sub: 'shoulder, upper arm, forearm and hand', bones: ['shoulder_l', 'upperarm_l', 'forearm_l', 'hand_l'] },
  { title: 'Right leg', sub: 'thigh, shin and foot', bones: ['thigh_r', 'shin_r', 'foot_r'] },
  { title: 'Left leg', sub: 'thigh, shin and foot', bones: ['thigh_l', 'shin_l', 'foot_l'] },
];

export const BONE_LABEL: Record<string, string> = {
  hips: 'Hips', spine: 'Spine', chest: 'Chest', neck: 'Neck', head: 'Head',
  shoulder_l: 'Shoulder', upperarm_l: 'Upper arm', forearm_l: 'Forearm', hand_l: 'Hand', shoulder_r: 'Shoulder', upperarm_r: 'Upper arm', forearm_r: 'Forearm', hand_r: 'Hand',
  thigh_l: 'Thigh', shin_l: 'Shin', foot_l: 'Foot', thigh_r: 'Thigh', shin_r: 'Shin', foot_r: 'Foot',
};

/** Uploaded models live in the server's store and are served at /models/custom/<name>. */
export const CUSTOM_MODEL_RE = /^custom\/[a-z0-9][a-z0-9-]{0,47}\.glb$/;
export const CUSTOM_MODEL_LIMIT_BYTES = 8_000_000;
export const isModelFile = (v: unknown): v is string => typeof v === 'string' && (v === '' || CUSTOM_MODEL_RE.test(v));
let customList: { file: string; label: string }[] = [];
export const setCustomModels = (l: { file: string; label: string }[]): void => {
  customList = l.filter((f) => CUSTOM_MODEL_RE.test(f.file));
};
export const customModels = (): readonly { file: string; label: string }[] => customList;
export function modelFileChoices(): { options: string[]; labels: Record<string, string> } {
  const labels: Record<string, string> = { '': 'The game\'s own' };
  for (const f of customList) labels[f.file] = `Uploaded: ${f.label}`;
  return { options: Object.keys(labels), labels };
}

/** The most readable size (yards) a part of the body is, for fitting an uploaded model: it is scaled to this when first put on. */
export const PART_SIZE: Record<string, number> = { head: 0.34, neck: 0.18, hand_l: 0.2, hand_r: 0.2, forearm_l: 0.34, forearm_r: 0.34, upperarm_l: 0.36, upperarm_r: 0.36, shoulder_l: 0.3, shoulder_r: 0.3, chest: 0.5, spine: 0.4, hips: 0.4, thigh_l: 0.5, thigh_r: 0.5, shin_l: 0.5, shin_r: 0.5, foot_l: 0.3, foot_r: 0.3 };

export interface ModelField { path: (string | number)[]; label: string; hint?: string; unit: 'deg' | 'yd' | 'x' | 'plain'; min: number; max: number }

export interface ModelGroup { id: string; title: string; sub: string; fields: ModelField[] }

const f = (path: (string | number)[], label: string, unit: ModelField['unit'], min: number, max: number, hint?: string): ModelField => ({ path, label, unit, min, max, ...(hint ? { hint } : {}) });

/** The gait and arm pose numbers (angles are degrees; the animator converts). */
const POSE: [string, string, ModelField['unit'], number, number, string][] = [
  ['armRest', 'Arms at rest: swing forward', 'deg', -90, 90, 'How far the arms hang forward (negative) or back when standing still.'],
  ['elbow', 'Elbows at rest', 'deg', -90, 90, 'How far the elbows are bent when standing still.'],
  ['armIn', 'Arms drawn in', 'deg', -45, 90, 'Pulls the arms in towards the body (for a model whose arms stand out).'],
  ['legIn', 'Legs drawn in', 'deg', -20, 45, 'Brings the legs closer together at rest.'],
  ['stride', 'Stride length', 'x', 0, 2, 'How far the legs swing with each step (a long coat limits it).'],
  ['rightSwing', 'Right arm swing', 'x', 0, 2, 'How much the right arm swings while moving (a heavy weapon is held steadier).'],
  ['castR', 'Right arm when casting', 'deg', -180, 90, 'Negative raises it forward and up.'],
  ['castL', 'Left arm when casting', 'deg', -180, 90, 'Negative raises it forward and up.'],
  ['swingArc', 'Melee swing wind-up', 'deg', -180, 0, 'How far the swinging arm winds up (negative is up and back).'],
];
const STYLE: [string, string, number, number, string][] = [
  ['bounce', 'Step bounce', 0, 3, 'How much the hips bob with each step (1 is the shared default).'],
  ['sway', 'Hip and shoulder roll', 0, 3, 'How much the body rolls with each step.'],
  ['lean', 'Lean into the run', 0, 3, 'Forward lean when running and into starts and stops.'],
  ['crouch', 'Standing crouch', 0, 0.4, 'Knee bend while standing (radians); the hips lower with it.'],
  ['arms', 'Arm swing', 0, 3, 'How far the arms swing while moving.'],
  ['guard', 'Elbows kept bent', 0, 1.2, 'A guard: elbows stay bent at rest (radians).'],
  ['landing', 'Landing give', 0, 3, 'How far the knees give on landing.'],
  ['tuck', 'Jump tuck', 0, 3, 'How high the knees tuck in the air.'],
  ['float', 'Hover', 0, 3, 'A slow hover of the hips (1 is the priest\'s glide).'],
];
const CAPE: [string, string, number, number][] = [
  ['y', 'Collar height', -1, 2], ['z', 'Collar distance behind', -1, 1], ['sx', 'Width', 0.3, 3], ['sy', 'Length', 0.3, 3], ['sz', 'Thickness', 0.2, 3], ['tilt', 'Tilt', -1, 1], ['minPitch', 'Swing towards the body', -1, 1], ['worldDown', 'Hang straight down', 0, 1],
];
const WINGS: [string, string, number, number][] = [
  ['y', 'Shoulder height', -1, 2], ['z', 'Distance behind', -1, 1], ['scale', 'Size', 0.1, 2], ['sx', 'Stretch across', 0.3, 3], ['tilt', 'Tilt', -1, 1], ['raise', 'Raise', -1, 1], ['open', 'Spread', -1, 1],
];

/** The groups of fields a character's page shows, only for what its entry in models.json has. */
export function characterGroups(id: string, data: ModelsFile): ModelGroup[] {
  const c = data.characters[id];
  if (!c) return [];
  const out: ModelGroup[] = [];
  const base = ['characters', id];
  if (c.pose) out.push({ id: 'pose', title: 'Arms and gait', sub: 'how the arms hang and the legs stride', fields: POSE.filter(([k]) => k in c.pose!).map(([k, label, unit, lo, hi, hint]) => f([...base, 'pose', k], label, unit, lo, hi, hint)) });
  if (c.style) out.push({ id: 'style', title: 'Way of moving', sub: 'bounce, lean, landing, jump tuck', fields: STYLE.filter(([k]) => k in c.style!).map(([k, label, lo, hi, hint]) => f([...base, 'style', k], label, 'plain', lo, hi, hint)) });
  if (c.helm) out.push({ id: 'helm', title: 'Helm and head cosmetics', sub: 'where head cosmetics sit on this head', fields: [f([...base, 'helm', 'top'], 'Top of the helm', 'yd', 0.8, 2, 'Where the crest ends: crowns sit above it.'), f([...base, 'helm', 'r'], 'Skull radius', 'yd', 0.05, 0.4), f([...base, 'helm', 'brow'], 'Brow line', 'yd', 0.8, 1.4, 'Horns and circlets sit on it.')] });
  if (c.bones) {
    for (const part of BODY_PARTS.filter((p) => p.bones.some((b) => c.bones![b]))) {
      const fields: ModelField[] = [];
      for (const b of part.bones.filter((x) => c.bones![x])) {
        const lbl = BONE_LABEL[b];
        const limb = /arm|hand|shoulder|thigh|shin|foot/.test(b);
        fields.push(
          f([...base, 'bones', b, 'rx'], limb ? `${lbl}: swing forward / back` : `${lbl}: lean forward / back`, 'deg', -90, 90, limb ? 'Degrees, added to whatever the animation does. Negative swings it forward, positive swings it back. 90 is a quarter turn; 5 is a nudge.' : 'Degrees, added to whatever the animation does. Positive leans it forward, negative back. 90 is a quarter turn; 5 is a nudge.'),
          f([...base, 'bones', b, 'ry'], `${lbl}: turn left / right`, 'deg', -90, 90, 'Degrees. Positive turns it towards the character\'s left, negative towards its right.'),
          f([...base, 'bones', b, 'rz'], `${lbl}: lean sideways`, 'deg', -90, 90, 'Degrees. Positive tips it towards the character\'s right, negative towards its left.'),
          f([...base, 'bones', b, 'size'], `${lbl}: size`, 'x', 0.4, 2.5, 'Times its normal size: 1 is unchanged, 2 is double, 0.5 is half. Scales this bone and what is attached to it.'),
        );
      }
      out.push({ id: `part-${part.title}`, title: part.title, sub: part.sub, fields });
    }
  }
  if (c.body) out.push({ id: 'body', title: 'Whole body', sub: 'replace the entire character model', fields: [{ ...f([...base, 'body', 'file'], 'Body model', 'plain', 0, 0, 'A rigged .glb made like the game\'s own models (bones named hips, spine, chest, neck, head, shoulder_l...; see DEVELOPING.md). The game keeps its own model until this one has loaded.'), unit: 'plain' }] });
  if (c.parts) {
    for (const part of BODY_PARTS.filter((p) => p.bones.some((b) => c.parts![b]))) {
      const fields: ModelField[] = [];
      for (const b of part.bones.filter((x) => c.parts![x])) {
        const lbl = BONE_LABEL[b];
        const pp = [...base, 'parts', b];
        fields.push(
          f([...pp, 'file'], `${lbl}: your own model`, 'plain', 0, 0, 'Pick a model you uploaded. It is fitted to this bone and moves with it.'),
          f([...pp, 'hide'], `${lbl}: hide the game's own part`, 'plain', 0, 1, 'Cuts away the part of the game\'s model that belongs to this bone, so yours replaces it instead of sitting inside it.'),
          f([...pp, 'scale'], `${lbl}: size`, 'x', 0.1, 4, 'Times the size it was fitted at: 1 is unchanged, 2 is double.'),
          f([...pp, 'x'], `${lbl}: slide left / right`, 'yd', -1, 1, 'Yards. Positive is the character\'s left. A nudge is 0.02.'), f([...pp, 'y'], `${lbl}: slide up / down`, 'yd', -1, 1, 'Yards. Positive is up.'), f([...pp, 'z'], `${lbl}: slide forward / back`, 'yd', -1, 1, 'Yards. Positive is forward.'),
          f([...pp, 'rx'], `${lbl}: tilt forward / back`, 'deg', -180, 180, 'Degrees.'), f([...pp, 'ry'], `${lbl}: turn left / right`, 'deg', -180, 180, 'Degrees.'), f([...pp, 'rz'], `${lbl}: lean sideways`, 'deg', -180, 180, 'Degrees.'),
        );
      }
      out.push({ id: `own-${part.title}`, title: `${part.title}: your own models`, sub: 'replace this part with a model you uploaded', fields });
    }
  }
  if (c.anims) out.push({ id: 'anims', title: 'Your own animations', sub: 'play an animation file in place of a built-in motion', fields: [['stand', 'Standing'], ['walk', 'Walking'], ['run', 'Running'], ['swing', 'Melee swing'], ['cast', 'Casting'], ['jump', 'Jumping']].filter(([k]) => k in c.anims!).map(([k, label]) => f([...base, 'anims', k], `${label}: animation file`, 'plain', 0, 0, 'Pick an uploaded .glb with a skeleton and an animation (Mixamo downloads work). Its bones are matched to this character by name, so the character moves the way the clip does. Stand, walk, run and cast loop; a swing starts over each time; a jump plays once.')) });
  if (c.cape) out.push({ id: 'cape', title: 'Cape', sub: 'where cape cosmetics hang', fields: CAPE.filter(([k]) => k in c.cape!).map(([k, label, lo, hi]) => f([...base, 'cape', k], label, 'plain', lo, hi)) });
  if (c.wings) out.push({ id: 'wings', title: 'Wings', sub: 'where wing cosmetics grow', fields: WINGS.filter(([k]) => k in c.wings!).map(([k, label, lo, hi]) => f([...base, 'wings', k], label, 'plain', lo, hi)) });
  return out;
}

const hand = (base: (string | number)[], title: string): ModelField[] => [
  f([...base, 'rot', 0], `${title}: turn about the left-right axis`, 'deg', -180, 180, 'Degrees. Tips the weapon forward or back (like nodding). 90 is a quarter turn.'), f([...base, 'rot', 1], `${title}: turn about the up-down axis`, 'deg', -180, 180, 'Degrees. Swings the weapon left or right (like shaking your head).'), f([...base, 'rot', 2], `${title}: roll about the forward axis`, 'deg', -180, 180, 'Degrees. Rolls the weapon sideways (like tilting your head to a shoulder).'),
  f([...base, 'pos', 0], `${title}: slide left / right`, 'yd', -1.5, 1.5, 'Yards from where the fist holds it. Positive is the character\'s left. A nudge is 0.05; the fist is about 0.15 wide.'), f([...base, 'pos', 1], `${title}: slide up / down`, 'yd', -1.5, 1.5, 'Yards. Positive slides it up through the fist, negative down. A nudge is 0.05.'), f([...base, 'pos', 2], `${title}: slide forward / back`, 'yd', -1.5, 1.5, 'Yards. Positive slides it forward, negative back. A nudge is 0.05.'),
  f([...base, 'lift'], `${title}: raise / lower the tip`, 'deg', -120, 120, 'Degrees. Positive raises the tip, negative lowers it, on top of the turns above. 5 is a nudge.'), f([...base, 'out'], `${title}: turn the tip away from the body`, 'deg', -90, 90, 'Degrees. Positive turns the tip outwards, negative towards the body.'),
];

export function weaponGroups(id: string, data: ModelsFile): ModelGroup[] {
  const w = data.weapons[id];
  if (!w) return [];
  const base = ['weapons', id];
  const out: ModelGroup[] = [{ id: 'model', title: 'Model', sub: 'swap the weapon for a model of your own', fields: [f([...base, 'file'], 'Weapon model', 'plain', 0, 0, 'A .glb you uploaded. It is made the length of the weapon it replaces, with its long side along the blade or shaft and its bottom end in the fist. Tune the grip below.')] }, { id: 'right', title: 'Right hand', sub: 'how it sits in the right hand', fields: hand([...base, 'right'], 'Right hand') }];
  if (w.left) out.push({ id: 'left', title: 'Left hand', sub: 'the second weapon of a pair', fields: hand([...base, 'left'], 'Left hand') });
  out.push({ id: 'effects', title: 'Cosmetic centre', sub: 'where weapon cosmetics (flames, stars, rings) are centred', fields: [f([...base, 'mid'], 'Centre along the weapon', 'yd', -1, 3, 'Yards from the grip.')] });
  if (w.hold) out.push({ id: 'hold', title: 'Two hands on it', sub: 'how both arms carry it', fields: [
    f([...base, 'hold', 'r', 0], 'Right arm: forward', 'deg', -180, 90), f([...base, 'hold', 'r', 1], 'Right arm: away from the body', 'deg', -180, 180), f([...base, 'hold', 'r', 2], 'Right elbow bend', 'deg', -180, 90),
    f([...base, 'hold', 'l', 0], 'Left arm: forward', 'deg', -180, 90), f([...base, 'hold', 'l', 1], 'Left arm: away from the body', 'deg', -180, 180), f([...base, 'hold', 'l', 2], 'Left elbow bend', 'deg', -180, 90),
    f([...base, 'hold', 'walk'], 'Arm swing while walking', 'x', 0, 1.5), f([...base, 'hold', 'arc'], 'Follow of a swing', 'x', 0, 1.5), f([...base, 'hold', 'elbowArc'], 'Elbow follow of a swing', 'x', 0, 1.5),
  ] });
  if (w.rest) out.push({ id: 'rest', title: 'Resting on the shoulder', sub: 'how it sits between fights', fields: [f([...base, 'rest', 'rot', 0], 'Turn about x', 'deg', -180, 180), f([...base, 'rest', 'rot', 1], 'Turn about y', 'deg', -180, 180), f([...base, 'rest', 'rot', 2], 'Turn about z', 'deg', -180, 180)] });
  return out;
}

export const SLOT_LABEL: Record<string, string> = { head: 'Head cosmetics (horns, crowns, halos)', wings: 'Wings', back: 'Capes and back pieces', weapon: 'Weapon cosmetics (flames, stars, rings)' };
export function slotGroups(slot: string, data: ModelsFile): ModelGroup[] {
  if (!data.cosmetics[slot]) return [];
  const base = ['cosmetics', slot];
  return [{ id: 'fit', title: 'Placement', sub: 'moves every cosmetic of this kind on every model', fields: [
    f([...base, 'x'], 'Slide left / right', 'yd', -1, 1, 'Yards. Positive is the character\'s left. A nudge is 0.05; a head is about 0.3 wide.'), f([...base, 'y'], 'Slide up / down', 'yd', -1, 1, 'Yards. Positive is up. A nudge is 0.05; a person is about 2 yards tall.'), f([...base, 'z'], 'Slide forward / back', 'yd', -1, 1, 'Yards. Positive is forward, negative is back. A nudge is 0.05.'),
    f([...base, 'scale'], 'Size', 'x', 0.2, 3, 'Times its normal size: 1 is unchanged, 2 is double, 0.5 is half.'), f([...base, 'rotY'], 'Turn left / right', 'deg', -180, 180, 'Degrees, about the up axis. Positive turns it towards the character\'s left.'),
  ] }];
}

/** The bounds of a number at a path of models.json (null: not a number of the file). */
export function modelBounds(path: readonly (string | number)[], data: ModelsFile): { min: number; max: number } | null {
  const [kind, id] = path;
  const groups = kind === 'characters' && typeof id === 'string' ? characterGroups(id, data) : kind === 'weapons' && typeof id === 'string' ? weaponGroups(id, data) : kind === 'cosmetics' && typeof id === 'string' ? slotGroups(id, data) : [];
  const key = JSON.stringify(path);
  for (const g of groups) for (const fd of g.fields) if (JSON.stringify(fd.path) === key) return { min: fd.min, max: fd.max };
  return null;
}
