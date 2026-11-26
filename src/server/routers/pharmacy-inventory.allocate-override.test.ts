/**
 * #520 — `pharmacyInventory.allocateForSale` writes the same allocation-override record as the
 * counter. Its FEFO-override approval must be server-verified too, never caller-supplied text.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  allocateForSale: vi.fn(),
  can: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(), withTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/abac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/abac')>()),
  can: mocks.can,
}));
vi.mock('@/lib/pharmacy/stock-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/stock-ledger')>()),
  allocateForSale: mocks.allocateForSale,
}));

import { pharmacyInventoryRouter } from './pharmacy-inventory';
import type { TRPCContext } from '../trpc';

const actor = { id: 'user_a', organizationId: 'org_a', status: 'ACTIVE', role: 'EMPLOYEE' };
const request = {
  branchId: 'branch_a',
  medicineId: 'medicine_1',
  requiredUnits: 10,
  idempotencyKeyPrefix: 'sale-1',
};
const override = { inventoryLotId: 'lot_later', reason: 'Customer wants longer dating' };

function fixture() {
  const transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  const db = {
    $transaction: transaction,
    organization: { findFirst: vi.fn().mockResolvedValue({ requireApprovalAuthenticator: false }) },
    user: { findFirst: vi.fn().mockResolvedValue(actor) },
    restaurantOperatorCredential: { findFirst: vi.fn() },
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        (where.id?.in ?? []).map((id) => ({ id }))
      ),
    },
    pharmacyBranchAssignment: { findFirst: vi.fn().mockResolvedValue({ id: 'assignment_a' }) },
  };
  const caller = pharmacyInventoryRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules: ['pharmacy-inventory'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: { expires: 'later', user: { ...actor } },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
  return { db, transaction, caller };
}

/** The actor holds `pharmacy:inventory`; `dispense` decides whether they are a pharmacist. */
function actorCan({ dispense }: { dispense: boolean }) {
  mocks.can.mockImplementation(
    async (_subject: unknown, action: string) => action !== 'pharmacy:dispense' || dispense
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.allocateForSale.mockResolvedValue({ allocations: [], overrideId: 'override_1' });
});

describe('pharmacyInventory.allocateForSale FEFO override approval (#520)', () => {
  it('refuses a caller-supplied approval policy before any stock is touched', async () => {
    const f = fixture();
    actorCan({ dispense: true });
    await expect(
      f.caller.allocateForSale({
        ...request,
        override: { ...override, approvalPolicy: 'PHARMACIST_PIN:pharmacist_1' },
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.transaction).not.toHaveBeenCalled();
    expect(mocks.allocateForSale).not.toHaveBeenCalled();
  });

  it('records the pharmacist on duty as a server-derived approval', async () => {
    const f = fixture();
    actorCan({ dispense: true });
    await f.caller.allocateForSale({ ...request, override });
    expect(mocks.allocateForSale).toHaveBeenCalledOnce();
    const [, scope, input] = mocks.allocateForSale.mock.calls[0]!;
    expect(scope).toEqual({ organizationId: 'org_a', branchId: 'branch_a', actorId: 'user_a' });
    expect(input.override).toEqual({ ...override, approvalPolicy: 'PHARMACIST_ON_DUTY' });
  });

  it('refuses an inventory-only override without a pharmacist PIN, before the transaction', async () => {
    const f = fixture();
    actorCan({ dispense: false });
    await expect(f.caller.allocateForSale({ ...request, override })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'A non-FEFO batch needs a pharmacist to approve it with their PIN.',
    });
    expect(f.transaction).not.toHaveBeenCalled();
    expect(mocks.allocateForSale).not.toHaveBeenCalled();
  });

  it('re-checks the approver inside the stock transaction', async () => {
    const f = fixture();
    // A pharmacist before the transaction, no longer one when the allocation re-checks.
    mocks.can.mockImplementation(async (_subject: unknown, action: string) => {
      if (action !== 'pharmacy:dispense') return true;
      return f.transaction.mock.calls.length === 0;
    });
    await expect(f.caller.allocateForSale({ ...request, override })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.transaction).toHaveBeenCalledOnce();
    expect(mocks.allocateForSale).not.toHaveBeenCalled();
  });

  it('allocates plain FEFO without any approval check', async () => {
    const f = fixture();
    actorCan({ dispense: false });
    await f.caller.allocateForSale(request);
    const [, , input] = mocks.allocateForSale.mock.calls[0]!;
    expect(input.override).toBeUndefined();
    expect(mocks.can).not.toHaveBeenCalledWith(
      expect.anything(),
      'pharmacy:dispense',
      undefined,
      expect.anything()
    );
  });
});
