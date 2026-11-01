import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ mode: vi.fn(), add: vi.fn(), branch: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({ hasModule: () => true }));
vi.mock('@/server/audit', async (original) => ({
  ...(await original<typeof import('@/server/audit')>()),
  isAuditExcludedPath: () => true,
}));
vi.mock('@/lib/pharmacy/operating-mode', () => ({ enforceOperatingMode: mocks.mode }));
vi.mock('@/lib/pharmacy/branch-assignment', () => ({ assertBranchAssignment: mocks.branch }));
vi.mock('@/lib/pharmacy/rx-sale-gate', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/rx-sale-gate')>()),
  assertRxSaleAllowed: vi.fn(),
}));
vi.mock('@/lib/pharmacy/sales', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/sales')>()),
  addSaleLine: mocks.add,
}));

import { pharmacySalesRouter } from './pharmacy-sales';
import type { TRPCContext } from '../trpc';

describe('Rx approval on a discounted line', () => {
  it('keeps the pharmacist and discount checkers independent and strips the Rx credential before domain writes', async () => {
    mocks.branch.mockImplementation(async (_db, scope) => scope);
    mocks.mode.mockImplementation(async (_db, _scope, input) => ({
      actorId: input.checkerId,
      policy: 'STAFFED',
    }));
    mocks.add.mockResolvedValue({ line: { id: 'line' } });
    const db = {
      user: {
        findUnique: vi.fn(async () => ({
          id: 'actor',
          organizationId: 'org',
          role: 'EMPLOYEE',
          status: 'ACTIVE',
          organizationRole: { permissions: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }] },
          permissionOverrides: [],
        })),
      },
      pharmacyBranchAssignment: { findMany: vi.fn(async () => [{ branchId: 'branch' }]) },
      pharmacyBranch: {
        findMany: vi.fn(async () => [{ id: 'branch' }]),
        findFirst: vi.fn(async () => ({ id: 'branch' })),
      },
      medicine: { findFirst: vi.fn(async () => ({ rx: true, controlled: false })) },
      pharmacySale: { findFirst: vi.fn(async () => ({ createdByUserId: 'maker' })) },
      $transaction: (run: (db: unknown) => unknown) => run(db),
    };
    const ctx = {
      db,
      session: { user: { id: 'actor', organizationId: 'org', status: 'ACTIVE', role: 'EMPLOYEE' } },
      entitlements: { organizationId: 'org', enabledModules: ['pharmacy-counter'] },
      audit: { detail: {} },
      requestMeta: { ip: null, userAgent: null },
    } as unknown as TRPCContext;
    await pharmacySalesRouter.createCaller(ctx).addLine({
      branchId: 'branch',
      saleId: 'sale',
      medicineId: 'medicine',
      presentationId: 'presentation',
      packLevelId: 'pack',
      saleUnit: 'UNIT',
      quantity: 1,
      canonicalUnitsPerSaleUnit: 1,
      discountMinor: 1,
      approvedByUserId: 'manager',
      approvalPin: '1234',
      prescriptionApproval: { checkerId: 'pharmacist', pin: '5678' },
      idempotencyKey: 'separate-checkers',
    });
    expect(mocks.mode).toHaveBeenNthCalledWith(
      1,
      db,
      expect.anything(),
      expect.objectContaining({
        kind: 'DISCOUNT',
        checkerId: 'manager',
        pin: '1234',
      })
    );
    expect(mocks.mode).toHaveBeenNthCalledWith(
      2,
      db,
      expect.anything(),
      expect.objectContaining({
        kind: 'RX',
        checkerId: 'pharmacist',
        pin: '5678',
      })
    );
    expect(mocks.branch).toHaveBeenCalledWith(db, {
      organizationId: 'org',
      branchId: 'branch',
      actorId: 'pharmacist',
    });
    const written = mocks.add.mock.calls[0]![2];
    expect(written).not.toHaveProperty('prescriptionApproval');
    expect(written).not.toHaveProperty('approvalPin');
  });
});
