import { describe, expect, it } from 'vitest';

import {
  trelloImportWithinLimits,
  trelloRawLimit,
  trelloRecordLimit,
} from './trello-import-limits';

describe('Trello import limits', () => {
  it.each([
    ['lists', 10000],
    ['cards', 10000],
    ['labels', 500],
    ['members', 1000],
    ['checklists', 3000],
    ['checkItems', 500],
    ['idMembers', 500],
    ['attachments', 100],
    ['customFields', 250],
    ['customFieldItems', 100],
    ['options', 250],
    ['actions', 10000],
    ['otherFields', 10000],
  ])('allows %s at the collection limit and refuses the next entry', (key, limit) => {
    const input = (length: number) => ({ [key]: Array.from({ length }, () => null) });
    expect(trelloImportWithinLimits(input(limit))).toBe(true);
    expect(trelloImportWithinLimits(input(limit + 1))).toBe(false);
  });

  it.each([
    ['id', 256],
    ['idCard', 256],
    ['idList', 256],
    ['idAttachment', 256],
    ['idCustomField', 256],
    ['idValue', 256],
    ['idMembers', 256],
    ['projectId', 256],
    ['name', 512],
    ['newProjectName', 512],
    ['fullName', 512],
    ['username', 256],
    ['url', 4096],
    ['color', 64],
    ['type', 128],
    ['state', 32],
    ['date', 128],
    ['due', 128],
    ['desc', 32768],
    ['text', 32768],
  ])('allows %s at the text limit and refuses the next character', (key, limit) => {
    const input = (length: number) => ({ [key]: 'x'.repeat(length) });
    expect(trelloImportWithinLimits(input(limit))).toBe(true);
    expect(trelloImportWithinLimits(input(limit + 1))).toBe(false);
  });

  it('bounds nested custom values and covers fields the Trello schema can strip', () => {
    const input = (length: number) => ({
      cards: [{ customFieldItems: [{ value: { text: 'x'.repeat(length) } }] }],
    });
    expect(trelloImportWithinLimits(input(4096))).toBe(true);
    expect(trelloImportWithinLimits(input(4097))).toBe(false);
  });

  it('bounds both mapping keys and values, and caps object entries', () => {
    const input = (length: number) => ({
      memberMapping: Object.fromEntries(
        Array.from({ length }, (_, index) => [String(index).padStart(256, 'a'), 'b'.repeat(256)])
      ),
    });
    expect(trelloImportWithinLimits(input(1000))).toBe(true);
    expect(trelloImportWithinLimits(input(1001))).toBe(false);
    expect(trelloImportWithinLimits({ memberMapping: { ['a'.repeat(257)]: 'b' } })).toBe(false);
    expect(trelloImportWithinLimits({ memberMapping: { a: 'b'.repeat(257) } })).toBe(false);
  });

  it('bounds depth in ignored extension data', () => {
    const input = (depth: number) =>
      Array.from({ length: depth }).reduce<unknown>((nested) => ({ nested }), null);
    expect(trelloImportWithinLimits(input(16))).toBe(true);
    expect(trelloImportWithinLimits(input(17))).toBe(false);
  });

  it('charges an overall budget even when each local limit is respected', () => {
    const parts = Array.from({ length: 200 }, (_, i) =>
      Array.from({ length: i === 199 ? 9798 : 10000 }, () => null)
    );
    expect(trelloImportWithinLimits({ parts })).toBe(true);
    parts[199].push(null);
    expect(trelloImportWithinLimits({ parts })).toBe(false);
  });
});

describe('imported Trello record and card name limits', () => {
  const list = { id: 'list' };
  const card = { id: 'card', idList: list.id };
  const checkItem = { name: 'Review', state: 'incomplete' };
  const comment = { type: 'commentCard', data: { card: { id: card.id } } };

  it('allows the maximum card name and reports the exceeded length', () => {
    const input = (length: number) => ({ trelloJson: { cards: [{ name: 'x'.repeat(length) }] } });
    expect(trelloRawLimit(input(16384))).toBeNull();
    expect(trelloRawLimit(input(16385))).toContain('16,384-character card name');
  });

  it.each([
    ['lists', Array.from({ length: 500 }, (_, id) => ({ id: String(id) })), list, '500 lists'],
    [
      'cards',
      Array.from({ length: 5000 }, (_, id) => ({ ...card, id: String(id) })),
      card,
      '5,000 cards',
    ],
    [
      'checklists',
      Array.from({ length: 100 }, () => ({
        idCard: card.id,
        checkItems: Array(500).fill(checkItem),
      })),
      { idCard: card.id, checkItems: [checkItem] },
      '50,000 checklist items',
    ],
    ['actions', Array(100000).fill(comment), comment, '100,000 comments'],
  ])(
    'allows %s at the record limit and names the maximum when exceeded',
    (key, values, extra, message) => {
      const board = { lists: [list], cards: [card], [key]: values };
      expect(trelloRecordLimit(board, false)).toBeNull();
      expect(trelloRecordLimit({ ...board, [key]: [...values, extra] }, false)).toContain(message);
    }
  );

  it('counts records only for cards placed by the import', () => {
    const comments = Array(100001).fill({
      type: 'commentCard',
      data: { card: { id: 'archived' } },
    });
    const board = {
      lists: [list],
      cards: [card, { id: 'archived', closed: true }],
      actions: comments,
    };
    expect(trelloRecordLimit(board, false)).toBeNull();
    expect(trelloRecordLimit(board, true)).toContain('100,000 comments');
    expect(trelloRecordLimit({ ...board, cards: [card] }, true)).toBeNull();
  });
});
