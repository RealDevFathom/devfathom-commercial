import { describe, expect, it } from 'vitest';
import {
  closeBlockingReasons,
  dayLockStatus,
  drawerStateLabel,
  hasCashVariance,
  isQuietDay,
  paymentSummary,
  paymentTypeLabel,
} from './day-close-status';

const open = { status: 'OPEN', expectedMinor: 1000, countedMinor: null };
const closed = { status: 'CLOSED', expectedMinor: 500, countedMinor: 500 };

describe('day-close status wording', () => {
  it('words the day lock and the drawer state so they cannot read as a contradiction', () => {
    expect(dayLockStatus(false)).toEqual({ label: 'Day not locked yet', tone: 'neutral' });
    expect(dayLockStatus(true)).toEqual({ label: 'Day locked', tone: 'success' });
    expect(drawerStateLabel('OPEN')).toBe('Drawer still open: count its cash below');
    expect(drawerStateLabel('CLOSED')).toBe('Drawer already counted and closed at the counter');
    for (const label of [dayLockStatus(false).label, drawerStateLabel('CLOSED')])
      expect(label).not.toMatch(/^(Open|Closed)( day)?$/);
  });
});

describe('closeBlockingReasons', () => {
  it('names every uncounted drawer, a missing variance note and the unticked confirmation', () => {
    expect(
      closeBlockingReasons({
        drawers: [open, closed, open],
        countFor: () => null,
        note: '',
        confirmed: false,
      })
    ).toEqual([
      'Drawers 1, 3 are still open: enter the counted cash for each.',
      'Tick the box confirming you have counted every drawer.',
    ]);
    expect(
      closeBlockingReasons({ drawers: [open], countFor: () => null, note: '', confirmed: true })
    ).toEqual(['Drawer 1 is still open: enter its counted cash.']);
  });

  it('asks for a variance note only once a count differs, and clears when all is done', () => {
    const short = (i: number) => (i === 0 ? 900 : null);
    expect(
      closeBlockingReasons({ drawers: [open], countFor: short, note: '  ', confirmed: true })
    ).toEqual(['Counted cash differs from expected cash: write a variance note.']);
    expect(
      closeBlockingReasons({ drawers: [open], countFor: short, note: 'Short', confirmed: true })
    ).toEqual([]);
    expect(
      closeBlockingReasons({ drawers: [open], countFor: () => 1000, note: '', confirmed: true })
    ).toEqual([]);
  });

  it('lets an empty day be locked once confirmed', () => {
    expect(
      closeBlockingReasons({ drawers: [], countFor: () => null, note: '', confirmed: true })
    ).toEqual([]);
  });
});

describe('hasCashVariance', () => {
  it('ignores an uncounted drawer and reads a closed drawer without a count as zero', () => {
    expect(hasCashVariance([open], () => null)).toBe(false);
    expect(hasCashVariance([open], () => 999)).toBe(true);
    expect(hasCashVariance([{ ...closed, countedMinor: null }], () => null)).toBe(true);
    expect(hasCashVariance([closed], () => null)).toBe(false);
  });
});

describe('payment summary', () => {
  it('always reports cash, card, credit and returns, with zero for a missing type', () => {
    expect(
      paymentSummary([{ type: 'CARD', amountMinor: 2500, refundMinor: 0, netMinor: 2500 }], 300)
    ).toEqual([
      { label: 'Cash received', amountMinor: 0 },
      { label: 'Card received', amountMinor: 2500 },
      { label: 'Credit (khata) given', amountMinor: 0 },
      { label: 'Returns refunded', amountMinor: 300 },
    ]);
  });

  it('labels payment types in plain words and keeps an unknown type readable', () => {
    expect(paymentTypeLabel('BANK_TRANSFER')).toBe('Bank transfer');
    expect(paymentTypeLabel('CREDIT')).toBe('Credit (khata)');
    expect(paymentTypeLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  it('treats a day with no sales, refunds or cash movement as quiet', () => {
    const zero = { grossSalesMinor: 0, refundTotalMinor: 0, cashExpectedMinor: 0 };
    expect(isQuietDay({ ...zero, tenderTotals: [] })).toBe(true);
    expect(isQuietDay({ ...zero, cashExpectedMinor: 5000, tenderTotals: [] })).toBe(false);
    expect(
      isQuietDay({
        ...zero,
        tenderTotals: [{ type: 'CASH', amountMinor: 1, refundMinor: 0, netMinor: 1 }],
      })
    ).toBe(false);
  });
});
