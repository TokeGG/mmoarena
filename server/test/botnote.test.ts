import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Accounts } from '../src/accounts';
import { MemoryStore } from '../src/store';
import { Lobby } from '../src/rooms';
import { BotLearner, NOTES_MAX } from '../src/botlearn';
import { BRAIN_BOUNDS, BRAIN_KEYS, NOTE_WEIGHT, brainFor, describeVariant } from '@arena/shared';
import type { ClassId, ClientMsg, ServerMsg } from '@arena/shared';

const sock = () => {
  const sent: ServerMsg[] = [];
  return { readyState: 1, sent, send(d: string) { sent.push(JSON.parse(d)); } } as any;
};
const until = async (cond: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(await cond(), 'timed out');
};
const of = (s: any, t: string) => (s.sent as any[]).filter((m) => m.t === t);

/** A real learner whose mage bots all play the 'lesson' variant (the shipped brain moved by a note). */
async function learnerWithLesson() {
  const learner = new BotLearner(new MemoryStore());
  await learner.whenReady();
  await learner.addNote({ matchId: 'aaaaaaaaaaaa', text: "didn't los enough, ran out of mana", by: 'Setup', role: 'owner', matchClasses: ['mage'] });
  const pops = (learner as any).pops as Map<ClassId, { variants: { id: string; brain: any }[] }>;
  learner.pick = (c: ClassId) => {
    const lesson = pops.get(c)!.variants.find((v) => v.id === 'lesson');
    return lesson ? { variantId: 'lesson', brain: lesson.brain } : { variantId: 'g0v0', brain: brainFor(c) };
  };
  return learner;
}

async function setup() {
  const accounts = new Accounts(new MemoryStore());
  const learner = await learnerWithLesson();
  let clock = 1_000_000;
  const lobby = new Lobby({ practicePrepMs: 0, queuePrepMs: 0, minCountedMatchMs: 0, now: () => (clock += 3000) }, accounts, learner);
  const reg = async (name: string) => {
    const s = sock();
    const p = lobby.connect(s, '5.5.5.5');
    lobby.handle(p, { t: 'register', name, password: 'password1' } as ClientMsg);
    await until(() => s.sent.some((m: ServerMsg) => m.t === 'account'));
    return { s, p };
  };
  const human = await reg('Hum');
  const owner = await reg('Own');
  owner.p.ownerOk = true;
  const dev = await reg('Dev');
  dev.p.account = { ...dev.p.account!, grants: ['dev'] };
  const fan = await reg('Fan');
  const guestSock = sock();
  const guest = { s: guestSock, p: lobby.connect(guestSock, '6.6.6.6') };
  lobby.handle(human.p, { t: 'join', name: 'x', classId: 'priest', mode: 'practice', size: 1, difficulty: 'normal', foes: ['mage'] } as ClientMsg);
  const room: any = human.p.room;
  assert.ok(room, 'practice started');
  const bots = [...room.sim.units.values()].filter((u: any) => u.controller === 'bot');
  assert.equal(bots[0].classId, 'mage');
  return { accounts, lobby, learner, human, owner, dev, fan, guest, room, bots };
}

describe('the testing marker reaches only the owner and devs', () => {
  it('owner and dev get bot_tests (watching), nobody else gets anything about it', async () => {
    const t = await setup();
    for (const who of [t.owner, t.dev, t.fan, t.guest]) t.room.addSpectator(who.p);
    for (let i = 0; i < 6; i++) t.lobby.tick();

    for (const who of [t.owner, t.dev]) {
      const m = of(who.s, 'bot_tests');
      assert.ok(m.length >= 1, 'sent when they started watching');
      assert.equal(m.at(-1).match, t.room.id);
      assert.equal(m.at(-1).bots, 1);
      assert.equal(m.at(-1).units.length, 1);
      assert.equal(m.at(-1).units[0].unit, t.bots[0].id);
      assert.equal(m.at(-1).units[0].label, 'lesson');
      assert.ok(m.at(-1).units[0].tries.length >= 1);
    }
    // a normal player in the match, a spectator, a guest: not one message, not one word of it
    for (const who of [t.human, t.fan, t.guest]) {
      assert.equal(of(who.s, 'bot_tests').length, 0);
      const all = JSON.stringify(who.s.sent);
      assert.ok(!/bot_tests|\"tries\"|lesson|Learning test|line of sight/i.test(all), 'no trace of the test in anything they received');
    }
    t.room.removeSpectator(t.owner.p);
  });

  it('a dev who plays the match is told too (the bots they fight); the same tries as the learning report', async () => {
    const t = await setup();
    const s = sock();
    const accounts = (t.lobby as any).accounts as Accounts;
    const p = t.lobby.connect(s, '7.7.7.7');
    t.lobby.handle(p, { t: 'register', name: 'Dee', password: 'password1' } as ClientMsg);
    await until(() => s.sent.some((m: ServerMsg) => m.t === 'account'));
    p.account = { ...p.account!, grants: ['dev'] };
    t.lobby.handle(p, { t: 'join', name: 'x', classId: 'rogue', mode: 'practice', size: 1, difficulty: 'normal', foes: ['mage'] } as ClientMsg);
    for (let i = 0; i < 3; i++) t.lobby.tick();
    const m = of({ sent: s.sent }, 'bot_tests');
    assert.ok(m.length >= 1, 'sent on the first tick');
    const marker = m.at(-1).units[0];
    // the marker and "What was learned" are built from the same variant record
    const k = t.learner.knowledge().find((c) => c.classId === 'mage')!;
    const lesson = k.variants!.find((v) => v.id === 'lesson')!;
    assert.deepEqual(marker.tries.map((x: any) => x.text), lesson.tries.map((x) => x.text));
    assert.equal(marker.more, lesson.more);
    assert.match(marker.tries.map((x: any) => x.text).join(' | '), /break line of sight more \(\d+% instead of \d+%\)/);
    assert.deepEqual(t.learner.variantTest('mage', 'lesson'), (({ unit, ...r }) => r)(marker));
    void accounts;
  });

  it('snapshots and replays are the same for everybody: nothing of it in them', async () => {
    const t = await setup();
    t.room.addSpectator(t.owner.p);
    for (let i = 0; i < 20; i++) t.lobby.tick();
    for (const who of [t.owner, t.human]) {
      const snaps = JSON.stringify(of(who.s, 'snapshot'));
      assert.ok(snaps.length > 100);
      assert.ok(!/bot_test|lesson|tries/i.test(snaps), 'the snapshots carry nothing');
    }
    const replay = JSON.stringify(t.room.recorder?.finish([]) ?? {});
    assert.ok(!/bot_test|lesson|tries/i.test(replay));
  });

  it('an owner who plays a bot by hand has no marker for that unit, and a fresh one when it is handed back', async () => {
    const t = await setup();
    t.room.addSpectator(t.owner.p);
    t.lobby.tick();
    assert.equal(of(t.owner.s, 'bot_tests').at(-1).units.length, 1);
    t.lobby.handle(t.owner.p, { t: 'admin_takeover', id: t.room.id, unit: t.bots[0].id } as ClientMsg);
    assert.ok(t.owner.p.ctl, 'took over');
    assert.equal(of(t.owner.s, 'bot_tests').at(-1).units.length, 0, 'the unit played by hand has no marker');
    t.lobby.handle(t.owner.p, { t: 'admin_release' } as ClientMsg);
    assert.equal(of(t.owner.s, 'bot_tests').at(-1).units.length, 1, 'a bot plays it again');
    assert.equal(of(t.human.s, 'bot_tests').length, 0);
  });

  it('a bot on the shipped brain has no marker; the match still tells owners it has a bot (for the note box)', async () => {
    const t = await setup();
    t.learner.pick = (c: ClassId) => ({ variantId: 'g0v0', brain: brainFor(c) });
    const s = sock();
    const p = t.lobby.connect(s, '8.8.8.8');
    p.ownerOk = true;
    t.lobby.handle(p, { t: 'join', name: 'x', classId: 'rogue', mode: 'practice', size: 1, difficulty: 'normal', foes: ['mage'] } as ClientMsg);
    t.lobby.tick();
    const m = of(s, 'bot_tests');
    assert.equal(m.at(-1).units.length, 0);
    assert.equal(m.at(-1).bots, 1);
  });
});

describe('notes for the bots', () => {
  it('a normal player cannot send one (nothing is stored, nothing moves)', async () => {
    const t = await setup();
    const before = t.learner.noteList().length;
    const lesson = JSON.stringify(t.learner.knowledge().find((c) => c.classId === 'mage')!.learned);
    for (const who of [t.human, t.fan, t.guest]) {
      t.lobby.handle(who.p, { t: 'bot_note', id: t.room.id, text: "didn't los enough" } as ClientMsg);
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(t.learner.noteList().length, before);
    assert.equal(JSON.stringify(t.learner.knowledge().find((c) => c.classId === 'mage')!.learned), lesson);
    assert.equal(of(t.human.s, 'bot_note_ack').length, 0);
    assert.equal((of(t.human.s, 'dev_result').at(-1) as any).ok, false);
  });

  it('a dev note on a live match moves the lesson variant of the classes in it, and is stored with who wrote it', async () => {
    const t = await setup();
    const mageBefore = t.learner.knowledge().find((c) => c.classId === 'mage')!.learned;
    t.room.addSpectator(t.dev.p);
    t.lobby.handle(t.dev.p, { t: 'bot_note', id: t.room.id, text: "the bot didn't use cover and wasted trinket" } as ClientMsg);
    await until(() => of(t.dev.s, 'bot_note_ack').length > 0);
    const ack = of(t.dev.s, 'bot_note_ack').at(-1);
    assert.equal(ack.ok, true);
    assert.match(ack.text, /^Your note moved: mage bots now /);
    assert.match(ack.lines.join('\n'), /mage bots now break line of sight more/);
    const after = t.learner.knowledge().find((c) => c.classId === 'mage')!.learned;
    assert.ok(after.losUse > mageBefore.losUse, 'losUse went up');
    assert.ok(after.trinketAt < mageBefore.trinketAt || mageBefore.trinketAt === BRAIN_BOUNDS.trinketAt[0], 'trinketAt went down');
    const notes = t.learner.noteList();
    assert.equal(notes[0].by, 'Dev');
    assert.equal(notes[0].role, 'dev');
    assert.equal(notes[0].matchId, t.room.id);
    assert.equal(typeof notes[0].liveSec, 'number', 'timestamped inside the match');
    assert.deepEqual(notes[0].classes, ['mage']);
    assert.equal(notes[0].weight, NOTE_WEIGHT);
    // the report log shows it
    const rep = t.learner.learnReports()[0];
    assert.equal(rep.source, 'note');
    assert.equal(rep.replayId, t.room.id);
    assert.equal(rep.note?.text, notes[0].text);
    // the admin panel viewers are told (notes + bugs ride in bot_knowledge)
    const k = of(t.dev.s, 'bot_knowledge').at(-1);
    assert.equal(k.notes[0].id, notes[0].id);
    // and the owner's admin log has it
    const log = await (t.lobby as any).adminLog?.list?.();
    if (log) assert.ok(JSON.stringify(log).includes('note for the bots'));
  });

  it('a note on a finished match (an archived replay) goes to the classes of that match\'s bots, or the ones it names', async () => {
    const t = await setup();
    t.learner.archived = async () => [{ id: 'bbbbbbbbbbbb', at: 1, bots: ['priest', 'rogue'], humans: ['mage'], humansWon: true }];
    const before = (c: ClassId) => t.learner.knowledge().find((k) => k.classId === c)!.learned;
    const priest = before('priest');
    const rogue = before('rogue');
    const mage = before('mage');
    t.lobby.handle(t.owner.p, { t: 'bot_note', id: 'bbbbbbbbbbbb', text: 'ran out of mana' } as ClientMsg);
    await until(() => of(t.owner.s, 'bot_note_ack').length > 0);
    assert.equal(of(t.owner.s, 'bot_note_ack').at(-1).ok, true);
    assert.ok(before('priest').spendBias > priest.spendBias, 'priest');
    assert.ok(before('rogue').spendBias > rogue.spendBias, 'rogue');
    assert.equal(before('mage').spendBias, mage.spendBias, 'the mage was a person in that match');
    assert.equal(t.learner.noteList()[0].role, 'owner');
    // a class tag chooses
    const p2 = before('priest');
    t.lobby.handle(t.owner.p, { t: 'bot_note', id: 'bbbbbbbbbbbb', text: 'rogue: wasted trinket' } as ClientMsg);
    await until(() => of(t.owner.s, 'bot_note_ack').length > 1);
    assert.equal(before('priest').trinketAt, p2.trinketAt);
    assert.ok(before('rogue').trinketAt <= rogue.trinketAt);
    assert.deepEqual(t.learner.noteList()[0].classes, ['rogue']);
    // an unknown match, and a match without bots
    t.lobby.handle(t.owner.p, { t: 'bot_note', id: 'cccccccccccc', text: 'ran out of mana' } as ClientMsg);
    await until(() => of(t.owner.s, 'bot_note_ack').length > 2);
    assert.equal(of(t.owner.s, 'bot_note_ack').at(-1).ok, false);
    t.learner.archived = async () => [{ id: 'dddddddddddd', at: 1, bots: [], humans: ['mage'], humansWon: true }];
    t.lobby.handle(t.owner.p, { t: 'bot_note', id: 'dddddddddddd', text: 'ran out of mana' } as ClientMsg);
    await until(() => of(t.owner.s, 'bot_note_ack').length > 3);
    assert.match(of(t.owner.s, 'bot_note_ack').at(-1).text, /no bots/);
  });

  it('notes from one person are spaced out', async () => {
    const t = await setup();
    (t.lobby as any).clock = () => 5_000_000; // a frozen clock
    t.lobby.handle(t.dev.p, { t: 'bot_note', id: t.room.id, text: 'ran out of mana' } as ClientMsg);
    t.lobby.handle(t.dev.p, { t: 'bot_note', id: t.room.id, text: 'wasted trinket' } as ClientMsg);
    await until(() => of(t.dev.s, 'bot_note_ack').length >= 2);
    const acks = of(t.dev.s, 'bot_note_ack');
    assert.equal(acks.filter((a) => a.ok).length, 1);
    assert.match(acks.find((a) => !a.ok).text, /wait a second/);
  });

  it('what cannot be placed comes back; a bug report goes to the bug list, only the owner marks it fixed', async () => {
    const t = await setup();
    t.lobby.handle(t.dev.p, { t: 'bot_note', id: t.room.id, text: 'the mage got stuck on a pillar. purple flamingo danced strangely' } as ClientMsg);
    await until(() => of(t.dev.s, 'bot_note_ack').length > 0);
    const ack = of(t.dev.s, 'bot_note_ack').at(-1);
    assert.equal(ack.ok, true);
    assert.equal(ack.bug, true);
    assert.deepEqual(ack.unmapped, ['purple flamingo danced strangely']);
    assert.match(ack.text, /did not move any bot numbers/);
    const bug = t.learner.bugList()[0];
    assert.equal(bug.by, 'Dev');
    assert.equal(bug.matchId, t.room.id);
    assert.equal(bug.fixed, false);
    assert.match(bug.text, /stuck/);
    // a dev cannot close it, the owner can
    t.lobby.handle(t.dev.p, { t: 'admin_act', act: 'bug_fixed', id: bug.id } as ClientMsg);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(t.learner.bugList()[0].fixed, false);
    assert.equal((of(t.dev.s, 'dev_result').at(-1) as any).ok, false);
    t.lobby.handle(t.owner.p, { t: 'admin_act', act: 'bug_fixed', id: bug.id } as ClientMsg);
    await until(() => t.learner.bugList()[0].fixed);
    assert.equal(t.learner.bugList()[0].fixedBy, 'Own');
    t.lobby.handle(t.owner.p, { t: 'admin_act', act: 'bug_fixed', id: bug.id, on: false } as ClientMsg);
    await until(() => !t.learner.bugList()[0].fixed);
    // the lists survive a restart
    await t.learner.flush();
    const again = new BotLearner((t.learner as any).store);
    await again.whenReady();
    assert.equal(again.bugList()[0].id, bug.id);
    assert.equal(again.noteList().length, t.learner.noteList().length);
  });
});

describe('a note moves the bots through the same limits as graded learning', () => {
  it('one note moves a number by NOTE_WEIGHT graded nudges, no more than a replay\'s step, and never out of bounds', async () => {
    const learner = new BotLearner(new MemoryStore());
    await learner.whenReady();
    const shipped = brainFor('mage');
    const { report } = await learner.addNote({ matchId: 'aaaaaaaaaaaa', text: "didn't los enough", by: 'D', role: 'dev', matchClasses: ['mage'] });
    const after = learner.knowledge().find((c) => c.classId === 'mage')!.learned;
    const [lo, hi] = BRAIN_BOUNDS.losUse;
    const step = Math.min(0.04 * (hi - lo) * NOTE_WEIGHT, 0.2 * (hi - lo));
    assert.ok(Math.abs(after.losUse - Math.min(hi, shipped.losUse + step)) < 1e-9);
    assert.ok(report.classes[0].moved.some((m) => m.key === 'losUse'));
    // the other classes were not touched
    for (const c of ['priest', 'rogue', 'warrior'] as ClassId[]) assert.deepEqual(learner.knowledge().find((k) => k.classId === c)!.diff, []);
  });

  it('piling up notes never passes the drift room or a bound, and widening the room is reported', async () => {
    const learner = new BotLearner(new MemoryStore());
    await learner.whenReady();
    const shipped = brainFor('priest');
    const notes: string[] = [];
    for (let i = 0; i < 40; i++) {
      const { report } = await learner.addNote({ matchId: 'aaaaaaaaaaaa', text: 'ran out of mana and healed too much and kicked too early and stood in flamestrike', by: 'D', role: 'dev', matchClasses: ['priest'] });
      notes.push(...(report.classes[0]?.notes ?? []));
    }
    const l = learner.knowledge().find((k) => k.classId === 'priest')!.learned;
    for (const k of BRAIN_KEYS) {
      assert.ok(l[k] >= BRAIN_BOUNDS[k][0] - 1e-9 && l[k] <= BRAIN_BOUNDS[k][1] + 1e-9, `${k} inside its bounds`);
      assert.ok(Math.abs(l[k] - shipped[k]) <= 0.95 * (BRAIN_BOUNDS[k][1] - BRAIN_BOUNDS[k][0]) + 1e-9, `${k} inside the largest room`);
    }
    assert.ok(notes.some((n) => /reached its limit|is at its bound/.test(n)), 'the limits are said in the report');
    assert.ok(learner.noteList().length <= NOTES_MAX);
  });

  it('the lesson variant exists afterwards and is handed to bots (so it is tried against people)', async () => {
    const learner = new BotLearner(new MemoryStore(), () => 0.5);
    await learner.whenReady();
    assert.equal(learner.summary().mage.variants.some((v) => v.id === 'lesson'), false);
    await learner.addNote({ matchId: 'aaaaaaaaaaaa', text: "didn't los enough", by: 'D', role: 'dev', matchClasses: ['mage'] });
    assert.equal(learner.summary().mage.variants.some((v) => v.id === 'lesson'), true);
    // a lesson variant that differs from the shipped brain has a marker, with its record
    const t = learner.variantTest('mage', 'lesson')!;
    assert.equal(t.label, 'lesson');
    assert.deepEqual(t, describeVariant('mage', 'lesson', learner.knowledge().find((c) => c.classId === 'mage')!.learned, { games: 0, wins: 0 }));
    // graded results are credited to it as for any variant
    learner.report('mage', 'lesson', true, 1);
    assert.equal(learner.variantTest('mage', 'lesson')!.games, 1);
  });

  it('the notes survive a restart and "reset the learned bots" clears the notes but keeps the bug list', async () => {
    const store = new MemoryStore();
    const a = new BotLearner(store);
    await a.whenReady();
    await a.addNote({ matchId: 'aaaaaaaaaaaa', text: "didn't los enough. it got stuck", by: 'D', role: 'dev', matchClasses: ['mage'] });
    await a.flush();
    const b = new BotLearner(store);
    await b.whenReady();
    assert.equal(b.noteList().length, 1);
    assert.equal(b.bugList().length, 1);
    await b.resetBrain();
    assert.equal(b.noteList().length, 0);
    assert.equal(b.bugList().length, 1);
  });
});
