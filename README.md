# WoW-style Arena · v0.21

A 3D third-person arena game in the style of WoW arena that runs in your browser. Tab-target combat, 1v1, 2v2 or 3v3, four classes with specs and talents, bots to practice against, ranked matches, friends and parties, replays and live spectating. Nothing to download or install.

## Play now

Open the game's Render link (the service is called `wow-arena`) in Chrome, Edge or Firefox on a computer (mouse and keyboard), pick a class, a spec and talents, then press **Practice** (bots) or **Ranked** (needs an account).

- The first visit after a quiet spell can take up to a minute while the server wakes up. If the page is slow, wait and reload.
- Guests can play practice and everything else except ranked, rating, history, friends and the leaderboard. Sign up (name + password) in the menu to keep your rating, unlocks, loot, settings and history.
- If the game looks outdated after an update, press **Ctrl+Shift+R** to reload fresh.
- Play with friends: add them in the friends panel, make a party, or challenge them to a duel.

## Play modes

- **Practice**: a private match against bots or training dummies. Choose 1v1, 2v2 or 3v3, who the enemies are, who your partners are (a bot of any class, or none), the bot level and the map. Nothing moves your rating.
- **Ranked** (needs an account): joins the queue for the size you picked (1v1, 2v2, 3v3). The server pairs waiting players in the order they queued; players who chose a specific arena only play there and Random players fit anywhere. Your rating changes with the result. Leaving a live ranked match is a loss.
- **Parties** (up to 3 friends): the leader invites, everybody presses Ranked when ready, the leader's size and arena apply, and the party always plays on one team.
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

Defaults: RMB-drag steer · LMB-drag orbit camera · W/S move · Q/E strafe · A/D turn (strafe while RMB held) · Space jump · wheel zoom · Tab next enemy · click to target · 1-6 abilities · R auto-attack.

**Esc** clears your target first, then opens the menu: Resume, Controls, mouse sensitivity, volume sliders, HUD editor, Leave match. In **Controls** click a box and press a key; every action has two slots, right-click clears a slot, binding a key that is in use moves it, and Esc itself is reserved. The same screen is on the join page. Signed in, your keybinds, HUD, volume and builds follow your account to any device.

## Classes, specs and talents

Four classes: Warrior (rage), Mage (mana), Priest (mana), Rogue (energy). Each has **3 specs** with their own six-ability bar and passive modifiers (for example Frost, Fire and Arcane), and **5 talent tiers**, one pick per tier:

- **Tiers I to III:** small passives (damage, healing, movement speed, cooldowns, longer slows and stuns).
- **Tier IV (ability swap):** pick one of three extra abilities that takes the place of one on your bar. The tooltip lists what each spec gives up. The bar stays six slots.

| Class | Tier IV choices |
|---|---|
| Warrior | Shockwave (short AoE stun), Piercing Howl (AoE slow), Die by the Sword (half damage for 5 s) |
| Mage | Cone of Cold (AoE damage and slow), Evocation (fast mana and 15% less damage for 6 s), Dragon's Breath (AoE burn and disorient) |
| Priest | Penance (three-hit channel), Holy Word: Serenity (strong instant heal), Power Infusion (+20% damage and healing, 15% faster casts) |
| Rogue | Blind (5 s disorient), Eviscerate (heavy finisher), Crippling Strike (hit and 40% slow) |

- **Tier V (capstones):** three more passives per class, mostly strengthening the new abilities.

Hover any ability, buff or debuff, spec, talent, gear piece or stat to see numbers that include your build.

## How combat works

Tab-target, a 1.5 s global cooldown, cast times, interrupts that lock a school, crowd control with diminishing returns, line-of-sight pillars and stealth. Warriors and rogues need auto-attack on (R, or any melee ability) to build rage and deal steady damage.

- **Jumping and ground zones:** Space jumps. A jump is mostly cosmetic, but while airborne you dodge the pulses of ground zones such as Flamestrike. Dodging has a 1.5 s cooldown so hop-spamming does not work. Targeted spells (Fireball, Frostbolt, Smite...) always hit.
- **Fog:** enemies you cannot see (stealthed or farther than 8 yards) are left out of your snapshots entirely.

## Gear and loot

- **Gear:** 5 slots, 4 tiers (Initiate, Veteran, Elite, Gladiator), 4 flavors. Tiers unlock by finishing matches (0 / 3 / 8 / 15). Every stat bonus is capped at 15%, so higher tiers are a small edge, not a gap.
- **Loot (signed in):** finished ranked matches drop a random item (two on a win); bot practice drops at most one Common-to-Rare item half the time; dummy practice drops nothing. Rarities Common, Uncommon, Rare, Epic, Legendary (weights 55 / 28 / 12 / 4.2 / 0.8) with rolled stats. Epic and Legendary can carry a perk, and each perk counts once however many pieces have it. Ranked drops are guaranteed Epic+ after 20 without one. Inventory holds 60; a full inventory pushes out the lowest-rarity, oldest item. Loot goes through the same capped bonuses as tier gear.
- Guests keep the match-count gear tiers.

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
- Gear is a capped multiplier and one rating applies to everyone: nobody is nerfed for being stronger.
- Your password and login token only go to this site.

## For the owner (hosting and moderation)

Players do not need any of this. The game is built from the GitHub repo `TokeGG/mmoarena` and hosted on Render as a web service named `wow-arena`; every push to `main` redeploys it (wait for **Deploy live**, then reload with Ctrl+Shift+R).

### Environment variables (Render > Environment)

| Variable | Purpose |
|---|---|
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Free Upstash Redis database so accounts, ratings, loot, history, replays and friends survive restarts. (`KV_REST_API_URL` and `KV_REST_API_TOKEN` also work.) Without them everything lives in memory and resets on every restart or redeploy. |
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

**Replay rule:** whenever you change simulation code (`shared/src/sim.ts` and anything it uses), bump `SIM_REVISION` in `shared/src/replay.ts`, otherwise older replays would play out differently. It is currently 2.

### Files

| Path | Role |
|---|---|
| `shared/data/*.json` | Classes, abilities, auras, specs, talents, gear, arenas, tuning. All game content lives here, so a future Godot/Unity client or server can read the same files. |
| `shared/src/sim.ts` | Headless, deterministic simulation. No rendering, no I/O, no wall clock. Same seed and inputs give the same result. |
| `shared/src/replay.ts` | Recorder and runner that re-simulate a match from its commands. |
| `shared/src/build.ts` | The only place that turns specs, talents (including ability swaps) and gear into numbers. |
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
- Bots and dummies use the classic ability bar and neutral gear. They do not dodge ground zones, use Flamestrike, or pick specs and talents.
- Duels are 1v1 only. Spectating covers ranked matches only; replays are saved for ranked and bot-practice matches of signed-in players.
- The 3D scene (maps, zones, replay and spectate cameras) has been built and tested through the simulation but not tuned on a real GPU yet. Characters are rounded primitives with outlines (`client/src/models.ts`); swap for glTF later.
- No combo points and no spell queueing window.
- Replays recorded before a simulation change stop playing.
