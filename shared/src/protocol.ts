import { ARENAS, CLASSES } from './data';
import { NAME_RE, PASSWORD_MAX, PASSWORD_MIN } from './accounts';
import type { AccountInfo, Cosmetics, LeaderRow, RosterEntry } from './accounts';
import type { Build, ClassId, SimEvent, Snapshot, TeamId } from './types';

export const PROTOCOL_VERSION = 5;

export type PracticeDifficulty = 'dummy' | 'easy' | 'normal' | 'hard';
const DIFFICULTIES: PracticeDifficulty[] = ['dummy', 'easy', 'normal', 'hard'];

/** Client -> server. The client only ever sends intents; the server decides outcomes. */
export type ClientMsg =
  | {
      t: 'join';
      name: string;
      classId: ClassId;
      mode: 'practice' | 'queue';
      /** Practice only: enemy classes (1-2), an optional ally bot, and how they behave. */
      foes?: ClassId[];
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
  | { t: 'cast'; ability: string; target?: number | null }
  | { t: 'auto'; on: boolean }
  | { t: 'leave' }
  /** Accounts. Password-based; a successful register/login returns a session token for `resume`. */
  | { t: 'register'; name: string; password: string; ownerCode?: string }
  | { t: 'login'; name: string; password: string }
  | { t: 'resume'; token: string }
  | { t: 'logout' }
  | { t: 'customize'; cosmetics: Cosmetics }
  /** Replace the account's saved settings (HUD, keybinds, builds...) with this JSON snapshot. */
  | { t: 'save_settings'; data: string }
  /** Throw away a loot item. */
  | { t: 'discard'; id: string }
  | { t: 'leaderboard' };

export const MAX_SETTINGS = 24000;

export type ServerMsg =
  | { t: 'welcome'; protocol: number; unitId: number; team: TeamId; classId: ClassId; spec: string | null; map: string }
  /** Progress (matches played unlock gear tiers). Store `token` and send it back on join. */
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
  /** Loot earned from the match that just finished; `discarded` are items pushed out of a full inventory. */
  | { t: 'loot'; drops: string[]; discarded: string[] }
  /** Cosmetics of the signed-in players in your match, by unit id. */
  | { t: 'roster'; players: RosterEntry[] };

/** Keep only a well-formed build: strings of sane length, at most 3 talent tiers and one id per gear slot. */
export function parseBuild(raw: unknown): Build | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === 'string' && /^[\w.]{1,40}$/.test(v) ? v : '');
  if (!id(r.spec)) return undefined;
  const talents = Array.isArray(r.talents) ? r.talents.slice(0, 3).map(id) : [];
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
      if (typeof m.name !== 'string' || typeof m.classId !== 'string' || !Object.hasOwn(CLASSES, m.classId) || (m.mode !== 'practice' && m.mode !== 'queue')) return null;
    {
      const validClass = (c: unknown): c is ClassId => typeof c === 'string' && Object.hasOwn(CLASSES, c);
      const foes = Array.isArray(m.foes) ? (m.foes.filter(validClass).slice(0, 2) as ClassId[]) : undefined;
      return {
        t: 'join',
        name: m.name.replace(/[^\w \-.]/g, '').trim().slice(0, 16) || 'Player',
        classId: m.classId,
        mode: m.mode,
        foes: foes && foes.length ? foes : undefined,
        ally: m.ally === undefined ? undefined : validClass(m.ally) ? m.ally : null,
        difficulty: DIFFICULTIES.includes(m.difficulty) ? m.difficulty : undefined,
        build: parseBuild(m.build),
        map: typeof m.map === 'string' && (m.map === 'random' || ARENAS.some((a) => a.id === m.map)) ? m.map : undefined,
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
      return { t: 'cast', ability: m.ability, target: m.target ?? null };
    case 'auto':
      return { t: 'auto', on: !!m.on };
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
      return { t: 'customize', cosmetics: { title, emblem, color } };
    }
    case 'discard':
      if (typeof m.id !== 'string' || !/^L\.[a-z]{3,12}\.[a-z]{3,12}\.[a-z0-9]{4,8}$/.test(m.id)) return null;
      return { t: 'discard', id: m.id };
    case 'save_settings':
      if (typeof m.data !== 'string' || m.data.length > MAX_SETTINGS) return null;
      return { t: 'save_settings', data: m.data };
    case 'leaderboard':
      return { t: 'leaderboard' };
    default:
      return null;
  }
}
