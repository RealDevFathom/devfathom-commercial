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
  receiptDebitNoteLines,
  receiptLineQuantities,
  receiptLineUnitCostMinor,
  type SaleableEvidence,
} from './receiving';

const AT = new Date('2026-09-02T09:00:00.000Z');
const LICENCE = {
  expiresAt: new Date('2027-01-01T00:00:00.000Z'),
  verified: true,
  superseded: false,
};
const CHECKS_ON = { checksEnabled: true, version: 0 };
const CHECKS_OFF = { checksEnabled: false, version: 2 };

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
    supplierCompliance: CHECKS_ON,
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
              licences: [
                {
                  expiresAt: new Date('2026-09-01T00:00:00.000Z'),
                  verified: true,
                  superseded: false,
                },
              ],
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

  it('refuses a superseded licence filing as no licence (DEV-466)', () => {
    expect(
      reasonOf(() =>
        assertSaleableOnReceipt(
          completeEvidence({
            supplier: { authorized: true, licences: [{ ...LICENCE, superseded: true }] },
          })
        )
      )
    ).toBe('SUPPLIER_LICENCE_EXPIRED');
  });

  describe('DEV-753 with the owner policy OFF', () => {
    it('posts an unauthorized, unlicensed supplier without refusing on those two facts', () => {
      expect(() =>
        assertSaleableOnReceipt(
          completeEvidence({
            supplier: { authorized: false, licences: [] },
            supplierCompliance: CHECKS_OFF,
          })
        )
      ).not.toThrow();
    });

    it('still refuses a supplier the tenant cannot see', () => {
      expect(
        reasonOf(() =>
          assertSaleableOnReceipt(
            completeEvidence({ supplier: null, supplierCompliance: CHECKS_OFF })
          )
        )
      ).toBe('SUPPLIER_NOT_AUTHORIZED');
    });

    // The switch is bounded to supplier licence and trade authorization: every other
    // field PUR-02 names stays mandatory.
    it.each([
      ['batch number', { batchNumber: '   ' }, 'MISSING_BATCH'],
      ['printed expiry', { printedExpiry: null }, 'MISSING_EXPIRY'],
      ['supplier invoice', { supplierInvoiceRef: '' }, 'MISSING_INVOICE_EVIDENCE'],
      ['warranty evidence', { warrantyEvidenceRef: '' }, 'MISSING_WARRANTY_EVIDENCE'],
      ['pack conversion', { canonicalUnitsPerPack: 0 }, 'MISSING_PACK_CONVERSION'],
      ['printed MRP', { printedMrpMinor: 0 }, 'MISSING_MRP'],
    ] as const)('still refuses stock with no %s', (_field, missing, reason) => {
      expect(
        reasonOf(() =>
          assertSaleableOnReceipt(
            completeEvidence({
              ...missing,
              supplier: { authorized: false, licences: [] },
              supplierCompliance: CHECKS_OFF,
            })
          )
        )
      ).toBe(reason);
    });
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

describe('DEV-690 — bonus-scheme check at goods-in', () => {
  // A 10+2 scheme on 10 packs of 10: 100 paid units and 20 free ones.
  const ORDERED = {
    canonicalUnitsPerPack: 10,
    orderedCanonicalUnits: 100,
    bonusCanonicalUnits: 20,
    listPricePerPackMinor: 10_000,
    previouslyReceivedUnits: 0,
    previouslyReceivedBonusUnits: 0,
    schemeValidUntil: new Date('2026-11-30T23:59:59Z'),
  };
  const RECEIVED = {
    canonicalUnitsPerPack: 10,
    arrivedCanonicalUnits: 120,
    rejectedCanonicalUnits: 0,
    rejectionReason: null,
    invoicedPricePerPackMinor: 10_000,
    bonusCanonicalUnits: 20,
    receivedAt: new Date('2026-11-15T10:00:00Z'),
  };

  it('raises nothing when every free unit arrives inside the scheme window', () => {
    expect(matchReceiptLine({ ordered: ORDERED, received: RECEIVED })).toEqual([]);
  });

  it('flags missing free units even when paid extras make the total quantity match', () => {
    const exceptions = matchReceiptLine({
      ordered: ORDERED,
      received: { ...RECEIVED, bonusCanonicalUnits: 0 },
    });
    expect(exceptions).toEqual([
      expect.objectContaining({ kind: 'BONUS_SHORTAGE', expectedUnits: 20, observedUnits: 0 }),
    ]);
  });

  it('accumulates free units across deliveries', () => {
    expect(
      matchReceiptLine({
        ordered: { ...ORDERED, previouslyReceivedUnits: 60, previouslyReceivedBonusUnits: 10 },
        received: { ...RECEIVED, arrivedCanonicalUnits: 60, bonusCanonicalUnits: 10 },
      })
    ).toEqual([]);
    expect(
      matchReceiptLine({
        ordered: { ...ORDERED, previouslyReceivedUnits: 60, previouslyReceivedBonusUnits: 5 },
        received: { ...RECEIVED, arrivedCanonicalUnits: 60, bonusCanonicalUnits: 10 },
      }).map((exception) => [exception.kind, exception.observedUnits])
    ).toEqual([['BONUS_SHORTAGE', 15]]);
  });

  it('flags a scheme that had lapsed before the goods arrived', () => {
    const [exception, ...rest] = matchReceiptLine({
      ordered: { ...ORDERED, schemeValidUntil: new Date('2026-11-01T00:00:00Z') },
      received: RECEIVED,
    });
    expect(rest).toEqual([]);
    expect(exception?.kind).toBe('SCHEME_EXPIRED');
    expect(exception?.detail).toContain('2026-11-01');
  });

  it('checks nothing on a line with no scheme', () => {
    expect(
      matchReceiptLine({
        ordered: {
          ...ORDERED,
          orderedCanonicalUnits: 120,
          bonusCanonicalUnits: 0,
          schemeValidUntil: new Date('2026-01-01T00:00:00Z'),
        },
        received: { ...RECEIVED, bonusCanonicalUnits: 0 },
      })
    ).toEqual([]);
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

describe('DEV-691 — GRN, purchase order and distributor bill three-way match', () => {
  // 10 packs of 10 ordered at 1,000 with 120 days' minimum shelf life.
  const ORDERED = {
    canonicalUnitsPerPack: 10,
    orderedCanonicalUnits: 100,
    bonusCanonicalUnits: 0,
    listPricePerPackMinor: 1_000,
    previouslyReceivedUnits: 0,
    minimumExpiryDays: 120,
  };
  const RECEIVED = {
    canonicalUnitsPerPack: 10,
    arrivedCanonicalUnits: 100,
    rejectedCanonicalUnits: 0,
    rejectionReason: null,
    invoicedPricePerPackMinor: 1_000,
    receivedAt: new Date('2026-11-15T10:00:00Z'),
    receivedPacks: 10,
    batchNumber: 'AB-12',
    printedExpiry: new Date('2027-06-01T00:00:00Z'),
    billed: {
      paidPacks: 10,
      batchNumber: 'ab -12',
      printedExpiry: new Date('2027-06-30T00:00:00Z'),
    },
  };
  const LINE = {
    receivedPacks: 10,
    billedPacks: 10,
    invoicedPricePerPackMinor: 1_000,
    discountBps: 0,
    taxBps: 0,
  };

  it('raises nothing when goods, order and bill agree (batch case, spacing and day ignored)', () => {
    expect(matchReceiptLine({ ordered: ORDERED, received: RECEIVED })).toEqual([]);
  });

  it('treats a bill that was not captured as nothing to compare', () => {
    expect(
      matchReceiptLine({
        ordered: ORDERED,
        received: {
          ...RECEIVED,
          billed: { paidPacks: null, batchNumber: null, printedExpiry: null },
        },
      })
    ).toEqual([]);
    expect(matchReceiptLine({ ordered: ORDERED, received: { ...RECEIVED, billed: null } })).toEqual(
      []
    );
  });

  it('flags packs billed but not delivered', () => {
    const exceptions = matchReceiptLine({
      ordered: { ...ORDERED, orderedCanonicalUnits: 80 },
      received: {
        ...RECEIVED,
        arrivedCanonicalUnits: 80,
        receivedPacks: 8,
        billed: { ...RECEIVED.billed, paidPacks: 10 },
      },
    });
    expect(exceptions).toEqual([
      expect.objectContaining({ kind: 'BILLED_SHORTAGE', expectedUnits: 100, observedUnits: 80 }),
    ]);
  });

  it('flags a batch that differs from the bill', () => {
    expect(
      matchReceiptLine({
        ordered: ORDERED,
        received: { ...RECEIVED, batchNumber: 'XY-99' },
      }).map((exception) => exception.kind)
    ).toEqual(['BATCH_CONFLICT']);
  });

  it('flags an expiry that differs from the bill or is shorter than the order accepts', () => {
    const [billMismatch] = matchReceiptLine({
      ordered: ORDERED,
      received: { ...RECEIVED, printedExpiry: new Date('2027-05-01T00:00:00Z') },
    });
    expect(billMismatch?.kind).toBe('EXPIRY_CONFLICT');
    expect(billMismatch?.detail).toContain('2027-06');

    const shortDated = matchReceiptLine({
      ordered: ORDERED,
      received: {
        ...RECEIVED,
        printedExpiry: new Date('2027-01-31T00:00:00Z'),
        billed: { ...RECEIVED.billed, printedExpiry: new Date('2027-01-01T00:00:00Z') },
      },
    });
    expect(shortDated.map((exception) => exception.kind)).toEqual(['EXPIRY_CONFLICT']);
    expect(shortDated[0]?.detail).toContain('120 days');
  });

  it('drafts a full claim for packs billed but not delivered, with discount and tax', () => {
    const exceptions = matchReceiptLine({
      ordered: ORDERED,
      received: {
        ...RECEIVED,
        arrivedCanonicalUnits: 80,
        receivedPacks: 8,
      },
    });
    const lines = receiptDebitNoteLines({
      exceptions,
      line: { ...LINE, receivedPacks: 8, discountBps: 1_000, taxBps: 1_800 },
    });
    // 2 packs x 1,000 = 2,000, less 10% = 1,800, plus 18% tax = 2,124.
    expect(lines).toEqual([
      expect.objectContaining({
        reason: 'BILLED_SHORTAGE',
        sourceKind: 'BILLED_SHORTAGE',
        packs: 2,
        pricePerPackMinor: 1_000,
        amountMinor: 2_124,
      }),
    ]);
  });

  it('drafts a full claim for the wrong batch and does not also claim its overcharge', () => {
    const exceptions = matchReceiptLine({
      ordered: ORDERED,
      received: { ...RECEIVED, batchNumber: 'XY-99', invoicedPricePerPackMinor: 1_200 },
    });
    expect(exceptions.map((exception) => exception.kind)).toEqual([
      'PRICE_CONFLICT',
      'BATCH_CONFLICT',
    ]);
    const lines = receiptDebitNoteLines({
      exceptions,
      line: { ...LINE, invoicedPricePerPackMinor: 1_200 },
    });
    expect(lines).toEqual([
      expect.objectContaining({ reason: 'WRONG_ITEM', packs: 10, amountMinor: 12_000 }),
    ]);
  });

  it('drafts only the difference for an overcharge, and nothing for an undercharge', () => {
    const over = matchReceiptLine({
      ordered: ORDERED,
      received: { ...RECEIVED, invoicedPricePerPackMinor: 1_150 },
    });
    expect(
      receiptDebitNoteLines({
        exceptions: over,
        line: { ...LINE, invoicedPricePerPackMinor: 1_150 },
      })
    ).toEqual([
      expect.objectContaining({
        reason: 'PRICE_OVERCHARGE',
        packs: 10,
        pricePerPackMinor: 150,
        amountMinor: 1_500,
      }),
    ]);
    const under = matchReceiptLine({
      ordered: ORDERED,
      received: { ...RECEIVED, invoicedPricePerPackMinor: 900 },
    });
    expect(
      receiptDebitNoteLines({
        exceptions: under,
        line: { ...LINE, invoicedPricePerPackMinor: 900 },
      })
    ).toEqual([]);
  });

  it('judges a MONTH expiry by the end of its printed month (review)', () => {
    // Received 15 Nov 2026 with 120 days required: the floor is 15 Mar 2027.
    const march = { ...RECEIVED, printedExpiry: new Date('2027-03-01T00:00:00Z'), billed: null };
    expect(
      matchReceiptLine({ ordered: ORDERED, received: { ...march, expiryPrecision: 'MONTH' } })
    ).toEqual([]);
    expect(
      matchReceiptLine({
        ordered: ORDERED,
        received: { ...march, expiryPrecision: 'DAY' },
      }).map((exception) => exception.kind)
    ).toEqual(['EXPIRY_CONFLICT']);
  });

  it('never claims more packs than the bill charged for (review)', () => {
    const exceptions = matchReceiptLine({
      ordered: ORDERED,
      received: {
        ...RECEIVED,
        batchNumber: 'XY-99',
        billed: { ...RECEIVED.billed, paidPacks: 8 },
      },
    });
    expect(receiptDebitNoteLines({ exceptions, line: { ...LINE, billedPacks: 8 } })).toEqual([
      expect.objectContaining({ reason: 'WRONG_ITEM', packs: 8, amountMinor: 8_000 }),
    ]);
    expect(receiptDebitNoteLines({ exceptions, line: { ...LINE, billedPacks: 0 } })).toEqual([]);

    const over = matchReceiptLine({
      ordered: ORDERED,
      received: { ...RECEIVED, invoicedPricePerPackMinor: 1_150 },
    });
    expect(
      receiptDebitNoteLines({
        exceptions: over,
        line: { ...LINE, billedPacks: 6, invoicedPricePerPackMinor: 1_150 },
      })
    ).toEqual([
      expect.objectContaining({ reason: 'PRICE_OVERCHARGE', packs: 6, amountMinor: 900 }),
    ]);
  });

  it('claims nothing for damage, which leaves through a purchase return', () => {
    const exceptions = matchReceiptLine({
      ordered: ORDERED,
      received: { ...RECEIVED, rejectedCanonicalUnits: 20, rejectionReason: 'Crushed' },
    });
    expect(exceptions.map((exception) => exception.kind)).toEqual(['DAMAGE']);
    expect(receiptDebitNoteLines({ exceptions, line: LINE })).toEqual([]);
  });
});
