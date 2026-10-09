import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITIES, AURAS, ArenaSim, CLASSES, CLASS_IDS, SPECS, TALENTS, TUNING, compileMods, describeAbility, describeTalent, explainAbility, markedParts, modsNotIn, newMods, plainText, talentsFor } from '../src/index';
import type { Build, Mods } from '../src/index';
import type { ClassId } from '../src/index';

const TICK = TUNING.tickMs;

describe('tooltips match the sim', () => {
  it('there is no random damage variance', () => assert.equal(TUNING.damageVariance, 0));

  it('the damage a direct-damage ability lists is the damage it deals', () => {
    const bad: string[] = [];
    let checked = 0;
    for (const def of Object.values(ABILITIES)) {
      const eff = def.effects.find((e) => e.type === 'damage');
      if (!eff || def.channel || def.cpScale || def.behindMult || def.requiresStealth || def.maxTargetHealthPct !== undefined
        || def.requiresTargetCasting || def.requiresTargetAura || def.consumes || def.exploit || def.target === 'ground' || def.cpSpend) continue;
      const sim = new ArenaSim({ seed: 3, prepMs: 0 });
      const me = sim.addUnit({ name: 'me', classId: def.class as ClassId, team: 0 });
      const foe = sim.addUnit({ name: 'foe', classId: 'warrior', team: 1 });
      me.pos = { x: 0, z: 0 }; foe.pos = { x: 0, z: 2 };
      foe.maxHealth = foe.health = 1e7;
      me.bar = [def.id, ...me.bar.filter((x) => x !== def.id)];
      sim.step();
      me.resource = me.resourceMax; me.facing = 0; me.lastInput = { ...me.lastInput, facing: 0 };
      const r = sim.useAbility(me.id, def.id, def.target === 'self' || def.target === 'aoe_enemy' ? me.id : foe.id);
      if (!r.ok) continue;
      let dealt = 0;
      for (let t = 0; t < def.castTime + 2 * TICK; t += TICK) {
        sim.step();
        for (const e of sim.drainEvents()) if (e.t === 'damage' && e.tgt === foe.id && e.ability === def.id) dealt += e.amount;
      }
      const listed = Number(/(?:[Dd]eals|dealing) (\d+)/.exec(describeAbility(def, me.mods).lines.find((l) => /damage/.test(l)) ?? '')?.[1]);
      checked++;
      if (!(dealt > 0)) continue; // missed or conditional on something not set up here
      if (Math.abs(dealt - listed) > 1) bad.push(`${def.id}: tooltip ${listed}, dealt ${dealt}`);
    }
    assert.ok(checked > 15, `only checked ${checked}`);
    assert.deepEqual(bad, []);
  });
});

/** A sentence in comparable form: case, spacing and end punctuation do not matter. */
const sentences = (s: string) => s.split(/(?<=\.)\s+/).map((x) => x.toLowerCase().replace(/[\s.]+$/, '').trim()).filter(Boolean);

describe('tooltips say each thing once', () => {
  it('an effect line never repeats the ability name as the name of its own effect', () => {
    for (const def of Object.values(ABILITIES)) {
      for (const l of describeAbility(def).lines) assert.ok(!/^(Applies|You gain|Target gains) /.test(l) || !l.includes(` ${def.name} for `), `${def.id}: ${l}`);
    }
    const ham = describeAbility(ABILITIES.hamstring);
    assert.ok(ham.stats.includes(`${AURAS.hamstring_slow.duration / 1000}s slow`), ham.stats.join(' · '));
    assert.deepEqual(ham.lines, ['Movement speed reduced by 50%.'], 'the duration is the chip, not repeated in the line');
  });

  it('Charge states its stun once, inside the charge line', () => {
    const lines = describeAbility(ABILITIES.charge).lines;
    assert.equal(lines.filter((l) => /stun|Cannot move, cast or act/i.test(l)).length, 1, lines.join(' | '));
  });

  it('the in-depth view only adds detail, it never repeats a sentence of the short view', () => {
    const builds: { mods: ReturnType<typeof newMods>; label: string }[] = [{ mods: newMods(), label: 'base' }];
    for (const c of CLASS_IDS) for (const s of SPECS[c]) builds.push({ mods: compileMods(c, { spec: s.id, talents: [], gear: {} }), label: s.id });
    for (const { mods, label } of builds) {
      for (const def of Object.values(ABILITIES)) {
        const d = describeAbility(def, mods);
        const short = [...d.stats, ...d.lines, ...d.notes].flatMap(sentences);
        const more = explainAbility(def, mods, []).flatMap(sentences);
        for (const s of more) for (const t of short) assert.ok(s !== t && !(t.length > 12 && s.includes(t)) && !(s.length > 12 && t.includes(s)), `${label}/${def.id}: "${s}" repeats "${t}"`);
        assert.equal(new Set(more).size, more.length, `${label}/${def.id}: in-depth lines repeat themselves`);
      }
    }
    // the damage breakdown only shows once a bonus changes the number
    assert.ok(!explainAbility(ABILITIES.frostbolt, newMods(), []).some((l) => l.startsWith('Damage:')));
    // combo point scaling and Consumes are explained in the short view only
    assert.ok(!explainAbility(ABILITIES.eviscerate, newMods(), []).some((l) => /combo point/i.test(l)));
    assert.equal(ABILITIES.eviscerate.name, 'Weak Point');
    assert.ok(!explainAbility(ABILITIES.arcane_barrage, newMods(), []).some((l) => l.startsWith('Consumes')));
    // a buff that boosts both damage and healing is named once
    const penance = explainAbility(ABILITIES.penance, newMods(), []).find((l) => l.startsWith('Boosted by'));
    if (penance) assert.equal(penance.split('Power Infusion').length - 1, 1, penance);
  });

  it('generated modifier lines are only shown when the description does not already say them', () => {
    const mods = { ability: { heroic_leap: { cooldown: 0.75 }, charge: { cooldown: 0.85 } } };
    assert.deepEqual(modsNotIn('Heroic Leap recharges 25% sooner and Charge 15% sooner.', mods), []);
    assert.deepEqual(modsNotIn('Heroic Leap recharges 25% sooner.', mods), ['Charge: −15% cooldown']);
    assert.deepEqual(modsNotIn('Heroic Leap recharges 20% sooner and Charge 15% sooner.', mods), ['Heroic Leap: −25% cooldown'], 'a wrong number in the text keeps the true line visible');
    assert.deepEqual(modsNotIn('Polymorph casts 15% faster.', { ability: { polymorph: { castTime: 0.85, cooldown: 0.85 } } }), ['Polymorph: −15% cooldown'], 'the stat has to match too');
  });

  it('every talent tooltip states each modifier and its bar swap exactly once', () => {
    for (const c of CLASS_IDS) for (const tiers of Object.values(TALENTS[c])) for (const t of tiers.flat()) {
      const d = describeTalent(t);
      assert.deepEqual(d.mods, [], `${t.id}: "${t.desc}" leaves out ${d.mods.join(', ')}`);
      assert.equal(d.swap, undefined, `${t.id}: the description should say what it learns and replaces`);
      if (t.swap && ABILITIES[t.swap.to]?.name === t.name) assert.ok(!t.desc.includes(t.name), `${t.id}: the description repeats the talent's name`);
    }
  });
});

/** Every build worth checking: no spec, each spec bare, and each spec with each single talent picked. */
function everyBuild(): { label: string; classId: ClassId; build?: Build; mods: Mods }[] {
  const out: { label: string; classId: ClassId; build?: Build; mods: Mods }[] = [];
  for (const c of CLASS_IDS) {
    out.push({ label: c, classId: c, mods: newMods() });
    for (const s of SPECS[c]) {
      const bare: Build = { spec: s.id, talents: [], gear: {} };
      out.push({ label: s.id, classId: c, build: bare, mods: compileMods(c, bare) });
      talentsFor(c, s.id).forEach((tier, i) => tier.forEach((t) => {
        const b: Build = { spec: s.id, talents: Object.assign(Array(i).fill(''), { [i]: t.id }), gear: {} };
        out.push({ label: `${s.id}+${t.id}`, classId: c, build: b, mods: compileMods(c, b) });
      }));
    }
  }
  return out;
}

describe('tooltips state durations, costs and resource gains', () => {
  const secs = (ms: number) => Math.round(ms / 100) / 10;
  const has = (text: string, n: number, unit = 's') => new RegExp(`(?<![\\d.])${String(n).replace('.', '\\.')}${unit}\\b`).test(text);

  it('every ability (with every spec and talent) shows each cost, gain, cast, cooldown and duration', () => {
    const bad: string[] = [];
    for (const { label, classId, mods } of everyBuild()) {
      for (const def of Object.values(ABILITIES)) {
        if (def.class !== classId) continue;
        const d = describeAbility(def, mods);
        const text = [...d.stats, ...d.lines, ...d.added, ...d.notes].join(' | ');
        const am = mods.ability[def.id] ?? {};
        const res = CLASSES[def.class].resource.type;
        const need = (ok: boolean, what: string) => { if (!ok) bad.push(`${label}/${def.id}: no ${what} in "${text}"`); };
        if (def.cost) need(d.stats.includes(`${Math.round(def.cost * (am.cost ?? 1))} ${res}`), 'cost');
        if (def.castTime) need(has(text, secs(def.castTime * mods.castTime * (am.castTime ?? 1))), 'cast time');
        if (def.cooldown) need(d.stats.includes(`${secs(def.cooldown * (am.cooldown ?? 1))}s cooldown`), 'cooldown');
        if (def.channel) need(text.includes(`every ${secs((def.castTime * mods.castTime * (am.castTime ?? 1)) / def.channel.ticks)}s`), 'channel tick interval');
        if (def.cpGain) need(text.includes(`Awards ${def.cpGain} combo point`), 'combo points');
        if (am.stored) need(d.stats.includes(`${1 + am.stored} charges`), 'charges');
        if (res === 'rage' && !def.cost && def.effects.some((e) => e.type === 'damage' || (e.type === 'charge' && e.hit) || (e.type === 'leap' && e.damage))) need(/builds rage/.test(text), 'rage built by its damage');
        for (const e of [...def.effects, ...(am.extra ?? [])]) {
          if (e.type === 'gain') need(text.includes(`Generates ${e.amount} ${res}`), 'resource gain');
          if (e.type === 'interrupt') need(has(text, secs(e.lockout)), 'lockout');
          if (e.type === 'zone' || e.type === 'flag' || e.type === 'smoke') need(has(text, e.duration / 1000), `${e.type} duration`);
          if (e.type === 'zone') need(has(text, e.pulse / 1000), 'zone pulse');
          if (e.type === 'aura') {
            const a = AURAS[e.aura];
            const ms = (e.duration ?? a.duration) * (mods.auraDuration[e.aura] ?? 1);
            if (ms > 0) need(has(text, secs(ms)), `${a.name} duration`);
            if (a.dot) need(text.includes(`every ${secs(a.dot.interval)}s`), `${a.name} tick interval`);
            if (e.extraPerCp) need(text.includes(`+${secs(e.extraPerCp)}s per combo point`), 'duration per combo point');
          }
        }
      }
    }
    assert.deepEqual(bad.slice(0, 20), []);
  });

  it("You're Not Going Anywhere says how long the banner stands, once", () => {
    const d = describeAbility(ABILITIES.not_going_anywhere);
    assert.ok(d.stats.includes('8s banner'), d.stats.join(' · '));
    assert.ok(!/8s|8 sec/.test(d.lines.join(' ')), 'not repeated in the line');
    assert.ok(d.stats.includes(`${ABILITIES.not_going_anywhere.cost} rage`));
  });

  it('marking the numbers a build changes never changes the text itself', () => {
    let marks = 0;
    for (const { mods } of everyBuild()) {
      for (const def of Object.values(ABILITIES)) {
        const plain = describeAbility(def, mods);
        const m = describeAbility(def, mods, undefined, { mark: true });
        assert.deepEqual({ ...m, stats: m.stats.map(plainText), lines: m.lines.map(plainText), added: m.added.map(plainText), notes: m.notes.map(plainText) }, plain, def.id);
        marks += [...m.stats, ...m.lines].filter((l) => markedParts(l).some((p) => !('text' in p))).length;
      }
    }
    assert.ok(marks > 50, 'talents and specs do mark numbers');
    const ww = describeAbility(ABILITIES.whirlwind, compileMods('warrior', { spec: 'arms', talents: ['', '', 'warrior_arms_t3a'], gear: {} }), undefined, { mark: true });
    assert.ok([...ww.stats, ...ww.lines].some((s) => s.includes('⟦') && s.includes('|+⟧')), `stronger Cleave is marked: ${ww.lines.join(' ')}`);
    assert.deepEqual(markedParts('Deals ⟦156|120|+⟧ damage.'), [{ text: 'Deals ' }, { value: '156', base: '120', better: true }, { text: ' damage.' }]);
  });
});
