export interface Vec2 { x: number; z: number }
export type TeamId = 0 | 1;
export type ClassId = 'warrior' | 'mage' | 'priest' | 'rogue';
export type School = 'physical' | 'fire' | 'frost' | 'arcane' | 'holy' | 'shadow' | 'nature';
export type DRCategory = 'stun' | 'incapacitate' | 'fear' | 'root' | 'silence';
export type AuraKind = 'stun' | 'incapacitate' | 'fear' | 'root' | 'slow' | 'speed' | 'absorb' | 'stealth';
export type ResourceType = 'mana' | 'rage' | 'energy';
export type TargetType = 'self' | 'enemy' | 'ally' | 'ally_or_self' | 'any' | 'aoe_enemy';
export type Phase = 'prep' | 'live' | 'ended';

// ---------- data definitions (loaded from /shared/data/*.json) ----------

export interface AuraDef {
  name: string;
  kind: AuraKind;
  /** ms. 0 = permanent until removed (stealth). */
  duration: number;
  harmful: boolean;
  dr?: DRCategory;
  breaksOnDamage?: boolean;
  dispellable?: boolean;
  slowPct?: number;
  speedPct?: number;
  absorb?: number;
}

export type Effect =
  | { type: 'damage'; amount: number }
  | { type: 'heal'; amount: number }
  | { type: 'aura'; aura: string }
  | { type: 'interrupt'; lockout: number }
  | { type: 'dispel' }
  | { type: 'dashToTarget'; stopDistance: number }
  | { type: 'blink'; distance: number }
  | { type: 'gain'; amount: number };

export interface AbilityDef {
  id: string;
  name: string;
  class: ClassId;
  school: School;
  target: TargetType;
  range: number;
  minRange?: number;
  radius?: number;
  castTime: number;
  cooldown: number;
  gcd: boolean;
  cost: number;
  effects: Effect[];
  requiresStealth?: boolean;
  requiresTargetCasting?: boolean;
  outOfCombatOnly?: boolean;
  keepsStealth?: boolean;
  prepOk?: boolean;
  ignoresLockout?: boolean;
  allowWhileRooted?: boolean;
}

export interface ClassDef {
  name: string;
  color: string;
  maxHealth: number;
  resource: { type: ResourceType; max: number; start: number; regenPerSec: number };
  auto: { interval: number; damage: number; range: number } | null;
  /** Action bar order (keys 1..n). */
  bar: string[];
}

export interface ArenaDef {
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  pillars: { x: number; z: number; r: number }[];
  spawns: Vec2[][];
  spawnFacing: number[];
  gateX: number;
}

export interface Tuning {
  tickMs: number;
  gcdMs: number;
  runSpeed: number;
  drResetMs: number;
  drSteps: number[];
  gearCap: number;
  rangeTolerance: number;
  prepMs: number;
  maxMatchMs: number;
  damageVariance: number;
  stealthDetect: number;
  outOfCombatMs: number;
  rageFromDealt: number;
  rageFromTaken: number;
  rageDecayPerSec: number;
}

// ---------- simulation state ----------

export interface MoveInput { seq: number; fwd: number; strafe: number; facing: number }
export type Result = { ok: true } | { ok: false; reason: string };

export interface AuraInst { id: string; kind: AuraKind; sourceId: number; expiresAt: number; absorbLeft: number }
export interface CastState { ability: string; target: number; start: number; end: number }
export interface DRState { count: number; resetAt: number }

export interface Unit {
  id: number;
  name: string;
  team: TeamId;
  classId: ClassId;
  controller: 'player' | 'dummy' | 'bot';
  pos: Vec2;
  facing: number;
  alive: boolean;
  health: number;
  maxHealth: number;
  resource: number;
  resourceMax: number;
  resourceType: ResourceType;
  gearMult: number;
  target: number | null;
  cast: CastState | null;
  gcdEnd: number;
  cooldowns: Record<string, number>;
  auras: AuraInst[];
  dr: Partial<Record<DRCategory, DRState>>;
  lockouts: Partial<Record<School, number>>;
  autoAttack: boolean;
  nextSwing: number;
  lastCombatAt: number;
  inputQueue: MoveInput[];
  lastInput: MoveInput;
  lastSeq: number;
  starve: number;
  fearDir: Vec2;
  fearRetargetAt: number;
}

export type SimEvent =
  | { t: 'cast_start'; unit: number; ability: string; target: number; end: number }
  | { t: 'cast'; unit: number; ability: string; target: number }
  | { t: 'cast_fail'; unit: number; ability: string; reason: string }
  | { t: 'damage'; src: number; tgt: number; amount: number; absorbed: number; ability: string | null; school: School }
  | { t: 'heal'; src: number; tgt: number; amount: number; overheal: number; ability: string }
  | { t: 'interrupt'; src: number; tgt: number; ability: string; school: School; lockout: number }
  /** expiresAt 0 = permanent. dr = duration multiplier applied (1, 0.5, 0.25). */
  | { t: 'aura'; src: number; tgt: number; aura: string; expiresAt: number; dr: number }
  | { t: 'aura_removed'; tgt: number; aura: string; reason: string }
  | { t: 'immune'; src: number; tgt: number; aura: string }
  | { t: 'dispel'; src: number; tgt: number; aura: string }
  | { t: 'death'; unit: number; killer: number | null }
  | { t: 'phase'; phase: Phase; winner: TeamId | 'draw' | null };

export interface UnitSnap {
  id: number;
  name: string;
  team: TeamId;
  classId: ClassId;
  x: number;
  z: number;
  facing: number;
  alive: boolean;
  health: number;
  maxHealth: number;
  resource: number;
  resourceMax: number;
  resourceType: ResourceType;
  target: number | null;
  cast: CastState | null;
  gcdEnd: number;
  /** abilityId -> absolute server time (ms) when ready. Only entries still on cooldown. */
  cooldowns: Record<string, number>;
  /** expiresAt 0 = permanent */
  auras: { id: string; kind: AuraKind; src: number; expiresAt: number }[];
  stealthed: boolean;
  /** Movement multiplier on TUNING.runSpeed; 0 when rooted/stunned/feared. */
  speedMult: number;
  /** Stunned, incapacitated or feared: client must not predict movement. */
  controlled: boolean;
  autoAttack: boolean;
  lastSeq: number;
}

export interface Snapshot {
  tick: number;
  time: number;
  phase: Phase;
  /** Server time when the current phase ends (prep -> live, or the match time limit). */
  phaseEndsAt: number;
  winner: TeamId | 'draw' | null;
  units: UnitSnap[];
}
