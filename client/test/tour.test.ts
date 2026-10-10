import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TOUR_IDS, TOURS_KEY, canStartIn, counterText, isLastStep, keyAction, markSeenIn, parseSeen, pickAutoTour, placeCard, serializeSeen, spotRect, stepBack, stepForward, textFor, unionRect, unionSeen } from '../src/tourLogic';
import { TOURS, TOUR_LIST } from '../src/tourData';

describe('tour steps', () => {
  it('walks forward to the end and back to the start', () => {
    assert.deepEqual(stepForward(0, 3), { index: 1, done: false });
    assert.deepEqual(stepForward(1, 3), { index: 2, done: false });
    assert.deepEqual(stepForward(2, 3), { index: 2, done: true });
    assert.deepEqual(stepForward(0, 1), { index: 0, done: true });
    assert.deepEqual(stepForward(0, 0), { index: 0, done: true });
    assert.equal(stepBack(2), 1);
    assert.equal(stepBack(0), 0);
  });

  it('counts steps from one and knows the last', () => {
    assert.equal(counterText(0, 9), '1 / 9');
    assert.equal(counterText(8, 9), '9 / 9');
    assert.equal(isLastStep(8, 9), true);
    assert.equal(isLastStep(7, 9), false);
  });

  it('picks the wording for the screen', () => {
    assert.equal(textFor('same', true), 'same');
    assert.equal(textFor({ desktop: 'click', touch: 'tap' }, false), 'click');
    assert.equal(textFor({ desktop: 'click', touch: 'tap' }, true), 'tap');
  });
});

describe('seen list', () => {
  it('parses what was saved and drops the rest', () => {
    assert.deepEqual(parseSeen(JSON.stringify({ menu: 5, hud: 7.9, nope: 3, build: 'x', watch: -1, admin: Infinity })), { menu: 5, hud: 7 });
    assert.deepEqual(parseSeen('not json'), {});
    assert.deepEqual(parseSeen('[1,2]'), {});
    assert.deepEqual(parseSeen(null), {});
    assert.deepEqual(parseSeen(''), {});
  });

  it('round-trips in a fixed order', () => {
    const m = markSeenIn(markSeenIn({}, 'hud', 20), 'devtools', 10);
    assert.equal(serializeSeen(m), '{"devtools":10,"hud":20}');
    assert.deepEqual(parseSeen(serializeSeen(m)), m);
    assert.equal(TOURS_KEY, 'arena.tours.v1');
  });

  it('marking does not change the list it was given', () => {
    const a = { menu: 1 };
    const b = markSeenIn(a, 'build', 2);
    assert.deepEqual(a, { menu: 1 });
    assert.deepEqual(b, { menu: 1, build: 2 });
  });

  it('unions two devices, keeping the earlier time', () => {
    const a = JSON.stringify({ menu: 5, hud: 9 });
    const b = JSON.stringify({ menu: 3, watch: 4 });
    assert.deepEqual(parseSeen(unionSeen(a, b)), { menu: 3, hud: 9, watch: 4 });
    assert.deepEqual(parseSeen(unionSeen(a, 'junk')), { menu: 5, hud: 9 });
    assert.equal(unionSeen(null, null), '{}');
  });
});

describe('which tour starts by itself', () => {
  it('the Dev tools tours are for devs and the owner, once', () => {
    assert.equal(pickAutoTour('devpanel', {}, 'dev'), 'devtools');
    assert.equal(pickAutoTour('devpanel', {}, 'owner'), 'devtools');
    assert.equal(pickAutoTour('devpanel', {}, null), null);
    assert.equal(pickAutoTour('devpanel', { devtools: 1 }, 'dev'), null);
    assert.equal(pickAutoTour('tuning', {}, 'owner'), 'tuning');
    assert.equal(pickAutoTour('tuning', { tuning: 1 }, 'owner'), null);
    assert.equal(pickAutoTour('admin', {}, 'dev'), 'admin');
    assert.equal(pickAutoTour('admin', {}, null), null);
  });

  it('the menu gives the welcome tour first and the build tour next time', () => {
    assert.equal(pickAutoTour('menu', {}, null), 'menu');
    assert.equal(pickAutoTour('menu', { menu: 1 }, null), 'build');
    assert.equal(pickAutoTour('menu', { menu: 1, build: 2 }, null), null);
  });

  it('a first match and a first watch each start their tour once', () => {
    assert.equal(pickAutoTour('match', {}, null), 'hud');
    assert.equal(pickAutoTour('match', { hud: 1 }, null), null);
    assert.equal(pickAutoTour('watch', {}, null), 'watch');
    assert.equal(pickAutoTour('watch', { watch: 1 }, null), null);
  });

  it('only fits the screen it is about', () => {
    assert.equal(canStartIn('menu', 'menu'), true);
    assert.equal(canStartIn('menu', 'match'), false);
    assert.equal(canStartIn('match', 'match'), true);
    assert.equal(canStartIn('watch', 'menu'), false);
    assert.equal(canStartIn('any', 'other'), true);
  });
});

describe('keys while a tour is open', () => {
  it('a tour that dims the page takes every key', () => {
    assert.equal(keyAction('Enter', 'modal'), 'next');
    assert.equal(keyAction('ArrowRight', 'modal'), 'next');
    assert.equal(keyAction('ArrowLeft', 'modal'), 'back');
    assert.equal(keyAction('Escape', 'modal'), 'skip');
    for (const code of ['Digit1', 'KeyW', 'Space', 'Tab', 'ArrowUp', 'KeyF']) assert.equal(keyAction(code, 'modal'), 'swallow');
  });

  it('the match tour only uses Enter and Esc', () => {
    assert.equal(keyAction('Enter', 'hint'), 'next');
    assert.equal(keyAction('Escape', 'hint'), 'skip');
    for (const code of ['Digit1', 'KeyW', 'ArrowLeft', 'ArrowRight', 'Space']) assert.equal(keyAction(code, 'hint'), 'pass');
  });
});

describe('where the card goes', () => {
  const vp = { w: 1280, h: 800 };
  const card = { w: 340, h: 160 };
  it('is centred with nothing to point at', () => {
    assert.deepEqual(placeCard(null, card, vp), { kind: 'free', left: 470, top: 320 });
  });
  it('sits below the target when there is room, else above', () => {
    assert.deepEqual(placeCard({ x: 100, y: 100, w: 200, h: 40 }, card, vp), { kind: 'free', left: 30, top: 152 });
    const low = placeCard({ x: 100, y: 700, w: 200, h: 40 }, card, vp);
    assert.equal(low.kind, 'free');
    if (low.kind === 'free') assert.equal(low.top, 700 - 12 - 160);
  });
  it('stays on the screen', () => {
    const p = placeCard({ x: 1250, y: 100, w: 30, h: 30 }, card, vp);
    assert.equal(p.kind, 'free');
    if (p.kind === 'free') assert.ok(p.left + card.w <= vp.w - 8);
  });
  it('docks to the bottom on a phone, or the top when the target is low', () => {
    const phone = { w: 390, h: 800 };
    assert.deepEqual(placeCard(null, card, phone), { kind: 'dock', edge: 'bottom' });
    assert.deepEqual(placeCard({ x: 10, y: 100, w: 100, h: 40 }, card, phone), { kind: 'dock', edge: 'bottom' });
    assert.deepEqual(placeCard({ x: 10, y: 600, w: 100, h: 40 }, card, phone), { kind: 'dock', edge: 'top' });
    assert.deepEqual(placeCard({ x: 10, y: 100, w: 100, h: 40 }, card, phone, true), { kind: 'dock', edge: 'top' });
  });
  it('lights several rectangles as one and cuts to the screen', () => {
    assert.deepEqual(unionRect([{ x: 10, y: 10, w: 10, h: 10 }, { x: 40, y: 30, w: 10, h: 10 }]), { x: 10, y: 10, w: 40, h: 30 });
    assert.equal(unionRect([]), null);
    assert.deepEqual(spotRect({ x: -20, y: 5, w: 100, h: 50 }, 6, vp), { x: 0, y: 0, w: 86, h: 61 });
    assert.equal(spotRect({ x: 2000, y: 5, w: 100, h: 50 }, 6, vp), null);
  });
});

describe('tour data', () => {
  it('has one tour per id with steps that have words', () => {
    assert.deepEqual(TOUR_LIST.map((d) => d.id).sort(), [...TOUR_IDS].sort());
    for (const id of TOUR_IDS) {
      const d = TOURS[id];
      assert.equal(d.id, id);
      assert.ok(d.steps.length >= 5, `${id} has steps`);
      for (const s of d.steps) {
        assert.ok(s.title.length > 0 && s.title.length <= 30, `${id}: title "${s.title}"`);
        for (const t of typeof s.text === 'string' ? [s.text] : [s.text.desktop, s.text.touch]) assert.ok(t.length > 10 && t.length <= 300, `${id}: "${s.title}" text length`);
      }
    }
  });

  it('only the match and watch tours leave the game playable', () => {
    for (const d of TOUR_LIST) assert.equal(d.mode, d.needs === 'match' || d.needs === 'watch' ? 'hint' : 'modal', d.id);
  });

  it('the phone wording of the match tour describes touch, not the mouse', () => {
    for (const s of TOURS.hud.steps) {
      if (typeof s.text === 'string') continue;
      assert.ok(!/mouse|click|right-click|\bpress\b/i.test(s.text.touch.replace(/needs a keyboard/i, '').replace(/need a mouse and keyboard/i, '')), `${s.title}: ${s.text.touch}`);
    }
  });
});

describe('skipping the tour', () => {
  it('counts every tour as seen, keeping the times already there, so none starts by itself again', async () => {
    const { markAllSeenIn, pickAutoTour, TOUR_IDS } = await import('../src/tourLogic');
    const seen = markAllSeenIn({ menu: 5 }, 100);
    assert.equal(seen.menu, 5);
    for (const id of TOUR_IDS) assert.ok(seen[id]);
    assert.equal(pickAutoTour('menu', seen, null), null);
    assert.equal(pickAutoTour('match', seen, null), null);
  });
});
