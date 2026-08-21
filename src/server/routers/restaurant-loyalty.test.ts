import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  annotateAudit: vi.fn(),
  configure: vi.fn(),
  enroll: vi.fn(),
  adjust: vi.fn(),
  redeem: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: mocks.annotateAudit,
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/lib/restaurant/loyalty', () => ({
  LoyaltyError: class LoyaltyError extends Error {},
  listLoyaltyPrograms: vi.fn(async () => []),
  getLoyaltyProgram: vi.fn(),
  listLoyaltyAccounts: vi.fn(async () => []),
  getLoyaltyAccount: vi.fn(),
  enrollLoyaltyAccount: mocks.enroll,
  listLoyaltyEntries: vi.fn(async () => []),
  getLoyaltyEntry: vi.fn(),
  configureLoyaltyProgram: mocks.configure,
  adjustLoyaltyPoints: mocks.adjust,
  redeemLoyaltyPoints: mocks.redeem,
}));

import { restaurantLoyaltyRouter } from './restaurant-loyalty';

function caller() {
  return restaurantLoyaltyRouter.createCaller({
    db: {} as never,
    entitlements: {
      enabledModules: ['restaurant-crm-loyalty'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
      limits: { 'loyalty.activeCustomers.max': 25_000 },
    },
    session: {
      expires: 'later',
      user: { id: 'user_1', role: 'EMPLOYEE', department: 'OPERATIONS', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

beforeEach(() => {
  mocks.can.mockReset().mockResolvedValue(true);
  mocks.annotateAudit.mockReset();
  mocks.configure.mockReset().mockResolvedValue({
    id: 'program_1',
    versionNumber: 1,
    earnRate: { toString: () => '1.25' },
    redemptionValue: { toString: () => '0.01' },
  });
  mocks.adjust.mockReset().mockResolvedValue({ id: 'adjust_1' });
  mocks.enroll.mockReset().mockResolvedValue({ id: 'account_1' });
  mocks.redeem.mockReset().mockResolvedValue({
    entryId: 'redeem_1',
    value: { toFixed: () => '1.00' },
  });
});

describe('loyalty tRPC boundary', () => {
  it('rejects unknown configure keys and non-string Decimal values', async () => {
    await expect(
      caller().configure({
        effectiveFrom: '2026-08-21T00:00:00.000Z',
        earnRate: '1',
        redemptionValue: '0.01',
        sneaky: true,
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().configure({
        effectiveFrom: '2026-08-21T00:00:00.000Z',
        earnRate: 1.25,
        redemptionValue: '0.01',
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('gates configure/adjust and redeem with distinct server capabilities', async () => {
    await caller().configure({
      effectiveFrom: '2026-08-21T00:00:00.000Z',
      earnRate: '1.25',
      redemptionValue: '0.01',
    });
    await caller().adjust({
      accountId: 'account_1',
      points: 5,
      reason: 'service recovery',
      idempotencyKey: 'adjust_1',
    });
    await caller().enrollAccount({ customerId: 'customer_1' });
    await caller().redeem({
      accountId: 'account_1',
      billId: 'bill_1',
      points: 100,
      idempotencyKey: 'redeem_1',
    });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'restaurant:configure',
      undefined,
      expect.anything()
    );
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'loyalty:redeem',
      undefined,
      expect.anything()
    );
    expect(mocks.enroll).toHaveBeenCalledWith(expect.anything(), {
      customerId: 'customer_1',
      activeCustomersMax: 25_000,
    });
    expect(mocks.adjust).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorId: 'user_1', reason: 'service recovery' })
    );
    expect(mocks.redeem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorId: 'user_1' })
    );
  });

  it('rejects unknown redemption keys before domain work', async () => {
    await expect(
      caller().redeem({
        accountId: 'account_1',
        billId: 'bill_1',
        points: 10,
        idempotencyKey: 'redeem_1',
        amount: '999',
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.redeem).not.toHaveBeenCalled();
  });
});
