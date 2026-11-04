/**
 * PH-PUR / PUR-02 receiving, PUR-04, PUR-05 — the pure kernel.
 *
 * The two rules that decide whether received goods are safe to sell are total
 * functions, so they can be enumerated rather than sampled: every field PUR-02
 * names gets its own negative case, and the three-way match is exercised on
 * each discrepancy in isolation and in combination.
 */
import { describe, expect, it } from 'vitest';

import {
  assertDirectPurchaseAuthorized,
  assertGoodsReceiptTransition,
  assertSaleableOnReceipt,
  matchReceiptLine,
  PharmacyReceivingError,
  receiptLineQuantities,
  receiptLineUnitCostMinor,
  residualAllocatedChargeMinor,
  type SaleableEvidence,
} from './receiving';

const AT = new Date('2026-09-02T09:00:00.000Z');
const LICENCE = { expiresAt: new Date('2027-01-01T00:00:00.000Z'), verified: true };

/** Everything present: the one shape that is allowed to become saleable stock. */
function completeEvidence(overrides: Partial<SaleableEvidence> = {}): SaleableEvidence {
  return {
    batchNumber: 'B-2291',
    printedExpiry: new Date('2027-06-01T00:00:00.000Z'),
    supplierInvoiceRef: 'INV-8841',
    warrantyEvidenceRef: 'WARRANTY-8841',
    canonicalUnitsPerPack: 10,
    printedMrpMinor: 25_000,
    supplier: { authorized: true, licences: [LICENCE] },
    at: AT,
    ...overrides,
  };
}

function reasonOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof PharmacyReceivingError) return error.reason;
    throw error;
  }
  return 'ACCEPTED — the call was expected to be refused';
}

describe('PUR-02 — stock is not saleable until every named field is present', () => {
  it('accepts a receipt line that names all of them', () => {
    expect(() => assertSaleableOnReceipt(completeEvidence())).not.toThrow();
  });

  // One case per field the PRD names, so a future change that drops any single
  // check fails here rather than shipping unsellable stock as saleable.
  it.each([
    ['batch number', { batchNumber: '   ' }, 'MISSING_BATCH'],
    ['printed expiry', { printedExpiry: null }, 'MISSING_EXPIRY'],
    ['supplier invoice', { supplierInvoiceRef: '' }, 'MISSING_INVOICE_EVIDENCE'],
    ['warranty evidence', { warrantyEvidenceRef: '' }, 'MISSING_WARRANTY_EVIDENCE'],
    ['pack conversion', { canonicalUnitsPerPack: 0 }, 'MISSING_PACK_CONVERSION'],
    ['printed MRP', { printedMrpMinor: 0 }, 'MISSING_MRP'],
    [
      'authorized supplier',
      { supplier: { authorized: false, licences: [LICENCE] } },
      'SUPPLIER_NOT_AUTHORIZED',
    ],
  ] as const)('refuses stock with no %s', (_field, missing, reason) => {
    expect(reasonOf(() => assertSaleableOnReceipt(completeEvidence(missing)))).toBe(reason);
  });

  it('refuses a supplier whose licence has expired by the receipt date', () => {
    expect(
      reasonOf(() =>
        assertSaleableOnReceipt(
          completeEvidence({
            supplier: {
              authorized: true,
              licences: [{ expiresAt: new Date('2026-09-01T00:00:00.000Z'), verified: true }],
            },
          })
        )
      )
    ).toBe('SUPPLIER_LICENCE_EXPIRED');
  });

  it('treats an unverified licence filing as no licence at all', () => {
    expect(
      reasonOf(() =>
        assertSaleableOnReceipt(
          completeEvidence({
            supplier: { authorized: true, licences: [{ ...LICENCE, verified: false }] },
          })
        )
      )
    ).toBe('SUPPLIER_LICENCE_EXPIRED');
  });

  it('refuses a supplier the tenant cannot see rather than reading it as unlicensed', () => {
    expect(reasonOf(() => assertSaleableOnReceipt(completeEvidence({ supplier: null })))).toBe(
      'SUPPLIER_NOT_AUTHORIZED'
    );
  });

  it('is still refused when a second field is also missing', () => {
    // Fixing one omission must not make the receipt postable while another
    // remains: each field is checked independently.
    const twoMissing = completeEvidence({ batchNumber: '', printedMrpMinor: 0 });
    expect(reasonOf(() => assertSaleableOnReceipt(twoMissing))).toBe('MISSING_BATCH');
    expect(reasonOf(() => assertSaleableOnReceipt({ ...twoMissing, batchNumber: 'B-1' }))).toBe(
      'MISSING_MRP'
    );
  });
});

describe('PUR-05 — the direct purchase bypass is evidence or it is nothing', () => {
  it('accepts a named reason and a different approver', () => {
    expect(() =>
      assertDirectPurchaseAuthorized({
        bypassReason: 'Emergency insulin, cash and carry.',
        bypassApprovedByUserId: 'user_manager',
        receivedByUserId: 'user_counter',
      })
    ).not.toThrow();
  });

  it.each([
    ['no reason', { bypassReason: '  ' }],
    ['no approver', { bypassApprovedByUserId: '' }],
  ] as const)('refuses a bypass with %s', (_label, missing) => {
    expect(
      reasonOf(() =>
        assertDirectPurchaseAuthorized({
          bypassReason: 'Emergency insulin.',
          bypassApprovedByUserId: 'user_manager',
          receivedByUserId: 'user_counter',
          ...missing,
        })
      )
    ).toBe('BYPASS_EVIDENCE_MISSING');
  });

  it('refuses a receiver who approves their own bypass', () => {
    expect(
      reasonOf(() =>
        assertDirectPurchaseAuthorized({
          bypassReason: 'Emergency insulin.',
          bypassApprovedByUserId: 'user_counter',
          receivedByUserId: 'user_counter',
        })
      )
    ).toBe('SELF_APPROVAL');
  });
});

describe('PUR-02/PUR-03 — canonical units and landed unit cost', () => {
  it('projects canonical units from packs on both the paid and the free side', () => {
    expect(
      receiptLineQuantities({
        receivedPacks: 10,
        bonusPacks: 2,
        canonicalUnitsPerPack: 10,
        rejectedCanonicalUnits: 0,
      })
    ).toEqual({
      receivedCanonicalUnits: 100,
      bonusCanonicalUnits: 20,
      arrivedCanonicalUnits: 120,
      acceptedCanonicalUnits: 120,
      rejectedCanonicalUnits: 0,
    });
  });

  it('splits arrivals into accepted and rejected without losing a unit', () => {
    const quantities = receiptLineQuantities({
      receivedPacks: 10,
      bonusPacks: 0,
      canonicalUnitsPerPack: 10,
      rejectedCanonicalUnits: 30,
    });
    expect(quantities.acceptedCanonicalUnits + quantities.rejectedCanonicalUnits).toBe(
      quantities.arrivedCanonicalUnits
    );
    expect(quantities.acceptedCanonicalUnits).toBe(70);
  });

  it('refuses to reject more units than arrived', () => {
    expect(
      reasonOf(() =>
        receiptLineQuantities({
          receivedPacks: 1,
          bonusPacks: 0,
          canonicalUnitsPerPack: 10,
          rejectedCanonicalUnits: 11,
        })
      )
    ).toBe('INVALID_QUANTITY');
  });

  it('refuses a delivery of nothing', () => {
    expect(
      reasonOf(() =>
        receiptLineQuantities({
          receivedPacks: 0,
          bonusPacks: 0,
          canonicalUnitsPerPack: 10,
          rejectedCanonicalUnits: 0,
        })
      )
    ).toBe('INVALID_QUANTITY');
  });

  it('lowers the unit cost when a scheme adds free packs, and never the money', () => {
    const paid = receiptLineUnitCostMinor({
      receivedPacks: 10,
      bonusPacks: 0,
      canonicalUnitsPerPack: 10,
      invoicedPricePerPackMinor: 10_000,
    });
    const withBonus = receiptLineUnitCostMinor({
      receivedPacks: 10,
      bonusPacks: 2,
      canonicalUnitsPerPack: 10,
      invoicedPricePerPackMinor: 10_000,
    });
    // 100_000 minor over 100 units, then the same 100_000 over 120 units.
    expect(paid).toBe(1_000);
    expect(withBonus).toBe(833);
    expect(withBonus).toBeLessThan(paid);
  });

  it('excludes a creditable input tax from stock cost and includes a non-creditable one', () => {
    const terms = {
      receivedPacks: 10,
      bonusPacks: 0,
      canonicalUnitsPerPack: 10,
      invoicedPricePerPackMinor: 10_000,
      taxBps: 1_700,
    };
    expect(receiptLineUnitCostMinor({ ...terms, taxCreditable: true })).toBe(1_000);
    expect(receiptLineUnitCostMinor({ ...terms, taxCreditable: false })).toBe(1_170);
  });

  it('includes allocated PO charges and subtracts its rebate from receipt lot cost', () => {
    expect(
      receiptLineUnitCostMinor({
        receivedPacks: 10,
        bonusPacks: 0,
        canonicalUnitsPerPack: 10,
        invoicedPricePerPackMinor: 10_000,
        discountBps: 1_000,
        rebateBps: 500,
        taxBps: 1_000,
        taxCreditable: false,
        allocatedChargeMinor: 5_950,
      })
    ).toBe(1_000);
    // 100,000 - 10,000 discount - 4,500 rebate + 8,550 tax + 5,950 charges.
  });

  it('costs an entirely free delivery at nothing per unit', () => {
    expect(
      receiptLineUnitCostMinor({
        receivedPacks: 0,
        bonusPacks: 5,
        canonicalUnitsPerPack: 10,
        invoicedPricePerPackMinor: 10_000,
      })
    ).toBe(0);
  });
});

describe('residual PO charge allocation', () => {
  const allocate = (input: {
    activeReceivedPacks: number;
    activeAllocatedChargeMinor: number;
    receivedPacks: number;
    orderLineChargeMinor?: number;
    orderedPacks?: number;
  }) =>
    residualAllocatedChargeMinor({
      orderLineChargeMinor: input.orderLineChargeMinor ?? 30_000,
      orderedPacks: input.orderedPacks ?? 10,
      activeReceivedPacks: input.activeReceivedPacks,
      activeAllocatedChargeMinor: input.activeAllocatedChargeMinor,
      receivedPacks: input.receivedPacks,
    });

  it('assigns a rounding residual only once across partial receipts', () => {
    const first = allocate({
      orderLineChargeMinor: 1,
      orderedPacks: 2,
      activeReceivedPacks: 0,
      activeAllocatedChargeMinor: 0,
      receivedPacks: 1,
    });
    const second = allocate({
      orderLineChargeMinor: 1,
      orderedPacks: 2,
      activeReceivedPacks: 1,
      activeAllocatedChargeMinor: first,
      receivedPacks: 1,
    });
    expect(first + second).toBe(1);
  });

  it('recovers the full charge when a replacement follows a released receipt', () => {
    // Two six-pack drafts against ten ordered packs; the first is cancelled.
    const first = allocate({
      activeReceivedPacks: 0,
      activeAllocatedChargeMinor: 0,
      receivedPacks: 6,
    });
    const second = allocate({
      activeReceivedPacks: 6,
      activeAllocatedChargeMinor: first,
      receivedPacks: 6,
    });
    expect([first, second]).toEqual([18_000, 12_000]);
    // Only the second survives; four replacement packs complete the order.
    const replacement = allocate({
      activeReceivedPacks: 6,
      activeAllocatedChargeMinor: second,
      receivedPacks: 4,
    });
    expect(replacement).toBe(18_000);
    expect(second + replacement).toBe(30_000);
  });

  it('never duplicates the charge on over-receipt and uses exact integer arithmetic', () => {
    expect(
      allocate({ activeReceivedPacks: 10, activeAllocatedChargeMinor: 30_000, receivedPacks: 5 })
    ).toBe(0);
    expect(
      allocate({
        orderLineChargeMinor: Number.MAX_SAFE_INTEGER,
        orderedPacks: Number.MAX_SAFE_INTEGER,
        activeReceivedPacks: 0,
        activeAllocatedChargeMinor: 0,
        receivedPacks: Number.MAX_SAFE_INTEGER - 1,
      })
    ).toBe(Number.MAX_SAFE_INTEGER - 1);
  });
});

describe('PUR-04 — the three-way match', () => {
  const ORDERED = {
    canonicalUnitsPerPack: 10,
    orderedCanonicalUnits: 100,
    bonusCanonicalUnits: 20,
    listPricePerPackMinor: 10_000,
    previouslyReceivedUnits: 0,
  };
  const RECEIVED = {
    canonicalUnitsPerPack: 10,
    arrivedCanonicalUnits: 120,
    rejectedCanonicalUnits: 0,
    rejectionReason: null,
    invoicedPricePerPackMinor: 10_000,
  };

  it('raises nothing when order, invoice and goods agree', () => {
    expect(matchReceiptLine({ ordered: ORDERED, received: RECEIVED })).toEqual([]);
  });

  it('raises a shortage when fewer units arrived than were ordered', () => {
    const [exception, ...rest] = matchReceiptLine({
      ordered: ORDERED,
      received: { ...RECEIVED, arrivedCanonicalUnits: 90 },
    });
    expect(rest).toEqual([]);
    expect(exception).toMatchObject({ kind: 'SHORTAGE', expectedUnits: 120, observedUnits: 90 });
  });

  it('raises an overage when more arrived than were ordered', () => {
    expect(
      matchReceiptLine({
        ordered: ORDERED,
        received: { ...RECEIVED, arrivedCanonicalUnits: 150 },
      })[0]
    ).toMatchObject({ kind: 'OVERAGE', expectedUnits: 120, observedUnits: 150 });
  });

  it('accumulates earlier deliveries, so a second one closes the shortage', () => {
    // 90 arrived first, 30 now: the order is complete and nothing is raised.
    expect(
      matchReceiptLine({
        ordered: { ...ORDERED, previouslyReceivedUnits: 90 },
        received: { ...RECEIVED, arrivedCanonicalUnits: 30 },
      })
    ).toEqual([]);
  });

  it('still reports a shortage on a partial delivery that leaves the order open', () => {
    expect(
      matchReceiptLine({
        ordered: { ...ORDERED, previouslyReceivedUnits: 50 },
        received: { ...RECEIVED, arrivedCanonicalUnits: 40 },
      })[0]
    ).toMatchObject({ kind: 'SHORTAGE', expectedUnits: 120, observedUnits: 90 });
  });

  it('raises damage for rejected units and carries the reason into the detail', () => {
    const [exception] = matchReceiptLine({
      ordered: ORDERED,
      received: {
        ...RECEIVED,
        rejectedCanonicalUnits: 20,
        rejectionReason: 'Crushed blister packs',
      },
    });
    expect(exception).toMatchObject({
      kind: 'DAMAGE',
      expectedUnits: 120,
      observedUnits: 20,
    });
    expect(exception!.detail).toContain('Crushed blister packs');
  });

  it('raises a price conflict when the invoice disagrees with the order', () => {
    expect(
      matchReceiptLine({
        ordered: ORDERED,
        received: { ...RECEIVED, invoicedPricePerPackMinor: 11_500 },
      })[0]
    ).toMatchObject({
      kind: 'PRICE_CONFLICT',
      expectedMinor: 10_000,
      observedMinor: 11_500,
    });
  });

  it('raises a pack conflict when the delivered pack size is not the ordered one', () => {
    expect(
      matchReceiptLine({
        ordered: ORDERED,
        received: { ...RECEIVED, canonicalUnitsPerPack: 20 },
      })[0]
    ).toMatchObject({ kind: 'PACK_CONFLICT', expectedUnits: 10, observedUnits: 20 });
  });

  it('reports every discrepancy of a bad delivery at once, in a stable order', () => {
    const kinds = matchReceiptLine({
      ordered: ORDERED,
      received: {
        canonicalUnitsPerPack: 20,
        arrivedCanonicalUnits: 80,
        rejectedCanonicalUnits: 20,
        rejectionReason: 'Cold chain broken',
        invoicedPricePerPackMinor: 12_000,
      },
    }).map((exception) => exception.kind);
    expect(kinds).toEqual(['SHORTAGE', 'DAMAGE', 'PRICE_CONFLICT', 'PACK_CONFLICT']);
  });

  it('reports only damage on the PUR-05 direct path, which has nothing to match', () => {
    // Parity, not a gap: with no ordered line there is no quantity or price to
    // compare against, and the damage rule is unchanged.
    expect(
      matchReceiptLine({
        ordered: null,
        received: { ...RECEIVED, rejectedCanonicalUnits: 5, rejectionReason: 'Torn carton' },
      }).map((exception) => exception.kind)
    ).toEqual(['DAMAGE']);
    expect(matchReceiptLine({ ordered: null, received: RECEIVED })).toEqual([]);
  });
});

describe('PUR-04 — a posted receipt is corrected by reversal, never by an edit', () => {
  it('allows DRAFT to POSTED and POSTED to REVERSED', () => {
    expect(() => assertGoodsReceiptTransition('DRAFT', 'POSTED')).not.toThrow();
    expect(() => assertGoodsReceiptTransition('POSTED', 'REVERSED')).not.toThrow();
    expect(() => assertGoodsReceiptTransition('DRAFT', 'CANCELLED')).not.toThrow();
  });

  it.each([
    ['POSTED', 'DRAFT'],
    ['POSTED', 'CANCELLED'],
    ['REVERSED', 'POSTED'],
    ['CANCELLED', 'POSTED'],
    ['DRAFT', 'REVERSED'],
  ] as const)('refuses %s → %s', (from, to) => {
    expect(reasonOf(() => assertGoodsReceiptTransition(from, to))).toBe('INVALID_TRANSITION');
  });
});
