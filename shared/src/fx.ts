import { FX } from './data';

/**
 * Animations: how the big visual effects look in time (how long Dragon's Breath sprays, how fast a Frost Nova ring grows, how
 * long a Charge leaves a trail). Visual only: nothing here is read by the simulation, and shared/data/fx.json is not part of
 * the content hash (replay.ts contentHash), so editing it never changes a match or a replay. The client reads these numbers when
 * an effect starts, so a dev's change shows on the very next cast. The dev panel's Animations page lists them from FX_INFO.
 */

/** The id of the one object in fx.json (patches name it like the game options' 'game'). */
export const FX_ID = 'fx';

export type FxUnit = 'ms' | 'x' | 'plain';
export interface FxField { label: string; hint: string; unit: FxUnit; min: number; max: number }
export interface FxGroup { title: string; sub: string; fields: Record<string, FxField> }

export const FX_INFO: Record<string, FxGroup> = {
  dragonsBreath: {
    title: "Dragon's Breath",
    sub: 'a jet of fire sprayed from the mage over the real cone',
    fields: {
      startDelayMs: { label: 'Wait before the spray starts', hint: 'Seconds between pressing the button and the first flame. 0 sprays at once.', unit: 'ms', min: 0, max: 1500 },
      sprayMs: { label: 'How long the spray stays', hint: 'Seconds the mage keeps spraying flame before it starts to fade.', unit: 'ms', min: 100, max: 4000 },
      fadeMs: { label: 'Fade-out time', hint: 'Seconds the flame takes to die down once the spray ends.', unit: 'ms', min: 0, max: 2000 },
      lengthScale: { label: 'Spray length', hint: 'How far the flame reaches, as a share of the real range (1 is exactly the range, more is just for looks).', unit: 'x', min: 0.4, max: 1.5 },
      widthScale: { label: 'Spray width', hint: 'How much of the real cone angle the flame fills (1 fills it, less is a narrower jet).', unit: 'x', min: 0.2, max: 1.2 },
      density: { label: 'Flame amount', hint: 'How many flames are drawn (more looks thicker and costs more on slow computers).', unit: 'x', min: 0.2, max: 3 },
    },
  },
  flamestrike: {
    title: 'Flamestrike',
    sub: 'the burning ground',
    fields: {
      popInMs: { label: 'Time to pop up', hint: 'Seconds the fire ring and flames take to fade in when the zone appears.', unit: 'ms', min: 0, max: 3000 },
      fadeOutMs: { label: 'Fade-out time', hint: 'Seconds the fire takes to die down at the end of its (server-set) duration.', unit: 'ms', min: 0, max: 4000 },
    },
  },
  blizzard: {
    title: 'Blizzard',
    sub: 'the icy storm',
    fields: {
      popInMs: { label: 'Time to pop up', hint: 'Seconds the storm takes to fade in when the zone appears.', unit: 'ms', min: 0, max: 3000 },
      fadeOutMs: { label: 'Fade-out time', hint: 'Seconds the storm takes to die down at the end of its (server-set) duration.', unit: 'ms', min: 0, max: 4000 },
    },
  },
  frostNova: {
    title: 'Frost Nova',
    sub: 'the expanding ring of frost',
    fields: {
      expandMs: { label: 'Ring growth time', hint: 'Seconds the ring takes to grow from the mage to the full radius.', unit: 'ms', min: 100, max: 3000 },
    },
  },
  holyNova: {
    title: 'Holy Nova',
    sub: 'the pulse of light',
    fields: {
      expandMs: { label: 'Pulse growth time', hint: 'Seconds the pulse takes to grow from the priest to the full radius.', unit: 'ms', min: 100, max: 3000 },
    },
  },
  charge: {
    title: 'Charge and Intercept',
    sub: 'the trail left while the warrior runs in (the run itself is as fast as the skill says)',
    fields: {
      trailMs: { label: 'Trail lifetime', hint: 'Seconds each puff of the streak behind the warrior stays visible.', unit: 'ms', min: 50, max: 2000 },
      trailDensity: { label: 'Trail amount', hint: 'How many streak puffs are drawn (0 turns the streak off).', unit: 'x', min: 0, max: 3 },
      dustDensity: { label: 'Dust amount', hint: 'How much dust is kicked up along the run (0 turns it off).', unit: 'x', min: 0, max: 3 },
    },
  },
  heroicLeap: {
    title: 'Heroic Leap',
    sub: 'the jump (its flight time is set by the skill)',
    fields: {
      arcScale: { label: 'Arc height', hint: 'How high the leap is drawn. 1 is the real height; this only changes the picture, not where you land.', unit: 'x', min: 0.2, max: 2 },
      landingRingMs: { label: 'Landing shockwave time', hint: 'Seconds the ring takes to spread over the landing radius.', unit: 'ms', min: 100, max: 2000 },
    },
  },
  blink: {
    title: 'Blink',
    sub: 'the streak between the two flashes',
    fields: {
      streakMs: { label: 'Streak lifetime', hint: 'Seconds the beam between where the mage left and arrived stays visible.', unit: 'ms', min: 50, max: 2000 },
    },
  },
  bladestorm: {
    title: 'Bladestorm',
    sub: 'the whirling blades',
    fields: {
      spinPerSec: { label: 'Spin speed', hint: 'Full turns of the blades per second.', unit: 'plain', min: 0.2, max: 8 },
    },
  },
};

/** The bounds of the number at a fx.json path (['dragonsBreath', 'sprayMs']), or null when it is not a known animation number. */
export function fxField(path: readonly (string | number)[]): FxField | null {
  if (path.length !== 2) return null;
  const g = path[0];
  const k = path[1];
  if (typeof g !== 'string' || typeof k !== 'string' || !Object.hasOwn(FX_INFO, g) || !Object.hasOwn(FX_INFO[g].fields, k)) return null;
  return FX_INFO[g].fields[k];
}

/** One animation number as it is now (patches applied), clamped to its bounds so a bad value cannot break a picture. */
export function fxNum(group: string, key: string): number {
  const info = FX_INFO[group]?.fields[key];
  const v = (FX as unknown as Record<string, Record<string, number> | undefined>)[group]?.[key];
  if (!info) return 0;
  if (typeof v !== 'number' || !Number.isFinite(v)) return info.min;
  return Math.min(info.max, Math.max(info.min, v));
}

/** An animation time in seconds (the files keep milliseconds). */
export const fxSec = (group: string, key: string): number => fxNum(group, key) / 1000;
