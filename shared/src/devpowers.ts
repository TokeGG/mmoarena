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
  // everything else the owner has: all off until given
  { id: 'players', label: 'Players tab: see accounts and edit them', hint: 'The player list, account changes, password resets, custom styles. Never tags and powers, and never the owner or other devs', on: false },
  { id: 'moderate', label: 'Moderation: kick, ban, mute, notes, kill', hint: 'Kick, ban and unban, mute and unmute, account notes, and killing players from inside a match', on: false },
  { id: 'ratings', label: 'Change ratings and reset stats', hint: 'Set a rating, reset someone\'s stats', on: false },
  { id: 'matchctl', label: 'Control other people\'s matches', hint: 'Pause or end matches, the cooldown switches, and the play-time statistics', on: false },
  { id: 'botadmin', label: 'Bot brain tools', hint: 'Reset the learned brain, commit learned bots to GitHub, the train-on-every-match switch and marking bot bugs fixed', on: false },
  { id: 'numberslive', label: 'Make numbers live and pull requests', hint: 'Make test numbers live for everyone at once, open pull requests with them, clear the live numbers', on: false },
  { id: 'requestsadm', label: 'Manage requests', hint: 'Have Claude build a request, merge its pull request, mark or delete requests', on: false },
  { id: 'hudall', label: 'HUD default for everyone', hint: 'Publish a HUD layout as everyone\'s starting layout', on: false },
  { id: 'botnames', label: 'Bot names', hint: 'Edit the names bots play under', on: false },
  { id: 'suggestions', label: 'Delete suggestions', hint: 'Remove entries from the suggestion box', on: false },
  { id: 'takeover', label: 'Take over a bot in a match', hint: 'Secretly play a bot in a live match', on: false },
  { id: 'watchall', label: 'Watch any match, live', hint: 'Watch private matches and ranked matches without the delay, and follow players into them', on: false },
  { id: 'changelog', label: 'The full change log', hint: 'Every commit on the main branch, including what the player notes leave out', on: false },
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
