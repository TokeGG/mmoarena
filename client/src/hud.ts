import { ABILITIES, AURAS, CLASSES, MARKS, TUNING, autoFor } from '@arena/shared';
import { ABILITY_ICON, AURA_ICON, CLASS_ICON, SCHOOL_GRADIENT } from './icons';
import { hpFill, hpText, plateFill, plateHpText, plateShown } from './hudLook';
import { applyName, avatarImg } from './nameStyle';
import type { AbilityDef, ClassId, RosterEntry, SimEvent, Snapshot, TeamId, UnitSnap } from '@arena/shared';

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const SCHOOL_TEXT: Record<string, string> = { physical: '#ffffff', fire: '#ffb04a', frost: '#8fdcff', arcane: '#d79bff', holy: '#fff3a0', shadow: '#c68bff', nature: '#8dff8d' };

const RES_COLOR = { mana: '#3b82f6', rage: '#c0392b', energy: '#e6c229' } as const;
const HP_ALLY = '#3fbf5f';
const HP_ENEMY = '#c0392b';

class Bar {
  readonly root: HTMLElement;
  private fill = el('div', 'fill');
  private label = el('div', 'blabel');
  private shield = el('div', 'shield');
  constructor(color: string, thin = false) {
    this.root = el('div', thin ? 'bar thin' : 'bar');
    this.root.append(this.fill, this.shield, this.label);
    this.fill.style.background = color;
  }
  setColor(c: string) {
    if (this.fill.dataset.c !== c) {
      this.fill.dataset.c = c;
      this.fill.style.background = c;
    }
  }
  /** `absorb` draws a pale segment after the health (pushed back from the right edge when it would overflow). */
  set(v: number, max: number, text: string, absorb = 0) {
    const hp = max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0;
    this.fill.style.width = `${hp}%`;
    const w = max > 0 ? Math.min(100, (absorb / max) * 100) : 0;
    this.shield.style.display = w > 0 ? 'block' : 'none'; // 'block', not '': the stylesheet hides it by default
    this.shield.style.width = `${w}%`;
    this.shield.style.left = `${Math.min(hp, 100 - w)}%`;
    this.label.textContent = text;
  }
}

/**
 * A cast that stopped before it finished stays in its cast bar for a moment, frozen where it stopped, coloured and labelled
 * with why: Interrupted (red), Stunned / Feared / Polymorphed (purple), Cancelled or Moved (grey), Line of sight, Out of
 * range, Target lost... Every cast bar shows it: yours, the unit frames' and the nameplates'.
 */
const CAST_STOP: Record<string, [string, string]> = {
  interrupted: ['Interrupted', 'linear-gradient(#ff5a4a,#a3170c)'],
  'crowd controlled': ['Crowd controlled', 'linear-gradient(#c58cff,#6a2ea8)'],
  pulled: ['Pulled', 'linear-gradient(#c58cff,#6a2ea8)'],
  cancelled: ['Cancelled', 'linear-gradient(#9aa0aa,#4b4f57)'],
  'switched spell': ['Cancelled', 'linear-gradient(#9aa0aa,#4b4f57)'],
  leapt: ['Cancelled', 'linear-gradient(#9aa0aa,#4b4f57)'],
  moved: ['Moved', 'linear-gradient(#9aa0aa,#4b4f57)'],
  'no line of sight': ['Line of sight', 'linear-gradient(#ffb14a,#a35c0c)'],
  'out of range': ['Out of range', 'linear-gradient(#ffb14a,#a35c0c)'],
  'target not visible': ['Target lost', 'linear-gradient(#ffb14a,#a35c0c)'],
  'target vanished': ['Target lost', 'linear-gradient(#ffb14a,#a35c0c)'],
  'blinded by smoke': ['Smoked', 'linear-gradient(#ffb14a,#a35c0c)'],
  'target is dead': ['Target died', 'linear-gradient(#9aa0aa,#4b4f57)'],
};
const STOP_SHOWN_MS = 1000;
/** Names of the units in the last snapshot, so an aura icon's tooltip can say who put it there. */
const unitNames = new Map<number, string>();
/** The cast each unit was last seen casting (and how far along), and casts that just stopped early. */
const lastCast = new Map<number, { ability: string; frac: number }>();
const stoppedCasts = new Map<number, { ability: string; label: string; color: string; frac: number; at: number }>();

/** Remember how far a unit's cast has got (called wherever a cast bar is drawn). */
function seeCast(id: number, c: { ability: string; start: number; end: number }, now: number): number {
  const span = Math.max(1, c.end - c.start);
  const frac = Math.max(0, Math.min(1, ABILITIES[c.ability]?.channel ? (c.end - now) / span : (now - c.start) / span));
  lastCast.set(id, { ability: c.ability, frac });
  stoppedCasts.delete(id);
  return frac;
}

/** A cast_fail arrived: if that unit was really casting that spell, its bar shows why it stopped. */
function castStopped(id: number, ability: string, reason: string): void {
  const lc = lastCast.get(id);
  lastCast.delete(id);
  if (!lc || lc.ability !== ability) return; // a press that never became a cast (held, refused) has no bar to show
  const [label, color] = CAST_STOP[reason] ?? [reason.charAt(0).toUpperCase() + reason.slice(1), 'linear-gradient(#ffb14a,#a35c0c)'];
  stoppedCasts.set(id, { ability, label, color, frac: lc.frac, at: performance.now() });
}

/** What a unit's cast bar should show now that it is not casting: the stopped cast, for a moment, or nothing. */
function stoppedCast(id: number): { ability: string; label: string; color: string; frac: number } | null {
  const s = stoppedCasts.get(id);
  if (!s) return null;
  if (performance.now() - s.at > STOP_SHOWN_MS) {
    stoppedCasts.delete(id);
    return null;
  }
  return s;
}

/** Portrait, name, health, resource, optional cast bar and aura icons. Built once, updated every frame. */
class UnitFrame {
  readonly root: HTMLElement;
  private portrait = el('div', 'portrait');
  private nameEl = el('div', 'name');
  private hp = new Bar(HP_ALLY);
  private res = new Bar('#3b82f6', true);
  private cast: Bar | null;
  private auras = el('div', 'auras');
  /** Rogue combo points: five pips under the resource bar, lit for each point held. */
  private pips = el('div', 'combo hidden');
  private classShown = '';
  constructor(root: HTMLElement, withCast: boolean) {
    this.root = root;
    this.cast = withCast ? new Bar('#f1c40f', true) : null;
    const body = el('div', 'fbody');
    body.append(this.nameEl, this.hp.root, this.res.root, this.pips);
    for (let i = 0; i < 8; i++) this.pips.append(el('span', 'pip'));
    if (this.cast) body.append(this.cast.root);
    body.append(this.auras);
    root.append(this.portrait, body);
  }
  update(u: UnitSnap, now: number, enemy: boolean, targeted = false, who?: RosterEntry) {
    this.root.classList.toggle('dead', !u.alive);
    this.root.classList.toggle('targeted', targeted);
    if (this.classShown !== u.classId) {
      this.classShown = u.classId;
      const c = CLASSES[u.classId].color;
      this.portrait.textContent = CLASS_ICON[u.classId];
      this.portrait.style.background = `radial-gradient(circle at 35% 30%, ${c}, #14161c 85%)`;
    }
    this.portrait.classList.toggle('enemy', enemy);
    this.nameEl.textContent = who ? `${who.emblem} ${u.name}` : u.name;
    applyName(this.nameEl, { color: who?.color || CLASSES[u.classId].color, color2: who?.color2, glow: who?.glow });
    this.hp.setColor(hpFill(enemy, u.maxHealth > 0 ? u.health / u.maxHealth : 0, CLASSES[u.classId].color));
    this.hp.set(u.health, u.maxHealth, hpText(u.health, u.maxHealth, u.absorb ?? 0), u.absorb ?? 0);
    this.res.setColor(RES_COLOR[u.resourceType]);
    this.res.set(u.resource, u.resourceMax, `${u.resource}`);
    this.pips.classList.toggle('hidden', u.classId !== 'rogue');
    [...this.pips.children].forEach((c, i) => {
      c.classList.toggle('on', i < (u.cp ?? 0));
      (c as HTMLElement).style.display = i < (u.cpMax ?? 5) ? '' : 'none';
    });
    if (this.cast) {
      const c = u.cast;
      const st = c ? null : stoppedCast(u.id);
      this.cast.root.classList.toggle('hidden', !c && !st);
      if (c) {
        seeCast(u.id, c, now);
        this.cast.setColor('#f1c40f');
        this.cast.set(ABILITIES[c.ability]?.channel ? c.end - now : now - c.start, c.end - c.start, ABILITIES[c.ability]?.name ?? c.ability);
      } else if (st) {
        this.cast.setColor(st.color);
        this.cast.set(st.frac, 1, `${ABILITIES[st.ability]?.name ?? st.ability}: ${st.label}`);
      }
    }
    // the icons are only rebuilt when the set of effects (or a seconds counter, or a stack count) changes, not every frame
    const shown = u.auras.slice(0, 8);
    const secsLeft = (x: { expiresAt: number }) => (x.expiresAt > 0 ? Math.max(0, Math.ceil((x.expiresAt - now) / 1000)) : -1);
    const key = shown.map((x) => `${x.id}:${x.src}:${secsLeft(x)}:${x.stacks ?? 0}`).join('|');
    if (key === this.auraKey) return;
    this.auraKey = key;
    this.auras.replaceChildren(
      ...shown.map((a) => {
        const def = AURAS[a.id];
        const icon = el('div', `aura ${def?.harmful ? 'bad' : 'good'}`, AURA_ICON[a.id] ?? '✦');
        icon.dataset.tip = `aura:${a.id}`;
        const who = unitNames.get(a.src);
        if (who) icon.dataset.tipFrom = a.src === u.id ? `${who} (on itself)` : who;
        // your talents only change the numbers of an effect you put there; someone else's shows its plain values
        if (who !== 'you') icon.dataset.tipPlain = '1';
        const left = secsLeft(a);
        if (left >= 0) icon.dataset.tipSub = `${left}s remaining`;
        if (left >= 0) icon.append(el('i', '', String(left)));
        if ((a.stacks ?? 0) > 1) icon.append(el('b', '', String(a.stacks)));
        return icon;
      }),
    );
  }
  private auraKey = '';
}

/** Abilities with a condition on the target or yourself (Execute below 20% health, interrupts on a casting target, finishers with no combo points) are blacked out until it holds. */
export function blockedByCondition(def: AbilityDef, me: UnitSnap, tgt: UnitSnap | undefined): boolean {
  if (def.maxTargetHealthPct !== undefined && (!tgt || tgt.team === me.team || tgt.health >= (tgt.maxHealth * def.maxTargetHealthPct) / 100)) return true;
  if (def.requiresTargetCasting && (!tgt || tgt.team === me.team || !tgt.cast)) return true;
  if (def.requiresStealth && !me.stealthed) return true;
  if (def.cpSpend && (me.cp ?? 0) < 1) return true;
  return false;
}

export interface HudHandlers {
  onTarget(id: number): void;
  onSlot(index: number): void;
  /** Shift+drag one slot onto another. */
  onReorder?(from: number, to: number): void;
}

export interface HudContext {
  snap: Snapshot;
  /** Estimated current server time (ms). */
  now: number;
  you: number;
  targetId: number | null;
}

export interface EventContext {
  you: number;
  nameOf(id: number): string;
  /** Screen position above a unit, or null if unknown/off-screen. */
  project(id: number): { x: number; y: number } | null;
}

export class Hud {
  private self = new UnitFrame($('self-frame'), true);
  private target = new UnitFrame($('target-frame'), true);
  private partyFrames = new Map<number, UnitFrame>();
  private enemyFrames = new Map<number, UnitFrame>();
  private slots: { root: HTMLElement; cd: HTMLElement; key: HTMLElement; ability: string }[] = [];
  private castBar = new Bar('#f1c40f');
  private plates = new Map<number, { root: HTMLElement; name: HTMLElement; title: HTMLElement; bar: Bar; cast: Bar; icon: HTMLElement; av: string; debuffs: HTMLElement; dkey: string; mark: HTMLElement; arrow: HTMLElement; mk: number }>();
  /** Emblem, title and colour of signed-in players, keyed by unit id. Sent by the server per match. */
  private roster = new Map<number, RosterEntry>();
  private errTimer = 0;
  private logLines: string[] = [];

  constructor(private handlers: HudHandlers) {
    $('cast').append(this.castBar.root);
    // click your own frame to target yourself
    $('self-frame').classList.add('clickable');
    $('self-frame').addEventListener('mousedown', (e) => {
      e.stopPropagation();
      if (this.youId !== null) this.handlers.onTarget(this.youId);
    });
  }

  private youId: number | null = null;

  /** Fill the HUD with a made-up fight so the layout editor has something to arrange outside a match. */
  demo(classId: ClassId, abilities: string[]) {
    const now = 100000;
    const mk = (id: number, name: string, team: TeamId, c: ClassId, hp: number, extra: Partial<UnitSnap> = {}): UnitSnap => {
      const cls = CLASSES[c];
      return {
        id, name, team, classId: c, spec: null, look: '', x: 0, z: 0, facing: 0, alive: true, health: Math.round(cls.maxHealth * hp), maxHealth: cls.maxHealth,
        resource: Math.round(cls.resource.max * 0.7), resourceMax: cls.resource.max, resourceType: cls.resource.type, target: null, cast: null, gcdEnd: 0,
        cooldowns: {}, auras: [], stealthed: false, y: 0, speedMult: 1, controlled: false, autoAttack: false, lastSeq: 0, ...extra,
      };
    };
    const ids = Object.keys(CLASSES) as ClassId[];
    const foe = ids.find((c) => c !== classId) ?? classId;
    const foe2 = ids.filter((c) => c !== classId && c !== foe)[0] ?? foe;
    const ally = ids.filter((c) => c !== classId && c !== foe && c !== foe2)[0] ?? classId;
    const units = [
      mk(1, 'You', 0, classId, 0.82, { autoAttack: true, cast: { ability: abilities[0] ?? '', target: 3, start: now - 700, end: now + 900 } }),
      mk(2, 'Ally', 0, ally, 0.6),
      mk(3, 'Enemy', 1, foe, 0.45, { cast: { ability: Object.keys(ABILITIES).find((a) => ABILITIES[a].class === foe && ABILITIES[a].castTime > 0) ?? '', target: 1, start: now - 400, end: now + 1100 } }),
      mk(4, 'Enemy 2', 1, foe2, 0.9),
    ];
    const snap: Snapshot = { tick: 0, time: now, phase: 'live', phaseEndsAt: now + 60000, winner: null, units, zones: [] };
    this.setBar(classId, abilities);
    this.update({ snap, now, you: 1, targetId: 3 });
    this.nameplates([], now);
  }

  /** The key bound to auto-attack, for the indicator's hint (it follows rebinding). */
  autoKey = 'R';

  show(visible: boolean) {
    $('hud').classList.toggle('hidden', !visible);
    if (!visible) this.clearLabels();
  }

  setBar(classId: ClassId, abilities: string[]) {
    const bar = $('actionbar');
    bar.replaceChildren();
    this.slots = abilities.map((ability, i) => {
      const root = el('div', 'slot');
      const key = el('span', 'key', String(i + 1));
      const def = ABILITIES[ability];
      root.style.background = SCHOOL_GRADIENT[def.school];
      root.dataset.tip = `ability:${ability}`;
      void classId;
      const ico = el('span', 'ico', ABILITY_ICON[ability] ?? '✦');
      const nm = el('span', 'nm', def.name);
      const cd = el('div', 'cd');
      cd.append(el('span'));
      root.append(ico, nm, cd, key);
      root.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        e.preventDefault();
        // Press and drag (any distance past a few pixels) onto another slot to swap them; a plain click casts.
        // Shift is no longer needed, but Shift+drag still works.
        const sx = e.clientX;
        const sy = e.clientY;
        let ghost: HTMLElement | null = null;
        let hover: Element | null = null;
        const move = (m: MouseEvent) => {
          if (!ghost) {
            if (!this.handlers.onReorder || Math.abs(m.clientX - sx) + Math.abs(m.clientY - sy) < 8) return;
            root.classList.add('dragging');
            ghost = root.cloneNode(true) as HTMLElement;
            ghost.classList.add('slot-ghost');
            document.body.append(ghost);
          }
          ghost.style.left = `${m.clientX - 32}px`;
          ghost.style.top = `${m.clientY - 32}px`;
          const over = document.elementFromPoint(m.clientX, m.clientY)?.closest('.slot:not(.slot-ghost)') ?? null;
          if (over !== hover) {
            hover?.classList.remove('dropto');
            over?.classList.add('dropto');
            hover = over;
          }
        };
        const up = (u: MouseEvent) => {
          window.removeEventListener('mousemove', move, true);
          window.removeEventListener('mouseup', up, true);
          hover?.classList.remove('dropto');
          root.classList.remove('dragging');
          if (!ghost) {
            this.handlers.onSlot(i);
            return;
          }
          ghost.remove();
          const over = document.elementFromPoint(u.clientX, u.clientY)?.closest('.slot');
          const to = over ? this.slots.findIndex((x) => x.root === over) : -1;
          if (to >= 0 && to !== i) this.handlers.onReorder?.(i, to);
        };
        window.addEventListener('mousemove', move, true);
        window.addEventListener('mouseup', up, true);
      });
      bar.append(root);
      return { root, cd, key, ability };
    });
  }

  private aimingId: string | null = null;
  /** Highlights the slot of the ground spell that is waiting for a click. */
  setAiming(id: string | null) {
    this.aimingId = id;
    for (const s of this.slots) s.root.classList.toggle('aiming', !!id && s.ability === id);
  }

  /** Action bar key captions, one per slot, e.g. from the player's keybinds. */
  setKeyLabels(labels: string[]) {
    this.slots.forEach((s, i) => {
      s.key.textContent = labels[i] ?? '';
      s.root.dataset.tipSub = (labels[i] ? `Hotkey: ${labels[i]}  ·  ` : '') + 'Drag to move';
    });
  }

  update(ctx: HudContext) {
    const { snap, now, you, targetId } = ctx;
    this.youId = you;
    for (const u of snap.units) unitNames.set(u.id, u.id === you ? 'you' : u.name);
    const me = snap.units.find((u) => u.id === you);
    if (!me) return;
    this.self.update(me, now, false);
    this.autoIndicator(me, snap, targetId);

    const tgt = targetId !== null ? snap.units.find((u) => u.id === targetId) : undefined;
    $('target-frame').classList.toggle('hidden', !tgt);
    if (tgt) this.target.update(tgt, now, tgt.team !== me.team);

    this.syncFrames($('party'), this.partyFrames, snap.units.filter((u) => u.team === me.team && u.id !== you), now, false, targetId);
    this.syncFrames($('enemies'), this.enemyFrames, snap.units.filter((u) => u.team !== me.team), now, true, targetId);

    // action bar
    const gcdLeft = Math.max(0, me.gcdEnd - now);
    const gcdTotal = TUNING.gcdMs;
    for (const s of this.slots) {
      const def = ABILITIES[s.ability];
      const cd = Math.max(me.cooldowns[s.ability] ? me.cooldowns[s.ability] - now : 0, def.gcd ? gcdLeft : 0);
      const total = me.cooldowns[s.ability] && me.cooldowns[s.ability] - now >= gcdLeft ? def.cooldown || gcdTotal : gcdTotal;
      const frac = Math.min(1, cd / total);
      s.cd.classList.toggle('hidden', cd <= 50);
      s.cd.style.background = `conic-gradient(rgba(0,0,0,.72) ${frac * 360}deg, rgba(0,0,0,.08) 0)`;
      (s.cd.firstChild as HTMLElement).textContent = cd > gcdTotal ? String(Math.ceil(cd / 1000)) : cd > 50 && total > gcdTotal ? (cd / 1000).toFixed(1) : '';
      // a proc (Hot Streak) makes this slot glow while it is active
      s.root.classList.toggle('proc', me.auras.some((a) => AURAS[a.id]?.instantFor === s.ability) || (!!def.exploit && !!tgt && tgt.team !== me.team && !!tgt.auras?.some((a) => a.id === def.exploit!.aura))); // Ice Lance glows while the target has Fingers of Frost
      const locked = me.alive && (me.auras.some((a) => AURAS[a.id]?.noCast) || (me.controlled && !def.ignoresControl) || (!!def.ignoresControl && me.auras.some((a) => AURAS[a.id]?.locksAbilities)) || (!def.ignoresLockout && (me.lockouts?.[def.school] ?? 0) > now));
      const blocked = me.alive && blockedByCondition(def, me, tgt);
      s.root.classList.toggle('locked', locked);
      s.root.classList.toggle('blocked', blocked && !locked);
      if (locked) {
        const ccAura = me.auras.find((a) => ['stun', 'fear', 'incapacitate'].includes(a.kind) || AURAS[a.id]?.locksAbilities);
        const end = me.controlled || def.ignoresControl ? ccAura?.expiresAt ?? 0 : me.lockouts?.[def.school] ?? 0;
        s.root.dataset.lock = end > now ? ((end - now) / 1000).toFixed(1) : '';
      } else delete s.root.dataset.lock;
      s.root.classList.toggle('unusable', me.resource < def.cost || !me.alive);
      s.root.classList.toggle('casting', me.cast?.ability === s.ability);
      s.root.classList.toggle('aiming', this.aimingId === s.ability);
    }
    // what is stopping you, in words: stun, fear, sheep, or a school lockout from an interrupt
    {
      const cc = me.alive ? me.auras.find((a) => ['stun', 'fear', 'incapacitate'].includes(a.kind)) : undefined;
      const lock = me.alive ? Object.entries(me.lockouts ?? {}).filter(([, t]) => (t ?? 0) > now).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0] : undefined;
      let text = '';
      if (cc) {
        const left = cc.expiresAt > 0 ? ` ${Math.max(0, (cc.expiresAt - now) / 1000).toFixed(1)}s` : '';
        text = `${cc.id === 'polymorph' ? 'POLYMORPHED' : cc.kind === 'stun' ? 'STUNNED' : cc.id === 'dragons_breath' ? 'DISORIENTED' : cc.kind === 'fear' ? 'FEARED' : 'INCAPACITATED'}${left}`;
      } else if (lock) text = `${lock[0].toUpperCase()} LOCKED ${Math.max(0, ((lock[1] ?? 0) - now) / 1000).toFixed(1)}s`;
      const box = $('ccstate');
      box.classList.toggle('hidden', !text);
      if (text) box.textContent = text;
      // a pulsing screen-edge glow in the colour of what is holding you
      const vig = $('ccvig');
      const kind = !text ? '' : cc ? (cc.id === 'polymorph' ? 'sheep' : cc.kind) : 'lock';
      vig.className = kind ? `cc-${kind}` : 'hidden';
      box.className = kind ? `cc-${kind}` : 'hidden';
    }
    const myStop = me.cast ? null : stoppedCast(me.id);
    $('cast').classList.toggle('hidden', !me.cast && !myStop);
    if (me.cast) {
      seeCast(me.id, me.cast, now);
      const left = Math.max(0, me.cast.end - now) / 1000;
      this.castBar.setColor('#f1c40f');
      this.castBar.set(ABILITIES[me.cast.ability]?.channel ? me.cast.end - now : now - me.cast.start, me.cast.end - me.cast.start, `${ABILITIES[me.cast.ability]?.name ?? ''}  ${left.toFixed(1)}`);
    } else if (myStop) {
      this.castBar.setColor(myStop.color);
      this.castBar.set(myStop.frac, 1, `${ABILITIES[myStop.ability]?.name ?? ''}: ${myStop.label}`);
    }

    this.updateBanner(snap, now, me.team);
    // Dampening: shown once it starts, with how much weaker healing is
    const dp = $('damp');
    const damp = snap.phase === 'live' ? snap.damp ?? 0 : 0;
    dp.classList.toggle('hidden', damp <= 0);
    if (damp > 0) dp.textContent = `Dampening ${Math.round(damp * 100)}%`;
  }

  setRoster(players: RosterEntry[]) {
    this.roster = new Map(players.map((p) => [p.unitId, p]));
  }

  private syncFrames(container: HTMLElement, frames: Map<number, UnitFrame>, units: UnitSnap[], now: number, enemy: boolean, targetId: number | null) {
    const ids = new Set(units.map((u) => u.id));
    for (const [id, f] of frames) {
      if (!ids.has(id)) {
        f.root.remove();
        frames.delete(id);
      }
    }
    for (const u of units) {
      let f = frames.get(u.id);
      if (!f) {
        const root = el('div', 'frame clickable');
        root.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          this.handlers.onTarget(u.id);
        });
        f = new UnitFrame(root, false);
        frames.set(u.id, f);
        container.append(root);
      }
      f.update(u, now, enemy, u.id === targetId, this.roster.get(u.id));
    }
  }

  private updateBanner(snap: Snapshot, now: number, myTeam: TeamId) {
    const b = $('banner');
    if (snap.paused) {
      b.replaceChildren(document.createTextNode('Paused'), el('small', '', 'dev tools · F2'));
    } else if (snap.phase === 'prep') {
      b.replaceChildren(document.createTextNode(`Gates open in ${Math.max(0, Math.ceil((snap.phaseEndsAt - now) / 1000))}`));
    } else if (snap.phase === 'ended') {
      const text = snap.winner === 'draw' ? 'Draw' : snap.winner === myTeam ? 'Victory' : 'Defeat';
      b.replaceChildren(document.createTextNode(text));
    } else {
      b.replaceChildren();
    }
  }

  setBanner(text: string, sub = '') {
    const b = $('banner');
    b.replaceChildren(document.createTextNode(text));
    if (sub) b.append(el('small', '', sub));
  }

  error(msg: string) {
    const e = $('err');
    e.textContent = msg;
    e.classList.add('show');
    clearTimeout(this.errTimer);
    this.errTimer = window.setTimeout(() => e.classList.remove('show'), 1400);
  }

  /** Take every nameplate and floating number off the screen (leaving a match, a disconnect, the end of watching). */
  clearLabels() {
    this.nameplates([], 0);
    $('labels').replaceChildren();
    $('damp').classList.add('hidden');
  }

  /** Nameplates over each visible unit. `units` come with screen positions already projected. */
  nameplates(
    units: { id: number; x: number; y: number; visible: boolean; name: string; health: number; maxHealth: number; enemy: boolean; alive: boolean; cast: { ability: string; start: number; end: number } | null; auras?: { id: string; expiresAt: number }[]; absorb?: number; target?: boolean; mark?: number; classId?: ClassId }[],
    now: number,
  ) {
    const seen = new Set<number>();
    for (const u of units) {
      seen.add(u.id);
      let p = this.plates.get(u.id);
      if (!p) {
        const root = el('div', 'plate');
        const name = el('div', 'pname');
        const bar = new Bar(HP_ALLY, true);
        const cast = new Bar('linear-gradient(#ffd966,#d9962a)', true);
        cast.root.classList.add('pcast', 'hidden');
        const title = el('div', 'ptitle');
        const icon = el('div', 'picon');
        const debuffs = el('div', 'pdebuffs');
        // over the head: your team's raid mark, and a bobbing arrow on your target
        const top = el('div', 'ptop');
        const mark = el('div', 'pmark hidden');
        const arrow = el('div', 'parrow hidden', '▼');
        top.append(mark, arrow);
        root.append(top, icon, name, title, bar.root, cast.root, debuffs);
        $('labels').append(root);
        p = { root, name, title, bar, cast, icon, av: '', debuffs, dkey: '', mark, arrow, mk: 0 };
        this.plates.set(u.id, p);
      }
      p.root.classList.toggle('hidden', !u.visible || !u.alive || !plateShown(u.enemy));
      p.root.style.left = `${u.x}px`;
      p.root.style.top = `${u.y}px`;
      const who = this.roster.get(u.id);
      p.name.textContent = who ? `${who.emblem} ${u.name}` : u.name;
      applyName(p.name, { color: who?.color || (u.enemy ? '#ff8a7a' : '#a8f0b8'), color2: who?.color2, glow: who?.glow }, '0 1px 2px #000');
      const av = who?.avatarUrl ?? '';
      if (p.av !== av) {
        p.av = av;
        p.icon.replaceChildren();
        const img = avatarImg(av, 'pav');
        if (img) p.icon.append(img);
      }
      const mk = u.mark ?? 0;
      if (p.mk !== mk) {
        p.mk = mk;
        const def = MARKS[mk - 1];
        p.mark.textContent = def?.icon ?? '';
        p.mark.title = def?.name ?? '';
        p.mark.dataset.mark = def?.id ?? '';
        p.mark.classList.toggle('hidden', !def);
      }
      p.arrow.classList.toggle('hidden', !u.target);
      p.arrow.classList.toggle('enemy', u.enemy);
      p.root.classList.toggle('targeted', !!u.target);
      p.title.textContent = who?.title ? `«${who.title}»` : '';
      p.title.classList.toggle('hidden', !who?.title);
      p.bar.setColor(plateFill(u.enemy, u.maxHealth > 0 ? u.health / u.maxHealth : 0, u.classId ? CLASSES[u.classId].color : u.enemy ? HP_ENEMY : HP_ALLY));
      p.bar.set(u.health, u.maxHealth, plateHpText(u.health, u.maxHealth), u.absorb ?? 0);
      // harmful effects on the unit (stuns, roots, slows, DoTs), each with its time left; rebuilt only when the set or a second changes
      const bad = (u.auras ?? []).filter((a) => AURAS[a.id]?.harmful).slice(0, 6);
      const dkey = bad.map((a) => `${a.id}:${a.expiresAt > 0 ? Math.ceil((a.expiresAt - now) / 1000) : ''}`).join();
      if (p.dkey !== dkey) {
        p.dkey = dkey;
        p.debuffs.replaceChildren(...bad.map((a) => {
          const ic = el('div', 'pdebuff', AURA_ICON[a.id] ?? '✦');
          if (a.expiresAt > 0) ic.append(el('i', '', String(Math.max(0, Math.ceil((a.expiresAt - now) / 1000)))));
          return ic;
        }));
      }
      // cast bar over the head: gold for allies, hot orange for enemies so you can see what to interrupt
      const pStop = u.cast ? null : stoppedCast(u.id);
      p.cast.root.classList.toggle('hidden', !u.cast && !pStop);
      if (pStop) {
        p.cast.setColor(pStop.color);
        p.cast.set(pStop.frac, 1, pStop.label);
      }
      if (u.cast) {
        seeCast(u.id, u.cast, now);
        p.cast.root.classList.toggle('enemy', u.enemy);
        p.cast.setColor(u.enemy ? 'linear-gradient(#ff9a52,#d94a1c)' : 'linear-gradient(#ffd966,#d9962a)');
        p.cast.set(ABILITIES[u.cast.ability]?.channel ? u.cast.end - now : now - u.cast.start, u.cast.end - u.cast.start, ABILITIES[u.cast.ability]?.name ?? u.cast.ability);
      }
    }
    for (const [id, p] of this.plates) {
      if (!seen.has(id)) {
        p.root.remove();
        this.plates.delete(id);
      }
    }
  }

  private float(pos: { x: number; y: number } | null, text: string, cls: string, size = 20, color = '') {
    if (!pos) return;
    const f = el('div', `ft ${cls}`, text);
    f.style.left = `${pos.x + (Math.random() * 44 - 22)}px`;
    f.style.top = `${pos.y - Math.random() * 14}px`;
    f.style.fontSize = `${size}px`;
    if (color) f.style.color = color;
    f.style.setProperty('--dx', `${(Math.random() < 0.5 ? -1 : 1) * (14 + Math.random() * 26)}px`);
    $('ftext').append(f);
    window.setTimeout(() => f.remove(), 1400);
  }

  private autoShown = false;
  /** The auto-attack setting: the indicator is hidden while it is off. */
  autoEnabled = true;

  /** Auto-attack status: lit and pulsing while swinging, amber when something stops the swings. */
  private autoIndicator(me: UnitSnap, snap: Snapshot, targetId: number | null) {
    const auto = autoFor(me.classId, me.spec);
    const root = $('autoind');
    const show = !!auto && this.autoEnabled && me.alive && snap.phase === 'live';
    root.classList.toggle('hidden', !show);
    if (!show || !auto) return;
    const t = targetId !== null ? snap.units.find((u) => u.id === targetId) : undefined;
    let state: 'on' | 'range' | 'target' | 'stealth' | 'off' = 'off';
    if (me.stealthed) state = 'stealth';
    else if (me.autoAttack) {
      if (!t || !t.alive || t.team === me.team) state = 'target';
      else if (Math.hypot(t.x - me.x, t.z - me.z) > auto.range + 0.5) state = 'range';
      else state = 'on';
    }
    root.dataset.state = state;
    const label = { on: 'Auto-attacking', range: 'Auto-attack: move closer', target: 'Auto-attack: no target', stealth: 'Auto-attack is off while stealthed', off: `Auto-attack off (right-click an enemy${this.autoKey && this.autoKey !== '—' ? ` or press ${this.autoKey}` : ''})` }[state];
    if (root.title !== label) root.title = label;
  }

  /** Pulse the indicator whenever one of our swings lands. */
  private autoPulse() {
    const root = $('autoind');
    root.classList.remove('pulse');
    void root.offsetWidth;
    root.classList.add('pulse');
  }

  private log(line: string) {
    this.logLines.push(line);
    if (this.logLines.length > 7) this.logLines.shift();
    $('log').replaceChildren(...this.logLines.map((l) => el('div', '', l)));
  }

  event(ev: SimEvent, ctx: EventContext) {
    const n = ctx.nameOf;
    const ab = (id: string | null) => (id ? ABILITIES[id]?.name ?? id : 'Auto Attack');
    switch (ev.t) {
      case 'damage': {
        const mine = ev.src === ctx.you;
        const toMe = ev.tgt === ctx.you;
        if (ev.amount > 0) {
          const size = Math.round(Math.min(40, 17 + Math.sqrt(ev.amount) * 0.9));
          if (toMe) this.float(ctx.project(ev.tgt), `-${ev.amount}`, 'in', size);
          else if (mine) {
            this.float(ctx.project(ev.tgt), `${ev.amount}`, 'out', size + 2, SCHOOL_TEXT[ev.school]);
            if (ev.ability === null) this.autoPulse();
          } else this.float(ctx.project(ev.tgt), `${ev.amount}`, 'other', Math.max(13, size - 6));
        }
        if (ev.absorbed > 0 && (toMe || mine)) this.float(ctx.project(ev.tgt), `${ev.absorbed} absorbed`, 'dim', 14);
        if (toMe || mine) this.log(`${n(ev.src)}'s ${ab(ev.ability)} hits ${n(ev.tgt)} for ${ev.amount}`);
        break;
      }
      case 'heal':
        if (ev.amount > 0) this.float(ctx.project(ev.tgt), `+${ev.amount}`, 'heal', Math.round(Math.min(34, 16 + Math.sqrt(ev.amount) * 0.8)));
        if (ev.overheal > 0 && (ev.src === ctx.you || ev.tgt === ctx.you)) this.float(ctx.project(ev.tgt), `${ev.overheal} overheal`, 'dim', 13);
        if (ev.tgt === ctx.you || ev.src === ctx.you) this.log(`${n(ev.src)}'s ${ab(ev.ability)} heals ${n(ev.tgt)} for ${ev.amount}`);
        break;
      case 'miss':
        this.float(ctx.project(ev.tgt), 'Missed', 'info');
        this.log(`${n(ev.src)}'s ${ab(ev.ability)} found nothing to interrupt`);
        break;
      case 'interrupt':
        this.float(ctx.project(ev.tgt), 'Interrupted', 'info');
        this.log(`${n(ev.src)} interrupts ${n(ev.tgt)}'s ${ab(ev.ability)}`);
        break;
      case 'aura': {
        const def = AURAS[ev.aura];
        if (def && ['stun', 'incapacitate', 'fear', 'root'].includes(def.kind)) {
          const dr = ev.dr < 1 ? (ev.dr === 0.5 ? ' (½)' : ' (¼)') : '';
          this.float(ctx.project(ev.tgt), `${def.name}${dr}`, 'cc');
          this.log(`${n(ev.tgt)} is affected by ${def.name}${dr}`);
        }
        break;
      }
      case 'immune': {
        this.float(ctx.project(ev.tgt), 'Immune', 'dim');
        // an aura refused by diminishing returns, or anything thrown at an unstoppable channel (Bladestorm)
        const what = AURAS[ev.aura]?.name ?? ABILITIES[ev.aura]?.name ?? ev.aura;
        this.log(`${n(ev.tgt)} is immune to ${what}`);
        break;
      }
      case 'dispel':
        this.float(ctx.project(ev.tgt), 'Dispelled', 'info');
        break;
      case 'dodge':
        this.float(ctx.project(ev.unit), 'Dodged!', 'info', 22);
        break;
      case 'death':
        this.log(`${n(ev.unit)} dies`);
        break;
      case 'respawn':
        this.log(`${n(ev.unit)} stands back up`);
        break;
      case 'cast_fail':
        castStopped(ev.unit, ev.ability, ev.reason);
        if (ev.unit === ctx.you && ev.reason !== 'moved' && ev.reason !== 'cancelled') this.error(ev.reason);
        break;
      default:
        break;
    }
  }
}
