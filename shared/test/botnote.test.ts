import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_NOTE_MAX, BRAIN_KEYS, BRAIN_WORDS, NOTE_PHRASES, NOTE_WEIGHT, brainFor, describeVariant, formatReport, noteLines, parseClientMsg, parseNote, tryText } from '../src';
import type { Brain, NoteInfo } from '../src';

const has = (text: string, key: keyof Brain, dir: 1 | -1) => parseNote(text).effects.some((e) => e.key === key && e.dir === dir);

describe('notes for the bots: phrases to brain numbers', () => {
  it('every one of the 34 numbers has phrases for both directions', () => {
    assert.equal(BRAIN_KEYS.length, 34);
    for (const k of BRAIN_KEYS) {
      assert.ok(NOTE_PHRASES[k].up.length >= 3, `${k} up`);
      assert.ok(NOTE_PHRASES[k].down.length >= 3, `${k} down`);
    }
  });

  it('every listed phrase maps to its number and direction (all of them, table driven)', () => {
    for (const k of BRAIN_KEYS) {
      for (const [d, dir] of [['up', 1], ['down', -1]] as const) {
        for (const p of NOTE_PHRASES[k][d]) assert.ok(has(p, k, dir), `"${p}" should move ${k} ${d}`);
      }
    }
  });

  it('the plain sentences of BRAIN_WORDS work as phrases too, brackets left out', () => {
    for (const k of BRAIN_KEYS) {
      assert.ok(has(BRAIN_WORDS[k].up.replace(/\s*\([^)]*\)/g, ''), k, 1), `${k} up: ${BRAIN_WORDS[k].up}`);
      assert.ok(has(BRAIN_WORDS[k].down.replace(/\s*\([^)]*\)/g, ''), k, -1), `${k} down: ${BRAIN_WORDS[k].down}`);
    }
  });

  it('understands the owner\'s examples, however they are spelled', () => {
    const cases: [string, keyof Brain, 1 | -1][] = [
      ["didn't los enough", 'losUse', 1],
      ['Did NOT break line of sight enough', 'losUse', 1],
      ['ran out of mana', 'spendBias', 1],
      ['wasted trinket', 'trinketAt', -1],
      ['died with defensives unused', 'defHp', 1],
      ['died with defensive cooldowns unused', 'defHp', 1],
      ['stood in flamestrike', 'dodge', 1],
      ['kicked too early', 'kickAt', 1],
      ['never kicked', 'kickAt', -1],
      ["didn't heal in time", 'healAt', 1],
      ['the priest healed too late', 'healAt', 1],
    ];
    for (const [t, k, d] of cases) assert.ok(has(t, k, d), `${t} -> ${k} ${d}`);
  });

  it('too passive / too aggressive move several numbers the right way', () => {
    assert.ok(has('too passive', 'burstUse', 1) && has('too passive', 'coverHp', -1));
    assert.ok(has('too aggressive', 'coverHp', 1) && has('too aggressive', 'defHp', 1));
  });

  it('classes: a tag names them for what follows, a class word in the sentence names it, none means every bot class', () => {
    const t = parseNote("mage: didn't los enough. priest, rogue: ran out of mana; the warrior wasted trinket. kicked too early");
    const find = (key: keyof Brain) => t.effects.find((e) => e.key === key)!;
    assert.deepEqual(find('losUse').classes, ['mage']);
    assert.deepEqual(find('spendBias').classes, ['priest', 'rogue']);
    assert.deepEqual(find('trinketAt').classes, ['warrior']);
    assert.deepEqual(find('kickAt').classes, ['priest', 'rogue'], 'a tag holds until the next one; a class word in a sentence names it for that sentence only');
    assert.equal(parseNote("didn't los enough").effects[0].classes, null);
    assert.deepEqual(parseNote('frost: stood in flamestrike').effects[0].classes, ['mage'], 'a spec tag names its class');
    assert.deepEqual(parseNote('the mage bots did not los enough').effects[0].classes, ['mage']);
  });

  it('a bug report is not a brain number; the rest of the sentence still counts', () => {
    const p = parseNote("the bot got stuck doing this and didn't los enough when fighting");
    assert.deepEqual(p.effects.map((e) => e.key), ['losUse']);
    assert.equal(p.bugs.length, 1);
    assert.match(p.bugs[0], /stuck/);
    assert.deepEqual(p.unmapped, []);
    const only = parseNote('it was frozen and just stood there doing nothing');
    assert.equal(only.effects.length, 0);
    assert.ok(only.bugs.length >= 1);
    assert.equal(parseNote('stuck on one target').bugs.length, 0, 'that is a target-loyalty phrase, not a bug');
    assert.ok(has('stuck on one target', 'stickiness', -1));
  });

  it('what cannot be placed is handed back to be rephrased', () => {
    const p = parseNote('wasted trinket. the purple flamingo danced strangely');
    assert.deepEqual(p.effects.map((e) => e.key), ['trinketAt']);
    assert.deepEqual(p.unmapped, ['purple flamingo danced strangely']);
    assert.deepEqual(parseNote('xyzzy plugh').unmapped, ['xyzzy plugh']);
    assert.deepEqual(parseNote('').effects, []);
  });

  it('asking for opposite things about one number does nothing and says so', () => {
    const p = parseNote('kicked too early. never kicked');
    assert.equal(p.effects.filter((e) => e.key === 'kickAt').length, 0);
    assert.equal(p.conflicts.length, 1);
  });

  it('the same wish said twice counts once', () => {
    assert.equal(parseNote("didn't los enough. should los more").effects.filter((e) => e.key === 'losUse').length, 1);
  });
});

describe('notes for the bots: messages and words', () => {
  it('a bot_note is checked on the way in and cut to the longest note', () => {
    const id = 'abcdef012345';
    assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'bot_note', id, text: '  ran out of mana ' })), { t: 'bot_note', id, text: 'ran out of mana' });
    assert.equal((parseClientMsg(JSON.stringify({ t: 'bot_note', id, text: 'x'.repeat(5000) })) as any).text.length, BOT_NOTE_MAX);
    assert.equal(parseClientMsg(JSON.stringify({ t: 'bot_note', id, text: '   ' })), null);
    assert.equal(parseClientMsg(JSON.stringify({ t: 'bot_note', id: '../x', text: 'hi' })), null);
    assert.equal(parseClientMsg(JSON.stringify({ t: 'bot_note', id, text: 4 })), null);
    assert.equal(parseClientMsg(JSON.stringify({ t: 'admin_act', act: 'bug_fixed' })), null, 'a bug id is needed');
    assert.ok(parseClientMsg(JSON.stringify({ t: 'admin_act', act: 'bug_fixed', id })));
  });

  it('the testing marker: top three differences in words, the rest counted, nothing for the shipped brain', () => {
    const shipped = brainFor('mage');
    assert.equal(describeVariant('mage', 'g0v0', shipped, { games: 0, wins: 0 }), null);
    const b = { ...shipped, defHp: shipped.defHp + 0.02, losUse: shipped.losUse + 0.2, strafe: shipped.strafe - 0.4, kickAt: shipped.kickAt + 0.1, dodge: shipped.dodge + 0.05 };
    const t = describeVariant('mage', 'lesson', b, { games: 12, wins: 7.04 })!;
    assert.equal(t.label, 'lesson');
    assert.equal(t.tries.length, 3);
    assert.equal(t.more, 2);
    assert.equal(t.games, 12);
    assert.equal(t.wins, 7);
    assert.equal(t.tries[0].key, 'strafe', 'the biggest share of its range first');
    assert.match(tryText('defHp', 0.65, 0.62), /^hold defensive cooldowns until they are lower \(62% instead of 65%\)$/);
    assert.equal(describeVariant('mage', 'g3v481', b, { games: 0, wins: 0 })!.label, 'variant g3v481');
  });

  it('a note report says what it did, what it could not place and what it reported', () => {
    const note: NoteInfo = {
      id: 'a', matchId: 'abc', at: 1, by: 'Dee', role: 'dev', text: "didn't los enough, got stuck, purple flamingo", classes: ['mage'],
      asked: [{ classId: 'mage', key: 'losUse', dir: 1, said: "didn't los enough", moved: true }], unmapped: ['purple flamingo'], bugs: ['got stuck'], conflicts: [], weight: NOTE_WEIGHT,
    };
    const text = noteLines(note).join('\n');
    assert.match(text, /Note from Dee \(dev\) after the match/);
    assert.match(text, /Could not place: "purple flamingo"/);
    assert.match(text, /bug list/);
    const r = formatReport({ id: 'r', replayId: 'abc', at: 1, source: 'note', passes: 1, replaysRead: 1, skipped: 0, bots: [], classes: [], habits: 0, totals: [], nothing: null, headline: 'Your note moved: mage bots now break line of sight more.', note });
    assert.equal(r[0], 'Your note moved: mage bots now break line of sight more.');
    assert.ok(r.some((l) => /Note from Dee/.test(l)));
    assert.ok(!r.some((l) => /lesson" variant/.test(l)), 'the replay explainer is not repeated for a note');
  });
});
