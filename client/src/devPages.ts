import { ABILITIES, AURAS, classOfOption, classOptionKeys, CLASSES, CLASS_IDS, DEV_PAGES, SPECS, TALENTS, auraSlots, canEditAsData, effectSkeleton, EFFECT_TYPES, entityProblems, entityText, entryFor, navFor, navText, skillInfo, skillSlots } from '@arena/shared';
import type { ClassId, DataPatch, DevEntry, DevPageId, ModTarget, NavEntry, NavGroup } from '@arena/shared';
import { iconEl, setIconPreview } from './iconArt';
import { libraryPage, loadCustomSounds, soundTools } from './soundsUi';
import { IconEditor } from './iconEditor';
import { previewOf } from './iconEditLogic';
import { SkillEditor, el } from './skillView';
import { dataForm } from './dataForm';
import { patchKey } from './devEdits';
import type { ChatScope } from './designer';

/** What the pages need from the place they sit in (the debug panel in a match, or the admin panel's Tuning tab). */
export interface WorkspaceHost {
  /** What is in effect already, by patch key (the match's test numbers, the session's, or the proposals). */
  testing(): Map<string, DataPatch>;
  inEffect(): DataPatch[];
  /** False in the Tuning tab: proposals are handled in their own list, not put back from here. */
  canRevert: boolean;
  /** Save what was typed (the icon picker's Save button): where it goes depends on the panel. */
  save?(): string | void;
  saveTitle?: string;
  /** Something was typed, reset or undone: update the toolbar's counter and the changes list. */
  onEdit(): void;
  /** The whole panel must be drawn again (the pages changed what it shows). */
  repaint(): void;
  /** The class the pages open on. */
  startClass(): ClassId;
  /** Skills to list first on the Skills page (everyone's bars in the match). */
  matchSkills?(): string[];
  /** The selection changed (the chat follows it). */
  onSelect?(): void;
}

let soundsLoadedOnce = false;

/** The files each page edits (for its reset and its change counter). */
export const PAGE_FILES: Record<DevPageId, DataPatch['file'][]> = {
  classes: ['classes'], specs: ['specs'], talents: ['talents'], skills: ['abilities'], passives: ['specs', 'talents', 'tuning'], auras: ['auras'], animations: ['fx'], sounds: ['sounds'], icons: ['icons'], options: ['tuning'],
};

const CAULDRON = new Set(['cauterizeHealth', 'cauterizeCooldownMs']);
/** Whether a change belongs to a page: the Passives page owns every stat bonus and skill change of specs and talents, and Cauterize. */
export function pageOwns(page: DevPageId, p: DataPatch): boolean {
  const passive = ((p.file === 'specs' || p.file === 'talents') && p.path[0] === 'mods') || (p.file === 'tuning' && CAULDRON.has(String(p.path[0])));
  if (p.file === 'tuning' && classOptionKeys().has(String(p.path[0]))) return page === 'classes';
  if (page === 'passives') return passive;
  if (passive) return false;
  return PAGE_FILES[page].includes(p.file);
}
/** The id of a change's entry in a page's navigation. */
export function navIdOf(page: DevPageId, p: DataPatch): string {
  if (page === 'icons') return `${({ aura: 'u', class: 'c', spec: 'p' } as Record<string, string>)[String(p.path[0])] ?? 'a'}:${p.id}`; // an icon's entry is its skill or buff
  if (page === 'animations' || page === 'sounds') return String(p.path[0]); // an animation's entry is its effect (dragonsBreath, charge, ...)
  if (page === 'classes' && p.file === 'tuning') return classOfOption(String(p.path[0])) ?? p.id;
  if (page !== 'passives') return p.id;
  if (p.file === 'tuning') return `s:${CLASS_IDS.flatMap((c) => SPECS[c]).find((x) => x.passive === 'cauterize')?.id ?? ''}`;
  return `${p.file === 'specs' ? 's' : 't'}:${p.id}`;
}

const classOfSpec = (id: string): ClassId | null => (CLASS_IDS.find((c) => SPECS[c].some((s) => s.id === id)) ?? null);
const classOfTalent = (id: string): ClassId | null => (CLASS_IDS.find((c) => Object.values(TALENTS[c] ?? {}).some((tiers) => tiers.some((t) => t.some((x) => x.id === id)))) ?? null);

/**
 * The pages of the debug panel and the Tuning tab: Classes, Specs, Talents, Skills, Auras and Game options. Each has a search
 * box, a navigation tree on the left, the fold-out groups of values of the chosen entry on the right, and a reset for the
 * page. The edits live in `editor`; the host sends them (see the toolbar of each host).
 */
export class DevWorkspace {
  readonly editor = new SkillEditor();
  page: DevPageId = 'skills';
  private sel: Partial<Record<DevPageId, string>> = {};
  private search: Record<DevPageId, string> = { classes: '', specs: '', talents: '', skills: '', passives: '', auras: '', animations: '', sounds: '', icons: '', options: '' };
  private navOpen = new Map<string, boolean>();
  private adding = new Map<string, { kind: 'ability' | 'aura'; id: string }>();
  private classCtx: ClassId | null = null;
  private iconEd: IconEditor;
  /** Where each list and each entry was scrolled to, so a redraw (the panel refreshes now and then) puts you back where you were. */
  private scrollPos = new Map<string, number>();
  /** Unsaved edits in an entry's data form, by file and id: they survive a redraw until applied or put back. */
  private drafts = new Map<string, Record<string, unknown>>();
  private navBox: HTMLElement | null = null;
  private detailBox: HTMLElement | null = null;

  constructor(private host: WorkspaceHost) {
    this.iconEd = new IconEditor({ set: this.editor.set, testing: () => host.testing(), canRevert: host.canRevert, onEdit: () => this.editor.onEdit(), save: host.save ? () => host.save?.() : undefined, saveTitle: host.saveTitle });
    this.editor.testing = () => host.testing();
    this.editor.canRevert = host.canRevert;
    this.editor.onEdit = () => {
      this.refreshMarks();
      host.onEdit();
    };
  }

  private tabBtns = new Map<DevPageId, HTMLElement>();
  private changedIds = new Set<string>();

  /** A value changed: the counters on the tabs and the dots in the list follow without drawing the page again. */
  refreshMarks(): void {
    setIconPreview(previewOf(this.set));
    const rows = this.set.rows(this.host.inEffect());
    for (const [id, b] of this.tabBtns) {
      b.querySelector('.devp-badge')?.remove();
      const n = rows.filter((r) => pageOwns(id, r.patch)).length;
      if (n) b.append(el('span', 'devp-badge', String(n)));
    }
    this.changedIds = new Set(rows.filter((r) => pageOwns(this.page, r.patch)).map((r) => navIdOf(this.page, r.patch)));
    if (this.navBox?.isConnected) {
      const top = this.navBox.scrollTop;
      this.drawNav();
      this.navBox.scrollTop = top;
    }
  }

  get set() {
    return this.editor.set;
  }

  get selected(): string {
    return this.sel[this.page] ?? '';
  }

  private ctxClass(): ClassId {
    return this.classCtx ?? this.host.startClass();
  }

  /** What the chat is about: the skill on show (Skills page), else the class of what is on show. */
  chatScope(): ChatScope {
    const id = this.sel.skills;
    if (this.page === 'skills' && id && ABILITIES[id]) return { ability: id, name: ABILITIES[id].name };
    const cls = this.ctxClass();
    return { ability: '', classId: cls, name: `the ${CLASSES[cls].name} class` };
  }

  /** Open a skill on the Skills page. */
  openSkill(id: string): void {
    if (!ABILITIES[id]) return;
    this.page = 'skills';
    this.sel.skills = id;
    const c = ABILITIES[id].class as string;
    if ((CLASS_IDS as string[]).includes(c)) this.classCtx = c as ClassId;
    this.host.onSelect?.();
    this.host.repaint();
  }

  // ---------------------------------------------------------------- navigation

  private navGroups(): NavGroup[] {
    const groups = navFor(this.page);
    if (this.page === 'skills' || this.page === 'icons') {
      const first = (this.host.matchSkills?.() ?? []).filter((id) => ABILITIES[id]);
      const pre = this.page === 'icons' ? 'a:' : '';
      if (first.length) groups.unshift({ title: 'In this match', entries: first.map((id) => ({ id: pre + id, name: ABILITIES[id].name, sub: ABILITIES[id].school })) });
    }
    return groups;
  }

  private firstEntry(groups: NavGroup[]): NavEntry | null {
    for (const g of groups) {
      const e = g.entries[0] ?? this.firstEntry(g.groups ?? []);
      if (e) return e;
    }
    return null;
  }

  /** The entry to open when none is chosen yet: the first one of the class the panel opens on. */
  private initial(groups: NavGroup[]): string {
    const cls = this.ctxClass();
    const all: NavEntry[] = [];
    const flat = (g: NavGroup, top: string) => {
      for (const e of g.entries) all.push({ ...e, sub: `${top}|${e.sub ?? ''}` });
      for (const c of g.groups ?? []) flat(c, top);
    };
    for (const g of groups) flat(g, g.title);
    if (this.page === 'skills' || this.page === 'icons') {
      const m = (this.host.matchSkills?.() ?? []).find((id) => ABILITIES[id]);
      if (m) return this.page === 'icons' ? `a:${m}` : m;
    }
    const own = all.find((e) => e.sub?.startsWith(`${CLASSES[cls].name}|`));
    if (this.page === 'classes') return cls;
    return own?.id ?? this.firstEntry(groups)?.id ?? '';
  }

  private ensureSelection(groups: NavGroup[]): string {
    const ids = new Set<string>();
    const walk = (g: NavGroup) => {
      g.entries.forEach((e) => ids.add(e.id));
      g.groups?.forEach(walk);
    };
    groups.forEach(walk);
    let s = this.sel[this.page];
    if (!s || !ids.has(s)) s = this.sel[this.page] = this.initial(groups);
    return s;
  }

  private noteClass(): void {
    const id = this.sel[this.page];
    if (!id) return;
    const c = this.page === 'classes' ? (id as ClassId) : this.page === 'specs' ? classOfSpec(id) : this.page === 'talents' ? classOfTalent(id) : this.page === 'passives' ? (id.startsWith('s:') ? classOfSpec(id.slice(2)) : classOfTalent(id.slice(2))) : this.page === 'skills' ? (ABILITIES[id]?.class as ClassId) : this.page === 'icons' ? (id.startsWith('c:') ? (id.slice(2) as ClassId) : id.startsWith('p:') ? classOfSpec(id.slice(2)) : id.startsWith('a:') ? (ABILITIES[id.slice(2)]?.class as ClassId) : null) : null;
    if (c && CLASSES[c]) this.classCtx = c;
  }

  // ---------------------------------------------------------------- drawing

  /** The tabs, the search box and the page. */
  render(): HTMLElement {
    const root = el('div', 'devp-ws');
    setIconPreview(previewOf(this.set));
    const rows = this.set.rows(this.host.inEffect());
    const tabs = el('div', 'devp-tabs');
    tabs.dataset.tour = 'dev-pages'; // the guided tours point at these (tourData.ts)
    this.tabBtns.clear();
    this.changedIds = new Set(rows.filter((r) => pageOwns(this.page, r.patch)).map((r) => navIdOf(this.page, r.patch)));
    let step = '';
    for (const p of DEV_PAGES) {
      if (p.step !== step) {
        step = p.step;
        tabs.append(el('span', 'devp-step', `${DEV_PAGES.findIndex((x) => x.step === step) === 0 ? '' : '› '}${step}:`));
      }
      const n = rows.filter((r) => pageOwns(p.id, r.patch)).length;
      const b = el('button', `devp-tab${p.id === this.page ? ' sel' : ''}`, p.label);
      b.title = p.blurb;
      b.dataset.tour = `dev-page-${p.id}`;
      if (n) b.append(el('span', 'devp-badge', String(n)));
      b.addEventListener('click', () => {
        this.page = p.id;
        this.host.onSelect?.();
        this.host.repaint();
      });
      tabs.append(b);
      this.tabBtns.set(p.id, b);
    }
    root.append(tabs);

    const groups = this.navGroups();
    this.ensureSelection(groups);
    this.noteClass();

    const bar = el('div', 'devp-searchrow');
    bar.dataset.tour = 'dev-search';
    const input = el('input', 'devp-search');
    input.type = 'search';
    input.placeholder = `Search ${DEV_PAGES.find((p) => p.id === this.page)!.label.toLowerCase()}…`;
    input.value = this.search[this.page];
    input.addEventListener('keydown', (e) => e.stopPropagation()); // typing here never casts spells
    input.addEventListener('input', () => {
      this.search[this.page] = input.value;
      this.editor.filter = ''; // the search finds the entry in the list; the entry itself always shows every option
      this.drawNav();
      // the open entry is not in the list any more: open the first one that is
      const first = this.navBox?.querySelector<HTMLElement>('.devp-navitem');
      const shown = [...(this.navBox?.querySelectorAll<HTMLElement>('.devp-navitem') ?? [])].some((b) => b.classList.contains('sel'));
      if (input.value.trim() && first && !shown) first.click();
      else this.drawDetail();
    });
    const reset = el('button', 'mm-small', '↺ Reset this page');
    reset.title = `Put every value on the ${DEV_PAGES.find((p) => p.id === this.page)!.label} page back to the data file's number (typed ones and ones being tried)`;
    reset.addEventListener('click', () => {
      this.set.resetWhere((p) => pageOwns(this.page, p), this.host.inEffect(), this.host.canRevert);
      this.host.repaint();
      this.host.onEdit();
    });
    bar.append(input, reset);
    root.append(bar);
    this.editor.filter = '';

    const split = el('div', 'devp-split');
    this.navBox = el('div', 'devp-nav');
    this.detailBox = el('div', 'devp-detail');
    this.navBox.dataset.tour = 'dev-nav';
    this.detailBox.dataset.tour = 'dev-detail';
    this.navBox.addEventListener('scroll', () => this.scrollPos.set(`nav:${this.page}`, this.navBox?.scrollTop ?? 0));
    this.detailBox.addEventListener('scroll', () => this.scrollPos.set(`detail:${this.page}:${this.sel[this.page] ?? ''}`, this.detailBox?.scrollTop ?? 0));
    split.append(this.navBox, this.detailBox);
    if (this.page === 'options') split.classList.add('single'); // one entry: no list to pick from
    root.append(split);
    this.drawNav();
    this.drawDetail();
    return root;
  }

  private drawNav(): void {
    const box = this.navBox;
    if (!box) return;
    const navKey = `nav:${this.page}`;
    const keepNav = box.scrollTop || (this.scrollPos.get(navKey) ?? 0);
    box.replaceChildren();
    const q = this.search[this.page].trim().toLowerCase();
    const sel = this.sel[this.page];
    queueMicrotask(() => { box.scrollTop = keepNav; });
    const entryBtn = (e: NavEntry): HTMLElement => {
      const b = el('button', `devp-navitem${e.id === sel ? ' sel' : ''}`);
      if (this.page === 'skills' || this.page === 'icons') {
        const kind = this.page !== 'icons' ? 'ability' : ({ u: 'aura', c: 'class', p: 'spec' } as Record<string, 'aura' | 'class' | 'spec'>)[e.id[0]] ?? 'ability';
        const sk = iconEl(kind, this.page === 'icons' ? e.id.slice(2) : e.id, '', true);
        const ic = el('span', 'devp-navicon');
        ic.append(sk);
        b.append(ic);
      } else if (e.icon) b.append(el('span', 'devp-navicon', e.icon));
      b.append(el('span', 'devp-navname', e.name));
      if (e.sub) b.append(el('small', 'devp-dim', e.sub));
      if (this.page === 'skills') b.dataset.tip = `ability:${e.id}`;
      const changed = this.entryChanged(e.id);
      if (changed) b.append(el('span', 'devp-dot', '●'));
      b.addEventListener('click', () => {
        this.scrollPos.delete(`detail:${this.page}:${e.id}`);
        this.sel[this.page] = e.id;
        this.noteClass();
        this.host.onSelect?.();
        this.drawNav();
        this.drawDetail();
      });
      return b;
    };
    const draw = (g: NavGroup, parentKey: string, into: HTMLElement): boolean => {
      const key = `${this.page}:${parentKey}/${g.title}`;
      const entries = g.entries.filter((e) => !q || navText(e).includes(q) || g.title.toLowerCase().includes(q) || parentKey.toLowerCase().includes(q));
      const sub = el('div', 'devp-navgroup');
      let any = entries.length > 0;
      for (const e of entries) sub.append(entryBtn(e));
      for (const c of g.groups ?? []) any = draw(c, `${parentKey}/${g.title}`, sub) || any;
      if (!any) return false;
      const holdsSel = !!sel && (entries.some((e) => e.id === sel) || JSON.stringify(g).includes(`"id":"${sel}"`));
      const d = el('details', 'devp-navfold');
      d.open = q ? true : this.navOpen.get(key) ?? holdsSel;
      d.addEventListener('toggle', () => {
        if (!q) this.navOpen.set(key, d.open);
      });
      const count = this.count(g);
      d.append(el('summary', '', `${g.title}`), sub);
      d.querySelector('summary')!.append(el('small', 'devp-dim', ` ${count}`));
      into.append(d);
      return true;
    };
    const groups = this.navGroups();
    // one group alone (Game options) needs no fold
    if (groups.length === 1 && !groups[0].groups && groups[0].entries.length <= 1) {
      for (const e of groups[0].entries) box.append(entryBtn(e));
      return;
    }
    let shown = false;
    for (const g of groups) shown = draw(g, '', box) || shown;
    if (!shown) box.append(el('small', 'devp-dim', 'Nothing matches.'));
  }

  private count(g: NavGroup): number {
    return g.entries.length + (g.groups ?? []).reduce((n, c) => n + this.count(c), 0);
  }

  /** Is anything on this entry typed or being tried? (a dot in the list) */
  private entryChanged(id: string): boolean {
    return this.changedIds.has(id);
  }

  private drawDetail(): void {
    const box = this.detailBox;
    if (!box) return;
    const detailKey = `detail:${this.page}:${this.sel[this.page] ?? ''}`;
    const keepDetail = this.scrollPos.get(detailKey) ?? 0;
    box.replaceChildren();
    queueMicrotask(() => { box.scrollTop = keepDetail; });
    const id = this.sel[this.page];
    if (!id) return void box.append(el('small', 'devp-dim', 'Pick something on the left.'));
    const ed = this.editor;
    const q = ed.filter;
    if (this.page === 'skills') {
      if (!ABILITIES[id]) return void box.append(el('small', 'devp-dim', 'That skill is gone.'));
      box.append(this.head(ABILITIES[id].name, `${ABILITIES[id].school} · ${CLASSES[ABILITIES[id].class as ClassId]?.name ?? ABILITIES[id].class}`, id));
      box.append(ed.skillBody(id));
      box.append(this.dataEditor('abilities', id));
      return;
    }
    const entry = entryFor(this.page, id);
    if (!entry) return void box.append(el('small', 'devp-dim', 'Nothing to show.'));
    if (this.page === 'icons') return this.iconEd.draw(box, id);
    box.append(this.head(entry.name, entry.sub, id));
    if (this.page === 'sounds') {
      if (!soundsLoadedOnce) {
        soundsLoadedOnce = true;
        void loadCustomSounds().then((changed) => changed && this.host.repaint());
      }
      if (id.startsWith('lib:')) libraryPage(box, id.slice(4), () => { this.sel.sounds = undefined; this.host.repaint(); });
      else {
        const fileField = entry.groups.flatMap((g) => g.fields).find((f) => f.path[1] === 'file');
        soundTools(box, {
          id,
          setFile: (v) => {
            if (fileField) this.editor.set.set(fileField, v, this.editor.testing(), this.editor.canRevert);
            this.editor.onEdit();
          },
          redraw: () => this.host.repaint(),
        });
      }
    }
    if (entry.lines.length) {
      const does = el('div', 'devp-does');
      for (const l of entry.lines) does.append(el('div', '', l));
      box.append(does);
    }
    if (entry.facts.length && !q) {
      const facts = el('div', 'devp-facts');
      for (const [k, v] of entry.facts) facts.append(el('span', 'devp-dim', k), el('span', '', v));
      box.append(facts);
    }
    if (entry.skillLinks?.length && !q) {
      const links = el('div', 'devp-row devp-links');
      links.append(el('small', 'devp-dim', 'Skills:'));
      for (const s of [...new Set(entry.skillLinks)].filter((x) => ABILITIES[x])) {
        const b = el('button', 'mm-small devp-link', ABILITIES[s].name);
        b.title = 'Open it on the Skills page';
        b.addEventListener('click', () => this.openSkill(s));
        links.append(b);
      }
      box.append(links);
    }
    let any = false;
    for (const g of entry.groups) {
      const node = ed.group(g, `${this.page}:${id}`);
      if (node) {
        box.append(node);
        any = true;
      }
    }
    // a spec's or talent's bonuses and skill changes are edited right here, the way a skill's numbers are (they used to be a page away)
    const pass = entry.passivesId ? entryFor('passives', entry.passivesId) : null;
    if (pass) {
      if (!q) box.append(el('div', 'devp-title', 'Bonuses and changes to skills'));
      for (const g of pass.groups) {
        const node = ed.group(g, `passives:${pass.id}`);
        if (node) {
          box.append(node);
          any = true;
        }
      }
      if (pass.addTargets) box.append(this.addWidget(pass)); // also while searching: this is where a shield on a heal is added
    }
    if (!any && q) box.append(el('small', 'devp-dim', 'No value here matches the search.'));
    if (entry.addTargets && !q) box.append(this.addWidget(entry));
    if (!q && this.page !== 'passives' && canEditAsData(entry.file)) box.append(this.dataEditor(entry.file, entry.id));
  }

  /** "Edit as data": the whole entry as text. Anything the game can do with a skill, buff, talent or spec can be added, changed or removed here. */
  private dataEditor(file: DataPatch['file'], id: string): HTMLElement {
    const key = `${this.page}:${id}:data`;
    const box = el('details', 'devp-sec devp-add');
    box.open = this.editor.open.get(key) ?? false;
    box.addEventListener('toggle', () => this.editor.open.set(key, box.open));
    box.append(el('summary', 'devp-sec-head', '＋ Add or remove anything (effects, shields, bonuses…)'));
    box.append(el('small', 'devp-dim', 'Every part of this entry as boxes. ✕ removes a part, ＋ adds one the game knows (a shield, damage, a stun, a talent bonus). Mistakes are listed and cannot be applied.'));
    const field = { file, id, path: ['$entity'], base: entityText(file, id, true) ?? '', value: entityText(file, id) ?? '' };
    const norm = (t: string) => { try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return t; } };
    const testing = this.host.testing();
    const dk = `${file}:${id}`;
    let work: Record<string, unknown> = this.drafts.get(dk) ?? JSON.parse(String(this.set.shown(field, testing)) || '{}');
    const keepDraft = () => {
      if (norm(JSON.stringify(work)) === norm(String(this.set.shown(field, testing)))) this.drafts.delete(dk);
      else this.drafts.set(dk, work);
    };
    const msg = el('div', 'devp-dim');
    const apply = el('button', 'mm-small mm-go', 'Apply');
    const area = el('textarea', 'devp-data') as HTMLTextAreaElement;
    area.spellcheck = false;
    area.rows = 12;
    const current = () => JSON.stringify(work, null, 2);
    const check = () => {
      const text = current();
      const bad = entityProblems(file, id, text);
      msg.replaceChildren(...(bad.length ? bad.slice(0, 6).map((b) => el('div', 'devp-bad', `✗ ${b}`)) : [el('div', '', '✓ Ready to apply')]));
      apply.toggleAttribute('disabled', bad.length > 0 || norm(text) === norm(String(this.set.shown(field, testing))));
    };
    const formHost = el('div');
    const drawForm = () => {
      formHost.replaceChildren(dataForm(file, work, () => { area.value = current(); keepDraft(); check(); }, drawForm));
      area.value = current();
      check();
    };
    drawForm();
    apply.addEventListener('click', () => {
      this.drafts.delete(dk);
      this.set.set(field, norm(current()), testing, this.host.canRevert);
      this.host.onEdit();
      this.host.repaint();
    });
    const reset = el('button', 'mm-small', '↺ Put back');
    reset.title = 'Put this entry back to the data file';
    reset.addEventListener('click', () => {
      this.drafts.delete(dk);
      this.set.set(field, field.base, testing, this.host.canRevert);
      this.host.onEdit();
      this.host.repaint();
    });
    const raw = el('details', 'devp-sec');
    raw.append(el('summary', 'devp-dim', 'Advanced: the same thing as text'));
    area.addEventListener('input', () => {
      try {
        work = JSON.parse(area.value);
        keepDraft();
        formHost.replaceChildren(dataForm(file, work, () => { area.value = current(); keepDraft(); check(); }, drawForm));
      } catch { /* mid-typing */ }
      const bad = entityProblems(file, id, area.value);
      msg.replaceChildren(...(bad.length ? bad.slice(0, 6).map((b) => el('div', 'devp-bad', `✗ ${b}`)) : [el('div', '', '✓ Ready to apply')]));
      apply.toggleAttribute('disabled', bad.length > 0);
    });
    raw.append(area);
    box.append(formHost, msg, el('div', 'devp-row'), raw);
    (box.children[box.children.length - 2] as HTMLElement).append(apply, reset);
    return box;
  }

  /** The entry's title with a reset for everything on it. */
  private head(name: string, sub: string, id: string): HTMLElement {
    const head = el('div', 'devp-entryhead');
    const t = el('div');
    t.append(el('div', 'devp-title', name), el('small', 'devp-dim', sub));
    const reset = el('button', 'mm-small', '↺ Reset this');
    reset.title = 'Put every value of this entry back to the data file\'s number';
    reset.addEventListener('click', () => {
      this.resetEntry(id);
      this.host.repaint();
      this.host.onEdit();
    });
    head.append(t, reset);
    return head;
  }

  /** The (file, id) pairs an entry's values live in: itself, and for a skill the buffs shown with it. */
  private entryPairs(id: string): { file: DataPatch['file']; id: string }[] {
    if (this.page === 'skills') {
      const info = skillInfo(id);
      return [{ file: 'abilities', id }, ...info.sections.filter((s) => s.kind === 'aura').map((s) => ({ file: 'auras' as const, id: s.id })), ...info.modifiers.map((m) => ({ file: m.source.file as DataPatch['file'], id: m.source.id }))];
    }
    const e = entryFor(this.page, id);
    return e ? [{ file: e.file, id: e.id }] : [];
  }

  private resetEntry(id: string): void {
    const pairs = this.entryPairs(id);
    const hit = (p: Pick<DataPatch, 'file' | 'id'>) => pairs.some((x) => x.file === p.file && x.id === p.id);
    const mine = (p: DataPatch) => hit(p) && (this.page === 'skills' || pageOwns(this.page, p) || ((this.page === 'talents' || this.page === 'specs') && pageOwns('passives', p))) && ((this.page !== 'animations' && this.page !== 'sounds') || p.path[0] === id) && (this.page !== 'icons' || p.path[0] === ({ u: 'aura', c: 'class', p: 'spec' } as Record<string, string>)[id[0]] || (p.path[0] === 'ability' && id.startsWith('a:')));
    for (const [k, p] of [...this.set.edits]) if (mine(p)) this.set.edits.delete(k);
    if (this.host.canRevert) for (const p of this.host.inEffect()) if (mine(p)) this.set.reverted.add(patchKey(p));
  }

  /** "Add a change": pick a skill or buff, then every stat change it could get from this spec, talent or buff shows as rows. */
  private addWidget(entry: DevEntry): HTMLElement {
    const key = `${this.page}:${entry.id}`;
    const box = el('details', 'devp-sec devp-add');
    box.open = this.editor.open.get(`${key}:add`) ?? false;
    box.addEventListener('toggle', () => this.editor.open.set(`${key}:add`, box.open));
    box.append(el('summary', 'devp-sec-head', `＋ Add a change to a skill or buff`));
    box.append(el('small', 'devp-dim', `Give ${entry.name} a bonus it does not have yet: pick the skill (or buff) it should change, then set the value that does something.`));
    const cur = this.adding.get(key);
    const row = el('div', 'devp-row');
    const kindSel = el('select', 'devp-sel');
    for (const [v, l] of [['ability', 'Skill'], ['aura', 'Buff or debuff']] as const) {
      const o = el('option', '', l);
      o.value = v;
      kindSel.append(o);
    }
    kindSel.value = cur?.kind ?? 'ability';
    const list = (kind: 'ability' | 'aura'): ModTarget[] => (entry.addTargets ?? []).filter((t) => t.kind === kind);
    const targetSel = el('select', 'devp-sel');
    const fill = () => {
      targetSel.replaceChildren();
      for (const t of list(kindSel.value as 'ability' | 'aura')) {
        const o = el('option', '', t.name);
        o.value = t.id;
        targetSel.append(o);
      }
    };
    fill();
    if (cur) targetSel.value = cur.id;
    kindSel.addEventListener('change', () => {
      fill();
      this.adding.set(key, { kind: kindSel.value as 'ability' | 'aura', id: targetSel.value });
      this.host.repaint();
    });
    targetSel.addEventListener('change', () => {
      this.adding.set(key, { kind: kindSel.value as 'ability' | 'aura', id: targetSel.value });
      this.host.repaint();
    });
    row.append(kindSel, targetSel);
    box.append(row);
    const pick = cur ?? { kind: 'ability' as const, id: targetSel.value };
    if (pick.id && (entry.file === 'specs' || entry.file === 'talents' || entry.file === 'auras')) {
      const fields = pick.kind === 'ability' ? skillSlots(entry.file, entry.id, pick.id) : auraSlots(entry.file, entry.id, pick.id);
      if (fields.length && this.adding.has(key)) box.append(this.editor.fieldList(fields));
      else if (fields.length) box.append(el('small', 'devp-dim', 'Choose from the lists to see the values.'));
    }
    return box;
  }

  /** The "changes so far" list: every value changed as old -> new with an undo. */
  changesList(): HTMLElement {
    const box = el('div', 'devp-changes-list');
    const rows = this.set.rows(this.host.inEffect());
    if (!rows.length) {
      box.append(el('small', 'devp-dim', 'No changes yet. Change a value on any page and it appears here.'));
      return box;
    }
    for (const r of rows) {
      const line = el('div', `devp-change${r.pending ? ' pending' : ''}`);
      const what = el('span', 'devp-change-what');
      what.append(el('b', '', r.owner), el('span', '', ` · ${r.label}`));
      const vals = el('span', 'devp-change-vals');
      vals.append(el('span', 'devp-dim', r.fromText), el('span', '', ' → '), el('b', '', r.toText));
      const tag = el('small', r.pending ? 'devp-tag new' : 'devp-tag', r.pending ? 'not sent yet' : this.host.canRevert ? 'being tried' : 'proposed');
      const undo = el('button', 'mm-small', 'Undo');
      undo.title = r.pending && !this.host.testing().has(r.key) ? 'Forget this change' : "Put the data file's number back";
      undo.disabled = !r.pending && !this.host.canRevert;
      undo.addEventListener('click', () => {
        this.set.undo(r.key, this.host.testing(), this.host.canRevert);
        this.host.repaint();
        this.host.onEdit();
      });
      line.append(what, vals, tag, undo);
      box.append(line);
    }
    return box;
  }

  /** How many values are changed in total (typed and being tried). */
  changeCount(): number {
    return this.set.rows(this.host.inEffect()).length;
  }
}
