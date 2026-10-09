import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CURSORS } from '@arena/shared';
import { ART_STATES, ART_STYLES, CURSOR_CONTEXTS, MAX_CURSOR_PX, OVERLAY_STYLES, cursorArt, glowFor, isOverride } from '../src/cursorArt';
import {
  DEFAULT_CURSOR_SETTINGS,
  TINT_CHOICES,
  cursorCss,
  cursorDeclarations,
  cursorOpen,
  decideContext,
  needsPick,
  parseCursorSettings,
  patchCursorSettings,
  planFor,
  serializeCursorSettings,
  tintColor,
} from '../src/cursors';
import type { CursorSituation } from '../src/cursors';

const open = () => true;
const stats = { matches: 0, wins: 0, peak: 1000 };

describe('cursor art', () => {
  it('every style in the list has art, and every art style is in the list', () => {
    for (const c of CURSORS) assert.ok(ART_STYLES.includes(c.id), c.id);
    for (const s of ART_STYLES) assert.ok(CURSORS.some((c) => c.id === s), s);
    assert.equal(ART_STYLES.length, 11);
    assert.deepEqual([...OVERLAY_STYLES].sort(), ['claw', 'ember', 'frost', 'star', 'void']);
  });
  it('is well-formed SVG within 128 px with the hotspot inside, for every style, state, size and density', () => {
    assert.deepEqual(CURSOR_CONTEXTS, ['default', 'enemy', 'ally', 'aim', 'aimBlocked']);
    for (const style of ART_STYLES) {
      for (const state of ART_STATES) {
        for (const size of [0.75, 1, 1.5, 2]) {
          for (const density of [1, 2] as const) {
            for (const glow of [null, '#69ccf0']) {
              const a = cursorArt(style, state, { size, glow, density });
              const id = `${style}/${state}/${size}/${density}`;
              assert.ok(a.svg.startsWith('<svg ') && a.svg.endsWith('</svg>'), id);
              assert.ok(a.w <= MAX_CURSOR_PX && a.h <= MAX_CURSOR_PX && a.w >= 16, id);
              const css = Math.round(a.w / density);
              assert.ok(a.hx >= 0 && a.hx < css && a.hy >= 0 && a.hy < css, `${id} hotspot ${a.hx},${a.hy}`);
              // tags balance and nothing is left unquoted
              assert.equal((a.svg.match(/"/g) ?? []).length % 2, 0, `${id} quotes`);
              assert.equal((a.svg.match(/<g[ >]/g) ?? []).length, (a.svg.match(/<\/g>/g) ?? []).length, `${id} <g> balance`);
              assert.ok(!/NaN|undefined/.test(a.svg), id);
              // strict XML (a cursor image is parsed as a standalone document): no attribute twice on one tag
              for (const tag of a.svg.match(/<[a-zA-Z][^>]*>/g) ?? []) {
                const names = [...tag.matchAll(/\s([\w:-]+)=/g)].map((m) => m[1]);
                assert.equal(new Set(names).size, names.length, `${id} duplicate attribute in ${tag}`);
              }
            }
          }
        }
      }
    }
  });
  it('the 2x image is twice the pixels with the same hotspot in CSS pixels', () => {
    const one = cursorArt('gauntlet', 'default', { size: 1, density: 1 });
    const two = cursorArt('gauntlet', 'default', { size: 1, density: 2 });
    assert.equal(two.w, one.w * 2);
    assert.equal(two.hx, one.hx);
  });
  it('the gauntlet has its own art for normal use and over buttons; the four overrides are all different', () => {
    const svgs = ART_STATES.map((st) => cursorArt('gauntlet', st).svg);
    assert.equal(new Set(svgs).size, ART_STATES.length);
  });
  it('the sword, cross and crosshair are the same for every style, tint and glow request', () => {
    for (const st of ['enemy', 'ally', 'aim', 'aimBlocked'] as const) {
      assert.ok(isOverride(st));
      const ref = cursorArt('gauntlet', st);
      for (const style of ART_STYLES) {
        for (const glow of [null, '#69ccf0']) {
          const a = cursorArt(style, st, { glow });
          assert.deepEqual(a, ref, `${style}/${st}`);
        }
      }
    }
    assert.ok(!isOverride('default') && !isOverride('link'));
  });
  it('the crosshair is the same art in green and in red, with the same hotspot', () => {
    const ok = cursorArt('wand', 'aim');
    const no = cursorArt('wand', 'aimBlocked');
    assert.equal([ok.hx, ok.hy].join(), [no.hx, no.hy].join());
    assert.ok(ok.svg.includes('#6dff8a') && !ok.svg.includes('#ff4b3e'));
    assert.ok(no.svg.includes('#ff4b3e') && !no.svg.includes('#6dff8a'));
    assert.equal(ok.svg.replaceAll('#6dff8a', '#ff4b3e'), no.svg);
  });
  it('custom styles keep their own art over buttons', () => {
    for (const style of ART_STYLES.filter((x) => x !== 'gauntlet')) assert.equal(cursorArt(style, 'link').svg, cursorArt(style, 'default').svg, style);
  });
  it('inline copies can have their ids prefixed so several can share a page', () => {
    const a = cursorArt('wand', 'default', { glow: '#fff', ids: 'x1-' }).svg;
    assert.ok(a.includes('id="x1-a"') && a.includes('xlink:href="#x1-a"') && !/ id="a"/.test(a));
  });
  it('glow is the tint for the chosen style and never touches the sword, cross or crosshair', () => {
    for (const st of ['enemy', 'ally', 'aim', 'aimBlocked'] as const) assert.equal(glowFor('wand', st, '#69ccf0'), null);
    assert.equal(glowFor('wand', 'default', '#69ccf0'), '#69ccf0');
    assert.equal(glowFor('wand', 'default', null), null);
    assert.equal(glowFor('gauntlet', 'link', null), '#f2c14e');
  });
});

describe('cursor css', () => {
  it('has a plain url, image-set forms, a hotspot and a keyword fallback in every declaration', () => {
    const d = cursorDeclarations('gauntlet', 'enemy', { size: 1, glow: null });
    assert.equal(d.length, 3);
    assert.ok(d[0].startsWith('cursor:url("data:image/svg+xml,'));
    assert.ok(d[1].includes('-webkit-image-set(') && d[2].includes('image-set(') && d[2].includes(' 2x'));
    for (const x of d) assert.match(x, /\) \d+ \d+, [a-z-]+;$/);
    const imp = cursorDeclarations('gauntlet', 'link', { size: 1, glow: null }, true);
    for (const x of imp) assert.ok(x.endsWith('!important;'));
  });
  it('the style sheet sets the page cursor, the link variant and hides it only for the overlay', () => {
    const s = { ...DEFAULT_CURSOR_SETTINGS };
    const css = cursorCss(planFor(s, 'default', false), s, '#69ccf0');
    assert.ok(css.startsWith('html{cursor:url('));
    assert.ok(css.includes('html.ac-pt,html.ac-pt *{') && css.includes('html.ac-own,html.ac-own *{cursor:none !important;}'));
    assert.ok(!css.includes('\n'));
  });
  it('custom styles have no separate link rule; the overrides are one cursor for every style', () => {
    const w = { ...DEFAULT_CURSOR_SETTINGS, style: 'wand' };
    assert.ok(!cursorCss(planFor(w, 'default', false), w, null).includes('ac-pt'));
    const strip = (c: string) => c.replace(/html\.ac-own.*$/, '');
    for (const ctx of ['enemy', 'ally', 'aim', 'aimBlocked'] as const) {
      const a = strip(cursorCss(planFor(w, ctx, false), w, '#69ccf0'));
      const g = DEFAULT_CURSOR_SETTINGS;
      const b = strip(cursorCss(planFor(g, ctx, false), g, null)).replace(/html\.ac-pt.*$/, '');
      assert.equal(a, b, ctx);
    }
  });
});

describe('cursor settings', () => {
  const store = (o: Record<string, string>) => (k: string) => o[k] ?? null;
  it('defaults: the gauntlet, size 1, class tint, no ripple, no trail', () => {
    assert.deepEqual(parseCursorSettings(store({}), open), DEFAULT_CURSOR_SETTINGS);
    assert.deepEqual(DEFAULT_CURSOR_SETTINGS, { style: 'gauntlet', size: 1, tint: 'class', ripple: false, trail: false, trailLen: 12 });
  });
  it('bad stored values fall back to the defaults', () => {
    const bad = parseCursorSettings(store({ 'arena.cursor.style': 'nope', 'arena.cursor.size': 'big', 'arena.cursor.tint': 'javascript:1', 'arena.cursor.ripple': 'yes', 'arena.cursor.trail': '2', 'arena.cursor.trailLen': 'NaN' }), open);
    assert.deepEqual(bad, DEFAULT_CURSOR_SETTINGS);
  });
  it('numbers are clamped and rounded', () => {
    const s = parseCursorSettings(store({ 'arena.cursor.size': '9', 'arena.cursor.trailLen': '999' }), open);
    assert.equal(s.size, 2);
    assert.equal(s.trailLen, 32);
    const t = parseCursorSettings(store({ 'arena.cursor.size': '0.1', 'arena.cursor.trailLen': '1' }), open);
    assert.equal(t.size, 0.75);
    assert.equal(t.trailLen, 4);
    assert.equal(parseCursorSettings(store({ 'arena.cursor.size': '1.23' }), open).size, 1.25);
  });
  it('a valid saved choice is read back, a hex tint is accepted', () => {
    const want = { style: 'ember', size: 1.5, tint: '#ff00aa', ripple: true, trail: true, trailLen: 20 };
    assert.deepEqual(parseCursorSettings((k) => serializeCursorSettings(want)[k] ?? null, open), want);
  });
  it('a locked style is never applied, on load or by a change', () => {
    const none = (id: string) => cursorOpen(id, stats);
    assert.equal(parseCursorSettings(store({ 'arena.cursor.style': 'frost' }), none).style, 'gauntlet');
    assert.equal(parseCursorSettings(store({ 'arena.cursor.style': 'wand' }), none).style, 'wand');
    const cur = { ...DEFAULT_CURSOR_SETTINGS, style: 'wand' };
    assert.equal(patchCursorSettings(cur, { style: 'crown', size: 1.5 }, none).style, 'wand');
    assert.equal(patchCursorSettings(cur, { style: 'crown', size: 1.5 }, none).size, 1.5);
    assert.equal(patchCursorSettings(cur, { style: 'dot' }, none).style, 'dot');
  });
  it('unlock rules: free, matches, wins, peak and owner', () => {
    assert.ok(cursorOpen('gauntlet', stats) && cursorOpen('pixel', stats));
    assert.ok(!cursorOpen('ember', stats) && cursorOpen('ember', { ...stats, wins: 5 }));
    assert.ok(!cursorOpen('claw', stats) && cursorOpen('claw', { ...stats, matches: 25 }));
    assert.ok(!cursorOpen('crown', stats) && cursorOpen('crown', { ...stats, peak: 1700 }));
    assert.ok(!cursorOpen('star', { ...stats, wins: 500 }));
    for (const c of CURSORS) assert.ok(cursorOpen(c.id, { ...stats, name: 'Toke' }), c.id);
    assert.ok(!cursorOpen('nope', { ...stats, name: 'Toke' }));
  });
  it('tint: class colour, none, or a chosen colour', () => {
    assert.equal(tintColor({ tint: 'class' }, '#69ccf0'), '#69ccf0');
    assert.equal(tintColor({ tint: 'class' }, null), null);
    assert.equal(tintColor({ tint: 'off' }, '#69ccf0'), null);
    assert.equal(tintColor({ tint: '#ff4b3e' }, '#69ccf0'), '#ff4b3e');
    for (const [v] of TINT_CHOICES) assert.ok(v === 'class' || v === 'off' || /^#[0-9a-f]{6}$/.test(v));
  });
});

describe('cursor context', () => {
  const sit = (o: Partial<CursorSituation> = {}): CursorSituation => ({ inMatch: true, spectating: false, aim: null, myTeam: 0, ...o });
  it('enemy and ally by team; yourself and the dead keep the chosen style', () => {
    assert.equal(decideContext(sit(), { team: 1, alive: true, self: false }, true), 'enemy');
    assert.equal(decideContext(sit(), { team: 0, alive: true, self: false }, true), 'ally');
    assert.equal(decideContext(sit(), { team: 0, alive: true, self: true }, true), 'default');
    assert.equal(decideContext(sit(), null, true), 'default');
    assert.equal(decideContext(sit(), { team: 1, alive: false, self: false }, true), 'default');
  });
  it('aiming wins over what is under the pointer, and shows blocked', () => {
    assert.equal(decideContext(sit({ aim: 'aim' }), { team: 1, alive: true, self: false }, true), 'aim');
    assert.equal(decideContext(sit({ aim: 'aimBlocked' }), null, true), 'aimBlocked');
  });
  it('spectators and menus always the default', () => {
    assert.equal(decideContext(sit({ spectating: true, aim: 'aim' }), null, true), 'default');
    assert.equal(decideContext(sit({ spectating: true }), { team: 1, alive: true, self: false }, true), 'default');
    assert.equal(decideContext(sit({ inMatch: false }), { team: 1, alive: true, self: false }, true), 'default');
    assert.equal(decideContext(sit(), { team: 1, alive: true, self: false }, false), 'default'); // over the HUD, not the scene
    assert.equal(decideContext(sit({ aim: 'aim' }), null, false), 'default');
  });
  it('the raycast only runs while nothing else decides', () => {
    assert.ok(needsPick(sit()));
    assert.ok(!needsPick(sit({ aim: 'aim' })) && !needsPick(sit({ spectating: true })) && !needsPick(sit({ inMatch: false })));
  });
});

describe('reduced motion and the overlay plan', () => {
  it('animated styles use the overlay, aiming and reduced motion fall back to still art', () => {
    const ember = { ...DEFAULT_CURSOR_SETTINGS, style: 'ember', trail: true, ripple: true };
    const p = planFor(ember, 'default', false);
    assert.ok(p.overlay && p.trail && p.ripple);
    for (const c of ['enemy', 'ally', 'aim', 'aimBlocked'] as const) assert.ok(!planFor(ember, c, false).overlay, c);
    const r = planFor(ember, 'default', true);
    assert.ok(!r.overlay && r.trail && r.ripple, 'switches the player turned on still work with reduced motion');
    const off = planFor({ ...DEFAULT_CURSOR_SETTINGS, style: 'ember' }, 'default', true);
    assert.ok(!off.trail && !off.ripple);
    assert.ok(!planFor(DEFAULT_CURSOR_SETTINGS, 'default', false).overlay);
    assert.ok(!planFor({ ...DEFAULT_CURSOR_SETTINGS, style: 'wand' }, 'default', false).overlay);
  });
  it('the frost shard always leaves a cold trail (unless motion is reduced)', () => {
    const f = { ...DEFAULT_CURSOR_SETTINGS, style: 'frost' };
    assert.ok(planFor(f, 'default', false).trail && !planFor(f, 'default', true).trail);
  });
  it('a still version of every animated style exists for the native cursor', () => {
    for (const s of OVERLAY_STYLES) assert.ok(cursorArt(s, 'default').svg.length > 100, s);
    const css = cursorCss(planFor({ ...DEFAULT_CURSOR_SETTINGS, style: 'void' }, 'default', true), { ...DEFAULT_CURSOR_SETTINGS, style: 'void' }, null);
    assert.ok(css.startsWith('html{cursor:url('));
  });
});
