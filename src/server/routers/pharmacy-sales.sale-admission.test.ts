import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-607: `create` and `addLine` admitted any member of the organization, so a cashier with
// no branch assignment (or a member with no counter capability) could open a bill and
// allocate stock that `counterCart` and `tender` then refused to show or settle. Bill
// creation and line allocation must use the same member, capability and branch-assignment
// gate as `counterCart`, and refuse before any sale or allocation write.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/sales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/sales')>()),
  addSaleLine: vi.fn(),
  createSale: vi.fn(),
}));

vi.mock('@/lib/pharmacy/customer-loyalty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/customer-loyalty')>()),
  linkCustomerToSale: vi.fn(),
}));

import { linkCustomerToSale } from '@/lib/pharmacy/customer-loyalty';
import { addSaleLine, createSale } from '@/lib/pharmacy/sales';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const BRANCH = 'branch-main';
const OUTSIDE = { code: 'FORBIDDEN', message: 'Branch is outside your scope.' };
const NO_CAPABILITY = { code: 'FORBIDDEN', message: 'You do not have permission for this action.' };

const line = {
  branchId: BRANCH,
  saleId: 'sale-1',
  medicineId: 'medicine-1',
  presentationId: 'presentation-1',
  packLevelId: 'pack-1',
  saleUnit: 'STRIP' as const,
  quantity: 2,
  canonicalUnitsPerSaleUnit: 10,
  idempotencyKey: 'counter:sale-1:medicine-1',
};

/** DEV-725: a counter bill names the device whose drawer takes its cash. */
const DEVICE = 'counter-device';

function fixture(options: {
  capabilities: string[];
  assignedBranches: string[];
  role?: 'ADMIN' | 'EMPLOYEE';
}) {
  const db = {
    // DEV-631: a counter bill or line is refused while today's business day is closed.
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyBranch: {
      // `assertInOrganization` asks by id; `counterBranches` lists (DEV-830).
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        where.id ? where.id.in.map((id) => ({ id })) : []
      ),
      findFirst: vi.fn(async () => ({ id: BRANCH })),
    },
    organization: { findUnique: vi.fn(async () => ({ currency: 'PKR', timezone: null })) },
    pharmacyBranchAssignment: {
      findMany: vi.fn(async () => options.assignedBranches.map((branchId) => ({ branchId }))),
    },
    user: {
      findUnique: vi.fn(async () => ({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: {
          permissions: options.capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
        },
        permissionOverrides: [],
      })),
    },
    medicine: { findFirst: vi.fn(async () => null) },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'cashier-1',
        role: options.role ?? 'EMPLOYEE',
        status: 'ACTIVE',
        organizationId: 'org-1',
      },
    },
    organization: { id: 'org-1', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, caller: app.createCaller(context).pharmacySales };
}

beforeEach(() => {
  vi.mocked(createSale).mockReset();
  vi.mocked(addSaleLine).mockReset();
  vi.mocked(linkCustomerToSale).mockReset();
});

describe('counter sale admission (DEV-607)', () => {
  it('refuses an unassigned cashier before a bill is created', async () => {
    const { db, caller } = fixture({ capabilities: ['pharmacy:counter'], assignedBranches: [] });
    await expect(caller.create({ branchId: BRANCH, deviceId: DEVICE })).rejects.toMatchObject(
      OUTSIDE
    );
    expect(createSale).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('refuses an unassigned cashier before any stock is allocated', async () => {
    const { db, caller } = fixture({ capabilities: ['pharmacy:counter'], assignedBranches: [] });
    await expect(caller.addLine(line)).rejects.toMatchObject(OUTSIDE);
    expect(addSaleLine).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a cashier assigned only to another branch', async () => {
    const { caller } = fixture({
      capabilities: ['pharmacy:counter'],
      assignedBranches: ['branch-other'],
    });
    await expect(caller.create({ branchId: BRANCH, deviceId: DEVICE })).rejects.toMatchObject(
      OUTSIDE
    );
    await expect(caller.addLine(line)).rejects.toMatchObject(OUTSIDE);
    expect(createSale).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('gives create, addLine and counterCart the same answer for an unassigned cashier', async () => {
    const { caller } = fixture({ capabilities: ['pharmacy:counter'], assignedBranches: [] });
    const refusals = await Promise.all([
      caller.create({ branchId: BRANCH, deviceId: DEVICE }).catch((error: unknown) => error),
      caller.addLine(line).catch((error: unknown) => error),
      caller.counterCart({ branchId: BRANCH, saleId: 'sale-1' }).catch((error: unknown) => error),
    ]);
    for (const refusal of refusals) expect(refusal).toMatchObject(OUTSIDE);
  });

  it.each([['pharmacy:procurement'], ['pharmacy:inventory'], ['reports:financial']])(
    'refuses an assigned member with only %s before any sale write',
    async (capability) => {
      const { db, caller } = fixture({ capabilities: [capability], assignedBranches: [BRANCH] });
      await expect(caller.create({ branchId: BRANCH, deviceId: DEVICE })).rejects.toMatchObject(
        NO_CAPABILITY
      );
      await expect(caller.addLine(line)).rejects.toMatchObject(NO_CAPABILITY);
      expect(createSale).not.toHaveBeenCalled();
      expect(addSaleLine).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );

  it('admits an assigned cashier to create a bill and add a line', async () => {
    const { caller } = fixture({ capabilities: ['pharmacy:counter'], assignedBranches: [BRANCH] });
    vi.mocked(createSale).mockResolvedValue({ id: 'sale-1' } as never);
    vi.mocked(addSaleLine).mockResolvedValue({ line: { id: 'line-1' }, allocation: {} } as never);

    await expect(caller.create({ branchId: BRANCH, deviceId: DEVICE })).resolves.toEqual({
      id: 'sale-1',
    });
    await caller.addLine(line);

    const scope = { organizationId: 'org-1', branchId: BRANCH, actorId: 'cashier-1' };
    // DEV-725: the last argument is the drawer precondition, run inside createSale.
    expect(createSale).toHaveBeenCalledWith(expect.anything(), scope, false, expect.any(Function));
    expect(addSaleLine).toHaveBeenCalledOnce();
    expect(vi.mocked(addSaleLine).mock.calls[0]![1]).toEqual(scope);
  });

  it('keeps the organization administrator able to open a bill on any active branch', async () => {
    const { caller } = fixture({
      capabilities: ['pharmacy:counter'],
      assignedBranches: [],
      role: 'ADMIN',
    });
    vi.mocked(createSale).mockResolvedValue({ id: 'sale-1' } as never);
    await expect(caller.create({ branchId: BRANCH, deviceId: DEVICE })).resolves.toEqual({
      id: 'sale-1',
    });
    expect(createSale).toHaveBeenCalledOnce();
  });
});

describe('DEV-830 counter branch scope (security scan F04)', () => {
  const link = { branchId: BRANCH, saleId: 'sale-1', patientId: 'patient-1', displayName: 'A' };

  it('refuses to link a customer on a branch the cashier is not assigned to', async () => {
    const { caller } = fixture({
      capabilities: ['pharmacy:counter'],
      assignedBranches: ['branch-other'],
    });
    await expect(caller.linkCustomer(link)).rejects.toMatchObject(OUTSIDE);
    expect(linkCustomerToSale).not.toHaveBeenCalled();
  });

  it('refuses to link a customer for a member without a counter capability', async () => {
    const { caller } = fixture({
      capabilities: ['pharmacy:inventory'],
      assignedBranches: [BRANCH],
    });
    await expect(caller.linkCustomer(link)).rejects.toMatchObject(NO_CAPABILITY);
    expect(linkCustomerToSale).not.toHaveBeenCalled();
  });

  it('links a customer for a cashier assigned to the branch', async () => {
    const { caller } = fixture({ capabilities: ['pharmacy:counter'], assignedBranches: [BRANCH] });
    vi.mocked(linkCustomerToSale).mockResolvedValue({ linked: true } as never);
    await expect(caller.linkCustomer(link)).resolves.toEqual({ linked: true });
    expect(vi.mocked(linkCustomerToSale).mock.calls[0]![1]).toEqual({
      organizationId: 'org-1',
      branchId: BRANCH,
      actorId: 'cashier-1',
    });
  });

  it('lists only the branches a member is actively assigned to', async () => {
    const { db, caller } = fixture({ capabilities: ['pharmacy:counter'], assignedBranches: [] });
    await caller.counterBranches();
    expect(db.pharmacyBranch.findMany.mock.calls.at(-1)![0].where).toEqual({
      organizationId: 'org-1',
      active: true,
      branchAssignments: { some: { organizationId: 'org-1', userId: 'cashier-1', active: true } },
    });
  });

  it('lists every active branch for the organization administrator', async () => {
    const { db, caller } = fixture({
      capabilities: ['pharmacy:counter'],
      assignedBranches: [],
      role: 'ADMIN',
    });
    await caller.counterBranches();
    expect(db.pharmacyBranch.findMany.mock.calls.at(-1)![0].where).toEqual({
      organizationId: 'org-1',
      active: true,
    });
  });
});
