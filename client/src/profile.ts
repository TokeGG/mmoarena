import { SPECS, cleanGear, emptyBuild, talentsFor, validateBuild } from '@arena/shared';
import type { Build, ClassId } from '@arena/shared';

/** Client-side progress and saved builds. The server re-validates everything; this just remembers the player's picks. */

/** Set from the signed-in account: owner-only cosmetics are kept only for the owner. */
export const flags = { owner: false };

export const progress = { token: '', matches: 0, wins: 0 };

const PROFILE_KEY = 'arena.profile.v1';
const buildKey = (c: ClassId) => `arena.build.v1.${c}`;

export function loadProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) Object.assign(progress, JSON.parse(raw));
  } catch {
    /* storage unavailable: start fresh */
  }
}

/** Signed in: the account is the source of truth, kept in memory only (never written over the guest save). */
export function applyAccountProgress(matches: number, wins: number) {
  progress.token = '';
  progress.matches = matches;
  progress.wins = wins;
}

/** Signed out: go back to this browser's guest progress. */
export function restoreGuestProgress() {
  Object.assign(progress, { token: '', matches: 0, wins: 0 });
  loadProfile();
}

export function saveProfile(token: string, matches: number, wins: number) {
  progress.token = token;
  progress.matches = matches;
  progress.wins = wins;
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(progress));
  } catch {
    /* ignore */
  }
}

/** Drop anything unknown (talents, removed cosmetics) so a stale save can never get a join rejected. */
export function sanitize(classId: ClassId, b: Build): Build {
  const spec = SPECS[classId].some((s) => s.id === b.spec) ? b.spec : SPECS[classId][0].id;
  const tiers = talentsFor(classId, spec);
  const talents = tiers.map((tier, i) => (tier.some((t) => t.id === b.talents[i]) ? b.talents[i] : ''));
  const gear = cleanGear(b.gear, flags.owner, progress.matches);
  // which skill a tier 5 pick replaces, where the talent lets the player choose
  const replace: Record<string, string> = {};
  for (const [id, from] of Object.entries(b.replace ?? {})) {
    const t = tiers.flat().find((x) => x.id === id);
    if (t?.swap && talents.includes(id) && (from === t.swap.from || t.swap.alt?.includes(from))) replace[id] = from;
  }
  return { spec, talents, gear, ...(Object.keys(replace).length ? { replace } : {}) };
}

export function defaultBuild(classId: ClassId): Build {
  return { ...emptyBuild(classId), talents: talentsFor(classId, emptyBuild(classId).spec).map(() => ''), gear: {} };
}

export function loadBuild(classId: ClassId): Build {
  try {
    const raw = localStorage.getItem(buildKey(classId));
    if (raw) {
      const b = sanitize(classId, JSON.parse(raw) as Build);
      if (validateBuild(classId, b, flags.owner, progress.matches).ok) return b;
    }
  } catch {
    /* fall through */
  }
  return defaultBuild(classId);
}

export function saveBuild(classId: ClassId, b: Build) {
  try {
    localStorage.setItem(buildKey(classId), JSON.stringify(b));
  } catch {
    /* ignore */
  }
}

const talentKey = (c: ClassId, spec: string) => `arena.talents.v1.${c}.${spec}`;

/** Remember the talent picks of one spec, so switching spec (or class) and back brings them back. */
export function saveSpecTalents(classId: ClassId, spec: string, talents: string[]) {
  try {
    localStorage.setItem(talentKey(classId, spec), JSON.stringify(talents));
  } catch {
    /* ignore */
  }
}

/** The picks last made on this spec, cleaned against the current talent list (null when there are none). */
export function loadSpecTalents(classId: ClassId, spec: string): string[] | null {
  try {
    const raw = localStorage.getItem(talentKey(classId, spec));
    const v = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(v)) return null;
    return talentsFor(classId, spec).map((tier, i) => (tier.some((t) => t.id === v[i]) ? v[i] : ''));
  } catch {
    return null;
  }
}
