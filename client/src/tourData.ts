/**
 * The words of the guided tours, as data: a list of steps per tour. Each step says which part of the screen it lights
 * (a CSS selector; `data-tour="..."` marks the parts of the Dev tools and admin panel that have no stable class), a title
 * and one or two plain sentences. Every sentence here describes what the game really does; when a button is renamed, change
 * it here too. The engine is in `tour.ts`.
 */
import type { TourDef, TourId, TourStep } from './tourLogic';

/** The first visible element that matches (a step that lights one row of many). */
const first = (sel: string) => () => {
  for (const e of document.querySelectorAll(sel)) {
    const b = e.getBoundingClientRect();
    if (b.width > 0 && b.height > 0) return e;
  }
  return null;
};

/** The button of the main menu's header row with this icon. */
const hdr = (icon: string) => `.hdr-btn[data-icon="${icon}"]`;
const sec = (s: 'values' | 'match' | 'ask', page?: string, extra: { drawer?: boolean; setups?: boolean } = {}): TourStep['onEnter'] => (h) => h.devShow({ section: s, ...(page ? { page } : {}), drawer: false, ...extra });
const adminTab = (tab: string, title: string, text: string, optional = false): TourStep => ({ title, text, target: `.admp [data-tour="admin-tab-${tab}"]`, optional });

// ------------------------------------------------------------------ Dev tools window

const devtools: TourDef = {
  id: 'devtools',
  name: 'Dev tools',
  blurb: 'The window for changing numbers and trying them (the 🛠 button or F2).',
  group: 'dev',
  needs: 'any',
  mode: 'modal',
  onEnd: (h) => h.devShow({ section: 'values', drawer: false }),
  steps: [
    { title: 'Dev tools', text: 'This window changes the numbers of the game (damage, cooldowns, health and more) so you can try them. Nothing you type here changes the real game until it is saved and committed.', target: '.devp', onEnter: sec('values', 'skills'), wait: true },
    { title: 'Three sections', text: 'Edit values is where you change numbers. Match tools has the restart, the damage meter and saved setups. Ask Claude is a chat about the skill you have open.', target: '.devp [data-tour="dev-sections"]' },
    { title: 'Who', text: 'The row of pages reads left to right. First, Who: Classes, Specs and Talents say what each class, spec and talent is.', target: '.devp [data-tour="dev-page-classes"], .devp [data-tour="dev-page-specs"], .devp [data-tour="dev-page-talents"]', onEnter: sec('values', 'classes') },
    { title: 'What they do', text: 'Then what they do: Skills are the buttons, Passives are what a spec or talent gives without a button, and Buffs & debuffs are the icons on a unit.', target: '.devp [data-tour="dev-page-skills"], .devp [data-tour="dev-page-passives"], .devp [data-tour="dev-page-auras"]', onEnter: sec('values', 'skills') },
    { title: 'Rules', text: 'Last, Rules: Game options hold the rules of every match, like cooldown rules, speeds, dampening and match length.', target: '.devp [data-tour="dev-page-options"]', onEnter: sec('values', 'options') },
    { title: 'Search', text: 'Type part of a name to cut the list on the left and the values on the right down to what matches. "Reset this page" puts every value on the page back.', target: '.devp [data-tour="dev-search"]', onEnter: sec('values', 'skills') },
    { title: 'The list', text: 'Pick something on the left to see its numbers on the right. Click the name of a group to open or close it.', target: '.devp [data-tour="dev-nav"]' },
    { title: 'Fold-out groups', text: 'Numbers are grouped in fold-outs on the right. Click a group\'s name to open or close it. A group with a changed number stays open.', target: first('.devp .devp-detail .devp-sec-head'), onEnter: sec('values', 'classes'), wait: true },
    { title: 'Type a number', text: 'Click a number and type a new one. The old value shows next to it, and the small arrow puts it back. Nothing is sent anywhere yet.', target: first('.devp .devp-detail .devp-field input'), wait: true },
    { title: 'Try it, or keep it', text: 'Try in this match (only inside a match) makes everyone in that match play on your numbers at once. Keep for my session does the same in every match you start, until you clear it or sign out.', target: '.devp [data-tour="dev-try"], .devp [data-tour="dev-keep"]' },
    { title: 'Send to the admin panel', text: 'Sends your changes, with the old and new numbers, to the Proposals tab of the admin panel. Nothing goes live until someone there acts on it, and committing to GitHub happens there.', target: '.devp [data-tour="dev-send"]' },
    { title: 'Redeploy and put back', text: 'Redeploy Render starts a deploy of the latest commit, and everyone online is disconnected for a moment. Put all back forgets what you typed and goes back to the real numbers.', target: '.devp [data-tour="dev-redeploy"], .devp [data-tour="dev-reset"]' },
    { title: 'Changes', text: 'Changes opens a list of every number you changed, old to new, with an Undo for each. It also shows the numbers kept for your session and your recent commits.', target: '.devp [data-tour="dev-drawer"]', onEnter: (h) => h.devShow({ section: 'values', drawer: true }), wait: true },
    { title: 'Match tools', text: 'Restart match, the damage and healing Meter and the map swap only show inside a match. Setups saves a named set of numbers and builds you can load again later.', target: '.devp .devp-matchtab .tools', onEnter: sec('match') },
    { title: 'Change builds', text: 'Inside a match, "Change my build and the bots\'" lets you swap the class, spec and talents of yourself or any bot, then Apply.', target: first('.devp .bots'), onEnter: sec('match') },
    { title: 'Ask Claude', text: 'Say in plain words how a skill or class should be. Claude answers, asks if something is unclear, and suggests number changes you can try. Anything that needs new code becomes a request for the owner.', target: '.devp .devp-asktab', onEnter: sec('ask') },
    { title: 'That is it', text: 'You can replay this tour any time from the "? Tours" button at the top of the admin panel.', onEnter: sec('values') },
  ],
};

// ------------------------------------------------------------------ the admin panel's Tuning tab

const tuning: TourDef = {
  id: 'tuning',
  name: 'Tuning tab',
  blurb: 'The skill designer in the admin panel.',
  group: 'dev',
  needs: 'any',
  mode: 'modal',
  steps: [
    { title: 'Tuning', text: 'The skill designer: the same pages as the Dev tools. Here no match is running, so your changes become proposals instead.', target: '.admp .admp-designer', wait: true },
    { title: 'Pages', text: 'Read the row left to right: Who (Classes, Specs, Talents), what they do (Skills, Passives, Buffs & debuffs) and the Rules (Game options).', target: '.admp [data-tour="dev-pages"]' },
    { title: 'Search and list', text: 'Search cuts the list down. Pick something on the left to see its numbers on the right, in fold-out groups.', target: '.admp [data-tour="dev-search"], .admp [data-tour="dev-nav"], .admp [data-tour="dev-detail"]' },
    { title: 'Type a number', text: 'Click a number and type a new one. The old value shows next to it and the small arrow puts it back.', target: first('.admp .devp-detail .devp-field input') },
    { title: 'Add to proposals', text: 'Add my edits to proposals puts what you typed on the Proposals tab, with the old and new numbers, ready to commit to GitHub.', target: '.admp [data-tour="admin-add"]' },
    { title: 'Ask Claude', text: 'The chat suggests number changes for the skill or class you have open. Its answers can be added to the proposals too.', target: '.admp .admp-chatholder' },
    { title: 'Proposals', text: 'Everything devs sent lands on the Proposals tab. Tick some there and commit them to GitHub.', target: '.admp [data-tour="admin-tab-proposals"]' },
    { title: 'Server setup', text: 'These lines say whether the server is set up for pull requests, skill notes and Ask Claude. A warning tells you what to set.', target: first('.admp .admp-env') },
  ],
};

// ------------------------------------------------------------------ the admin panel

const admin: TourDef = {
  id: 'admin',
  name: 'Admin panel',
  blurb: 'What each tab of the admin panel is for.',
  group: 'admin',
  needs: 'any',
  mode: 'modal',
  steps: [
    { title: 'Admin panel', text: 'This is where the server is run. The tabs along the top split it up. A dev sees fewer tabs than the owner.', target: '.admp .admp-card' },
    { title: 'Tabs', text: 'Click a tab to switch. A number in brackets means something is waiting for you.', target: '.admp [data-tour="admin-tabs"]' },
    adminTab('dashboard', 'Dashboard', 'The server at a glance: how many are online, in the queue and in matches, how long it has been up, and the latest admin actions.'),
    adminTab('players', 'Players', 'Search every account. Click one for kick, ban and mute, rating and stats, unlocks, the dev tag, a private note and their recent matches.', true),
    adminTab('time', 'Play time', 'How long each signed-in account spends on the server, counted by the server.', true),
    adminTab('matches', 'Live matches', 'Every match running now. You can watch the ones open for watching. The owner can also pause and end them.'),
    adminTab('replays', 'Replays', 'Every match played on the server, each with its replay to watch. The owner can also train the bots on them.'),
    adminTab('moderation', 'Moderation', 'The suggestion box and the skill notes people sent in.'),
    adminTab('proposals', 'Proposals', 'Number changes sent from the Dev tools. Tick the ones you want, then commit them to GitHub.'),
    adminTab('tuning', 'Tuning', 'The skill designer, and the numbers that are live for everyone right now.'),
    adminTab('requests', 'Requests', 'Things devs asked Claude for that need a code change, written so they can be handed to a coding session.', true),
    adminTab('server', 'Server', 'Send an announcement to everyone online, turn maintenance mode on or off, and replay the guided tours.', true),
    adminTab('log', 'Log', 'Every admin action: who did what, and when.'),
    { title: 'Tours', text: 'The "? Tours" button replays this tour and the others.', target: '.admp [data-tour="admin-tours"]' },
  ],
};

// ------------------------------------------------------------------ players: the main menu

const menu: TourDef = {
  id: 'menu',
  name: 'Main menu',
  blurb: 'Classes, game modes, friends, settings.',
  group: 'player',
  needs: 'menu',
  mode: 'modal',
  steps: [
    { title: 'Welcome to ARENA', text: 'A 3D team fight in your browser: 1v1, 2v2 or 3v3 in an arena, against bots or other players. This quick tour shows the menu.' },
    { title: 'Pick a class', text: 'Warrior, Mage, Priest or Rogue. Hover one to see what it plays like.', target: '.mm-classes' },
    { title: 'Pick a spec', text: 'Each class has three specs that change the skills you get. Hover a spec to see them.', target: '.mm-specs' },
    { title: 'Talents', text: 'Pick one talent in each tier to tune your build. The next tour goes through them.', target: '.mm-talents' },
    { title: 'Look', text: 'Gear, your name and title, cursor, nameplates and HUD. Looks never change how you fight, and more unlock as you play.', target: '.mm-lookcard' },
    { title: 'Team size', text: 'Choose 1v1, 2v2 or 3v3.', target: '.mm-seg' },
    { title: 'Ways to play', text: 'Practice is a private match against bots; the arena and bot skill are set above it. The next button queues you against other players: with an account it is Ranked and changes your rating, as a guest it is Find match.', target: '#join .mm-actions' },
    { title: 'Friends and party', text: 'Add friends, see who is online, invite them to a party of up to six, or challenge one to an unranked 1v1 duel.', target: hdr('friends') },
    { title: 'Watch live', text: 'Watch any match in progress, a few seconds behind. Your own past matches have replays under Profile.', target: hdr('watch') },
    { title: 'Profile', text: 'Sign in or register to keep your rating, unlocks, settings and match history on any device. Guests can play without ranking.', target: hdr('profile') },
    { title: 'Patch notes', text: 'What changed in each update. A number on the icon means there is news you have not read.', target: hdr('patches') },
    { title: 'Settings', text: { desktop: 'Press Esc for sound, graphics, controls and the HUD editor.', touch: 'Tap the cog for sound and graphics.' }, target: `${hdr('settings')}, .mm-esc` },
    { title: 'Need this again?', text: 'Help & tours replays this and the other tours any time.', target: '.mm-esc .tour-help-link, .mm-esc' },
  ],
};

// ------------------------------------------------------------------ players: your build

/** Hover the picked spec so its card (the skills, in bar order) opens. */
const showSpecCard = () => {
  if (document.querySelector('.mm-specpop:not(.hidden)')) return;
  document.querySelector('.mm-spec.sel')?.dispatchEvent(new MouseEvent('mouseenter'));
};
const tier = (...n: number[]) => n.map((i) => `.mm-talents > :nth-child(${i})`).join(', ');

const build: TourDef = {
  id: 'build',
  name: 'Your build',
  blurb: 'Class, spec, talents, trinket and the order of your skills.',
  group: 'player',
  needs: 'menu',
  mode: 'modal',
  onEnd: () => document.querySelector('.mm-left')?.dispatchEvent(new MouseEvent('mouseleave')),
  steps: [
    { title: 'Class', text: 'The class sets your health, your resource (mana, energy or rage) and how you play.', target: '.mm-classes' },
    { title: 'Spec', text: 'The spec picks your role and your skills. Switching spec keeps your talents for each spec.', target: '.mm-specs' },
    { title: 'Talent tiers', text: 'Talents come in tiers, one pick each. Click a talent to pick it; click it again to clear it.', target: '.mm-talents' },
    { title: 'Tiers I and II', text: 'The first two tiers are class talents, shared by every spec of your class.', target: tier(1, 2) },
    { title: 'Tier III', text: 'The third tier is a talent of your spec.', target: tier(3) },
    { title: 'Tier IV: trinket', text: 'The fourth tier gives a trinket: an extra button beside the action bar.', target: tier(4) },
    { title: 'Tier V: class skill', text: 'The fifth tier gives a class skill that replaces one of your skills. Some let you choose which one.', target: tier(5) },
    { title: 'Order of your skills', text: { desktop: 'Hover your spec to see its skills in action bar order. Drag a skill onto another slot to rearrange them; Reset order puts it back. The number is the key.', touch: 'Open your spec to see its skills in action bar order. Drag a skill onto another slot to rearrange them; Reset order puts it back.' }, target: '.mm-specpop:not(.hidden)', onEnter: showSpecCard, keep: showSpecCard, wait: true },
    { title: 'Saved for you', text: 'Your picks are remembered for each class, and follow your account if you are signed in.' },
  ],
};

// ------------------------------------------------------------------ players: the first match

const hud: TourDef = {
  id: 'hud',
  name: 'Your first match',
  blurb: 'The frames, action bar, cast bar, log and how to move and aim.',
  group: 'player',
  needs: 'match',
  mode: 'hint',
  steps: [
    { title: 'Your first match', text: 'The gates open after a short countdown. This tour points at the screen while you wait. Enter goes on and Esc skips it; every other key still plays.' },
    { title: 'You', text: 'Your health bar and your resource (mana, energy or rage). The buffs and debuffs on you show under it.', target: '#self-frame' },
    { title: 'Your target', text: { desktop: 'Left-click an enemy or press Tab to target one. Their health, cast and effects show here. Right-click an enemy to target it and start auto-attack.', touch: 'Tap an enemy to target it. Their health, cast and effects show here.' }, target: '#target-frame:not(.hidden)' },
    { title: 'Teams', text: { desktop: 'Your allies and the enemies each have a frame. Click a frame to target that player.', touch: 'Your allies and the enemies each have a frame. Tap one to target that player.' }, target: '#party, #enemies' },
    { title: 'Action bar', text: { desktop: 'Your skills. Press the number on a button (1 to 8 by default), or click it. F is the trinket button beside the bar. Drag a button onto another to rearrange them.', touch: 'Your skills. Tap a button to use it.' }, target: '#actionbar' },
    { title: 'Cast bar', text: 'A spell with a cast time fills a bar here. Starting another spell cancels the one you are casting.', target: '#cast:not(.hidden)' },
    { title: 'Auto-attack', text: { desktop: 'Shows whether auto-attack is on. Right-click an enemy or press R to toggle it.', touch: 'Shows whether auto-attack is on.' }, target: '#autoind:not(.hidden)', optional: true },
    { title: 'Combat log', text: 'Damage, healing and effects as they happen.', target: '#log' },
    { title: 'Kill feed', text: 'Who just fell.', target: '#killfeed' },
    { title: 'Moving and aiming', text: { desktop: 'W A S D move and Space jumps. Hold the right mouse button and drag to steer; the left button drags the camera only; the wheel zooms. Esc clears your target, then opens the menu.', touch: 'One finger drags the camera and two pinch to zoom. A tap picks a unit. Walking needs a keyboard, so a phone is best for looking around and targeting.' } },
    { title: 'Make it yours', text: { desktop: 'Esc, then Edit HUD layout, lets you move and resize everything you just saw. Esc, then Controls & keys, changes the keys.', touch: 'The HUD editor and key settings need a mouse and keyboard: open them from a computer.' } },
  ],
};

// ------------------------------------------------------------------ players: watching

const scoresBtn = () => [...document.querySelectorAll<HTMLElement>('.spec-bar button')].find((b) => b.textContent === 'Scores' && b.getBoundingClientRect().width > 0) ?? null;

const watch: TourDef = {
  id: 'watch',
  name: 'Watching a match',
  blurb: 'The watch bar: following players, builds, scores, replays.',
  group: 'player',
  needs: 'watch',
  mode: 'hint',
  steps: [
    { title: 'You are watching', text: 'A live match runs a few seconds behind, so watching cannot help the players. This tour points at the bar; Enter goes on and Esc skips it.', target: '.spec-bar .sb-top' },
    { title: 'Follow a player', text: { desktop: 'The arrows switch whose view you follow. Tab does the same, and so does clicking a player.', touch: 'The arrows switch whose view you follow. A double tap on the scene does the same.' }, target: '.spec-bar .sb-nav' },
    { title: 'Builds', text: 'Everyone\'s talents and skills.', target: '.spec-bar .sb-builds' },
    { title: 'Scores', text: 'Damage and healing per player.', target: scoresBtn, optional: true },
    { title: 'Replay controls', text: 'Pause, change the speed and drag the bar to jump around.', target: '.spec-bar .sb-replay:not(.hidden)', optional: true },
    { title: 'Camera', text: { desktop: 'Drag with the left mouse button to turn the camera and use the wheel to zoom.', touch: 'One finger turns the camera and two fingers pinch to zoom.' } },
    { title: 'Leave', text: 'Leave takes you back to the menu.', target: '.spec-bar .sb-exit' },
  ],
};

export const TOURS: Record<TourId, TourDef> = { devtools, tuning, admin, menu, build, hud, watch };
export const TOUR_LIST: TourDef[] = [devtools, tuning, admin, menu, build, hud, watch];
