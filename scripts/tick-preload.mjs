// Runs the test suite at another tick length without touching a data file:
//   TICKMS=16 NODE_OPTIONS="--import tsx --import ./scripts/tick-preload.mjs" node --test shared/test/*.test.ts ...
// (or `npm run test:16`). TUNING.tickMs is what ArenaSim, the bots and the tests default to.
const { TUNING } = await import(new URL('../shared/src/data.ts', import.meta.url).href);
TUNING.tickMs = Number(process.env.TICKMS || TUNING.tickMs);
