# Project rules

- Every commit that changes abilities, specs, talents, weapons or class mechanics must also update the bots (`shared/src/bot.ts`) so they use the new abilities, and the per-spec bot test in `shared/test/builds.test.ts` must pass. Bots get a spec via `botBuild` and must play whatever is on their bar (`useFirst` lists).
- Bump `SIM_REVISION` (shared/src/replay.ts) on sim/data changes, plus the version in README line 1, root `package.json` and `client/package.json`; keep versions below 1.0.
- Before pushing: typecheck shared/server/client and run `npx tsx --test shared/test/*.test.ts server/test/*.test.ts client/test/*.test.ts`.
- After a patch that changes abilities, re-run `npx tsx scripts/train-rotations.ts` (seconds) and `npx tsx scripts/train-bots.ts` (a few minutes) and commit the updated `shared/data/rotations.json` and `shared/data/botbrain.json`.
- Every version bump also adds an entry at the top of `shared/data/patches.json` (the main menu's Patch notes list); a test fails if its version differs from `package.json`.
- After changing abilities, auras, specs, talents or tooltip text, run `npx tsx scripts/gen-wiki.ts` and commit `WIKI.md` (a test fails while it is out of date).
