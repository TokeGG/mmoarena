import rotationsJson from '../data/rotations.json' with { type: 'json' };
import { ABILITIES, AURAS } from './data';
import { ArenaSim } from './sim';
import { TUNING } from './data';
import type { Build, ClassId, Unit } from './types';

/**
 * Damage rotations: for each spec, the order in which its damage abilities are pressed when nothing more urgent is going
 * on. The order is learned offline (scripts/train-rotations.ts searches orders against a target dummy and keeps the one
 * that deals the most damage with the real cooldowns, costs, procs and combo points) and stored in
 * shared/data/rotations.json. Payoffs (combo point finishers, rage dumps) are not part of the order: they go off at their
 * own thresholds (see `spendPayoff`), which is also how the trainer plays them.
 */
const LEARNED = rotationsJson as Record<string, string[]>;

/** A filler or cooldown that deals damage to an enemy, which the rotation may press (not finishers, gap closers or ground spells). */
export function isRotationAbility(id: string): boolean {
  const d = ABILITIES[id];
  if (!d || d.cpSpend || d.rageSpend || d.target === 'ground' || d.target === 'self' || d.target === 'aoe_all') return false;
  if (d.effects.some((e) => e.type === 'charge' || e.type === 'dashToTarget' || e.type === 'interrupt' || e.type === 'pull')) return false;
  if (d.maxTargetHealthPct !== undefined || d.requiresTargetCasting) return false; // only now and then (Execute): the class logic handles those
  // crowd control is spent on purpose (to peel, to set up a kill), not as filler; a damage channel that stuns as it goes (Slice and Dice) is filler
  const cc = d.effects.some((e) => e.type === 'aura' && ['stun', 'incapacitate', 'fear', 'root'].includes(AURAS[e.aura]?.kind ?? ''));
  if (cc && !d.channel) return false;
  return d.effects.some((e) => e.type === 'damage' || e.type === 'exsanguinate');
}

/** The learned order for this spec, keeping what is on the bar, then any other damage ability on the bar (a talent swap the order has not seen). */
export function rotationFor(classId: ClassId, spec: string | null, bar: readonly string[]): string[] | null {
  const learned = LEARNED[`${classId}:${spec ?? ''}`];
  if (!learned) return null;
  const order = learned.filter((id) => bar.includes(id) && isRotationAbility(id));
  for (const id of bar) if (isRotationAbility(id) && !order.includes(id)) order.push(id);
  return order;
}

/** Combo points and rage are cashed in at a full-ish bar: 4+ combo points, 70+ rage. True if something went off. */
export function spendPayoff(sim: ArenaSim, u: Unit, target: number): boolean {
  for (const id of u.bar) {
    const d = ABILITIES[id];
    if (!d) continue;
    const dealsDamage = d.effects.some((e) => e.type === 'damage' || e.type === 'exsanguinate' || (e.type === 'aura' && !!e.cpDot));
    if (d.cpSpend && dealsDamage && u.cp >= 4 && sim.useAbility(u.id, id, target).ok) return true;
    if (d.rageSpend && u.resource >= 70 && sim.useAbility(u.id, id, target).ok) return true;
  }
  return false;
}

/** Damage a build deals to a target dummy in `seconds`, pressing `order` (the first that goes off) and payoffs at their thresholds: the score the rotation trainer maximises. */
export function rotationDamage(classId: ClassId, build: Build, order: string[], seconds = 45): number {
  const sim = new ArenaSim({ seed: 5, prepMs: 0 });
  const u = sim.addUnit({ name: 'u', classId, team: 0, controller: 'bot', build });
  const d = sim.addUnit({ name: 'd', classId: 'warrior', team: 1, controller: 'dummy' });
  d.maxHealth = d.health = 1e9;
  const at = classId === 'mage' || classId === 'priest' ? 18 : 2.2;
  u.pos = { x: 0, z: 0 };
  d.pos = { x: at, z: 0 };
  u.facing = Math.PI / 2;
  sim.step();
  sim.setTarget(u.id, d.id);
  sim.setAutoAttack(u.id, true);
  for (let t = 0; t < seconds * 1000; t += sim.tickMs) {
    d.pos = { x: at, z: 0 };
    if (!u.cast && sim.time >= u.gcdEnd - 1 && !spendPayoff(sim, u, d.id)) for (const id of order) if (u.bar.includes(id) && sim.useAbility(u.id, id, d.id).ok) break;
    sim.step();
    sim.drainEvents();
  }
  return 1e9 - d.health;
}
