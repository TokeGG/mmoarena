import { ABILITIES, AURAS } from '@arena/shared';
import type { AbilityDef, School } from '@arena/shared';

/**
 * How each ability and aura is drawn, as plain data (no three.js here, so it can be tested).
 *
 *   projectile  something genuinely thrown or flying: it leaves the caster and the hit lands when it arrives
 *   onTarget    an instant that lands at once: the impact is drawn at the target, nothing travels
 *   burst       centred on the caster (novas, shouts, cones)
 *   aura        applies a lasting effect: an impact at the target plus a persistent aura visual (see AURA_VISUAL)
 *   melee       weapon strike: slash on the target
 *   movement    the caster moves (charge, blink, leap)
 *   support     heals, shields and self buffs
 *   zone        ground area (the zone snapshot draws it)
 *   channel     held spell: tether or volley while it lasts
 */
export type VisualClass = 'projectile' | 'onTarget' | 'burst' | 'aura' | 'melee' | 'movement' | 'support' | 'zone' | 'channel';

/** The look of an impact or ground eruption. */
export type ImpactKind = 'fire' | 'frost' | 'arcane' | 'shadow' | 'holy' | 'nature' | 'dust';

export interface AbilityVisual {
  cls: VisualClass;
  /** onTarget / aura: what comes out of the ground or hits the target. */
  hit?: { kind: ImpactKind; style: 'eruption' | 'impact' | 'pillar' | 'swirl' };
}

const eruption = (kind: ImpactKind): AbilityVisual => ({ cls: 'onTarget', hit: { kind, style: 'eruption' } });
const impact = (kind: ImpactKind): AbilityVisual => ({ cls: 'onTarget', hit: { kind, style: 'impact' } });
const swirl = (kind: ImpactKind): AbilityVisual => ({ cls: 'onTarget', hit: { kind, style: 'swirl' } });
const auraHit = (kind: ImpactKind, style: 'eruption' | 'impact' | 'pillar' | 'swirl' = 'impact'): AbilityVisual => ({ cls: 'aura', hit: { kind, style } });
const c = (cls: VisualClass): AbilityVisual => ({ cls });

/** Every non-retired ability, exactly once. Retired ones fall back to `visualFor`'s guess from what the ability does. */
export const ABILITY_VISUAL: Record<string, AbilityVisual> = {
  // warrior
  mortal_strike: c('melee'), charge: c('movement'), pummel: c('melee'), hamstring: c('melee'), execute: c('melee'),
  intimidating_shout: c('burst'), bloodthirst: c('melee'), whirlwind: c('burst'), enraged_regeneration: c('support'),
  slice_and_dice: c('channel'), bladestorm: c('burst'), slam: c('melee'), reel_in: c('burst'), deep_cuts: c('melee'),
  axe_throw: c('projectile'), heroic_leap: c('movement'), not_going_anywhere: c('zone'), battle_banner: c('zone'),
  dragon_roar: c('burst'),
  // mage
  frostbolt: c('projectile'), fireball: c('projectile'), pyroblast: c('projectile'), arcane_blast: c('projectile'),
  arcane_missiles: c('channel'),
  scorch: eruption('fire'), ice_lance: impact('frost'), arcane_barrage: impact('arcane'),
  polymorph: swirl('arcane'), counterspell: impact('arcane'), deep_freeze: eruption('frost'),
  frost_nova: c('burst'), arcane_explosion: c('burst'), dragons_breath: c('burst'), blink: c('movement'),
  ice_barrier: c('support'), arcane_power: c('support'), evocation: c('support'), mirror_image: c('support'),
  flamestrike: c('zone'), rune_of_power: c('zone'),
  // priest
  smite: c('projectile'), mind_blast: impact('shadow'), mind_flay: c('channel'), penance: c('channel'),
  shadow_word_death: auraHit('shadow', 'impact'), plague_bloom: auraHit('shadow', 'eruption'),
  dispel_magic: swirl('holy'), leap_of_faith: swirl('holy'),
  flash_heal: c('support'), greater_heal: c('support'), power_word_shield: c('support'), pain_suppression: c('support'),
  desperate_prayer: c('support'), dispersion: c('support'), ascend: c('support'),
  psychic_scream: c('burst'), holy_nova: c('burst'), purifying_light: c('burst'),
  // rogue
  stealth: c('support'), vanish: c('support'), sprint: c('support'), adrenaline_rush: c('support'), evasion: c('support'),
  cheap_shot: c('melee'), kidney_shot: c('melee'), sinister_strike: c('melee'), backstab: c('melee'), kick: c('melee'),
  mutilate: c('melee'), eviscerate: c('melee'), garrote: c('melee'), exsanguinate: c('melee'), gouge: c('melee'), sap: c('melee'),
  shadowstep: c('movement'), blind: swirl('dust'),
  // trinkets
  trinket_cleanse: c('support'), trinket_shield: c('support'), trinket_heal: c('support'),
};

const SCHOOL_KIND: Record<School, ImpactKind> = {
  physical: 'dust', fire: 'fire', frost: 'frost', arcane: 'arcane', holy: 'holy', shadow: 'shadow', nature: 'nature',
};
export const impactKindFor = (school: School): ImpactKind => SCHOOL_KIND[school] ?? 'arcane';

/** The visual for an ability: the table, or (retired and unlisted abilities) a guess from what it does. */
export function visualFor(def: AbilityDef): AbilityVisual {
  const listed = ABILITY_VISUAL[def.id];
  if (listed) return listed;
  const has = (t: string) => def.effects.some((e) => e.type === t);
  const enemy = def.target === 'enemy' || def.target === 'any';
  if (def.target === 'ground') return c('zone');
  if (has('charge') || has('dashToTarget') || has('leap')) return c('movement');
  if (def.channel) return c('channel');
  if (def.target === 'aoe_enemy' || def.target === 'aoe_all') return c('burst');
  if (enemy && def.range <= 6) return c('melee');
  if (enemy && def.castTime > 0 && has('damage')) return c('projectile');
  if (enemy) return impact(impactKindFor(def.school));
  return c('support');
}

// ---------------------------------------------------------------- auras

/** Looks for lasting effects on a unit. */
export type AuraStyle = 'shadow' | 'bleed' | 'burn' | 'frost' | 'holy' | 'poison';

export interface AuraVisual {
  style: AuraStyle;
  /** 0..1 multiplier on how much is drawn (marks and absorbs are lighter than real damage over time). */
  strength: number;
  /** Also draw a faint bubble around the unit (shields). */
  bubble?: number;
}

/**
 * Harmful and helpful auras that get a persistent visual around the unit. Every aura with a `dot` must be here
 * (tested); stuns, fears and the like keep their hand-made attachments in effects.ts.
 */
export const AURA_VISUAL: Record<string, AuraVisual> = {
  creeping_rot: { style: 'shadow', strength: 0.8 },
  plague_bloom: { style: 'shadow', strength: 1 },
  garrote_bleed: { style: 'bleed', strength: 1 },
  mutilate_bleed: { style: 'bleed', strength: 0.7 },
  deep_cuts_bleed: { style: 'bleed', strength: 0.8 },
  mortal_wounds: { style: 'bleed', strength: 0.45 },
  burn: { style: 'burn', strength: 1 },
  frost_nova_root: { style: 'frost', strength: 1 },
  frostbolt_slow: { style: 'frost', strength: 0.6 },
  frostbolt_root: { style: 'frost', strength: 0.8 },
  deep_freeze_stun: { style: 'frost', strength: 1.3 },
  renew: { style: 'holy', strength: 0.8 },
  pw_shield: { style: 'holy', strength: 1 },
  penance_barrier: { style: 'holy', strength: 1, bubble: 0.08 },
  trinket_shield: { style: 'holy', strength: 0.9, bubble: 0.07 },
};

/** Aura ids whose damage ticks carry this ability id. */
export function dotAurasFor(ability: string | null): string[] {
  if (!ability) return [];
  return Object.keys(AURAS).filter((id) => AURAS[id].dot?.ability === ability);
}

/** Aura ids that heal over time and report the heal under their own id. */
export const hotAuras = (): string[] => Object.keys(AURAS).filter((id) => !!AURAS[id].hot);

/**
 * Is this damage event a tick of a damage-over-time aura (as opposed to the direct hit of the cast)?
 * The direct hit arrives together with its cast event; a tick comes later while the target carries the aura.
 */
export function isDotTick(ability: string | null, targetAuras: readonly string[], secondsSinceCast: number): string | null {
  if (secondsSinceCast < 0.05) return null;
  for (const id of dotAurasFor(ability)) if (targetAuras.includes(id)) return id;
  return null;
}

/** The pieces of an aura visual that a unit currently wears, in the order they are drawn: one entry per aura with a visual. */
export function auraVisualsOf(auras: readonly string[]): { id: string; vis: AuraVisual }[] {
  const out: { id: string; vis: AuraVisual }[] = [];
  for (const id of auras) {
    const vis = AURA_VISUAL[id];
    if (vis) out.push({ id, vis });
  }
  return out;
}

/** Fade envelope of a persistent layer: ramps in after it appears and out once its aura is gone. Returns 0..1. */
export function layerAlpha(age: number, leftFor: number | null, fadeIn = 0.35, fadeOut = 0.45): number {
  const a = Math.min(1, Math.max(0, age / fadeIn));
  if (leftFor === null) return a;
  return a * Math.max(0, 1 - leftFor / fadeOut);
}

/** Tracks which persistent layers exist, which are fading out, and which are finished and must be disposed. */
export class LayerBook {
  private live = new Map<string, { gone: number | null }>();

  /** Mark the layers wanted this frame; everything else starts (or keeps) fading. Returns keys to dispose now. */
  step(wanted: ReadonlySet<string>, dt: number, fadeOut = 0.45): string[] {
    const done: string[] = [];
    for (const k of wanted) {
      const e = this.live.get(k);
      if (!e) this.live.set(k, { gone: null });
      else e.gone = null;
    }
    for (const [k, e] of this.live) {
      if (wanted.has(k)) continue;
      e.gone = (e.gone ?? 0) + dt;
      if (e.gone >= fadeOut) {
        this.live.delete(k);
        done.push(k);
      }
    }
    return done;
  }

  /** Seconds a layer has been gone, or null while it is wanted (or unknown). */
  goneFor(key: string): number | null {
    return this.live.get(key)?.gone ?? null;
  }

  get size() {
    return this.live.size;
  }
}
