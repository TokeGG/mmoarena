export interface Vec2 { x: number; z: number }
export type TeamId = 0 | 1;
export type ClassId = 'warrior' | 'mage' | 'priest' | 'rogue';
export type School = 'physical' | 'fire' | 'frost' | 'arcane' | 'holy' | 'shadow' | 'nature';
export type DRCategory = 'stun' | 'incapacitate' | 'fear' | 'root' | 'silence';
export type AuraKind = 'stun' | 'incapacitate' | 'fear' | 'root' | 'slow' | 'speed' | 'absorb' | 'stealth' | 'buff' | 'dot';
export type ResourceType = 'mana' | 'rage' | 'energy';
export type TargetType = 'self' | 'enemy' | 'ally' | 'ally_or_self' | 'any' | 'aoe_enemy' | 'aoe_all' | 'ground';
export type Phase = 'prep' | 'live' | 'ended';

// ---------- builds: specs, talents, gear ----------

/** Per-ability tweaks. damage/heal/cooldown/castTime are multipliers, range is added yards. */
/** `charges` = extra uses allowed while the cooldown runs; `after` = auras you gain on yourself each time the ability fires. */
export interface AbilityMod { damage?: number; heal?: number; cooldown?: number; castTime?: number; range?: number; charges?: number; after?: string[] }

/** Fully resolved modifiers a unit carries. Multipliers default to 1. */
export interface Mods {
  damageDone: number;
  healingDone: number;
  damageTaken: number;
  maxHealth: number;
  castTime: number;
  gcd: number;
  regen: number;
  moveSpeed: number;
  /** Auto-attack interval multiplier (0.7 = swings 43% faster). */
  autoSpeed: number;
  ability: Record<string, AbilityMod>;
  auraDuration: Record<string, number>;
}
/** Partial form used in data files (specs, talents, auras). */
export type ModsInput = Partial<Omit<Mods, 'ability' | 'auraDuration'>> & {
  ability?: Record<string, AbilityMod>;
  auraDuration?: Record<string, number>;
};

export interface SpecDef { id: string; name: string; role: string; desc: string; icon: string; bar: string[]; mods: ModsInput }
/** A talent that trades one of the spec's bar abilities (`from`) for another (`to`). */
export interface BarSwap { to: string; from: string }
export interface TalentDef { id: string; name: string; desc: string; icon: string; mods: ModsInput; swap?: BarSwap }
export interface CosmeticItem {
  id: string;
  slot: string;
  name: string;
  /** Which model the client draws (horns, wings, cloak, ring...). */
  style: string;
  /** CSS hex colour. */
  color: string;
  /** Only the owner account may wear it. */
  owner?: boolean;
}
export interface CosmeticsDef { slots: { id: string; name: string; icon: string }[]; items: CosmeticItem[] }
/** A player's chosen build. Sent on join and validated by the server. */
/** `gear` holds the cosmetic picked for each slot (slot id -> item id). Looks only. */
export interface Build { spec: string; talents: string[]; gear: Record<string, string> }

// ---------- data definitions (loaded from /shared/data/*.json) ----------

export interface AuraDef {
  name: string;
  kind: AuraKind;
  /** ms. 0 = permanent until removed (stealth). */
  duration: number;
  harmful: boolean;
  dr?: DRCategory;
  breaksOnDamage?: boolean;
  /** Only one target at a time per caster: applying it again removes it from the previous target. */
  unique?: boolean;
  /** Damage over time that counts as a bleed (Exsanguinate feeds on these). */
  bleed?: boolean;
  /** Re-applying adds a stack up to this many (Arcane Charge). */
  maxStacks?: number;
  /** Your next damaging ability of this school does `mult` times damage and uses the aura up (Shatter). */
  empower?: { school: School; mult: number };
  /** Your next cast of this ability is instant and uses this aura up (Hot Streak -> Pyroblast). */
  instantFor?: string;
  /** An incapacitated unit may still turn on the spot (Polymorph). */
  canTurn?: boolean;
  /** While this is on you, abilities that normally work through crowd control (Blink) do not (Polymorph). */
  locksAbilities?: boolean;
  /** Heals the holder this percent of maximum health every interval. */
  hot?: { pct: number; interval: number };
  dispellable?: boolean;
  slowPct?: number;
  speedPct?: number;
  absorb?: number;
  /** Damage over time: `amount` every `interval` ms while the aura lasts (credited to `ability` for talent modifiers). */
  dot?: { amount: number; interval: number; school: School; ability: string };
  /** Stat modifiers applied while the aura is active (kind 'buff'). */
  mods?: ModsInput;
}

export type Effect =
  /** `only` limits an effect to allies or enemies of the caster (Penance heals a friend and hurts a foe). */
  | { type: 'damage'; amount: number; only?: 'ally' | 'enemy' }
  | { type: 'heal'; amount: number; only?: 'ally' | 'enemy' }
  | { type: 'aura'; aura: string; /** Chance (0-1) that it applies. */ chance?: number; /** Apply to the caster instead of the target. */ self?: boolean; /** Extra duration in ms per combo point spent. */ extraPerCp?: number }
  /** Combo point payoff: damage from points plus a share of the bleeds on the target, then those bleeds are multiplied. */
  | { type: 'exsanguinate'; perCp: number; bleedFraction: number; bleedMult: number }
  | { type: 'interrupt'; lockout: number }
  | { type: 'dispel' }
  | { type: 'dashToTarget'; stopDistance: number }
  /** A real run: the caster sprints at `speed` yards/s towards the target (uncontrollable) until `stopDistance` away. */
  | { type: 'charge'; stopDistance: number; speed: number; /** Damage dealt on landing, when the target's stun ends. */ hit?: number }
  | { type: 'blink'; distance: number }
  | { type: 'gain'; amount: number }
  /** A ground effect left at the target's position: `amount` damage to enemies inside `radius` every `pulse` ms for `duration` ms. Airborne units dodge a pulse. */
  | { type: 'zone'; radius: number; duration: number; pulse: number; amount: number; delay?: number }
  /** A smoke cloud on the caster: enemies inside lose their target and cannot target anyone. */
  | { type: 'smoke'; radius: number; duration: number }
  /** Removes every harmful effect from the caster. */
  | { type: 'cleanse' }
  /** Drops combat: out of combat at once, and enemies lose their target on the caster. */
  | { type: 'dropCombat' };

export interface AbilityDef {
  id: string;
  name: string;
  class: ClassId;
  school: School;
  target: TargetType;
  range: number;
  minRange?: number;
  radius?: number;
  /** For `aoe_enemy`: only hits enemies inside this many degrees of arc in front of the caster (a cone `radius` yards long). Absent = full circle. */
  coneDeg?: number;
  castTime: number;
  cooldown: number;
  gcd: boolean;
  cost: number;
  effects: Effect[];
  requiresStealth?: boolean;
  /** Combo points earned each time this lands. */
  cpGain?: number;
  /** A combo point payoff: needs at least one point and spends them all. */
  cpSpend?: boolean;
  /** Damage effects are multiplied by the combo points spent (Eviscerate). */
  cpScale?: boolean;
  /** Uses up all stacks of this aura for extra damage (+`perStack` per stack: Arcane Barrage eats Arcane Charge). */
  consumes?: { aura: string; perStack: number };
  /** Can be cast while moving (moving does not cancel it). */
  castWhileMoving?: boolean;
  requiresTargetCasting?: boolean;
  outOfCombatOnly?: boolean;
  keepsStealth?: boolean;
  /** While the caster is stealthed this ability's slot becomes the named ability (Sinister Strike turns into Cheap Shot). */
  stealthSwap?: string;
  prepOk?: boolean;
  ignoresLockout?: boolean;
  /** Can be used while stunned, feared or incapacitated (Blink). */
  ignoresControl?: boolean;
  allowWhileRooted?: boolean;
  /** Channelled: castTime is the whole channel, and the effects fire once per tick (a volley) instead of at the end. */
  channel?: { ticks: number; /** Drawn and described as a continuous beam instead of missiles. */ beam?: boolean };
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
  id: string;
  name: string;
  /** Visual theme for the client scenery (gameplay never depends on it). */
  theme: string;
  desc: string;
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
  autoTolerance: number;
  /** Width of the cone in front of a player inside which targets must be to cast on them or swing at them. */
  castConeDeg: number;
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

export interface MoveInput { seq: number; fwd: number; strafe: number; facing: number; /** Start a (cosmetic) jump. */ jump?: boolean }
export type Result = { ok: true } | { ok: false; reason: string };

export interface AuraInst { id: string; kind: AuraKind; sourceId: number; expiresAt: number; absorbLeft: number; nextTick?: number; stacks?: number; /** Multiplier on this damage-over-time's ticks (Exsanguinate). */ dotMult?: number }
export interface CastState { ability: string; target: number; start: number; end: number; /** Ground-targeted spells: where it lands. */ gx?: number; gz?: number; /** Channels: total ticks and how many have fired. */ ticks?: number; done?: number }
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
  /** Build: ability bar, spec id and resolved passive modifiers. */
  bar: string[];
  spec: string | null;
  /** Cosmetic gear summary (see gearLook). */
  look: string;
  mods: Mods;
  target: number | null;
  cast: CastState | null;
  gcdEnd: number;
  cooldowns: Record<string, number>;
  /** Extra charges spent during each ability's current cooldown (talents that allow more than one use). */
  chargesUsed: Record<string, number>;
  /** Combo points (rogue): earned by Mutilate and Sinister Strike, spent by payoff abilities. */
  cp: number;
  auras: AuraInst[];
  dr: Partial<Record<DRCategory, DRState>>;
  lockouts: Partial<Record<School, number>>;
  autoAttack: boolean;
  /** When auto-attack last switched on; it times out after the out-of-combat delay without any combat. */
  autoSince: number;
  /** The player turned auto-attack off in settings: it never starts, not even from a melee ability. */
  autoDisabled: boolean;
  /** Set while running a Charge: the unit is carried to the target and ignores movement input. */
  charge: { target: number; stop: number; speed: number; until: number; hit: number } | null;
  nextSwing: number;
  lastCombatAt: number;
  inputQueue: MoveInput[];
  /** Sim time (ms) the current/last jump began. */
  jumpStart: number;
  /** While time < dodgeUntil and high enough, ground effects miss this unit. dodgeReadyAt gates the next immune jump. */
  dodgeUntil: number;
  dodgeReadyAt: number;
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
  /** A channel ran its course (or its target died). Interrupts and movement send cast_fail instead. */
  | { t: 'channel_end'; unit: number; ability: string }
  | { t: 'damage'; src: number; tgt: number; amount: number; absorbed: number; ability: string | null; school: School }
  | { t: 'heal'; src: number; tgt: number; amount: number; overheal: number; ability: string }
  | { t: 'interrupt'; src: number; tgt: number; ability: string; school: School; lockout: number }
  /** expiresAt 0 = permanent. dr = duration multiplier applied (1, 0.5, 0.25). */
  | { t: 'aura'; src: number; tgt: number; aura: string; expiresAt: number; dr: number }
  | { t: 'aura_removed'; tgt: number; aura: string; reason: string }
  | { t: 'immune'; src: number; tgt: number; aura: string }
  | { t: 'dispel'; src: number; tgt: number; aura: string }
  | { t: 'death'; unit: number; killer: number | null }
  /** A jump took the unit out of a ground effect's pulse. */
  | { t: 'dodge'; unit: number; ability: string }
  | { t: 'phase'; phase: Phase; winner: TeamId | 'draw' | null };

export interface UnitSnap {
  /** Schools you are locked out of (interrupted), with when each lockout ends. Only present while one is active. */
  lockouts?: Partial<Record<School, number>>;
  id: number;
  name: string;
  team: TeamId;
  classId: ClassId;
  spec: string | null;
  /** Only present when talents changed the spec's default ability bar. */
  bar?: string[];
  /** Cosmetic gear summary (see gearLook). */
  look: string;
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
  auras: { id: string; kind: AuraKind; src: number; expiresAt: number; stacks?: number }[];
  /** Rogue combo points (absent at zero). */
  cp?: number;
  stealthed: boolean;
  /** Damage the unit's shields (Power Word: Shield, Ice Barrier) can still soak; absent when none. */
  absorb?: number;
  /** Height above the ground from a jump (cosmetic). */
  y: number;
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
  /** Ground effects currently on the floor. */
  zones: ZoneSnap[];
}

export interface ZoneSnap {
  id: number;
  /** A smoke cloud (no damage): enemies inside cannot target. */
  smoke?: boolean;
  owner: number;
  team: TeamId;
  x: number;
  z: number;
  r: number;
  school: School;
  ability: string;
  start: number;
  /** Server time of the first pulse; later pulses follow every `pulse` ms until `end`. */
  firstAt: number;
  pulse: number;
  end: number;
}
