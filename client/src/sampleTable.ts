/**
 * The sample manifest: which recorded sounds the game plays, and for which sound ids. The ids are the ones the audio engine
 * already uses for a recipe (`c-<ability>` = released, `cs-<ability>` = wind-up, `hit-<ability>` = lands), so a sample
 * simply takes over from the synthesised recipe of the same id, which stays as the fallback while the file is loading,
 * if it is missing or if the browser cannot decode it. To add one, see "Sample bank" in DEVELOPING.md.
 */

export interface SampleDef {
  /** Files to try in order (names under public/audio/). The first one the browser can decode wins (put .ogg before .mp3, say). */
  files: string[];
  /** Base loudness 0..1.4 (the same mix the recipes use, so 0.4 is about a recipe at vol 0.7). */
  volume: number;
  /** Playback rate, 1 = as recorded; lower is deeper and longer. */
  rate?: number;
  /** Random pitch spread: the rate is multiplied by 1 +/- this (0.05 = +/- 5%). */
  pitchVar?: number;
  /** Random loudness spread, the same way. */
  volVar?: number;
  /** More takes of the same sound: one of `files` and these is picked at random. */
  variants?: string[][];
  /** Louder / softer with the `power` of the sound (0.4..1.4): 0 = ignore it, 1 = follow it fully. */
  powerGain?: number;
  /** Play the synthesised recipe as well (the sample for the body, the recipe for the punch). Default: the sample replaces it. */
  layer?: boolean;
  /** Fetch and decode as soon as the audio engine is unlocked, so the first use already has it. Keep for small, common clips. */
  preload?: boolean;
}

export const SAMPLES: Record<string, SampleDef> = {
  // Freesound 105016 "JM_FX_Fireball_01" (see CREDITS.md): the rising whoosh for the launch, the burst and its decay for the hit
  'c-fireball': { files: ['fireball-launch.mp3'], volume: 0.5, pitchVar: 0.06, volVar: 0.1, powerGain: 0.3, preload: true },
  'hit-fireball': { files: ['fireball-hit.mp3'], volume: 0.4, pitchVar: 0.07, volVar: 0.12, powerGain: 0.5, layer: true, preload: true },
  // Pyroblast: the same recordings, pitched down so it is heavier and slower
  'c-pyroblast': { files: ['fireball-launch.mp3'], volume: 0.42, rate: 0.72, pitchVar: 0.04, volVar: 0.08, powerGain: 0.3 },
  'hit-pyroblast': { files: ['fireball-hit.mp3'], volume: 0.5, rate: 0.62, pitchVar: 0.04, volVar: 0.08, powerGain: 0.5, layer: true },
};
