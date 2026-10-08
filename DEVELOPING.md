# Developing and hosting the game

Everything a player does not need: running the game locally, tests, the project rules, bot training, hosting on Render, the database, owner tools and security. The player guide is [README.md](README.md); the skill and talent reference is [WIKI.md](WIKI.md).

## Running locally and tests

```bash
npm install
npm run dev:server        # game server on :8080
npm run dev:client        # Vite on http://localhost:5173 (proxies /ws to :8080)
npm run build && npm start     # production: one process serves the client and WebSocket
npm test                  # simulation, bots, builds, replays, accounts, matchmaking, friends, tooltips, real WebSocket end-to-end
npm run typecheck
npm run duel              # headless bot-vs-bot win rates for every composition
npm run duel -- 30 hard   # 30 seeds per matchup, hard bots
npx tsx scripts/gen-wiki.ts    # rebuild WIKI.md from the data (a test fails while it is out of date)
npx tsx scripts/train-rotations.ts   # relearn every spec's damage rotation (seconds)
npx tsx scripts/train-bots.ts  # relearn the bot brains by self-play (minutes)
```

`npm run duel` measures how the bots' playbook performs, not how humans will. Use it to catch broken classes and wildly lopsided numbers, then tune `shared/data/*.json`.

## Project rules

The full list is in [CLAUDE.md](CLAUDE.md). In short:

- **Replays:** whenever simulation code (`shared/src/sim.ts` and anything it uses) or game data changes, bump `SIM_REVISION` in `shared/src/replay.ts`, otherwise older replays would play out differently. Replays are also gated by a hash of the data files, so a stale one says so instead of showing a wrong fight.
- **Versions:** bump the version in README line 1, the root `package.json` and `client/package.json` together (kept below 1.0), and add the matching entry at the top of `shared/data/patches.json` (the in-game Patch notes; a test checks the versions agree).
- **Bots:** a change to abilities, specs, talents, weapons or class mechanics also updates `shared/src/bot.ts` so bots use the new skills, and the per-spec bot test must pass. Then re-train (below) and commit `shared/data/rotations.json` and `shared/data/botbrain.json`.
- **Wiki:** after changing abilities, auras, specs, talents or tooltip wording, run `npx tsx scripts/gen-wiki.ts` and commit `WIKI.md`.

## Bots and learning

- Bots play from a tunable brain (cover and defensive thresholds, strafing, healer priority, focus fire, kiting range, heal timing, burst timing, chase, ground-zone dodging, pre-shielding).
- Bots take talents (a random pick in most tiers), so the tier IV trinket and the tier V class skills are played by bots too; a test checks that every ability on a bot's bar gets used.
- **Rotations:** `npx tsx scripts/train-rotations.ts` searches each spec's damage-ability order against a target dummy (the real cooldowns, costs, procs and combo points; several talent builds per spec) and keeps the order that deals the most damage, in `shared/data/rotations.json`. Bots press their filler in that order; finishers and rage dumps go off at their own thresholds, crowd control is spent on purpose.
- **Player tricks:** casters fake casts (start one and stop it) while an enemy's interrupt is ready and in reach; interrupters wait into a cast before kicking, longer against someone who has faked before; bots step behind pillars, walls or decks to make a long cast at them fail, take cover the same way when hurt (on the walk grid, both floors), take the ramp up to someone on a walkway, and keep sidestepping between casts. How much of each they do is part of the brain (`jukeChance`, `jukeAt`, `kickAt`, `losUse`, `mobility`), so it is trained and learned like the rest.
- **Difficulty:** Easy reacts in about 1.3 s, thinks less often, skips a third of its decisions, interrupts rarely and saves itself late; Normal is in between; Hard reacts in 0.16 s.
- `npx tsx scripts/train-bots.ts` runs bot-vs-bot self-play (a few minutes) in 1v1, 2v2 and 3v3 on every arena in turn, and writes the trained baseline to `shared/data/botbrain.json`. Brains stored by the server are completed from that baseline when they load, so a brain saved by an older version never misses the newer traits.
- Live, the server keeps six brain variants per class, hands one to every bot it spawns, credits each finished match against a human (20 s or longer, no draws) to that variant, and replaces the weakest with a mutation of the best. Variants are stored in the same Upstash store as accounts (memory only without it); `/api/status` shows them.
- After each recorded match the server replays it, measures what every human did (strafing, distance to target, health when using a defensive, healer focus, team focus) and keeps a running per-class human style; each class gets a "human" brain variant pulled towards that style, which only survives if it wins.
- **Learning from being outplayed:** the same replay is studied for how the people beat the bots (`shared/src/outplay.ts`): a bot's casts kicked while a kick was ready on it, the point in a cast people kick at, its own kicks juked by a fake, deaths with a long defensive still ready, deaths to an unanswered burst, long casts taken in the open, time spent in ground effects, a melee bot kited or a caster pinned. Each becomes a lesson for one brain number, counted three times over when the person won. Lessons only push the way they point (a bot that already defends earlier than a lesson asks is left alone). Each class gets a "lesson" variant (the best brain moved towards them, rebuilt after every replay), and new variants are bred towards the lessons, so the population improves in tens of games rather than hundreds. `/api/status` shows each class's real win rate against people by the person's class and the bot's difficulty.
- **Offline, from real replays:** the server keeps the newest 400 matches between people and bots (solo practice included, 30 days each). `npx tsx scripts/study-replays.ts --server https://your.server --code OWNER_CODE` (or `--store` with the Upstash variables, or `--dir` with replay files) plays them back, prints how each bot class is being beaten and its real win rates, and writes `shared/data/players.json`; `--apply` also moves `shared/data/botbrain.json` towards the lessons. `scripts/train-bots.ts` then trains against opponents that play like people of their class (spacing, sidestepping, kick timing, fakes), weighted towards the match-ups bots lose most to people, and `npx tsx scripts/train-bots.ts --calibrate` lists its simulated 1v1 win rates next to the real ones. Only replays recorded on the current game data can be played back, so study after a patch has had some games.

## Files

| Path | Role |
|---|---|
| `shared/data/*.json` | Classes, abilities, auras, specs, talents, cosmetics, arenas, tuning, bot brain, patch notes. All game content lives here. |
| `shared/src/sim.ts` | Headless, deterministic simulation. No rendering, no I/O, no wall clock. Same seed and inputs give the same result. |
| `shared/src/replay.ts` | Recorder and runner that re-simulate a match from its commands. |
| `shared/src/build.ts` | The only place that turns specs and talents (including ability swaps) into numbers; cosmetics only decide the look. |
| `shared/src/describe.ts` | All tooltip text, generated from the same data and modifiers the sim uses (also feeds WIKI.md). |
| `shared/src/bot.ts`, `botbrain.ts` | Bot AI, driven through the same commands a player uses, and its tunable brain. |
| `shared/src/geometry.ts`, `jump.ts` | Movement, collision, line of sight, jumping, walkways and ramps. Used by the server and by client prediction. |
| `shared/src/protocol.ts` | Message types and validation of untrusted client input. |
| `shared/src/accounts.ts` | Ranks, Elo, cosmetics, friends, match records (shared types and rules). |
| `server/src/index.ts` | HTTP and WebSocket entry, `/api/status`, avatars, replay download. |
| `server/src/rooms.ts` | Lobby, queues, parties, duels, rooms, spectators. |
| `server/src/matchmaking.ts` | Pairs queued players and parties into two equal teams. |
| `server/src/accounts.ts`, `store.ts` | Accounts, sessions, owner tools, history, replays, friends; the Upstash/memory store. |
| `client/src/` | Three.js + Vite client: scene and models, HUD and HUD editor, menus, tooltips, audio, spectate and replay viewer, friends panel. |
| `scripts/` | `train-bots.ts` (bot training), `study-replays.ts` (learning from real replays), `train-rotations.ts` and `gen-wiki.ts` (writes WIKI.md). |
| tests | `shared/test`, `server/test` and `client/test`, run by `npm test`. |

## Hosting on Render

The game is built from the GitHub repo `TokeGG/mmoarena` and hosted on Render at https://mmoarena.onrender.com; every push to `main` redeploys it (wait for **Deploy live**, then reload with Ctrl+Shift+R).

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

### Environment variables (Render > Environment)

| Variable | Purpose |
|---|---|
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Free Upstash Redis database so accounts, ratings, history, replays, friends and bot brains survive restarts. (`KV_REST_API_URL` and `KV_REST_API_TOKEN` also work.) Without them everything lives in memory and resets on every restart or redeploy. |
| `ARENA_OWNER_CODE` | Secret that unlocks the owner tools for the founder account (see below). Without it the owner tools are off; set it **before** registering `Toke`. |
| `ARENA_SECRET` | Long random string that signs the guest progress tokens. Without it a public dev secret is used and tokens can be forged. |
| `ARENA_KEY_PREFIX` | Prefix for every database key (default `wowarena:`). It lets this game share the Aim Arena Upstash database without conflicts. Do not change it once accounts exist. |
| `SUGGESTION_WEBHOOK_URL` | A Discord webhook: every suggestion is also posted to that channel (mentions are stripped; an attached note goes as a file). It is a secret: set it in Render, never in the repo. |
| `GITHUB_TOKEN` | Optional. A GitHub token (fine-grained: Contents and Pull requests read/write on this repository) so numbers a dev saves in game also open a pull request against the data files. Without it saved numbers are still live (database overrides), just not proposed for the files. `GITHUB_REPO` (default `TokeGG/mmoarena`) and `GITHUB_BASE` (default `main`) pick where. |
| `ANTHROPIC_API_KEY` | Optional. Turns on **Ask Claude** in the dev panel: a dev describes a change to a skill in plain words and Claude picks new numbers, tried in their match at once. Only the skill's data and the request are sent; only existing numbers can change. `AI_TUNE_MODEL` picks the model (default `claude-opus-5-5`, low effort for quick answers; a safety decline retries on Anthropic's recommended fallback model). Limited to 30 requests an hour per account. |
| `DEV_NOTES_WEBHOOK_URL` | Optional Discord webhook for devs' skill notes (falls back to `SUGGESTION_WEBHOOK_URL`). Notes are also kept in the suggestion box. |
| `PORT` | Port to listen on (Render sets it itself). |

### Upstash setup

1. Create a free Redis database at https://upstash.com.
2. Copy the REST URL and REST TOKEN.
3. Add them as `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in Render and redeploy.
4. Register `Toke` again with the owner code (accounts made while the database was off are gone).

The menu shows a warning while accounts are temporary, and `/api/status` reports `persistent: true` once it works.

## Owner tools

The **🛡 Admin** button (top right, founder account only, the name `Toke`) opens the admin panel (its **Replays** tab lists every match played on the server, bot matches included: watch, save the file, **Train bots** on it (a bot match teaches its losers through its winners), or upload a saved replay file to train on via `POST /api/botlearn/upload`); Profile > **★ Owner** keeps your own style and GIF icon. You must also enter `ARENA_OWNER_CODE` once per session, and the name alone is never enough. Everything is checked on the server, and every admin action is written to the admin log.

- **Dashboard:** online players, queue, matches by kind, uptime, version, live number changes, maintenance state, recent admin actions.
- **Players:** search every account; per player: kick, ban (1 hour to for good, with a reason they see; banning ends their sessions and keeps them from signing in), mute (no suggestions, invites or friend requests), set rating, reset stats, reset password, unlocks and the **dev tag**, a private note, recent matches, follow.
- **Matches:** every running match (private ones too): watch live, pause or resume (it stops counting), end.
- **Moderation:** the suggestion box and skill notes, with delete.
- **Tuning:** live number changes (clear), bot matches.
- **Server:** announcements to everyone online, and **maintenance mode** (nobody but you can start a match; the message is shown and kept over restarts).
- **Log:** the last 300 admin actions.

- **Your own style:** a free-text title (up to 24 characters), colours (gradient and glow), and a **GIF icon** (max 256x256 px and 256 KB) that shows on your nameplate and profile.
- **Accounts panel:** award owner-tier titles, emblems and colours to any player, give a friend a custom title and colours, switch on the **GIF icon ability per friend** (they then upload their own in the same place), and reset a password (a temporary password is shown once and old sessions end).
- **Owner-only looks:** extra cosmetics (Founder's Crown, Void Horns, Dragon Pauldrons, Archon Wings and more) that only the founder account can wear; the server strips them from anyone else's build, but everyone sees them on the owner. They are hidden from everyone else's Look menu.
- **Watching:** the owner watches matches with no delay and gets a scoreboard (button or **B**) with each player's damage, healing, damage taken, healing received and overheal, grouped by team.
- **Server panel:** who is online, how many are queued, and every match running (private ones too): watch any of them live, or end one. **Announcement** sends a message every connected player sees.
- **Bot match:** a private match of bots against bots (1v1 to 3v3, class, spec, difficulty, arena), watched live; it closes when you leave. **Follow** a player from the Watch live window and you are taken into each match they start.
- **Dev tag:** in the Accounts panel, *Dev tools* gives a player the dev tools (the owner always has them). In any match that is not ranked (alone against bots, or with friends in practice, a party match or a duel), **F2** or the **🛠 Dev** button opens them: pause the match (for everyone in it), pick any skill in the match and change any of its numbers (and the numbers of the effects it applies), try them at once (only that match runs on them, everyone in it is told and sees them in tooltips, and it stops counting for progress, replays and bot learning), put them back, or **Save for everyone**: the numbers are applied over the data files on the server (kept in the database, sent to every client) and a pull request with the changed numbers is opened on GitHub (needs `GITHUB_TOKEN`). Merging it makes them a real patch (bump the version, notes, wiki, training as usual); **Live number changes** in this panel lists what is applied and clears it. Each skill shows every buff and debuff tied to it (put on the target or you, procs, auras it consumes or exploits, ones talents add) with where it comes from, what it does and its numbers, plus the talents, specs and buffs that change it. **Keep for my session** puts the numbers into every non-ranked match the dev starts until they clear them or sign out (matches are short). **🤖 Ask Claude** (needs `ANTHROPIC_API_KEY`) takes a plain-words request and tries Claude's numbers in the match. Devs can also send a **note on a skill** to the owner's Discord. Devs see the **Builds** panel (everyone's spec, skills and talents, **N**) in their own matches too.
- Owner and dev tools are never listed in the patch notes.
- **Suggestions:** the owner sees every suggestion under the 💡 Suggest box (with any attached .txt note, up to 10,000 characters) and can delete them.
- There are no co-admins by design (the dev tag only opens the tuning tools). Password reset is the only account recovery.

## Security measures

| Area | Protection |
|---|---|
| Authority | Server-authoritative simulation at a fixed 20 Hz tick; per-viewer snapshot culling; every client message is validated. |
| Accounts | scrypt password hashes, random session tokens in a bearer header (no cookies, so no CSRF), 30-day expiry, rate-limited login and registration. |
| Owner | Founder name plus a secret code entered per session, rate-limited guesses. |
| Avatars | GIF only, checked for size and dimensions on the server and served from a separate path. |
| Replays | Stored compressed with a 30-day expiry and gated by a content hash so a stale replay never plays a wrong fight. |
| Connections | Per-socket message rate limit and message size cap. |
| Storage | All keys sit under one prefix so the database can be shared safely. |

Friend lists live on the account record; who is online is held in memory only, so presence costs no database reads.

## Known limits

- Numbers are tuned with bot duels, not with many humans yet. Retune after you play.
- Matchmaking pairs players in queue order; it does not use rating yet. One rating covers 1v1, 2v2 and 3v3.
- Duels are 1v1 only.
- Characters are rounded primitives with outlines (`client/src/models.ts`); swap for glTF later.
- Replays recorded before a simulation or data change stop playing.

## Change history before 0.47

Patch notes from 0.47 on are in `shared/data/patches.json` (shown in the game's Patch notes). Older notes, kept from the previous README:

**Talents (0.69):** every spec has five tiers of three options (`shared/data/talents.json`). Tiers I and II are the same for every spec of a class; tier III is the spec's own; tier IV (`TRINKET_TIER`) is the trinket slot, shared by every class (`Unit.trinket`, ability class `'trinket'`, key action `trinket`); tier V swaps one bar skill for a class skill (`swap.from`, with `swap.alt` when the player chooses which skill goes, stored in `Build.replace`; `swap.stealth` puts it on a slot only while stealthed, as Sap does on Kidney Shot). The old six-tier tree and its skill swaps were removed; abilities that no longer appear anywhere are kept in the data with `retired: true`. The sim builds the new talents from generic pieces: `proc` (one roll for a group of effects), `cast` (free cast of another ability's effects), `strip`, `dropTargets`, `zoneBuff`, and ability mods `castDuring`, `allyOk`, `before`, `landing`, `gain`, `ticks`, `swapAura`, `shieldPct`, `echo`, stored charges. Old saved builds with six tiers are trimmed to five when loaded.

- **Heal numbers (0.43.4):** base Flash Heal 350 (70 mana, 1.5 s) and Greater Heal 580 (90 mana, 2.6 s). Heals no longer roll random variance (removed in 0.55.4) and scale with talents; tooltips show the base number with your modifiers.
- **Control feedback and Flash Heal (0.43.3):** being stunned, feared, polymorphed or locked out by an interrupt now pulses a coloured glow around the screen edge (red stun, purple fear, blue sheep, gold school lockout), shows a larger banner with the time left, and blacked-out action slots count down their own time. Flash Heal heals 320 (was 160) for the same 70 mana (0.43.4: now 350).
- **Mind Flay beam, Dispersion (0.43.2):** Mind Flay is drawn and described as a continuous beam (same six pulses of damage, still broken by moving or interrupts); Dispersion now cuts damage taken by 90% (was 60%) for its 6 s.
- **Spell queue (0.43.1):** pressing a global-cooldown spell while you are casting or on the GCD holds it (the newest press wins, for up to 3 s) and sends it the instant you are free. Off-global spells like Counterspell still go immediately; ground-targeted spells are not queued.
- **Rogue combo points and mage Shatter / Arcane Charge (0.43):** Mutilate and Sinister Strike each earn 1 combo point (max 5, not tied to a target, and they never decay); payoffs spend all of them and scale with the number spent. Shared rogue kit: Stealth, Vanish, Sprint, Kidney Shot, Kick. **Cutthroat:** Mutilate adds a small bleed (14/s for 6 s), Evasion and Adrenaline Rush are gone, **Garrote** is an instant 100 damage hit plus a 50/s bleed on a 30 s cooldown, and **Exsanguinate** (35 energy, combo payoff) deals 60 per point plus half the bleed damage still on the target, then triples current bleeds. **Duelist:** Adrenaline Rush is now a payoff: 4 s plus 1.5 s per combo point, +60% energy regeneration, 30% faster auto attacks and 2% max health per second. **Shade:** Shadowstep and Sinister Strike, no Evasion, plus **Eviscerate** (110 damage per combo point, no cooldown). Frost Nova and Deep Freeze give you **Shatter** (10 s): your next frost damaging ability does 400% more and uses it up; this replaces the old rooted/frozen vulnerability and Ice Lance shatter. Arcane Blast adds an **Arcane Charge** (max 5, 12 s) and Arcane Barrage spends them for +50% damage each (up to 3.5x). Rogue talent trees were rebuilt for the new bars; bots use Eviscerate at 4+ points.
- **Priest bars (0.42):** Warden (Discipline) has Penance in place of Greater Heal; Lightbearer (Holy) has **Holy Nova** (instant, 60-yard radius: heals every ally in sight for 130 and hurts every enemy for 80, 12 s cooldown) in place of Pain Suppression; Gloomweaver (Shadow) has **Mind Flay** (a 3 s channel of six 45-damage ticks) in place of Smite. Penance is no longer a talent.
- New abilities with the rework: Rogue **Garrote** (a bleed) and **Fan of Knives** (area hit).

- **Damage over time and aimed spells:** Shadow priests get a no-cooldown damage-over-time spell and a bigger, longer one on a cooldown (replacing Dispel Magic). Priests' healing channel (Penance) heals a friend or hurts an enemy depending on who you target. Flamestrike and Blizzard are **aimed at the cursor**: press the key to arm the spell (its slot lights up and a ring follows your pointer), then **click or press the key again to place it**; Esc, casting something else or a stun cancels. The ring only shows while a spell is armed. While steering with the right button the ring sits at the centre of the screen.

- **Rules worth knowing (0.23):** auto-attacks need line of sight like spells; starting another spell cancels the one you are casting (0.38.1: that includes off-global instants like Counterspell, which you can still press mid-cast); Blink works while stunned, feared or incapacitated; Polymorph is limited to one target per caster and the sheep wanders; Fireball is an instant cast on an 8 s cooldown (it was a 1.5 s cast from 0.36); warriors build rage at a third of the original rate in 0.23 and at 0.15 per damage point from 0.31; Smoke Bomb (0.33) drops a 6-yard cloud for 6 s that strips targeting from enemies inside it; melee reach is 3 yards plus a half-yard lag allowance (0.34; measured centre to centre, and it was 5 + 1.5 before); Vanish (0.37) removes every debuff, drops you out of combat, strips enemy targets off you and stealths you; Power Word: Shield and Ice Barrier draw a pale segment on the health bar for the absorb left, plus +N in the frame text (0.38.3); Scorch is a 0.6 s cast you can make while moving, and each cast has a 15% chance to give Hot Streak, making your next Pyroblast instant (0.39); an action slot glows while a proc makes it instant, e.g. Pyroblast under Hot Streak (0.39.1); mage bars (0.40): Frost has Deep Freeze in place of Blizzard and a Shatter mechanic (see 0.43); Fire has Dragon's Breath in place of Frost Nova; Arcane has Arcane Missiles (the old channel), a new instant Arcane Barrage, and its own Arcane Explosion (damage and a 40% slow) in place of Frost Nova and Ice Barrier; the Deep Freeze talent became Elemental Mastery (Frost learns Blizzard, Fire and Arcane learn Evocation); Mage tier 4 is now the Blink tier (0.38): Twin Rift (two blinks per cooldown), Phase Stride (+40% speed for 4 s after blinking) or Arcane Surge (30% faster casts for 5 s after blinking), which replaced the Cone of Cold / Evocation / Dragon's Breath tier (those abilities are gone; Flash Freeze and Inferno Heart were reworked to Frost Nova only and Elemental Fury); damage-over-time ticks no longer break fear; Polymorph (0.38) holds the sheep still, lets it turn, heals it 10% of max health every second and blocks Blink; enemy and ally nameplates show harmful effects with time left; Cheap Shot is no longer on any bar (0.37.1): while stealthed, the Sinister Strike and Mutilate slots turn into it (Duelist, Combat, Shade and Cutthroat), then turn back; Cutthroat gained Adrenaline Rush and Shade gained Evasion in the freed slot; Blind, Psychic Scream and Intimidating Shout all break when the victim takes damage (0.36.1; bots leave a lone feared or blinded enemy alone until it wakes); class balance (0.36: 1v1 bot duels across all four classes, 24 seeds a pairing, hard bots: warrior 45, mage 47 and rogue 52 wins out of 72, fights last 55-75 s and each deals about 3100-3500 damage; mage beats warrior 15-9 and loses to rogue 8-16, rogue and warrior split 12-12; Frostbolt 140, Fireball 210, Smite 170 for 25 mana, Flash Heal 160 for 70 mana, priest mana regen 6; the priest bot now moves, smites and screams like a caster when alone, and bots hunt stealthed enemies; a lone priest still loses 1v1 to every class but lasts 70-110 s and deals 500-1000) and priest balance (0.35.1: a priest could out-heal every class in 1v1 and no bot could ever kill one; Flash Heal 230 to 130 for 80 mana, Power Word: Shield absorbs 200 on a 15 s cooldown, mana regen 8 to 4, 2500 health; rogue Sinister Strike 110, Mutilate 155, Eviscerate 260 — in 24-seed bot duels the rogue, warrior and mage now all beat a priest in roughly 70-100 s); casts, ground spells and swings need the target inside a 90-degree cone in front of your character model, not just on screen: turn away and you stay targeted but cannot cast until you face it again (0.34; bots ignore it); Blink frees you from stuns, roots and slows; stealthed rogues are spotted within 2 yards (0.29), and auto-attack only swings from stealth at that range, breaking it.
- **Fog:** enemies you cannot see (stealthed or farther than 8 yards) are left out of your snapshots entirely.

**0.69 owner and dev tools:** dev "send" no longer goes live: `dev_save` stores a proposal (`DevTools.propose`, store key `devproposals`) that the admin panel's Tuning tab lists, stacked, with each number's old and new value; the owner ticks proposals and opens one pull request with them, makes them live, or dismisses them (`admin_proposals`). Bans and mutes take a number of minutes (00 = for good); `admin_act kill` kills a player in their match; the bot battle starts from the main menu's robot button; the debug window (F2) can rebuild a bot's class and talents (`dev_bot`, `ArenaSim.rebuildUnit`). Bot training from replays starts at once as a job (`train_status` pushes progress and the time left; the measure worker is now a small pool, so a batch runs in parallel) and the learner's new brains are used by the next bots that spawn, with no offline step; `scripts/train-bots.ts` is still how brains are committed to `botbrain.json`.
