import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// #633: the batch re-check has its own PostgreSQL suite (sale-batch-safety.db.test.ts).
const batchSafety = vi.hoisted(() => ({
  assertSaleBatchesSellable: vi.fn(async () => new Map()),
}));
vi.mock('./sale-batch-safety', () => ({
  assertSaleBatchesSellable: batchSafety.assertSaleBatchesSellable,
}));
const postings = vi.hoisted(() => ({ postTenderEntry: vi.fn(), postSaleLineEntry: vi.fn() }));
// Keep settlement, receipt identity, idempotency and evidence logic real.
vi.mock('./finance-postings', async () => ({
  ...(await vi.importActual<typeof import('./finance-postings')>('./finance-postings')),
  postTenderEntry: postings.postTenderEntry,
  postSaleLineEntry: postings.postSaleLineEntry,
}));
// The persisted regulatory gate has its own suite (regulatory.test.ts).
vi.mock('./regulatory', async () => ({
  ...(await vi.importActual<typeof import('./regulatory')>('./regulatory')),
  assertStoredPharmacyMayOperate: vi.fn(async () => undefined),
}));

import { Prisma } from '@/generated/prisma/client';

import {
  applyPharmacyTender,
  assertRefundWithinTender,
  computePharmacyClose,
  DISCARDED_TENDER_COMMAND,
  discardPharmacyTenderAttempt,
  foldExpectedCash,
  openPharmacyDrawer,
  PharmacySettlementError,
  readPharmacyTenderOutcome,
  requireReleaseSafeAdapter,
  saleTotalMinor,
} from './settlement';

describe('pharmacy settlement invariants', () => {
  it('uses exact integer minor units for split coverage', () => {
    expect(
      saleTotalMinor([
        { quantity: 2, unitPriceMinor: 501, discountMinor: 1 },
        { quantity: 1, unitPriceMinor: 99, discountMinor: 0 },
      ])
    ).toBe(1100);
  });

  it('caps cumulative refunds at the original tender', () => {
    expect(() => assertRefundWithinTender(1_000, 600, 401)).toThrowError(
      expect.objectContaining({ reason: 'REFUND_EXCEEDS_TENDER' })
    );
    expect(() => assertRefundWithinTender(1_000, 600, 400)).not.toThrow();
  });

  it('makes a mock adapter impossible in a release build', () => {
    const adapter = { name: 'MOCK', certified: true, execute: vi.fn() };
    expect(() => requireReleaseSafeAdapter(adapter, 'production')).toThrowError(
      expect.objectContaining({ reason: 'MOCK_PROVIDER_IN_RELEASE' })
    );
  });

  it('rejects uncertified providers in every environment', () => {
    const adapter = { name: 'wallet-demo', certified: false, execute: vi.fn() };
    expect(() => requireReleaseSafeAdapter(adapter, 'test')).toThrow(PharmacySettlementError);
  });

  it('reproduces a close from immutable sources regardless of read order', () => {
    const a = computePharmacyClose({
      sales: [
        { id: 'b', totalMinor: 700 },
        { id: 'a', totalMinor: 300 },
      ],
      refunds: [{ id: 'r', amountMinor: 125 }],
      drawers: [{ id: 'd', expectedMinor: 1_500, countedMinor: 1_490 }],
    });
    const b = computePharmacyClose({
      sales: [
        { id: 'a', totalMinor: 300 },
        { id: 'b', totalMinor: 700 },
      ],
      refunds: [{ id: 'r', amountMinor: 125 }],
      drawers: [{ id: 'd', expectedMinor: 1_500, countedMinor: 1_490 }],
    });
    expect(a).toEqual(b);
    expect(a).toMatchObject({ netSalesMinor: 875, cashVarianceMinor: -10 });
  });

  it('folds float, cash sales, refunds, paid-in and paid-out exactly', () => {
    expect(
      foldExpectedCash([
        { kind: 'OPENING_FLOAT', amountMinor: 10_000 },
        { kind: 'CASH_SALE', amountMinor: 2_500 },
        { kind: 'CASH_REFUND', amountMinor: 300 },
        { kind: 'PAID_IN', amountMinor: 200 },
        { kind: 'PAID_OUT', amountMinor: 400 },
      ])
    ).toBe(12_000);
  });

  it('replays one idempotency result without duplicating tender or receipt', async () => {
    let idempotency: Record<string, unknown> | null = null;
    batchSafety.assertSaleBatchesSellable.mockReset().mockResolvedValue(new Map());
    postings.postTenderEntry.mockClear();
    postings.postSaleLineEntry.mockClear();
    const tenderCreatedAt = new Date('2026-09-02T10:00:00Z');
    const tenderCreate = vi.fn().mockResolvedValue({ id: 'tender-1', createdAt: tenderCreatedAt });
    const saleUpdate = vi.fn().mockResolvedValue({});
    const db = {
      pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
      $executeRaw: vi.fn().mockImplementation(async () => {
        idempotency ??= {
          id: 'idem-1',
          commandType: 'tender',
          payloadHash: '',
          resultPayload: null,
        };
        return 1;
      }),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ receipt_number: 41 }]),
      pharmacyMoneyIdempotencyKey: {
        findUnique: vi.fn().mockImplementation(async () => idempotency),
        update: vi.fn().mockImplementation(async ({ data }) => {
          idempotency = { ...idempotency, resultPayload: data.resultPayload };
          return idempotency;
        }),
      },
      pharmacySale: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'sale-1',
          status: 'OPEN',
          lines: [
            {
              id: 'line-1',
              organizationId: 'org-1',
              branchId: 'branch-1',
              medicineId: 'medicine-1',
              presentationId: 'presentation-1',
              quantity: 1,
              canonicalUnits: 1,
              unitPriceMinor: 100,
              discountMinor: 0,
              medicine: { organizationId: 'org-1', productName: 'Issued medicine', strengths: [] },
              presentation: {
                organizationId: 'org-1',
                medicineId: 'medicine-1',
                presentation: 'Tablet',
              },
              allocations: [
                {
                  id: 'allocation-1',
                  organizationId: 'org-1',
                  branchId: 'branch-1',
                  inventoryLotId: 'lot-1',
                  canonicalUnits: 1,
                  lot: {
                    organizationId: 'org-1',
                    branchId: 'branch-1',
                    batch: {
                      organizationId: 'org-1',
                      medicineId: 'medicine-1',
                      batchNumber: 'B1',
                      expiresAt: new Date('2030-01-01'),
                    },
                  },
                },
              ],
            },
          ],
          tenders: [],
        }),
        update: saleUpdate,
      },
      pharmacyTender: {
        create: tenderCreate,
        findFirst: vi.fn().mockResolvedValue({ saleId: 'sale-1' }),
      },
      camera: { findFirst: vi.fn().mockResolvedValue(null) },
      pharmacySaleEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const input = {
      saleId: 'sale-1',
      deviceId: 'device-1',
      businessDate: new Date('2026-09-02T00:00:00.000Z'),
      type: 'BANK_TRANSFER' as const,
      providerRef: 'BANK-001',
      amountMinor: 100,
      idempotencyKey: 'retry-1',
    };

    const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' };
    // These phase checks fail even if an absent tender guard is replaced by an
    // extra completion/replay call: no payment or posting may precede guard 1.
    batchSafety.assertSaleBatchesSellable
      .mockImplementationOnce(async () => {
        expect(tenderCreate).not.toHaveBeenCalled();
        expect(postings.postTenderEntry).not.toHaveBeenCalled();
        expect(saleUpdate).not.toHaveBeenCalled();
        expect(postings.postSaleLineEntry).not.toHaveBeenCalled();
        expect(db.pharmacySaleEvent.create).not.toHaveBeenCalled();
        expect(db.$queryRaw).toHaveBeenCalledTimes(2);
        return new Map();
      })
      .mockImplementationOnce(async () => {
        expect(tenderCreate).toHaveBeenCalledTimes(1);
        expect(postings.postTenderEntry).toHaveBeenCalledTimes(1);
        expect(saleUpdate).not.toHaveBeenCalled();
        expect(postings.postSaleLineEntry).not.toHaveBeenCalled();
        expect(db.pharmacySaleEvent.create).not.toHaveBeenCalled();
        // The two existing reads are the day and sale locks, not a receipt draw.
        expect(db.$queryRaw).toHaveBeenCalledTimes(2);
        return new Map();
      });

    // Capture the canonical hash inserted by the first command in this narrow fake.
    db.$executeRaw.mockImplementationOnce(async (query: { values: unknown[] }) => {
      idempotency = {
        id: 'idem-1',
        commandType: 'tender',
        payloadHash: query.values[5],
        resultPayload: null,
      };
      return 1;
    });
    const first = await applyPharmacyTender(
      db as never,
      {
        organizationId: 'org-1',
        branchId: 'branch-1',
        actorId: 'actor-1',
      },
      input
    );
    // Both exact-scope guards belong to the FIRST fully paid command.
    expect(batchSafety.assertSaleBatchesSellable).toHaveBeenCalledTimes(2);
    expect(batchSafety.assertSaleBatchesSellable).toHaveBeenNthCalledWith(1, db, scope, 'sale-1');
    expect(batchSafety.assertSaleBatchesSellable).toHaveBeenNthCalledWith(2, db, scope, 'sale-1');

    const replay = await applyPharmacyTender(
      db as never,
      {
        organizationId: 'org-1',
        branchId: 'branch-1',
        actorId: 'actor-1',
      },
      input
    );

    expect(first).toMatchObject({ tenderId: 'tender-1', receiptNumber: 41, replayed: false });
    expect(replay).toMatchObject({ tenderId: 'tender-1', receiptNumber: 41, replayed: true });
    expect(tenderCreate).toHaveBeenCalledTimes(1);
    expect(saleUpdate).toHaveBeenCalledTimes(1);
    expect(db.pharmacySaleEvent.create).toHaveBeenCalledTimes(1);
    // Replaying the bound result cannot re-enter either guard or consume a receipt.
    expect(batchSafety.assertSaleBatchesSellable).toHaveBeenCalledTimes(2);
    expect(postings.postTenderEntry).toHaveBeenCalledExactlyOnceWith(db, scope, {
      tenderId: 'tender-1',
      at: tenderCreatedAt,
    });
    expect(postings.postSaleLineEntry).toHaveBeenCalledExactlyOnceWith(db, scope, {
      saleLineId: 'line-1',
      at: expect.any(Date),
    });
    expect(db.pharmacyTender.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'tender-1', organizationId: 'org-1', branchId: 'branch-1' },
      select: { saleId: true },
    });
    expect(db.camera.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: {
        organizationId: 'org-1',
        branchId: 'branch-1',
        enabled: true,
        counterEvidence: true,
        gateway: { status: 'ACTIVE', revokedAt: null },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    expect(db.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it.each(['CARD', 'WALLET'] as const)(
    'rejects a failed tender-time batch guard before %s payment or sale/ledger writes',
    async (type) => {
      const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' };
      const batchRefusal = new Error('batch became unsellable after add-to-cart');
      batchSafety.assertSaleBatchesSellable
        .mockReset()
        .mockResolvedValue(new Map())
        .mockRejectedValueOnce(batchRefusal);
      postings.postTenderEntry.mockClear();
      postings.postSaleLineEntry.mockClear();
      const adapter = {
        name: 'CERTIFIED_TEST_PROVIDER',
        certified: true,
        execute: vi.fn().mockResolvedValue({ approved: true, providerRef: 'provider-1' }),
      };
      const input = {
        saleId: 'sale-1',
        deviceId: 'device-1',
        businessDate: new Date('2026-09-02T00:00:00.000Z'),
        type,
        amountMinor: 100,
        idempotencyKey: 'refused-batch-1',
        adapter,
      };
      const db = {
        $executeRaw: vi.fn().mockResolvedValue(1),
        $queryRaw: vi.fn().mockResolvedValue([]),
        pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
        pharmacyMoneyIdempotencyKey: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'idem-refused',
            commandType: 'tender',
            payloadHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
            resultPayload: null,
          }),
          update: vi.fn(),
        },
        pharmacySale: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'sale-1',
            status: 'OPEN',
            lines: [
              {
                id: 'line-1',
                quantity: 1,
                unitPriceMinor: 100,
                discountMinor: 0,
                medicine: { organizationId: 'org-1', productName: 'Issued medicine', strengths: [] },
              },
            ],
            tenders: [],
          }),
          update: vi.fn(),
        },
        pharmacyTender: {
          create: vi.fn().mockResolvedValue({
            id: 'forbidden-tender',
            createdAt: new Date('2026-09-02T10:00:00Z'),
          }),
        },
        pharmacySaleEvent: { create: vi.fn() },
        pharmacyDrawerMovement: { create: vi.fn() },
        camera: { findFirst: vi.fn() },
      };

      // This exact rejection also detects a missing await on the tender guard.
      // Removing ONLY settlement's guard reaches the provider and tender before
      // completion sees the same refusal, so the no-side-effect checks fail.
      await expect(applyPharmacyTender(db as never, scope, input)).rejects.toBe(batchRefusal);
      expect(batchSafety.assertSaleBatchesSellable).toHaveBeenCalledExactlyOnceWith(
        db,
        scope,
        'sale-1'
      );
      expect(db.pharmacySale.findFirst).toHaveBeenCalledWith({
        where: { id: 'sale-1', organizationId: 'org-1', branchId: 'branch-1' },
        include: expect.any(Object),
      });
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(db.pharmacyTender.create).not.toHaveBeenCalled();
      expect(postings.postTenderEntry).not.toHaveBeenCalled();
      expect(postings.postSaleLineEntry).not.toHaveBeenCalled();
      expect(db.pharmacySale.update).not.toHaveBeenCalled();
      expect(db.pharmacySaleEvent.create).not.toHaveBeenCalled();
      expect(db.pharmacyDrawerMovement.create).not.toHaveBeenCalled();
      expect(db.pharmacyMoneyIdempotencyKey.update).not.toHaveBeenCalled();
      expect(db.camera.findFirst).not.toHaveBeenCalled();
      // No receipt-sequence query: just the original day and scoped-sale locks.
      expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    }
  );
});

describe('readPharmacyTenderOutcome', () => {
  const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' };
  const original = {
    branchId: 'branch-1',
    saleId: 'sale-1',
    deviceId: 'device-1',
    businessDate: new Date('2026-09-12T14:15:16.123Z'),
    type: 'CASH' as const,
    amountMinor: 100,
    cashReceivedMinor: 150,
    idempotencyKey: 'attempt-1',
  };
  const partial = {
    tenderId: 'tender-1',
    settled: false,
    receiptNumber: null,
    remainingMinor: 200,
  };
  const full = { tenderId: 'tender-1', settled: true, receiptNumber: 41, remainingMinor: 0 };
  let unexpected: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    unexpected = vi.fn(() => {
      throw new Error('Unexpected database operation');
    });
  });
  afterEach(() => expect(unexpected).not.toHaveBeenCalled());

  function fixture(input: Parameters<typeof readPharmacyTenderOutcome>[2] = original) {
    const sale = { id: 'sale-1', organizationId: 'org-1', branchId: 'branch-1' };
    const prior = {
      organizationId: 'org-1',
      deviceId: 'device-1',
      key: 'attempt-1',
      commandType: 'tender',
      payloadHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      resultPayload: partial,
    };
    const cash = input.type === 'CASH' ? (input.cashReceivedMinor ?? input.amountMinor) : null;
    const tender = {
      id: 'tender-1',
      organizationId: 'org-1',
      branchId: 'branch-1',
      saleId: 'sale-1',
      deviceId: 'device-1',
      type: input.type,
      amountMinor: input.amountMinor,
      businessDate: new Date('2026-09-12T00:00:00.000Z'),
      cashReceivedMinor: cash,
      changeGivenMinor: cash === null ? null : cash - input.amountMinor,
    };
    const saleRead = vi.fn().mockResolvedValue(sale);
    const keyRead = vi.fn().mockResolvedValue(prior);
    const tenderRead = vi.fn().mockResolvedValue(tender);
    // Any additional model operation, raw SQL, or transaction is observable even if caught.
    const only = (entries: Record<string, unknown>) =>
      new Proxy(entries, { get: (target, key) => target[String(key)] ?? unexpected });
    const db = only({
      pharmacySale: only({ findFirst: saleRead }),
      pharmacyMoneyIdempotencyKey: only({ findUnique: keyRead }),
      pharmacyTender: only({ findFirst: tenderRead }),
    });
    return { db, input, sale, prior, tender, saleRead, keyRead, tenderRead };
  }

  it('#710 recovers the exact manual tender and rejects altered capture evidence', async () => {
    const f = fixture({ ...original, type: 'RAAST', cashReceivedMinor: undefined,
      providerRef: '001234', payerName: 'Ayesha' });
    const recorded = { ...f.tender, provider: 'MANUAL_MERCHANT', providerRef: '001234', payerName: 'Ayesha', referenceSkipped: false };
    f.tenderRead.mockResolvedValue(recorded);
    expect(await readPharmacyTenderOutcome(f.db as never, scope, f.input)).toMatchObject({ status: 'ACCEPTED' });
    for (const change of [{ providerRef: '1234' }, { payerName: 'Other payer' }, { referenceSkipped: true }]) {
      f.tenderRead.mockResolvedValue({ ...recorded, ...change });
      expect(await readPharmacyTenderOutcome(f.db as never, scope, f.input)).toEqual({ status: 'UNKNOWN', replayUnsafe: true });
    }
  });

  it.each([partial, full])('returns the stored operation result: %j', async (result) => {
    const f = fixture();
    f.keyRead.mockResolvedValue({ ...f.prior, resultPayload: result });
    // The sale may have completed or changed since this attempt; never use its aggregates.
    f.saleRead.mockResolvedValue({
      ...f.sale,
      status: 'COMPLETED',
      receiptNumber: 99,
      tenders: [],
    });
    expect(await readPharmacyTenderOutcome(f.db as never, scope, f.input)).toEqual({
      status: 'ACCEPTED',
      replayUnsafe: true,
      result,
    });
    expect(f.saleRead).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'sale-1', organizationId: 'org-1', branchId: 'branch-1' },
      select: { id: true, organizationId: true, branchId: true },
    });
    expect(f.keyRead.mock.calls[0][0].where).toEqual({
      organizationId_deviceId_key: {
        organizationId: 'org-1',
        deviceId: 'device-1',
        key: 'attempt-1',
      },
    });
    expect(f.tenderRead.mock.calls[0][0].where).toEqual({
      id: 'tender-1',
      organizationId: 'org-1',
      branchId: 'branch-1',
      saleId: 'sale-1',
    });
    expect(f.saleRead.mock.invocationCallOrder[0]).toBeLessThan(
      f.keyRead.mock.invocationCallOrder[0]
    );
  });

  it.each([
    { ...original, cashReceivedMinor: undefined },
    { ...original, type: 'BANK_TRANSFER' as const },
    { ...original, type: 'CREDIT' as const, cashReceivedMinor: undefined },
    { ...original, type: 'CARD' as const },
    { ...original, type: 'WALLET' as const },
  ])('matches persisted cash semantics for $type / $cashReceivedMinor', async (input) => {
    const f = fixture(input);
    expect(await readPharmacyTenderOutcome(f.db as never, scope, input)).toEqual({
      status: 'ACCEPTED',
      replayUnsafe: true,
      result: partial,
    });
  });

  it.each([
    null,
    { id: 'foreign-sale', organizationId: 'org-1', branchId: 'branch-1' },
    { id: 'sale-1', organizationId: 'foreign-org', branchId: 'branch-1' },
    { id: 'sale-1', organizationId: 'org-1', branchId: 'foreign-branch' },
  ])('does not look up a key for an unavailable or foreign sale: %j', async (sale) => {
    const f = fixture();
    f.saleRead.mockResolvedValue(sale);
    expect(await readPharmacyTenderOutcome(f.db as never, scope, f.input)).toEqual({
      status: 'UNKNOWN',
      replayUnsafe: true,
    });
    expect(f.keyRead).not.toHaveBeenCalled();
    expect(f.tenderRead).not.toHaveBeenCalled();
  });

  it.each(['organizationId', 'branchId'] as const)('binds the authorized %s', async (field) => {
    const f = fixture();
    expect(
      await readPharmacyTenderOutcome(f.db as never, { ...scope, [field]: 'foreign' }, f.input)
    ).toEqual({ status: 'UNKNOWN', replayUnsafe: true });
    expect(f.keyRead).not.toHaveBeenCalled();
  });

  it.each(['organizationId', 'deviceId', 'key', 'commandType', 'payloadHash'] as const)(
    'never accepts a mismatched key record %s',
    async (field) => {
      const f = fixture();
      f.prior[field] = 'mismatch';
      expect(await readPharmacyTenderOutcome(f.db as never, scope, f.input)).toEqual({
        status: 'UNKNOWN',
        replayUnsafe: true,
      });
      expect(f.tenderRead).not.toHaveBeenCalled();
    }
  );

  it.each([
    { deviceId: 'other-device' },
    { idempotencyKey: 'other-key' },
    { type: 'CREDIT' as const },
    { amountMinor: 101 },
    { cashReceivedMinor: 151 },
    { cashReceivedMinor: undefined },
    { businessDate: new Date('2026-09-12T14:15:16.124Z') },
    { businessDate: new Date('2026-09-13T00:00:00.000Z') },
  ])('never accepts a changed original envelope: %j', async (change) => {
    const f = fixture();
    expect(
      await readPharmacyTenderOutcome(f.db as never, scope, { ...f.input, ...change })
    ).toEqual({ status: 'UNKNOWN', replayUnsafe: true });
    expect(f.tenderRead).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    {},
    [],
    '',
    0,
    false,
    { ...partial, tenderId: '' },
    { ...partial, tenderId: 1 },
    { ...partial, settled: 'false' },
    { ...partial, receiptNumber: 41 },
    { ...partial, remainingMinor: 0 },
    { ...partial, remainingMinor: -1 },
    { ...partial, remainingMinor: 0.5 },
    { ...partial, remainingMinor: Number.MAX_SAFE_INTEGER + 1 },
    { ...partial, remainingMinor: null },
    { ...full, receiptNumber: null },
    { ...full, receiptNumber: 0 },
    { ...full, receiptNumber: 1.5 },
    { ...full, remainingMinor: 1 },
    { ...partial, providerRef: 'sensitive-unexpected-field' },
  ])('keeps empty or malformed stored results unknown: %j', async (resultPayload) => {
    const f = fixture();
    f.keyRead.mockResolvedValue({ ...f.prior, resultPayload });
    expect(await readPharmacyTenderOutcome(f.db as never, scope, f.input)).toEqual({
      status: 'UNKNOWN',
      replayUnsafe: true,
    });
    expect(f.tenderRead).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { id: 'other' },
    { organizationId: 'other' },
    { branchId: 'other' },
    { saleId: 'other' },
    { deviceId: 'other' },
    { type: 'CREDIT' },
    { amountMinor: 99 },
    { cashReceivedMinor: 149 },
    { changeGivenMinor: 49 },
    { businessDate: new Date('2026-09-13T00:00:00.000Z') },
    { businessDate: new Date('invalid') },
  ])('requires a matching immutable tender: %j', async (change) => {
    const f = fixture();
    f.tenderRead.mockResolvedValue(change === null ? null : { ...f.tender, ...change });
    expect(await readPharmacyTenderOutcome(f.db as never, scope, f.input)).toEqual({
      status: 'UNKNOWN',
      replayUnsafe: true,
    });
  });

  it.each(['saleRead', 'keyRead', 'tenderRead'] as const)(
    'contains %s failures without exposure',
    async (stage) => {
      const f = fixture();
      f[stage].mockRejectedValue(new Error('sensitive database details'));
      expect(await readPharmacyTenderOutcome(f.db as never, scope, f.input)).toEqual({
        status: 'UNKNOWN',
        replayUnsafe: true,
      });
    }
  );

  it.each([{}, { deviceId: 'unknown-device' }, { idempotencyKey: 'unknown-key' }])(
    'reports absent keys without replay permission: %j',
    async (change) => {
      const f = fixture();
      f.keyRead.mockResolvedValue(null);
      expect(
        await readPharmacyTenderOutcome(f.db as never, scope, { ...f.input, ...change })
      ).toEqual({ status: 'NOT_FOUND', replayUnsafe: true });
      expect(f.tenderRead).not.toHaveBeenCalled();
    }
  );

  it('keeps an invisible attempt unsafe while a concurrent lookup observes its commit', async () => {
    const f = fixture();
    let finishInvisibleRead!: (value: null) => void;
    f.keyRead.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishInvisibleRead = resolve;
        })
    );
    const invisible = readPharmacyTenderOutcome(f.db as never, scope, f.input);
    await Promise.resolve();
    const committed = await readPharmacyTenderOutcome(f.db as never, scope, f.input);
    finishInvisibleRead(null);
    expect(await invisible).toEqual({ status: 'NOT_FOUND', replayUnsafe: true });
    expect(committed).toEqual({ status: 'ACCEPTED', replayUnsafe: true, result: partial });
    expect(f.tenderRead).toHaveBeenCalledTimes(1);
  });
});

describe('openPharmacyDrawer — one open drawer per counter device', () => {
  const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' };
  const input = {
    deviceId: 'counter-device',
    businessDate: new Date('2026-10-20T00:00:00.000Z'),
    openingFloatMinor: 0,
  };
  function fixture(existingOpen: { id: string } | null, createError?: unknown) {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
      pharmacyDrawerSession: {
        findFirst: vi.fn().mockResolvedValue(existingOpen),
        create: createError
          ? vi.fn().mockRejectedValue(createError)
          : vi.fn().mockResolvedValue({ id: 'drawer-new', status: 'OPEN' }),
      },
      pharmacyDrawerMovement: { create: vi.fn().mockResolvedValue({}) },
    };
    return db;
  }

  it('opens a drawer when the device has none open', async () => {
    const db = fixture(null);
    await expect(openPharmacyDrawer(db as never, scope, input)).resolves.toMatchObject({
      id: 'drawer-new',
    });
    expect(db.pharmacyDrawerSession.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        branchId: 'branch-1',
        deviceId: 'counter-device',
        status: 'OPEN',
      },
      select: { id: true },
    });
  });

  it('refuses a second open on the same device with the typed OPEN_DRAWER reason', async () => {
    const db = fixture({ id: 'drawer-open' });
    await expect(openPharmacyDrawer(db as never, scope, input)).rejects.toThrowError(
      expect.objectContaining({ reason: 'OPEN_DRAWER' })
    );
    expect(db.pharmacyDrawerSession.create).not.toHaveBeenCalled();
  });

  it('translates the partial-unique race (P2002) into the same typed reason', async () => {
    const race = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: 'pharmacy_one_open_drawer_per_device' },
    });
    const db = fixture(null, race);
    await expect(openPharmacyDrawer(db as never, scope, input)).rejects.toThrowError(
      expect.objectContaining({ reason: 'OPEN_DRAWER' })
    );
  });

  it('lets every other database failure through unchanged', async () => {
    const failure = new Error('connection reset');
    const db = fixture(null, failure);
    await expect(openPharmacyDrawer(db as never, scope, input)).rejects.toBe(failure);
  });
});

describe('DEV-712 discardPharmacyTenderAttempt', () => {
  const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'cashier-1' };
  const attempt = {
    branchId: 'branch-1',
    saleId: 'sale-1',
    deviceId: 'device-1',
    businessDate: new Date('2026-11-03T00:00:00.000Z'),
    type: 'BANK_TRANSFER' as const,
    amountMinor: 1_250,
    idempotencyKey: 'counter-tender:sale-1:BANK_TRANSFER:1250',
  };
  const record = {
    reason: 'Customer did not pay',
    approvedByUserId: 'manager-1',
    approvalPolicy: 'MANAGER_PIN',
    selfApproved: false,
  };
  const digest = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');

  type Key = { commandType: string; payloadHash: string; resultPayload: unknown };
  function fixture(existing: Key | null = null) {
    const keys = new Map<string, Key>();
    if (existing) keys.set(attempt.idempotencyKey, existing);
    const db = {
      pharmacySale: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'sale-1',
          organizationId: 'org-1',
          branchId: 'branch-1',
        }),
      },
      // INSERT ... ON CONFLICT DO NOTHING on (organization, device, key).
      $executeRaw: vi.fn(async (query: { values: unknown[] }) => {
        const [, , , key, commandType, payloadHash, resultPayload] = query.values as string[];
        if (keys.has(key!)) return 0;
        keys.set(key!, {
          commandType: commandType!,
          payloadHash: payloadHash!,
          resultPayload: JSON.parse(resultPayload!),
        });
        return 1;
      }),
      pharmacyMoneyIdempotencyKey: {
        findUnique: vi.fn(
          async ({ where }: { where: { organizationId_deviceId_key: { key: string } } }) => {
            const found = keys.get(where.organizationId_deviceId_key.key);
            return found
              ? {
                  id: 'idem-1',
                  organizationId: 'org-1',
                  deviceId: 'device-1',
                  key: where.organizationId_deviceId_key.key,
                  ...found,
                }
              : null;
          }
        ),
      },
      pharmacyTender: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'tender-1',
          organizationId: 'org-1',
          branchId: 'branch-1',
          saleId: 'sale-1',
          deviceId: 'device-1',
          type: 'BANK_TRANSFER',
          amountMinor: 1_250,
          businessDate: new Date('2026-11-03T00:00:00.000Z'),
          cashReceivedMinor: null,
          changeGivenMinor: null,
        }),
      },
    };
    return { db, keys };
  }

  it('claims the attempt key with the approver and reason, so the attempt never lands', async () => {
    const f = fixture();
    await expect(
      discardPharmacyTenderAttempt(f.db as never, scope, attempt, record)
    ).resolves.toEqual({ status: 'DISCARDED' });
    expect(f.keys.get(attempt.idempotencyKey)).toEqual({
      commandType: DISCARDED_TENDER_COMMAND,
      payloadHash: digest(attempt),
      resultPayload: {
        saleId: 'sale-1',
        type: 'BANK_TRANSFER',
        amountMinor: 1_250,
        discardedByActorId: 'cashier-1',
        approvedByUserId: 'manager-1',
        approvalPolicy: 'MANAGER_PIN',
        selfApproved: false,
        reason: 'Customer did not pay',
      },
    });
    // The in-flight tender then binds the same key and is refused; nothing is recorded.
    await expect(applyPharmacyTender(f.db as never, scope, attempt)).rejects.toMatchObject({
      reason: 'TENDER_ATTEMPT_DISCARDED',
    });
    expect(f.db.pharmacyTender.findFirst).not.toHaveBeenCalled();
    // A second discard of the same attempt answers the same way.
    await expect(
      discardPharmacyTenderAttempt(f.db as never, scope, attempt, record)
    ).resolves.toEqual({ status: 'DISCARDED' });
  });

  it('returns a tender that already committed under the key instead of discarding it', async () => {
    const result = { tenderId: 'tender-1', settled: true, receiptNumber: 41, remainingMinor: 0 };
    const f = fixture({
      commandType: 'tender',
      payloadHash: digest(attempt),
      resultPayload: result,
    });
    await expect(
      discardPharmacyTenderAttempt(f.db as never, scope, attempt, record)
    ).resolves.toEqual({ status: 'ACCEPTED', result });
    expect(f.keys.get(attempt.idempotencyKey)?.commandType).toBe('tender');
  });

  it('refuses when the key holds this attempt but its tender cannot be read', async () => {
    const f = fixture({ commandType: 'tender', payloadHash: digest(attempt), resultPayload: null });
    await expect(
      discardPharmacyTenderAttempt(f.db as never, scope, attempt, record)
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
  });

  it('discards an attempt whose key was bound to a different payment', async () => {
    const f = fixture({ commandType: 'tender', payloadHash: 'other', resultPayload: null });
    await expect(
      discardPharmacyTenderAttempt(f.db as never, scope, attempt, record)
    ).resolves.toEqual({ status: 'DISCARDED' });
    expect(f.keys.get(attempt.idempotencyKey)?.commandType).toBe('tender');
  });

  it('writes nothing for a sale outside the scope', async () => {
    const f = fixture();
    f.db.pharmacySale.findFirst.mockResolvedValue(null);
    await expect(
      discardPharmacyTenderAttempt(f.db as never, scope, attempt, record)
    ).resolves.toBeNull();
    expect(f.db.$executeRaw).not.toHaveBeenCalled();
  });
});
