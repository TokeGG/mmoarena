# WoW-style Arena (browser phase) · v0.9.0

Third-person 3D arena combat in the style of WoW arena: tab-target, global cooldown, cast times, interrupts with school lockouts, crowd control with diminishing returns, line-of-sight pillars, stealth. The server decides every outcome; the browser is a renderer and input device.

## Run it locally

```bash
npm install
npm run dev:server        # game server on :8080
npm run dev:client        # Vite on http://localhost:5173 (proxies /ws to :8080)
```

Production (one process serves the client and the WebSocket):

```bash
npm run build && npm start     # uses $PORT, default 8080
```

## Deploy: GitHub + Render

1. Push the **contents** of this folder so `package.json` and `render.yaml` sit at the repo root (not inside a `wow-arena/` subfolder). Leave Render's Root Directory blank. Commit `package-lock.json` too (it appears after your first `npm install`).
2. Render: **New + → Blueprint**, pick the repo. `render.yaml` already sets Node, the Virginia region, the build and start commands and the health check. Or create a **Web Service** by hand with:

| Setting | Value |
|---|---|
| Runtime | Node |
| Region | Virginia |
| Build command | `npm install --include=dev && npm run build` |
| Start command | `npm start` |
| Health check path | `/healthz` |

3. Open the Render URL. The same service serves the page and the WebSocket (`wss://<host>/ws`), so there is nothing else to configure and no CORS to set up.

The free tier sleeps when idle, so the first visit after a while takes about a minute to wake. That is fine for testing with friends but not for a live queue.

## Builds, gear and progress

- **Specs:** 3 per class (e.g. Frost/Fire/Arcane), each with its own 6-ability bar and passive modifiers. **Talents:** 3 tiers, one pick per tier.
- **Gear:** 5 slots, 4 tiers (Initiate, Veteran, Elite, Gladiator), 4 flavors. Tiers unlock by finishing matches (0 / 3 / 8 / 15); each stat bonus is capped at 15%, so higher tiers are a small edge.
- **Arenas:** three maps with different layouts and looks (Dusk Colosseum, Sunken Ruins, Frostkeep Pit; data in `shared/data/arenas.json`). Pick one in the menu or leave it on Random. In the queue, players who chose an arena only play there and Random players fill in; the menu previews the chosen arena. Adding a map = a new JSON entry (+ an optional theme in `client/src/arenaMap.ts`).
- **Accounts and ranked ladder:** players can register with a username + password (scrypt-hashed, 30-day session token). Signed-in players get a server-side profile: Elo rating (start 1000; Bronze/Silver/Gold/Platinum/Diamond/Gladiator), wins/matches, unlockable emblems/titles/name colours shown on nameplates, and a leaderboard. Only the queue ("Ranked 2v2") moves rating; leaving a live ranked match is a loss. Guests still play with browser-local progress.
  - **Settings follow the account:** HUD layout and style, keybinds, sensitivity, class, builds and practice options are saved to your account automatically and applied on any device after you sign in (the page reloads once). Guests keep settings in the browser only.
  - **Owner account:** the name `Toke` carries the founder role and exclusive titles, emblems and glowing name colours. Anyone can claim a free name, so set `ARENA_OWNER_CODE` on Render to a secret: registering `Toke` then requires that code. Register the account as soon as you deploy.
  - **Persistence:** create a free Upstash Redis database and set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (the Vercel-style `KV_REST_API_URL`/`KV_REST_API_TOKEN` also work) on Render. Without them accounts live in memory and reset on every restart (the server logs which store is in use).
- **Progress without a database:** the server signs a token with your match count; the browser stores it and sends it on join. **Set the `ARENA_SECRET` env var on Render** to a long random string, otherwise a public dev secret is used and tokens can be forged.
- A match counts only if it was live 20 s or more, was not dummy practice, and you did not forfeit.
- **Tooltips:** hover abilities, buffs/debuffs, specs, talents, gear, stats and classes (numbers reflect your build).
- **Main menu:** character-select layout with a live 3D preview of your class behind it.

## Practice with bots

The join screen has three practice options: opponents (any 1 or 2 classes), your partner (a bot of any class, or none), and bot skill.

| Skill | What changes |
|---|---|
| Dummies | They stand still and do nothing. Good for checking numbers and visuals. |
| Easy | Slow reactions, answers about 40% of your casts with an interrupt. |
| Normal | About 0.4s reaction, interrupts most casts. |
| Hard | About 0.16s reaction, interrupts everything it can. |

Bots use the same entry points as a human (move, target, cast), so they obey the global cooldown, range, line of sight, resources, lockouts and stealth. They path around pillars, interrupt casts, dispel crowd control off their partner, polymorph the enemy that is not the kill target, and stun or kick casters.

## Tests and balance runs

```bash
npm test                  # sim rules, bots, protocol validation, real WebSocket end-to-end
npm run duel              # headless bot-vs-bot win rates for every composition
npm run duel -- 30 hard   # 30 seeds per matchup, hard bots
```

`npm run duel` measures how the bots' playbook performs, not how humans will. Use it to catch broken classes, stuck bots and wildly lopsided numbers, then tune `shared/data/*.json`.

## Layout

| Path | What it is |
|---|---|
| `shared/data/*.json` | Classes, abilities, auras, arena, tuning. All game content lives here. A future Godot/Unity client or server reads the same files. |
| `shared/src/sim.ts` | Headless simulation. No rendering, no I/O, no wall clock. Same seed and inputs give the same result. |
| `shared/src/bot.ts` | Bot AI, driven through the same commands a player uses. |
| `shared/src/geometry.ts` | Movement, collision, line of sight. Used by the server and by client prediction. |
| `shared/src/protocol.ts` | Message types and validation of untrusted client input. |
| `server/` | Node + `ws`. 20 Hz tick, practice rooms, 2v2 queue, per-socket rate limit. |
| `client/` | Three.js + Vite. Orbit camera, HUD, prediction for own movement, interpolation for everyone else. |

## Design rules

- The client sends intents only (`cast X on Y`, movement input). It never decides hits, cooldowns or damage.
- Own movement is predicted and reconciled against the server. Abilities are not predicted.
- Enemy units you cannot see (stealthed, farther than 8 yards) are left out of your snapshots entirely.
- Gear is a capped multiplier (`gearCap` in `tuning.json`, 1.15). Matchmaking is by rating, never by level, so nobody gets nerfed for being stronger.

## Controls

Defaults: RMB-drag steer · LMB-drag orbit camera · W/S move · Q/E strafe · A/D turn (strafe while RMB held) · wheel zoom · Tab next enemy · click to target · 1-6 abilities · R auto-attack.

**Esc** clears your target first, then opens the menu (Resume, Controls, mouse sensitivity, Leave match). In **Controls** click a box and press a key; every action has two slots, right-click clears a slot, binding a key that is in use moves it, and Esc itself is reserved. Bindings and sensitivity are saved in the browser. The same screen is on the join page under "Controls & keybinds".

## Known gaps

- Numbers are a first pass. Bot-vs-bot runs say mages are weak against melee, two-healer teams stall, and matches with a healer run long. Treat that as a starting point and retune after you play.
- Warriors and rogues need auto-attack on (R, or any melee ability) to build rage and deal steady damage.
- No rating or Elo yet, no spell queueing window, no silence or combo points.
- Bots and dummies still use the classic ability bar and neutral gear; only humans get specs, talents and gear. New spec/ability numbers are untested against human play.
- Characters are built from rounded primitives with ink outlines (`client/src/models.ts`): horned plate warrior with glowing-edged sword and shield, robed mage with bent hat and a floating arcane orb, priest with spinning halo, light wings and mace, hooded rogue with venom daggers. The world has bloom, colour grading, a low golden-hour sun, mountain ridgelines, dust motes and brazier embers (`scene.ts`, `arenaMap.ts`). None of this has been tuned on a real GPU yet. Swap for glTF later.
