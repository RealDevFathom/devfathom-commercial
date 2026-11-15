import { describe, expect, it } from 'vitest';
import { checkPharmacyCashClose, type CashCloseFacts } from './cash-close-check';
import { buildPharmacyShiftHandover, type ShiftHandoverFacts } from './shift-handover';

const now = new Date('2026-11-10T18:00:00.000Z');
const closeFacts: CashCloseFacts = {
  businessDate: '2026-11-10',
  currency: 'PKR',
  close: {
    id: 'close-1',
    sequence: 1,
    cashExpectedMinor: 500_000,
    cashCountedMinor: 300_000,
    cashVarianceMinor: -200_000,
    varianceNote: 'Short',
  },
  grossSalesMinor: 1_000_000,
  completedSales: 10,
  drawers: [],
  refunds: [],
  voids: [],
};

function facts(overrides: Partial<ShiftHandoverFacts> = {}): ShiftHandoverFacts {
  return {
    check: checkPharmacyCashClose(closeFacts),
    pendingRx: { count: 2, oldestAt: new Date('2026-11-08T09:00:00.000Z') },
    orders: [
      { status: 'READY_FOR_COLLECTION', reservationExpiresAt: new Date('2026-11-10T12:00:00Z') },
      { status: 'READY_FOR_COLLECTION', reservationExpiresAt: new Date('2026-11-11T12:00:00Z') },
      { status: 'PACKING', reservationExpiresAt: new Date('2026-11-11T12:00:00Z') },
    ],
    restock: { count: 4, reserveOnArrival: 1 },
    now,
    ...overrides,
  };
}

describe('buildPharmacyShiftHandover', () => {
  it('drafts pending Rx, promised items and cash variance from the given figures', () => {
    const note = buildPharmacyShiftHandover(facts());
    expect(note).toMatchObject({
      draft: true,
      readOnly: true,
      closed: true,
      pendingRx: { count: 2, oldestAt: '2026-11-08' },
      promised: {
        openOrders: 3,
        overdueOrders: 1,
        ordersByStatus: { READY_FOR_COLLECTION: 2, PACKING: 1 },
        restockPromises: 4,
        restockReserveOnArrival: 1,
      },
      cash: { expectedMinor: 500_000, countedMinor: 300_000, varianceMinor: -200_000 },
    });
    expect(note.note).toContain('2 emergency supplies still waiting for the prescription');
    expect(note.note).toContain('3 open orders (1 being packed, 2 ready for collection)');
    expect(note.note).toContain('1 past its reservation time');
    expect(note.note).toContain('4 customers to contact when stock arrives (1 to reserve');
    expect(note.note).toContain('short PKR 2000.00');
  });

  it("surfaces the cash-close check's findings as the review items, unchanged", () => {
    const f = facts();
    const note = buildPharmacyShiftHandover(f);
    expect(note.flags).toEqual(f.check.findings);
    expect(note.flags.map((flag) => flag.kind)).toContain('CLOSE_VARIANCE');
    for (const finding of f.check.findings) expect(note.note).toContain(finding.explanation);
    expect(note.policyVersion).toBe(f.check.policyVersion);
  });

  it('says plainly when nothing is outstanding or flagged', () => {
    const check = checkPharmacyCashClose({
      ...closeFacts,
      close: { ...closeFacts.close!, cashCountedMinor: 500_000, cashVarianceMinor: 0 },
    });
    const note = buildPharmacyShiftHandover(
      facts({
        check,
        pendingRx: { count: 0, oldestAt: null },
        orders: [],
        restock: { count: 0, reserveOnArrival: 0 },
      })
    );
    expect(note.note).toContain('Pending Rx: none');
    expect(note.note).toContain('Customer orders: none open.');
    expect(note.note).toContain('Restock promises: none outstanding.');
    expect(note.note).toContain('no variance');
    expect(note.note).toContain('No unusual voids, refunds or variances flagged');
    expect(note.flags).toEqual([]);
  });

  it('waits for the count on a day that is still open', () => {
    const check = checkPharmacyCashClose({
      ...closeFacts,
      close: null,
      drawers: [{ id: 'd1', label: 'one', expectedMinor: 10_000, countedMinor: null }],
    });
    const note = buildPharmacyShiftHandover(facts({ check }));
    expect(note.closed).toBe(false);
    expect(note.cash.varianceMinor).toBeNull();
    expect(note.note).toContain('day still open');
    expect(note.note).toContain('not every drawer has been counted yet');
  });

  it('is labelled a draft that saves and sends nothing', () => {
    expect(buildPharmacyShiftHandover(facts()).note).toContain('nothing has been saved or sent');
  });
});
