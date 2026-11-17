import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-884: exercise the public mutation, real ABAC/counter gate and real recovery
// library against synthetic rows. Only persistence and unrelated services are mocked.
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

import { annotateAudit } from '@/server/audit';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const NOW = new Date('2026-11-17T10:00:00.000Z');
const SENT_AT = new Date('2026-11-16T10:00:00.000Z');
const SOLD_AT = new Date('2026-11-16T11:00:00.000Z');
type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const COUNTER: Rule = { capability: 'pharmacy:counter', effect: 'ALLOW' };
const OWNER: Rule = { capability: 'pharmacy:*', effect: 'ALLOW' };

type Access = {
  rules: Rule[];
  overrides?: Rule[];
  role?: 'EMPLOYEE' | 'ADMIN';
  assigned: string[];
};

function fixture({ rules, overrides = [], role = 'EMPLOYEE', assigned }: Access) {
  const member = {
    status: 'ACTIVE',
    organizationId: 'org-a',
    organizationRole: { permissions: rules },
    permissionOverrides: overrides,
  };
  const interest = {
    id: 'interest-a',
    organizationId: 'org-a',
    branchId: 'branch-a',
    status: 'NOTIFIED',
    patientId: 'patient-a',
    orderLineId: null,
    campaignKey: null,
    demandEventId: 'demand-a',
    demandEvent: { requestedMedicineId: 'medicine-a' },
    notifications: [{ id: 'notice-a' }],
    recoveredSaleId: null,
    recoveredSaleLineId: null,
  };
  const demand = { status: 'OPEN', recoveredSaleLineId: null };
  const reservation = { status: 'RESERVED' };
  const line = {
    id: 'line-a',
    saleId: 'sale-a',
    medicineId: 'medicine-a',
    sale: {
      status: 'COMPLETED',
      receiptNumber: 1,
      completedAt: SOLD_AT,
      customer: { patientId: 'patient-a' },
    },
  };
  const db = {
    user: { findUnique: vi.fn(async () => member) },
    pharmacyBranch: {
      findMany: vi.fn(async () => [{ id: 'branch-a' }]),
      findFirst: vi.fn(async () => ({ id: 'branch-a' })),
    },
    pharmacyBranchAssignment: {
      findMany: vi.fn(async () => assigned.map((branchId) => ({ branchId }))),
    },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(async () => []),
    pharmacyRestockInterest: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        'recoveredSaleLineId' in where ? [] : [interest]
      ),
      findFirst: vi.fn(async () => interest),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(interest, data);
        return { ...interest, ...data };
      }),
    },
    pharmacyMessageLog: {
      findMany: vi.fn(async () => [{ dedupeKey: 'back-in-stock:notice-a', updatedAt: SENT_AT }]),
    },
    pharmacySaleLine: {
      findMany: vi.fn(async () => [line]),
      findFirst: vi.fn(async () => line),
    },
    unfulfilledDemandEvent: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
        Object.assign(demand, data)
      ),
    },
    pharmacyRestockReservation: {
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(reservation, data);
        return { count: 1 };
      }),
    },
  };
  db.$transaction.mockImplementation(async (run: (tx: typeof db) => Promise<unknown>) => run(db));
  const ctx = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'user-a',
        role,
        department: 'COUNTER',
        status: 'ACTIVE',
        organizationId: 'org-a',
      },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  };
  return {
    db,
    interest,
    demand,
    reservation,
    caller: app.createCaller(ctx as unknown as TRPCContext).pharmacySales,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => vi.useRealTimers());

describe('DEV-884 linkRestockRecoveries authorization', () => {
  const denied: Array<Access & { label: string }> = [
    { label: 'no counter capability', rules: [], assigned: ['branch-a'] },
    {
      label: 'dispense permission without the canonical counter capability',
      rules: [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }],
      assigned: ['branch-a'],
    },
    {
      label: 'an explicit counter override DENY',
      rules: [COUNTER],
      overrides: [{ capability: 'pharmacy:counter', effect: 'DENY' }],
      assigned: ['branch-a'],
    },
    {
      label: 'an alias DENY despite the canonical ALLOW',
      rules: [COUNTER],
      overrides: [{ capability: 'pharmacy.counter', effect: 'DENY' }],
      assigned: ['branch-a'],
    },
    {
      label: 'a role DENY despite an override ALLOW',
      rules: [{ capability: 'pharmacy:counter', effect: 'DENY' }],
      overrides: [COUNTER],
      assigned: ['branch-a'],
    },
    { label: 'assignment only to another branch', rules: [COUNTER], assigned: ['branch-b'] },
    { label: 'no branch assignment', rules: [COUNTER], assigned: [] },
    {
      label: 'a solo owner with an explicit DENY',
      rules: [OWNER],
      overrides: [{ capability: 'pharmacy:counter', effect: 'DENY' }],
      role: 'ADMIN',
      assigned: [],
    },
  ];

  it.each(denied)(
    'refuses $label without disclosing IDs or mutating recovery rows',
    async (access) => {
      const { caller, db, interest, demand, reservation } = fixture(access);
      const before = structuredClone({ interest, demand, reservation });
      const result = await caller.linkRestockRecoveries({ branchId: 'branch-a' }).then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: undefined, error })
      );
      expect.soft(result.error).toMatchObject({ code: 'FORBIDDEN' });
      expect.soft(result.value).toBeUndefined();
      for (const id of ['interest-a', 'sale-a', 'line-a']) {
        expect.soft(JSON.stringify(result)).not.toContain(id);
      }
      expect.soft(db.$transaction).not.toHaveBeenCalled();
      expect.soft(db.$queryRaw).not.toHaveBeenCalled();
      expect.soft(db.pharmacyRestockInterest.findMany).not.toHaveBeenCalled();
      expect.soft(db.pharmacySaleLine.findMany).not.toHaveBeenCalled();
      expect.soft(db.pharmacyRestockInterest.update).not.toHaveBeenCalled();
      expect.soft(db.unfulfilledDemandEvent.update).not.toHaveBeenCalled();
      expect.soft(db.pharmacyRestockReservation.updateMany).not.toHaveBeenCalled();
      expect.soft({ interest, demand, reservation }).toEqual(before);
    }
  );

  const allowed: Array<Access & { label: string }> = [
    { label: 'an assigned counter member', rules: [COUNTER], assigned: ['branch-a'] },
    { label: 'an assigned owner', rules: [OWNER], role: 'ADMIN', assigned: ['branch-a'] },
    {
      label: 'a solo owner without branch assignments',
      rules: [OWNER],
      role: 'ADMIN',
      assigned: [],
    },
  ];

  it.each(allowed)('keeps the public mutation working for $label', async (access) => {
    const { caller, db, interest, demand, reservation } = fixture(access);
    await expect(caller.linkRestockRecoveries({ branchId: 'branch-a' })).resolves.toEqual([
      { interestId: 'interest-a', saleId: 'sale-a', saleLineId: 'line-a', recoveredAt: NOW },
    ]);
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(db.pharmacyRestockInterest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-a',
          branchId: 'branch-a',
          status: 'NOTIFIED',
        }),
      })
    );
    expect(db.pharmacyRestockInterest.update).toHaveBeenCalledOnce();
    expect(interest).toMatchObject({
      status: 'RECOVERED',
      recoveredSaleId: 'sale-a',
      recoveredSaleLineId: 'line-a',
    });
    expect(demand).toMatchObject({ status: 'RECOVERED', recoveredSaleLineId: 'line-a' });
    expect(reservation.status).toBe('CONSUMED');
    if (access.assigned.length === 0) {
      expect(annotateAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          targetId: 'branch-a',
          metadata: {
            branchId: 'branch-a',
            reason: 'org-admin-receipt-access-without-branch-assignment',
          },
        })
      );
    }
  });
});
