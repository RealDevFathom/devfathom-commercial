/**
 * DEV-752: one purchase-order line may arrive as several lots on a single
 * receipt. These tests drive the real `postGoodsReceipt` against a mocked
 * tenant-scoped client and assert which receiving exceptions it writes: the
 * quantity leg (SHORTAGE / OVERAGE) is cumulative across a line's lots and
 * judged once, on its last lot; every per-lot check still fires on its own lot.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const receiveLot = vi.hoisted(() => vi.fn());
const appendControlledPurchaseEntries = vi.hoisted(() => vi.fn());

vi.mock('./stock-ledger', async () => {
  const actual = await vi.importActual<typeof import('./stock-ledger')>('./stock-ledger');
  return { ...actual, receiveLot };
});
vi.mock('./controlled-register', () => ({ appendControlledPurchaseEntries }));

const finance = vi.hoisted(() => ({
  postGoodsReceiptEntry: vi.fn(),
  reversePostingForSource: vi.fn(),
}));
vi.mock('./finance-postings', async () => ({
  ...(await vi.importActual<typeof import('./finance-postings')>('./finance-postings')),
  ...finance,
}));

import { postGoodsReceipt } from './goods-receipt';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const AT = new Date('2026-10-21T00:00:00.000Z');
const SCOPE = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'user_a' };
const LIST_PRICE = 1_000;

type OrderLine = {
  id: string;
  canonicalUnitsPerPack: number;
  orderedCanonicalUnits: number;
  bonusCanonicalUnits: number;
  listPricePerPackMinor: number;
};

type LotInput = {
  id: string;
  lineNumber: number;
  purchaseOrderLineId: string | null;
  received: number;
  bonus?: number;
  rejected?: number;
  unitsPerPack?: number;
  invoicedPricePerPackMinor?: number;
};

type PriorReceiptLine = {
  goodsReceiptId: string;
  status: 'DRAFT' | 'POSTED' | 'REVERSED';
  purchaseOrderLineId: string;
  receivedCanonicalUnits: number;
  bonusCanonicalUnits: number;
};

/** An order line of `packs` packs of 10 canonical units at the list price. */
function orderLine(id: string, packs: number, bonusUnits = 0): OrderLine {
  return {
    id,
    canonicalUnitsPerPack: 10,
    orderedCanonicalUnits: packs * 10,
    bonusCanonicalUnits: bonusUnits,
    listPricePerPackMinor: LIST_PRICE,
  };
}

function receiptLine(lot: LotInput) {
  const rejected = lot.rejected ?? 0;
  return {
    id: lot.id,
    lineNumber: lot.lineNumber,
    purchaseOrderLineId: lot.purchaseOrderLineId,
    ocrFieldEvidence: null,
    ocrRegulatedConfirmedAt: null,
    ocrRegulatedConfirmedById: null,
    medicineId: 'med_synthetic',
    batchNumber: `BATCH-${lot.id}`,
    printedExpiry: new Date('2028-12-31T00:00:00.000Z'),
    expiryPrecision: 'DAY' as const,
    canonicalUnitsPerPack: lot.unitsPerPack ?? 10,
    printedMrpMinor: 1_500,
    packLevelId: 'pack_synthetic',
    stockLocationId: 'loc_shelf',
    quarantineLocationId: rejected > 0 ? 'loc_quarantine' : null,
    unitCostMinor: 100,
    receivedCanonicalUnits: lot.received,
    bonusCanonicalUnits: lot.bonus ?? 0,
    acceptedCanonicalUnits: lot.received + (lot.bonus ?? 0) - rejected,
    rejectedCanonicalUnits: rejected,
    rejectionReason: rejected > 0 ? 'Crushed carton' : null,
    invoicedPricePerPackMinor: lot.invoicedPricePerPackMinor ?? LIST_PRICE,
    gs1Warnings: [] as string[],
  };
}

function receiptDb(input: {
  lots: LotInput[];
  orderLines?: OrderLine[];
  priorReceiptLines?: PriorReceiptLine[];
  direct?: boolean;
}) {
  const purchaseOrderId = input.direct ? null : 'po_synthetic';
  const orderLines = input.orderLines ?? [];
  const prior = input.priorReceiptLines ?? [];
  let exceptionSeq = 0;

  const receipt = {
    id: 'gr_current',
    organizationId: SCOPE.organizationId,
    branchId: SCOPE.branchId,
    status: 'DRAFT',
    supplierId: 'supplier_a',
    supplierInvoiceRef: 'INV-SYN-1',
    warrantyEvidenceRef: 'WAR-SYN-1',
    purchaseOrderId,
    qualifiedPersonUserId: null,
    receivedAt: AT,
    supplier: {
      name: 'Synthetic Supplier',
      authorized: true,
      licences: [
        {
          expiresAt: new Date('2030-01-01T00:00:00.000Z'),
          verifiedAt: new Date('2020-01-01T00:00:00.000Z'),
        },
      ],
    },
    lines: input.lots.map(receiptLine).sort((a, b) => a.lineNumber - b.lineNumber),
  };

  const db = {
    $queryRaw: vi.fn((query: TemplateStringsArray) => {
      const sql = query.join('');
      if (sql.includes('pharmacy_purchase_orders')) {
        return Promise.resolve(
          purchaseOrderId
            ? [
                {
                  id: purchaseOrderId,
                  branchId: SCOPE.branchId,
                  supplierId: 'supplier_a',
                  status: 'RECEIVING',
                },
              ]
            : []
        );
      }
      return Promise.resolve([{ id: receipt.id }]);
    }),
    medicine: { findMany: vi.fn().mockResolvedValue([]) },
    // DEV-753/DEV-466: the posting gate reads supersession across the licence register.
    pharmacySupplierLicence: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyGoodsReceipt: {
      findFirst: vi.fn().mockResolvedValue(receipt),
      update: vi.fn().mockResolvedValue({}),
    },
    pharmacyManufacturingBatch: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: 'batch_synthetic',
        expiresAt: new Date('2028-12-31T19:00:00.000Z'),
      }),
    },
    pharmacyPurchaseOrderLine: {
      findFirst: vi.fn(({ where }: { where: { id: string; organizationId: string } }) =>
        Promise.resolve(
          where.organizationId === SCOPE.organizationId
            ? (orderLines.find((line) => line.id === where.id) ?? null)
            : null
        )
      ),
    },
    pharmacyGoodsReceiptLine: {
      update: vi.fn().mockResolvedValue({}),
      // Honour the filter the real query sends, so a prior line only counts
      // when it is on another receipt that is POSTED for the same order line.
      findMany: vi.fn(
        ({
          where,
        }: {
          where: {
            organizationId: string;
            purchaseOrderLineId: string;
            goodsReceiptId: { not: string };
            goodsReceipt: { status: string };
          };
        }) =>
          Promise.resolve(
            prior
              .filter(
                (line) =>
                  where.organizationId === SCOPE.organizationId &&
                  line.purchaseOrderLineId === where.purchaseOrderLineId &&
                  line.goodsReceiptId !== where.goodsReceiptId.not &&
                  line.status === where.goodsReceipt.status
              )
              .map((line) => ({
                receivedCanonicalUnits: line.receivedCanonicalUnits,
                bonusCanonicalUnits: line.bonusCanonicalUnits,
              }))
          )
      ),
    },
    pharmacyReceivingException: {
      create: vi.fn(() => Promise.resolve({ id: `ex_${++exceptionSeq}` })),
    },
    pharmacyPurchaseOrder: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };

  return { db: db as unknown as ScopedDb, mocks: db };
}

type CreatedException = {
  goodsReceiptId: string;
  goodsReceiptLineId: string;
  purchaseOrderLineId: string | null;
  kind: string;
  expectedUnits: number | null;
  observedUnits: number | null;
  expectedMinor: number | null;
  observedMinor: number | null;
};

function created(mocks: ReturnType<typeof receiptDb>['mocks']): CreatedException[] {
  return mocks.pharmacyReceivingException.create.mock.calls.map(
    (call) => (call as unknown as [{ data: CreatedException }])[0].data
  );
}

function quantityExceptions(mocks: ReturnType<typeof receiptDb>['mocks']) {
  return created(mocks).filter((ex) => ex.kind === 'SHORTAGE' || ex.kind === 'OVERAGE');
}

async function post(db: ScopedDb) {
  return postGoodsReceipt(db, SCOPE, { goodsReceiptId: 'gr_current', at: AT });
}

beforeEach(() => {
  appendControlledPurchaseEntries.mockReset();
  let seq = 0;
  receiveLot.mockReset().mockImplementation(() => {
    seq += 1;
    return Promise.resolve({
      lot: { id: `lot_${seq}` },
      movement: { id: `move_${seq}` },
      quarantineMovement: null,
    });
  });
});

describe('postGoodsReceipt — received time of the posted lot (DEV-726)', () => {
  it('never makes a lot received later than its posting instant', async () => {
    const { db } = receiptDb({
      orderLines: [orderLine('pol_a', 10)],
      lots: [{ id: 'grl_1', lineNumber: 1, purchaseOrderLineId: 'pol_a', received: 100 }],
    });
    // Keyed for 21 October (stored as UTC midnight) and posted at 01:30 PKT that day,
    // which is still 20:30 UTC on the 20th.
    const postedAt = new Date('2026-10-20T20:30:00.000Z');

    await postGoodsReceipt(db, SCOPE, { goodsReceiptId: 'gr_current', at: postedAt });

    expect(receiveLot).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ receivedAt: postedAt })
    );
  });

  it('keeps an earlier received date as keyed', async () => {
    const { db } = receiptDb({
      orderLines: [orderLine('pol_a', 10)],
      lots: [{ id: 'grl_1', lineNumber: 1, purchaseOrderLineId: 'pol_a', received: 100 }],
    });

    await postGoodsReceipt(db, SCOPE, {
      goodsReceiptId: 'gr_current',
      at: new Date('2026-10-22T09:00:00.000Z'),
    });

    expect(receiveLot).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ receivedAt: AT })
    );
  });
});

describe('postGoodsReceipt — several lots of one order line (DEV-752)', () => {
  it('raises no quantity exception when 6 + 4 packs fill a 10-pack line', async () => {
    const { db, mocks } = receiptDb({
      orderLines: [orderLine('pol_a', 10)],
      lots: [
        { id: 'grl_1', lineNumber: 1, purchaseOrderLineId: 'pol_a', received: 60 },
        { id: 'grl_2', lineNumber: 2, purchaseOrderLineId: 'pol_a', received: 40 },
      ],
    });

    const result = await post(db);

    expect(result.lines.map((line) => line.goodsReceiptLineId)).toEqual(['grl_1', 'grl_2']);
    expect(receiveLot).toHaveBeenCalledTimes(2);
    expect(mocks.pharmacyReceivingException.create).not.toHaveBeenCalled();
    expect(result.exceptions).toEqual([]);
  });

  it('reports one SHORTAGE for 3 + 4 packs of a 10-pack line, on the last lot', async () => {
    const { db, mocks } = receiptDb({
      orderLines: [orderLine('pol_a', 10)],
      lots: [
        { id: 'grl_1', lineNumber: 1, purchaseOrderLineId: 'pol_a', received: 30 },
        { id: 'grl_2', lineNumber: 2, purchaseOrderLineId: 'pol_a', received: 40 },
      ],
    });

    const result = await post(db);

    expect(created(mocks)).toEqual([
      expect.objectContaining({
        goodsReceiptId: 'gr_current',
        goodsReceiptLineId: 'grl_2',
        purchaseOrderLineId: 'pol_a',
        kind: 'SHORTAGE',
        expectedUnits: 100,
        observedUnits: 70,
      }),
    ]);
    expect(result.exceptions).toEqual([
      { id: 'ex_1', kind: 'SHORTAGE', detail: expect.stringContaining('short by 30') },
    ]);
  });

  it('reports one OVERAGE for 10 + 10 packs of a 10-pack line, on the last lot', async () => {
    const { db, mocks } = receiptDb({
      orderLines: [orderLine('pol_a', 10)],
      lots: [
        { id: 'grl_1', lineNumber: 1, purchaseOrderLineId: 'pol_a', received: 100 },
        { id: 'grl_2', lineNumber: 2, purchaseOrderLineId: 'pol_a', received: 100 },
      ],
    });

    await post(db);

    expect(created(mocks)).toEqual([
      expect.objectContaining({
        goodsReceiptLineId: 'grl_2',
        kind: 'OVERAGE',
        expectedUnits: 100,
        observedUnits: 200,
      }),
    ]);
  });

  it('defers an OVERAGE the first lot already reached alone to the last lot', async () => {
    // 12 + 10 packs: the first lot is over on its own. Pins the OVERAGE half of
    // the last-lot filter, which 10 + 10 cannot (its first lot is exactly full).
    const { db, mocks } = receiptDb({
      orderLines: [orderLine('pol_a', 10)],
      lots: [
        { id: 'grl_1', lineNumber: 1, purchaseOrderLineId: 'pol_a', received: 120 },
        { id: 'grl_2', lineNumber: 2, purchaseOrderLineId: 'pol_a', received: 100 },
      ],
    });

    await post(db);

    expect(created(mocks)).toEqual([
      expect.objectContaining({
        goodsReceiptLineId: 'grl_2',
        kind: 'OVERAGE',
        expectedUnits: 100,
        observedUnits: 220,
      }),
    ]);
  });

  it('counts bonus units toward the cumulative quantity across lots', async () => {
    const { db, mocks } = receiptDb({
      orderLines: [orderLine('pol_a', 10, 10)],
      lots: [
        { id: 'grl_1', lineNumber: 1, purchaseOrderLineId: 'pol_a', received: 60, bonus: 10 },
        { id: 'grl_2', lineNumber: 2, purchaseOrderLineId: 'pol_a', received: 40 },
      ],
    });

    await post(db);

    expect(mocks.pharmacyReceivingException.create).not.toHaveBeenCalled();
  });

  describe('with an earlier posted receipt of 50 units on the order line', () => {
    const priorReceiptLines: PriorReceiptLine[] = [
      {
        goodsReceiptId: 'gr_earlier',
        status: 'POSTED',
        purchaseOrderLineId: 'pol_a',
        receivedCanonicalUnits: 50,
        bonusCanonicalUnits: 0,
      },
    ];

    it('raises nothing when lots of 3 + 2 packs close the line at 100', async () => {
      const { db, mocks } = receiptDb({
        orderLines: [orderLine('pol_a', 10)],
        priorReceiptLines,
        lots: [
          { id: 'grl_1', lineNumber: 1, purchaseOrderLineId: 'pol_a', received: 30 },
          { id: 'grl_2', lineNumber: 2, purchaseOrderLineId: 'pol_a', received: 20 },
        ],
      });

      await post(db);

      expect(mocks.pharmacyGoodsReceiptLine.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: SCOPE.organizationId,
          purchaseOrderLineId: 'pol_a',
          goodsReceiptId: { not: 'gr_current' },
          goodsReceipt: { status: 'POSTED' },
        },
        select: { receivedCanonicalUnits: true, bonusCanonicalUnits: true },
      });
      expect(mocks.pharmacyReceivingException.create).not.toHaveBeenCalled();
    });

    it('raises one OVERAGE of 110 on the last lot for lots of 3 + 3 packs', async () => {
      const { db, mocks } = receiptDb({
        orderLines: [orderLine('pol_a', 10)],
        priorReceiptLines,
        lots: [
          { id: 'grl_1', lineNumber: 1, purchaseOrderLineId: 'pol_a', received: 30 },
          { id: 'grl_2', lineNumber: 2, purchaseOrderLineId: 'pol_a', received: 30 },
        ],
      });

      await post(db);

      expect(created(mocks)).toEqual([
        expect.objectContaining({
          goodsReceiptLineId: 'grl_2',
          kind: 'OVERAGE',
          expectedUnits: 100,
          observedUnits: 110,
        }),
      ]);
    });

    it('ignores units on a receipt that is not POSTED', async () => {
      const { db, mocks } = receiptDb({
        orderLines: [orderLine('pol_a', 10)],
        priorReceiptLines: [
          ...priorReceiptLines,
          {
            goodsReceiptId: 'gr_reversed',
            status: 'REVERSED',
            purchaseOrderLineId: 'pol_a',
            receivedCanonicalUnits: 40,
            bonusCanonicalUnits: 0,
          },
        ],
        lots: [
          { id: 'grl_1', lineNumber: 1, purchaseOrderLineId: 'pol_a', received: 30 },
          { id: 'grl_2', lineNumber: 2, purchaseOrderLineId: 'pol_a', received: 20 },
        ],
      });

      await post(db);

      expect(mocks.pharmacyReceivingException.create).not.toHaveBeenCalled();
    });
  });

  describe('interleaved lots of two order lines (A lot 1, B lot 1, A lot 2)', () => {
    it('judges each order line once, on its own last lot', async () => {
      const { db, mocks } = receiptDb({
        orderLines: [orderLine('pol_a', 10), orderLine('pol_b', 5)],
        lots: [
          { id: 'grl_a1', lineNumber: 1, purchaseOrderLineId: 'pol_a', received: 60 },
          { id: 'grl_b1', lineNumber: 2, purchaseOrderLineId: 'pol_b', received: 30 },
          { id: 'grl_a2', lineNumber: 3, purchaseOrderLineId: 'pol_a', received: 40 },
        ],
      });

      await post(db);

      expect(quantityExceptions(mocks)).toEqual([
        expect.objectContaining({
          goodsReceiptLineId: 'grl_b1',
          purchaseOrderLineId: 'pol_b',
          kind: 'SHORTAGE',
          expectedUnits: 50,
          observedUnits: 30,
        }),
      ]);
    });

    it('does not let the other order line split one line from its last lot', async () => {
      const { db, mocks } = receiptDb({
        orderLines: [orderLine('pol_a', 10), orderLine('pol_b', 5)],
        lots: [
          { id: 'grl_a1', lineNumber: 1, purchaseOrderLineId: 'pol_a', received: 60 },
          { id: 'grl_b1', lineNumber: 2, purchaseOrderLineId: 'pol_b', received: 50 },
          { id: 'grl_a2', lineNumber: 3, purchaseOrderLineId: 'pol_a', received: 30 },
        ],
      });

      await post(db);

      expect(quantityExceptions(mocks)).toEqual([
        expect.objectContaining({
          goodsReceiptLineId: 'grl_a2',
          purchaseOrderLineId: 'pol_a',
          kind: 'SHORTAGE',
          expectedUnits: 100,
          observedUnits: 90,
        }),
      ]);
    });
  });

  describe('per-lot checks are not deferred to the last lot', () => {
    it('raises PRICE_CONFLICT on the first lot it applies to', async () => {
      const { db, mocks } = receiptDb({
        orderLines: [orderLine('pol_a', 10)],
        lots: [
          {
            id: 'grl_1',
            lineNumber: 1,
            purchaseOrderLineId: 'pol_a',
            received: 60,
            invoicedPricePerPackMinor: 1_200,
          },
          { id: 'grl_2', lineNumber: 2, purchaseOrderLineId: 'pol_a', received: 40 },
        ],
      });

      await post(db);

      expect(created(mocks)).toEqual([
        expect.objectContaining({
          goodsReceiptLineId: 'grl_1',
          kind: 'PRICE_CONFLICT',
          expectedMinor: LIST_PRICE,
          observedMinor: 1_200,
        }),
      ]);
    });

    it('raises PRICE_CONFLICT on the first lot alongside the SHORTAGE on the last', async () => {
      const { db, mocks } = receiptDb({
        orderLines: [orderLine('pol_a', 10)],
        lots: [
          {
            id: 'grl_1',
            lineNumber: 1,
            purchaseOrderLineId: 'pol_a',
            received: 30,
            invoicedPricePerPackMinor: 1_200,
          },
          { id: 'grl_2', lineNumber: 2, purchaseOrderLineId: 'pol_a', received: 40 },
        ],
      });

      await post(db);

      expect(created(mocks).map((ex) => [ex.goodsReceiptLineId, ex.kind])).toEqual([
        ['grl_1', 'PRICE_CONFLICT'],
        ['grl_2', 'SHORTAGE'],
      ]);
    });

    it('raises DAMAGE on the lot with rejected units, and counts them as arrived', async () => {
      const { db, mocks } = receiptDb({
        orderLines: [orderLine('pol_a', 10)],
        lots: [
          { id: 'grl_1', lineNumber: 1, purchaseOrderLineId: 'pol_a', received: 60, rejected: 10 },
          { id: 'grl_2', lineNumber: 2, purchaseOrderLineId: 'pol_a', received: 40 },
        ],
      });

      await post(db);

      expect(created(mocks)).toEqual([
        expect.objectContaining({
          goodsReceiptLineId: 'grl_1',
          kind: 'DAMAGE',
          expectedUnits: 60,
          observedUnits: 10,
        }),
      ]);
      expect(receiveLot).toHaveBeenNthCalledWith(
        1,
        db,
        SCOPE,
        expect.objectContaining({
          quantityUnits: 50,
          quarantine: expect.objectContaining({ units: 10, stockLocationId: 'loc_quarantine' }),
        })
      );
    });

    it('raises PACK_CONFLICT on the first lot when its pack size differs from the order', async () => {
      const { db, mocks } = receiptDb({
        orderLines: [orderLine('pol_a', 10)],
        lots: [
          {
            id: 'grl_1',
            lineNumber: 1,
            purchaseOrderLineId: 'pol_a',
            received: 60,
            unitsPerPack: 20,
          },
          { id: 'grl_2', lineNumber: 2, purchaseOrderLineId: 'pol_a', received: 40 },
        ],
      });

      await post(db);

      expect(created(mocks)).toEqual([
        expect.objectContaining({
          goodsReceiptLineId: 'grl_1',
          kind: 'PACK_CONFLICT',
          expectedUnits: 10,
          observedUnits: 20,
        }),
      ]);
    });
  });

  it('raises no quantity exception on a direct purchase', async () => {
    const { db, mocks } = receiptDb({
      direct: true,
      lots: [
        { id: 'grl_1', lineNumber: 1, purchaseOrderLineId: null, received: 30 },
        { id: 'grl_2', lineNumber: 2, purchaseOrderLineId: null, received: 40, rejected: 5 },
      ],
    });

    const result = await post(db);

    expect(result.lines).toHaveLength(2);
    expect(mocks.pharmacyPurchaseOrderLine.findFirst).not.toHaveBeenCalled();
    expect(mocks.pharmacyGoodsReceiptLine.findMany).not.toHaveBeenCalled();
    expect(mocks.pharmacyPurchaseOrder.updateMany).not.toHaveBeenCalled();
    // The goods check still runs on the direct path; only the order leg is absent.
    expect(created(mocks)).toEqual([
      expect.objectContaining({
        goodsReceiptLineId: 'grl_2',
        purchaseOrderLineId: null,
        kind: 'DAMAGE',
      }),
    ]);
  });
});
