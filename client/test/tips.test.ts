import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, AURAS, CLASS_IDS, COSMETICS, SPECS, TALENTS, markedParts, plainText, talentsFor } from '@arena/shared';
import { CLASS_BLURB, resolveTip, setTipBuild, tipBuildKey } from '../src/tips';
import { dedupeTip } from '../src/tooltip';
import type { TipContent } from '../src/tooltip';

/** Every row a tooltip can show (the in-depth rows included), split into comparable sentences. */
function sentences(c: TipContent): string[] {
  const rows = [c.title, ...(c.stats ?? []), ...(c.lines ?? []), ...(c.good ?? []), ...(c.bad ?? []), ...(c.notes ?? []), ...(c.more ?? []), ...(c.footer ? [c.footer] : [])];
  return rows.flatMap((r) => r.split(/(?<=\.)\s+/)).map((s) => s.toLowerCase().replace(/[\s.:]+$/, '').trim()).filter(Boolean);
}

function assertNoRepeats(key: string, c: TipContent | null) {
  assert.ok(c, `${key} has a tooltip`);
  const all = sentences(c);
  all.forEach((s, i) => all.forEach((t, j) => {
    if (i >= j) return;
    assert.ok(s !== t && !(t.length > 12 && s.includes(t)) && !(s.length > 12 && t.includes(s)), `${key}: "${s}" and "${t}"`);
  }));
}

describe('every tooltip says each thing once', () => {
  it('abilities, for every spec (with the talent-swapped abilities too)', () => {
    for (const c of CLASS_IDS) for (const spec of SPECS[c]) {
      setTipBuild(c, { spec: spec.id, talents: [], gear: {} });
      const ids = new Set(spec.bar);
      for (const t of talentsFor(c, spec.id).flat()) if (t.swap) ids.add(t.swap.to);
      for (const id of ids) assertNoRepeats(`${spec.id}/${id}`, resolveTip(`ability:${id}`, {}));
    }
    setTipBuild('mage', undefined);
    for (const id of Object.keys(ABILITIES)) assertNoRepeats(id, resolveTip(`ability:${id}`, {}));
  });

  it('auras, talents, classes and cosmetics', () => {
    for (const id of Object.keys(AURAS)) assertNoRepeats(id, resolveTip(`aura:${id}`, {}));
    for (const c of CLASS_IDS) {
      for (const t of Object.values(TALENTS[c]).flat(2)) {
        const tip = resolveTip(`talent:${c}:${t.id}`, {});
        assertNoRepeats(t.id, tip);
        assert.deepEqual([tip!.good, tip!.stats], [[], undefined], `${t.id}: its description already states the numbers and the swap`);
      }
      assertNoRepeats(c, resolveTip(`class:${c}`, { tipText: CLASS_BLURB[c] }));
    }
    for (const item of COSMETICS.items) assertNoRepeats(item.id, resolveTip(`item:${item.id}`, {}));
  });

  it('a text tip whose body only restates its title shows just the title', () => {
    assert.deepEqual(resolveTip('text', { tipTitle: 'Ranked', tipText: 'Ranked match' })?.lines, []);
    assert.deepEqual(resolveTip('text', { tipTitle: 'Ranked', tipText: 'Your rating changes with the result.' })?.lines, ['Your rating changes with the result.']);
  });

  it('the renderer drops any row that repeats the title or an earlier row', () => {
    const c = dedupeTip({ title: 'Blink', stats: ['Instant'], lines: ['Blink.', 'Teleports you forward.'], notes: ['Teleports you forward'], more: ['Instant.'], footer: 'Hotkey: 1' });
    assert.deepEqual([c.lines, c.notes, c.more, c.footer], [['Teleports you forward.'], [], [], 'Hotkey: 1']);
  });
});

describe('tooltips follow the build', () => {
  const marks = (c: ReturnType<typeof resolveTip>) => [...(c?.stats ?? []), ...(c?.lines ?? [])].flatMap((l) => markedParts(l).filter((p) => !('text' in p)));

  it('picking a talent changes the numbers at once, marked against the base value', () => {
    setTipBuild('warrior', { spec: 'fury', talents: [], gear: {} });
    const before = resolveTip('ability:slam', {})!;
    assert.ok(before.stats!.includes('40 rage'));
    setTipBuild('warrior', { spec: 'fury', talents: ['', '', 'warrior_fury_t3c'], gear: {} });
    const after = resolveTip('ability:slam', {})!;
    assert.ok(after.stats!.some((s) => plainText(s) === '34 rage'), after.stats!.join(' · '));
    assert.deepEqual(marks(after).find((p) => 'base' in p && p.base === '40'), { value: '34', base: '40', better: true });
  });

  it('what a talent adds to a skill is listed as a bonus', () => {
    setTipBuild('rogue', { spec: 'assassination', talents: ['rogue_t1c'], gear: {} });
    assert.deepEqual(resolveTip('ability:vanish', {})!.good, ['Heals you for 75% of your missing health.']);
  });

  it('a data-tip-build key describes that build instead of the current one (the spec cards in the menu)', () => {
    setTipBuild('warrior', { spec: 'arms', talents: [], gear: {} });
    const fury = tipBuildKey('warrior', { spec: 'fury', talents: ['', '', 'warrior_fury_t3c'], gear: {} });
    assert.ok(resolveTip('ability:slam', { tipBuild: fury })!.stats!.some((s) => plainText(s) === '34 rage'));
    assert.ok(resolveTip('ability:slam', {})!.stats!.includes('40 rage'), 'the current build is untouched');
    setTipBuild('mage', undefined);
  });
});
