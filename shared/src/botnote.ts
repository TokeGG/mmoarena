import { CLASSES, CLASS_IDS, SPECS } from './data';
import { BRAIN_KEYS } from './botbrain';
import type { Brain } from './botbrain';
import { BRAIN_WORDS } from './brainwords';
import type { ClassId } from './types';

/**
 * Notes for the bots: a dev or the owner writes what went wrong in plain words after (or during) a match, and this turns it
 * into brain numbers and a direction. It is a small deterministic phrase matcher, not a language model: the same note always
 * gives the same moves, and whatever it cannot place is handed back so the writer can rephrase.
 */

/** Longest note. */
export const BOT_NOTE_MAX = 2500;
/** A note counts like this many replays of graded evidence: each mapped number moves NUDGE_STEP of its range times this (botlearn.ts), inside the same step, drift and bound limits. */
export const NOTE_WEIGHT = 3;

export interface NoteEffect {
  key: keyof Brain;
  /** 1: the number goes up, -1: down (what "up" means is BRAIN_WORDS[key].up). */
  dir: 1 | -1;
  /** The words of the note that said it. */
  said: string;
  /** The classes the note names for this, or null for every bot class in the match. */
  classes: ClassId[] | null;
  /** How strongly it was said: 1 slightly, 2 as written, 3 "a lot" (the reading by Ask Claude sets it; a phrase is 2). */
  strength?: 1 | 2 | 3;
}
export interface ParsedNote {
  effects: NoteEffect[];
  /** Asks for both more and less of the same thing: nothing was done about these. */
  conflicts: string[];
  /** Parts that report something broken (stuck, frozen...): no brain number can fix them, they go to the bug list. */
  bugs: string[];
  /** Parts that could not be placed: rephrase them. */
  unmapped: string[];
}

type Dir = 'up' | 'down';
/**
 * What people say, per number and direction. "up" is the direction of BRAIN_WORDS[key].up (higher value), "down" the other.
 * Phrases are matched as whole words after normalising (case, apostrophes, plurals, "line of sight" = "los", "cd" =
 * "cooldown"), so "Didn't LOS enough" and "did not los enough" are the same. BRAIN_WORDS' own up/down sentences work too.
 */
export const NOTE_PHRASES: Record<keyof Brain, Record<Dir, string[]>> = {
  coverHp: {
    up: ['hide earlier', 'hid too late', 'ran for cover too late', 'should run for cover sooner', 'didnt hide soon enough', 'stayed in the open too long when low', 'went for cover too late'],
    down: ['hid too early', 'ran for cover too early', 'ran away too early', 'left the fight too early', 'hides too much when hurt', 'stay in the fight longer', 'hid at high health'],
  },
  defHp: {
    up: ['died with defensive unused', 'died with defensive cooldown unused', 'died with defensive', 'used defensive too late', 'defensive too late', 'didnt use defensive', 'never used defensive', 'held defensive too long', 'should use defensive earlier', 'saved defensive too long'],
    down: ['wasted defensive', 'used defensive too early', 'defensive too early', 'popped defensive too early', 'burned defensive early', 'wasted evasion', 'wasted vanish'],
  },
  strafe: {
    up: ['didnt strafe enough', 'should strafe more', 'barely strafed', 'never strafed', 'easy to hit', 'was a static target', 'did not sidestep'],
    down: ['strafed too much', 'strafes too much', 'wasted time strafing', 'strafing too much', 'sidestepped too much'],
  },
  healerPrio: {
    up: ['ignored the healer', 'didnt go for the healer', 'should kill the healer first', 'should focus the healer', 'didnt target the healer', 'never hit the healer'],
    down: ['went for the healer too much', 'tunneled the healer', 'too focused on the healer', 'ignored the dps', 'kept hitting the healer'],
  },
  focus: {
    up: ['didnt focus', 'didnt focus fire', 'split the damage', 'spread damage', 'should focus fire', 'didnt focus the same target', 'different targets', 'picked different targets'],
    down: ['too much focus fire', 'all hit the same target', 'everyone on the same target', 'should pick their own target', 'overfocused'],
  },
  killLow: {
    up: ['didnt finish the low target', 'didnt finish him off', 'let the low target live', 'should finish weak targets', 'let me live at low health', 'didnt chase the low target', 'ignored the low health target'],
    down: ['chased low health targets too much', 'overcommitted to a low target', 'kept chasing the almost dead', 'went after the low target too much'],
  },
  rangeBias: {
    up: ['stood too close', 'too close', 'didnt kite', 'should stay farther back', 'should stand further back', 'caster in melee range', 'caster stood next to me'],
    down: ['stood too far', 'too far away', 'too far', 'should fight closer', 'should stand closer', 'kited too much', 'kited too far'],
  },
  healAt: {
    up: ['healed too late', 'didnt heal', 'didnt heal in time', 'didnt heal enough', 'should heal earlier', 'heals too slow', 'let people die', 'healer didnt heal', 'priest didnt heal', 'never healed', 'heal too late'],
    down: ['healed too early', 'healed too much', 'overhealing', 'healed when not needed', 'heal too early', 'spammed heals'],
  },
  burstHp: {
    up: ['burst too late', 'didnt burst early', 'should burst earlier', 'saved burst too long', 'died with burst unused', 'held burst too long', 'didnt use burst'],
    down: ['burst too early', 'wasted burst', 'wasted cooldown on a healthy target', 'popped burst too early', 'wasted cooldown on full health', 'burst at full health'],
  },
  strafeFlip: {
    up: ['changes direction too often', 'changed direction too often', 'jittery', 'zigzag too much', 'twitchy', 'flips direction too much', 'strafe flips too fast'],
    down: ['predictable strafing', 'predictable movement', 'strafes in straight lines', 'should change direction more', 'strafe was predictable', 'predictable'],
  },
  chase: {
    up: ['stopped chasing', 'let me escape', 'didnt chase', 'gave up chasing', 'didnt follow when i ran', 'let me run away', 'should chase more'],
    down: ['chased too much', 'kept chasing', 'chased me forever', 'followed too far', 'chased too far', 'should stop chasing'],
  },
  panicHp: {
    up: ['emergency too late', 'panic button too late', 'should use emergency earlier', 'died with emergency button', 'didnt use the big heal in time', 'emergency button too late', 'big heal too late', 'barrier too late'],
    down: ['wasted emergency', 'emergency too early', 'used the panic button too early', 'panic button too early', 'wasted the big heal', 'wasted barrier'],
  },
  dangerAt: {
    up: ['reacts to everything', 'panics at small damage', 'overreacted', 'over reacted', 'too jumpy', 'reacted to small hits', 'defends too easily'],
    down: ['didnt react to burst', 'didnt react to damage', 'ignored the burst', 'didnt see the burst coming', 'didnt defend against burst', 'should react to burst', 'died to burst', 'died in a burst', 'reacted too late to burst'],
  },
  ccEarly: {
    up: ['didnt stun', 'didnt use cc', 'didnt use crowd control', 'should stun earlier', 'never used stun', 'didnt sheep', 'didnt fear when hurt', 'never stunned', 'never used cc', 'cc too late', 'stun too late'],
    down: ['wasted stun', 'wasted cc', 'used cc too early', 'stunned too early', 'wasted fear', 'wasted sheep', 'cc too early', 'stun too early'],
  },
  dodge: {
    up: ['stood in flamestrike', 'stood in blizzard', 'stood in the fire', 'stands in ground effect', 'didnt dodge', 'didnt move out of the fire', 'stood in aoe', 'stood in the zone', 'standing in the fire', 'stood in the ground effect', 'stood in fire', 'stands in fire', 'stands in flamestrike', 'stands in blizzard'],
    down: ['dodged too much', 'ran out of blizzard for nothing', 'left the zone too early', 'dodges too much', 'moved out of the zone too much'],
  },
  preShield: {
    up: ['didnt have shield up', 'no shield at the start', 'shield was down', 'should preshield', 'didnt preshield', 'shield not up', 'shield wasnt up'],
    down: ['shielded at full health', 'shield too early', 'shielded when healthy', 'wasted shield at the start'],
  },
  jukeChance: {
    up: ['should fake cast more', 'didnt fake', 'faked too little', 'more fake casts', 'never faked', 'didnt fake cast'],
    down: ['faked too much', 'fake casts too much', 'wasted time faking', 'too many fake casts', 'stopped casting too much', 'fakes too much', 'faked too often'],
  },
  jukeAt: {
    up: ['fake cast stopped too early', 'fake wasnt convincing', 'fake cast cancelled too early', 'fakes stopped too early', 'fake was too short', 'fake cast too short'],
    down: ['fake cast too long', 'fakes got kicked', 'got interrupted on the fake', 'fake too late', 'fake cast stopped too late', 'fake got interrupted'],
  },
  kickAt: {
    up: ['kicked too early', 'kick too early', 'kicked on the fake', 'fell for the fake', 'kicked a fake cast', 'interrupted too early', 'wasted kick', 'wasted interrupt', 'kicked the fake', 'kicking too early', 'interrupt too early'],
    down: ['never kicked', 'didnt kick', 'didnt interrupt', 'never interrupted', 'kicked too late', 'interrupt too late', 'missed the kick', 'let the cast finish', 'should kick earlier', 'didnt use kick', 'kick too late', 'kicking too late', 'let the big cast finish'],
  },
  losUse: {
    up: ['didnt los enough', 'didnt los', 'didnt break los', 'should los more', 'never used pillar', 'didnt hide behind the pillar', 'stood in the open', 'should use cover', 'no los', 'didnt use cover', 'didnt use the pillar', 'didnt use pillar'],
    down: ['hid too much', 'los too much', 'kept hiding', 'ran behind pillar too much', 'wasted time on los', 'hid behind the pillar too much', 'too much los'],
  },
  mobility: {
    up: ['didnt move enough', 'stood still', 'stationary', 'should keep moving', 'too static', 'didnt keep moving'],
    down: ['moved too much', 'ran around too much', 'should stand and fight', 'too much hopping', 'jumped too much', 'moves too much', 'circled too much'],
  },
  trinketAt: {
    up: ['didnt use trinket', 'never used trinket', 'died with trinket', 'stunned with trinket ready', 'should trinket earlier', 'didnt break stun', 'trinket too late', 'didnt trinket', 'held the trinket too long', 'sat in stun with trinket'],
    down: ['wasted trinket', 'trinket too early', 'used trinket on nothing', 'wasted pvp trinket', 'trinketed too early', 'popped trinket too early', 'trinket wasted'],
  },
  burstUse: {
    up: ['didnt use offensive cooldown', 'held cooldown while losing', 'should pop cooldown when behind', 'didnt pop cooldown when losing', 'too passive', 'passive', 'didnt pressure', 'didnt use offensive cooldown when losing', 'saved offensive cooldown too long'],
    down: ['wasted offensive cooldown', 'popped cooldown while losing for nothing', 'used offensive cooldown too early', 'popped offensive cooldown too early', 'wasted cooldown'],
  },
  peelAt: {
    up: ['didnt peel', 'melee on the caster', 'didnt frost nova', 'got meleed', 'should peel earlier', 'let the melee sit on', 'didnt scream', 'didnt use dragons breath', 'didnt use psychic scream', 'melee sat on the caster', 'peeled too late', 'peel too late'],
    down: ['peeled too much', 'wasted frost nova', 'kept peeling', 'wasted psychic scream', 'peeled for no reason', 'peeled too early', 'wasted dragons breath'],
  },
  shieldAt: {
    up: ['didnt shield partner', 'didnt shield ally', 'should shield earlier', 'no shield on partner', 'pain suppression too late', 'didnt shield the partner', 'shielded too late', 'shield too late'],
    down: ['shielded too much', 'wasted shield on partner', 'shielded too early', 'wasted pain suppression', 'shield on partner too early'],
  },
  healCap: {
    up: ['didnt top off', 'didnt top up', 'let people sit at ninety percent', 'never healed to full', 'should top people up', 'didnt heal people near full'],
    down: ['overhealed', 'healed full health', 'healed people at full', 'wasted heals', 'wasted mana on heals', 'healed healthy', 'healed someone at full health', 'overheal'],
  },
  switchHp: {
    up: ['switched away from the low target', 'didnt finish', 'should finish before switching', 'swapped when almost dead', 'left him at ten percent', 'switched off a low target', 'swapped off the kill', 'switched away from the kill'],
    down: ['didnt switch', 'kept hitting the almost dead target', 'should switch more', 'tunnel vision', 'stayed on the low target too long', 'wouldnt switch'],
  },
  stickiness: {
    up: ['swapped targets too much', 'kept switching target', 'target swapping', 'changed targets too often', 'flip flopped', 'didnt stay on target', 'switches target too much', 'switched targets too often'],
    down: ['stuck on one target', 'stuck on the same target', 'stayed on the same target', 'wouldnt switch targets', 'kept hitting an immune target', 'attacked a target out of sight', 'kept targeting someone behind a pillar', 'stuck on target', 'stuck on a target he cant hit'],
  },
  losCheck: {
    up: ['kept casting at someone out of sight', 'cast into a pillar', 'wasted casts into the pillar', 'kept casting after i hid', 'finished the cast while i was behind a pillar', 'cast while out of los', 'cast at me behind the pillar', 'kept casting into los', 'casts into the pillar'],
    down: ['cancelled casts too often', 'cancelled cast too early', 'stopped casting too early', 'cancels too many casts', 'stopped casts too much'],
  },
  rangeBuffer: {
    up: ['casts went out of range', 'cast failed out of range', 'i walked out of range', 'out of range cast', 'spell out of range', 'failed to cast out of range', 'target walked out of range', 'cast out of range'],
    down: ['started casts too close', 'moved in too much before casting', 'wasted time walking into range', 'cast too late', 'walked too close before casting'],
  },
  drRespect: {
    up: ['wasted stun on dr', 'stunned with dr', 'feared with diminishing returns', 'wasted cc on dr', 'used cc on dr', 'stun had no effect', 'stun was nearly immune', 'cc on diminishing returns', 'wasted fear on dr', 'used stun with dr', 'cced me on dr'],
    down: ['didnt cc because of dr', 'should cc even on dr', 'held cc too long for dr', 'waited too long for dr', 'should stun even with dr'],
  },
  spendBias: {
    up: ['ran out of mana', 'went oom', 'oom', 'no mana', 'out of mana', 'mana ran out', 'should save mana', 'wasted mana', 'low on mana at the key moment', 'ran dry', 'no mana left', 'mana was empty'],
    down: ['saved mana for nothing', 'died with mana', 'didnt spend mana', 'hoarded mana', 'died with full mana', 'should spend mana', 'died with mana left', 'saved too much mana'],
  },
  stayNear: {
    up: ['ran away from the healer', 'left the healer', 'out of healer range', 'wandered away from the healer', 'didnt stay near the healer', 'melee ran out of heals', 'away from the priest', 'strayed from the healer', 'ran out of heal range'],
    down: ['stuck to the healer too much', 'stayed next to the healer too much', 'followed the healer around', 'too close to the healer', 'glued to the healer'],
  },
  edgeCare: {
    up: ['fell into lava', 'died to lava', 'jumped into lava', 'hopped into the lava', 'walked into lava', 'lava death', 'fell off', 'died in the lava', 'hopped into lava'],
    down: ['stayed too far from lava', 'didnt jump over lava', 'too scared of lava', 'wouldnt hop near lava', 'avoided lava too much'],
  },
};

/**
 * Words that stand for several numbers at once: how it feels to play against, not one setting. Same matching rules as above.
 */
export const NOTE_FEELINGS: { phrases: string[]; moves: { key: keyof Brain; dir: 1 | -1 }[] }[] = [
  { phrases: ['too aggressive', 'overextended', 'dove in too much', 'dived in too much', 'too reckless', 'too brave'], moves: [{ key: 'coverHp', dir: 1 }, { key: 'defHp', dir: 1 }, { key: 'burstHp', dir: -1 }] },
  { phrases: ['too passive', 'too defensive', 'too timid', 'too cautious', 'not aggressive enough', 'didnt pressure enough'], moves: [{ key: 'coverHp', dir: -1 }, { key: 'burstUse', dir: 1 }, { key: 'burstHp', dir: 1 }] },
  { phrases: ['too predictable', 'easy to read'], moves: [{ key: 'strafeFlip', dir: -1 }, { key: 'jukeChance', dir: 1 }] },
  { phrases: ['too slow to react', 'reacted too slowly', 'reacts too late'], moves: [{ key: 'dangerAt', dir: -1 }, { key: 'panicHp', dir: 1 }] },
];

/** Words that report a malfunction rather than a judgement: they cannot be fixed with a brain number. */
const BUG_PHRASES = ['stuck', 'froze', 'frozen', 'freeze', 'glitch', 'glitched', 'bug', 'bugged', 'afk', 'idle', 'pathing', 'doing nothing', 'not moving', 'wont move', 'doesnt move', 'dont move', 'ran into the wall', 'into the wall', 'against the wall', 'in a corner', 'running in circles', 'spinning', 'stands there', 'did nothing', 'wont attack', 'never attacked', 'cant reach', 'walked off', 'broken'];

// ---------------------------------------------------------------- normalising

const SYNONYMS: Record<string, string> = { cd: 'cooldown', cds: 'cooldown', def: 'defensive', defs: 'defensive', defensives: 'defensive', cc: 'cc', ccd: 'cced', pvp: 'pvp' };
/** Words that carry nothing for matching. */
const FILLER = new Set(['the', 'a', 'an', 'really', 'very', 'just', 'quite', 'bot', 'my', 'their', 'his', 'her', 'our', 'literally', 'basically', 'kinda']);
/** Words that do not make a leftover piece worth reporting as "could not place". */
const NOISE = new Set(['the', 'a', 'an', 'bot', 'when', 'while', 'and', 'but', 'it', 'he', 'she', 'they', 'was', 'were', 'is', 'are', 'did', 'do', 'also', 'then', 'so', 'because', 'that', 'this', 'of', 'in', 'on', 'at', 'to', 'with', 'doing', 'fight', 'fighting', 'match', 'game', 'i', 'me', 'we', 'you', 'there', 'had', 'has', 'have', 'got', 'get', 'again', 'sometimes', 'often', 'always', 'still', 'too', 'much', 'more', 'less', 'enough', 'lot', 'bit', 'like', 'its', 'one', 'my', 'their', 'ok', 'okay']);

interface Tok { raw: string; n: string }

function contractions(text: string): string {
  return text
    .replace(/[’`]/g, "'")
    .replace(/\b(did|do|does|could|would|should|was|were|is|are|can|has|have|had)\s+not\b/gi, (_m, w: string) => `${w}n't`)
    .replace(/\bcannot\b/gi, "can't")
    .replace(/\bline[- ]of[- ]sight\b/gi, 'los')
    .replace(/\bpre[- ]shield/gi, 'preshield')
    .replace(/\bpercent\b/gi, '%');
}

function stem(w: string): string {
  const s = SYNONYMS[w] ?? w;
  if (s.length > 4 && s.endsWith('s') && !/(ss|us|is)$/.test(s)) return s.slice(0, -1);
  return s;
}

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of contractions(text).matchAll(/[A-Za-z0-9%]+(?:'[A-Za-z]+)?/g)) {
    const raw = m[0];
    out.push({ raw, n: stem(raw.toLowerCase().replace(/'/g, '')) });
  }
  return out;
}

const NUMBER_WORDS: Record<string, string> = { ninety: '90', ten: '10' };
const phraseTokens = (p: string): string[] => tokens(p).map((t) => NUMBER_WORDS[t.n] ?? t.n).filter((n) => !FILLER.has(n));

interface Rule { toks: string[]; key: keyof Brain; dir: 1 | -1 }
let RULES: Rule[] | null = null;
const dirSign = (d: Dir): 1 | -1 => (d === 'up' ? 1 : -1);
/** The BRAIN_WORDS sentence without its bracket: "use defensive cooldowns earlier (at higher health)" -> "use defensive cooldowns earlier". */
const wordsPhrase = (s: string) => s.replace(/\s*\([^)]*\)/g, '');

function rules(): Rule[] {
  if (RULES) return RULES;
  const out: Rule[] = [];
  for (const key of BRAIN_KEYS) {
    for (const dir of ['up', 'down'] as const) {
      for (const p of [...NOTE_PHRASES[key][dir], wordsPhrase(BRAIN_WORDS[key][dir])]) out.push({ toks: phraseTokens(p), key, dir: dirSign(dir) });
    }
  }
  for (const f of NOTE_FEELINGS) for (const p of f.phrases) for (const m of f.moves) out.push({ toks: phraseTokens(p), key: m.key, dir: m.dir });
  RULES = out.filter((r) => r.toks.length).sort((a, b) => b.toks.length - a.toks.length);
  return RULES;
}

// ---------------------------------------------------------------- classes

/** Names a note can use for a class: "mage", or one of its specs ("frost", "pyromancy"). */
const CLASS_NAMES: Record<string, ClassId> = (() => {
  const m: Record<string, ClassId> = {};
  for (const c of CLASS_IDS) {
    m[c] = c;
    m[CLASSES[c].name.toLowerCase()] = c;
    for (const s of SPECS[c] ?? []) {
      m[s.id.toLowerCase()] = c;
      m[s.name.toLowerCase()] = c;
    }
  }
  return m;
})();
/** Spec names are also ordinary words ("fire", "shadow", "combat"): they name a class only in a tag at the start ("frost: ..."). */
const classWord = (w: string): ClassId | undefined => CLASS_NAMES[w] ?? CLASS_NAMES[w.replace(/s$/, '')];
const CLASS_ONLY = new Set<string>(CLASS_IDS.flatMap((c) => [c, CLASSES[c].name.toLowerCase()]));
const isClassOnly = (w: string) => CLASS_ONLY.has(w) || CLASS_ONLY.has(w.replace(/s$/, ''));

/** "mage: ..." or "priest, rogue: ..." or "frost mage bots: ..." at the start of a sentence. */
function tagOf(sentence: string): { classes: ClassId[]; rest: string } | null {
  const m = /^\s*([A-Za-z][A-Za-z ,/&+-]{1,60}?)\s*:\s*(.*)$/s.exec(sentence);
  if (!m) return null;
  const words = m[1].toLowerCase().split(/[\s,/&+-]+/).filter(Boolean).filter((w) => !['and', 'bot', 'bots', 'the', 'all'].includes(w));
  if (!words.length) return null;
  const found: ClassId[] = [];
  for (const w of words) {
    const c = classWord(w);
    if (!c) return null; // an ordinary sentence with a colon
    if (!found.includes(c)) found.push(c);
  }
  return { classes: found, rest: m[2] };
}

// ---------------------------------------------------------------- parsing

const trimConnectors = (t: Tok[]): Tok[] => {
  let a = 0;
  let b = t.length;
  while (a < b && ['and', 'but', 'also', 'then', 'plus', 'so', 'when', 'while', 'because', 'the', 'a', 'it', 'he', 'she', 'they', 'was', 'were', 'is', 'are'].includes(t[a].n)) a++;
  while (b > a && ['and', 'but', 'also', 'then', 'plus', 'so', 'when', 'while', 'because', 'the', 'a', 'it', 'he', 'she', 'they'].includes(t[b - 1].n)) b--;
  return t.slice(a, b);
};

function matchAt(stream: Tok[], i: number, toks: string[]): boolean {
  if (i + toks.length > stream.length) return false;
  for (let k = 0; k < toks.length; k++) if ((NUMBER_WORDS[stream[i + k].n] ?? stream[i + k].n) !== toks[k]) return false;
  return true;
}

/** What a note asks for. Sentences end at . ; ! ? or a new line; a tag ("mage: ...") names the classes for what follows until the next tag. */
export function parseNote(text: string): ParsedNote {
  const out: ParsedNote = { effects: [], conflicts: [], bugs: [], unmapped: [] };
  let tagged: ClassId[] | null = null;
  const seen = new Map<string, NoteEffect>();
  const dead = new Set<string>();
  for (const part of text.split(/[.;!?\n]+/)) {
    let sentence = part.trim();
    if (!sentence) continue;
    const tag = tagOf(sentence);
    if (tag) {
      tagged = tag.classes;
      sentence = tag.rest.trim();
      if (!sentence) continue;
    }
    // inside the sentence a class can be named too ("the mage did not los enough")
    const all = tokens(sentence);
    const stream = all.filter((t) => !FILLER.has(t.n));
    const named = [...new Set(stream.map((t) => t.n).filter(isClassOnly).map((w) => classWord(w)!))];
    const classes = named.length ? named : tagged;
    // the longest phrases claim their words first; words a longer phrase took are not matched again (the same words may carry several numbers)
    const claim = new Array<string>(stream.length).fill('');
    const found: { key: keyof Brain; dir: 1 | -1; from: number; to: number }[] = [];
    for (const r of rules()) {
      for (let i = 0; i + r.toks.length <= stream.length; i++) {
        if (!matchAt(stream, i, r.toks)) continue;
        const span = `${i}-${i + r.toks.length}`;
        if (claim.slice(i, i + r.toks.length).some((c) => c && c !== span)) continue;
        for (let k = i; k < i + r.toks.length; k++) claim[k] = span;
        found.push({ key: r.key, dir: r.dir, from: i, to: i + r.toks.length });
      }
    }
    // a phrase said in two places, or two rules on the same words, count once per number and direction
    for (const f of found) {
      const said = stream.slice(f.from, f.to).map((t) => t.raw).join(' ');
      const sig = `${classes ? [...classes].sort().join('+') : '*'}|${f.key}`;
      if (dead.has(sig)) continue;
      const have = seen.get(sig);
      if (have) {
        if (have.dir !== f.dir) {
          seen.delete(sig);
          dead.add(sig);
          out.effects = out.effects.filter((e) => e !== have);
          out.conflicts.push(`"${have.said}" and "${said}" ask for opposite things about ${BRAIN_WORDS[f.key].what}`);
        }
        continue;
      }
      const eff: NoteEffect = { key: f.key, dir: f.dir, said, classes: classes ? [...classes] : null };
      seen.set(sig, eff);
      out.effects.push(eff);
    }
    // what is left: broken behaviour goes to the bug list, anything else that says something could not be placed
    const covered = new Set<Tok>();
    for (const f of found) for (let k = f.from; k < f.to; k++) covered.add(stream[k]);
    const runs: Tok[][] = [];
    let cur: Tok[] = [];
    for (const t of all) {
      if (covered.has(t)) {
        if (cur.length) runs.push(cur);
        cur = [];
      } else cur.push(t);
    }
    if (cur.length) runs.push(cur);
    for (const run of runs) {
      const t = trimConnectors(run);
      if (!t.length) continue;
      const stream2 = t.filter((x) => !FILLER.has(x.n));
      const bug = BUG_PHRASES.some((p) => {
        const pt = phraseTokens(p);
        for (let i = 0; i + pt.length <= stream2.length; i++) if (matchAt(stream2, i, pt)) return true;
        return false;
      });
      const words = stream2.filter((x) => !NOISE.has(x.n) && !isClassOnly(x.n));
      const raw = t.map((x) => x.raw).join(' ');
      if (bug) out.bugs.push(raw);
      else if (words.length >= 2 || (words.length === 1 && !found.length && !out.effects.length)) out.unmapped.push(raw);
    }
  }
  return out;
}

/** A note the interpreter can say something useful about: moves, or a bug. */
export const noteUnderstood = (p: ParsedNote): boolean => p.effects.length > 0 || p.bugs.length > 0;
