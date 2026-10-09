# WoW-style Arena · v0.69.26

A 3D arena game in the style of WoW arena that runs in your browser: tab-target combat in 1v1, 2v2 or 3v3, four classes with three specs each and a talent tree for every spec, bots to practice against, ranked matches, friends, parties, duels, live spectating and replays. Nothing to download or install.

**Contents:** [Play now](#play-now) · [Controls](#controls) · [Modes](#modes) · [Classes and specs](#classes-and-specs) · [Arenas](#arenas) · [Rules worth knowing](#rules-worth-knowing) · [Practice bots](#practice-bots) · [Accounts, rating and looks](#accounts-rating-and-looks) · [Friends, parties and duels](#friends-parties-and-duels) · [Watching and replays](#watching-and-replays) · [Skills and talents](#skills-and-talents) · [Credits](#credits) · [Licence](#licence)

## Play now

**https://mmoarena.onrender.com**

- Use Chrome, Edge or Firefox on a computer with a mouse and keyboard to play. On a phone you can watch live matches and replays (see [Watching on a phone](#watching-and-replays)); playing needs a keyboard and mouse.
- Pick a class, a spec and talents, then press **Practice** (bots) or **Ranked** (needs an account).
- The first visit after a quiet spell can take up to a minute while the server wakes up. If the page is slow, wait and reload.
- Guests can play everything except ranked, rating, match history, friends and the leaderboard. Sign up in the menu (name and password) to keep your rating, unlocks, settings and history.
- If the game looks outdated after an update, press **Ctrl+Shift+R** to reload it fresh.

## Controls

Every key can be rebound: **Esc > Controls** in a match, or **Controls** on the menu. The defaults:

| Action | Default |
|---|---|
| Move forward / back | W / S (or the arrow keys) |
| Turn left / right | A / D (they strafe while you hold the right mouse button) |
| Strafe left / right | Q / E |
| Jump | Space |
| Abilities | 1 to 8 |
| Trinket (talent tier IV) | F |
| Next enemy | Tab |
| Auto-attack on or off | R |
| Detailed tooltips | Hold Alt while hovering |
| Steer / look around | Hold the right / left mouse button and drag; both buttons together run forward |
| Zoom | Mouse wheel (all the way in is first person) |
| Target | Left-click a character or its frame (click yourself to target yourself). Right-click an enemy to target it and start auto-attack. |
| Menu | Esc (clears your target first) |

- **Action bar:** drag one slot onto another to rearrange it; the order is saved for each spec. On the menu, hover a spec to see its eight skills and rearrange them there too (the card stays open while your mouse is on that side of the menu).
- **Free camera:** there is no free-fly camera any more; spectators follow players.
- **Lobby:** drag on the empty middle of the menu to turn your character.
- **Esc menu:** Resume, Controls, auto-attack on or off, mouse sensitivity, brightness, the **Cursor** section (style, size, tint, click ripple and trail), volume, the HUD editor (move and resize every element, including the error text (out of range, no line of sight...) and the stun text, and restyle those two: size, colour, outline, background, how long they stay; the combat log, kill feed and network stats grow their text when you drag the box bigger, and the scroll wheel over them changes the text size) and Leave match. Your cursor style (a steel gauntlet by default) is used everywhere, except that every player sees the same red sword over enemies, green cross over allies and crosshair while aiming a ground spell (red when it cannot be cast); ten more styles open as you play matches, win and climb the ladder, and the same section is in Profile > Customize.
- **Binding keys:** click a box and press a key, or hold Shift, Ctrl or Alt for a combo such as Shift+1. Every action has two slots, right-click clears a slot, and Esc is reserved.
- Signed in, your keybinds, HUD, sound settings and builds follow your account to any device.

## Modes

- **Practice:** a private match against bots or training dummies. Choose 1v1, 2v2 or 3v3, the arena, the bot skill and (under Advanced) your bot partners; the opponents are random classes, rolled each time. Nothing moves your rating.
- **Ranked** (needs an account): queues for the team size you picked. Players are paired in the order they queued; if you pick an arena you only play there, Random fits anywhere. Your rating changes with the result, and leaving a live ranked match is a loss.
- **Parties** (up to 6 players): the leader picks the mode and arena, everyone else presses Ready. A party plays on one team, in practice too (friends replace partner bots). A party bigger than the team size queues as separate players.
- **Party match:** with friends in a party, the leader can start a friendly match for the whole party. Everyone starts on the leader's team (a team holds 3), and you can pick Team 1 or Team 2 on your party card; bots fill the empty places.
- **Duels:** challenge an online friend to an unranked 1v1 with the class and build you have picked on the menu.
- **Watch live:** the menu lists every match in progress except solo dummy training. Spectators see everything five seconds late, so watching cannot help the players.
- **Replays:** Profile > Matches keeps your last 30 counted matches, each with a replay you can pause, speed up, seek and share by link.
- A match counts (for rating, history and unlocks) when it lasted at least 20 seconds, was not dummy practice, and you did not forfeit.

## Classes and specs

| Class | Health | Resource | Plays like |
|---|---|---|---|
| [Warrior](WIKI.md#warrior) | 3400 | Rage, built by dealing and taking damage | Heavy melee: charges in, slows, interrupts |
| [Mage](WIKI.md#mage) | 2400 | Mana | Ranged caster: slows, roots and polymorphs, fragile |
| [Priest](WIKI.md#priest) | 2500 | Mana | Healer and support: shields, heals, dispels and fears |
| [Rogue](WIKI.md#rogue) | 2800 | Energy and combo points | Stealth melee: stuns from stealth, kicks casters |

Every class has three specs, each with its own eight-skill action bar (and each warrior and mage spec carries its own weapon):

| Spec | Class | Role | Playstyle |
|---|---|---|---|
| [Warbringer](WIKI.md#warrior-arms) | Warrior | Dual wield | Fast, relentless swings. Mortal Strike cuts the target's healing; Slice and Dice stuns the cone ahead. |
| [Rampager](WIKI.md#warrior-fury) | Warrior | Two-handed sword | Slow swings with long reach. Bloodthirst heals as it hits; Bladestorm shreds everything near you. |
| [Barbarian](WIKI.md#warrior-protection) | Warrior | Control / reach | Fights with a polearm. Reel In, a bleeding Deep Cuts and a banner that traps enemies in place. |
| [Cryomancy](WIKI.md#mage-frost) | Mage | Control / kiting | Slows and roots keep enemies away. Fingers of Frost and Shatter turn Ice Lance into a huge hit; Deep Freeze locks it in. |
| [Pyromancy](WIKI.md#mage-fire) | Mage | Burst damage | Big fire damage with Pyroblast, Fireball and Flamestrike. Hot Streak makes Pyroblast instant. Cauterize saves you from one killing blow. |
| [Starweaving](WIKI.md#mage-arcane) | Mage | Sustain / utility | A damage cooldown, and Arcane Missiles and Barrage that hit hard; Explosion slows what is close. |
| [Warden](WIKI.md#priest-discipline) | Priest | Shield healer | Wards and Pain Suppression keep allies alive. Penance heals a friend or hurts a foe. |
| [Lightbearer](WIKI.md#priest-holy) | Priest | Pure healer | Direct healing. Holy Nova heals your team and hurts every enemy. |
| [Gloomweaver](WIKI.md#priest-shadow) | Priest | Damage | Shadow Word: Pain and Devouring Plague wear enemies down; Mind Flay and Mind Blast hit hard. |
| [Cutthroat](WIKI.md#rogue-assassination) | Rogue | Burst melee | Stealth openers into heavy hits. Mutilate and Garrote leave bleeds; Exsanguinate cashes in on them. |
| [Duelist](WIKI.md#rogue-combat) | Rogue | Sustained melee | Steady damage with Sinister Strike and Sprint. Gouge buys a moment; Adrenaline Rush gives faster swings, energy and healing. |
| [Shade](WIKI.md#rogue-subtlety) | Rogue | Control / mobility | Slippery repositioning with Shadowstep and Sprint. Backstab hits twice as hard from behind; Eviscerate finishes. |

**Talents:** five tiers, one pick per tier, remembered for each spec.

- **Tiers I and II** are the same for every spec of a class. Tier I changes one of the class's own skills (Mage: how Blink works; Warrior: Charge; Priest: Psychic Scream; Rogue: its stealth kit). Tier II is a flat boost (health, speed, damage, healing, casting speed, energy or combo points, depending on the class).
- **Tier III** is your spec's own: stronger skills, an extra chance to trigger a proc, or a side effect on your main skill.
- **Tier IV, the trinket,** adds an extra button beside the action bar (default key **F**, rebindable under Controls): **Cleansing Charm** (removes every harmful effect), **Warding Charm** (an absorb of 20% of your health) or **Healing Charm** (heals 25% of your health). It is the same for every class, has a 60 second cooldown, triggers no global cooldown and works while stunned.
- **Tier V** gives your class a new skill that replaces one you have, three to choose from. Warrior (replaces Heroic Leap): Intimidating Shout, Dragon Roar or Battle Banner. Mage (replaces Polymorph or Counterspell, you choose which): Mirror Image, Evocation or Rune of Power. Priest (replaces Desperate Prayer, or Power Word: Shield for Shadow): Leap of Faith, Purifying Light or Ascend to the Heavens. Rogue: Blind or Evasion in place of Sprint, or Sap, which takes the Kidney Shot button while you are stealthed.

**Tooltips** show the numbers for your build: hover any skill, buff, talent or look. Numbers your spec or talents change are green, with the base value struck through, and the spec card on the menu flags the skills your talents change. Hold **Alt** for how each number is worked out.

## Arenas

Pick one on the menu or leave it on Random.

| Arena | Layout |
|---|---|
| Dusk Colosseum | Four columns around an open centre, with an emperor's box (a small raised balcony with a ramp at each end) on the north and south walls. |
| Sunken Ruins | A fallen tower and broken columns: lots of line-of-sight play. Two crumbling stone platforms climb out of the rubble, and broken walls give cover you can vault. |
| Frostkeep Pit | A ring of ice spires with a frozen bridge spanning the pit from north to south, and snowdrift walls on the flanks. |
| The Serpent | An S-shaped raised wooden walkway between two start yards, with a ramp up from each yard and four pillars underneath for cover. |
| The Overlook | A central raised plateau with ramps north and south, a shaded hall underneath and low barricades. Every duel is played here. |
| Icebound Ring | A raised square walkway around an open courtyard with an ice spire, with ramps down towards each team. |
| Sun Terraces | Two long raised terraces along the north and south walls with a ramp at each end, plus a centre obelisk and barricades. |
| Cinder Crater | A basalt crater cracked with lava: obsidian spires, jagged rock walls in front of each start yard, low rock barricades and a raised ledge in two corners. |
| Lava Forge | A grey-brick hall with a raised forging plinth in the middle (ramps north and south), four person-high basins of molten rock, brick chimneys and slabs of rim rock. |
| Sandstone Yard | A sand-floored stadium yard with a stepped plinth in the middle (ramps east and west), stacked carved blocks, tall obelisks and low sandbag-style barricades. |

**Getting around:** you can jump over deck rails and low barricades, jump off any walkway to drop to the ground, and jump onto the lower part of a ramp from the side. Heroic Leap aimed on top of a walkway lands up there. A raised deck is a floor between levels: someone above you is hidden while the deck is between you, and visible once you can see past its edge. Ground spells (Flamestrike, the banners, Rune of Power, smoke) only reach the floor they were placed on. Charge and Heroic Leap clear rails and barricades too (Charge can take you off a walkway onto someone below), and Shadowstep lands you on your target's level. Ramps and piers block sight on the ground. Barricades are as tall as a person: on the ground they block walking and sight, and a jump clears them and lifts your sight line over them for a moment, long enough for an instant spell (and for them to hit you back).

## Rules worth knowing

- **Casting:** most skills trigger a 1 second global cooldown. Starting another spell cancels the one you are casting. A spell you press while casting or on the global cooldown is queued and goes off as soon as you are free (the newest press wins).
- **Facing and range:** casts and swings need the target in the half-circle in front of your character and in line of sight. Melee reach is 3 yards (some warrior weapons reach further). Range is measured in 3D, and a blade never reaches between floors, so someone up on a walkway is out of melee reach from the ground below (and the other way round). Ground spells (Flamestrike, Battle Banner, Not Going Anywhere, Rune of Power) are aimed at the cursor: press the key, then click to place; one still on its cooldown does not bring the ring up.
- **Lava:** the four basins on Lava Forge are lava. Jump in and you are no longer pushed out, but you burn for 5% of your health every half second until you climb out; on foot you cannot walk in.
- **Line of sight:** a body, not a single thread: a unit whose edge shows past a pillar or wall end (about a third of a yard) is in sight and can be targeted.
- **Dampening:** in a match with a healer, 90 seconds into the fight healing and new shields start getting weaker, 0.3% more every second (up to 90% weaker), so two healers cannot out-heal each other forever. The Dampening banner at the top shows how much.
- **Crowd control:** the same kind of stun, fear, incapacitate or root on one target has diminishing returns (full, half, quarter, then immune, reset after 18 seconds). Interrupts instead lock a spell school for a few seconds. Polymorph, Blind, Gouge, Sap and Frost Nova's root break on any damage; Psychic Scream and Intimidating Shout break on direct damage (not damage over time); Dragon's Breath does not break.
- **Blink** frees you from stuns, roots and slows and works while stunned, but not while polymorphed or under Dragon's Breath.
- **Auto-attack:** warriors and rogues deal steady damage (and warriors build rage) with auto-attack. It starts with a right-click on an enemy, R or any melee skill, stays on while you have an enemy targeted (so it is ready when you close in), and stops when you clear your target, or 5 seconds after combat if nothing hostile is targeted.
- **Resources:** mana and energy refill over time. Rage starts empty, builds from damage you deal with free skills and auto-attacks and from damage you take, and drains out of combat. Rogue builders award combo points that finishers spend (Kidney Shot, Eviscerate, Exsanguinate, Adrenaline Rush); while stealthed, the builder slot becomes Cheap Shot.
- **Stealth:** a stealthed rogue is seen only within 2 yards. Damage or attacking breaks it, and enemies you cannot see are never sent to your browser.
- **Ground zones:** while you are in the air you dodge a pulse of Flamestrike and the like (one dodging jump every 1.5 seconds). Spells aimed at you always hit.
- **Exact numbers:** there is no random damage or healing: every hit does exactly what its tooltip says.

## Practice bots

| Skill | What changes |
|---|---|
| Dummies | They stand still and do nothing, and a dummy you kill stands back up at full health after a moment. Good for checking numbers and visuals. |
| Easy | About 1.3 s reaction, answers about 20% of your casts with an interrupt. |
| Normal | About 0.55 s reaction, interrupts most casts. |
| Hard | About 0.16 s reaction, interrupts everything it can. |

Bots use the same commands as a player, so they obey the global cooldown, range, line of sight, resources, lockouts and stealth. They play their spec's whole bar, walk around pillars and out of ground zones, interrupt casts, dispel crowd control off their partner, polymorph the enemy that is not the kill target, and stun or kick casters.

## Accounts, rating and looks

- **Rating:** everyone starts at 1000 and one rating covers every team size. Elo K is 48 for your first 5 ranked games, 32 up to 20, then 24; teams are compared by their average rating. Tiers: Bronze, Silver (1100), Gold (1300), Platinum (1500), Diamond (1700), Gladiator (1900).
- **Profile:** rating, tier, peak, wins and matches, unlocks and the Matches tab (history and replays). There is a leaderboard of every account.
- **Look:** one menu for everything that changes how you look, with tabs and a search box: **Character** (headwear, wings, back, weapon glow, ground aura, armor dye and a companion), **Name and title**, **Cursor**, **Nameplates and HUD** and **Effects**. The nameplate editor gives you, your allies and your enemies their own looks: drag to resize the name, health bar, resource bar and debuff row (they snap to each other) and anchor the plate at the head or the feet. Looks never change how you fight. More of them unlock as you play (at 5, 15, 30, 60 and 100 matches); the Look menu shows what is still locked. Titles, emblems and name colours unlock with matches, wins or peak rating and show on your nameplate.
- **Settings follow the account:** HUD layout and style, keybinds, sensitivity, cursor, volume, class, builds and practice options apply on any device after you sign in. Guests keep settings in the browser only.
- Passwords are never stored (only a salted hash), and a login lasts 30 days.

## Friends, parties and duels

- **Friends:** add a player by name; they accept or decline (if they had already asked you, you are friends straight away). The list shows who is online and what they are doing, up to 50 friends.
- **Parties and duels:** invite from the friends list. Invites show as a banner at the top of the screen and expire on their own. See [Modes](#modes) for how parties queue.
- **Suggestions:** the 💡 Suggest button on the menu sends an idea to the developer.

## Watching and replays

- Every match with a player in it can be watched live (except solo dummy training), five seconds behind.
- **On a phone:** drag to turn the camera, pinch to zoom, tap a player to follow them and double tap for the next one; big buttons switch player, show builds and scores, and leave. Replays have thumb-sized play/pause, speed and seek buttons. The **Light graphics** setting (Automatic, On, Off) lowers resolution and effects on small screens, and the game can be added to a phone's home screen. The Settings button on the main menu has a Done button to get back out.
- Replays re-run the exact match in your browser, so you can pause, change speed, seek and follow any player. A replay link can be shared with anyone.
- Replays only play on the game data they were recorded with; after a balance change an older replay says so instead of showing a wrong fight.

## Skills and talents

Every class, spec, skill, talent and effect, with its cost, cast time, cooldown, range, duration and what it does, is in the **[wiki (WIKI.md)](WIKI.md)**. It is generated from the game data, so it always matches the in-game tooltips.

- Classes: [Warrior](WIKI.md#warrior) · [Mage](WIKI.md#mage) · [Priest](WIKI.md#priest) · [Rogue](WIKI.md#rogue)
- [Effects reference](WIKI.md#effects) (every buff, debuff and proc) · [Rules every class shares](WIKI.md#rules)

---

Developing or hosting the game: see [DEVELOPING.md](DEVELOPING.md).

## Server update rate

The game server runs the match 20 times a second by default. Set the environment variable `ARENA_TICK_MS` to a whole number of milliseconds from 8 to 50 to change it; the hosting blueprint (`render.yaml`) sets `16`, which is 62.5 updates a second: tighter fights, with two players' screens agreeing on where each stands to within a yard (95 % of the time) on a clean connection with 100 ms ping. See "Running at 62.5 Hz" in DEVELOPING.md for the cost, how to set it on Render by hand and how to go back to 50.

## Credits

The characters, weapons, cape, wings and arena scenery (for example the dual sabers by Shadow Models 3D, the greatsword by denisdezmand, the Tyra Polearm by zenkuri, the Old Wizard by JuanCarlosOsanteHernandez, the Hooded Shadow Assassin by iRahulRajput and the Abyssal Sentinel by Rignu) and one recorded sound are third-party art used under their licences: see [CREDITS.md](CREDITS.md), or **Credits** in the main menu.

## Licence

Copyright (c) 2026 TokeGG. All rights reserved. The code is public so it can be read, not so it can be copied, hosted or reused: see [LICENSE](LICENSE). Third-party art keeps its own licence ([CREDITS.md](CREDITS.md)).
