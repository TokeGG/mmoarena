/**
 * What a dev can do. The dev tag opens the dev tools; the owner then switches single powers off for one person (or on, for the
 * ones that are off to begin with) in the admin panel's Permissions tab. A power is stored on the account as a grant:
 * `deny:<id>` takes away one that is on by default, `power:<id>` adds one that is off by default. The server checks every one.
 */
export interface DevPower { id: string; label: string; hint: string; on: boolean }

export const DEV_POWERS: readonly DevPower[] = [
  { id: 'tuning', label: 'Dev panel in matches', hint: 'Try numbers, pause, restart and change units in their own matches and the bot battles they watch', on: true },
  { id: 'commit', label: 'Commit numbers to the game', hint: 'Save changes for everyone: they land on the main branch and the game updates', on: true },
  { id: 'askclaude', label: 'Ask Claude and requests', hint: 'Ask Claude about skills, send skill notes and requests for code changes', on: true },
  { id: 'botmatch', label: 'Start bot battles', hint: 'Bots against bots, watched live', on: true },
  { id: 'maps', label: 'Maps', hint: 'The map editor, custom maps, and switching maps on or off for players', on: true },
  { id: 'redeploy', label: 'Redeploy the server', hint: 'The Redeploy button', on: true },
  { id: 'maintain', label: 'Announcements and maintenance mode', hint: 'Send announcements to everyone and switch maintenance mode on', on: false },
];

export const DEV_POWER_IDS: readonly string[] = DEV_POWERS.map((p) => p.id);

/** Whether an account with the dev tag has a power (the tag itself is checked by the caller). */
export function hasPower(grants: readonly string[] | undefined, id: string): boolean {
  const def = DEV_POWERS.find((p) => p.id === id);
  if (!def) return false;
  return def.on ? !grants?.includes(`deny:${id}`) : !!grants?.includes(`power:${id}`);
}

/** The grants of an account with one power set (the other grants stay). */
export function withPower(grants: readonly string[], id: string, on: boolean): string[] {
  const def = DEV_POWERS.find((p) => p.id === id);
  if (!def) return [...grants];
  const key = def.on ? `deny:${id}` : `power:${id}`;
  const rest = grants.filter((g) => g !== key);
  // for a power that is on by default, "on" means no deny; for one that is off by default, "on" means a power grant
  return def.on ? (on ? rest : [...rest, key]) : on ? [...rest, key] : rest;
}
