import type { Brain } from './botbrain';

/** How a brain number is written: a share of health or chance, seconds, yards, or a plain score. */
type Fmt = 'pct' | 'sec' | 'yd' | 'num';

/**
 * What each learned bot number means in play, in plain words: the behaviour it sets, what a higher or lower value changes,
 * and what to look for in a game to see it working. Used by the learning reports so "defHp 0.65 -> 0.62" reads as
 * "uses defensive cooldowns later".
 */
export interface BrainWords {
  /** The behaviour, as a noun phrase ("when it uses defensive cooldowns"). */
  what: string;
  /** The change in behaviour when the number goes up / down (a verb phrase after "bots now"). */
  up: string;
  down: string;
  /** What to watch for in a match. */
  watch: string;
  fmt: Fmt;
}

export const BRAIN_WORDS: Record<keyof Brain, BrainWords> = {
  coverHp: { what: 'the health at which it runs behind a pillar', up: 'run for cover earlier (at higher health)', down: 'stay in the fight longer before hiding', watch: 'bots breaking line of sight when hurt', fmt: 'pct' },
  defHp: { what: 'the health at which it uses defensive cooldowns', up: 'use defensive cooldowns earlier (at higher health)', down: 'hold defensive cooldowns until they are lower', watch: 'Evasion, Vanish, Desperate Prayer, Enraged Regeneration going off', fmt: 'pct' },
  strafe: { what: 'how hard it sidesteps while fighting', up: 'sidestep more', down: 'stand still more', watch: 'bots weaving left and right instead of standing', fmt: 'pct' },
  healerPrio: { what: 'how much it wants to kill the healer first', up: 'go for the healer sooner', down: 'ignore the healer more', watch: 'which of your team they target first', fmt: 'num' },
  focus: { what: 'how much it joins its teammate on one target', up: 'focus the same target as their partner', down: 'pick their own targets', watch: 'two bots hitting the same player', fmt: 'num' },
  killLow: { what: 'how much a low-health enemy pulls its attention', up: 'chase weak targets harder', down: 'ignore weak targets more', watch: 'bots switching to whoever is almost dead', fmt: 'num' },
  rangeBias: { what: 'how far a caster stands from its target', up: 'stand farther back', down: 'fight closer', watch: 'casters kiting at range or hugging you', fmt: 'yd' },
  healAt: { what: 'how early a priest heals', up: 'heal earlier', down: 'heal later', watch: 'priest bots topping people up before they are low', fmt: 'num' },
  burstHp: { what: 'the enemy health at which it spends burst cooldowns', up: 'burst earlier (at higher enemy health)', down: 'save burst for when the enemy is lower', watch: 'bots popping Recklessness or Arcane Power', fmt: 'pct' },
  strafeFlip: { what: 'how long before it changes sidestep direction', up: 'change sidestep direction less often', down: 'change sidestep direction more often', watch: 'how predictable their weaving is', fmt: 'sec' },
  chase: { what: 'how often it chases a slowed, fleeing target', up: 'keep chasing runners', down: 'switch to someone else', watch: 'bots following you when you run', fmt: 'pct' },
  panicHp: { what: 'the health at which it hits its emergency button', up: 'use emergency buttons earlier', down: 'wait longer for emergency buttons', watch: 'big heals, shields and barriers used at the last second or early', fmt: 'pct' },
  dangerAt: { what: 'how big a burst of damage counts as danger', up: 'only react to bigger bursts', down: 'react to smaller bursts', watch: 'bots protecting themselves before they are low', fmt: 'pct' },
  ccEarly: { what: 'how early it uses stuns, fears and sheep to defend', up: 'use crowd control to defend earlier', down: 'hold crowd control until later', watch: 'bots stunning or sheeping you when they get hurt', fmt: 'pct' },
  dodge: { what: 'how readily it steps out of ground fire like Flamestrike', up: 'leave ground zones sooner', down: 'stand in ground zones longer', watch: 'bots standing in or leaving your Flamestrike and Blizzard', fmt: 'pct' },
  preShield: { what: 'the health below which it keeps its shield up', up: 'keep a shield on even when healthy', down: 'only shield when hurt', watch: 'Power Word: Shield and Ice Barrier already up at the start', fmt: 'pct' },
  jukeChance: { what: 'how often a caster fakes a cast', up: 'fake casts more often to bait your interrupt', down: 'fake casts less', watch: 'casters starting a spell and cancelling it', fmt: 'pct' },
  jukeAt: { what: 'how far into a fake cast it stops', up: 'stop fakes later', down: 'stop fakes earlier', watch: 'how long a fake cast bar runs before it is cancelled', fmt: 'pct' },
  kickAt: { what: 'how far into your cast it interrupts', up: 'interrupt later in your cast', down: 'interrupt earlier in your cast', watch: 'Kick, Pummel and Counterspell timing against your casts', fmt: 'pct' },
  losUse: { what: 'how readily it hides behind pillars and decks', up: 'break line of sight more', down: 'fight in the open more', watch: 'bots ducking behind cover from your big casts', fmt: 'pct' },
  mobility: { what: 'how much it keeps moving while fighting', up: 'keep moving more', down: 'stand and fight more', watch: 'bots strafing, circling and hopping', fmt: 'pct' },
  trinketAt: { what: 'how readily it uses its trinket', up: 'use the trinket earlier and break out of stuns at once', down: 'save the trinket', watch: 'trinkets popping when stunned, feared or sheeped', fmt: 'pct' },
  burstUse: { what: 'how early it uses offensive cooldowns when losing', up: 'use offensive cooldowns earlier', down: 'hold offensive cooldowns longer', watch: 'bots popping big cooldowns while behind', fmt: 'pct' },
  peelAt: { what: 'how soon a caster pushes melee off itself', up: 'peel melee away sooner (Frost Nova, Dragon\'s Breath, Psychic Scream)', down: 'keep casting with melee on them', watch: 'casters blasting you away when you reach them', fmt: 'pct' },
  shieldAt: { what: 'the ally health at which a healer shields them', up: 'shield allies earlier', down: 'shield allies later', watch: 'Power Word: Shield and Pain Suppression on partners', fmt: 'pct' },
  healCap: { what: 'the health above which a healer stops healing', up: 'heal people who are nearly full', down: 'stop healing sooner and save mana', watch: 'priests wasting or saving heals on healthy allies', fmt: 'pct' },
  switchHp: { what: 'the enemy health at which it finishes a target instead of switching', up: 'finish low targets instead of switching', down: 'switch away from low targets more', watch: 'bots finishing you off versus swapping', fmt: 'pct' },
  stickiness: { what: 'how loyal it is to its current target', up: 'stay on one target longer', down: 'leave a target sooner (also one it cannot hit)', watch: 'how often bots swap targets', fmt: 'num' },
  losCheck: { what: 'how quickly it stops a cast whose target stepped out of sight', up: 'stop wasted casts at once', down: 'finish casts at targets that left sight', watch: 'casts continuing after you duck behind a pillar', fmt: 'pct' },
  rangeBuffer: { what: 'how much room it keeps inside maximum range before casting', up: 'start casts closer so you cannot walk out of range', down: 'cast at the edge of range', watch: 'casts failing because you stepped out of range', fmt: 'yd' },
  drRespect: { what: 'how strictly it avoids crowd control that has diminishing returns', up: 'skip weakened crowd control', down: 'use crowd control even when it is weak', watch: 'stuns and fears wasted on a target with diminishing returns', fmt: 'pct' },
  spendBias: { what: 'how soon a caster saves mana', up: 'save mana earlier', down: 'spend mana freely', watch: 'casters running dry at the key moment', fmt: 'pct' },
  stayNear: { what: 'how closely a fighter stays with its healer', up: 'stay near their healer', down: 'wander away from the healer', watch: 'melee bots running out of their healer\'s reach', fmt: 'pct' },
  edgeCare: { what: 'how far from lava it keeps before hopping', up: 'keep clear of lava edges', down: 'hop closer to lava', watch: 'bots falling into lava', fmt: 'pct' },
};

const num = (n: number, small = false) => (small ? n.toFixed(3) : (Math.round(n * 100) / 100).toString());
/** A brain value in the unit it means ("62% health", "1.5 s", "3 yd"). */
export function showBrainValue(key: keyof Brain, v: number): string {
  const f = BRAIN_WORDS[key].fmt;
  if (f === 'pct') return `${Math.round(v * 100)}%`;
  if (f === 'sec') return `${num(v)} s`;
  if (f === 'yd') return `${num(v)} yd`;
  return num(v);
}

/** One move as a sentence about the behaviour: "now use defensive cooldowns later (62% instead of 65%)". */
export function plainMove(m: { key: keyof Brain; before: number; after: number }): string {
  const w = BRAIN_WORDS[m.key];
  if (!w) return `${String(m.key)} ${m.before} -> ${m.after}`;
  return `${m.after > m.before ? w.up : w.down} (${w.what}: ${showBrainValue(m.key, m.after)}, was ${showBrainValue(m.key, m.before)})`;
}
