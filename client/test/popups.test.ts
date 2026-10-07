import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { registerPopup, closeTopPopup, closeAllPopups, anyPopupOpen } = await import('../src/popups');

describe('pop-up manager', () => {
  it('Escape closes the newest open window first, and a match start closes them all', () => {
    const made = (name: string, pos: number) => {
      const p = { open: false, name, pos };
      registerPopup({ isOpen: () => p.open, close: () => (p.open = false), el: () => ({ compareDocumentPosition: (o: any) => (o.pos > pos ? 4 : 2) }) as any });
      return p;
    };
    (globalThis as any).Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
    const friends = made('friends', 1);
    const suggest = made('suggest', 2);
    const live = made('live', 3);
    assert.equal(closeTopPopup(), false, 'nothing open');
    friends.open = true;
    suggest.open = true;
    assert.equal(closeTopPopup(), true);
    assert.equal(suggest.open, false, 'the one drawn on top went first');
    assert.equal(friends.open, true);
    live.open = true;
    closeAllPopups();
    assert.equal(anyPopupOpen(), false);
  });
});
