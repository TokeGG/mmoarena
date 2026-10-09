import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, ArenaSim, AURAS, autoFor, CLASSES, DEV_PAGES, SPECS, TALENTS, TUNING, applyPatches, compileMods, currentValue, entryFor, fileDefault, isAddition, mergePatches, navFor, patchOf, tunableNumbers, validPatch } from '../src/index';
import type { DataPatch, DevField } from '../src/index';

const warden = { spec: 'discipline', talents: [], gear: {} };
const spec = (id: string) => Object.values(SPECS).flat().find((s) => s.id === id)!;

describe('passives can be edited: specs, talents, classes, auras and the game options', () => {
  it('a spec passive number changes the compiled mods, and is put back', () => {
    const pws = () => compileMods('priest', warden).ability.power_word_shield?.heal;
    assert.equal(pws(), 1.5);
    const undo = applyPatches([{ file: 'specs', id: 'discipline', path: ['mods', 'ability', 'power_word_shield', 'heal'], value: 2.25 }]);
    assert.equal(pws(), 2.25);
    undo();
    assert.equal(pws(), 1.5);
  });

  it("a spec's switch (the Warden's moving Penance) can be turned off and on", () => {
    const moving = () => !!compileMods('priest', warden).ability.penance?.castWhileMoving;
    assert.ok(moving());
    const off: DataPatch = { file: 'specs', id: 'discipline', path: ['mods', 'ability', 'penance', 'castWhileMoving'], value: 0 };
    assert.ok(validPatch(off));
    assert.equal(currentValue(off), 1);
    const undo = applyPatches([off]);
    assert.ok(!moving());
    assert.equal(currentValue(off), 0);
    undo();
    assert.ok(moving());
    // a switch takes 1 or 0 only
    assert.ok(!validPatch({ ...off, value: 5 }));
    assert.ok(!validPatch({ ...off, value: 'yes' }));
  });

  it('a stat bonus a spec does not have yet can be added, then vanishes again', () => {
    const holy = spec('holy');
    assert.deepEqual(holy.mods, {});
    const dmg: DataPatch = { file: 'specs', id: 'holy', path: ['mods', 'damageDone'], value: 1.3 };
    assert.ok(validPatch(dmg));
    assert.equal(currentValue(dmg), 1, 'reads as the neutral value before');
    assert.ok(isAddition(dmg));
    const undo = applyPatches([dmg, { file: 'specs', id: 'holy', path: ['mods', 'ability', 'smite', 'damage'], value: 2 }, { file: 'specs', id: 'holy', path: ['mods', 'ability', 'smite', 'castWhileMoving'], value: 1 }, { file: 'specs', id: 'holy', path: ['mods', 'auraDuration', 'pw_shield'], value: 3 }]);
    const m = compileMods('priest', { spec: 'holy', talents: [], gear: {} });
    assert.equal(m.damageDone, 1.3);
    assert.equal(m.ability.smite.damage, 2);
    assert.ok(m.ability.smite.castWhileMoving);
    assert.equal(m.auraDuration.pw_shield, 3);
    undo();
    assert.deepEqual(holy.mods, {}, 'the data is exactly as the file has it');
    assert.equal(compileMods('priest', { spec: 'holy', talents: [], gear: {} }).damageDone, 1);
  });

  it('only real stat changes can be added: unknown keys, skills and the wrong kind of value are refused', () => {
    const bad: DataPatch[] = [
      { file: 'specs', id: 'holy', path: ['mods', 'nonsense'], value: 1 },
      { file: 'specs', id: 'holy', path: ['mods', 'ability', 'no_such_skill', 'damage'], value: 1 },
      { file: 'specs', id: 'holy', path: ['mods', 'ability', 'smite', 'nonsense'], value: 1 },
      { file: 'specs', id: 'holy', path: ['mods', 'ability', 'smite', 'extra', 0, 'amount'], value: 1 },
      { file: 'specs', id: 'holy', path: ['mods', 'auraDuration', 'no_such_aura'], value: 1 },
      { file: 'specs', id: 'holy', path: ['mods', 'damageDone', 'x'], value: 1 },
      { file: 'specs', id: 'holy', path: ['name'], value: 1 },
      { file: 'specs', id: 'holy', path: ['bar', 0], value: 1 },
      { file: 'abilities', id: 'smite', path: ['mods', 'damageDone'], value: 1 },
      { file: 'classes', id: 'mage', path: ['mods', 'damageDone'], value: 1 },
    ];
    for (const p of bad) assert.ok(!validPatch(p), JSON.stringify(p.path));
  });

  it('a talent in several specs is changed in every copy, and a stat can be added to all of them', () => {
    const copies = Object.values(TALENTS.warrior).flatMap((t) => t.flat()).filter((t) => t.id === 'warrior_t2a');
    assert.ok(copies.length >= 3);
    const undo = applyPatches([
      { file: 'talents', id: 'warrior_t2a', path: ['mods', 'autoSpeed'], value: 0.5 },
      { file: 'talents', id: 'warrior_t2a', path: ['mods', 'damageTaken'], value: 0.9 },
    ]);
    assert.ok(copies.every((t) => (t.mods as Record<string, number>).autoSpeed === 0.5 && (t.mods as Record<string, number>).damageTaken === 0.9));
    const built = compileMods('warrior', { spec: 'arms', talents: ['', 'warrior_t2a'], gear: {} });
    assert.equal(built.autoSpeed, 0.5);
    assert.equal(built.damageTaken, 0.9);
    undo();
    assert.ok(copies.every((t) => !('damageTaken' in (t.mods as object))));
    assert.ok(copies.every((t) => (t.mods as Record<string, number>).autoSpeed !== 0.5));
  });

  it('class stats, a spec weapon swing and an aura buff are numbers too, and mods of an aura can get a new stat', () => {
    const undo = applyPatches([
      { file: 'classes', id: 'mage', path: ['resource', 'regenPerSec'], value: 99 },
      { file: 'specs', id: 'fury', path: ['auto', 'interval'], value: 1000 },
      { file: 'auras', id: 'polymorph', path: ['harmful'], value: 0 },
      { file: 'auras', id: 'polymorph', path: ['mods', 'moveSpeed'], value: 0.5 },
    ]);
    assert.equal(CLASSES.mage.resource.regenPerSec, 99);
    assert.equal(spec('fury').auto!.interval, 1000);
    assert.equal(AURAS.polymorph.harmful, false);
    assert.equal((AURAS.polymorph as { mods?: { moveSpeed?: number } }).mods?.moveSpeed, 0.5);
    undo();
    assert.equal(CLASSES.mage.resource.regenPerSec, 24);
    assert.equal(spec('fury').auto!.interval, 3000);
    assert.equal(AURAS.polymorph.harmful, true);
    assert.ok(!('mods' in AURAS.polymorph));
  });

  it('fileDefault is the file value even while a patch is applied', () => {
    const p: DataPatch = { file: 'specs', id: 'discipline', path: ['mods', 'ability', 'power_word_shield', 'heal'], value: 9 };
    const undo = applyPatches([p]);
    assert.equal(currentValue(p), 9);
    assert.equal(fileDefault(p), 1.5);
    undo();
  });
});

describe('the game options (tuning.json) can be patched', () => {
  it('a number is patched live and put back; the server tick is locked', () => {
    const was = TUNING.gcdMs;
    const undo = applyPatches([{ file: 'tuning', id: 'game', path: ['gcdMs'], value: 1500 }, { file: 'tuning', id: 'game', path: ['drSteps', 1], value: 0.4 }]);
    assert.equal(TUNING.gcdMs, 1500);
    assert.equal(TUNING.drSteps[1], 0.4);
    undo();
    assert.equal(TUNING.gcdMs, was);
    assert.equal(TUNING.drSteps[1], 0.5);
    assert.ok(!validPatch({ file: 'tuning', id: 'game', path: ['tickMs'], value: 20 }));
    assert.ok(!validPatch({ file: 'tuning', id: 'game', path: ['nonsense'], value: 20 }));
    assert.ok(!validPatch({ file: 'tuning', id: 'other', path: ['gcdMs'], value: 20 }));
    assert.ok(!tunableNumbers('tuning', 'game').some((t) => t.path[0] === 'tickMs'));
  });

  it('the Cauterize passive follows its numbers in a match', () => {
    const sim = new ArenaSim({ seed: 1, prepMs: 0 });
    const m = sim.addUnit({ name: 'm', classId: 'mage', team: 0, build: { spec: 'fire', talents: [], gear: {} } });
    const w = sim.addUnit({ name: 'w', classId: 'warrior', team: 1 });
    const undo = applyPatches([{ file: 'tuning', id: 'game', path: ['cauterizeHealth'], value: 0.6 }]);
    sim.dealDamage(w, m, 1e6, 'physical', null);
    undo();
    assert.ok(m.alive);
    assert.equal(m.health, Math.round(m.maxHealth * 0.6));
  });
});

describe('a patch reaches the units already in a match', () => {
  it('refreshMods works the Warden passive, a new stat and a talent out again for every unit', () => {
    const sim = new ArenaSim({ seed: 1, prepMs: 0 });
    const p = sim.addUnit({ name: 'p', classId: 'priest', team: 0, build: warden });
    const h = sim.addUnit({ name: 'h', classId: 'priest', team: 1, build: { spec: 'holy', talents: [], gear: {} } });
    const w = sim.addUnit({ name: 'w', classId: 'warrior', team: 1, build: { spec: 'arms', talents: ['', 'warrior_t2b'], gear: {} } });
    const hp = { p: p.maxHealth, h: h.maxHealth, w: w.maxHealth };
    assert.equal(p.mods.ability.power_word_shield.heal, 1.5);
    const undo = applyPatches([
      { file: 'specs', id: 'discipline', path: ['mods', 'ability', 'power_word_shield', 'heal'], value: 3 },
      { file: 'specs', id: 'holy', path: ['mods', 'maxHealth'], value: 2 },
      { file: 'talents', id: 'warrior_t2b', path: ['mods', 'maxHealth'], value: 1.5 },
      { file: 'specs', id: 'discipline', path: ['mods', 'ability', 'penance', 'castWhileMoving'], value: 0 },
    ]);
    sim.refreshMods();
    undo();
    assert.equal(p.mods.ability.power_word_shield.heal, 3);
    assert.ok(!p.mods.ability.penance.castWhileMoving);
    assert.equal(h.maxHealth, hp.h * 2);
    assert.equal(h.health, h.maxHealth, 'full health stays full');
    assert.equal(w.maxHealth, Math.round(CLASSES.warrior.maxHealth * 1.5));
    sim.refreshMods(); // the numbers go back
    assert.equal(p.mods.ability.power_word_shield.heal, 1.5);
    assert.ok(p.mods.ability.penance.castWhileMoving);
    assert.equal(h.maxHealth, hp.h);
    assert.equal(w.maxHealth, hp.w);
  });

  it('a spec auto-attack patch is what the unit swings with at once', () => {
    const sim = new ArenaSim({ seed: 1, prepMs: 0 });
    sim.addUnit({ name: 'a', classId: 'warrior', team: 0, build: { spec: 'arms', talents: [], gear: {} } });
    const undo = applyPatches([{ file: 'specs', id: 'arms', path: ['auto', 'damage'], value: 1000 }]);
    assert.equal(autoFor('warrior', 'arms')!.damage, 1000);
    undo();
    assert.equal(autoFor('warrior', 'arms')!.damage, 45);
  });
});

describe('the catalogue behind the pages', () => {
  const allEntries = () => {
    const out: { page: (typeof DEV_PAGES)[number]['id']; id: string }[] = [];
    for (const pg of DEV_PAGES) {
      const walk = (g: ReturnType<typeof navFor>[number]) => {
        for (const e of g.entries) out.push({ page: pg.id, id: e.id });
        g.groups?.forEach(walk);
      };
      navFor(pg.id).forEach(walk);
    }
    return out;
  };

  it('every entry opens, every field is a valid patch of its own value, and the files agree', () => {
    for (const { page, id } of allEntries()) {
      if (page === 'skills') {
        assert.ok(ABILITIES[id], id);
        continue;
      }
      const e = entryFor(page, id);
      assert.ok(e, `${page}/${id}`);
      const seen = new Set<string>();
      for (const g of e.groups) {
        for (const f of g.fields) {
          assert.ok(f.label && f.label.length > 2, `${page}/${id} label of ${f.path.join('.')}`);
          const k = `${f.file}:${f.id}:${f.path.join('.')}`;
          assert.ok(!seen.has(k), `${page}/${id} lists ${k} twice`);
          seen.add(k);
          assert.ok(validPatch(patchOf(f, f.value)), `${page}/${id} ${k} = ${f.value}`);
          assert.equal(String(f.base), String(fileDefault(f)), k);
        }
      }
    }
  });

  it('every number of the classes, specs, talents, auras and game options is on some page', () => {
    const listed = new Set<string>();
    for (const { page, id } of allEntries()) {
      if (page === 'skills') continue;
      for (const g of entryFor(page, id)!.groups) for (const f of g.fields) listed.add(`${f.file}:${f.id}:${f.path.join('.')}`);
    }
    const missing: string[] = [];
    const check = (file: DataPatch['file'], id: string) => {
      for (const t of tunableNumbers(file, id)) if (!listed.has(`${file}:${id}:${t.path.join('.')}`)) missing.push(`${file}:${id}:${t.path.join('.')}`);
    };
    for (const c of Object.keys(CLASSES)) check('classes', c);
    for (const s of Object.values(SPECS).flat()) check('specs', s.id);
    for (const id of new Set(Object.values(TALENTS).flatMap((b) => Object.values(b).flat(2)).map((t) => t.id))) check('talents', id);
    for (const id of Object.keys(AURAS)) check('auras', id);
    check('tuning', 'game');
    assert.deepEqual(missing, []);
  });

  it('the Warden page names its passives in words and the Pyromancy page has Cauterize', () => {
    const w = entryFor('passives', 's:discipline')!;
    const fields = w.groups.flatMap((g) => g.fields);
    const pws = fields.find((f) => f.path.join('.') === 'mods.ability.power_word_shield.heal') as DevField;
    assert.match(pws.label, /Power Word: Shield/);
    assert.match(pws.label, /shield strength/);
    assert.equal(pws.unit, 'x');
    const moving = fields.find((f) => f.path.join('.') === 'mods.ability.penance.castWhileMoving') as DevField;
    assert.equal(moving.kind, 'switch');
    assert.equal(moving.value, 1);
    assert.ok(w.lines.some((l) => /shield strength/i.test(l)));
    const fire = entryFor('passives', 's:fire')!.groups.flatMap((g) => g.fields).map((f) => f.path.join('.'));
    assert.ok(fire.includes('cauterizeHealth') && fire.includes('cauterizeCooldownMs'));
    // a spec without a stat gets every stat offered, flagged as new
    const holy = entryFor('passives', 's:holy')!.groups.flatMap((g) => g.fields);
    assert.ok(holy.filter((f) => f.added).length >= 12);
    assert.ok(!entryFor('options', 'game')!.groups.flatMap((g) => g.fields).some((f) => f.path[0] === 'tickMs'));
  });

  it('later patches to the same value replace earlier ones', () => {
    const a: DataPatch = { file: 'tuning', id: 'game', path: ['gcdMs'], value: 1200 };
    assert.deepEqual(mergePatches([a], [{ ...a, value: 900 }]), [{ ...a, value: 900 }]);
  });
});
