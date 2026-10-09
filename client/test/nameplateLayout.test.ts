import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), key: (i: number) => [...store.keys()][i] ?? null, get length() { return store.size; } };
const L = await import('../src/nameplateLayout');
const S = await import('../src/nameplateStore');
const { snapshotSettings, parseSettings } = await import('../src/settingsSync');

const full: import('../src/nameplateLayout').PlateContext = { hasMark: true, hasArrow: true, hasAvatar: true, hasTitle: true, hasRes: true, hasCast: true, auraCount: 4 };
const bare: import('../src/nameplateLayout').PlateContext = { hasMark: false, hasArrow: false, hasAvatar: false, hasTitle: false, hasRes: false, hasCast: false, auraCount: 0 };
const near = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ~ ${b}`);

describe('nameplate layout', () => {
  it('a head plate stacks around the bar, the bar\'s bottom on the anchor', () => {
    const p = L.defaultProfile();
    const lay = L.layoutPlate(p, full);
    const r = lay.parts;
    near(r.bar.y + r.bar.h, 0);
    near(r.bar.x, -55);
    assert.equal(r.bar.w, 110);
    near(r.res.y, r.bar.y + r.bar.h + 1); // under the bar
    near(r.cast.y, r.res.y + r.res.h + 2);
    near(r.auras.y, r.cast.y + r.cast.h + 2);
    near(r.title.y + r.title.h, r.bar.y - 1); // over the bar
    near(r.name.y + r.name.h, r.title.y);
    near(r.icon.y + r.icon.h, r.name.y - 2);
    near(r.marks.y + r.marks.h, r.icon.y);
    assert.ok(lay.bounds && lay.bounds.y < r.marks.y + 0.01);
  });

  it('parts that are not shown take no room and the others keep the line', () => {
    const p = L.defaultProfile();
    const lay = L.layoutPlate(p, bare);
    assert.equal(lay.parts.res.visible, false);
    assert.equal(lay.parts.auras.visible, false);
    // without a title the name sits straight over the bar; without a cast bar the buffs hang off the bar
    near(lay.parts.name.y + lay.parts.name.h, lay.parts.bar.y);
    const some = L.layoutPlate(p, { ...bare, auraCount: 2 });
    near(some.parts.auras.y, some.parts.bar.y + some.parts.bar.h + 2); // its own gap, nothing between
  });

  it('a feet plate hangs below the anchor', () => {
    const p = L.defaultProfile();
    L.setAnchor(p, 'feet');
    assert.equal(p.anchor, 'feet');
    const lay = L.layoutPlate(p, full);
    assert.ok(lay.parts.bar.y >= 0);
    for (const id of L.PART_IDS) assert.ok(lay.parts[id].y >= -0.01, id);
    L.setAnchor(p, 'head');
    assert.deepEqual(p.parts, L.defaultParts('head'));
  });

  it('a validated profile or preset still switches to the other anchor\'s arrangement', () => {
    const p = L.sanitizeProfile(L.defaultProfile());
    L.setAnchor(p, 'feet');
    assert.deepEqual(p.parts, L.defaultParts('feet'));
    const q = L.PLATE_PRESETS[2].make();
    L.setAnchor(q, 'feet');
    assert.deepEqual(q.parts, L.defaultParts('feet'));
  });

  it('switching the anchor keeps parts the player rearranged', () => {
    const p = L.defaultProfile();
    p.parts.res.dx = 12;
    const mine = JSON.stringify(p.parts);
    L.setAnchor(p, 'feet');
    assert.equal(JSON.stringify(p.parts), mine);
  });

  it('scale multiplies sizes and offsets; width and height scale on their own', () => {
    const p = L.defaultProfile();
    p.scaleW = 2;
    p.scaleH = 1.5;
    const r = L.layoutPlate(p, full).parts;
    assert.equal(r.bar.w, 220);
    assert.equal(r.bar.h, 10.5);
    p.parts.res.dx = 10;
    p.parts.res.dy = 4;
    const q = L.layoutPlate(p, full).parts;
    near(q.res.x - r.res.x, 20);
    near(q.res.y - r.res.y, 4.5); // 3 more px, times the height scale
  });

  it('children follow a moved parent', () => {
    const p = L.defaultProfile();
    const before = L.layoutPlate(p, full).parts;
    p.parts.bar.dy = -20;
    p.parts.bar.dx = 7;
    const after = L.layoutPlate(p, full).parts;
    for (const id of ['res', 'cast', 'auras', 'title', 'name', 'icon', 'marks'] as const) {
      near(after[id].x - before[id].x, 7);
      near(after[id].y - before[id].y, -20);
    }
  });

  it('a part stays attached when it is resized', () => {
    const p = L.defaultProfile();
    const a = L.layoutPlate(p, full).parts;
    p.bar.h = 20;
    const b = L.layoutPlate(p, full).parts;
    near(b.bar.y + b.bar.h, 0); // still sitting on the anchor
    near(b.res.y, 1 + 0); // the resource bar is still against its bottom
    assert.ok(b.bar.y < a.bar.y);
  });

  it('the buff row wraps at its width or in fixed columns', () => {
    const p = L.defaultProfile();
    p.auras.size = 20;
    p.auras.width = 120;
    const g = L.auraGrid(p, 6);
    assert.equal(g.perRow, 5); // 5 * 22 - 2 = 108 <= 120 < 130
    assert.equal(g.rows, 2);
    assert.equal(g.h, 42);
    p.auras.layout = 'columns';
    p.auras.cols = 1;
    const c = L.auraGrid(p, 3);
    assert.deepEqual([c.perRow, c.rows, c.w, c.h], [1, 3, 20, 64]);
    assert.deepEqual(L.auraGrid(p, 0), { perRow: 0, rows: 0, w: 0, h: 0 });
  });

  it('attaching to another part keeps its place unless asked to sit flush; loops are refused', () => {
    const p = L.defaultProfile();
    p.parts.auras.dy = 9;
    const was = L.layoutPlate(p, full).parts.auras;
    assert.ok(L.reattach(p, full, 'auras', 'bar', 'below'));
    const now = L.layoutPlate(p, full).parts.auras;
    near(now.x, was.x);
    near(now.y, was.y);
    assert.ok(L.reattach(p, full, 'auras', 'bar', 'below', true));
    assert.equal(p.parts.auras.dx + p.parts.auras.dy, 0);
    // the bar carries everything; it cannot hang from its own child
    assert.equal(L.canAttach(p.parts, 'bar', 'name'), false);
    assert.equal(L.reattach(p, full, 'bar', 'name', 'below'), false);
    assert.equal(p.parts.bar.to, 'plate');
    assert.deepEqual(L.descendants(p.parts, 'name').sort(), ['icon', 'marks']);
  });

  it('nudging moves a part by screen pixels, scaled back', () => {
    const p = L.defaultProfile();
    p.scaleW = 2;
    L.nudgePart(p, 'res', 10, -3);
    assert.equal(p.parts.res.dx, 5);
    assert.equal(p.parts.res.dy, 1 - 3);
  });
});

describe('nameplate snapping', () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

  it('snaps edges and centres to the other boxes, with guides', () => {
    // a box 3px right of another's left edge snaps its left edge to it
    const s = L.snapMove(box(53, 100, 40, 10), [box(50, 0, 100, 10)], {}, 6);
    assert.equal(s.dx, -3);
    assert.ok(s.guides.some((g) => g.axis === 'x' && g.at === 50));
    // its centre to the other's centre
    const c = L.snapMove(box(80, 40, 40, 10), [box(50, 0, 100, 10)], {}, 6);
    assert.equal(c.dx, 0);
    const c2 = L.snapMove(box(83, 40, 40, 10), [box(50, 0, 100, 10)], {}, 6);
    assert.equal(c2.dx, -3);
  });

  it('does not snap beyond the threshold, picks the nearest line, snaps axes on their own', () => {
    const none = L.snapMove(box(70, 70, 10, 10), [box(0, 0, 10, 10)], {}, 6);
    assert.deepEqual([none.dx, none.dy, none.guides.length], [0, 0, 0]);
    const s = L.snapMove(box(12, 30, 10, 10), [box(0, 0, 10, 10), box(11, 100, 10, 10)], {}, 6);
    assert.equal(s.dx, -1); // the line at 11, not 10
    assert.equal(s.dy, 0);
    const both = L.snapMove(box(2, 3, 10, 10), [], { x: [0], y: [0] }, 6);
    assert.deepEqual([both.dx, both.dy], [-2, -3]);
  });

  it('snaps to the plate\'s anchor lines', () => {
    const r = L.snapMove(box(-21, 4, 40, 10), [], { x: [0], y: [0] }, 6);
    assert.equal(r.dx, 1); // the centre (-1) goes to 0
    assert.equal(r.dy, -4);
    const edge = L.snapEdge(103, [0, 100, 140], 5);
    assert.deepEqual(edge, { delta: -3, at: 100 });
    assert.equal(L.snapEdge(120, [0, 100], 5), null);
  });

  it('whole-plate resize follows the corner, optionally in proportion', () => {
    const p = L.defaultProfile();
    const start = { scaleW: 1, scaleH: 1, w: 100, h: 50 };
    L.resizePlate(p, start, 100, 0, false);
    assert.equal(p.scaleW, 2);
    assert.equal(p.scaleH, 1);
    L.resizePlate(p, start, 50, 5, true);
    assert.equal(p.scaleW, 1.5);
    assert.equal(p.scaleH, 1.5);
    L.resizePlate(p, start, 100000, 0, false);
    assert.equal(p.scaleW, 3); // clamped
  });
});

describe('nameplate profiles', () => {
  it('defaults are valid and unchanged by validation', () => {
    const d = L.defaultProfile();
    assert.deepEqual(L.sanitizeProfile(d), d);
    assert.deepEqual(L.sanitizeProfile(JSON.parse(JSON.stringify(d))), d);
  });

  it('clamps, rounds and drops what is not valid', () => {
    const p = L.sanitizeProfile({ scaleW: 99, scaleH: -4, offsetY: 1e9, anchor: 'sideways', bar: { w: 'wide', h: 12.6, color: 'custom', custom: 'red', text: 'both' }, name: { color: 'custom', custom: '#ABCDEF', size: 0 }, auras: { which: 'cc', max: 100, layout: 'columns' }, show: 'yes', junk: 1 });
    assert.equal(p.scaleW, 3);
    assert.equal(p.scaleH, 0.4);
    assert.equal(p.offsetY, 150);
    assert.equal(p.anchor, 'head');
    assert.equal(p.bar.w, 110); // not a number: the default
    assert.equal(p.bar.h, 13);
    assert.equal(p.bar.custom, '#3fbf5f'); // not a colour
    assert.equal(p.bar.text, 'both');
    assert.equal(p.name.custom, '#abcdef');
    assert.equal(p.name.size, 6);
    assert.equal(p.auras.which, 'cc');
    assert.equal(p.auras.max, 16);
    assert.equal(p.show, true);
    for (const bad of [null, 5, 'x', [], undefined]) assert.deepEqual(L.sanitizeProfile(bad), L.defaultProfile());
  });

  it('fixes the fade distances and breaks attachment loops', () => {
    const p = L.sanitizeProfile({ fade: { on: true, near: 40, far: 10 } });
    assert.ok(p.fade.far > p.fade.near);
    const q = L.sanitizeProfile({ parts: { name: { to: 'icon', side: 'above', dx: 0, dy: 0 }, icon: { to: 'name', side: 'above', dx: 0, dy: 0 }, bar: { to: 'bar', side: 'over', dx: 1e6, dy: 'x' }, res: { to: 'nothing', side: 'diagonal' } } });
    for (const id of L.PART_IDS) {
      const seen = new Set<string>([id]);
      let cur = q.parts[id].to;
      while (cur !== 'plate') {
        assert.ok(!seen.has(cur), `loop at ${id}`);
        seen.add(cur);
        cur = q.parts[cur].to;
      }
    }
    assert.equal(q.parts.bar.to === 'bar', false);
    assert.equal(q.parts.bar.dx, 500);
    assert.equal(q.parts.res.to, 'bar'); // fell back to the default relation
    assert.equal(q.parts.res.side, 'below');
    // every field of the schema reads and writes through its path
    for (const f of L.PLATE_FIELDS) assert.notEqual(L.getPath(L.defaultProfile(), f.path), undefined, f.path);
  });

  it('every preset is a valid profile and differs from the others', () => {
    const seen = new Set<string>();
    for (const pr of L.PLATE_PRESETS) {
      const p = pr.make();
      assert.deepEqual(L.sanitizeProfile(p), p, pr.id);
      seen.add(JSON.stringify(p));
      // nothing is placed off the plate to nowhere
      const lay = L.layoutPlate(p, full);
      assert.ok(lay.bounds && lay.bounds.w > 0 && lay.bounds.w < 400, pr.id);
    }
    assert.equal(seen.size, L.PLATE_PRESETS.length);
    assert.deepEqual(L.PLATE_PRESETS[0].make(), L.defaultProfile());
    assert.deepEqual(L.PLATE_PRESETS.map((x) => x.id), ['classic', 'minimal', 'bold', 'raid']);
  });

  it('saves only what differs from the classic look, and reads it back exactly', () => {
    assert.deepEqual(L.compactProfile(L.defaultProfile()), {});
    const p = L.defaultProfile();
    p.bar.h = 12;
    p.parts.res.dx = 5;
    assert.deepEqual(L.compactProfile(p), { bar: { h: 12 }, parts: { res: { to: 'bar', side: 'below', dx: 5, dy: 1 } } });
    const all = [p, ...L.PLATE_PRESETS.map((x) => x.make()), L.migrateOldLook({ plateWidth: 'wide', plates: 'enemies' }).ally];
    const plainFeet = L.PLATE_PRESETS[2].make();
    L.setAnchor(plainFeet, 'feet'); // nothing rearranged: the saved text has no parts at all
    all.push(plainFeet);
    assert.equal('parts' in L.compactProfile(plainFeet), false);
    const feet = L.PLATE_PRESETS[2].make();
    L.setAnchor(feet, 'feet');
    feet.offsetY = -9;
    feet.parts.marks.dy = 6;
    all.push(feet);
    for (const q of all) {
      const text = JSON.stringify(L.compactProfile(q));
      assert.ok(text.length < 700, text.length + '');
      assert.deepEqual(L.sanitizeProfile(JSON.parse(text)), q);
    }
    assert.ok(JSON.stringify(L.compactProfile(L.PLATE_PRESETS[0].make())) === '{}');
  });

  it('resetting a part puts back its options and its attachment only', () => {
    const p = L.defaultProfile();
    p.bar.h = 30;
    p.res.h = 9;
    p.parts.res.dx = 8;
    L.resetPart(p, 'res');
    assert.equal(p.res.h, 4);
    assert.equal(p.parts.res.dx, 0);
    assert.equal(p.bar.h, 30);
  });
});

describe('old settings move into the three profiles', () => {
  it('no old settings: the classic look everywhere', () => {
    const m = L.migrateOldLook(undefined);
    for (const k of L.PLATE_KINDS) assert.deepEqual(m[k], L.defaultProfile());
    assert.deepEqual(L.migrateOldLook({ bar: 'flat' }).enemy, L.defaultProfile());
  });

  it('every old option lands in all three profiles', () => {
    const m = L.migrateOldLook({ plates: 'all', plateWidth: 'wide', plateBar: 'thick', plateHp: 'percent', plateColor: 'class', plateName: 'hide', plateText: 'lg', plateRes: 'hide', plateCast: 'hide', plateDebuffs: 'hide', targetBars: 'bright', targetArrow: 'off' });
    for (const k of L.PLATE_KINDS) {
      const p = m[k];
      assert.equal(p.bar.w, 130);
      assert.equal(p.bar.h, 11);
      assert.equal(p.res.h, 6);
      assert.equal(p.bar.text, 'percent');
      assert.equal(p.bar.color, 'class');
      assert.equal(p.name.show, false);
      assert.equal(p.name.size, 14);
      assert.equal(p.res.show, false);
      assert.equal(p.cast.show, false);
      assert.equal(p.auras.show, false);
      assert.equal(p.target.glow, 'bright');
      assert.equal(p.target.arrow, false);
      assert.deepEqual(L.sanitizeProfile(p), p);
    }
    assert.equal(L.migrateOldLook({ plateBar: 'thin', plateHp: 'value' }).me.bar.text, 'none'); // a thin bar never had room for its text
    assert.equal(L.migrateOldLook({ plateWidth: 'xwide' }).ally.bar.w, 170);
  });

  it('"show nameplates" decides which kinds are on', () => {
    const on = (plates: string) => L.PLATE_KINDS.map((k) => L.migrateOldLook({ plates })[k].show);
    assert.deepEqual(on('all'), [true, true, true]);
    assert.deepEqual(on('enemies'), [false, false, true]);
    assert.deepEqual(on('allies'), [true, true, false]);
    assert.deepEqual(on('off'), [false, false, false]);
  });

  it('garbage in the old look is ignored', () => {
    for (const bad of [null, 'x', 4, [], { plateWidth: 7, plates: {} }]) assert.deepEqual(L.migrateOldLook(bad).me, L.defaultProfile());
  });
});

describe('which profile a unit gets', () => {
  it('own, ally and enemy; bots and dummies by their team; nobody is "me" when watching', () => {
    assert.equal(L.plateKind({ id: 3, enemy: false }, 3), 'me');
    assert.equal(L.plateKind({ id: 4, enemy: false }, 3), 'ally');
    assert.equal(L.plateKind({ id: 5, enemy: true }, 3), 'enemy');
    assert.equal(L.plateKind({ id: 3, enemy: false }, 3, true), 'ally');
    assert.equal(L.plateKind({ id: 3, enemy: true }, 3, true), 'enemy');
    assert.equal(L.plateKind({ id: 9, enemy: true }, 0), 'enemy');
  });
});

describe('anchor, fade and effects', () => {
  it('projects from the head (above the model) or the feet, following the model height', () => {
    assert.equal(L.anchorWorldY('head', 0), 2.7);
    assert.equal(L.anchorWorldY('head', 4.5), 7.2); // on a deck
    assert.ok(L.anchorWorldY('feet', 0) < 0.1 && L.anchorWorldY('feet', 0) >= 0);
    near(L.anchorWorldY('feet', 3) - 3, L.FEET_LIFT);
  });

  it('fades with distance and shrinks only when asked', () => {
    const p = L.defaultProfile();
    assert.equal(L.fadeAlpha(p, 500), 1);
    assert.equal(L.distanceScale(p, 500), 1);
    p.fade.on = true;
    p.fade.near = 20;
    p.fade.far = 60;
    assert.equal(L.fadeAlpha(p, 10), 1);
    assert.equal(L.fadeAlpha(p, 40), 0.5);
    assert.equal(L.fadeAlpha(p, 60), 0);
    p.distScale = true;
    assert.equal(L.distanceScale(p, 10), 1);
    assert.equal(L.distanceScale(p, 24), 0.75);
    assert.equal(L.distanceScale(p, 36), 0.6);
    assert.equal(L.distanceScale(p, 1000), 0.6);
  });

  it('nearer plates are drawn over farther ones and the target\'s over all', () => {
    assert.ok(L.plateZ(5, false) > L.plateZ(30, false));
    assert.ok(L.plateZ(80, true) > L.plateZ(1, false));
  });

  it('picks the effects by the profile', () => {
    const info = (id: string) => ({ stun: { harmful: true, kind: 'stun' }, slow: { harmful: true, kind: 'slow' }, rend: { harmful: true, kind: 'dot' }, shield: { harmful: false, kind: 'absorb' } } as Record<string, { harmful: boolean; kind: string }>)[id];
    const auras = [{ id: 'stun', src: 1, expiresAt: 5 }, { id: 'slow', src: 2, expiresAt: 5 }, { id: 'rend', src: 1, expiresAt: 5 }, { id: 'shield', src: 1, expiresAt: 5 }];
    const a = L.defaultProfile().auras;
    assert.deepEqual(L.pickAuras(a, auras, info, 1).map((x) => x.id), ['stun', 'slow', 'rend']);
    assert.deepEqual(L.pickAuras({ ...a, which: 'all' }, auras, info, 1).map((x) => x.id), ['stun', 'slow', 'rend', 'shield']);
    assert.deepEqual(L.pickAuras({ ...a, which: 'mine' }, auras, info, 1).map((x) => x.id), ['stun', 'rend', 'shield']);
    assert.deepEqual(L.pickAuras({ ...a, which: 'cc' }, auras, info, 1).map((x) => x.id), ['stun']);
    assert.deepEqual(L.pickAuras({ ...a, which: 'all', max: 2 }, auras, info, 1).map((x) => x.id), ['stun', 'slow']);
    assert.deepEqual(L.pickAuras({ ...a, show: false }, auras, info, 1), []);
  });

  it('health bar text', () => {
    assert.equal(L.barText('none', 50, 100), '');
    assert.equal(L.barText('percent', 50, 100), '50%');
    assert.equal(L.barText('value', 50, 100), '50');
    assert.equal(L.barText('both', 50, 100), '50 · 50%');
    assert.equal(L.barText('percent', 0, 0), '0%');
  });

  it('the target arrow points at the unit', () => {
    assert.equal(L.arrowGlyph('▼', 'head'), '▼');
    assert.equal(L.arrowGlyph('▼', 'feet'), '▲');
    assert.equal(L.arrowGlyph('★', 'feet'), '★');
  });
});

describe('saving the profiles', () => {
  it('migrates the old look until a profile is saved, then keeps what was saved', () => {
    store.clear();
    store.set('arena.hud.look.v1', JSON.stringify({ plates: 'enemies', plateWidth: 'wide' }));
    const loaded = S.loadPlates();
    assert.equal(loaded.enemy.bar.w, 130);
    assert.equal(loaded.ally.show, false);
    assert.equal(store.has('arena.plates.enemy.v1'), false); // loading never writes
    const p = L.cloneProfile(S.plateProfile('ally'));
    p.show = true;
    p.anchor = 'feet';
    p.offsetY = 12;
    S.setPlate('ally', p);
    assert.ok(store.has('arena.plates.ally.v1'));
    S.loadPlates();
    assert.equal(S.plateProfile('ally').anchor, 'feet');
    assert.equal(S.plateProfile('ally').offsetY, 12);
    assert.equal(S.plateProfile('enemy').bar.w, 130); // still the migrated one
    assert.equal(JSON.parse(store.get('arena.hud.look.v1')!).plateWidth, 'wide'); // the old key is kept
  });

  it('copies, resets and validates what comes out of storage', () => {
    store.clear();
    S.loadPlates();
    const p = L.defaultProfile();
    p.name.size = 20;
    S.setPlate('enemy', p);
    S.copyPlate('enemy', 'me');
    assert.equal(S.plateProfile('me').name.size, 20);
    S.resetPlate('me');
    assert.equal(S.plateProfile('me').name.size, 11);
    store.set('arena.plates.ally.v1', '{"scaleW": 50, "bar": "no"}');
    store.set('arena.plates.me.v1', 'not json');
    S.loadPlates();
    assert.equal(S.plateProfile('ally').scaleW, 3);
    assert.deepEqual(S.plateProfile('me'), L.migrateOldLook(undefined).me);
  });

  it('notifies listeners and bumps the version', () => {
    store.clear();
    S.loadPlates();
    let n = 0;
    const off = S.onPlatesChange(() => n++);
    const v = S.plateVersion();
    S.setPlate('me', L.defaultProfile());
    assert.equal(n, 1);
    assert.ok(S.plateVersion() > v);
    off();
    S.setPlate('me', L.defaultProfile());
    assert.equal(n, 1);
  });

  it('is small enough to sync with the account, and the keys are arena.* settings', () => {
    store.clear();
    S.loadPlates();
    for (const k of L.PLATE_KINDS) {
      const p = L.defaultProfile();
      p.name.custom = '#ffffff';
      S.setPlate(k, p);
    }
    S.savePrefs({ snap: false, zoom: 2, guides: true });
    const snap = snapshotSettings();
    for (const k of L.PLATE_KINDS) assert.ok(snap[S.PLATE_KEY(k)], k);
    assert.ok(snap[S.PLATE_UI_KEY]);
    for (const k of L.PLATE_KINDS) assert.ok(snap[S.PLATE_KEY(k)].length < 700, snap[S.PLATE_KEY(k)]);
    const back = parseSettings(JSON.stringify(snap));
    assert.ok(back && Object.keys(back).length >= 4);
    assert.equal(S.loadPrefs().snap, false);
  });
});
