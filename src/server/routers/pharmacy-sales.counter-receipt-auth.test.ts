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
}));
vi.mock('@/lib/pharmacy/counter', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/counter')>()),
  readCounterReceipt: vi.fn(),
}));
vi.mock('@/lib/pharmacy/dispensing-label-source', () => ({
  readDispensingLabelSources: vi.fn(async () => []),
}));

import { readCounterReceipt } from '@/lib/pharmacy/counter';
import { readDispensingLabelSources } from '@/lib/pharmacy/dispensing-label-source';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

type Permission = { capability: string; effect: 'ALLOW' | 'DENY' };

const cashierPermissions: Permission[] = [
  { capability: 'pharmacy.counter', effect: 'ALLOW' },
  { capability: 'pharmacy:orders', effect: 'ALLOW' },
];

function fixture(permissions: Permission[]) {
  const db = {
    user: {
      findUnique: vi.fn(async () => ({
        organizationRole: { permissions },
        permissionOverrides: [],
      })),
    },
    pharmacyBranch: {
      findFirst: vi.fn(async () => ({ id: 'branch-a', name: 'Counter' })),
    },
    organization: { findUnique: vi.fn(async () => ({ currency: 'PKR' })) },
    restaurantStaffProfile: {
      findMany: vi.fn(
        async () =>
          [] as Array<{
            primaryBranchId: string | null;
            jobRoles: { branchId: string }[];
            directCapabilityGrants: { branchId: string }[];
          }>
      ),
    },
  };
  const user = {
    id: 'user-a',
    role: 'EMPLOYEE',
    department: 'COUNTER',
    status: 'ACTIVE',
    organizationId: 'org-a',
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: { expires: 'later', user },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  };
  return {
    db,
    user,
    caller: () => app.createCaller(context as unknown as TRPCContext).pharmacySales,
  };
}

const input = { branchId: 'branch-a', saleId: 'sale-a' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readCounterReceipt).mockResolvedValue({ receiptNumber: 7 } as never);
});

describe('counterReceipt authorization', () => {
  it('forbids a cashier without pharmacy:dispense before reading the receipt', async () => {
    const f = fixture(cashierPermissions);
    await expect(f.caller().counterReceipt(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.restaurantStaffProfile.findMany).not.toHaveBeenCalled();
    expect(readCounterReceipt).not.toHaveBeenCalled();
    expect(readDispensingLabelSources).not.toHaveBeenCalled();
  });

  it('forbids a user assigned to another branch', async () => {
    const f = fixture([{ capability: 'pharmacy:dispense', effect: 'ALLOW' }]);
    f.db.restaurantStaffProfile.findMany.mockResolvedValue([
      {
        primaryBranchId: 'branch-b',
        jobRoles: [],
        directCapabilityGrants: [],
      },
    ]);
    await expect(f.caller().counterReceipt(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(readCounterReceipt).not.toHaveBeenCalled();
    expect(readDispensingLabelSources).not.toHaveBeenCalled();
  });

  it('reads the receipt for a dispenser assigned to the branch', async () => {
    const f = fixture([{ capability: 'pharmacy:dispense', effect: 'ALLOW' }]);
    f.db.restaurantStaffProfile.findMany.mockResolvedValue([
      {
        primaryBranchId: 'branch-a',
        jobRoles: [{ branchId: 'branch-b' }],
        directCapabilityGrants: [],
      },
    ]);
    await expect(f.caller().counterReceipt(input)).resolves.toMatchObject({
      receiptNumber: 7,
      dispensingLabelSources: [],
    });
    expect(readCounterReceipt).toHaveBeenCalledWith(
      f.db,
      { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' },
      'sale-a',
      { name: 'Counter', currency: 'PKR' }
    );
  });
});
