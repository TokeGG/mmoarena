# How the bots learn

A plain-language guide for the owner. The exact details live in `DEVELOPING.md` ("Bots and learning") and in the code; this is the whole picture in one place.

## The 30-second version

- A bot is **rules + a brain + a rotation**. The rules are code (what a bot *can* do). The brain is **34 numbers** that decide how it *chooses* (how early it defends, how much it strafes, when it bursts). The rotation is the order it presses its damage buttons.
- **Learning only changes the brain numbers** (and which brain a bot is handed). It does not write new behaviour. If you want a bot to do something it has no code for, that is a code change.
- The best teacher is **real matches with people**. When a match with people ends, the server replays it, watches every bot tick by tick, and asks: *what did the person do that beat this bot, and what did the bot do wrong?* Each answer nudges one or more brain numbers a small, capped amount.
- Bots are also **tested live**: each class keeps six brain variants, every new bot is handed one, wins and losses against people are counted, and the weakest variant is replaced by a mutation of the best. Winners get picked more often.
- The learned brain stays on the server until you press **Commit learned bots to GitHub**, which makes it the shipped brain for every future deploy.
- The older offline training (`scripts/train-bots.ts`) is **bot against bot in the simulator**. That is *not* learning from live play, and it now refuses to overwrite the brain unless real player data exists.

## 1. What a bot is made of

| Layer | What it is | Where it lives | Does it learn? |
|---|---|---|---|
| **Rules** | What a bot is able to do: cast, kite, interrupt, use cover, heal, use the trinket | `shared/src/bot.ts` | No. Only changed by code. |
| **Brain** | 34 numbers on a fixed scale: `defHp`, `panicHp`, `strafe`, `mobility`, `burstUse`, `peelAt`, `trinketAt`, `shieldAt`, `healAt`, `kickAt`, `jukeChance`, `losUse`, `dodge`, `stayNear`, `edgeCare` and the rest | `shared/data/botbrain.json` (shipped), the server's store (live) | **Yes. This is what learning changes.** |
| **Rotation** | The order each spec presses its damage abilities | `shared/data/rotations.json` | Not from matches. It is computed by `scripts/train-rotations.ts`, which searches orders against a target dummy using the real cooldowns, costs and combo points. |
| **Difficulty** | Easy, Normal, Hard: reaction time (about 1.3 s, in between, 0.16 s), how often it thinks, how much it skips | `shared/src/bot.ts` | No. |
| **Talents** | A random pick in most tiers, so every skill gets played | `botBuild` | No. |

Every brain number has a safe range (`BRAIN_BOUNDS`) and a default. A number can never leave its range, and an older saved brain that lacks a newer number simply reads the default.

## 2. Where the training data comes from

| Source | Real play? | Value | Notes |
|---|---|---|---|
| **A match with people against bots** (practice, party, anything counted) | Yes | **Highest.** | Studied automatically after every counted match. This is the live game review. |
| **A match with people in it, forced** (the owner's "train on this replay" or "train on all archived replays") | Yes | High. | Same study, with 1 to 5 passes so the evidence counts more. |
| **Bot against bot** (owner bot matches, with *train on every match* switched on) | No | Low. | The loser learns from the winner. Off by default because bots beating bots mostly teaches bots to beat bots. |
| **Offline self-play** (`scripts/train-bots.ts`) | No | Weak. | Mutate and score brains in the simulator. It now needs real player data in `shared/data/players.json` or an explicit `--allow-sim-only`. |

Honest status of the shipped brain: until the first **Commit learned bots**, `botbrain.json` is the result of older self-play training and `players.json` is empty. Real learning only exists on the live server until you commit it.

## 3. The live loop, step by step

1. **A match ends.** Every match is recorded (positions, inputs, seeds), so it can be replayed exactly.
2. **The server decides whether to study it.** A match counts if people played it out (20 seconds or longer, no draw). Bot-only matches are studied only when the owner's *train on every match* switch is on. A replay recorded on older game data is refused (it would not play back the same).
3. **The replay is played back** in a worker, and every bot (and every person) is measured tick by tick.
4. **Three kinds of evidence come out of that** (section 4).
5. **Evidence becomes brain nudges** with strict limits (section 5).
6. **The class gets a "lesson" brain**: the best current brain moved toward the evidence. It joins the six-variant population and plays a share of the games until it wins its way up.
7. **Results are credited.** When a bot finishes a game against people, its variant gets the result. A bot that lasted long and kept its health in a loss, or won with health to spare, counts for more than a win or loss alone.
8. **The population evolves.** After about 36 results (every variant needs a few games), the weakest variant is replaced by a mutation of the best, pulled part of the way toward the lessons. Older records are halved so recent play matters more.
9. **Every new bot is handed a variant** by weighted sampling (Thompson sampling): variants that win get picked more, but uncertain ones still get tried.
10. **A report is written.** What was studied, what mistakes were found, which numbers moved (before to after), or an honest "nothing to learn because ...". It goes to the admin log and the admin panel.
11. **You decide when it ships**: **Commit learned bots to GitHub** writes the learned brains and the human-style data into the repo as one patch.

## 4. What the bots learn from

### A. Countable mistakes (21 kinds)

Each has a measurable signal in the replay and one brain number it teaches. Losing to a person counts about three times as much as winning against one.

| What the replay shows | Brain number it teaches | The change |
|---|---|---|
| Its casts get kicked while a kick was ready on it | `jukeChance` | Fakes more casts |
| People kick its casts at a certain point | `jukeAt` | Stops its fakes before that point |
| Its own kicks hit nothing after a person faked | `kickAt` | Kicks later, past their fakes |
| Dies with a long defensive still ready | `defHp`, `panicHp` | Defends earlier |
| Dies to a burst it did not react to | `dangerAt` | Treats smaller bursts as danger |
| Long casts keep landing on it in the open | `losUse` | Uses pillars and cover more |
| Keeps standing in ground effects | `dodge` | Walks out sooner |
| Melee bot is kited; caster bot is pinned | `chase`, `mobility`, `rangeBias` | Chases, keeps moving, keeps distance |
| Locked down 1.5 s or died with the trinket ready | `trinketAt` | Uses the trinket sooner |
| Died with an offensive cooldown ready | `burstUse` | Pops cooldowns earlier when losing |
| Caster stood still with melee on it and a push-off ready | `peelAt` | Uses Frost Nova, Psychic Scream and similar sooner |
| An ally died with the shield or Pain Suppression ready | `shieldAt`, `healAt` | Healer shields and heals sooner |
| An ally under 40% and the healer did nothing | `healAt` | Healer reacts sooner |
| Heals wasted on allies at full health | `healCap` (down) | Stops healing nearly full allies |
| Dropped a target under 30% | `switchHp` | Finishes it |
| Kept hitting a target it could not hit | `stickiness` (down) | Leaves such targets sooner |
| Casts lost to no line of sight | `losCheck` | Stops the cast faster |
| Casts lost to range | `rangeBuffer` | Keeps inside max range |
| Crowd control into diminished or immune targets | `drRespect` | Keeps crowd control off them |
| Out of mana in a fight | `spendBias` | Saves mana, uses Evocation sooner |
| (Group, movement and lava) | `stayNear`, `edgeCare` | See the graded signals below |

Not measured, and why: using high ground when kited (no clean yes or no in a replay), crowd control on the "wrong" target (the replay cannot say which was right), and crowd control chains (the sim already refuses most of them).

### B. Graded signals (so every fight teaches something)

Even a fight with no clear mistake is measured as **rates**, compared against the person who fought the bot, measured the same way:

- **Movement:** time standing still, time in an enemy's sight, line-of-sight breaks per minute, sidestepping, distance to its target, time out of its healer's reach, seconds in lava.
- **Gameplay:** burst cooldowns idle while an enemy was in reach, health when defensives were pressed, target changes per minute, health when the trinket was used.

Any difference above a small floor becomes a nudge toward how the person played (4% of the number's range at full strength, half that for a win). That is why the report no longer says "they already play what they learned": a fight is only reported as teaching nothing if it was under 8 seconds, no bot fought a person, or the bots played it exactly as the people did.

### C. How people play (the "human" variant)

The replay is also used to learn how people of each class actually play: spacing, strafing, kick timing, fakes, how early they defend. That is kept as a running per-class **human style**, and a "human" brain variant is pulled toward it. It only survives if it wins.

## 5. The safety limits (why it cannot go off the rails)

| Limit | Value |
|---|---|
| One replay moves a number at most | one fifth of its range (times the passes, up to three) |
| A number can drift from the shipped brain at most | 60% of its range (widened by 10% at a time to 95% when needed) |
| Every number | stays inside `BRAIN_BOUNDS` |
| Lessons only push one way | a bot that already defends earlier than a lesson asks is left alone |
| Evidence | adds up per class across replays; older evidence fades 8% with each new lesson for the same number |
| A short fight | under 8 seconds teaches nothing; a result under 20 seconds is not counted |
| Draws, forfeits, replays from an older game version | ignored (and counted, so you can see them) |
| Learned brain | has to **win its way up** as a variant; it is not trusted blindly |

## 6. How you see and steer it (admin panel, Bot training tab)

- **Live learning box:** matches studied (with people and bot-only), per class, when the bots last learned, the learned variant's win rate, the bots' real win rate against people, and an **amber warning when the server's store is the in-memory fallback**.
- **What the bots know:** per class, the learned numbers against the shipped ones, how many replays taught the class, last learned, variant win rates.
- **Reports:** every study writes an expandable report (mistakes by type with counts, numbers that moved) in the queue and in the admin log, even when nothing moved.
- **Buttons (owner only):** train on one replay (1 to 5 passes), **train on all archived replays**, the *train on every match* switch, **reset the learned brain to shipped defaults**, and **Commit learned bots to GitHub**.
- **Devs** can see the status. They cannot train, reset or commit the bots.

## 7. Turning learning into a release

1. Let the bots play real matches with people for a while.
2. Open the Bot training tab, read the reports and the win rate against people.
3. Press **Commit learned bots to GitHub**. It writes `botbrain.json` (per class: the lesson brain, or a variant with 30 or more games against people that beats it by 5 points) and `players.json` (the human style and real results, merged over the file so a restarted server never wipes earlier data).
4. It is one commit and also a patch: "Bots learned from live matches", one line with the number of matches studied, the version's last number plus one, and `SIM_REVISION` plus one. It refuses if no match with people was studied since the last commit.
5. Render deploys it; every bot spawns with the new baseline.

## 8. Things that limit it (read this)

- **The database must be persistent.** Without Upstash Redis (`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in Render) everything learned lives in memory and is **lost on every restart or deploy**, including the counters and variants. The admin panel warns about this. Pressing Commit before a deploy saves it.
- **It needs people.** With few players, evidence builds slowly (tens of matches per class to move things noticeably). Bot-only matches are a weak substitute.
- **Patches invalidate old replays.** A replay only plays back on the exact game data it was recorded on. After a balance change (including a dev commit) older archived replays cannot be studied; each new match is studied the moment it ends, so live learning keeps working.
- **It tunes judgement, not skill.** Brain numbers change *how readily* a bot does something it already knows. New mechanics (Mirror Image behaviour, a new ability) need rules in `bot.ts` first.
- **Win rates are noisy.** A handful of games proves little; the variants need dozens of results against people before the ranking means anything.
- **Rotations are separate.** They are recomputed by `npx tsx scripts/train-rotations.ts` after ability changes, not learned from matches. Only Fire mage and the three warrior specs were recomputed for the newest changes; the other specs still use older rotations.
- **Self-play is not live learning.** `scripts/train-bots.ts` is a simulator tool; with no human data it refuses to overwrite the brain unless you pass `--allow-sim-only`.

## 9. A good routine

| When | What |
|---|---|
| Always | Keep the Redis keys set in Render |
| Weekly (or after a busy night) | Read the Live learning box; if people matches were studied, press **Commit learned bots** |
| After a balance change | Expect older replays to be unusable for study; new matches still teach immediately |
| After new abilities | `scripts/train-rotations.ts`, and add rules in `bot.ts` so bots use the new skills; the per-spec bot test checks every skill gets used |
| Something looks wrong | **Reset learned brain** (admin panel) puts every class back on the shipped brain |

## 10. Quick answers

- *"It says nothing to learn."* The match was too short, no bot fought a person, the bots already play at or past what the lesson asks, or the mistakes were too few to teach yet. The report says which.
- *"Do the bots learn from my devs' balance changes?"* They adapt to the new numbers by being tested against people on them. Their rotation needs a retrain for new damage orders.
- *"Is it learning from the sim?"* Only the old offline script does, and it is now fenced off. The live loop uses real recorded matches with people.
- *"How long until I see a difference?"* The lesson brain moves after every studied match; a visible change in win rate against people takes tens of games per class.
