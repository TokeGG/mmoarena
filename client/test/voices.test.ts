import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, ARENAS } from '@arena/shared';
import { ACTION_VOICE, CAST_VOICE, HIT_VOICE, START_VOICE, STEP_SURFACE, castVoice, hitVoice, startVoice } from '../src/voices';
import type { NoiseOpts, Synth, ToneOpts } from '../src/voices';

function record() {
  const tones: ToneOpts[] = [];
  const noises: NoiseOpts[] = [];
  const s: Synth = { tone: (o) => void tones.push(o), noise: (o) => void noises.push(o) };
  return { s, tones, noises };
}
const sane = (tones: ToneOpts[], noises: NoiseOpts[]) => {
  for (const t of tones) assert.ok(t.f > 0 && t.d > 0 && (t.vol ?? 0.3) > 0 && (t.to === undefined || t.to > 0), JSON.stringify(t));
  for (const n of noises) assert.ok(n.f > 0 && n.d > 0 && (n.vol ?? 0.3) > 0 && (n.to === undefined || n.to > 0), JSON.stringify(n));
};

describe('ability voices', () => {
  it('every ability gets a release sound, from its own recipe or from what it does', () => {
    const missing: string[] = [];
    for (const def of Object.values(ABILITIES)) if (!castVoice(def) && def.school === 'physical') missing.push(def.id);
    assert.deepEqual(missing, [], 'physical abilities always have a voice');
    for (const def of Object.values(ABILITIES)) {
      const v = castVoice(def);
      if (!v) continue; // spells without a signature use the school sound
      const { s, tones, noises } = record();
      v(s, 1);
      assert.ok(tones.length + noises.length > 0, def.id);
      sane(tones, noises);
    }
  });

  it('signature tables only name real abilities and every recipe makes valid sound', () => {
    for (const table of [CAST_VOICE, START_VOICE, HIT_VOICE]) {
      for (const [id, r] of Object.entries(table)) {
        assert.ok(ABILITIES[id], `${id} is an ability`);
        for (const power of [0.4, 1, 1.4]) {
          const { s, tones, noises } = record();
          r(s, power);
          assert.ok(tones.length + noises.length > 0, id);
          sane(tones, noises);
        }
      }
    }
  });

  it('most abilities have their own signature, and key ones differ from each other', () => {
    const own = Object.values(ABILITIES).filter((d) => CAST_VOICE[d.id]).length;
    assert.ok(own >= Object.keys(ABILITIES).length * 0.9, `${own} of ${Object.keys(ABILITIES).length}`);
    const sig = (id: string) => {
      const { s, tones, noises } = record();
      CAST_VOICE[id](s, 1);
      return JSON.stringify([tones, noises]);
    };
    const ids = ['frostbolt', 'fireball', 'pyroblast', 'blink', 'charge', 'kick', 'backstab', 'flash_heal', 'polymorph'];
    assert.equal(new Set(ids.map(sig)).size, ids.length, 'distinct sounds');
  });

  it('bigger power sounds louder or longer; start and hit voices resolve by ability', () => {
    const vol = (power: number) => {
      const { s, tones, noises } = record();
      HIT_VOICE.pyroblast(s, power);
      return tones.reduce((a, t) => a + (t.vol ?? 0), 0) + noises.reduce((a, n) => a + (n.vol ?? 0), 0);
    };
    assert.ok(vol(1.4) > vol(0.5));
    assert.ok(startVoice(ABILITIES.pyroblast) && !startVoice(ABILITIES.kick));
    assert.ok(hitVoice(ABILITIES.ice_lance) && hitVoice(undefined) === null);
  });

  it('action sounds and arena footsteps are complete', () => {
    for (const [name, r] of Object.entries(ACTION_VOICE)) {
      const { s, tones, noises } = record();
      r(s, 1);
      assert.ok(tones.length + noises.length > 0, name);
      sane(tones, noises);
    }
    for (const a of ARENAS) assert.ok(STEP_SURFACE[a.theme], `${a.theme} has footsteps`);
  });
});
