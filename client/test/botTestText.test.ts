import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BotTest } from '@arena/shared';
import { botTestSummary, botTestTip, testRecord } from '../src/botTestText';
import { botTests } from '../src/botTestState';
import { ackLines } from '../src/botNoteUi';

const test = (over: Partial<BotTest> = {}): BotTest => ({
  unit: 7, classId: 'rogue', label: 'lesson', more: 0, games: 0, wins: 0,
  tries: [{ key: 'defHp', text: 'use defensive cooldowns later (62% instead of 65%)', watch: 'Evasion, Vanish, Desperate Prayer, Enraged Regeneration going off' }],
  ...over,
});

describe('learning-test marker text', () => {
  it('says what the bot is trying and what to look for, in one sentence', () => {
    assert.equal(
      botTestSummary(test()),
      'Learning test: this bot is trying: use defensive cooldowns later (62% instead of 65%) · look for: Evasion, Vanish, Desperate Prayer, Enraged Regeneration going off (lesson, no games against people yet)',
    );
  });

  it('lists up to three tries, counts the rest and gives the record', () => {
    const t = test({
      label: 'variant g2v481', games: 12, wins: 7.4, more: 2,
      tries: [
        { key: 'losUse', text: 'break line of sight more (80% instead of 60%)', watch: 'bots ducking behind cover' },
        { key: 'kickAt', text: 'interrupt later in your cast (55% instead of 45%)', watch: 'Kick timing' },
        { key: 'strafe', text: 'stand still more (60% instead of 80%)', watch: 'weaving' },
      ],
    });
    const s = botTestSummary(t);
    assert.match(s, /break line of sight more \(80% instead of 60%\) · interrupt later in your cast \(55% instead of 45%\) · stand still more \(60% instead of 80%\) · and 2 smaller changes/);
    assert.match(s, /\(variant g2v481, won 7 of 12 games against people so far\)$/);
    assert.equal(testRecord({ games: 1, wins: 1 }), 'won 1 of 1 game against people so far');
    assert.equal(testRecord({ games: 0, wins: 0 }), 'no games against people yet');
  });

  it('the tooltip names it a learning test, lists the tries and tells that only owner and devs see it', () => {
    const tip = botTestTip(test({ more: 1 }));
    assert.equal(tip.title, 'Learning test');
    assert.equal(tip.tag, 'lesson');
    assert.deepEqual(tip.lines, ['• use defensive cooldowns later (62% instead of 65%)', '• and 1 smaller change']);
    assert.match(tip.notes![0], /^Look for: Evasion/);
    assert.match(tip.footer!, /Only you \(owner and devs\) can see this/);
  });

  it('the state answers per unit and forgets everything on clear', () => {
    botTests.handle({ t: 'bot_tests', match: 'abcdef012345', bots: 2, units: [test({ unit: 7 })] });
    assert.equal(botTests.get(7)?.label, 'lesson');
    assert.equal(botTests.get(8), undefined);
    assert.equal(botTests.bots, 2);
    assert.notEqual(botTests.key(7), '');
    assert.equal(botTests.key(8), '');
    botTests.clear();
    assert.equal(botTests.get(7), undefined);
    assert.equal(botTests.match, '');
  });
});

describe('note box answers', () => {
  it('shows what the note moved, what could not be placed and that a bug was listed', () => {
    const lines = ackLines({ t: 'bot_note_ack', id: 'abcdef012345', ok: true, text: 'Your note moved: mage bots now break line of sight more.', lines: ['Your note moved: mage bots now break line of sight more.', 'more detail'], unmapped: ['purple flamingo'], bug: true });
    assert.equal(lines[0], 'Your note moved: mage bots now break line of sight more.');
    assert.match(lines[1], /Could not place: "purple flamingo"/);
    assert.match(lines[2], /Bot bugs reported/);
    assert.deepEqual(ackLines({ t: 'bot_note_ack', id: 'abcdef012345', ok: false, text: 'There were no bots in that match.' }), ['There were no bots in that match.']);
  });
});
