import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  licensed: vi.fn(),
  annotateAudit: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  queryRaw: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.licensed,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
  annotateAudit: mocks.annotateAudit,
}));
import type { TRPCContext } from '@/server/trpc';
import { pharmacyLoyaltyRouter } from './loyalty-router';

function caller() {
  const db = {
    $queryRaw: mocks.queryRaw,
    $transaction: (run: (tx: unknown) => unknown) => run(db),
    pharmacyLoyaltyProgramVersion: {
      findFirst: mocks.findFirst,
      findMany: mocks.findMany,
      create: mocks.create,
    },
  };
  return pharmacyLoyaltyRouter.createCaller({
    db,
    session: {
      expires: 'later',
      user: { id: 'owner-a', organizationId: 'org-a', role: 'ADMIN', status: 'ACTIVE' },
    },
    entitlements: { organizationId: 'org-a', modules: [], enabledModules: ['pharmacy-crm'] },
    organization: { id: 'org-a' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

const prior = {
  id: 'program-1',
  version: 1,
  earnMode: 'PERCENT_OF_SPEND',
  earnPoints: 100,
  perSpendMinor: 1_000_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.licensed.mockReturnValue(true);
  mocks.findFirst.mockResolvedValue(prior);
  mocks.findMany.mockResolvedValue([prior]);
  mocks.queryRaw.mockResolvedValue([]);
  mocks.create.mockImplementation(async ({ data }) => ({ id: 'program-2', ...data }));
});

describe('DEV-746 owner earning rate', () => {
  it.each([
    [{ option: 'percent-2' }, 'PERCENT_OF_SPEND', 200, 1_000_000],
    [{ option: 'step-1000' }, 'POINTS_PER_SPEND_STEP', 1, 100_000],
    [{ option: 'custom-percent', percent: '1.25' }, 'PERCENT_OF_SPEND', 125, 1_000_000],
    [{ option: 'custom-step', stepPoints: 3, stepRupees: 500 }, 'POINTS_PER_SPEND_STEP', 3, 50_000],
  ])('appends the next version for %j', async (input, earnMode, earnPoints, perSpendMinor) => {
    await expect(caller().setEarnRate(input)).resolves.toMatchObject({ version: 2 });
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org-a',
        version: 2,
        earnMode,
        earnPoints,
        perSpendMinor,
        actorId: 'owner-a',
      },
    });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'pharmacyLoyalty.setEarnRate',
        targetId: 'program-2',
        changes: {
          earnRule: {
            before: expect.objectContaining({ version: 1, earnPoints: 100 }),
            after: expect.objectContaining({ version: 2, earnMode, earnPoints, perSpendMinor }),
          },
        },
      })
    );
  });

  it.each([
    { option: 'custom-percent', percent: '100.01' },
    { option: 'custom-percent', percent: '0' },
    { option: 'custom-percent' },
    { option: 'custom-step', stepPoints: 2, stepRupees: 1 },
    { option: 'custom-step', stepPoints: 1 },
  ])('refuses %j on the server before writing', async (input) => {
    await expect(caller().setEarnRate(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('refuses an unknown option and caller-supplied scope', async () => {
    await expect(caller().setEarnRate({ option: 'percent-100' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller().setEarnRate({ option: 'percent-1', organizationId: 'org-b' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('lets only an authorized owner change the rate', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().setEarnRate({ option: 'percent-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('reads the current version and its dated history for this tenant', async () => {
    await expect(caller().earnRate()).resolves.toEqual({ current: prior, versions: [prior] });
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-a' }, orderBy: { version: 'desc' } })
    );
  });
});
