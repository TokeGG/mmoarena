# Netcode study: what limits input feel, what a higher tick rate buys and costs

Status: measurements and a plan; Stage 1 (section 7) is implemented in 0.69.4, results in section 9; Stage 2 (the sim at any tick length, 62.5 Hz switchable by `ARENA_TICK_MS`, dead reckoning of other players) is implemented in 0.69.4 too, results in section 10. The sections before it describe the code as it was when measured. Line numbers are for the tree at the time of writing; `client/src/main.ts` was being edited by other work at the same time, so for it the function name is the stable reference.

## 0. Verdict in ten lines

1. **What limits "input feel" today is not the 20 Hz tick, it is three specific things.** (a) The own character is drawn up to one tick behind its own prediction: key press to first movement on screen is **47 ms** at 20 Hz and can be **24 ms with a client-only change**. (b) Other players are drawn `one-way latency + 100 ms` old (**155 ms** at 50 ms one-way, 0.76 u of positional error at run speed, p95 1.1 u), of which the 100 ms buffer is the part we control. (c) On any link with packet loss the server's per-player input queue grows to 4 to 5 ticks after the first stall and **never drains** (`shared/src/sim.ts:199-208, 491-503`): the server then acts on a position about 200 ms old and range checks go wrong (p95 error 1.4 u instead of 0.13 u; 4.6 % wrongly refused, 6.4 % wrongly accepted at 1 % loss).
2. **Higher tick rate buys less than it looks like.** Clean 50 ms / 10 ms jitter link, stage-1 fixes applied in both cases (two-snapshot buffer, smoothed clock): going from 20 Hz to 62.5 Hz moves the shown age of other players from 116 to 82 ms (mean staleness 0.57 to 0.41 u), local input to screen from 47 to 35 ms (24 to 23 ms once the own character is drawn ahead, so the tick rate adds nothing there), input to server-confirmed from 175 to 140 ms. 62.5 to 125 Hz buys another 16 ms (0.08 u) and nothing at the server round trip.
3. **Server CPU does not double with the rate, it grows 1.9x (20 to 60 Hz) and 2.9x (to 120 Hz)** for a 3v3 room with bots (41 -> 78 -> 121 ms of CPU per second of match) and 2.4x and 3.4x for a 3v3 of humans (15 -> 35 -> 51 ms). Hard bots are 58 to 66 % of a bot room. Bandwidth with today's JSON snapshots scales linearly: 74 KB/s per client at 20 Hz becomes 234 KB/s at 60 Hz and 472 KB/s at 120 Hz for a 3v3 (about 10 GB per hour of egress for one 3v3 room at 120 Hz, against 1.6 GB at 20 Hz).
4. **120 Hz (or 128): NO-GO.** The gain over 62.5 Hz is 16 ms, the cost is +45 to 55 % CPU, 2x bandwidth with the current snapshots, 2.5x the replay size of 62.5 Hz, a buffer so small (16 ms) that 2.4 % of frames underrun at 10 ms jitter on a clean link and 24 % on a link with 1 % loss, a server loop that cannot hold it as written (23 % of callbacks fire two ticks at once), and a rate limiter that would disconnect every client. Of the high rates only 128 Hz (7.8125 ms) keeps exact floating point time; 120 Hz (8.33 ms) lost a DoT tick in the rules test, so a "120" would have to be 125 Hz (`tickMs` 8).
5. **60 Hz (use `tickMs` 16 = 62.5 Hz, not 16.67): GO as stage 2, after stage 1.** It needs a Render Starter instance (0.5 vCPU) for about the player count we have today, the sim becomes tick-length independent, and everything tuned at 20 Hz (bots, rotations, replays) is retrained. Stage 1 (below) delivers about as much of the felt improvement (others 39 ms fresher, own character 23 ms faster, no 150 ms penalty after a lossy blip) with no hosting cost and no retraining.
6. **Do not do** snapshot rates above the sim rate (20 Hz sim with 40/60 Hz "fill" snapshots): measured, zero gain (the path is the same piecewise-linear path, and the fill costs one tick of extra age).
7. Sections 7 and 8 are the implementation plan, ready to hand over.

## 1. How data flows today

### Client (`client/src/main.ts`)

- **Sampling and send rate.** The render loop (`requestAnimationFrame`, `dt` capped at 0.25 s, ~line 934) feeds an accumulator: `acc += dt; while (acc >= DT) { acc -= DT; fixedStep(); }` (~1031). `DT = TUNING.tickMs / 1000` (line 41). So inputs are produced in step with the display frames, in bursts when a frame is late (a 250 ms hitch gives 5 inputs at once at 20 Hz and 15 at 60 Hz). Each step reads the *current key state* (`controls.sample`, `client/src/input.ts:174`): a key tap shorter than a tick can be missed; there are no key events with timestamps.
- **Message.** `{t:'input', seq, fwd, strafe, facing, jump?}` as JSON text, one WebSocket message per tick (`fixedStep`, ~580; `send` at 256). About 20 messages/s.
- **Prediction.** `applyInput` (~560) calls the shared `stepMovementL` with the same speed, `DT`, arena and level as the server, so the prediction is bit-exact except for the server's rounding of the input (`fwd`/`strafe` to 0.01, `facing` to 0.001, `sim.ts:202-205`). It keeps `pending` (inputs not yet acknowledged, max 60 = 3 s at 20 Hz, line 595).
- **Reconciliation** (`onSnapshot`, ~478-510): set `pred` to the server position, drop `pending` up to `me.lastSeq`, replay the rest. There is **no threshold and no smoothing at this point: it always snaps `pred`** and relies on the drawing layer to hide the difference: the drawn position is `prevPred -> pred` blended by `acc/DT` and eased towards with `1 - exp(-dt*38)` (~1047-1068; 5/s while controlled by crowd control). If the correction is larger than 4 units the drawn position teleports. In practice the correction is below 1 cm (rounding) on a clean link.
- **Interpolation of others** (`interpolate`, ~606): `renderTime = estimatedNow() - 100 ms` (`INTERP_DELAY_MS`, line 44; ~1042: `max(100*rate, 60)`), pick the two snapshots around it and lerp x, z, y and facing (shortest-arc). **No extrapolation**: if `renderTime` is past the newest snapshot the unit freezes at it. 30 snapshots are kept.
- **Clock** (`estimatedNow`, ~750): `latest.time + (performance.now() - latestAt)`, i.e. the server time label of the **most recent snapshot** plus local time since its arrival. No smoothing and no round-trip measure (there is no ping/pong message in the protocol, so the client does not know its latency). Because it is anchored on the arrival of the last snapshot, it equals "server now minus the one-way delay of that snapshot", and every late snapshot moves the clock.
- **Lag compensation** (`viewTime`, ~736): casts carry `vt = round(estimatedNow() - 100)`, exactly the server time of the frame the player was looking at (when the buffer is the fixed 100 ms; any change to the delay must change this too).

### Server

- **Loop** (`server/src/index.ts:246-262`): one global `setInterval(10 ms)` with an accumulator (`acc += now - last; while (acc >= TICK && n < 5) lobby.tick()`), so a late timer fires extra ticks instead of slowing the game, and a backlog above 5 ticks is dropped. It is a fixed step, but the *wall-clock* spacing of ticks is quantised to the 10 ms timer: measured spacing is 50.0 ms +- 3.7 ms (sd) at 20 Hz.
- **Input** (`server/src/rooms.ts:376` -> `ArenaSim.queueInput`, `shared/src/sim.ts:199-208`): rounded, pushed on the unit's `inputQueue`, **cap 5, the oldest is dropped when it overflows** (so a dropped input is a hole the client must be corrected for). `tickUnit` (`sim.ts:491-503`) takes **exactly one** input per tick; with an empty queue it repeats the last input for up to 3 ticks (`starve < 3`) and then stops the unit. Duplicates are not detected (a repeated `seq` would simply be played again); there is no early/late concept: whatever arrives next is the next step. Nothing ever consumes more than one per tick, so a backlog never shrinks (finding 1).
- **Step order** (`rooms.ts:516-548`): bots queue their input, `sim.step()`, events drained, then one snapshot per *team* is built (`sim.snapshot(team)` with fog culling) and sent as one JSON string to every player of that team. Snapshot every tick, no delta. `lastSeq` of each unit rides in its own `UnitSnap`.
- **Abilities and auto-attacks resolve on the server only**, and **immediately on message arrival** (`rooms.ts:384-386` -> `useAbility`, not at a tick boundary); only the *result* leaves with the next snapshot (up to one tick later). Auto-attacks, DoT/HoT, channels, auras, GCD and cooldowns run in `step()` against `time` in ms and fire at the first tick at or after their due time.
- **Lag compensation** (`sim.ts:249-254, 334`): `rewind = clamp(sim.time - vt, 0, TUNING.maxRewindMs = 300)`; range and facing are checked against the *target's* position `rewind` ms ago (`posAt`, linear between per-tick history entries) but against the *caster's* current server position. History is `HISTORY_TICKS = 12` entries (`sim.ts:20`, a new `Map` allocated each tick, `:422`): 600 ms at 20 Hz but **94 ms at 128 Hz**, so at a higher tick rate the rewind silently falls back to the oldest entry.
- **Transport.** `ws` server without `perMessageDeflate` (default off), `maxPayload` 32 KB, inbound limit 120 messages/s per socket (`index.ts:60, 218, 235`). TCP via the Render proxy, so loss shows up as head-of-line stalls, not as lost packets.
- **Extra work per tick:** in any match that counts for progress the room also builds a *full* snapshot for the delayed spectator feed and keeps 100 of them (`rooms.ts:552-553, 25`), whether or not anyone watches.

## 2. Weaknesses found (ordered by effect on feel)

| # | Where | What | Measured effect |
|---|---|---|---|
| 1 | `sim.ts:199-208, 491-503` | Input queue is a FIFO consumed at exactly one per tick and capped at 5 (drop oldest). After any stall (a retransmit, a late Wi-Fi burst) the backlog stays for the rest of the match. | At 1 % loss each way: queue depth 4.4 ticks vs 1.1, input to server-confirmed 364 vs 175 ms, range-check error p95 1.4 vs 0.13 u, 4.6 % false refusals and 6.4 % false acceptances. A catch-up policy (consume 2 per tick above depth 2) gives 209 ms and 0.55 u with no false refusals (emulated in the harness). |
| 2 | `main.ts` `estimatedNow` | Clock is the last snapshot's label plus local time: jitter goes straight into render time and into `vt`. | Render time runs **backwards** about 115 times/min at 30 ms jitter (0 to 23/min at 10 ms, depending on loss) and the remote players pop (>0.3 u in one frame) 6 to 8 times/min even with no loss; a smoothed clock gives 0 backward steps. |
| 3 | `main.ts:44, ~1042` | Fixed 100 ms buffer (2 snapshots) and no extrapolation, no adaptation, no latency measure. | Shown age = one-way + 100 ms. A 66 ms buffer: -34 ms (-0.16 u mean staleness), 0 % underrun on a clean 10 ms-jitter link (3.4 % at 1 % loss vs 2.8 % now); at 50 ms 4.7 % of frames freeze. |
| 4 | `main.ts` `frame`/`fixedStep` | Own character drawn by blending `prevPred -> pred`, i.e. always up to one tick behind its prediction; input sampled once per tick. | Key press to first visible movement **47 ms** at 20 Hz; projecting the last step forward by the time since it was taken (no server change) gives **24 ms**. |
| 5 | `index.ts:246-262` | `setInterval(10)` quantises tick starts to 10 ms and cannot drive ticks shorter than ~12 ms. | Tick spacing sd 3.7 ms at 20 Hz (7 %), 5 ms at 60 Hz (30 %), and at 8.33 ms 23 % of callbacks run two ticks back to back. `setInterval(1)` gives sd 0.6 to 0.9 ms at every rate. |
| 6 | `rooms.ts:543-548`, `sim.ts:1578-1620` | Snapshot is the whole unit state as pretty-key JSON, every tick, for every unit, including data that never changes. | 3.8 KB per snapshot for 6 units (74 KB/s per client); per unit: **237 B identity** (name, class, spec, look, bar, trinket, max values: never changes), **264 B state**, only **54 B motion**. |
| 7 | `rooms.ts:552-553` | A full extra snapshot is built and stored 100-deep every tick in every counted match, even with no spectator. | Part of the 0.25 to 0.55 ms per tick "snapshots + rest" cost. |
| 8 | tick-coupled constants | `starve < 3`, queue cap 5, `HISTORY_TICKS 12`, `SPECTATE_DELAY_TICKS = 20*5`, `TICKS_AFTER_END = 20*300`, `% 5`/`% 10` in `rooms.ts`, `tick * 50` in `client/src/spectate.ts:273-274`, `MAX_MSGS_PER_SEC = 120` | All silently change meaning with `tickMs`; see section 6. |
| 9 | client | A late frame produces a burst of inputs (up to `0.25/DT`) in one instant; a key tap shorter than a tick is lost; no ping/pong so there is no RTT display and no way to adapt. | Burst of 5 at 20 Hz fits the queue; at 62.5 Hz it overflows it (drop and correction). |

## 3. Method (what the numbers are and are not)

`scripts/netstudy.ts` (rerun with `npx tsx scripts/netstudy.ts`, see the end). Everything is deterministic virtual time except the CPU and timer sections.

- **net section:** the *real* `ArenaSim` (real `queueInput`, `step`, input queue, `lastSeq`, history and `posAt`) with two scripted players (zig-zag strafing, straight runs with 180 degree flicks, stop-start; open ground), a simulated link per direction and a port of the client logic (`NetClient`; the comments name the `main.ts` function each part is taken from: fixed-step accumulator, `applyInput`, `onSnapshot` reconciliation, `interpolate`, `estimatedNow`, own-unit blending and `1-exp(-dt*38)` easing) at 60 fps rendering (144 for one row). 3 seeds x 60 s per configuration, 3 s warm-up.
- **Link model:** one-way latency + uniform(0, jitter) per message, in-order delivery (TCP), a lost message is retransmitted after max(200 ms, 2 RTT) and everything behind it waits (head-of-line blocking), loss applied per message, both directions. This is deliberately realistic for WebSocket and it is **pessimistic for high message rates**: 120 messages/s means 6x more chances per second to hit a loss than 20 messages/s.
- **Metrics:** *age* = wall time minus the server time of the state being drawn; *staleness* = distance between the drawn remote unit and its true server position now (what "seeing people where they really are" means; includes the unavoidable one-way delay); *recon* = drawn position minus the true path at the time being drawn (interpolation/extrapolation quality alone); *corr* = size of the snap of the own predicted position at each snapshot; *pops* = frames where a remote unit moved more than 0.3 u in one frame; *clock back* = frames where render time went backwards; *underrun* = frames where render time was past the newest snapshot; *c1* = key press to the own character having moved 0.1 u on screen; *c2* = key press to the server position (as seen in a snapshot at the client) having moved 0.1 u; *c3* = key press to the other player's screen showing it moved 0.1 u; *range error* = |server's lag-compensated caster-target distance - the distance the casting player saw| for casts that start between 1.5 and 6.5 u apart (uses the real `posAt`, `maxRewindMs` clamp and history window); *false rej/acc* = share of casts whose verdict at a 3.5 u reach disagrees with the caster's screen.
- **Not modelled:** server timer jitter inside the net runs (measured separately), browser frame-time jitter, unit-unit collision, abilities (movement only), non-TCP transport. "Catch-up" and "cap2" are emulated *around* the sim (the sim is untouched), so they show what such a policy would do, not an implementation.
- **CPU/bandwidth section:** the real `Lobby`/`Room` from `server/src` with fake sockets, hard bots, practice matches of 1v1, 2v2 and 3v3 (a zig-zagging human sends one input message per tick), 120 s of match per cell, measured as process CPU time (user+system), not wall time, because this machine was shared (load average 10 to 18 while measuring). The sim reads `TUNING.tickMs` once at load, so each tick length runs in its own process with the value set in memory; no file was changed.
- **Machine:** Intel Xeon 2.8 GHz, Node 22. Render's small instances are slower and share cores, so CPU capacity below divides by 1.5.

## 4. Results

### 4.1 The current game across network conditions

Rows are one-way latency ms / jitter ms (uniform extra) / loss % (each way).

| net (ms / ms / %) | age ms | stale mean u | stale p95 u | clock back /min | pops /min | corr >5 cm % | corr p95 u | input drops /min | queue depth | c1 ms | c2 ms | c3 ms | range err p95 u |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 20/0/0 | 120 | 0.59 | 0.84 | 0 | 0 | 0.0 | 0.009 | 0 | 1.1 | 46 | 73 | 145 | 0.23 |
| 20/0/1 | 120 | 0.60 | 0.84 | 1 | 10 | 0.1 | 0.009 | 0 | 4.6 | 46 | 278 | 347 | 1.37 |
| 20/0/3 | 121 | 0.62 | 0.85 | 3 | 23 | 0.1 | 0.009 | 0 | 4.6 | 46 | 287 | 352 | 1.36 |
| 20/10/0 | 125 | 0.61 | 0.90 | 0 | 0 | 0.0 | 0.009 | 0 | 1.4 | 47 | 123 | 198 | 0.21 |
| 20/10/1 | 125 | 0.63 | 0.91 | 1 | 12 | 0.5 | 0.009 | 3 | 4.4 | 47 | 292 | 367 | 1.27 |
| 20/10/3 | 126 | 0.64 | 0.94 | 5 | 25 | 1.0 | 0.009 | 7 | 4.4 | 47 | 306 | 373 | 1.22 |
| 20/30/0 | 133 | 0.65 | 1.02 | 117 | 8 | 0.0 | 0.009 | 0 | 1.5 | 50 | 132 | 202 | 0.31 |
| 20/30/1 | 134 | 0.66 | 1.03 | 112 | 18 | 0.5 | 0.009 | 4 | 4.3 | 50 | 310 | 380 | 1.27 |
| 20/30/3 | 134 | 0.68 | 1.05 | 112 | 33 | 1.1 | 0.009 | 8 | 4.3 | 50 | 321 | 393 | 1.31 |
| 50/0/0 | 150 | 0.73 | 1.05 | 0 | 0 | 0.0 | 0.009 | 0 | 1.4 | 47 | 170 | 240 | 0.21 |
| 50/0/1 | 150 | 0.74 | 1.05 | 0 | 8 | 0.4 | 0.009 | 2 | 4.4 | 47 | 358 | 420 | 1.39 |
| 50/0/3 | 151 | 0.76 | 1.09 | 2 | 27 | 0.3 | 0.009 | 2 | 4.5 | 47 | 370 | 430 | 1.48 |
| 50/10/0 | 155 | 0.76 | 1.11 | 0 | 0 | 0.0 | 0.009 | 0 | 1.1 | 47 | 175 | 247 | 0.13 |
| 50/10/1 | 155 | 0.77 | 1.12 | 8 | 8 | 0.8 | 0.009 | 5 | 4.4 | 47 | 364 | 430 | 1.38 |
| 50/10/3 | 156 | 0.79 | 1.22 | 23 | 25 | 1.2 | 0.009 | 9 | 4.4 | 47 | 383 | 443 | 1.28 |
| 50/30/0 | 163 | 0.80 | 1.23 | 119 | 6 | 0.0 | 0.009 | 0 | 1.5 | 45 | 195 | 265 | 0.24 |
| 50/30/1 | 164 | 0.82 | 1.25 | 112 | 17 | 2.0 | 0.010 | 18 | 4.3 | 45 | 379 | 446 | 1.26 |
| 50/30/3 | 165 | 0.86 | 1.56 | 110 | 36 | 5.0 | 0.110 | 43 | 4.2 | 45 | 405 | 461 | 1.30 |
| 100/0/0 | 200 | 0.96 | 1.40 | 0 | 0 | 0.0 | 0.009 | 0 | 1.4 | 47 | 270 | 340 | 0.21 |
| 100/0/1 | 201 | 1.01 | 1.41 | 1 | 11 | 3.6 | 0.010 | 54 | 4.3 | 47 | 471 | 542 | 1.64 |
| 100/0/3 | 205 | 1.08 | 2.45 | 7 | 26 | 8.5 | 0.350 | 129 | 4.0 | 47 | 482 | 548 | 2.15 |
| 100/10/0 | 205 | 0.99 | 1.46 | 0 | 0 | 0.0 | 0.009 | 0 | 1.1 | 47 | 276 | 347 | 0.16 |
| 100/10/1 | 206 | 1.04 | 1.68 | 10 | 11 | 3.3 | 0.010 | 52 | 4.3 | 47 | 460 | 531 | 1.46 |
| 100/10/3 | 210 | 1.11 | 2.57 | 22 | 27 | 8.0 | 0.350 | 125 | 4.0 | 47 | 496 | 544 | 2.03 |
| 100/30/0 | 213 | 1.03 | 1.58 | 117 | 6 | 0.0 | 0.009 | 0 | 1.5 | 45 | 294 | 364 | 0.26 |
| 100/30/1 | 215 | 1.09 | 1.93 | 110 | 20 | 3.6 | 0.010 | 70 | 4.1 | 43 | 423 | 510 | 2.06 |
| 100/30/3 | 219 | 1.11 | 2.62 | 103 | 34 | 10.5 | 0.351 | 171 | 3.6 | 42 | 452 | 530 | 2.18 |

Reading it: staleness is dominated by latency (0.59 u at 20 ms to 0.96 u at 100 ms one-way: it is `speed x (one-way + 100 ms)`, only the 100 is ours). Loss, not latency or jitter, is what breaks the input path: from 1 % loss the queue sits at 4+ ticks and the confirmed response time doubles. With 30 ms of jitter and no loss nothing breaks except the clock running backwards (about 115 times a minute) and a few pops. Corrections of the own position are invisible (<1 cm) except when inputs are dropped (queue overflow at 100 ms latency + loss: 8 to 10 % of snapshots, up to 0.35 u).

### 4.2 Hypothetical settings

Settings are `sim Hz / snapshot Hz`, then the interpolation buffer (`d100`, `d66`, `d50` ms, `d2snap` = two snapshot intervals, `adaptive`), `smooth` = smoothed clock, `extrap` = extrapolation up to 100 ms, `catch-up` / `cap2` = server input-queue policies (emulated), `own-ahead` = own character projected forward, `fill` = 20 Hz sim with 40/60 Hz interpolated snapshots, `60 sim / 30 snap` = a snapshot every second tick. 62.5 and 125 Hz are integer `tickMs` 16 and 8; 60/120 are 16.67/8.33. Columns: age ms, staleness mean/p95 u, recon p95 u, pops/min, clock back/min, underrun %, c1/c2/c3 ms, range-check error p95 u, false refusals/acceptances %, share of casts whose rewind is cut by the 12-entry history, input drops/min, mean queue depth (ticks).

**Clean link, 50 ms one-way, 10 ms jitter, 0 % loss**

| setting | age | stale | recon p95 | pops | clock back | underrun % | c1 | c2 | c3 | range err p95 | false rej / acc % | hist cut % | drops | queue |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 20/20 d100 (now) | 155 | 0.76 / 1.11 | 0.01 | 0 | 0 | 0.0 | 47 | 175 | 247 | 0.13 | 0.0 / 1.0 | 0 | 0 | 1.1 |
| 20/20 d100 smooth clock | 150 | 0.73 / 1.06 | 0.01 | 0 | 0 | 0.0 | 47 | 175 | 240 | 0.13 | 0.0 / 0.0 | 0 | 0 | 1.1 |
| 20/20 d66 | 121 | 0.60 / 0.88 | 0.01 | 0 | 0 | 0.0 | 47 | 175 | 213 | 0.13 | 0.0 / 1.0 | 0 | 0 | 1.1 |
| 20/20 d50 | 105 | 0.52 / 0.76 | 0.01 | 0 | 0 | 4.7 | 47 | 175 | 197 | 0.13 | 0.0 / 0.0 | 0 | 0 | 1.1 |
| 20/20 adaptive+smooth+extrap | 123 | 0.60 / 0.87 | 0.01 | 0 | 0 | 0.0 | 47 | 175 | 214 | 0.13 | 0.0 / 0.9 | 0 | 0 | 1.1 |
| 20/20 d100 +input catch-up | 155 | 0.76 / 1.11 | 0.01 | 0 | 0 | 0.0 | 47 | 175 | 247 | 0.13 | 0.0 / 1.0 | 0 | 0 | 1.1 |
| 20/20 d66 smooth+extrap+catch-up | 116 | 0.57 / 0.82 | 0.01 | 0 | 0 | 0.0 | 47 | 175 | 207 | 0.13 | 0.0 / 1.0 | 0 | 0 | 1.1 |
| 20/20 d66 smooth+extrap+catch-up +own-ahead | 116 | 0.57 / 0.82 | 0.01 | 0 | 0 | 0.0 | 24 | 175 | 207 | 0.44 | 2.9 / 1.0 | 0 | 0 | 1.1 |
| 20/40 fill d2snap | 155 | 0.76 / 1.11 | 0.01 | 0 | 0 | 0.0 | 47 | 175 | 249 | 0.14 | 1.0 / 1.0 | 0 | 0 | 1.1 |
| 20/60 fill d2snap | 138 | 0.68 / 0.99 | 0.01 | 0 | 0 | 0.0 | 47 | 175 | 230 | 0.14 | 1.0 / 0.0 | 0 | 0 | 1.1 |
| 30/30 d2snap smooth+extrap | 117 | 0.58 / 0.82 | 0.01 | 0 | 0 | 0.0 | 38 | 150 | 199 | 0.13 | 0.0 / 0.0 | 0 | 0 | 1.2 |
| 40/40 d100 | 155 | 0.75 / 1.11 | 0.01 | 0 | 0 | 0.0 | 41 | 145 | 244 | 0.12 | 0.9 / 0.0 | 0 | 0 | 1.3 |
| 40/40 d2snap smooth+extrap | 100 | 0.50 / 0.70 | 0.01 | 0 | 0 | 0.0 | 41 | 145 | 191 | 0.13 | 0.9 / 0.9 | 0 | 0 | 1.3 |
| 62.5/62.5 d100 | 154 | 0.75 / 1.11 | 0.01 | 0 | 0 | 0.0 | 35 | 140 | 247 | 0.25 | 0.8 / 0.0 | 100 | 0 | 1.8 |
| 62.5/62.5 d2snap smooth+extrap | 82 | 0.41 / 0.58 | 0.01 | 0 | 0 | 0.0 | 35 | 140 | 173 | 0.08 | 0.8 / 0.8 | 0 | 0 | 1.8 |
| 62.5/62.5 d2snap smooth+extrap+catch-up +own-ahead | 82 | 0.41 / 0.65 | 0.01 | 0 | 0 | 0.0 | 23 | 136 | 169 | 0.13 | 0.8 / 0.8 | 0 | 0 | 1.4 |
| 60/60 d2snap smooth+extrap | 83 | 0.42 / 0.59 | 0.01 | 0 | 0 | 0.0 | 31 | 138 | 169 | 0.07 | 0.0 / 0.0 | 0 | 0 | 1.6 |
| 60 sim / 30 snap d2snap | 121 | 0.60 / 0.88 | 0.01 | 0 | 0 | 0.0 | 31 | 144 | 208 | 0.07 | 0.0 / 0.0 | 0 | 0 | 1.6 |
| 125/125 d100 | 154 | 0.75 / 1.11 | 0.01 | 0 | 0 | 0.0 | 25 | 141 | 246 | 0.83 | 1.7 / 3.3 | 100 | 0 | 2.5 |
| 125/125 d2snap smooth+extrap | 66 | 0.33 / 0.47 | 0.01 | 0 | 0 | 2.4 | 25 | 141 | 160 | 0.24 | 0.9 / 0.0 | 100 | 0 | 2.5 |
| 128/128 d2snap smooth+extrap | 66 | 0.33 / 0.46 | 0.01 | 0 | 0 | 2.9 | 25 | 137 | 153 | 0.25 | 0.8 / 2.5 | 100 | 0 | 2.4 |
| 120/120 d2snap smooth+extrap | 67 | 0.33 / 0.47 | 0.01 | 0 | 0 | 2.2 | 31 | 137 | 156 | 0.21 | 0.8 / 0.8 | 100 | 0 | 2.3 |
| 120 sim / 60 snap d2snap | 88 | 0.44 / 0.64 | 0.01 | 0 | 0 | 0.0 | 31 | 141 | 176 | 0.37 | 3.1 / 2.4 | 100 | 0 | 2.3 |
| 120/120 d2snap smooth+extrap+catch-up | 67 | 0.35 / 0.53 | 0.01 | 0 | 0 | 2.2 | 31 | 131 | 152 | 0.31 | 0.0 / 1.8 | 100 | 0 | 1.5 |

**Lossy link, 50 ms one-way, 10 ms jitter, 1 % loss each way**

| setting | age | stale | recon p95 | pops | clock back | underrun % | c1 | c2 | c3 | range err p95 | false rej / acc % | hist cut % | drops | queue |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 20/20 d100 (now) | 155 | 0.77 / 1.12 | 0.01 | 8 | 8 | 2.8 | 47 | 364 | 430 | 1.38 | 4.6 / 6.4 | 0 | 5 | 4.4 |
| 20/20 d100 smooth clock | 150 | 0.74 / 1.06 | 0.01 | 7 | 0 | 2.9 | 47 | 364 | 424 | 1.38 | 4.6 / 6.4 | 0 | 5 | 4.4 |
| 20/20 d66 | 121 | 0.61 / 0.88 | 0.01 | 8 | 8 | 3.4 | 47 | 364 | 397 | 1.38 | 5.5 / 7.3 | 0 | 5 | 4.4 |
| 20/20 d50 | 105 | 0.54 / 0.77 | 0.01 | 8 | 8 | 8.1 | 47 | 364 | 381 | 1.34 | 4.6 / 6.4 | 0 | 5 | 4.4 |
| 20/20 adaptive+smooth+extrap | 130 | 0.64 / 1.11 | 0.01 | 1 | 9 | 3.2 | 47 | 364 | 409 | 1.38 | 5.6 / 7.4 | 0 | 5 | 4.4 |
| 20/20 d100 +input catch-up | 155 | 0.78 / 1.12 | 0.01 | 31 | 8 | 2.8 | 47 | 209 | 281 | 0.55 | 0.0 / 1.8 | 0 | 3 | 1.7 |
| 20/20 d66 smooth+extrap+catch-up | 116 | 0.59 / 0.82 | 0.01 | 29 | 0 | 3.5 | 47 | 209 | 242 | 0.47 | 0.8 / 0.0 | 0 | 3 | 1.7 |
| 20/20 d66 smooth+extrap+catch-up +own-ahead | 116 | 0.59 / 0.82 | 0.01 | 29 | 0 | 3.5 | 24 | 209 | 242 | 0.78 | 4.4 / 1.8 | 0 | 3 | 1.7 |
| 20/40 fill d2snap | 155 | 0.79 / 1.13 | 0.18 | 20 | 5 | 7.9 | 47 | 357 | 424 | 1.39 | 2.8 / 3.8 | 0 | 4 | 4.4 |
| 20/60 fill d2snap | 139 | 0.73 / 1.43 | 0.48 | 27 | 5 | 11.2 | 47 | 385 | 410 | 1.47 | 7.2 / 7.2 | 0 | 5 | 4.4 |
| 30/30 d2snap smooth+extrap | 117 | 0.59 / 0.82 | 0.01 | 15 | 0 | 6.6 | 38 | 282 | 333 | 0.89 | 5.6 / 0.8 | 0 | 48 | 4.5 |
| 40/40 d100 | 155 | 0.76 / 1.12 | 0.01 | 19 | 7 | 5.9 | 41 | 237 | 339 | 0.64 | 3.7 / 4.6 | 7 | 129 | 4.1 |
| 40/40 d2snap smooth+extrap | 100 | 0.50 / 0.71 | 0.01 | 19 | 0 | 8.3 | 41 | 237 | 289 | 0.64 | 5.6 / 3.7 | 5 | 129 | 4.1 |
| 62.5/62.5 d100 | 155 | 0.73 / 1.12 | 0.02 | 24 | 6 | 7.5 | 35 | 214 | 305 | 1.03 | 4.6 / 0.8 | 100 | 378 | 3.7 |
| 62.5/62.5 d2snap smooth+extrap | 82 | 0.40 / 0.58 | 0.09 | 26 | 0 | 12.2 | 35 | 214 | 241 | 0.91 | 2.3 / 1.6 | 14 | 378 | 3.7 |
| 62.5/62.5 d2snap smooth+extrap+catch-up +own-ahead | 82 | 0.41 / 0.76 | 0.11 | 44 | 0 | 12.2 | 23 | 163 | 203 | 0.86 | 0.0 / 1.6 | 14 | 353 | 1.3 |
| 60/60 d2snap smooth+extrap | 83 | 0.41 / 0.59 | 0.04 | 23 | 0 | 11.3 | 31 | 211 | 239 | 0.79 | 1.0 / 1.0 | 10 | 326 | 4.2 |
| 60 sim / 30 snap d2snap | 122 | 0.59 / 0.88 | 0.05 | 15 | 11 | 5.8 | 31 | 206 | 280 | 0.97 | 3.2 / 0.0 | 10 | 280 | 4.2 |
| 125/125 d100 | 157 | 0.66 / 1.24 | 0.24 | 41 | 13 | 12.3 | 25 | 205 | 293 | 1.47 | 5.9 / 3.9 | 100 | 1559 | 2.9 |
| 125/125 d2snap smooth+extrap | 66 | 0.32 / 0.78 | 0.46 | 47 | 0 | 24.2 | 25 | 205 | 220 | 1.31 | 3.0 / 3.0 | 100 | 1559 | 2.9 |
| 128/128 d2snap smooth+extrap | 66 | 0.31 / 0.74 | 0.44 | 49 | 0 | 25.6 | 25 | 197 | 225 | 1.33 | 3.1 / 2.3 | 100 | 1677 | 2.9 |
| 120/120 d2snap smooth+extrap | 67 | 0.32 / 0.80 | 0.45 | 50 | 0 | 25.1 | 31 | 201 | 208 | 1.17 | 2.2 / 2.9 | 100 | 1483 | 3.0 |
| 120 sim / 60 snap d2snap | 88 | 0.40 / 0.74 | 0.28 | 22 | 3 | 10.6 | 31 | 186 | 237 | 1.20 | 4.0 / 3.2 | 100 | 1465 | 3.1 |
| 120/120 d2snap smooth+extrap+catch-up | 67 | 0.35 / 0.91 | 0.51 | 53 | 0 | 25.1 | 31 | 186 | 194 | 1.12 | 0.9 / 2.6 | 100 | 1430 | 1.2 |

**Good link, 20 ms one-way, no jitter, no loss**

| setting | age | stale | recon p95 | pops | clock back | underrun % | c1 | c2 | c3 | range err p95 | false rej / acc % | hist cut % | drops | queue |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 20/20 d100 (now) | 120 | 0.59 / 0.84 | 0.01 | 0 | 0 | 0.0 | 46 | 73 | 145 | 0.23 | 0.0 / 0.0 | 0 | 0 | 1.1 |
| 20/20 d66 smooth+extrap+catch-up | 86 | 0.43 / 0.61 | 0.01 | 0 | 0 | 0.0 | 46 | 73 | 106 | 0.23 | 0.0 / 0.0 | 0 | 0 | 1.1 |
| 40/40 d2snap smooth+extrap | 70 | 0.35 / 0.49 | 0.01 | 0 | 0 | 0.0 | 39 | 76 | 123 | 0.11 | 1.7 / 0.0 | 0 | 0 | 1.3 |
| 62.5/62.5 d2snap smooth+extrap | 52 | 0.26 / 0.37 | 0.01 | 0 | 0 | 0.0 | 33 | 63 | 102 | 0.07 | 0.0 / 0.0 | 0 | 0 | 1.4 |
| 62.5/62.5 d2snap smooth+extrap+catch-up +own-ahead | 52 | 0.26 / 0.37 | 0.01 | 0 | 0 | 0.0 | 23 | 63 | 102 | 0.12 | 0.8 / 0.0 | 0 | 0 | 1.4 |
| 125/125 d2snap smooth+extrap | 36 | 0.18 / 0.26 | 0.01 | 0 | 0 | 0.0 | 25 | 64 | 87 | 0.04 | 0.0 / 0.0 | 0 | 0 | 2.1 |

**Bad link, 100 ms one-way, 30 ms jitter, 3 % loss each way**

| setting | age | stale | recon p95 | pops | clock back | underrun % | c1 | c2 | c3 | range err p95 | false rej / acc % | hist cut % | drops | queue |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 20/20 d100 (now) | 219 | 1.11 / 2.62 | 1.43 | 34 | 103 | 19.5 | 42 | 452 | 530 | 2.18 | 0.0 / 5.9 | 0 | 171 | 3.6 |
| 20/20 d66 smooth+extrap+catch-up | 167 | 0.93 / 2.45 | 1.49 | 80 | 0 | 28.2 | 41 | 327 | 357 | 2.73 | 2.7 / 4.1 | 0 | 163 | 1.4 |
| 40/40 d2snap smooth+extrap | 151 | 0.81 / 2.45 | 1.69 | 51 | 1 | 43.0 | 41 | 464 | 456 | 2.68 | 13.3 / 6.7 | 42 | 702 | 2.8 |
| 62.5/62.5 d2snap smooth+extrap | 134 | 0.69 / 2.24 | 1.68 | 71 | 1 | 64.1 | 30 | 417 | 366 | 2.83 | 8.8 / 15.8 | 100 | 1786 | 1.9 |
| 62.5/62.5 d2snap smooth+extrap+catch-up +own-ahead | 134 | 0.76 / 2.46 | 1.91 | 107 | 1 | 64.1 | 20 | 429 | 380 | 3.00 | 10.3 / 14.4 | 100 | 1744 | 0.7 |
| 125/125 d2snap smooth+extrap | 126 | 0.55 / 1.70 | 1.34 | 106 | 6 | 91.4 | 25 | 521 | 509 | 2.56 | 8.2 / 8.2 | 100 | 5248 | 0.9 |

What the tables say:

- **Interpolation buffer, not tick rate, is the largest single item for others' positions.** At 20 Hz the buffer cannot go below ~2 snapshots (100 ms) without freezing; adaptive + smoothed clock reaches 123 ms age on the clean link (-32 ms). Doubling the snapshot rate halves the buffer for the same safety: 40 Hz 100 ms, 62.5 Hz 82 to 86 ms, 125 Hz 66 to 70 ms. The jitter floor is the point where underrun appears: 4.7 % of frames at 20 Hz with a 50 ms buffer, 2.4 % at 125 Hz with two snapshots (16 ms) and 10 ms jitter on a clean link, 24 % with 1 % loss.
- **Extrapolation changes almost nothing** in these runs (the scripted motion is piecewise linear and the buffer is two snapshots); it only matters when the buffer is thinner than the jitter. Worth having as a safety net, not as a gain.
- **Snapshot-rate-only changes do nothing**: `20/40 fill` and `20/60 fill` are not better than simply shrinking the buffer at 20/20 (age 155 and 138 ms against 121 ms with `d66`), because the interpolated snapshots are labelled one tick behind, and they pop and underrun more under loss. `60 sim / 30 snap` keeps the 20 Hz age (121 ms) but keeps the 31 ms local feel and 144 ms confirmed response.
- **Local feel (c1)** is sample wait + display lag: 47 ms (20 Hz), 41 (40), 35 (62.5), 31 (60), 25 to 31 (120/125); the `own-ahead` client change brings every rate down by about one tick: 24 ms at 20 Hz, 23 at 62.5 Hz. That change at 20 Hz is worth more than going from 20 to 125 Hz without it. **Trade-off:** the caster now sees itself up to one tick ahead of where the server has it, so the distance the caster saw and the one the server judges differ more (range-check error p95 0.13 -> 0.44 u at 20 Hz, 0.08 -> 0.13 u at 62.5 Hz; 2.9 % false refusals at a 3.5 u reach at 20 Hz). The spell range tolerance (1.5 u) absorbs it; the melee tolerance (0.5 u) mostly does.
- **Server-confirmed response (c2)** floor is 2x one-way + wait for the next tick + the snapshot interval: 175 ms at 20 Hz, 140 at 62.5 and 125 Hz.
- **Range-check accuracy** improves from 0.13 to 0.08 u p95 (20 -> 62.5 Hz) on a clean link and is **worse** at 120/125/128 Hz (0.2 to 0.85 u) because `HISTORY_TICKS = 12` covers only 94 ms and a normal rewind is 100 to 150 ms; at 62.5 Hz the window is 12 x 16 = 192 ms: fine for a two-snapshot buffer (0 % of casts cut on the clean link, 10 to 14 % with loss) but with a 100 ms buffer a rewind is 150+ ms and 100 % of casts are cut. History must be defined in ms.
- **Loss makes high rates worse unless the input path is fixed**: at 1 % loss, input drops per minute are 5 (20 Hz), 129 (40 Hz), 378 (62.5 Hz) and ~1500 (120 Hz) because the 5-tick queue covers 250 ms at 20 Hz but 40 ms at 125 Hz, and there are 6x more messages to lose. The catch-up policy removes most of that effect (drops to ~3/min at 20 Hz, c2 364 -> 209 ms) but makes remote players pop more (31 vs 8 pops/min), since the server position jumps when it catches up.

### 4.3 Server CPU (one room, ms of CPU per tick)

| tick | units | ms / tick (all) | sim.step | bots | snapshots + rest | CPU ms per match-second (with bots) | % of one core | same without bots |
|---|---|---|---|---|---|---|---|---|
| 20 Hz (50.00 ms) | 2 | 0.778 | 0.059 | 0.462 | 0.257 | 15.6 | 1.6 % | 6.3 |
| 20 Hz (50.00 ms) | 4 | 1.509 | 0.117 | 0.843 | 0.549 | 30.2 | 3.0 % | 13.3 |
| 20 Hz (50.00 ms) | 6 | 2.059 | 0.150 | 1.364 | 0.545 | 41.2 | 4.1 % | 13.9 |
| 30.0 Hz (33.33 ms) | 2 | 0.661 | 0.069 | 0.339 | 0.253 | 19.8 | 2.0 % | 9.7 |
| 30.0 Hz (33.33 ms) | 4 | 1.282 | 0.102 | 0.713 | 0.467 | 38.5 | 3.8 % | 17.1 |
| 30.0 Hz (33.33 ms) | 6 | 1.779 | 0.113 | 1.059 | 0.607 | 53.4 | 5.3 % | 21.6 |
| 60.0 Hz (16.67 ms) | 2 | 0.530 | 0.055 | 0.243 | 0.232 | 31.8 | 3.2 % | 17.2 |
| 60.0 Hz (16.67 ms) | 4 | 1.226 | 0.082 | 0.680 | 0.465 | 73.6 | 7.4 % | 32.8 |
| 60.0 Hz (16.67 ms) | 6 | 1.290 | 0.095 | 0.753 | 0.442 | 77.4 | 7.7 % | 32.2 |
| 120.0 Hz (8.33 ms) | 2 | 0.379 | 0.042 | 0.189 | 0.148 | 45.5 | 4.6 % | 22.8 |
| 120.0 Hz (8.33 ms) | 4 | 0.804 | 0.069 | 0.480 | 0.255 | 96.5 | 9.7 % | 38.9 |
| 120.0 Hz (8.33 ms) | 6 | 1.002 | 0.073 | 0.628 | 0.301 | 120.2 | 12.0 % | 44.8 |
| 128 Hz (7.81 ms) | 2 | 0.354 | 0.044 | 0.165 | 0.145 | 45.4 | 4.5 % | 24.2 |
| 128 Hz (7.81 ms) | 4 | 0.866 | 0.069 | 0.502 | 0.295 | 110.9 | 11.1 % | 46.7 |
| 128 Hz (7.81 ms) | 6 | 0.995 | 0.073 | 0.651 | 0.272 | 127.4 | 12.7 % | 44.1 |

Capacity (70 % of the CPU budget, divided by 1.5 for slower hardware, plus ~8 us per outgoing message; excludes HTTP, accounts, replay gzip at match end, the bot learner worker and GC pauses, so treat as an upper bound). Cells are rooms of 1v1 humans / 3v3 humans / 3v3 with 5 bots (practice).

| instance | 20 Hz | 30 Hz | 60 Hz | 120 Hz | 128 Hz |
|---|---|---|---|---|---|
| CPU per room-second (ms), 1v1 / 3v3 humans / 3v3 + 5 bots | 7 / 15 / 41 | 10 / 23 / 54 | 18 / 35 / 78 | 25 / 51 / 121 | 26 / 50 / 128 |
| Free 0.1 vCPU: rooms that fit | 7 / 3 / 1 | 4 / 2 / 0 | 2 / 1 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| Starter 0.5 vCPU: rooms that fit | 35 / 15 / 5 | 23 / 10 / 4 | 12 / 6 / 2 | 9 / 4 / 1 | 8 / 4 / 1 |
| Standard 1 vCPU: rooms that fit | 70 / 31 / 11 | 46 / 20 / 8 | 25 / 13 / 5 | 18 / 9 / 3 | 17 / 9 / 3 |
| Pro 2 vCPU: rooms that fit | 140 / 62 / 22 | 92 / 40 / 17 | 51 / 26 / 11 | 37 / 18 / 7 | 35 / 18 / 7 |

Render's published instance sizes as I know them: Free 0.1 vCPU, Starter 0.5, Standard 1, Pro 2 (check the current plan page). **Free (0.1 vCPU) already holds only a handful of 1v1 rooms at 20 Hz and about one at 60 Hz; 60 Hz needs Starter, 120 Hz is a Standard-class workload.**

### 4.4 Bandwidth per client

| tick | units | JSON bytes / snapshot | JSON KB/s per client | deflate per message KB/s | deflate + context KB/s | binary + delta bytes / snapshot | binary + delta KB/s |
|---|---|---|---|---|---|---|---|
| 20 Hz | 2 | 1124 | 22.0 | 9.4 | 1.0 | 141 | 2.8 |
| 20 Hz | 4 | 2353 | 45.9 | 16.7 | 1.8 | 933 | 18.2 |
| 20 Hz | 6 | 3782 | 73.9 | 23.3 | 2.4 | 1601 | 31.3 |
| 30.0 Hz | 2 | 1170 | 34.3 | 15.8 | 1.6 | 93 | 2.7 |
| 30.0 Hz | 4 | 2567 | 75.2 | 26.4 | 2.6 | 630 | 18.4 |
| 30.0 Hz | 6 | 3901 | 114.3 | 34.9 | 3.4 | 928 | 27.2 |
| 60.0 Hz | 2 | 1255 | 73.5 | 28.3 | 3.0 | 78 | 4.6 |
| 60.0 Hz | 4 | 2538 | 148.7 | 48.2 | 4.7 | 321 | 18.8 |
| 60.0 Hz | 6 | 3985 | 233.5 | 69.0 | 6.5 | 628 | 36.8 |
| 120.0 Hz | 2 | 1331 | 156.0 | 54.7 | 5.0 | 60 | 7.0 |
| 120.0 Hz | 4 | 2618 | 306.7 | 88.2 | 8.7 | 187 | 21.9 |
| 120.0 Hz | 6 | 4025 | 471.7 | 132.9 | 11.4 | 333 | 39.1 |
| 128 Hz | 2 | 1112 | 139.1 | 50.8 | 4.8 | 43 | 5.4 |
| 128 Hz | 4 | 2571 | 321.4 | 99.4 | 9.3 | 198 | 24.7 |
| 128 Hz | 6 | 3667 | 458.4 | 120.9 | 10.8 | 281 | 35.2 |

Per unit (20 Hz, measured): identity 237 B, motion 54 B, state 264 B. "bin+delta" = positions/facing/height as 9 bytes per unit in a fixed binary frame plus a JSON diff of everything else (skipped for units that did not change, sent at most 20 times a second): a real encoder was run over the captured frames. "deflate" columns use zlib: per message about 150 us of CPU per 1 to 4 KB message (3x the cost of the whole `sim.step`), with context takeover far smaller but with a 32 KB+ window per socket; both are worse choices than not sending the bytes. Egress: today a 3v3 at 20 Hz sends 443 KB/s to its six clients, 1.6 GB per room-hour; at 120 Hz with JSON 9.7 GB per room-hour.

### 4.5 Server loop timing (Node 22, this machine)

| tick ms | setInterval ms | busy ms per tick | ticks | mean gap | sd | p99 gap | max gap | % callbacks with 2+ ticks |
|---|---|---|---|---|---|---|---|---|
| 50.00 | 10 | 0.0 | 159 | 50.02 | 3.66 | 56.8 | 58.0 | 0.0 |
| 50.00 | 10 | 20.0 | 159 | 50.04 | 3.30 | 56.3 | 56.6 | 0.0 |
| 50.00 | 1 | 0.0 | 159 | 50.00 | 0.66 | 52.5 | 52.7 | 0.0 |
| 50.00 | 1 | 20.0 | 159 | 50.00 | 0.82 | 53.0 | 55.1 | 0.0 |
| 33.33 | 10 | 0.0 | 239 | 33.31 | 4.32 | 41.8 | 43.7 | 0.0 |
| 33.33 | 10 | 13.3 | 239 | 33.31 | 2.61 | 37.1 | 39.4 | 0.0 |
| 33.33 | 1 | 0.0 | 239 | 33.33 | 0.70 | 34.4 | 39.0 | 0.0 |
| 33.33 | 1 | 13.3 | 239 | 33.34 | 0.68 | 34.9 | 38.4 | 0.0 |
| 16.67 | 10 | 0.0 | 479 | 16.67 | 4.95 | 22.2 | 25.5 | 0.0 |
| 16.67 | 10 | 6.7 | 479 | 16.67 | 5.00 | 22.7 | 26.2 | 0.0 |
| 16.67 | 1 | 0.0 | 479 | 16.67 | 0.62 | 18.5 | 20.1 | 0.0 |
| 16.67 | 1 | 6.7 | 479 | 16.67 | 1.17 | 18.3 | 30.4 | 0.0 |
| 8.33 | 10 | 0.0 | 960 | 8.33 | 4.09 | 11.0 | 24.1 | 23.3 |
| 8.33 | 10 | 3.3 | 959 | 8.34 | 2.77 | 11.0 | 19.5 | 22.6 |
| 8.33 | 1 | 0.0 | 959 | 8.33 | 0.87 | 9.4 | 19.2 | 0.0 |
| 8.33 | 1 | 3.3 | 959 | 8.33 | 1.61 | 9.3 | 51.5 | 0.1 |

`ws.send` costs about 5 us per 1 to 3 KB message to a loopback client (kernel included).

### 4.6 Replays and rules drift when only `tickMs` changes

The sim is already almost entirely millisecond based (cooldowns, GCD, casts, auras, DoTs, auto attack, swing timers, regeneration per `DT`, movement per `DT`). The same scripted situations at each tick length:

| scenario | 50.00 ms | 40.00 ms | 33.33 ms | 25.00 ms | 20.00 ms | 16.67 ms | 16.00 ms | 10.00 ms | 8.33 ms | 8.00 ms | 7.81 ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| frostbolt press->damage (ms, ideal 1500) | 1500.0 | 1520.0 | 1533.3 | 1500.0 | 1500.0 | 1500.0 | 1504.0 | 1500.0 | 1508.3 | 1504.0 | 1500.0 |
| frostbolt chain: 8th cast lands at (ms, ideal 12000 + press delay) | 12050.0 | 12200.0 | 12133.3 | 12025.0 | 12020.0 | 12100.0 | 12048.0 | 12010.0 | 12033.3 | 12040.0 | 12007.8 |
| sinister strikes in 12 s on 1000 ms GCD (ideal 12) | 12.0 | 12.0 | 12.0 | 12.0 | 12.0 | 12.0 | 12.0 | 12.0 | 12.0 | 12.0 | 12.0 |
| mind flay ticks (ideal 6) | 6.0 | 6.0 | 6.0 | 6.0 | 6.0 | 6.0 | 6.0 | 6.0 | 6.0 | 6.0 | 6.0 |
| mind flay last tick at (ms, ideal 3000) | 3000.0 | 3000.0 | 3000.0 | 3000.0 | 3000.0 | 3000.0 | 3008.0 | 3000.0 | 3000.0 | 3000.0 | 3000.0 |
| garrote hits in 9.5 s (1 + 8 bleed ticks) | 9.0 | 9.0 | 9.0 | 9.0 | 9.0 | 9.0 | 9.0 | 9.0 | 8.0 | 9.0 | 9.0 |
| garrote total damage | 500.0 | 500.0 | 500.0 | 500.0 | 500.0 | 500.0 | 500.0 | 500.0 | 450.0 | 500.0 | 500.0 |
| kidney shot stun: press -> removed (ms; data says 4400) | 4400.0 | 4400.0 | 4400.0 | 4400.0 | 4400.0 | 4416.7 | 4400.0 | 4400.0 | 4400.0 | 4400.0 | 4406.3 |
| auto attacks in 20 s (2000 ms interval, ideal 10) | 10.0 | 10.0 | 10.0 | 10.0 | 10.0 | 10.0 | 10.0 | 10.0 | 10.0 | 10.0 | 10.0 |
| distance run in 5 s (ideal 35 at speed 7) | 35.0 | 35.0 | 35.0 | 35.0 | 35.0 | 35.0 | 35.1 | 35.0 | 35.0 | 35.0 | 35.0 |
| mana regained in 10 s | 240.0 | 240.0 | 240.0 | 240.0 | 240.0 | 240.0 | 240.0 | 240.0 | 240.0 | 240.0 | 240.0 |

Reading it:

- **Rules are tick-length independent except for rounding up to the next tick.** A cast, stun or channel ends at the first tick at or after its due time (on average +tickMs/2). The 8th Frostbolt of a back-to-back chain lands at 12050 ms with 50 ms ticks, 12010 at 10 ms, 12025 at 25 ms; at 40 ms it lands at 12200 because 1500 is not a multiple of 40 (every cast loses up to 20 ms, 1.7 % of damage output). With an integer `tickMs` that divides the common durations (10, 20, 25, 50; 16 and 8 are close) the effect stays below 1 %. GCD, cooldowns, auto attack, mana regeneration, running distance and Mind Flay ticks were identical at every tick length.
- **Non-integer tick lengths accumulate floating point time and bite.** At 8.33 ms (120 Hz) a Garrote lost its last bleed tick (8 hits instead of 9: 450 instead of 500 damage); at 16.67 ms (60 Hz) the Kidney Shot stun came out 16.7 ms too long and the Frostbolt chain 100 ms late (12100 against 12048 at 16 ms). At 7.8125 ms (=1000/128, exactly representable in binary) nothing was lost. **Use an integer `tickMs`** (16 for ~62 Hz, 8 for 125 Hz, 25 for 40 Hz), or keep `time` as an integer tick count times `tickMs`.
- **Bot matches:** 40 hard bot matches per tick length, mean length 84 to 90 s and mean damage 5.4k to 5.9k at every tick length; team 0 won 12 to 18, team 1 always 10, draws 12 to 18. No trend beyond noise (a sample of 40 cannot resolve differences below ~15 %). Note the *cost* is not noise: bots ran `decide` every tick for "hard" (`P.think = 1` tick).
- **Replays** re-simulate identically at every tick length tested (`ReplayRunner` on a recording made at the same `tickMs`), but are **linear in the tick rate**: the same 90 s bot match is 31 KB gzipped at 20 Hz, 70 KB at 62.5 Hz and 173 KB at 120 Hz (every input is a command per tick per player).

| tickMs | matches | team 0 wins | team 1 wins | draws | mean length s | mean damage | replay commands | replay JSON KB | replay gzip KB | re-sim identical |
|---|---|---|---|---|---|---|---|---|---|---|
| 50.00 | 40 | 17 | 10 | 13 | 84.2 | 5467 | 5826 | 140 | 31.5 | 4/4 |
| 40.00 | 40 | 15 | 10 | 15 | 88.1 | 5783 | 6098 | 147 | 33.2 | 4/4 |
| 33.33 | 40 | 17 | 10 | 13 | 83.8 | 5363 | 8396 | 205 | 45.5 | 4/4 |
| 25.00 | 40 | 18 | 10 | 12 | 85.9 | 5711 | 10988 | 269 | 57.8 | 4/4 |
| 20.00 | 40 | 15 | 10 | 15 | 87.8 | 5777 | 12240 | 300 | 64.5 | 4/4 |
| 16.67 | 40 | 14 | 10 | 16 | 90.4 | 5867 | 17199 | 423 | 89.3 | 4/4 |
| 16.00 | 40 | 15 | 10 | 15 | 86.7 | 5687 | 13192 | 325 | 70.2 | 4/4 |
| 10.00 | 40 | 13 | 10 | 17 | 90.3 | 5899 | 25610 | 642 | 132.4 | 4/4 |
| 8.33 | 40 | 17 | 10 | 13 | 86.1 | 5675 | 33261 | 844 | 173.4 | 4/4 |
| 8.00 | 40 | 15 | 10 | 15 | 88.2 | 5781 | 34579 | 878 | 179.4 | 4/4 |
| 7.81 | 40 | 12 | 10 | 18 | 90.5 | 5832 | 35553 | 904 | 184.9 | 4/4 |

## 5. What each step buys and costs, honestly

| Step | Gain (clean 50/10/0 link unless noted) | Cost |
|---|---|---|
| Stage 1: own-ahead rendering | c1 47 -> 24 ms (no server work); range-check mismatch rises 0.13 -> 0.44 u p95 | client only, 1 day |
| Stage 1: smoothed clock + adaptive buffer (66 ms at 20 Hz) | age 155 -> 123 ms, mean staleness 0.76 -> 0.60 u; render time never runs backwards; vt stays exact | client only, 1 to 2 days |
| Stage 1: input catch-up on the server | lossy link: confirmed response 364 -> 209 ms, range error p95 1.4 -> 0.55 u, no false refusals | sim change (bump `SIM_REVISION`), 1 day + retrain |
| Stage 1: setInterval(1) + hrtime accumulator | tick spacing sd 3.7 -> 0.7 ms | 0.5 day |
| Stage 1: snapshot diet (identity once, positions binary) | 74 -> ~30 KB/s per client at 3v3; less JSON CPU | 2 to 3 days |
| Stage 1: net stats overlay with real ping/pong | makes everything above verifiable on real devices | 1 day |
| Stage 2: 62.5 Hz (`tickMs` 16), on top of stage 1 | age 116 -> 82 ms (buffer 32 ms), mean staleness 0.57 -> 0.41 u, c1 24 -> 23 ms (35 without own-ahead), confirmed response 175 -> 140 ms, range error 0.13 -> 0.08 u | CPU 1.9x, bandwidth 3x unless stage 1 diet is done, retrain bots/rotations, replays 2.2x, 3 to 5 days |
| Stage 3: 125 Hz (`tickMs` 8), on top of stage 2 | age 82 -> 66 ms, staleness 0.41 -> 0.33 u, c1 25 ms, confirmed response 141 ms (no change) | CPU 2.9x, bandwidth 6x, replays 5.5x, thin buffer (2.4 % underrun on a clean link), needs Standard-class hosting. NOT recommended. |

What the owner would feel: a clean-link player sees opponents about 40 ms fresher after stage 1 and 34 ms fresher again after stage 2 and their own character reacts in 23 to 24 ms instead of 47. A player on a lossy mobile or Wi-Fi link gets a game that does not get 150 ms slower after every blip. 128 Hz is 16 ms (one display frame) better than 62.5 Hz and that is below what a 60 Hz monitor can show.

## 6. Migration cost and risk of changing the tick rate

### Per-tick versus per-ms in the code

Already in milliseconds (no change needed): `abilities.json`/`auras.json` durations and cooldowns, GCD, DoT/HoT intervals (`while (nextTick <= time)`), auto-attack interval, channel ticks (`c.start + span*k/ticks`), regeneration and rage decay (`x * DT`), movement (`speed * DT`), charge and leap, fear, jump (`JUMP_MS`), Lava, outOfCombat, prep and match timers (`prepEndsAt`, `matchEndsAt`).

Tick-coupled and must change (all verified by grep):

| File | What | Change |
|---|---|---|
| `shared/src/sim.ts:9, 14` | `const TICK = TUNING.tickMs; DT` read once at module load | make `tickMs` a `SimOptions` field (default `TUNING.tickMs`) and use `this.tickMs`; needed for per-replay tick length and tests |
| `sim.ts:20, 422-427` | `HISTORY_TICKS = 12`, new `Map` per tick | size in ms (`ceil((maxRewindMs + 100)/tickMs)`), ring buffer of typed arrays |
| `sim.ts:208, 497` | queue cap 5, repeat last input 3 ticks | ms-based (250 ms, 150 ms) or replace by the catch-up policy |
| `sim.ts:352` | `TICK * 2` pending retry | fine as is (ms) |
| `shared/src/bot.ts:227, 243, 282, 652` | `P.think * TUNING.tickMs`: hard = 1 tick = a decision every tick | keep think in ms (50 / 100 / 300 ms); `tick()` also does per-tick bookkeeping (trail of 1.2 s, history of 2.5 s: both scale with the rate) |
| `shared/src/replay.ts:24-51, 62-65, 74-108` | commands carry the tick number; `ticks`; `ReplayRunner.seek` | add `tickMs` to `ReplayData` (absent = 50), build the runner's sim with it |
| `contentHash` (`replay.ts:14`) | hashes `TUNING` | any `tickMs` change already makes every stored replay unplayable ("stale"), as intended; with the per-replay `tickMs` old ones could stay playable |
| `server/src/index.ts:247-262` | loop | `setInterval(1)`, `performance.now()` accumulator, cap on catch-up ticks in ms |
| `index.ts:60` | `MAX_MSGS_PER_SEC = 120` | at 62.5 Hz inputs alone are 62/s plus actions: raise to ~240 or batch inputs; at 125 Hz it would disconnect everyone |
| `server/src/rooms.ts:25-26, 519, 559` | `20 * 5`, `20 * 300`, `% 5`, `% 10` | seconds x ticks-per-second helper |
| `rooms.ts:552-553` | extra full snapshot per tick | only when spectators exist or at 20 Hz |
| `client/src/main.ts:41, 595, 1015` | `DT`, `pending.length > 60`, `spec.clock >= TUNING.tickMs` | `pending` by time (1 s); replay viewer already uses `TUNING.tickMs` |
| `client/src/spectate.ts:273-274` | `tick * 50 / 1000` hard-coded | `tick * tickMs / 1000` (shows wrong clock otherwise) |
| `shared/src/rotation.ts:62` | steps by `TUNING.tickMs` | ok; `rotations.json` must be retrained |
| `shared/data/botbrain.json`, `rotations.json` | tuned at 20 Hz | retrain (`scripts/train-rotations.ts`, `scripts/train-bots.ts`), per CLAUDE.md |
| tests | every test uses `TUNING.tickMs` (`advance(sim, TICK)`) | measured with `TUNING.tickMs` overridden in memory (857 tests; 1 already fails at 50 ms in the shared tree): **25 ms: 27 fail, 16 ms: 41, 8 ms: 47**. They cluster in bots on every arena, bots with walkways and barricades, movement (`7 yards/second`, charge), channelled abilities, Slice and Dice, stealth, lag compensation, learning from replays, owner bot training: tests that assume 20 ticks/s (per-tick distances, tick counts, fixed tick budgets for bot matches). Each needs a look when the sim becomes tick-independent |
| `SIM_REVISION`, version in README/package.json/client/package.json, `patches.json`, `WIKI.md` | | bump and regenerate as CLAUDE.md requires; `WIKI.md` only if tooltip text changes |

### What breaks if `tickMs` is simply edited in `tuning.json`

- Every stored and in-flight replay is refused (hash mismatch): acceptable, but old match histories lose their replay button.
- The 5-input queue becomes 80 ms (62.5 Hz) or 40 ms (125 Hz): the first jitter drops inputs and corrects the player (measured 378 and ~1500 drops/min at 1 % loss).
- Lag compensation is cut to the history window (192 ms at 62.5 Hz, 94 ms at 125 Hz): range checks go wrong (above).
- The server loop cannot hold 125 Hz (bursts of two ticks).
- At 125 Hz the 120 messages/s limit disconnects every player at once (inputs alone are 125/s).
- Spectator delay, end-screen timeout and stats cadence all change length silently; spectate clock is wrong.
- Non-integer tick lengths lose DoT ticks (measured at 120 Hz).
- Bots: hard bots decide every tick, so decisions per second x1.5 (30 Hz), x3.1 (62.5 Hz), x6.25 (125 Hz); brains trained at 20 Hz behave slightly differently and cost CPU (bots are 58 to 66 % of a bot room).

### The alternatives

- **Keep the sim at 20 Hz and add a higher-rate movement layer:** the measurements above say what is worth having: a smaller buffer needs *snapshots* at a higher rate, which needs *state* at a higher rate, i.e. movement integrated at the higher rate; sub-stepping movement inside a 20 Hz tick (3 inputs per tick, positions published each sub-step) is possible but changes the replay format (input per sub-step), prediction (client/server must step the same sub-steps), collision and ability range checks (still only at 20 Hz), and gets none of the bot/rotation/CPU work out of the way. It is as invasive as `tickMs` and the rules would be at a different resolution than movement. **Rejected.**
- **Uniform `tickMs` change** (40 Hz = 25 ms or 62.5 Hz = 16 ms): the sim already supports it with the list above. **Recommended path for stage 2.**
- **Staged path (60 now, 120 later):** yes, if at all: stage 2 is the same refactor that any later step would need (ms-based constants, per-replay `tickMs`, history in ms, loop), so choosing 62.5 Hz first makes 125 Hz a config change; it is the numbers (section 5), not the code, that say not to go there.

## 7. Recommended plan (hand-over)

**Stage 1: fix the pipeline at 20 Hz (do first, ~1.5 weeks of work, no hosting change). Items 1 to 4 and 6 to 7 are client/server transport only; item 5 changes the sim, so follow every rule in CLAUDE.md for it (bots, `SIM_REVISION`, versions, `patches.json`, training, `WIKI.md` only if tooltips change, tests).**

1. Add `ping`/`pong` to `shared/src/protocol.ts` and a client RTT estimate (median of last 8). Add a net stats overlay (toggle with a key or `?netstats`): RTT, snapshot interval mean/jitter, interpolation delay, clock error, queue depth (server puts `qd` into the own `UnitSnap`), corrections per minute, dropped inputs. Use it to validate the rest on real devices.
2. Client clock: keep `offset = max over a 2 s window of (snap.time - arrival)`, slew it (10 % per snapshot), `estimatedNow() = now + offset`. Use the same value everywhere. (`see `estimatedNow` and `viewTime` in `client/src/main.ts``)
3. Client interpolation: delay = clamp(1.25 x snapshot interval + 3 x EWMA arrival deviation, 1.25 x interval, 150 ms), extrapolate up to 100 ms when past the newest snapshot, and send `vt` computed from the **actual** render time (replace the fixed `INTERP_DELAY_MS` in `viewTime`).
4. Own character: draw `pred + (pred - prevPred) * acc/DT` instead of blending `prevPred -> pred` (keep the 38/s easing). Expect c1 47 -> 24 ms (and a larger gap between what the caster saw and what the server judges: keep the spell/melee tolerances in mind).
5. Server input queue: replace "one per tick, drop oldest above 5" by "if more than 2 are waiting, consume the extra ones in the same tick (apply the extra movement steps), cap 10 (250 ms)". Bump `SIM_REVISION`, version, patch notes, retrain as CLAUDE.md requires; keep the replay recorder the same (it records inputs when received).
6. Server loop: `setInterval(1)` (or `setTimeout` chain) with the `performance.now()` accumulator.
7. Snapshots: send per-unit identity (name, class, spec, look, bar, trinket, maxima) once in a roster message and on change; per tick send only motion + changing state; stop building the spectator snapshot when nobody can watch.
8. Re-run `npx tsx scripts/netstudy.ts`, compare with section 4 (age ~116 to 123 ms, c1 ~24 ms, lossy confirmed response ~209 ms are the targets).

**Stage 2: 62.5 Hz (`tickMs` 16) only if stage 1 leaves the owner wanting more (~1.5 weeks including retraining, plus a Render Starter plan).**

1. Refactor to a tick-length independent sim: `tickMs` in `SimOptions` and in `ReplayData` (default 50); history, starve and queue limits in ms; bots' `think` in ms; server tick-count constants as seconds; `MAX_MSGS_PER_SEC` 240 or batched inputs; client `pending` by time; `spectate.ts` clock. Land this at `tickMs` 50 first (no behaviour change except what `SIM_REVISION` covers) and run the whole test suite.
2. Switch to `tickMs` 16; send input batched per rendered frame (one WebSocket message carrying all inputs of the frame) to keep the message rate at the display rate; keep the snapshot diet.
3. Retrain `rotations.json` and `botbrain.json`; check `npm run duel`; patch notes (players see the tick change as netcode notes only).
4. Run Render Starter (0.5 vCPU) and watch `/api/status`; the harness's capacity table says about 12 1v1 rooms or 6 human 3v3 rooms before the CPU is 70 % busy.

**Not planned:** 120/128 Hz, snapshot-only rate increases, a decoupled movement layer.

## 8. Re-running the study

```
npx tsx scripts/netstudy.ts                       # everything, about 10 to 20 minutes on a quiet 4-core machine
npx tsx scripts/netstudy.ts --quick               # 1 seed, 30 s runs, 20 s CPU cells
npx tsx scripts/netstudy.ts --only net            # sections: net, stage1 (old pipeline vs Stage 1, seconds), cpu (also does bandwidth), timer, rules, bots
npx tsx scripts/netstudy.ts --json out.json       # raw numbers
```

Run `cpu` and `timer` when the machine is otherwise idle. The script only imports from `shared/`, `server/` and (the pure Stage 1 modules) `client/src`; it starts child processes of itself (one per tick length, because `TUNING.tickMs` is read once at module load) and never writes into the repository.

To see how the existing test suite behaves at another tick length without touching any file, preload a script that sets `TUNING.tickMs` in memory (`NODE_OPTIONS="--import tsx --import preload.mjs"` with `preload.mjs` doing `(await import('<repo>/shared/src/data.ts')).TUNING.tickMs = Number(process.env.TICKMS)`).

## 9. Stage 1 results (implemented in 0.69.4)

Same harness (`npx tsx scripts/netstudy.ts --only stage1`, 3 seeds x 60 s, 20 Hz, 50 ms one-way, 60 fps), but the "stage 1" rows drive the client side with the **real** modules (`client/src/netClock.ts`, `interpDelay.ts`, `ownAhead.ts`) and the **real** sim catch-up; "before" is the old pipeline (the sim's catch-up credit forced to zero each tick). Links: clean (0 ms jitter, no loss), 1 % loss each way (10 ms jitter), 30 ms jitter (no loss).

| link / pipeline | age of others ms | stale mean u | stale p95 u | own input to screen (c1) ms | input to server-confirmed (c2) ms | range-check error p95 u | false refusals % | false accepts % | underrun % | render time back/min | pops/min | input queue depth |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| clean / before | 150 | 0.73 | 1.05 | 47 | 170 | 0.21 | 0.0 | 0.9 | 0.0 | 0 | 0 | 1.43 |
| clean / stage 1 | 125 | 0.62 | 0.89 | 24 | 170 | 0.54 | 1.7 | 2.6 | 0.0 | 0 | 0 | 1.43 |
| 1 % loss / before | 155 | 0.77 | 1.12 | 47 | 364 | 1.38 | 4.6 | 6.4 | 2.8 | 8.2 | 7.7 | 4.36 |
| 1 % loss / stage 1 | 162 | 0.79 | 1.66 | 24 | 209 | 0.79 | 1.6 | 1.6 | 2.7 | 0 | 6.2 | 1.71 |
| 30 ms jitter / before | 163 | 0.80 | 1.23 | 45 | 195 | 0.24 | 1.9 | 0.0 | 0.0 | 119 | 6.0 | 1.51 |
| 30 ms jitter / stage 1 | 139 | 0.68 | 0.98 | 23 | 195 | 0.64 | 5.9 | 1.0 | 0.0 | 0 | 0 | 1.51 |

What improved: on a clean link others are drawn **25 ms** fresher (125 vs 150 ms; the buffer is 1.5 snapshot intervals = 75 ms instead of 100), with 30 ms of jitter 24 ms fresher; your own character reacts **23 ms** sooner (47 to 24 ms); render time never runs backwards any more (119 steps a minute at 30 ms jitter before, 0 now) and remote players stop popping at 30 ms jitter (6 to 0 a minute); on a lossy link the input queue no longer stays 4 ticks deep (4.4 to 1.7), the time until the server has acted on an input falls from 364 to 209 ms, and the range-check error and wrong verdicts drop (p95 1.38 to 0.79 u, wrong verdicts 4.6/6.4 % to 1.6/1.6 %).

What did not improve, or got worse: (1) **others on a lossy link are not fresher** (162 vs 155 ms): the adaptive delay rises with the lateness it measures, which is the price of having no more freezes (underrun stays at 2.7 %, from the head-of-line stalls themselves, which extrapolation only bridges for 100 ms). (2) **Range-check error on clean links is larger** (p95 0.21 to 0.54 u, 0.24 to 0.64 at 30 ms jitter, false refusals up to 1.7 % and 5.9 %): drawing your own character ahead means the player sees himself closer to his target than the server (which judges the caster at its server position) does; this is the cost the study predicted for the 24 ms of response, and the melee/spell tolerances in the sim must stay generous. (3) The input to server-confirmed time on clean and jittery links did not change (the catch-up only matters after stalls). (4) The "dropped inputs" column of the harness now counts inputs skipped by the catch-up (the unit had already moved on a repeated input), so it is not comparable between the two pipelines. (5) At the sim level the catch-up is deliberately cautious: a client can never move more ticks than the clock has run (a repeated tick is matched by skipping one late input, an idle tick pays for one extra step), so a stall that the server covered by repeating the last input is cleared completely, while a longer one recovers only what its idle ticks pay for. The unlimited emulation of section 4 would be a speed hack for a modified client.

Not measured here: real browsers, real frame-time jitter, the snapshot diet (a protocol change with no effect on the numbers above; a 6-unit snapshot in an idle test match went from 2305 to 1736 bytes of JSON per tick, about 25 % less; busy fights have more state, so the share is smaller), the 1 ms server loop (its spacing was measured in section 4.5). Use the Network stats readout on real devices.


## 10. Stage 2 results (0.69.4): tick length is a setting, and how close two screens agree

### What was built

- `ArenaSim` takes `tickMs` (default `TUNING.tickMs` = 50); replays record it; `contentHash(tickMs)`; the server reads `ARENA_TICK_MS` (8 to 50, default 50; `render.yaml` sets 16); `welcome.tickMs`; the client predicts, sends one input per tick and sizes its buffers from it. The migration list of section 6 was worked through: input queue (250 ms), repeat window (150 ms), catch-up depth/credit, history (600 ms) in milliseconds; bots think on a ms clock; room cadences (`% 5`, `% 10`, spectator delay, end screen) in ms; rate limit `max(120, 2000/tickMs + 60)`; loop catch-up cap in ms; `spectate.ts` clock; `rotation.ts` loop. DEVELOPING.md has the details.
- **At 50 ms nothing changed:** digests of the event logs and end states of six full bot matches (6 players, 6 arenas) captured from the code before the change are identical after it (`SIM_REVISION` is 91 because of the separate lava pit change, not because of this one); three of them are in `shared/test/tickms.test.ts`. The 40-match bot comparison reproduces the section 4.6 row for 50 ms to the digit (84.2 s, 5467 damage). Rotations and bot brain were therefore not retrained (CLAUDE.md asks for it when abilities change; no ability, spec or talent changed, and the shipped data was tuned at the 50 ms the sim still plays at).
- **Server load meter** (`server/src/tickmeter.ts`) in `/api/status` and the admin dashboard; a console warning at more than 70 % load for 10 s. Pause/map-swap fixes on the client (section 10.5).

### 10.1 Rules at 16 ms (`scripts/netstudy.ts --only rules,bots --ticks 50,16`)

| scenario | 50 ms | 16 ms |
|---|---|---|
| Frostbolt press to damage (ideal 1500) | 1500 | 1504 |
| 8th Frostbolt of a chain (ideal 12000 + press delay) | 12050 | 12048 |
| Sinister Strikes in 12 s | 12 | 12 |
| Mind Flay ticks / last tick (ideal 6 / 3000) | 6 / 3000 | 6 / 3008 |
| Garrote hits in 9.5 s / damage | 9 / 500 | 9 / 500 |
| Kidney Shot stun (data 4400) | 4400 | 4400 |
| auto attacks in 20 s | 10 | 10 |
| mana in 10 s | 240 | 240 |

Every duration is within one tick of the data; the lost Garrote tick and the late stun of the 8.33 and 16.67 ms rows are gone because the tick is an integer number of milliseconds. 40 hard-bot matches per tick length: 50 ms 17 / 10 / 13 (team 0 wins / team 1 wins / draws), 84.2 s mean length, 5467 damage; 16 ms 15 / 10 / 15, 88.7 s, 5736 damage (+5 %, inside the noise of 40 matches). Replays re-simulate identically at both. A replay is 2.4x as large at 16 ms (378 KB JSON, 81 KB gzipped for a 90 s 1v1 against 140 / 31.5).

### 10.2 Tests

`npx tsx --test ...` at the default 50 ms: 937 tests (all green). `npm run test:16` (the whole suite with `TUNING.tickMs` 16 in memory): all green; the 41 failures of the section 6 measurement were tests that assumed 20 ticks per second (per-tick walk distances, `i < 100` loops, `t % 20` sampling in the bot stuck checks, queue depth thresholds, the 5 s spectator delay in ticks, a Shatter timing that only worked when 4000 ms landed on a tick); they now count milliseconds or ask for 50 ms explicitly (`shared/test/catchup.test.ts`, whose scenarios are about the 50 ms queue). `shared/test/tickms.test.ts` runs the rules, the input queue and catch-up, lag-compensation history (300 ms rewind at 50, 16 and 8 ms), replays at 16 ms, rate-limit, full 2v2 bot matches at 16 ms, and the 50 ms digests.

### 10.3 Pairwise agreement: do two screens show the same place?

Definition (`scripts/netstudy.ts --target`): two humans run at run speed (7 yd/s: zig-zags with strafe flips every 0.5 s, mouse flicks, straight runs, stop-starts), 50 ms one-way latency (100 ms RTT), 20 ms jitter, 0 or 1 % loss each way (TCP head-of-line model of section 3), Stage 1 client (real modules), 3 seeds x 60 s. Metric: at every frame of player A, the distance between where A's screen draws B and where B's own screen draws B (B's predicted, own-ahead position) at the same instant, both directions pooled; the 95th percentile must be below 1.0 yard. "Server vs view" is the drawn other player against the server's authoritative position at that instant. "Lead" is dead reckoning of other players: they are drawn `lead` ms later than the buffered time and anything past the newest snapshot continues straight along the last two snapshots' velocity (no fade, teleports not carried on); `lead = min(150 ms, f x RTT)`, `f` swept.

| link | server rate | lead f | pair mean yd | pair p95 yd | pair p99 | pair max | server vs view p95 | age ms | p95 < 1 yd |
|---|---|---|---|---|---|---|---|---|---|
| 0 % loss | 20 Hz | 0 (Stage 1 as it was) | 1.01 | 1.52 | 1.53 | 1.56 | 0.91 | 129 | FAIL |
| 0 % loss | 20 Hz | 0.5 | 0.74 | 1.11 | 1.31 | 1.78 | 0.51 | 69 | FAIL |
| 0 % loss | 20 Hz | **0.75** | 0.62 | **0.98** | 1.36 | 1.99 | 0.47 | 39 | PASS (barely) |
| 0 % loss | 20 Hz | 1.0 | 0.50 | 1.04 | 1.47 | 2.20 | 0.57 | 9 | FAIL |
| 0 % loss | 62.5 Hz | 0 | 0.82 | 1.24 | 1.24 | 1.25 | 0.67 | 95 | FAIL |
| 0 % loss | 62.5 Hz | 0.5 | 0.54 | 0.82 | 1.02 | 1.44 | 0.27 | 35 | PASS |
| 0 % loss | 62.5 Hz | **0.75** | 0.42 | **0.72** | 1.10 | 1.67 | 0.31 | 5 | PASS |
| 0 % loss | 62.5 Hz | 1.0 | 0.30 | 0.77 | 1.21 | 1.89 | 0.44 | -25 | PASS |
| 1 % loss | 20 Hz | 0 | 1.50 | 2.64 | 2.87 | 3.68 | 1.75 | 193 | FAIL |
| 1 % loss | 20 Hz | 0.75 | 1.11 | 2.01 | 2.52 | 4.95 | 1.12 | 103 | FAIL |
| 1 % loss | 20 Hz | 1.25 (best) | 0.87 | 1.62 | 2.41 | 5.34 | 0.71 | 43 | FAIL |
| 1 % loss | 62.5 Hz | 0 | 1.73 | 2.81 | 3.39 | 3.85 | 1.75 | 228 | FAIL |
| 1 % loss | 62.5 Hz | 0.75 | 1.35 | 2.23 | 2.83 | 3.38 | 1.13 | 138 | FAIL |
| 1 % loss | 62.5 Hz | 1.25 (best) | 1.10 | 1.91 | 2.53 | 3.66 | 0.71 | 78 | FAIL |

(All rows with all lead settings: `npx tsx scripts/netstudy.ts --target`.)

Verdict, honestly:

1. **Without dead reckoning the target is not met anywhere**: p95 1.52 yd at 20 Hz and 1.24 yd at 62.5 Hz on the clean 100 ms RTT link. The floor is physics: a screen shows the other player as he was one-way-up + tick wait + one-way-down + buffer ago (about 130 ms at 20 Hz, 95 ms at 62.5 Hz) and a runner covers 7 yd/s.
2. **Dead reckoning is what gets under 1 yard**, and the best setting is 0.75 x RTT (150 ms cap): 20 Hz reaches p95 **0.98** yd (a pass by 0.02 yd, i.e. not a safe margin) and 62.5 Hz reaches **0.72** yd. Less lead leaves staleness, more lead makes direction changes (a strafe flip every half second) cost more than the staleness it removes: p95 goes back up past f = 0.75 to 1.0 at 20 Hz while the mean keeps falling; the maximum grows from 1.56 to 1.99 yd. The server-vs-view error falls from 0.91 to 0.47 yd at 20 Hz.
3. **So sub-yard agreement on the clean link is met at 20 Hz with extrapolation, with almost no margin, and with comfortable margin at 62.5 Hz** (0.72 yd; 0.82 even at f = 0.5, 0.77 at f = 1). 62.5 Hz buys about 0.26 yd of p95 and removes the 95 % reliance on a 20 Hz velocity estimate.
4. **On a 1 % loss link neither rate gets there** (p95 1.6 to 2.0 yd with the best lead; without it 2.6 to 2.8). A lost packet on TCP stalls everything behind it for 200 ms or more, during which no position information exists at all; extrapolation bridges only part of that. 62.5 Hz is even slightly worse than 20 Hz on this link (3x as many messages to lose, the adaptive buffer grows to 138 ms age): the section 4 finding that only the input/transport path matters under loss. Getting under 1 yard there needs a transport that does not stall (WebRTC data channels or WebTransport with unreliable position updates), which is not part of this change.
5. **Shipped:** the client uses `Lead` (`client/src/interpDelay.ts`): 0.75 x the measured round trip, at most 150 ms, eased, off before the first ping answer and for spectators; casts report the drawn time as `vt`, so the server's lag compensation still judges against what the player saw. It applies at 50 and 16 ms alike.

Caveats: the scripted motion flips direction more often than most real play (it is a worst case for dead reckoning and therefore for the p95 gain); both players are modelled symmetrically; browsers' frame jitter, server timer jitter and a real player's hand are not modelled (section 3).

### 10.4 Cost at 16 ms with the final code (this machine, Xeon 2.8 GHz, process CPU time, hard bots, `--only cpu --ticks 50,16`, 120 s per cell)

| tick | units | ms CPU per tick | ms CPU per second of match | JSON KB/s per client | bin+delta KB/s (not built) |
|---|---|---|---|---|---|
| 20 Hz | 2 | 0.99 | 19.8 | 17.5 | 3.7 |
| 20 Hz | 4 | 1.37 | 27.3 | 32.4 | 11.8 |
| 20 Hz | 6 | 1.86 | 37.2 | 50.6 | 20.9 |
| 62.5 Hz | 2 | 0.46 | 28.6 | 51.0 | 3.9 |
| 62.5 Hz | 4 | 0.95 | 59.3 | 101.6 | 15.1 |
| 62.5 Hz | 6 | 1.24 | 77.2 | 155.3 | 23.5 |

CPU per second of match grows 1.44x (1v1), 2.2x (2v2) and 2.1x (3v3 with bots) (the machine was shared, so the 20 Hz cells are noisier than the section 4.3 ones: 41 ms there for the 3v3 against 37 here); bandwidth per client is 3.0x (51 -> 155 KB/s for a 3v3, with the Stage 1 snapshot diet). Using the section 4.3 capacity method (70 % of the CPU, /1.5 for slower hosts): a 0.5 vCPU Starter holds about 12 1v1 rooms, 6 human 3v3 rooms or 2 bot 3v3 rooms at 62.5 Hz; the 0.1 vCPU free plan one 1v1-or-2v2 room (it holds a handful at 20 Hz): the owner runs one room at a time and wants to see how it copes, which is what the load meter is for (`/api/status` `tick.load`; above 70 % for 10 s the console says `server busy`).

### 10.5 Pause and map swap (found while testing)

The Stage 1 client was not built for a paused or teleported sim: the smoothed clock kept running against frozen server time labels (and jumped by the pause length on resume), others kept moving along their last velocity, the own character kept predicting held keys against a frozen server position, and after a map swap old buffers and velocities were applied to positions tens of yards away. Fixed: a paused snapshot freezes drawing exactly on itself (no extrapolation, no lead, `estimatedNow()` = frozen server time), nothing is predicted or sent while paused and queued inputs are dropped (client and server), a resume, a restart (`dev_state.reset`) and a map swap throw away the snapshot buffer, clock offset, delay statistics, render time, lead, prediction and camera anchor (`resetNetState` in `client/src/main.ts`; the scene already snaps its meshes in `setMap`), and the server sends the first paused frame at once after a swap. Tests: `server/test/devmap.test.ts` (immediate frame, identical positions for 100 paused ticks), `client/test/netClock.test.ts`.

### 10.6 Not verified

No real browser was available: the client changes (lead, pause handling, tick-length handling, admin row, network readout) are type-checked and their pure parts unit tested, but not seen on screen. The server loop at 16 ms is verified for spacing logic by tests with an injected clock, not under real load on Render's hardware; the 1 % loss rows are a model of TCP, not a measurement on a real network.
