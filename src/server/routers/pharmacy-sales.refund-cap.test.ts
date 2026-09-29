import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import { refundPharmacyTender } from '@/lib/pharmacy/settlement';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' };
const input = {
  branchId: 'branch-1',
  originalTenderId: 'cash-tender',
  deviceId: 'device-1',
  businessDate: new Date('2026-09-29'),
  amountMinor: 100,
  reason: 'Returned medicine',
  idempotencyKey: 'refund-attempt',
};

function fixture(returnedUnits: number, priorRefunds: number[] = []) {
  let payloadHash = '';
  const db = {
    $executeRaw: vi.fn(async (query: { values: unknown[] }) => {
      payloadHash = String(query.values[5]);
      return 1;
    }),
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyMoneyIdempotencyKey: {
      findUnique: vi.fn(async () => ({ id: 'idem-1', commandType: 'refund', payloadHash })),
      update: vi.fn().mockResolvedValue({}),
    },
    pharmacyTender: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'cash-tender',
        saleId: 'sale-1',
        type: 'CASH',
        amountMinor: 1000,
        refunds: [],
        sale: { customerId: null },
      }),
    },
    pharmacySale: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'sale-1',
        lines: [
          {
            quantity: 10,
            unitPriceMinor: 100,
            discountMinor: 0,
            canonicalUnits: 10,
            returnLines: returnedUnits ? [{ canonicalUnits: returnedUnits }] : [],
          },
        ],
        // Prior refunds belong to other tenders; the current cash tender is still unused.
        refunds: priorRefunds.map((amountMinor, i) => ({
          originalTenderId: `other-${i}`,
          amountMinor,
        })),
      }),
    },
    pharmacyDrawerSession: { findFirst: vi.fn().mockResolvedValue({ id: 'drawer-1' }) },
    pharmacyRefund: { create: vi.fn(async ({ data }) => ({ id: 'refund-1', ...data })) },
    pharmacyDrawerMovement: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown): Promise<unknown> =>
      callback(db)
    ),
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'actor-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, caller: app.createCaller(context).pharmacySales };
}

for (const boundary of ['service', 'API'] as const) {
  describe(`${boundary} mandatory returned-value cap`, () => {
    for (const flag of [{}, { requireReturnedValue: false }, { requireReturnedValue: true }]) {
      const label = 'requireReturnedValue' in flag ? String(flag.requireReturnedValue) : 'omitted';
      const run = (f: ReturnType<typeof fixture>, amountMinor = 100) => {
        const request = { ...input, ...flag, amountMinor };
        return boundary === 'API'
          ? f.caller.refundTender(request)
          : refundPharmacyTender(f.db as unknown as ScopedDb, scope, request);
      };
      const assertLocked = (f: ReturnType<typeof fixture>) => {
        const query = f.db.$queryRaw.mock.calls[1][0] as { sql: string; values: unknown[] };
        expect(query.sql).toMatch(/pharmacy_sales[\s\S]*FOR UPDATE/);
        expect(query.values).toEqual(['sale-1', 'org-1', 'branch-1']);
        expect(f.db.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
          f.db.pharmacySale.findFirst.mock.invocationCallOrder[0]
        );
        expect(f.db.pharmacySale.findFirst).toHaveBeenCalledWith({
          where: {
            id: 'sale-1',
            organizationId: 'org-1',
            branchId: 'branch-1',
            status: 'COMPLETED',
          },
          include: { lines: { include: { returnLines: true } }, refunds: true },
        });
      };
      it(`rejects no-return refunds with flag ${label}`, async () => {
        const f = fixture(0);
        await expect(run(f)).rejects.toThrow('REFUND_EXCEEDS_TENDER');
        assertLocked(f);
        expect(f.db.pharmacyRefund.create).not.toHaveBeenCalled();
        expect(f.db.pharmacyDrawerSession.findFirst).not.toHaveBeenCalled();
      });
      it(`rejects mixed-tender aggregate over-cap with flag ${label}`, async () => {
        const f = fixture(5, [200, 200]);
        await expect(run(f, 101)).rejects.toThrow('REFUND_EXCEEDS_TENDER');
        assertLocked(f);
        expect(f.db.pharmacyRefund.create).not.toHaveBeenCalled();
        expect(f.db.pharmacyDrawerMovement.create).not.toHaveBeenCalled();
      });
      it(`allows exactly the remaining returned value with flag ${label}`, async () => {
        const f = fixture(5, [200, 200]);
        await expect(run(f)).resolves.toMatchObject({
          refundId: 'refund-1',
          amountMinor: 100,
          replayed: false,
        });
        assertLocked(f);
        expect(f.db.pharmacyRefund.create).toHaveBeenCalledTimes(1);
      });
    }
  });
}
