export interface Vec2 { x: number; z: number }
export interface Rect { x0: number; x1: number; z0: number; z1: number }
export type TeamId = 0 | 1;
export type ClassId = 'warrior' | 'mage' | 'priest' | 'rogue';
export type School = 'physical' | 'fire' | 'frost' | 'arcane' | 'holy' | 'shadow' | 'nature';
/** 'charge': Charge's short stun has its own group, so it does not spend a step of the stun diminishing returns. */
export type DRCategory = 'stun' | 'incapacitate' | 'fear' | 'root' | 'silence' | 'charge';
export type AuraKind = 'stun' | 'incapacitate' | 'fear' | 'root' | 'slow' | 'speed' | 'absorb' | 'stealth' | 'buff' | 'dot' | 'mark';
export type ResourceType = 'mana' | 'rage' | 'energy';
export type TargetType = 'self' | 'enemy' | 'ally' | 'ally_or_self' | 'any' | 'aoe_enemy' | 'aoe_all' | 'ground';
export type Phase = 'prep' | 'live' | 'ended';

// ---------- builds: specs, talents, gear ----------

/** Per-ability tweaks. damage/heal/cooldown/castTime are multipliers, range is added yards. */
/** `charges` = extra uses allowed while the cooldown runs; `after` = auras you gain on yourself each time the ability fires. */
export interface AbilityMod {
  damage?: number; heal?: number; cooldown?: number; castTime?: number; range?: number; charges?: number; after?: string[];
  /** Resource cost multiplier. */
  cost?: number;
  /** Extra effects appended to the ability (a slow on a strike, a smoke cloud on Vanish). */
  extra?: Effect[];
  /** Chance of one extra combo point each time the ability lands. */
  cpChance?: number;
  /** Extra stored uses, each recharging on its own timer (Vanish with two charges). */
  stored?: number;
  /** Chance each cast first teleports the caster behind the target for free (no combo points). */
  shadowProc?: number;
  /** Works without its usual target requirement (Deep Freeze for specs that cannot apply Fingers of Frost or Shatter). */
  free?: boolean;
  /** Can be used in the middle of another cast without stopping it (Blink). */
  castDuring?: boolean;
  /** An ability aimed at enemies may also be aimed at allies and yourself (Charge becomes Intercept on a friend). */
  allyOk?: boolean;
  /** Effects that go off first, before the ability's own (a Frost Nova where Blink starts). */
  before?: Effect[];
  /** Effects that go off when a charge arrives. */
  landing?: Effect[];
  /** Multiplies the resource this ability gains (Cleave earning more rage). */
  gain?: number;
  /** A channel's tick count (replaces the base count). */
  ticks?: number;
  /** Swaps one aura the ability applies for another (Psychic Scream stuns or sends enemies running instead). */
  swapAura?: Record<string, string>;
  /** Share of the healing this ability does that also arrives as a barrier on the target (Penance). */
  shieldPct?: number;
  /** Share of a heal that is also sent to the other side of the pair: an ally if you healed yourself, you if you healed an ally (Greater Heal). */
  echo?: number;
}

/** Fully resolved modifiers a unit carries. Multipliers default to 1. */
export interface Mods {
  damageDone: number;
  healingDone: number;
  /** Multiplies healing this unit receives (Mortal Wounds). */
  healingTaken: number;
  damageTaken: number;
  maxHealth: number;
  castTime: number;
  gcd: number;
  regen: number;
  moveSpeed: number;
  /** Auto-attack interval multiplier (0.7 = swings 43% faster). */
  autoSpeed: number;
  /** Extra combo point slots on top of 5. */
  maxCp: number;
  /** Multiplies the per-point scaling of combo point payoffs. */
  cpPower: number;
  ability: Record<string, AbilityMod>;
  auraDuration: Record<string, number>;
  /** Milliseconds a re-applied aura (a bleed) adds to its remaining time instead of restarting. */
  auraExtend: Record<string, number>;
}
/** Partial form used in data files (specs, talents, auras). */
export type ModsInput = Partial<Omit<Mods, 'ability' | 'auraDuration' | 'auraExtend' | 'maxCp'>> & {
  ability?: Record<string, AbilityMod>;
  auraDuration?: Record<string, number>;
  auraExtend?: Record<string, number>;
  /** Added, not multiplied. */
  maxCp?: number;
};

/** A weapon a spec is built around: it sets the auto-attack and how the character is drawn. */
export interface WeaponDef { id: 'dual' | 'daggers' | 'twohand' | 'polearm' | 'fire_staff' | 'ice_staff' | 'arcane_staff' | 'holy_staff' | 'necro_staff'; name: string }
export interface AutoDef { interval: number; damage: number; range: number }
export interface SpecDef { id: string; name: string; role: string; desc: string; icon: string; bar: string[]; mods: ModsInput; /** A built-in effect with no button (Cauterize). */ passive?: 'cauterize'; weapon?: WeaponDef; /** Replaces the class auto-attack (dual wield swings fast, two-handers slowly, polearms reach further). */ auto?: AutoDef }
/** A talent that trades one of the spec's bar abilities (`from`) for another (`to`). */
export interface BarSwap {
  to: string;
  from: string;
  /** Other abilities the player may choose to replace instead of `from` (Mage tier 5: Counterspell or Polymorph). */
  alt?: string[];
  /** `to` does not take a button: it shows in `from`'s place only while you are stealthed (Sap on the Kidney Shot button). */
  stealth?: boolean;
}
export interface TalentDef {
  id: string;
  name: string;
  desc: string;
  icon: string;
  mods: ModsInput;
  swap?: BarSwap;
  /** The ability this talent gives as the trinket: an extra button next to the bar (tier 4). */
  trinket?: string;
}
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
  /** Matches the account must have played before it can be worn (a signed-in account; guests have none). */
  unlock?: number;
  /** One line for the tooltip (what it looks like). */
  desc?: string;
}
export interface CosmeticsDef { slots: { id: string; name: string; icon: string }[]; items: CosmeticItem[] }
/** A player's chosen build. Sent on join and validated by the server. */
/** `gear` holds the cosmetic picked for each slot (slot id -> item id). Looks only. */
export interface Build {
  spec: string;
  /** The talent picked in each tier ('' for none). */
  talents: string[];
  gear: Record<string, string>;
  /** For a swap talent that can replace more than one skill: the skill the player chose to give up (talent id -> ability id). */
  replace?: Record<string, string>;
}

// ---------- data definitions (loaded from /shared/data/*.json) ----------

export interface AuraDef {
  name: string;
  kind: AuraKind;
  /** ms. 0 = permanent until removed (stealth). */
  duration: number;
  harmful: boolean;
  dr?: DRCategory;
  breaksOnDamage?: boolean;
  /** Does not break on damage while the unit also has this aura (Shatter holds through Deep Freeze). */
  heldBy?: string;
  /** The marked unit takes `mult` times damage from abilities of this school (Shatter). */
  vulnerable?: { school: School; mult: number };
  /** A line of text for the tooltip of an effect that has no stats of its own. */
  note?: string;
  /** A fear that runs away from whoever put it on, as far as it can, instead of anywhere (Psychic Scream's flee form). */
  flee?: boolean;
  /** Each hit that could land on the holder has this chance (0-1) to strike an image instead and do nothing (Mirror Image). */
  decoys?: number;
  /** Enemies cannot see or target the holder while it lasts (Ascend to the Heavens). */
  untargetable?: boolean;
  /** Takes no damage or harmful effects while it lasts. */
  invulnerable?: boolean;
  /** Harmful effects put on the holder do not take hold while it lasts (Purifying Light). */
  blocksDebuffs?: boolean;
  /** Putting this on resets the cooldown of this ability. */
  resetsCooldown?: string;
  /** The next use of this ability costs no cooldown, and uses this aura up. */
  freeCooldownFor?: string;
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
  /** While this is on you, you cannot use any ability at all (Dispersion). */
  noCast?: boolean;
  /** Heals the holder this percent of maximum health every interval. */
  hot?: { pct: number; interval: number };
  dispellable?: boolean;
  slowPct?: number;
  speedPct?: number;
  absorb?: number;
  /** Absorb as a fraction of the target's max health (added to `absorb`). */
  absorbPct?: number;
  /** Damage over time: `amount` every `interval` ms while the aura lasts (credited to `ability` for talent modifiers). */
  dot?: { amount: number; interval: number; school: School; ability: string };
  /** Stat modifiers applied while the aura is active (kind 'buff'). */
  mods?: ModsInput;
  /** Longest it can last (ms) before diminishing returns, however many combo points went in (Kidney Shot). */
  maxDuration?: number;
}

export type Effect =
  /** `only` limits an effect to allies or enemies of the caster (Penance heals a friend and hurts a foe). */
  | { type: 'damage'; amount: number; only?: 'ally' | 'enemy' }
  | { type: 'heal'; amount: number; only?: 'ally' | 'enemy' }
  /** Heals a fraction of the target's missing health. */
  | { type: 'healMissing'; pct: number }
  | { type: 'aura'; aura: string; /** Limits the effect to allies (and yourself) or enemies of the caster. */ only?: 'ally' | 'enemy'; /** Chance (0-1) that it applies. */ chance?: number; /** Apply to the caster instead of the target. */ self?: boolean; /** Extra duration in ms per combo point spent. */ extraPerCp?: number; /** Lasts this long (ms) instead of the aura's own duration (Deep Freeze applies Shatter for 4 s). */ duration?: number; /** Only when the cast ran its full time, not when a proc made it instant (Pyroblast -> Hot Streak). */ fullCast?: boolean }
  /** Combo point payoff: damage from points plus a share of the bleeds on the target, then those bleeds are multiplied. */
  | { type: 'exsanguinate'; perCp: number; bleedFraction: number; bleedMult: number }
  | { type: 'interrupt'; lockout: number }
  | { type: 'dispel'; /** Takes every dispellable harmful effect off, not just one; with `only` it works on allies or enemies. */ all?: boolean; only?: 'ally' | 'enemy' }
  /** `behind`: land on the far side of the target (its back) rather than on the line you came in on. */
  | { type: 'dashToTarget'; stopDistance: number; behind?: boolean }
  /** Heals a fraction of the target's maximum health. */
  | { type: 'healMax'; pct: number }
  /** A jump to the chosen ground spot (Heroic Leap). */
  | { type: 'leap'; /** Damage to enemies around the landing spot. */ damage?: number; radius?: number }
  /** Drags the target in front of the caster, `stopDistance` yards away (Reel In). */
  | { type: 'pull'; stopDistance: number; /** Drags an ally (Leap of Faith) instead of an enemy. */ ally?: boolean }
  /** Plants a banner at the chosen ground spot: enemies inside cannot leave the circle while it stands. */
  | { type: 'flag'; radius: number; duration: number }
  /** A real run: the caster sprints at `speed` yards/s towards the target (uncontrollable) until `stopDistance` away. */
  | { type: 'charge'; stopDistance: number; speed: number; /** Damage dealt on landing, when the target's stun ends. */ hit?: number; only?: 'ally' | 'enemy' }
  | { type: 'blink'; distance: number }
  | { type: 'gain'; amount: number }
  /** A ground effect left at the target's position: `amount` damage to enemies inside `radius` every `pulse` ms for `duration` ms. Airborne units dodge a pulse. `initial` is a one-off hit to everything inside the moment the cast lands (not dodgeable). */
  | { type: 'zone'; radius: number; duration: number; pulse: number; amount: number; delay?: number; initial?: number; /** Self aura granted for certain when the opening hit lands on at least one enemy (Flamestrike -> Hot Streak). */ procOnHit?: string }
  /** A smoke cloud on the caster: enemies inside lose their target and cannot target anyone. */
  | { type: 'smoke'; radius: number; duration: number }
  /** Removes every harmful effect from the caster. */
  | { type: 'cleanse' }
  /** Frees you from every root and slow (Dispersion). */
  | { type: 'freeMove' }
  /** Drops combat: out of combat at once, and enemies lose their target on the caster. */
  | { type: 'dropCombat' }
  /** With this chance (0-1), the effects inside all happen together (one roll for the whole group). */
  | { type: 'proc'; p: number; effects: Effect[] }
  /** Everything another ability does, free: its area is worked out round the caster (a Frost Nova) or, for one target, on this target. */
  | { type: 'cast'; ability: string }
  /** Removes auras of these kinds from the target (Blind takes off damage over time and fears). */
  | { type: 'strip'; kinds: AuraKind[] }
  /** Enemies lose their target on the caster, and casts at it stop (Mirror Image, Ascend to the Heavens). */
  | { type: 'dropTargets' }
  /** A circle on the ground that gives `aura` to those inside for as long as it stands: `allies` for the caster's team, `self` for the caster alone (Battle Banner, Rune of Power). */
  | { type: 'zoneBuff'; radius: number; duration: number; aura: string; who: 'allies' | 'self' };

export interface AbilityDef {
  id: string;
  name: string;
  /** 'trinket' for the tier 4 abilities every class can pick. */
  class: ClassId | 'trinket';
  /** On no bar and in no talent right now (the old skill swaps were removed with the five-tier tree). Kept in the data so it can come back; audits, the wiki and the debug window skip it. */
  retired?: boolean;
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
  /** Damage multiplier when the caster is behind the target (Backstab). */
  behindMult?: number;
  /** Rage payoff: needs at least `min` rage, spends all of it, and damage scales from x1 at `min` up to x`maxMult` at full rage. */
  rageSpend?: { min: number; maxMult: number };
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
  /** Never fails on facing: the caster does not have to be looking at the target (Counterspell). */
  unmissable?: boolean;
  /** Only castable on a target that has at least one of these auras (Deep Freeze). */
  requiresTargetAura?: string[];
  /** Damage counts as if the target were marked by Shatter when it has this aura, and uses the aura up (Ice Lance on Fingers of Frost). */
  exploit?: { aura: string; mult: number };
  /** Can only be used on a target whose health is below this percentage of its maximum (Execute). */
  maxTargetHealthPct?: number;
  outOfCombatOnly?: boolean;
  keepsStealth?: boolean;
  /** While the caster is stealthed this ability's slot becomes the named ability (Sinister Strike turns into Cheap Shot). */
  stealthSwap?: string;
  prepOk?: boolean;
  ignoresLockout?: boolean;
  /** Direct damage from this ability does not break fear-type effects (Devouring Plague). */
  noBreak?: boolean;
  /** Can be used while stunned, feared or incapacitated (Blink). */
  ignoresControl?: boolean;
  allowWhileRooted?: boolean;
  /** Cannot be interrupted, and while it lasts the caster shrugs off stuns, fears, incapacitates, roots, slows and pulls (Bladestorm). */
  unstoppable?: boolean;
  /** Channelled: castTime is the whole channel, and the effects fire once per tick (a volley) instead of at the end. */
  channel?: { ticks: number; /** The first tick fires the moment the channel starts instead of one interval in (Slice and Dice). */ immediate?: boolean; /** The caster stands in place while it lasts (movement is ignored, not cancelling it): Slice and Dice holds you and your targets still. */ hold?: boolean; /** Drawn and described as a continuous beam instead of missiles. */ beam?: boolean };
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
  /**
   * Raised walkways: flat deck pieces and ramps that rise along an axis (units are on level 0, the ground, or level 1, up
   * here). Under the flats you walk on the ground; the ramps are solid blocks on the ground. Rails along the open edges are
   * worked out from the pieces (see deckRails): they stop you walking off, but a jump clears them and you drop down.
   * Stone piers hold the flats up; they are worked out too unless `piers` lists them.
   */
  deck?: { height: number; flats: Rect[]; ramps: (Rect & { rise: '+x' | '-x' | '+z' | '-z' })[]; piers?: Rect[] };
  /** Low barricades, as tall as a person: they block walking and sight on the ground; a jump clears them and sees over them. */
  lows?: (Rect & { /** A pit of lava: a jump can land in it (nobody is pushed out) and standing in it burns. */ lava?: boolean })[];
  /** Solid straight walls (axis-aligned boxes). They block movement, Blink and line of sight on every level. */
  walls?: { x0: number; x1: number; z0: number; z1: number }[];
  /** Walkable waypoints bots steer between when walls hide the target (the walkable links are worked out from the walls). */
  nav?: Vec2[];
  /** False keeps the arena out of the 'random' pick (it can still be chosen by name and is used for duels). */
  randomPool?: boolean;
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
  /** Cauterize (Pyromancy): health left after a killing blow, as a fraction of max, and how long until it can save you again. */
  cauterizeHealth: number;
  cauterizeCooldownMs: number;
  /** Lava pits: how often standing in one burns you, and how much (fraction of max health) each time. */
  lavaIntervalMs: number;
  lavaPct: number;
  /** Online play: a cast that fails only on range or facing is retried for this long, so a target that stepped out of reach in transit still gets hit. */
  castGraceMs: number;
  /** Furthest back, in ms, that a cast's range and facing check may look at where its target was (lag compensation). */
  maxRewindMs: number;
  /** Feared units stumble around at this fraction of run speed. */
  fearSpeed: number;
  prepMs: number;
  maxMatchMs: number;
  /** Heal spam: each repeat of the same heal in a row is this much weaker (0.15 = 15%), down to this fraction of full, and the pause (ms) after which the count starts again. */
  healSpamStep: number;
  healSpamFloor: number;
  healSpamWindowMs: number;
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
export interface CastState { ability: string; target: number; start: number; end: number; /** Ground-targeted spells: where it lands (gl 1: on top of a walkway). */ gx?: number; gz?: number; gl?: 1; /** Channels: total ticks and how many have fired. */ ticks?: number; done?: number }
export interface DRState { count: number; resetAt: number }

export interface Unit {
  /** 0 = the ground, 1 = up on a walkway's deck or ramps (see ArenaDef.deck). */
  level: 0 | 1;
  id: number;
  name: string;
  team: TeamId;
  classId: ClassId;
  controller: 'player' | 'dummy' | 'bot';
  /** A training dummy that was killed stands up again at `home` when this time comes (practice never ends by killing dummies). */
  respawnAt?: number;
  home?: Vec2;
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
  /** The talent picked in each tier ('' for none), for showing a build to people watching. */
  talents: string[];
  /** The trinket (tier 4 pick): an extra button next to the bar. */
  trinket?: string;
  /** Slots that turn into another ability while this unit is stealthed, from talents (Sap on Kidney Shot): slot ability -> ability. */
  stealthSwaps?: Record<string, string>;
  /** The build the unit was made with, kept so dev tools can work its numbers out again after a change. */
  buildRef?: Build;
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
  /** In the air after Heroic Leap: flies from -> to between start and start + dur, then slams down. */
  /** The spell this unit finished casting last, so a Counterspell pressed a moment late still counts. */
  lastCast: { ability: string; at: number } | null;
  leap: { fromX: number; fromZ: number; toX: number; toZ: number; start: number; dur: number; damage: number; radius: number; /** Floor heights at take-off and landing, and the landing level. */ fromH: number; toH: number; toLv: 0 | 1 } | null;
  charge: { target: number; stop: number; speed: number; until: number; hit: number } | null;
  nextSwing: number;
  lastCombatAt: number;
  /** When standing in lava burns this unit next. */
  lavaAt?: number;
  /** The last heal this unit cast, how many times in a row (0 = first), when, and the strength it had (see Sim.healSpam). */
  lastHeal?: { ability: string; stacks: number; at: number; mult: number };
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
  /** A teleport turned a unit to a new facing (Shadowstep landing behind a target): its player's camera follows. */
  | { t: 'turn'; unit: number; facing: number }
  /** A jump landed (Heroic Leap): where from and where to, for the visuals. */
  | { t: 'leap'; unit: number; fromX: number; fromZ: number; x: number; z: number }
  /** The leap came down. */
  | { t: 'leap_land'; unit: number; x: number; z: number }
  /** A channel ran its course (or its target died). Interrupts and movement send cast_fail instead. */
  | { t: 'channel_end'; unit: number; ability: string }
  | { t: 'damage'; src: number; tgt: number; amount: number; absorbed: number; ability: string | null; school: School }
  | { t: 'heal'; src: number; tgt: number; amount: number; overheal: number; ability: string }
  /** An interrupt found nothing to interrupt. */
  | { t: 'miss'; src: number; tgt: number; ability: string }
  | { t: 'interrupt'; src: number; tgt: number; ability: string; school: School; lockout: number }
  /** expiresAt 0 = permanent. dr = duration multiplier applied (1, 0.5, 0.25). */
  | { t: 'aura'; src: number; tgt: number; aura: string; expiresAt: number; dr: number }
  | { t: 'aura_removed'; tgt: number; aura: string; reason: string }
  | { t: 'immune'; src: number; tgt: number; aura: string }
  | { t: 'dispel'; src: number; tgt: number; aura: string }
  | { t: 'death'; unit: number; killer: number | null }
  | { t: 'respawn'; unit: number }
  /** A jump took the unit out of a ground effect's pulse. */
  | { t: 'dodge'; unit: number; ability: string }
  | { t: 'phase'; phase: Phase; winner: TeamId | 'draw' | null };

export interface UnitSnap {
  /** Charges ready on abilities that store several uses (the number on the button). Only present when there are any. */
  charges?: Record<string, number>;
  /** Schools you are locked out of (interrupted), with when each lockout ends. Only present while one is active. */
  lockouts?: Partial<Record<School, number>>;
  id: number;
  name: string;
  team: TeamId;
  classId: ClassId;
  spec: string | null;
  /** Only present when talents changed the spec's default ability bar. */
  bar?: string[];
  /** The tier IV trinket: an extra button beside the bar. */
  trinket?: string;
  /** Slots that turn into another ability while stealthed, from talents (Sap on the Kidney Shot slot). */
  stealthSwaps?: Record<string, string>;
  /** Cosmetic gear summary (see gearLook). */
  look: string;
  /** 1 while up on a walkway's deck or ramps; absent on the ground. */
  lv?: 1;
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
  /** Combo point slots when above the usual five (Deep Pockets). */
  cpMax?: number;
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
  /** A dev paused this match (dev tools, against bots only): nothing moves until it resumes. */
  paused?: true;
}

export interface ZoneSnap {
  id: number;
  /** A smoke cloud (no damage): enemies inside cannot target. */
  smoke?: boolean;
  /** A banner: enemies inside cannot leave. */
  flag?: boolean;
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
  /** Floor height when the zone lies on top of a walkway (absent on the ground). */
  y?: number;
  /** A circle that buffs those inside (Battle Banner: the caster's team; Rune of Power: the caster). */
  buff?: 'allies' | 'self';
}
