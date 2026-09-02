import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  applyPharmacyTender,
  assertRefundWithinTender,
  computePharmacyClose,
  foldExpectedCash,
  PharmacySettlementError,
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
    const tenderCreate = vi.fn().mockResolvedValue({ id: 'tender-1' });
    const saleUpdate = vi.fn().mockResolvedValue({});
    const db = {
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
          lines: [{ quantity: 1, unitPriceMinor: 100, discountMinor: 0 }],
          tenders: [],
        }),
        update: saleUpdate,
      },
      pharmacyTender: { create: tenderCreate },
    };
    const input = {
      saleId: 'sale-1',
      deviceId: 'device-1',
      businessDate: new Date('2026-09-02T00:00:00.000Z'),
      type: 'BANK_TRANSFER' as const,
      amountMinor: 100,
      idempotencyKey: 'retry-1',
    };

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
  });
});
