import { ARENAS, CLASSES } from './data';
import { NAME_RE, PASSWORD_MAX, PASSWORD_MIN, cleanCustom } from './accounts';
import type { AccountInfo, AdminRow, Cosmetics, CustomStyle, FriendRow, LeaderRow, LiveMatch, MatchRecord, PartyInfo, RosterEntry } from './accounts';
import type { Build, ClassId, SimEvent, Snapshot, TeamId } from './types';

export const PROTOCOL_VERSION = 8;

/** Team sizes: 1v1, 2v2, 3v3. */
export type TeamSize = 1 | 2 | 3;
export const TEAM_SIZES: TeamSize[] = [1, 2, 3];

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
  | { t: 'cast'; ability: string; target?: number | null; /** Ground-targeted spells: the point under the cursor. */ x?: number; z?: number; /** Sim time of the frame the player was looking at, so the server can judge range against what they saw. */ vt?: number }
  | { t: 'auto'; on: boolean }
  /** The auto-attack setting: `off` stops it from ever starting. */
  | { t: 'autoOff'; off: boolean }
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
  /** Friends: your list and requests. */
  | { t: 'friends' }
  | { t: 'friend'; op: 'add' | 'accept' | 'decline' | 'remove'; name: string }
  /** Ask a friend into your party (queue together) or to a 1v1 duel. */
  | { t: 'invite'; kind: 'party' | 'duel'; name: string }
  | { t: 'invite_reply'; id: string; accept: boolean }
  | { t: 'party_leave' }
  /** Pick which side you play on in a party match. */
  | { t: 'party_side'; side: 0 | 1 }
  /** Party members other than the leader: mark yourself ready (with your current class and build) or not. */
  | { t: 'ready'; on: boolean; name: string; classId: ClassId; build?: Build; profile?: string }
  | { t: 'party_kick'; name: string }
  /** Owner only. Any field left out is unchanged; `custom: null` removes a custom style. */
  | { t: 'admin_set'; name: string; grants?: string[]; custom?: CustomStyle | null; useCustom?: boolean; resetPassword?: boolean };

export const MAX_SETTINGS = 24000;

export type ServerMsg =
  | { t: 'welcome'; protocol: number; unitId: number; team: TeamId; classId: ClassId; spec: string | null; bar?: string[]; map: string }
  /** Progress (matches played). Store `token` and send it back on join. */
  | { t: 'profile'; token: string; matches: number; wins: number }
  | { t: 'queued'; waiting: number; needed: number }
  | { t: 'snapshot'; snap: Snapshot; events: SimEvent[] }
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
  /** Your party is not in the queue yet: `ready` of `total` members have pressed play. */
  | { t: 'party_wait'; ready: number; total: number }
  /** A duel was agreed: send a join with mode 'duel' and `duelWith`. */
  | { t: 'duel_go'; with: string }
  /** A short message to show the player. */
  | { t: 'notice'; text: string }
  | { t: 'live'; rows: LiveMatch[] }
  /** You are now watching a match (snapshots follow, about 5 s behind). */
  | { t: 'spectating'; id: string; map: string; size: number }
  | { t: 'admin_accounts'; rows: AdminRow[] }
  /** Result of an admin_set; `tempPassword` is shown once when a password was reset. */
  | { t: 'admin_result'; ok: boolean; name: string; reason?: string; row?: AdminRow; tempPassword?: string };

/** Keep only a well-formed build: strings of sane length, at most 3 talent tiers and one id per gear slot. */
export function parseBuild(raw: unknown): Build | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === 'string' && /^[\w.]{1,40}$/.test(v) ? v : '');
  if (!id(r.spec)) return undefined;
  const talents = Array.isArray(r.talents) ? r.talents.slice(0, 8).map(id) : [];
  const gear: Record<string, string> = {};
  if (r.gear && typeof r.gear === 'object') {
    for (const [slot, v] of Object.entries(r.gear as Record<string, unknown>).slice(0, 8)) if (/^\w{1,12}$/.test(slot) && id(v)) gear[slot] = id(v);
  }
  return { spec: id(r.spec), talents, gear };
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
    case 'target':
      if (m.id !== null && !isNum(m.id)) return null;
      return { t: 'target', id: m.id };
    case 'cast':
      if (typeof m.ability !== 'string' || m.ability.length > 40) return null;
      if (m.target !== undefined && m.target !== null && !isNum(m.target)) return null;
      const gx = typeof m.x === 'number' && Number.isFinite(m.x) && Math.abs(m.x) < 1000 ? m.x : undefined;
      const gz = typeof m.z === 'number' && Number.isFinite(m.z) && Math.abs(m.z) < 1000 ? m.z : undefined;
      return { t: 'cast', ability: m.ability, target: m.target ?? null, ...(gx !== undefined && gz !== undefined ? { x: gx, z: gz } : {}), ...(typeof m.vt === 'number' && Number.isFinite(m.vt) ? { vt: m.vt } : {}) };
    case 'auto':
      return { t: 'auto', on: !!m.on };
    case 'autoOff':
      return { t: 'autoOff', off: !!m.off };
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
    case 'party_side':
      return { t: 'party_side', side: m.side === 1 ? 1 : 0 };
    case 'party_kick':
      if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) return null;
      return { t: 'party_kick', name: m.name };
    case 'live':
      return { t: 'live' };
    case 'spectate':
      if (typeof m.id !== 'string' || !/^[0-9a-f]{12,16}$/.test(m.id)) return null;
      return { t: 'spectate', id: m.id };
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
