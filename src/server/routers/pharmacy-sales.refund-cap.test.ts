import { describe, expect, it, vi } from 'vitest';

// Integrated tip: refunds also post finance entries and request counter evidence; this suite is
// about the returned-value cap, so those collaborators are stubbed.
vi.mock('@/lib/pharmacy/finance-postings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/finance-postings')>()),
  postTenderEntry: vi.fn(),
  postTenderRefundEntry: vi.fn(),
  postSaleLineEntry: vi.fn(),
}));
vi.mock('@/lib/pharmacy/counter-evidence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/counter-evidence')>()),
  requestCounterEvidence: vi.fn(),
}));

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
    user: {
      findUnique: vi.fn().mockResolvedValue({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: {
          permissions: [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }],
        },
        permissionOverrides: [],
      }),
    },
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch-1' }),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
    },
    pharmacyBranchAssignment: {
      findMany: vi.fn().mockResolvedValue([{ branchId: 'branch-1' }]),
    },
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
        // A refund here follows a settled sale; settled sales are always capped.
        status: 'COMPLETED',
        lines: [
          {
            quantity: 10,
            unitPriceMinor: 100,
            discountMinor: 0,
            canonicalUnits: 10,
            unidentifiedReturnHolds: [] as Array<{ canonicalUnits: number }>,
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
    // F3: the business day is open.
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
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
        if (boundary === 'API')
          expect(f.db.pharmacyBranch.findFirst).toHaveBeenCalledWith({
            where: { id: 'branch-1', organizationId: 'org-1', active: true },
            select: { id: true },
          });
        // Integrated tip: the F3 day lock and the tip's tender-join lock run first, so find the
        // sale lock by content rather than by position; it must still precede the aggregate read.
        const index = f.db.$queryRaw.mock.calls.findIndex(([q]) => {
          const query = q as { sql: string; values: unknown[] };
          return (
            /pharmacy_sales[\s\S]*FOR UPDATE/.test(query.sql) &&
            JSON.stringify(query.values) === JSON.stringify(['sale-1', 'org-1', 'branch-1'])
          );
        });
        expect(index).toBeGreaterThanOrEqual(0);
        expect(f.db.$queryRaw.mock.invocationCallOrder[index]).toBeLessThan(
          f.db.pharmacySale.findFirst.mock.invocationCallOrder[0]
        );
        expect(f.db.pharmacySale.findFirst).toHaveBeenCalledWith({
          where: {
            id: 'sale-1',
            organizationId: 'org-1',
            branchId: 'branch-1',
            status: 'COMPLETED',
          },
          include: {
            lines: { include: { unidentifiedReturnHolds: true, returnLines: true } },
            refunds: true,
          },
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

it('includes unidentified quarantine holdings in the mandatory refund cap', async () => {
  const f = fixture(0);
  const sale = await f.db.pharmacySale.findFirst();
  sale.lines[0].unidentifiedReturnHolds.push({ canonicalUnits: 2 });
  await expect(f.caller.refundTender({ ...input, amountMinor: 201 })).rejects.toThrow(
    'REFUND_EXCEEDS_TENDER'
  );
  expect(f.db.pharmacyRefund.create).not.toHaveBeenCalled();
  await expect(f.caller.refundTender({ ...input, amountMinor: 200 })).resolves.toMatchObject({
    refundId: 'refund-1',
  });
});
