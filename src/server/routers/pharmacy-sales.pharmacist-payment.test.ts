// Real router, central ABAC, Rx gate and settlement; only persistence, batch
// inspection (covered separately) and accounting postings are bounded fakes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/sale-batch-safety', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/sale-batch-safety')>()),
  assertSaleBatchesSellable: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/pharmacy/finance-postings', () => ({
  postTenderEntry: vi.fn(),
  postSaleLineEntry: vi.fn(),
  postTenderRefundEntry: vi.fn(),
}));

import { hasModule } from '@/lib/entitlements';
import {
  assertSaleBatchesSellable,
  PharmacySaleBatchError,
} from '@/lib/pharmacy/sale-batch-safety';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { pharmacySalesRouter } from './pharmacy-sales';
import type { TRPCContext } from '../trpc';

type Permission = { capability: string; effect: 'ALLOW' | 'DENY' };
const input = {
  branchId: 'branch-a',
  saleId: 'sale-a',
  deviceId: 'device-a',
  businessDate: new Date('2026-11-01T00:00:00Z'),
  type: 'CASH' as const,
  amountMinor: 100,
  cashReceivedMinor: 150,
  idempotencyKey: 'payment-a',
};
function fixture(role = 'pharmacist', overrides: Permission[] = [], roleDenies: string[] = []) {
  const permissions: Permission[] = [
    ...PHARMACY_ROLE_TEMPLATES.find((r) => r.key === role)!.capabilities.map((capability) => ({
      capability,
      effect: 'ALLOW' as const,
    })),
    ...roleDenies.map((capability) => ({ capability, effect: 'DENY' as const })),
  ];
  let idempotency: Record<string, unknown> | null = null;
  const sale = {
    id: 'sale-a',
    status: 'OPEN',
    lines: [
      {
        id: 'line-a',
        organizationId: 'org-a',
        branchId: 'branch-a',
        medicineId: 'medicine-a',
        presentationId: 'presentation-a',
        quantity: 1,
        canonicalUnits: 1,
        unitPriceMinor: 100,
        discountMinor: 0,
        medicine: {
          organizationId: 'org-a',
          productName: 'Rx medicine',
          rx: true,
          restricted: false,
          controlled: false,
          strengths: [],
        },
        presentation: { organizationId: 'org-a', medicineId: 'medicine-a', presentation: 'Tablet' },
        allocations: [
          {
            id: 'allocation-a',
            organizationId: 'org-a',
            branchId: 'branch-a',
            inventoryLotId: 'lot-a',
            canonicalUnits: 1,
            lot: {
              organizationId: 'org-a',
              branchId: 'branch-a',
              batch: {
                organizationId: 'org-a',
                medicineId: 'medicine-a',
                batchNumber: 'B1',
                expiresAt: new Date('2030-01-01'),
              },
            },
          },
        ],
      },
    ],
    tenders: [],
  };
  const db = {
    user: {
      findUnique: vi.fn(async () => ({
        status: 'ACTIVE',
        organizationId: 'org-a',
        organizationRole: { permissions },
        permissionOverrides: overrides,
      })),
    },
    pharmacyBranch: {
      findMany: vi.fn(async () => [{ id: 'branch-a' }]),
      findFirst: vi.fn(async () => ({ id: 'branch-a' })),
    },
    pharmacyBranchAssignment: { findMany: vi.fn(async () => [{ branchId: 'branch-a' }]) },
    pharmacyDailyClose: { findFirst: vi.fn(async (): Promise<{ id: string } | null> => null) },
    pharmacyDrawerSession: {
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => ({ id: 'drawer-a' })),
    },
    pharmacyDrawerMovement: { create: vi.fn(async () => ({})) },
    pharmacySale: { findFirst: vi.fn(async () => sale), update: vi.fn(async () => ({})) },
    pharmacyTender: {
      create: vi.fn(async () => ({ id: 'tender-a', createdAt: new Date() })),
      findFirst: vi.fn(async () => ({ saleId: 'sale-a' })),
    },
    pharmacySaleEvent: { create: vi.fn(async () => ({})) },
    camera: { findFirst: vi.fn(async () => null) },
    pharmacyMoneyIdempotencyKey: {
      findUnique: vi.fn(async () => idempotency),
      update: vi.fn(async ({ data }: { data: { resultPayload: unknown } }) => {
        idempotency = { ...idempotency, resultPayload: data.resultPayload };
        return idempotency;
      }),
    },
    $queryRaw: vi.fn(async () => [{ receipt_number: 41 }]),
    $executeRaw: vi.fn(async (query: { values: unknown[] }) => {
      idempotency ??= {
        id: 'idem-a',
        commandType: 'tender',
        payloadHash: query.values[5],
        resultPayload: null,
      };
      return 1;
    }),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'pharmacist-a', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-a' },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  };
  return {
    db,
    sale,
    context,
    caller: () => pharmacySalesRouter.createCaller(context as unknown as TRPCContext),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasModule).mockReturnValue(true);
  vi.mocked(assertSaleBatchesSellable).mockReset().mockResolvedValue(new Map());
});

describe('DEV-622 default Pharmacist payments', () => {
  it('settles an Rx sale with template grants, records the actor and scoped receipt, and replays once', async () => {
    const f = fixture();
    await expect(f.caller().tender(input)).resolves.toMatchObject({
      tenderId: 'tender-a',
      settled: true,
      receiptNumber: 41,
      remainingMinor: 0,
      replayed: false,
    });
    await expect(f.caller().tender(input)).resolves.toMatchObject({
      tenderId: 'tender-a',
      replayed: true,
    });
    expect(f.db.pharmacyTender.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        organizationId: 'org-a',
        branchId: 'branch-a',
        actorId: 'pharmacist-a',
        amountMinor: 100,
        cashReceivedMinor: 150,
        changeGivenMinor: 50,
        drawerSessionId: 'drawer-a',
      }),
    });
    expect(f.db.pharmacySale.update).toHaveBeenCalledExactlyOnceWith({
      where: { organizationId_id: { organizationId: 'org-a', id: 'sale-a' } },
      data: expect.objectContaining({ status: 'COMPLETED', receiptNumber: 41 }),
    });
    expect(f.db.pharmacySaleEvent.create).toHaveBeenCalledOnce();
    expect(assertSaleBatchesSellable).toHaveBeenCalledTimes(2);
    expect(f.db.pharmacySale.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sale-a', organizationId: 'org-a', branchId: 'branch-a' },
      })
    );
    const locks = f.db.$queryRaw.mock.calls.map((c) =>
      (c as unknown as [{ strings: string[] }])[0].strings.join(' ')
    );
    expect(locks.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(locks.some((s) => s.includes('FOR UPDATE'))).toBe(true);
  });
  it.each(['pharmacy:counter', 'pharmacy:dispense', 'pharmacy:*', '*'])(
    'preserves an explicit user DENY of %s',
    async (capability) => {
      const f = fixture('pharmacist', [{ capability, effect: 'DENY' }]);
      await expect(f.caller().tender(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.pharmacyTender.create).not.toHaveBeenCalled();
    }
  );
  it('preserves a role DENY despite a user ALLOW', async () => {
    const f = fixture(
      'pharmacist',
      [{ capability: 'pharmacy:counter', effect: 'ALLOW' }],
      ['pharmacy:counter']
    );
    await expect(f.caller().tender(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.pharmacyTender.create).not.toHaveBeenCalled();
  });
  it('keeps a cashier from paying an Rx bill without dispensing authorization', async () => {
    const f = fixture('cashier');
    await expect(f.caller().tender(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('dispensing permission'),
    });
    expect(f.db.pharmacyTender.create).not.toHaveBeenCalled();
  });
  it.each(['unassigned', 'foreign', 'inactive'] as const)(
    'fails closed for %s access',
    async (kind) => {
      const f = fixture();
      if (kind === 'unassigned') f.db.pharmacyBranchAssignment.findMany.mockResolvedValue([]);
      if (kind === 'foreign') f.context.session.user.organizationId = 'org-other';
      if (kind === 'inactive') f.context.session.user.status = 'INACTIVE';
      await expect(f.caller().tender(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.pharmacyTender.create).not.toHaveBeenCalled();
    }
  );
  it.each(['drawer', 'closed-day', 'over-tender', 'batch'] as const)(
    'preserves the %s payment gate',
    async (kind) => {
      const f = fixture();
      if (kind === 'drawer') f.db.pharmacyDrawerSession.findFirst.mockResolvedValue(null);
      if (kind === 'closed-day')
        f.db.pharmacyDailyClose.findFirst.mockResolvedValue({ id: 'close-a' });
      if (kind === 'batch')
        vi.mocked(assertSaleBatchesSellable).mockRejectedValue(
          new PharmacySaleBatchError('SALE_BATCH_RECALLED', 'RECALLED', 'line-a', 'lot-a')
        );
      await expect(
        f.caller().tender({ ...input, amountMinor: kind === 'over-tender' ? 101 : 100 })
      ).rejects.toBeDefined();
      expect(f.db.pharmacyTender.create).not.toHaveBeenCalled();
      expect(f.db.pharmacySale.update).not.toHaveBeenCalled();
    }
  );
});
