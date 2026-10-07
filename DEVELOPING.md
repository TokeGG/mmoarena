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
```

`npm run duel` measures how the bots' playbook performs, not how humans will. Use it to catch broken classes and wildly lopsided numbers, then tune `shared/data/*.json`.

## Project rules

The full list is in [CLAUDE.md](CLAUDE.md). In short:

- **Replays:** whenever simulation code (`shared/src/sim.ts` and anything it uses) or game data changes, bump `SIM_REVISION` in `shared/src/replay.ts`, otherwise older replays would play out differently. Replays are also gated by a hash of the data files, so a stale one says so instead of showing a wrong fight.
- **Versions:** bump the version in README line 1, the root `package.json` and `client/package.json` together (kept below 1.0), and add the matching entry at the top of `shared/data/patches.json` (the in-game Patch notes; a test checks the versions agree).
- **Bots:** a change to abilities, specs, talents, weapons or class mechanics also updates `shared/src/bot.ts` so bots use the new skills, and the per-spec bot test must pass. Then re-train (below) and commit `shared/data/botbrain.json`.
- **Wiki:** after changing abilities, auras, specs, talents or tooltip wording, run `npx tsx scripts/gen-wiki.ts` and commit `WIKI.md`.

## Bots and learning

- Bots play from a tunable brain (cover and defensive thresholds, strafing, healer priority, focus fire, kiting range, heal timing, burst timing, chase, ground-zone dodging, pre-shielding).
- `npx tsx scripts/train-bots.ts` runs bot-vs-bot self-play (a few minutes) and writes the trained baseline to `shared/data/botbrain.json`.
- Live, the server keeps six brain variants per class, hands one to every bot it spawns, credits each finished match against a human (20 s or longer, no draws) to that variant, and replaces the weakest with a mutation of the best. Variants are stored in the same Upstash store as accounts (memory only without it); `/api/status` shows them.
- After each recorded match the server replays it, measures what every human did (strafing, distance to target, health when using a defensive, healer focus, team focus) and keeps a running per-class human style; each class gets a "human" brain variant pulled towards that style, which only survives if it wins.

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
| `scripts/` | `train-bots.ts` (bot training) and `gen-wiki.ts` (writes WIKI.md). |
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
| `PORT` | Port to listen on (Render sets it itself). |

### Upstash setup

1. Create a free Redis database at https://upstash.com.
2. Copy the REST URL and REST TOKEN.
3. Add them as `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in Render and redeploy.
4. Register `Toke` again with the owner code (accounts made while the database was off are gone).

The menu shows a warning while accounts are temporary, and `/api/status` reports `persistent: true` once it works.

## Owner tools

Profile > **★ Owner**, founder account only (the name `Toke`). You must also enter `ARENA_OWNER_CODE` once per session, and the name alone is never enough. Everything is checked on the server.

- **Your own style:** a free-text title (up to 24 characters), colours (gradient and glow), and a **GIF icon** (max 256x256 px and 256 KB) that shows on your nameplate and profile.
- **Accounts panel:** award owner-tier titles, emblems and colours to any player, give a friend a custom title and colours, switch on the **GIF icon ability per friend** (they then upload their own in the same place), and reset a password (a temporary password is shown once and old sessions end).
- **Owner-only looks:** extra cosmetics (Founder's Crown, Void Horns, Dragon Pauldrons, Archon Wings and more) that only the founder account can wear; the server strips them from anyone else's build, but everyone sees them on the owner. They are hidden from everyone else's Look menu.
- **Watching:** the owner watches matches with no delay and gets a scoreboard (button or **B**) with each player's damage, healing, damage taken, healing received and overheal, grouped by team.
- **Suggestions:** the owner sees every suggestion under the 💡 Suggest box (with any attached .txt note, up to 10,000 characters) and can delete them.
- There are no co-admins by design. Password reset is the only account recovery.

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

**Talents belong to your spec (0.41):** each of the 12 specs has its own six tiers, three options each, tailored to what that spec does.

- **Tier I (shared, 0.41.1):** the same three talents for all three specs of a class; they only modify the skills every spec of that class has (for example Mage: Polymorph, Counterspell, Blink). Your tier I pick carries over when you change spec.
- **Tiers II and III:** buffs for that spec's own abilities (damage, healing, cooldowns, longer slows and stuns, survivability). Tier III is the utility tier; for mages it is the **Blink tier** (two blinks per cooldown, a run-speed burst after blinking, or faster casts after blinking).
- **Tiers IV, V and VI (skill replacements):** each choice adds an ability that takes the place of one bar slot (tier IV, V and VI each replace a different slot, so you can take all three; the tooltip says what you give up). Every spec has nine abilities it can bring in this way. Switching spec clears your talent picks.
- **Party matches (0.46.0):** with two or three friends in a party, the leader gets a **Party match** button: a friendly (unranked) match for the whole party. Each party chip has a Team 1 / Team 2 button (click your own to switch; sides start balanced), everyone must be Ready, and bots fill the empty places on each side at the chosen Bot skill. If more friends pick one side than the chosen team size, the match grows to fit (three friends on one side is a 3v3), so nobody is left out. Ranked and Find match still queue a party that is bigger than the team size as separate players.
- **Lag compensation and watching (0.45.0):** every cast now carries the server time of the frame you were looking at; the server keeps the last 12 ticks of positions and judges range, minimum range and facing against where the enemy stood on your screen (rewind capped at 300 ms, roughly your ping plus the 100 ms render delay; allies and your own position are never rewound, and line of sight, cooldowns and damage use live state). The rewind is written into the replay, so replays reproduce it exactly, and the 150 ms retry from 0.44.0 still covers what is left. Every match with a player in it can be watched (not just ranked): the list shows ranked ones with a trophy; solo dummy training stays private.
- **Server feel (0.44.0):** a player cast that fails only on range or facing is now held for 150 ms (`castGraceMs`) and retried every tick, so a target that was in reach on your screen but stepped away in transit still gets hit; a different press replaces the held cast, and bots and training dummies are never held. Measured server cost is tiny (a 3v3 tick is about 0.03 ms of sim plus 0.3 ms of snapshots, around 58 KB/s per client). Stealth no longer slows movement; feared units now stumble at 35% of run speed (was 50%). Heal floating text shows what landed plus a dim "N overheal" line, so a Flash Heal that rolls 323-378 on a target missing 250 shows +250.
- **Combo points (0.43.5):** combo points no longer drain out of combat. Kidney Shot is now a combo payoff (25 energy, 30 s cooldown): it stuns for 3 s plus 1 s per point spent, so 4 s on 1 point up to 8 s on 5 (diminishing returns still apply). Bots use it at 3+ points. **Dispersion (0.43.5)** can be used while stunned, feared or silenced (not while polymorphed) and removes every root and slow when cast; while it lasts you cannot use any ability (all slots black out).
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
