import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, AURAS } from '@arena/shared';
import { ABILITY_VISUAL, AURA_VISUAL, LayerBook, auraVisualsOf, dotAurasFor, isDotTick, layerAlpha, visualFor } from '../src/skillVisuals';
import type { AuraStyle, VisualClass } from '../src/skillVisuals';

const live = Object.values(ABILITIES).filter((a) => !a.retired);

describe('ability visual classes', () => {
  it('lists every non-retired ability exactly once, and nothing unknown', () => {
    const missing = live.filter((a) => !ABILITY_VISUAL[a.id]).map((a) => a.id);
    assert.deepEqual(missing, []);
    const unknown = Object.keys(ABILITY_VISUAL).filter((id) => !ABILITIES[id]);
    assert.deepEqual(unknown, []);
    const retired = Object.keys(ABILITY_VISUAL).filter((id) => ABILITIES[id]?.retired);
    assert.deepEqual(retired, []);
  });
  it('only genuinely flying things are projectiles', () => {
    const proj = live.filter((a) => visualFor(a).cls === 'projectile').map((a) => a.id).sort();
    assert.deepEqual(proj, ['arcane_blast', 'axe_throw', 'fireball', 'frostbolt', 'pyroblast', 'smite']);
  });
  it('scorch erupts under the target and is no projectile', () => {
    const v = visualFor(ABILITIES.scorch);
    assert.equal(v.cls, 'onTarget');
    assert.deepEqual(v.hit, { kind: 'fire', style: 'eruption' });
  });
  it('priest damage-over-time spells apply an aura', () => {
    for (const id of ['plague_bloom', 'shadow_word_death']) assert.equal(visualFor(ABILITIES[id]).cls, 'aura');
  });
  it('instant damage at range lands on the target, not as a bolt', () => {
    for (const a of live) {
      if (a.target !== 'enemy' || a.range <= 6 || a.channel) continue;
      const cls: VisualClass = visualFor(a).cls;
      if (a.castTime === 0 && !['fireball', 'axe_throw'].includes(a.id)) assert.notEqual(cls, 'projectile', a.id);
    }
  });
  it('onTarget and aura entries say what to draw; nothing else does', () => {
    for (const a of live) {
      const v = visualFor(a);
      assert.equal(!!v.hit, v.cls === 'onTarget' || v.cls === 'aura', a.id);
    }
  });
  it('guesses a sane class for retired abilities', () => {
    for (const a of Object.values(ABILITIES).filter((x) => x.retired)) assert.ok(visualFor(a).cls, a.id);
  });
});

describe('aura visuals', () => {
  it('every damage-over-time aura has a visual', () => {
    const dots = Object.entries(AURAS).filter(([, d]) => d.dot).map(([id]) => id);
    assert.ok(dots.length >= 6);
    assert.deepEqual(dots.filter((id) => !AURA_VISUAL[id]), []);
  });
  it('only refers to real auras with known styles and sane strength', () => {
    const styles: AuraStyle[] = ['shadow', 'bleed', 'burn', 'frost', 'holy', 'poison'];
    for (const [id, v] of Object.entries(AURA_VISUAL)) {
      assert.ok(AURAS[id], id);
      assert.ok(styles.includes(v.style), id);
      assert.ok(v.strength > 0 && v.strength <= 1.5, id);
    }
  });
  it('maps the examples to the right looks', () => {
    assert.equal(AURA_VISUAL.plague_bloom.style, 'shadow');
    assert.equal(AURA_VISUAL.garrote_bleed.style, 'bleed');
    assert.equal(AURA_VISUAL.burn.style, 'burn');
    assert.equal(AURA_VISUAL.frost_nova_root.style, 'frost');
    assert.equal(AURA_VISUAL.renew.style, 'holy');
    assert.ok(AURA_VISUAL.penance_barrier.bubble);
  });
  it('finds the visuals of a unit', () => {
    assert.deepEqual(auraVisualsOf(['stealth', 'burn', 'renew']).map((x) => x.id), ['burn', 'renew']);
  });
});

describe('damage ticks', () => {
  it('knows which aura a tick belongs to', () => {
    assert.deepEqual(dotAurasFor('plague_bloom'), ['plague_bloom']);
    assert.deepEqual(dotAurasFor(null), []);
  });
  it('the direct hit of a cast is not a tick; later hits while the aura is up are', () => {
    assert.equal(isDotTick('plague_bloom', ['plague_bloom'], 0), null);
    assert.equal(isDotTick('plague_bloom', ['plague_bloom'], 1), 'plague_bloom');
    assert.equal(isDotTick('plague_bloom', [], 1), null);
    assert.equal(isDotTick('fireball', ['burn'], 1), 'burn');
    assert.equal(isDotTick('frostbolt', ['burn'], 1), null);
  });
});

describe('layer lifetime', () => {
  it('fades in and out', () => {
    assert.equal(layerAlpha(0, null), 0);
    assert.equal(layerAlpha(1, null), 1);
    assert.ok(layerAlpha(1, 0.2) < 1 && layerAlpha(1, 0.2) > 0);
    assert.equal(layerAlpha(1, 0.5), 0);
  });
  it('keeps wanted layers and disposes each gone one exactly once', () => {
    const book = new LayerBook();
    assert.deepEqual(book.step(new Set(['1:a', '2:b']), 0.016), []);
    assert.equal(book.size, 2);
    assert.equal(book.goneFor('1:a'), null);
    assert.deepEqual(book.step(new Set(['2:b']), 0.2), []);
    assert.equal(book.goneFor('1:a'), 0.2);
    assert.deepEqual(book.step(new Set(['2:b']), 0.3), ['1:a']);
    assert.deepEqual(book.step(new Set(['2:b']), 0.3), []);
    assert.equal(book.size, 1);
  });
  it('a layer that comes back stops fading', () => {
    const book = new LayerBook();
    book.step(new Set(['x']), 0.016);
    book.step(new Set(), 0.3);
    assert.deepEqual(book.step(new Set(['x']), 0.016), []);
    assert.equal(book.goneFor('x'), null);
  });
  it('everything is disposed when the unit dies or leaves', () => {
    const book = new LayerBook();
    book.step(new Set(['1:a', '1:b', '1:c']), 0.016);
    const out = book.step(new Set(), 1);
    assert.deepEqual(out.sort(), ['1:a', '1:b', '1:c']);
    assert.equal(book.size, 0);
  });
});
