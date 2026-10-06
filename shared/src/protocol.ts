import { CLASSES } from './data';
import type { Build, ClassId, SimEvent, Snapshot, TeamId } from './types';

export const PROTOCOL_VERSION = 3;

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
      /** Spec, talent picks and gear. Validated by the server against the signed profile. */
      build?: Build;
      /** Signed progress token from an earlier `profile` message. */
      profile?: string;
    }
  | { t: 'input'; seq: number; fwd: number; strafe: number; facing: number }
  | { t: 'target'; id: number | null }
  | { t: 'cast'; ability: string; target?: number | null }
  | { t: 'auto'; on: boolean }
  | { t: 'leave' };

export type ServerMsg =
  | { t: 'welcome'; protocol: number; unitId: number; team: TeamId; classId: ClassId; spec: string | null }
  /** Progress (matches played unlock gear tiers). Store `token` and send it back on join. */
  | { t: 'profile'; token: string; matches: number; wins: number }
  | { t: 'queued'; waiting: number; needed: number }
  | { t: 'snapshot'; snap: Snapshot; events: SimEvent[] }
  | { t: 'error'; reason: string; ability?: string }
  | { t: 'closed'; reason: string };

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
        profile: typeof m.profile === 'string' && m.profile.length <= 400 ? m.profile : undefined,
      };
    }
    case 'input':
      if (!isNum(m.seq) || !isNum(m.fwd) || !isNum(m.strafe) || !isNum(m.facing)) return null;
      return { t: 'input', seq: m.seq | 0, fwd: m.fwd, strafe: m.strafe, facing: m.facing };
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
    default:
      return null;
  }
}
