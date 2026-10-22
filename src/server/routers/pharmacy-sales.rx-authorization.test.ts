import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({ hasModule: vi.fn(() => true), resolveOrganizationEntitlements: vi.fn() }));
vi.mock('@/server/audit', () => ({ annotateAudit: vi.fn(), ipFromHeaders: vi.fn(() => null), isAuditExcludedPath: vi.fn(() => false), recordTrpcAudit: vi.fn() }));
vi.mock('@/lib/pharmacy/prescription-files', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/prescription-files')>()),
  loadPrescriptionFile: vi.fn(async () => ({ id: 'file' })),
}));
vi.mock('@/lib/pharmacy/sales', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/sales')>()),
  addSaleLine: vi.fn(async (_db, _scope, input) => ({ line: { id: 'line-1' }, input })),
}));

import { addSaleLine } from '@/lib/pharmacy/sales';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const base = {
  branchId: 'branch-1', saleId: 'sale-1', medicineId: 'medicine-1',
  presentationId: 'presentation-1', packLevelId: 'pack-1', saleUnit: 'UNIT' as const,
  quantity: 1, canonicalUnitsPerSaleUnit: 1, idempotencyKey: 'rx-line-1',
};

function caller(actorRules: Array<{ capability: string; effect: 'ALLOW' | 'DENY' }>, approverRules = actorRules) {
  const db = {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    pharmacyBranch: { findMany: async () => [{ id: 'branch-1' }] },
    medicine: { findFirst: async () => ({ id: 'medicine-1', rx: true, restricted: false, controlled: false }) },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        organizationRole: { permissions: where.id === 'pharmacist-1' ? approverRules : actorRules },
        permissionOverrides: [],
      }),
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === 'pharmacist-1'
          ? { id: 'pharmacist-1', organizationId: 'org-1', role: 'EMPLOYEE', status: 'ACTIVE' }
          : null,
    },
    pharmacyBranchAssignment: { findFirst: async () => ({ id: 'assignment-1' }) },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: { expires: 'later', user: { id: 'cashier-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' } },
    organization: { id: 'org-1', vertical: 'PHARMACY' }, support: null,
    requestMeta: { ip: null, userAgent: null }, audit: { detail: {} },
  } as unknown as TRPCContext;
  return app.createCaller(context).pharmacySales;
}

beforeEach(() => vi.mocked(addSaleLine).mockClear());

describe('pharmacySales.addLine non-controlled Rx authorization', () => {
  it('accepts path (a) only for the actor exact dispense grant', async () => {
    await caller([{ capability: 'pharmacy:dispense', effect: 'ALLOW' }]).addLine(base);
    expect(addSaleLine).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ rxAuthorization: { path: 'ACTOR_GRANT' } }));
  });

  it('lets an explicit DENY beat an exact actor ALLOW', async () => {
    await expect(
      caller([
        { capability: 'pharmacy:dispense', effect: 'ALLOW' },
        { capability: 'pharmacy:dispense', effect: 'DENY' },
      ]).addLine(base)
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'RX_AUTHORIZATION_REQUIRED' });
  });

  it.each([
    ['reference', { prescriptionReference: 'RX-42' }, { path: 'PRESCRIPTION_REFERENCE', prescriptionReference: 'RX-42' }],
    ['photo', { prescriptionFileRef: '/api/pharmacy/prescription-files?id=123e4567-e89b-42d3-a456-426614174000' }, { path: 'PRESCRIPTION_PHOTO', prescriptionFileRef: '/api/pharmacy/prescription-files?id=123e4567-e89b-42d3-a456-426614174000' }],
  ])('accepts path (b) by %s', async (_label, rxAuthorization, resolved) => {
    await caller([]).addLine({ ...base, rxAuthorization });
    expect(addSaleLine).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ rxAuthorization: resolved }));
  });

  it('accepts path (c) with a same-branch pharmacist and non-empty reason', async () => {
    await caller([], [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }]).addLine({
      ...base,
      rxAuthorization: { override: { approverUserId: 'pharmacist-1', reason: 'Prescription confirmed by phone' } },
    });
    expect(addSaleLine).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      rxAuthorization: { path: 'PHARMACIST_OVERRIDE', approverUserId: 'pharmacist-1', reason: 'Prescription confirmed by phone' },
    }));
  });

  it.each([
    ['approver lacks the grant', [], [{ capability: 'pharmacy:orders', effect: 'ALLOW' }], { override: { approverUserId: 'pharmacist-1', reason: 'Asked pharmacist' } }],
    ['actor has only a wildcard grant', [{ capability: 'pharmacy:*', effect: 'ALLOW' }], [], undefined],
    ['no evidence is supplied', [], [], undefined],
  ])('rejects when %s', async (_label, actorRules, approverRules, rxAuthorization) => {
    await expect(caller(actorRules, approverRules).addLine({ ...base, rxAuthorization })).rejects.toMatchObject({
      code: 'FORBIDDEN', message: 'RX_AUTHORIZATION_REQUIRED',
    });
    expect(addSaleLine).not.toHaveBeenCalled();
  });
});
