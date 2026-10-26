import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { evaluateOrderSettlement } from './bills';
import {
  buildReceiptForBranch,
  getOrderSettlementForBranch,
  moneyErrorResponse,
} from './checkout-routes';
import { OrderCommandError } from './orders';
import { quoteOpenBillSettlement } from './tenders';

vi.mock('./bills', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bills')>()),
  evaluateOrderSettlement: vi.fn(),
}));

import {
  TaxConfigurationError,
  TaxProfileResolutionError,
  resolveTaxProfile,
} from './tax-calculator';
vi.mock('./tenders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tenders')>()),
  quoteOpenBillSettlement: vi.fn(),
}));

const decimal = (value: string) => new Prisma.Decimal(value);

describe('checkout money serialization', () => {
  it.each([
    ['0', '0.00'],
    ['3', '3.00'],
    ['3.5', '3.50'],
  ])('preserves two decimals for %s across summary and receipt shapes', async (value, expected) => {
    vi.mocked(evaluateOrderSettlement).mockResolvedValue({
      orderId: 'order-1',
      settled: true,
      blocker: null,
      derivedOrderTotal: decimal(value),
      accountedTotal: decimal(value),
      unbilledItemIds: [],
      bills: [
        {
          id: 'bill-1',
          status: 'SETTLED',
          splitKind: 'NONE',
          grandTotal: decimal(value),
          taxTotal: decimal(value),
          remainingDue: decimal('0'),
          deliveryFeeTotal: decimal(value),
          compTotal: decimal(value),
          discountTotal: decimal(value),
          receiptNumber: 1,
        },
      ],
    });

    const summaryDb = {
      restaurantOrder: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'order-1',
          deliveryFulfillment: { deliveryFeeSnapshot: decimal(value) },
        }),
      },
      restaurantBillLine: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as ScopedDb;
    const summary = await getOrderSettlementForBranch(summaryDb, 'order-1', 'branch-1');

    expect(summary).toMatchObject({
      derivedOrderTotal: expected,
      accountedTotal: expected,
      deliveryFeeTotal: expected,
      bills: [
        {
          grandTotal: expected,
          taxTotal: expected,
          remainingDue: '0.00',
          deliveryFeeTotal: expected,
          compTotal: expected,
        },
      ],
    });

    const receiptDb = {
      restaurantBill: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'bill-1',
          orderId: 'order-1',
          branchId: 'branch-1',
          businessDate: new Date('2026-09-01T00:00:00.000Z'),
          status: 'SETTLED',
          splitKind: 'NONE',
          fractionNumerator: null,
          fractionDenominator: null,
          subtotal: decimal(value),
          taxTotal: decimal(value),
          serviceChargeTotal: decimal(value),
          deliveryFeeTotal: decimal(value),
          compTotal: decimal(value),
          discountTotal: decimal(value),
          roundingAdjustment: decimal(value),
          grandTotal: decimal(value),
          receiptNumber: 1,
          settledAt: new Date('2026-09-01T01:00:00.000Z'),
          branch: { name: 'Branch', timezone: 'UTC' },
          order: { orderNumber: 'ORDER-1', channel: 'DELIVERY' },
          lines: [
            {
              id: 'line-1',
              name: 'Item',
              quantity: 1,
              unitPrice: decimal(value),
              lineSubtotal: decimal(value),
              compAmount: decimal(value),
              lineTotal: decimal(value),
            },
          ],
          tenders: [
            {
              id: 'tender-1',
              type: 'CASH',
              amount: decimal(value),
              tipAmount: decimal(value),
              changeGiven: decimal(value),
              createdAt: new Date('2026-09-01T01:00:00.000Z'),
            },
          ],
        }),
      },
    } as unknown as ScopedDb;
    const receipt = await buildReceiptForBranch(receiptDb, 'bill-1', 'branch-1');

    expect(receipt).toMatchObject({
      lines: [
        {
          unitPrice: expected,
          lineSubtotal: expected,
          compAmount: expected,
          lineTotal: expected,
        },
      ],
      tenders: [{ amount: expected, tipAmount: expected, changeGiven: expected }],
      totals: {
        subtotal: expected,
        taxTotal: expected,
        serviceChargeTotal: expected,
        deliveryFeeTotal: expected,
        compTotal: expected,
        discountTotal: expected,
        roundingAdjustment: expected,
        grandTotal: expected,
      },
    });
  });

  // QA-143: an OPEN bill's stored grandTotal is pre-tax and its taxTotal is 0, so the
  // register summary must surface the live tax quote the tender will charge — not the
  // bare bill total that hides tax and shows a due that cannot settle the bill.
  it('surfaces the live tax quote for an OPEN bill instead of the pre-tax stored total', async () => {
    vi.mocked(evaluateOrderSettlement).mockResolvedValue({
      orderId: 'order-1',
      settled: false,
      blocker: 'BILLS_OPEN',
      derivedOrderTotal: decimal('970.00'),
      accountedTotal: decimal('970.00'),
      unbilledItemIds: [],
      bills: [
        {
          id: 'bill-1',
          status: 'OPEN',
          splitKind: 'NONE',
          // Stored pre-tax figures: grandTotal has no tax, taxTotal is 0, and the
          // recorded balance is the pre-tax total less the partial tender (970 − 970).
          grandTotal: decimal('970.00'),
          taxTotal: decimal('0.00'),
          remainingDue: decimal('0.00'),
          deliveryFeeTotal: decimal('0.00'),
          compTotal: decimal('0.00'),
          discountTotal: decimal('0.00'),
          receiptNumber: null,
        },
      ],
    });
    // The live quote (15% exclusive) the next tender will charge after a 970 partial.
    vi.mocked(quoteOpenBillSettlement).mockResolvedValue({
      grandTotal: decimal('1115.50'),
      tax: decimal('145.50'),
      remainingDue: decimal('145.50'),
    } as Awaited<ReturnType<typeof quoteOpenBillSettlement>>);

    const summaryDb = {
      restaurantOrder: {
        findFirst: vi.fn().mockResolvedValue({ id: 'order-1', deliveryFulfillment: null }),
      },
      restaurantBillLine: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'line-1',
            billId: 'bill-1',
            name: 'Item',
            quantity: 1,
            lineSubtotal: decimal('970.00'),
            compAmount: decimal('0.00'),
          },
        ]),
      },
    } as unknown as ScopedDb;
    const summary = await getOrderSettlementForBranch(summaryDb, 'order-1', 'branch-1');

    expect(summary?.bills[0]).toMatchObject({
      grandTotal: '1115.50',
      taxTotal: '145.50',
      remainingDue: '145.50',
      lines: [
        {
          id: 'line-1',
          name: 'Item',
          quantity: 1,
          lineSubtotal: '970.00',
          compAmount: '0.00',
        },
      ],
    });
  });
});

describe('tax configuration checkout refusal (#148)', () => {
  it('maps a real missing-profile failure to actionable 409', async () => {
    let failure: unknown;
    try {
      resolveTaxProfile([], new Date('2026-10-21T00:00:00Z'));
    } catch (error) {
      failure = error;
    }
    const response = moneyErrorResponse(failure)!;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: 'TAX_PROFILE_UNAVAILABLE',
      error: expect.stringContaining('publish a tax profile before tendering'),
    });
  });
  it.each(['MISSING', 'EXPIRED', 'AMBIGUOUS'] as const)(
    'refuses %s profiles without leaking domain internals',
    async (reason) => {
      const response = moneyErrorResponse(
        new TaxProfileResolutionError(reason, 'private-profile-id')
      )!;
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.code).toBe(
        reason === 'AMBIGUOUS' ? 'TAX_RULE_CONFLICT' : 'TAX_PROFILE_UNAVAILABLE'
      );
      expect(body.error).not.toContain('private-profile-id');
    }
  );
  it('sanitizes other tax configuration failures and preserves unexpected 500 handling', async () => {
    const response = moneyErrorResponse(
      new TaxConfigurationError('Tax rule private-rule-id is not approved')
    )!;
    expect(response.status).toBe(409);
    expect((await response.json()).error).not.toContain('private-rule-id');
    expect(moneyErrorResponse(new Error('database failure'))).toBeNull();
  });
});

describe('order command error responses', () => {
  it('reports a closed business day as a conflict', async () => {
    const response = moneyErrorResponse(
      new OrderCommandError('This business day is closed; no order can be opened.', 'DAY_CLOSED')
    )!;

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'This business day is closed; no order can be opened.',
    });
  });
});
