import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GEAR, MAX_INVENTORY, RARITIES, bestGear, compileMods, gearStats, itemById, lootItem, rollLoot, statBonuses, validateBuild, TUNING } from '../src/index';
import type { Build } from '../src/index';

const seeded = (seed: number) => {
  let a = seed;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
};
const build = (gear: Record<string, string>): Build => ({ spec: 'frost', talents: [], gear });

describe('loot items', () => {
  it('the same id always yields the same item, and itemById resolves it', () => {
    const id = 'L.epic.weapon.k3f9a2';
    const a = lootItem(id)!;
    const b = lootItem(id)!;
    assert.deepEqual(a, b);
    assert.equal(itemById(id)?.name, a.name);
    assert.equal(a.slot, 'weapon');
    assert.equal(a.rarity, 'epic');
  });

  it('rejects malformed ids', () => {
    for (const bad of ['L.epic.weapon', 'L.mythic.weapon.abcd12', 'L.epic.boots.abcd12', 'L.epic.weapon.ABCD', 'X.epic.weapon.abcd12', 'L.epic.weapon.abcd12.x']) assert.equal(lootItem(bad), undefined, bad);
  });

  it('stat budgets scale with rarity and stay close to the tier budgets', () => {
    const rand = seeded(7);
    const avg: Record<string, number> = {};
    for (const r of RARITIES) {
      let sum = 0;
      for (let i = 0; i < 200; i++) {
        const it = lootItem(`L.${r.id}.chest.${rollLoot(rand).split('.')[3]}`)!;
        sum += Object.values(it.stats).reduce((a, b) => a + b, 0);
        assert.ok(Object.values(it.stats).filter((v) => v > 0).length <= r.lines);
      }
      avg[r.id] = sum / 200;
    }
    assert.ok(avg.common < avg.uncommon && avg.uncommon < avg.rare && avg.rare < avg.epic && avg.epic < avg.legendary);
    const chestWeight = GEAR.slots.find((s) => s.id === 'chest')!.weight;
    assert.ok(avg.legendary <= 22 * chestWeight * 1.2 + 4, 'legendary within ~20% of its nominal budget');
  });

  it('perks only appear on epic and legendary, and legendaries always carry one', () => {
    const rand = seeded(11);
    let epicPerks = 0;
    for (let i = 0; i < 300; i++) {
      const id = rollLoot(rand, { minRarity: 'common' });
      const it = lootItem(id)!;
      if (['common', 'uncommon', 'rare'].includes(it.rarity!)) assert.equal(it.perk, undefined);
      if (it.rarity === 'legendary') assert.ok(it.perk);
      if (it.rarity === 'epic' && it.perk) epicPerks++;
    }
    for (let i = 0; i < 30; i++) assert.ok(lootItem(rollLoot(rand, { minRarity: 'legendary' }))!.perk);
    void epicPerks;
  });

  it('rarity drop rates roughly follow the weights and respect min/max', () => {
    const rand = seeded(3);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 5000; i++) {
      const r = lootItem(rollLoot(rand))!.rarity!;
      counts[r] = (counts[r] ?? 0) + 1;
    }
    assert.ok(counts.common > counts.uncommon && counts.uncommon > counts.rare && counts.rare > counts.epic);
    assert.ok((counts.legendary ?? 0) < 120, 'legendary stays rare');
    for (let i = 0; i < 200; i++) assert.ok(['common', 'uncommon', 'rare'].includes(lootItem(rollLoot(rand, { maxRarity: 'rare' }))!.rarity!));
    for (let i = 0; i < 200; i++) assert.ok(['epic', 'legendary'].includes(lootItem(rollLoot(rand, { minRarity: 'epic' }))!.rarity!));
  });
});

describe('loot in builds', () => {
  it('can only be equipped when owned, in the right slot', () => {
    const id = 'L.rare.head.abcd12';
    assert.equal(validateBuild('mage', build({ head: id }), 99).ok, false, 'guests never own loot');
    assert.equal(validateBuild('mage', build({ head: id }), 99, ['L.rare.head.zzzz99']).ok, false);
    assert.equal(validateBuild('mage', build({ head: id }), 99, [id]).ok, true);
    assert.equal(validateBuild('mage', build({ head: id }), 99, new Set([id])).ok, true);
    assert.equal(validateBuild('mage', build({ chest: id }), 99, [id]).ok, false, 'wrong slot');
  });

  it('loot stats feed the same capped bonuses', () => {
    const gear: Record<string, string> = {};
    for (const slot of GEAR.slots) gear[slot.id] = rollLoot(() => 0.9999, { minRarity: 'legendary' }).replace(/\.[a-z]+\.[a-z0-9]{6}$/, `.${slot.id}.zzzzzz`);
    const bonuses = statBonuses(gearStats(gear));
    for (const v of Object.values(bonuses)) assert.ok(v <= (TUNING.gearCap - 1) * 100 + 1e-9);
  });

  it('the same perk on several pieces only counts once', () => {
    let first: string | undefined;
    const ids: Record<string, string> = {};
    const slots = GEAR.slots.map((s) => s.id);
    for (let n = 0; n < 4000 && Object.keys(ids).length < 2; n++) {
      const id = `L.legendary.${slots[Object.keys(ids).length]}.${n.toString(36).padStart(5, '0')}`;
      const it = lootItem(id)!;
      if (it.perk === 'windrunner') {
        first ??= it.perk;
        ids[it.slot] = id;
      }
    }
    assert.equal(Object.keys(ids).length, 2, 'found two windrunner pieces');
    const one = compileMods('mage', { spec: 'frost', talents: [], gear: { [Object.keys(ids)[0]]: Object.values(ids)[0] } });
    const two = compileMods('mage', { spec: 'frost', talents: [], gear: ids });
    assert.equal(one.moveSpeed, two.moveSpeed);
    assert.ok(one.moveSpeed > 1.04);
  });

  it('auto-equip prefers loot that beats set gear for the flavor', () => {
    const base = bestGear('fury', 999);
    assert.deepEqual(bestGear('fury', 999, []), base);
    const rand = seeded(5);
    let best = '';
    for (let i = 0; i < 400; i++) {
      const id = rollLoot(rand, { minRarity: 'legendary' }).replace(/\.[a-z]+\.([a-z0-9]{6})$/, '.weapon.$1');
      best = id;
      if (bestGear('fury', 999, [id]).weapon === id) break;
    }
    assert.equal(bestGear('fury', 999, [best]).weapon, best, 'a strong enough legendary weapon wins the slot');
  });

  it('inventory cap constant is sane', () => assert.ok(MAX_INVENTORY >= 30));
});
