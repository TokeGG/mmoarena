# WoW-style Arena · v0.34.2

A 3D third-person arena game in the style of WoW arena that runs in your browser. Tab-target combat, 1v1, 2v2 or 3v3, four classes with specs and talents, bots to practice against, ranked matches, friends and parties, replays and live spectating. Nothing to download or install.

## Play now

**https://mmoarena.onrender.com**

Open the link in Chrome, Edge or Firefox on a computer (mouse and keyboard), pick a class, a spec and talents, then press **Practice** (bots) or **Ranked** (needs an account).

- The first visit after a quiet spell can take up to a minute while the server wakes up. If the page is slow, wait and reload.
- Guests can play practice and everything else except ranked, rating, history, friends and the leaderboard. Sign up (name + password) in the menu to keep your rating, unlocks, settings and history.
- If the game looks outdated after an update, press **Ctrl+Shift+R** to reload fresh.
- Play with friends: add them in the friends panel, make a party, or challenge them to a duel.

## Play modes

- **Practice**: a private match against bots or training dummies. Choose 1v1, 2v2 or 3v3, who the enemies are, who your partners are (a bot of any class, or none), the bot level and the map. Nothing moves your rating.
- **Ranked** (needs an account): joins the queue for the size you picked (1v1, 2v2, 3v3). The server pairs waiting players in the order they queued; players who chose a specific arena only play there and Random players fit anywhere. Your rating changes with the result. Leaving a live ranked match is a loss.
- **Parties** (up to 3 friends): the lobby lists who is in your party and who is ready. The leader picks the mode and arena (Practice or Ranked); everyone else presses Ready instead. A party plays on one team, in practice too (friends replace ally bots). A party larger than the team size (for example 2 friends in a 1v1) queues as separate players, so they can be matched against each other.
- **Duels**: challenge an online friend to an unranked 1v1. Both of you use the class and build selected in the menu.
- **Watch live**: the menu lists ranked matches in progress. Spectators see everything five seconds late, so watching cannot help the players.
- **Replays**: Profile > Matches keeps your last 30 counted matches, each with a replay button.
- **Maps** (three arenas, each with its own layout and look; pick one or leave it on Random):

| Map | Feel |
|---|---|
| Dusk Colosseum | Sand arena with a pillar ring, warm light |
| Sunken Ruins | Broken walls and cover, lots of line-of-sight play |
| Frostkeep Pit | Cold stone pit with ice and open sight lines |

- A match counts only if it was live 20 s or more, was not dummy practice, and you did not forfeit.

## Controls (rebindable)

Defaults: RMB-drag steer · LMB-drag orbit camera · both mouse buttons run forward · W/S move · Q/E strafe · A/D turn (strafe while RMB held) · Space jump · wheel zoom (scroll all the way in for first person; the camera also drops into first person when a wall or pillar is right behind you) · Tab next enemy · click to target (click yourself or your own frame to target yourself) · 1-8 abilities (drag one action slot onto another to rearrange; saved per spec) · R toggles auto-attack (it also starts when you use a melee ability, and stops after 5 s out of combat or when you click off your target onto empty space, or press Esc to clear it); right-click an enemy (a click, not a drag) targets it and starts auto-attack, left-click only targets.

**Esc** clears your target first, then opens the menu: Resume, Controls, an Auto-attack on/off toggle, mouse sensitivity, volume sliders, HUD editor, Leave match. In **Controls** click a box and press a key, or hold **Shift / Ctrl / Alt** and press one for a combo such as Shift+1 (a plain binding still fires with a modifier held unless that exact combo is bound; release a modifier on its own to bind the modifier itself; browsers may grab some Ctrl combos); every action has two slots, right-click clears a slot, binding a key that is in use moves it, and Esc itself is reserved. The same screen is on the join page. Signed in, your keybinds, HUD, volume and builds follow your account to any device.

## Classes, specs and talents

Four classes: Warrior (rage), Mage (mana), Priest (mana), Rogue (energy). Each has **3 specs** with their own **eight-ability bar** (keys 1-8) and passive modifiers (for example Frost, Fire and Arcane), and **6 talent tiers**, one pick per tier:

- **Tiers I to III and the last tier:** passives (damage, healing, movement speed, cooldowns, longer slows and stuns).
- **Tiers IV and V (ability swaps):** each choice adds an extra ability that takes the place of one on your bar (the tooltip lists what each spec gives up). Between them, every class can bring **a stun and an interrupt** of its own.

| Class | Abilities you can swap in |
|---|---|
| Warrior | Shockwave, Piercing Howl, Die by the Sword, Storm Bolt, Disrupting Shout |
| Mage | Cone of Cold, Evocation, Dragon's Breath, Deep Freeze, Arcane Torrent |
| Priest | Penance, Holy Word: Serenity, Power Infusion, Hammer of Justice, Silence |
| Rogue | Blind, Eviscerate, Crippling Poison, Smoke Bomb, Deadly Throw |

- **Damage over time and aimed spells:** Shadow priests get a no-cooldown damage-over-time spell and a bigger, longer one on a cooldown (replacing Dispel Magic). Priests' healing channel (Penance) heals a friend or hurts an enemy depending on who you target. Flamestrike and Blizzard are **aimed at the cursor**: press the key to arm the spell (its slot lights up and a ring follows your pointer), then **click or press the key again to place it**; Esc, casting something else or a stun cancels. The ring only shows while a spell is armed. While steering with the right button the ring sits at the centre of the screen.

Hover any ability, buff or debuff, spec, talent or look to see numbers for your build.

## How combat works

Tab-target, a 1.5 s global cooldown, cast times, interrupts that lock a school, crowd control with diminishing returns, line-of-sight pillars and stealth. Warriors and rogues need auto-attack on (right-click an enemy, R, or any melee ability; it is held while stealthed unless the target is within 2 yards) to build rage and deal steady damage.

- **Jumping and ground zones:** Space jumps. A jump is mostly cosmetic, but while airborne you dodge the pulses of ground zones such as Flamestrike. Dodging has a 1.5 s cooldown so hop-spamming does not work. Targeted spells (Fireball, Frostbolt, Smite...) always hit.
- **Rules worth knowing (0.23):** auto-attacks need line of sight like spells; starting another spell cancels the one you are casting (off-global instants like interrupts do not); Blink works while stunned, feared or incapacitated; Polymorph is limited to one target per caster and the sheep wanders; Fireball is a quick 1.8 s cast; warriors build rage at a third of the original rate in 0.23 and at 0.15 per damage point from 0.31; Smoke Bomb (0.33) drops a 6-yard cloud for 6 s that strips targeting from enemies inside it; melee reach is 3 yards plus a half-yard lag allowance (0.34; measured centre to centre, and it was 5 + 1.5 before); casts, ground spells and swings need the target inside a 90-degree cone in front of your character model, not just on screen: turn away and you stay targeted but cannot cast until you face it again (0.34; bots ignore it); Blink frees you from stuns, roots and slows; stealthed rogues are spotted within 2 yards (0.29), and auto-attack only swings from stealth at that range, breaking it.
- **Fog:** enemies you cannot see (stealthed or farther than 8 yards) are left out of your snapshots entirely.

## Appearance (cosmetics change how you look, nothing else)

Nothing you wear changes your stats, damage or health: every player of a class is equal, and the build that matters is your spec and talents. There is no loot and no unlocking: **all 60 cosmetics are free for everyone**.

- **Seven slots, 8-10 choices each:** *Headwear* (horned crown, winged circlet, royal and frost crowns, pointed hat, warcrest, halo, antlers, cat ears, knight helm), *Shoulders* (spiked, gilded, crystal, wolf fur, flame tufts, royal mantle, bone, emerald), *Back* (four cloaks that sway as you run, angel, bat and phoenix wings that flap, a war banner), *Weapon glow* (ember, frostbite, venom, radiance, void, storm, blood, moonlit), *Ground aura* (sun ring, frost and emerald runes, hellfire, whirlwind, cherry blossom, shadow mist, drifting embers), *Armor dye* (ten colours that recolour the whole class model) and *Companion* (orbiting fire, frost and spirit orbs, an arcane crystal, orb trios, a pale moon, a lantern).
- **Owner-only looks:** the founder account has 11 extra cosmetics (Founder's Crown, Void Horns, Dragon Pauldrons, Archon Wings, Cloak of Embers, Godfire, Throne of Light, Stormlord, Midas Gold, Crown Satellites, Mini Sun). Other players cannot pick them, and the server strips them from anyone else's build, but everyone can see them on the owner.
- **Who sees it:** everyone in the match, spectators and replays too. The menu preview updates as you pick, the picker stays open so you can try several, and **Random look** and **Clear all** are one click.
- Old saves are tidied automatically: gear ids from the earlier tier and loot system are dropped quietly and any loot you held is gone.

## Practice with bots

| Skill | What changes |
|---|---|
| Dummies | They stand still and do nothing. Good for checking numbers and visuals. |
| Easy | Slow reactions, answers about 40% of your casts with an interrupt. |
| Normal | About 0.4 s reaction, interrupts most casts. |
| Hard | About 0.16 s reaction, interrupts everything it can. |

Bots use the same commands as a human (move, target, cast), so they obey the global cooldown, range, line of sight, resources, lockouts and stealth. They path around pillars, interrupt casts, dispel crowd control off their partner, polymorph the enemy that is not the kill target, and stun or kick casters.

## Accounts, rating and the profile

Sign up in the menu (name + password). Passwords are never stored, only a salted scrypt hash, and a login lasts 30 days.

- **Rating:** everyone starts at 1000 and one rating covers every size. Elo K is 48 for your first 5 ranked games, 32 up to 20, then 24. Teams are compared by average rating. Tiers: Bronze, Silver (1100), Gold (1300), Platinum (1500), Diamond (1700), Gladiator (1900).
- **Profile:** rating, tier, peak, wins and matches, unlocks, and the Matches tab (history and replays). There is a leaderboard of every account.
- **Cosmetics:** emblems, titles and name colours unlock by matches, wins or peak rating and show on nameplates. The founder account has exclusive owner-tier ones.
- **Settings follow the account:** HUD layout and style, keybinds, sensitivity, volume, class, builds and practice options are saved to your account and applied on any device after you sign in (the page reloads once). Guests keep settings in the browser only.

## Friends, parties and duels

- **Friends:** add by name. The other side gets a request and accepts or declines; if you add someone who already asked you, you are friends straight away. The list shows who is online and what they are doing. Up to 50 friends.
- Parties and duels are described under Play modes. Invites expire on their own.
- Friend lists live on the account record; who is online is held in memory only, so presence costs no database reads.

## Replays and spectating

- The server records every command and input of a counted match (about 20-60 KB gzipped, kept 30 days). The browser re-runs the exact match on the shared simulation, so you can pause, change speed, seek, and follow any player. A replay URL (`/?replay=<id>`) can be shared with anyone.
- Replays only play on the game data they were recorded with. After a balance or rules change, older replays say so instead of showing a wrong fight.
- Spectating is ranked matches only, up to the room's spectator cap, five seconds behind live.

## Sound

All audio is synthesised live in the browser (Web Audio), so there are no sound files to download. It covers spell casts and impacts per school, melee swings, heals, crowd control, deaths, jumping, footsteps, countdown ticks, match start and result stingers, UI clicks and a quiet ambience for each arena theme. Sounds are positional (volume by distance, pan by screen position). The Esc menu has master, effects and ambience sliders, and a mute button sits on screen. Audio starts on your first click or key press, as browsers require.

## Fair play and safety

- The server decides every outcome. The client sends intents only (cast X on Y, movement input) and never decides hits, cooldowns or damage.
- Your own movement is predicted and corrected by the server. Abilities are not predicted.
- Enemies you cannot see are not sent to your browser, so wall-hacks have nothing to read.
- Cosmetics are visual only, so nothing you wear gives an advantage.
- Your password and login token only go to this site.

## For the owner (hosting and moderation)

Players do not need any of this. The game is built from the GitHub repo `TokeGG/mmoarena` and hosted on Render at https://mmoarena.onrender.com; every push to `main` redeploys it (wait for **Deploy live**, then reload with Ctrl+Shift+R).

### Environment variables (Render > Environment)

| Variable | Purpose |
|---|---|
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Free Upstash Redis database so accounts, ratings, history, replays and friends survive restarts. (`KV_REST_API_URL` and `KV_REST_API_TOKEN` also work.) Without them everything lives in memory and resets on every restart or redeploy. |
| `ARENA_OWNER_CODE` | Secret that unlocks the owner tools for the founder account (see below). Without it the owner tools are off, and you should set it **before** registering `Toke`. |
| `ARENA_SECRET` | Long random string that signs the guest progress tokens. Without it a public dev secret is used and tokens can be forged. |
| `ARENA_KEY_PREFIX` | Prefix for every database key (default `wowarena:`). It lets this game share the Aim Arena Upstash database without conflicts. Do not change it once accounts exist. |
| `PORT` | Port to listen on (Render sets it itself). |

### Deploy (Render)

1. Push the **contents** of this folder so `package.json` and `render.yaml` sit at the repo root. Leave Render's Root Directory blank and commit `package-lock.json`.
2. Render: **New + > Blueprint**, pick the repo. `render.yaml` sets Node, the Virginia region, the build and start commands and the health check. Or create a Web Service by hand:

| Setting | Value |
|---|---|
| Runtime | Node |
| Region | Virginia |
| Build command | `npm install --include=dev && npm run build` |
| Start command | `npm start` |
| Health check path | `/healthz` |

3. Open the Render URL. One service serves the page and the WebSocket (`wss://<host>/ws`), so there is nothing else to configure and no CORS to set up. The free tier sleeps when idle.

### Upstash setup

1. Create a free Redis database at https://upstash.com.
2. Copy the REST URL and REST TOKEN.
3. Add them as `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in Render and redeploy.
4. Register `Toke` again with the owner code (accounts made while the database was off are gone).

The menu shows a warning while accounts are temporary, and `/api/status` reports `persistent: true` once it works.

### Owner tools

Profile > **★ Owner**, founder account only (the name `Toke`). You must also enter `ARENA_OWNER_CODE` once per session, and the name alone is never enough. Everything is checked on the server.

- **Your own style:** a free-text title (up to 24 characters), colours (gradient and glow), and a **GIF icon** (max 256x256 px and 256 KB) that shows on your nameplate and profile.
- **Accounts panel:** award owner-tier titles, emblems and colours to any player, give a friend a custom title and colours, switch on the **GIF icon ability per friend** (they then upload their own in the same place), and reset a password (a temporary password is shown once and old sessions end).
- There are no co-admins by design. Password reset is the only account recovery.

### Security measures

| Area | Protection |
|---|---|
| Authority | Server-authoritative simulation at a fixed 20 Hz tick; per-viewer snapshot culling; every client message is validated. |
| Accounts | scrypt password hashes, random session tokens in a bearer header (no cookies, so no CSRF), 30-day expiry, rate-limited login and registration. |
| Owner | Founder name plus a secret code entered per session, rate-limited guesses. |
| Avatars | GIF only, checked for size and dimensions on the server and served from a separate path. |
| Replays | Stored compressed with a 30-day expiry and gated by a content hash so a stale replay never plays a wrong fight. |
| Connections | Per-socket message rate limit and message size cap. |
| Storage | All keys sit under one prefix so the database can be shared safely. |

### Running locally and tests

```bash
npm install
npm run dev:server        # game server on :8080
npm run dev:client        # Vite on http://localhost:5173 (proxies /ws to :8080)
npm run build && npm start     # production: one process serves the client and WebSocket
npm test                  # simulation, bots, builds, replays, accounts, matchmaking, friends, real WebSocket end-to-end
npm run typecheck
npm run duel              # headless bot-vs-bot win rates for every composition
npm run duel -- 30 hard   # 30 seeds per matchup, hard bots
```

`npm run duel` measures how the bots' playbook performs, not how humans will. Use it to catch broken classes and wildly lopsided numbers, then tune `shared/data/*.json`.

**Replay rule:** whenever you change simulation code (`shared/src/sim.ts` and anything it uses), bump `SIM_REVISION` in `shared/src/replay.ts`, otherwise older replays would play out differently. It is currently 3.

### Files

| Path | Role |
|---|---|
| `shared/data/*.json` | Classes, abilities, auras, specs, talents, cosmetics, arenas, tuning. All game content lives here, so a future Godot/Unity client or server can read the same files. |
| `shared/src/sim.ts` | Headless, deterministic simulation. No rendering, no I/O, no wall clock. Same seed and inputs give the same result. |
| `shared/src/replay.ts` | Recorder and runner that re-simulate a match from its commands. |
| `shared/src/build.ts` | The only place that turns specs and talents (including ability swaps) into numbers; cosmetics only decide the look. |
| `shared/src/bot.ts` | Bot AI, driven through the same commands a player uses. |
| `shared/src/geometry.ts`, `jump.ts` | Movement, collision, line of sight, jumping. Used by the server and by client prediction. |
| `shared/src/protocol.ts` | Message types and validation of untrusted client input. |
| `shared/src/accounts.ts` | Ranks, Elo, cosmetics, friends, match records (shared types and rules). |
| `server/src/index.ts` | HTTP and WebSocket entry, `/api/status`, avatars, replay download. |
| `server/src/rooms.ts` | Lobby, queues, parties, duels, rooms, spectators. |
| `server/src/matchmaking.ts` | Pairs queued players and parties into two equal teams. |
| `server/src/accounts.ts` | Accounts, sessions, owner tools, history, replays, friends, the Upstash/memory store. |
| `client/src/` | Three.js + Vite client: scene and models, HUD and HUD editor, menus, audio, spectate and replay viewer, friends panel. |
| `tests` | `shared/test`, `server/test` and `client/test`, run by `npm test`. |

### Known limits

- Numbers are a first pass and untuned, especially the 0.21 abilities and talents. Bot-vs-bot runs say mages are weak against melee and matches with a healer run long. Retune after you play.
- Matchmaking pairs players in queue order; it does not use rating yet. One rating covers 1v1, 2v2 and 3v3.
- Bots and dummies use the classic ability bar. They do not dodge ground zones, use Flamestrike, or pick specs and talents.
- Duels are 1v1 only. Spectating covers ranked matches only; replays are saved for ranked and bot-practice matches of signed-in players.
- The 3D scene (maps, zones, replay and spectate cameras) has been built and tested through the simulation but not tuned on a real GPU yet. Characters are rounded primitives with outlines (`client/src/models.ts`); swap for glTF later.
- No combo points and no spell queueing window.
- Replays recorded before a simulation change stop playing.
