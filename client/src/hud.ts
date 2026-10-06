import { ABILITIES, AURAS, CLASSES } from '@arena/shared';
import type { ClassId, SimEvent, Snapshot, TeamId, UnitSnap } from '@arena/shared';

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const RES_COLOR = { mana: '#3b82f6', rage: '#c0392b', energy: '#e6c229' } as const;
const HP_ALLY = '#3fbf5f';
const HP_ENEMY = '#c0392b';

class Bar {
  readonly root: HTMLElement;
  private fill = el('div', 'fill');
  private label = el('div', 'blabel');
  constructor(color: string, thin = false) {
    this.root = el('div', thin ? 'bar thin' : 'bar');
    this.root.append(this.fill, this.label);
    this.fill.style.background = color;
  }
  setColor(c: string) {
    this.fill.style.background = c;
  }
  set(v: number, max: number, text: string) {
    this.fill.style.width = `${max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0}%`;
    this.label.textContent = text;
  }
}

/** Name, health, resource, optional cast bar and aura chips. Built once, updated every frame. */
class UnitFrame {
  readonly root: HTMLElement;
  private nameEl = el('div', 'name');
  private hp = new Bar(HP_ALLY);
  private res = new Bar('#3b82f6', true);
  private cast: Bar | null;
  private auras = el('div', 'auras');
  constructor(root: HTMLElement, withCast: boolean) {
    this.root = root;
    this.cast = withCast ? new Bar('#f1c40f', true) : null;
    root.append(this.nameEl, this.hp.root, this.res.root);
    if (this.cast) root.append(this.cast.root);
    root.append(this.auras);
  }
  update(u: UnitSnap, now: number, enemy: boolean, targeted = false) {
    this.root.classList.toggle('dead', !u.alive);
    this.root.classList.toggle('targeted', targeted);
    this.nameEl.textContent = `${u.name} · ${CLASSES[u.classId].name}`;
    this.nameEl.style.color = CLASSES[u.classId].color;
    this.hp.setColor(enemy ? HP_ENEMY : HP_ALLY);
    this.hp.set(u.health, u.maxHealth, `${u.health} / ${u.maxHealth}`);
    this.res.setColor(RES_COLOR[u.resourceType]);
    this.res.set(u.resource, u.resourceMax, `${u.resource}`);
    if (this.cast) {
      const c = u.cast;
      this.cast.root.classList.toggle('hidden', !c);
      if (c) this.cast.set(now - c.start, c.end - c.start, ABILITIES[c.ability]?.name ?? c.ability);
    }
    this.auras.replaceChildren(
      ...u.auras.slice(0, 8).map((a) => {
        const def = AURAS[a.id];
        const left = a.expiresAt > 0 ? ` ${Math.max(0, (a.expiresAt - now) / 1000).toFixed(0)}s` : '';
        return el('span', `chip ${def?.harmful ? 'bad' : 'good'}`, `${def?.name ?? a.id}${left}`);
      }),
    );
  }
}

export interface HudHandlers {
  onTarget(id: number): void;
  onSlot(index: number): void;
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
  private plates = new Map<number, { root: HTMLElement; name: HTMLElement; bar: Bar }>();
  private errTimer = 0;
  private logLines: string[] = [];

  constructor(private handlers: HudHandlers) {
    $('cast').append(this.castBar.root);
  }

  show(visible: boolean) {
    $('hud').classList.toggle('hidden', !visible);
  }

  setClass(classId: ClassId) {
    const bar = $('actionbar');
    bar.replaceChildren();
    this.slots = CLASSES[classId].bar.map((ability, i) => {
      const root = el('div', 'slot');
      const key = el('span', 'key', String(i + 1));
      root.append(key, document.createTextNode(ABILITIES[ability].name));
      const cd = el('div', 'cd hidden');
      root.append(cd);
      root.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        this.handlers.onSlot(i);
      });
      bar.append(root);
      return { root, cd, key, ability };
    });
  }

  /** Action bar key captions, one per slot, e.g. from the player's keybinds. */
  setKeyLabels(labels: string[]) {
    this.slots.forEach((s, i) => (s.key.textContent = labels[i] ?? ''));
  }

  update(ctx: HudContext) {
    const { snap, now, you, targetId } = ctx;
    const me = snap.units.find((u) => u.id === you);
    if (!me) return;
    this.self.update(me, now, false);

    const tgt = targetId !== null ? snap.units.find((u) => u.id === targetId) : undefined;
    $('target-frame').classList.toggle('hidden', !tgt);
    if (tgt) this.target.update(tgt, now, tgt.team !== me.team);

    this.syncFrames($('party'), this.partyFrames, snap.units.filter((u) => u.team === me.team && u.id !== you), now, false, targetId);
    this.syncFrames($('enemies'), this.enemyFrames, snap.units.filter((u) => u.team !== me.team), now, true, targetId);

    // action bar
    const gcdLeft = Math.max(0, me.gcdEnd - now);
    for (const s of this.slots) {
      const def = ABILITIES[s.ability];
      const cd = Math.max(me.cooldowns[s.ability] ? me.cooldowns[s.ability] - now : 0, def.gcd ? gcdLeft : 0);
      s.cd.classList.toggle('hidden', cd <= 50);
      s.cd.textContent = cd > 1500 ? String(Math.ceil(cd / 1000)) : cd > 50 ? (cd / 1000).toFixed(1) : '';
      s.root.classList.toggle('unusable', me.resource < def.cost || !me.alive);
      s.root.classList.toggle('casting', me.cast?.ability === s.ability);
    }
    $('cast').classList.toggle('hidden', !me.cast);
    if (me.cast) this.castBar.set(now - me.cast.start, me.cast.end - me.cast.start, ABILITIES[me.cast.ability]?.name ?? '');

    this.updateBanner(snap, now, me.team);
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
      f.update(u, now, enemy, u.id === targetId);
    }
  }

  private updateBanner(snap: Snapshot, now: number, myTeam: TeamId) {
    const b = $('banner');
    if (snap.phase === 'prep') {
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

  /** Nameplates over each visible unit. `units` come with screen positions already projected. */
  nameplates(units: { id: number; x: number; y: number; visible: boolean; name: string; health: number; maxHealth: number; enemy: boolean; alive: boolean }[]) {
    const seen = new Set<number>();
    for (const u of units) {
      seen.add(u.id);
      let p = this.plates.get(u.id);
      if (!p) {
        const root = el('div', 'plate');
        const name = el('div');
        const bar = new Bar(HP_ALLY, true);
        root.append(name, bar.root);
        $('labels').append(root);
        p = { root, name, bar };
        this.plates.set(u.id, p);
      }
      p.root.classList.toggle('hidden', !u.visible || !u.alive);
      p.root.style.left = `${u.x}px`;
      p.root.style.top = `${u.y}px`;
      p.name.textContent = u.name;
      p.name.style.color = u.enemy ? '#ff8a7a' : '#a8f0b8';
      p.bar.setColor(u.enemy ? HP_ENEMY : HP_ALLY);
      p.bar.set(u.health, u.maxHealth, '');
    }
    for (const [id, p] of this.plates) {
      if (!seen.has(id)) {
        p.root.remove();
        this.plates.delete(id);
      }
    }
  }

  private float(pos: { x: number; y: number } | null, text: string, cls: string) {
    if (!pos) return;
    const f = el('div', `ft ${cls}`, text);
    f.style.left = `${pos.x + (Math.random() * 30 - 15)}px`;
    f.style.top = `${pos.y}px`;
    $('ftext').append(f);
    window.setTimeout(() => f.remove(), 1300);
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
      case 'damage':
        if (ev.tgt === ctx.you) this.float(ctx.project(ev.tgt), `-${ev.amount}`, 'in');
        else if (ev.src === ctx.you) this.float(ctx.project(ev.tgt), `-${ev.amount}`, 'out');
        if (ev.absorbed > 0 && (ev.tgt === ctx.you || ev.src === ctx.you)) this.float(ctx.project(ev.tgt), `${ev.absorbed} absorbed`, 'dim');
        if (ev.tgt === ctx.you || ev.src === ctx.you) this.log(`${n(ev.src)}'s ${ab(ev.ability)} hits ${n(ev.tgt)} for ${ev.amount}`);
        break;
      case 'heal':
        if (ev.amount > 0) this.float(ctx.project(ev.tgt), `+${ev.amount}`, 'heal');
        if (ev.tgt === ctx.you || ev.src === ctx.you) this.log(`${n(ev.src)}'s ${ab(ev.ability)} heals ${n(ev.tgt)} for ${ev.amount}`);
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
      case 'immune':
        this.float(ctx.project(ev.tgt), 'Immune', 'dim');
        this.log(`${n(ev.tgt)} is immune to ${AURAS[ev.aura]?.name ?? ev.aura} (diminishing returns)`);
        break;
      case 'dispel':
        this.float(ctx.project(ev.tgt), 'Dispelled', 'info');
        break;
      case 'death':
        this.log(`${n(ev.unit)} dies`);
        break;
      case 'cast_fail':
        if (ev.unit === ctx.you && ev.reason !== 'moved') this.error(ev.reason);
        break;
      default:
        break;
    }
  }
}
