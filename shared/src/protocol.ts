import { ABILITIES, ARENAS, CLASSES, CLASS_IDS, SPECS } from './data';
import { validPatch } from './devpatch';
import type { DataPatch } from './devpatch';
import { NAME_RE, PASSWORD_MAX, PASSWORD_MIN, cleanCustom } from './accounts';
import type { AccountInfo, AdminLogRow, AdminRow, Cosmetics, CustomStyle, FriendRow, LeaderRow, LiveMatch, MatchRecord, StatRow, PartyInfo, RosterEntry } from './accounts';
import type { SlimSnapshot, UnitInfo } from './snapslim';
import type { Build, ClassId, SimEvent, Snapshot, TeamId } from './types';

export const PROTOCOL_VERSION = 10;

/** Team sizes: 1v1, 2v2, 3v3. */
export type TeamSize = 1 | 2 | 3;
/** What the owner can do from the admin panel. */
export type AdminAct = 'kick' | 'ban' | 'unban' | 'mute' | 'unmute' | 'set_rating' | 'reset_stats' | 'note' | 'maintenance' | 'pause_match' | 'history' | 'log' | 'feed' | 'train' | 'train_status' | 'autotrain' | 'kill';
const ADMIN_ACTS: readonly AdminAct[] = ['kick', 'ban', 'unban', 'mute', 'unmute', 'set_rating', 'reset_stats', 'note', 'maintenance', 'pause_match', 'history', 'log', 'feed', 'train', 'train_status', 'autotrain', 'kill'];
/** A running match in the owner's admin panel. */
export interface AdminRoom { id: string; map: string; size: number; kind: 'ranked' | 'practice' | 'party' | 'bots' | 'dummies'; elapsedMs: number; players: { name: string; classId: ClassId; team: TeamId; human: boolean }[]; watchers: number; devTest: boolean; paused: boolean }
/** One connection on the owner's "Online now" list (guests included). */
export interface AdminOnline { name: string; guest: boolean; ip: string; where: string; status: string; sinceMs: number }
/** One replay the bots are training on (or just trained on), for the admin panel's progress bars. */
export interface TrainJobRow {
  id: string;
  state: 'training' | 'done' | 'failed';
  startedAt: number;
  /** How long it should take in all, from the replay's length and how long earlier ones took. */
  etaMs: number;
  finishedAt?: number;
  /** What came of it. */
  text?: string;
}
/** A change a dev sent to the owner's admin panel with "Send to the admin panel"; nothing in it is live until the owner acts. */
export interface ProposalRow {
  id: string;
  by: string;
  at: number;
  note?: string;
  patches: DataPatch[];
  /** The same changes in words: what, old number, new number. */
  changes: { label: string; from: number | string | null; to: number | string }[];
  status: 'pending' | 'live' | 'pr' | 'dismissed';
  url?: string;
}
/** What a unit is playing with, shown to people watching a match. */
export interface UnitBuild { id: number; name: string; classId: ClassId; team: TeamId; spec: string | null; talents: string[]; bar: string[]; /** A bot (its class and build can be changed from the dev panel). */ bot?: boolean; }
/** One bot in an owner's bot match: its class and, if chosen, its spec (else a random one). */
export interface BotPick { classId: ClassId; spec?: string }

export type PracticeDifficulty = 'dummy' | 'easy' | 'normal' | 'hard';
const DIFFICULTIES: PracticeDifficulty[] = ['dummy', 'easy', 'normal', 'hard'];

/** Client -> server. The client only ever sends intents; the server decides outcomes. */
export type ClientMsg =
  | {
      t: 'join';
      name: string;
      classId: ClassId;
      /** 'party': a friendly match for the whole party; each member picks a side and bots fill the empty places. */
      mode: 'practice' | 'queue' | 'duel' | 'party';
      /** Duel only: the friend you agreed to fight (account name). */
      duelWith?: string;
      /** Players per team (default 2). */
      size?: TeamSize;
      /** Practice only: enemy classes (up to the team size), ally bots (one fewer than the team size), and how they behave. */
      foes?: ClassId[];
      allies?: ClassId[];
      /** Older single-ally form, used when `allies` is absent. */
      ally?: ClassId | null;
      difficulty?: PracticeDifficulty;
      /** Arena id, or 'random' (default). */
      map?: string;
      /** Spec, talent picks and gear. Validated by the server against the signed profile. */
      build?: Build;
      /** Signed progress token from an earlier `profile` message. */
      profile?: string;
    }
  | { t: 'input'; seq: number; fwd: number; strafe: number; facing: number; jump?: boolean }
  | { t: 'target'; id: number | null }
  /** Round-trip probe: the server answers at once with a `pong` carrying the same `n`. */
  | { t: 'ping'; n: number }
  | { t: 'cast'; ability: string; target?: number | null; /** Ground-targeted spells: the point under the cursor. */ x?: number; z?: number; /** 1 when the point is on top of a walkway (the aim hit the deck, not the ground under it). */ lv?: 1; /** Sim time of the frame the player was looking at, so the server can judge range against what they saw. */ vt?: number }
  | { t: 'auto'; on: boolean }
  /** The auto-attack setting: `off` stops it from ever starting. */
  | { t: 'autoOff'; off: boolean }
  /** Put a raid mark (1-8) over a unit's head for your team, or 0 to clear it. */
  | { t: 'mark'; unit: number; mark: number }
  | { t: 'leave' }
  /** Accounts. Password-based; a successful register/login returns a session token for `resume`. */
  | { t: 'register'; name: string; password: string; ownerCode?: string }
  | { t: 'login'; name: string; password: string }
  | { t: 'resume'; token: string }
  | { t: 'logout' }
  | { t: 'customize'; cosmetics: Cosmetics }
  /** Replace the account's saved settings (HUD, keybinds, builds...) with this JSON snapshot. */
  | { t: 'save_settings'; data: string }
  | { t: 'leaderboard' }
  /** Prove this session is the owner (needs the server's owner code). */
  | { t: 'owner_unlock'; code: string }
  | { t: 'admin_list' }
  /** Your recent matches. */
  | { t: 'history' }
  /** Ranked matches in progress that can be watched. */
  | { t: 'live' }
  | { t: 'spectate'; id: string }
  /**
   * Owner only: a private match of bots against bots, watched live. Each side lists its bots (class and, optionally, spec);
   * nobody else can see or join it, and it closes when the owner stops watching.
   */
  /** Dev tools (owner or the 'dev' tag), in a match where the dev is the only person: pause it, try numbers in it. */
  | { t: 'dev_pause'; on: boolean }
  | { t: 'dev_patch'; patches: DataPatch[] }
  /** Test numbers kept for the dev's session: put into every match they play (or watch, as the owner) until cleared. */
  | { t: 'dev_session'; patches: DataPatch[] }
  /** Dev tools: keep these numbers for everyone (live at once, and proposed for the data files). */
  | { t: 'dev_save'; patches: DataPatch[]; note?: string }
  /** Dev tools: a note on a skill, sent to the owner. */
  | { t: 'dev_note'; ability: string; text: string }
  /** Ask Claude to change a skill's numbers from a plain-words request; the answer is tried in the dev's match at once. */
  | { t: 'dev_ai'; ability: string; text: string }
  /** Dev tools: start the match over with the same builds (everyone back at the start, full health, live at once). */
  | { t: 'dev_restart' }
  /** Owner, dev test matches: move the running match to another map. */
  | { t: 'dev_map'; id: string }
  /** Dev tools: give a bot in the dev's match another class and build, on the fly. */
  | { t: 'dev_bot'; unit: number; classId: ClassId; build: Build }
  /** Dev tools: everyone's build in the dev's own match. */
  | { t: 'dev_builds' }
  /** Owner admin panel. */
  | { t: 'admin_overview' }
  | { t: 'admin_announce'; text: string }
  | { t: 'admin_end'; id: string }
  | { t: 'overrides_clear' }
  /** Owner: open a GitHub pull request with every live number change, for the data files. */
  | { t: 'overrides_pr'; note?: string }
  /** Owner: the dev proposals (list), or act on some: make them live, open one pull request with them all, or dismiss them. */
  | { t: 'admin_proposals'; op: 'list' | 'live' | 'pr' | 'dismiss'; ids?: string[]; note?: string }
  /** Owner moderation and server control from the admin panel (see AdminAct). */
  | { t: 'admin_act'; act: AdminAct; name?: string; minutes?: number; reason?: string; value?: number; text?: string; id?: string; on?: boolean }
  /** Owner only: follow a player (by name) into every match they play, as a live spectator; null stops following. */
  | { t: 'follow'; name: string | null }
  | { t: 'bot_match'; size: TeamSize; teams: [BotPick[], BotPick[]]; difficulty: 'easy' | 'normal' | 'hard'; map: string }
  /** Friends: your list and requests. */
  | { t: 'friends' }
  | { t: 'friend'; op: 'add' | 'accept' | 'decline' | 'remove'; name: string }
  /** Ask a friend into your party (queue together) or to a 1v1 duel. */
  | { t: 'invite'; kind: 'party' | 'duel'; name: string }
  | { t: 'invite_reply'; id: string; accept: boolean }
  | { t: 'party_leave' }
  /** End screen: ready (or not) for another match with the same players. */
  | { t: 'rematch'; on: boolean }
  /** The suggestion box: send an idea (everyone), or read the box (owner only). */
  | { t: 'suggest'; text: string; /** An attached .txt note for more room (up to NOTE_MAX characters). */ note?: string }
  | { t: 'suggestions' }
  /** Owner only: remove one suggestion from the box. */
  | { t: 'suggest_delete'; at: number; text: string }
  /** Pick which side you play on in a party match. */
  | { t: 'party_side'; side: 0 | 1 }
  /** Party members other than the leader: mark yourself ready (with your current class and build) or not. */
  | { t: 'ready'; on: boolean; name: string; classId: ClassId; build?: Build; profile?: string }
  | { t: 'party_kick'; name: string }
  /** Tell your party what you have picked in the menu (class, spec, skins) so they see your model in the lobby. */
  | { t: 'party_look'; classId: ClassId; build?: Build }
  /** Owner only. Any field left out is unchanged; `custom: null` removes a custom style. */
  | { t: 'admin_set'; name: string; grants?: string[]; custom?: CustomStyle | null; useCustom?: boolean; resetPassword?: boolean };

export const MAX_SETTINGS = 24000;
/** Longest note a player can attach to a suggestion (the socket carries 32 KB, and not every character is one byte). */
export const NOTE_MAX = 10000;

export type ServerMsg =
  | { t: 'welcome'; protocol: number; unitId: number; team: TeamId; classId: ClassId; spec: string | null; bar?: string[]; map: string; /** Milliseconds per server tick (absent: TUNING.tickMs, what older servers ran at). */ tickMs?: number }
  /** Progress (matches played). Store `token` and send it back on join. */
  | { t: 'profile'; token: string; matches: number; wins: number }
  | { t: 'queued'; waiting: number; needed: number }
  /** `snap` from a player's own team feed carries slim units plus the `info` (identity) of units new or changed; see snapslim.ts. Spectator and paused frames are full. */
  | { t: 'snapshot'; snap: SlimSnapshot; events: SimEvent[]; info?: UnitInfo[] }
  /** The answer to a `ping`. */
  | { t: 'pong'; n: number; /** How much of a tick the server needs, 0 to 1+ (1 = all of it): the network readout says when it is busy. */ load?: number }
  /** How many of the people in the finished match are ready to play again. */
  | { t: 'rematch'; ready: number; total: number; you: boolean }
  | { t: 'suggest_ack'; ok: boolean; reason?: string }
  | { t: 'suggestions'; rows: { at: number; name: string; text: string; note?: string }[] }
  /** Numbers changed for everyone by a dev (applied over the data files). */
  | { t: 'overrides'; patches: DataPatch[] }
  | { t: 'proposals'; rows: ProposalRow[] }
  /** The replays the bots are training on right now and the ones just finished. */
  | { t: 'train_status'; jobs: TrainJobRow[]; active: number }
  /** Dev tools: the match's pause state and the test numbers in it. */
  | { t: 'dev_state'; paused: boolean; patches: DataPatch[]; /** The match started over (everyone is back at the spawns): drop every position and prediction held for the old state. */ reset?: boolean }
  /** The test match is now on this map (everyone in it, players and watchers). */
  | { t: 'dev_map'; map: string }
  | { t: 'dev_session'; patches: DataPatch[] }
  | { t: 'dev_result'; ok: boolean; text: string; url?: string }
  /** Owner admin panel: who is online and every match running (private ones included), and the server's state. */
  | { t: 'admin_overview'; /** How the server loop copes (owner only). */ tick?: { ms: number; avgMs: number; maxMs: number; load: number; late: number; worstMs: number; rooms: number }; online: number; /** Everyone connected, guests too (owner only). */ players?: AdminOnline[]; queued: number; rooms: AdminRoom[]; uptimeMs?: number; version?: string; accounts?: number; overrides?: number; maintenance?: string | null; /** Saving numbers also opens a GitHub pull request (GITHUB_TOKEN is set). */ pullRequests?: boolean; /** Skill notes reach Discord. */ notes?: boolean; /** The dev panel's Ask Claude box works (ANTHROPIC_API_KEY is set). */ ai?: boolean; /** The bots train on every finished match (the owner's switch). */ autoTrain?: boolean }
  | { t: 'admin_log'; rows: AdminLogRow[] }
  | { t: 'admin_history'; name: string; rows: MatchRecord[] }
  /** Every match played on the server (the owner's match list). */
  | { t: 'admin_feed'; rows: MatchRecord[] }
  /** For people watching: every unit's spec, talents and ability bar. */
  | { t: 'builds'; units: UnitBuild[] }
  /** Who the owner is following into their matches (null: nobody). */
  | { t: 'following'; name: string | null }
  /** Owner spectators only: running damage and healing totals for everyone in the match. */
  | { t: 'stats'; rows: StatRow[]; /** The match just ended: show the scoreboard to everyone in it. */ final?: boolean }
  | { t: 'error'; reason: string; ability?: string }
  | { t: 'closed'; reason: string }
  /** The signed-in account (sent on login, resume, customize and after every counted match). `token` only on login/register. */
  | { t: 'account'; account: AccountInfo; token?: string }
  | { t: 'auth_error'; reason: string }
  | { t: 'logged_out' }
  | { t: 'leaderboard'; rows: LeaderRow[] }
  /** The account's saved settings JSON ('' if none yet). Sent right after login/resume. */
  | { t: 'settings'; data: string }
  /** Cosmetics of the signed-in players in your match, by unit id. */
  | { t: 'roster'; players: RosterEntry[] }
  | { t: 'owner'; ok: boolean; reason?: string }
  | { t: 'history'; rows: MatchRecord[] }
  | { t: 'friends'; friends: FriendRow[]; requests: string[] }
  | { t: 'invite'; id: string; kind: 'party' | 'duel'; from: string }
  | { t: 'invite_gone'; id: string }
  | { t: 'party'; party: PartyInfo | null }
  /** A duel was agreed: send a join with mode 'duel' and `duelWith`. */
  | { t: 'duel_go'; with: string }
  /** A short message to show the player. */
  | { t: 'notice'; text: string }
  /** Your team's raid marks: unit id and mark (1-8, see MARKS). */
  | { t: 'marks'; marks: [number, number][] }
  /** The owner's announcement: a big banner for everyone online (and anyone joining in the next few minutes). */
  | { t: 'announce'; text: string; by: string; at: number }
  | { t: 'live'; rows: LiveMatch[]; signIn?: boolean }
  /** You are now watching a match (snapshots follow, about 5 s behind). */
  | { t: 'spectating'; id: string; map: string; size: number }
  | { t: 'admin_accounts'; rows: AdminRow[] }
  /** Result of an admin_set; `tempPassword` is shown once when a password was reset. */
  | { t: 'admin_result'; ok: boolean; name: string; reason?: string; row?: AdminRow; tempPassword?: string };

/** Number patches from a client: well formed, at most 200, each naming an existing number in the data. */
/** Most players in a party: two full teams of three for an in-house 3v3. */
export const PARTY_MAX = 6;
/** Most party members on one side of a party match. */
export const PARTY_SIDE_MAX = 3;

/** What a party leader reads while the others have not pressed Ready: "Waiting for Bob, Cy (2/4) to ready up". `ready` counts the leader. */
export function partyWaitingText(names: string[], ready: number, total: number): string {
  return `Waiting for ${names.join(', ')} to ready up (${ready}/${total}).`;
}

/** Raid marks a team can put over heads (index + 1 is the mark number), WoW style. */
export const MARKS = [
  { id: 'star', name: 'Star', icon: '⭐' },
  { id: 'circle', name: 'Circle', icon: '🟠' },
  { id: 'diamond', name: 'Diamond', icon: '💎' },
  { id: 'triangle', name: 'Triangle', icon: '🔺' },
  { id: 'moon', name: 'Moon', icon: '🌙' },
  { id: 'square', name: 'Square', icon: '🟦' },
  { id: 'cross', name: 'Cross', icon: '❌' },
  { id: 'skull', name: 'Skull', icon: '💀' },
] as const;

export function parsePatches(raw: unknown): DataPatch[] | null {
  if (!Array.isArray(raw) || raw.length > 200) return null;
  const out: DataPatch[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') return null;
    const { file, id, path, value } = p as Record<string, unknown>;
    if (!['abilities', 'auras', 'specs', 'talents', 'classes'].includes(file as string) || typeof id !== 'string' || id.length > 40 || (typeof value !== 'number' && !(typeof value === 'string' && value.length <= 20))) return null;
    if (!Array.isArray(path) || !path.every((k) => (typeof k === 'string' && k.length <= 32) || (typeof k === 'number' && Number.isInteger(k) && k >= 0 && k < 32))) return null;
    const patch: DataPatch = { file: file as DataPatch['file'], id, path: path as (string | number)[], value };
    if (!validPatch(patch)) return null;
    out.push(patch);
  }
  return out;
}

/** Keep only a well-formed build: strings of sane length, the 5 talent tiers (an older client's sixth entry is dropped), the skills chosen to give up for swap talents and one id per gear slot. */
export function parseBuild(raw: unknown): Build | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === 'string' && /^[\w.]{1,40}$/.test(v) ? v : '');
  if (!id(r.spec)) return undefined;
  const talents = Array.isArray(r.talents) ? r.talents.slice(0, 5).map(id) : [];
  const gear: Record<string, string> = {};
  if (r.gear && typeof r.gear === 'object') {
    for (const [slot, v] of Object.entries(r.gear as Record<string, unknown>).slice(0, 8)) if (/^\w{1,12}$/.test(slot) && id(v)) gear[slot] = id(v);
  }
  const replace: Record<string, string> = {};
  if (r.replace && typeof r.replace === 'object') {
    for (const [t, v] of Object.entries(r.replace as Record<string, unknown>).slice(0, 5)) if (id(t) && id(v)) replace[t] = id(v);
  }
  return { spec: id(r.spec), talents, gear, ...(Object.keys(replace).length ? { replace } : {}) };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validate untrusted input. Returns null for anything malformed. */
export function parseClientMsg(raw: string): ClientMsg | null {
  let m: any;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  switch (m.t) {
    case 'join':
      if (typeof m.name !== 'string' || typeof m.classId !== 'string' || !Object.hasOwn(CLASSES, m.classId) || (m.mode !== 'practice' && m.mode !== 'queue' && m.mode !== 'duel' && m.mode !== 'party')) return null;
    {
      const validClass = (c: unknown): c is ClassId => typeof c === 'string' && Object.hasOwn(CLASSES, c);
      const foes = Array.isArray(m.foes) ? (m.foes.filter(validClass).slice(0, 3) as ClassId[]) : undefined;
      const allies = Array.isArray(m.allies) ? (m.allies.filter(validClass).slice(0, 2) as ClassId[]) : undefined;
      return {
        t: 'join',
        name: m.name.replace(/[^\w \-.]/g, '').trim().slice(0, 16) || 'Player',
        classId: m.classId,
        mode: m.mode,
        duelWith: typeof m.duelWith === 'string' && NAME_RE.test(m.duelWith) ? m.duelWith : undefined,
        size: m.size === 1 || m.size === 2 || m.size === 3 ? m.size : undefined,
        foes: foes && foes.length ? foes : undefined,
        allies,
        ally: m.ally === undefined ? undefined : validClass(m.ally) ? m.ally : null,
        difficulty: DIFFICULTIES.includes(m.difficulty) ? m.difficulty : undefined,
        build: parseBuild(m.build),
        map: typeof m.map === 'string' && (m.map === 'random' || ARENAS.some((a) => a.id === m.map)) ? m.map : undefined,
        profile: typeof m.profile === 'string' && m.profile.length <= 400 ? m.profile : undefined,
      };
    }
    case 'ready': {
      if (typeof m.name !== 'string' || typeof m.classId !== 'string' || !Object.hasOwn(CLASSES, m.classId)) return null;
      return {
        t: 'ready',
        on: !!m.on,
        name: m.name.replace(/[^\w \-.]/g, '').trim().slice(0, 16) || 'Player',
        classId: m.classId as ClassId,
        build: parseBuild(m.build),
        profile: typeof m.profile === 'string' && m.profile.length <= 400 ? m.profile : undefined,
      };
    }
    case 'input':
      if (!isNum(m.seq) || !isNum(m.fwd) || !isNum(m.strafe) || !isNum(m.facing)) return null;
      return { t: 'input', seq: m.seq | 0, fwd: m.fwd, strafe: m.strafe, facing: m.facing, jump: m.jump === true ? true : undefined };
    case 'ping':
      if (!isNum(m.n) || Math.abs(m.n) > 1e12) return null;
      return { t: 'ping', n: m.n };
    case 'target':
      if (m.id !== null && !isNum(m.id)) return null;
      return { t: 'target', id: m.id };
    case 'cast':
      if (typeof m.ability !== 'string' || m.ability.length > 40) return null;
      if (m.target !== undefined && m.target !== null && !isNum(m.target)) return null;
      const gx = typeof m.x === 'number' && Number.isFinite(m.x) && Math.abs(m.x) < 1000 ? m.x : undefined;
      const gz = typeof m.z === 'number' && Number.isFinite(m.z) && Math.abs(m.z) < 1000 ? m.z : undefined;
      return { t: 'cast', ability: m.ability, target: m.target ?? null, ...(gx !== undefined && gz !== undefined ? { x: gx, z: gz, ...(m.lv === 1 ? { lv: 1 as const } : {}) } : {}), ...(typeof m.vt === 'number' && Number.isFinite(m.vt) ? { vt: m.vt } : {}) };
    case 'auto':
      return { t: 'auto', on: !!m.on };
    case 'autoOff':
      return { t: 'autoOff', off: !!m.off };
    case 'mark':
      if (!Number.isInteger(m.unit) || !Number.isInteger(m.mark) || (m.mark as number) < 0 || (m.mark as number) > MARKS.length) return null;
      return { t: 'mark', unit: m.unit as number, mark: m.mark as number };
    case 'leave':
      return { t: 'leave' };
    case 'register':
    case 'login':
      if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) return null;
      if (typeof m.password !== 'string' || m.password.length < PASSWORD_MIN || m.password.length > PASSWORD_MAX) return null;
      if (m.t === 'register') return { t: 'register', name: m.name, password: m.password, ownerCode: typeof m.ownerCode === 'string' ? m.ownerCode.slice(0, 80) : undefined };
      return { t: 'login', name: m.name, password: m.password };
    case 'resume':
      if (typeof m.token !== 'string' || m.token.length < 10 || m.token.length > 80) return null;
      return { t: 'resume', token: m.token };
    case 'logout':
      return { t: 'logout' };
    case 'customize': {
      const c = m.cosmetics;
      const str = (v: unknown) => (typeof v === 'string' && v.length <= 24 ? v : null);
      if (!c || typeof c !== 'object') return null;
      const title = str(c.title);
      const emblem = str(c.emblem);
      const color = str(c.color);
      if (title === null || !emblem || !color) return null;
      const cosmetics: Cosmetics = { title, emblem, color };
      if (c.custom !== undefined) {
        const custom = cleanCustom(c.custom);
        if (!custom) return null;
        cosmetics.custom = custom;
      }
      if (c.useCustom) cosmetics.useCustom = true;
      return { t: 'customize', cosmetics };
    }
    case 'owner_unlock':
      if (typeof m.code !== 'string' || !m.code || m.code.length > 80) return null;
      return { t: 'owner_unlock', code: m.code };
    case 'admin_list':
      return { t: 'admin_list' };
    case 'history':
      return { t: 'history' };
    case 'friends':
      return { t: 'friends' };
    case 'friend':
      if (!['add', 'accept', 'decline', 'remove'].includes(m.op) || typeof m.name !== 'string' || !NAME_RE.test(m.name)) return null;
      return { t: 'friend', op: m.op, name: m.name };
    case 'invite':
      if ((m.kind !== 'party' && m.kind !== 'duel') || typeof m.name !== 'string' || !NAME_RE.test(m.name)) return null;
      return { t: 'invite', kind: m.kind, name: m.name };
    case 'invite_reply':
      if (typeof m.id !== 'string' || !/^[0-9a-f]{8,16}$/.test(m.id)) return null;
      return { t: 'invite_reply', id: m.id, accept: m.accept === true };
    case 'party_leave':
      return { t: 'party_leave' };
    case 'rematch':
      return { t: 'rematch', on: m.on !== false };
    case 'suggest': {
      if (typeof m.text !== 'string') return null;
      const text = m.text.replace(/\s+/g, ' ').trim().slice(0, 600);
      const note = typeof m.note === 'string' ? m.note.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\r\n?/g, '\n').trim().slice(0, NOTE_MAX) : '';
      return text.length >= 5 ? { t: 'suggest', text, ...(note ? { note } : {}) } : null;
    }
    case 'suggestions':
      return { t: 'suggestions' };
    case 'suggest_delete':
      return typeof m.at === 'number' && Number.isFinite(m.at) && typeof m.text === 'string' ? { t: 'suggest_delete', at: m.at, text: m.text.slice(0, 600) } : null;
    case 'party_side':
      return { t: 'party_side', side: m.side === 1 ? 1 : 0 };
    case 'party_look':
      if (typeof m.classId !== 'string' || !Object.hasOwn(CLASSES, m.classId)) return null;
      return { t: 'party_look', classId: m.classId as ClassId, build: parseBuild(m.build) };
    case 'party_kick':
      if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) return null;
      return { t: 'party_kick', name: m.name };
    case 'live':
      return { t: 'live' };
    case 'spectate':
      if (typeof m.id !== 'string' || !/^[0-9a-f]{12,16}$/.test(m.id)) return null;
      return { t: 'spectate', id: m.id };
    case 'dev_pause':
      return { t: 'dev_pause', on: m.on === true };
    case 'dev_patch':
    case 'dev_session':
    case 'dev_save': {
      const patches = parsePatches(m.patches);
      if (!patches) return null;
      if (m.t === 'dev_patch' || m.t === 'dev_session') return { t: m.t, patches };
      const note = typeof m.note === 'string' ? m.note.slice(0, 600) : undefined;
      return { t: 'dev_save', patches, ...(note ? { note } : {}) };
    }
    case 'dev_note':
    case 'dev_ai':
      if (typeof m.ability !== 'string' || !Object.hasOwn(ABILITIES, m.ability) || typeof m.text !== 'string' || !m.text.trim()) return null;
      return { t: m.t, ability: m.ability, text: m.text.trim().slice(0, 600) };
    case 'dev_builds':
      return { t: 'dev_builds' };
    case 'dev_restart':
      return { t: 'dev_restart' };
    case 'dev_map':
      return typeof m.id === 'string' && ARENAS.some((a) => a.id === m.id) ? { t: 'dev_map', id: m.id } : null;
    case 'dev_bot': {
      if (typeof m.unit !== 'number' || !Number.isInteger(m.unit) || !CLASS_IDS.includes(m.classId)) return null;
      const build = parseBuild(m.build);
      if (!build) return null;
      return { t: 'dev_bot', unit: m.unit, classId: m.classId, build };
    }
    case 'admin_overview':
      return { t: 'admin_overview' };
    case 'admin_announce':
      if (typeof m.text !== 'string' || !m.text.trim()) return null;
      return { t: 'admin_announce', text: m.text.trim().slice(0, 200) };
    case 'admin_end':
      if (typeof m.id !== 'string' || !/^[0-9a-f]{12,16}$/.test(m.id)) return null;
      return { t: 'admin_end', id: m.id };
    case 'overrides_clear':
      return { t: 'overrides_clear' };
    case 'admin_proposals': {
      if (!['list', 'live', 'pr', 'dismiss'].includes(m.op)) return null;
      const ids = Array.isArray(m.ids) ? m.ids.filter((x: unknown): x is string => typeof x === 'string' && /^[0-9a-z]{4,20}$/.test(x)).slice(0, 100) : undefined;
      const note = typeof m.note === 'string' ? m.note.trim().slice(0, 600) : '';
      return { t: 'admin_proposals', op: m.op, ...(ids ? { ids } : {}), ...(note ? { note } : {}) };
    }
    case 'overrides_pr': {
      const note = typeof m.note === 'string' ? m.note.trim().slice(0, 600) : '';
      return { t: 'overrides_pr', ...(note ? { note } : {}) };
    }
    case 'admin_act': {
      if (!ADMIN_ACTS.includes(m.act)) return null;
      const out: Extract<ClientMsg, { t: 'admin_act' }> = { t: 'admin_act', act: m.act };
      if (m.name !== undefined) {
        if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) return null;
        out.name = m.name;
      }
      if (m.minutes !== undefined) {
        if (typeof m.minutes !== 'number' || !Number.isFinite(m.minutes) || m.minutes < 0 || m.minutes > 60 * 24 * 3650) return null;
        out.minutes = m.minutes;
      }
      if (m.value !== undefined) {
        if (typeof m.value !== 'number' || !Number.isFinite(m.value)) return null;
        out.value = m.value;
      }
      if (typeof m.reason === 'string') out.reason = m.reason.slice(0, 200);
      if (typeof m.text === 'string') out.text = m.text.slice(0, 1000);
      if (m.id !== undefined) {
        if (typeof m.id !== 'string' || !/^[0-9a-f]{12,16}$/.test(m.id)) return null;
        out.id = m.id;
      }
      if (m.on !== undefined) out.on = m.on === true;
      // the acts on a player need a name, the ones on a match an id
      if (['kick', 'ban', 'unban', 'mute', 'unmute', 'set_rating', 'reset_stats', 'note', 'history', 'kill'].includes(out.act) && !out.name) return null;
      if ((out.act === 'pause_match' || out.act === 'train') && !out.id) return null;
      return out;
    }
    case 'follow':
      if (m.name === null) return { t: 'follow', name: null };
      if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) return null;
      return { t: 'follow', name: m.name };
    case 'bot_match': {
      const size = m.size === 1 || m.size === 2 || m.size === 3 ? (m.size as TeamSize) : null;
      if (!size || !Array.isArray(m.teams) || m.teams.length !== 2) return null;
      const side = (raw: unknown): BotPick[] | null => {
        if (!Array.isArray(raw) || raw.length !== size) return null;
        const out: BotPick[] = [];
        for (const b of raw) {
          if (!b || typeof b !== 'object' || typeof b.classId !== 'string' || !Object.hasOwn(CLASSES, b.classId)) return null;
          if (b.spec !== undefined && (typeof b.spec !== 'string' || !SPECS[b.classId as ClassId].some((s) => s.id === b.spec))) return null;
          out.push({ classId: b.classId as ClassId, ...(b.spec ? { spec: b.spec } : {}) });
        }
        return out;
      };
      const a = side(m.teams[0]);
      const b = side(m.teams[1]);
      const difficulty = m.difficulty === 'easy' || m.difficulty === 'normal' || m.difficulty === 'hard' ? m.difficulty : null;
      if (!a || !b || !difficulty || typeof m.map !== 'string' || !(m.map === 'random' || ARENAS.some((x) => x.id === m.map))) return null;
      return { t: 'bot_match', size, teams: [a, b], difficulty, map: m.map };
    }
    case 'admin_set': {
      if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) return null;
      const out: Extract<ClientMsg, { t: 'admin_set' }> = { t: 'admin_set', name: m.name };
      if (m.grants !== undefined) {
        if (!Array.isArray(m.grants) || m.grants.length > 80 || !m.grants.every((g: unknown) => typeof g === 'string' && /^[a-z]{3,8}(:[a-z0-9_]{2,16})?$/.test(g))) return null;
        out.grants = [...new Set(m.grants as string[])];
      }
      if (m.custom === null) out.custom = null;
      else if (m.custom !== undefined) {
        const custom = cleanCustom(m.custom);
        if (!custom) return null;
        out.custom = custom;
      }
      if (m.useCustom !== undefined) out.useCustom = !!m.useCustom;
      if (m.resetPassword) out.resetPassword = true;
      return out;
    }
    case 'save_settings':
      if (typeof m.data !== 'string' || m.data.length > MAX_SETTINGS) return null;
      return { t: 'save_settings', data: m.data };
    case 'leaderboard':
      return { t: 'leaderboard' };
    default:
      return null;
  }
}
