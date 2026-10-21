import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { evaluateOrderSettlement } from './bills';
import { buildReceiptForBranch, getOrderSettlementForBranch } from './checkout-routes';

vi.mock('./bills', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bills')>()),
  evaluateOrderSettlement: vi.fn(),
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
    } as unknown as ScopedDb;
    const summary = await getOrderSettlementForBranch(summaryDb, 'order-1', 'branch-1');

    expect(summary).toMatchObject({
      derivedOrderTotal: expected,
      accountedTotal: expected,
      deliveryFeeTotal: expected,
      bills: [
        {
          grandTotal: expected,
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
        roundingAdjustment: expected,
        grandTotal: expected,
      },
      loyalty: null,
    });
  });

  it('attaches the customer wallet balance to a settled receipt', async () => {
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
          subtotal: decimal('100'),
          taxTotal: decimal('0'),
          serviceChargeTotal: decimal('0'),
          deliveryFeeTotal: decimal('0'),
          compTotal: decimal('0'),
          roundingAdjustment: decimal('0'),
          grandTotal: decimal('100'),
          receiptNumber: 1,
          settledAt: new Date('2026-09-01T01:00:00.000Z'),
          branch: { name: 'Branch', timezone: 'UTC' },
          order: { orderNumber: 9, channel: 'DINE_IN', customerId: 'cust-1' },
          lines: [],
          tenders: [],
        }),
      },
      restaurantCustomer: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'cust-1',
          loyaltyAccount: { id: 'acct-1', active: true },
        }),
      },
      loyaltyPointsEntry: {
        aggregate: vi
          .fn()
          .mockImplementation(async ({ where }: { where: { kind?: string } }) =>
            where.kind === 'EARN' ? { _sum: { points: 100 } } : { _sum: { points: 250 } }
          ),
      },
      loyaltyProgramVersion: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'program-1',
          earnRate: decimal('1'),
          redemptionValue: decimal('1'),
        }),
      },
    } as unknown as ScopedDb;

    const receipt = await buildReceiptForBranch(receiptDb, 'bill-1', 'branch-1');

    expect(receipt?.loyalty).toEqual({
      pointsBalance: 250,
      pointsEarned: 100,
      pointsPerPkr: '1',
      balancePkr: '250.00',
    });
  });
});
