import type { Prisma } from '@/generated/prisma/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./patient-prescriptions', () => ({ auditPatientRead: vi.fn() }));

import { recordKhataRepayment } from './khata-repayment';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };

function database() {
  const payment = vi.fn(async ({ data }) => ({ id: 'payment-a', ...data }));
  const movement = vi.fn(async ({ data }) => ({ id: 'movement-a', ...data }));
  let idempotency: Record<string, unknown> | null = null;
  return {
    payment,
    movement,
    db: {
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(async (sql: Prisma.Sql) => {
        idempotency ??= {
          id: 'key-a',
          commandType: 'khata-repayment',
          payloadHash: sql.values[4],
          resultPayload: null,
        };
        return 1;
      }),
      pharmacyMoneyIdempotencyKey: {
        findUnique: vi.fn(async () => idempotency),
        update: vi.fn(async ({ data }) => {
          Object.assign(idempotency!, data);
          return idempotency;
        }),
      },
      pharmacyKhataEvent: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: 'charge-a', kind: 'CHARGE', amountMinor: 10_000, occurredAt: new Date() },
          ]),
        create: payment,
      },
      pharmacyDrawerSession: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'drawer-a',
          status: 'OPEN',
          businessDate: new Date('2026-11-03T00:00:00Z'),
        }),
      },
      pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
      pharmacyDrawerMovement: { create: movement },
    },
  };
}

describe('counter khata repayment', () => {
  it('records cash as both a khata payment and a drawer paid-in', async () => {
    const { db, payment, movement } = database();
    const result = await recordKhataRepayment(db as never, scope, {
      familyAccountId: 'family-a',
      amountMinor: 4_000,
      tender: 'CASH',
      drawerSessionId: 'drawer-a',
      occurredAt: new Date('2026-11-03T10:00:00Z'),
      idempotencyKey: 'request-a',
    });

    expect(result).toMatchObject({ receiptId: 'payment-a', remainingBalanceMinor: 6_000 });
    expect(payment).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'PAYMENT', amountMinor: 4_000, note: 'Tender: CASH' }),
    });
    expect(movement).toHaveBeenCalledWith({
      data: expect.objectContaining({
        drawerSessionId: 'drawer-a',
        kind: 'PAID_IN',
        amountMinor: 4_000,
        reason: 'Khata payment payment-a',
      }),
    });
  });

  it('does not change drawer cash for a non-cash tender', async () => {
    const { db, movement } = database();
    await recordKhataRepayment(db as never, scope, {
      familyAccountId: 'family-a',
      amountMinor: 2_000,
      tender: 'CARD',
      occurredAt: new Date('2026-11-03T10:00:00Z'),
      idempotencyKey: 'request-a',
    });
    expect(movement).not.toHaveBeenCalled();
  });
});

it('replays a lost response without duplicating either ledger or drawer entries', async () => {
  const { db, payment, movement } = database();
  const input = {
    familyAccountId: 'family-a',
    amountMinor: 2000,
    tender: 'CASH' as const,
    drawerSessionId: 'drawer-a',
    occurredAt: new Date('2026-11-03T10:00:00Z'),
    idempotencyKey: 'same-request',
  };
  const first = await recordKhataRepayment(db as never, scope, input);
  expect(await recordKhataRepayment(db as never, scope, input)).toEqual(first);
  expect(payment).toHaveBeenCalledTimes(1);
  expect(movement).toHaveBeenCalledTimes(1);
  await expect(
    recordKhataRepayment(db as never, scope, { ...input, amountMinor: 1000 })
  ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
  expect(payment).toHaveBeenCalledTimes(1);
});
