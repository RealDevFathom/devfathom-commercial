import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { compLine } from './bills';

const D = (value: string) => new Prisma.Decimal(value);

describe('compLine service charge', () => {
  it.each(['0.00', '30.00'])(
    'excludes comped merchandise before a %s order discount',
    async (discount) => {
      const lines = [
        { id: 'comped', billId: 'bill', lineSubtotal: D('40'), compAmount: D('0') },
        { id: 'paid', billId: 'bill', lineSubtotal: D('60'), compAmount: D('0') },
      ];
      const bill = {
        id: 'bill',
        status: 'OPEN',
        subtotal: D('100'),
        compTotal: D('0'),
        discountTotal: D(discount),
        grandTotal: D('110').minus(discount),
        serviceChargeRate: D('0.10'),
        serviceChargeTotal: D('10'),
      };
      const updateBill = vi.fn();
      const updateLine = vi.fn(async ({ where, data }) => {
        Object.assign(
          lines.find((line) => line.id === where.id)!,
          data
        );
      });
      const tx = {
        $queryRaw: vi.fn(),
        restaurantBill: { findFirst: vi.fn(async () => bill), update: updateBill },
        restaurantBillLine: {
          findUnique: vi.fn(async () => lines[0]),
          findMany: vi.fn(async () => lines),
          update: updateLine,
        },
        restaurantMoneyIdempotencyKey: {
          findUnique: vi.fn(async () => null),
          create: vi.fn(),
          update: vi.fn(),
        },
        restaurantCoAuthorization: { create: vi.fn(async () => ({ id: 'approval' })) },
      };
      const db = {
        $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
      };

      await compLine(db as unknown as ScopedDb, {
        billId: 'bill',
        billLineId: 'comped',
        branchId: 'branch',
        reason: 'Guest complaint',
        approvingStaffProfileId: 'manager',
        actor: { staffProfileId: 'staff', deviceId: 'device', idempotencyKey: 'comp-key' },
      });

      const { data } = updateBill.mock.calls[0]![0];
      expect(data.serviceChargeBasis.toFixed(2)).toBe('60.00');
      expect(data.serviceChargeTotal.toFixed(2)).toBe('6.00');
      expect(data.compTotal.toFixed(2)).toBe('40.00');
      expect(data.discountTotal.toFixed(2)).toBe(discount);
      expect(data.grandTotal.toFixed(2)).toBe(D('66').minus(discount).toFixed(2));
      expect(updateLine).toHaveBeenCalledWith({
        where: { id: 'comped' },
        data: { serviceChargeAmount: D('0') },
      });
      expect(updateLine).toHaveBeenCalledWith({
        where: { id: 'paid' },
        data: { serviceChargeAmount: D('6') },
      });
    }
  );
});
