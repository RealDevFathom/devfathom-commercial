import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (view: { enabledModules: string[] }, key: string) => view.enabledModules.includes(key),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
import { pharmacyStagedReviewRouter } from './pharmacy-staged-review';
import type { TRPCContext } from '../trpc';

const scope = { branchId: 'branch_a', sourceId: 'source_a', batchId: 'batch_a' };
function makeDb() {
  const row = {
    id: 'row_a',
    productName: 'Example',
    packLabel: null,
    sourceKey: 'key',
    rowNumber: 1,
    rawPayload: { QTY: '1.0000' },
    quantityCanonical: null,
    exceptions: [],
  };
  return {
    user: {
      count: vi.fn().mockResolvedValue(2),
      findUnique: vi
        .fn()
        .mockResolvedValue({
          role: 'ADMIN',
          status: 'ACTIVE',
          organizationId: 'org_a',
          organizationRole: null,
          permissionOverrides: [],
        }),
    },
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch_a' }),
      findMany: vi.fn().mockResolvedValue([{ id: 'branch_a', name: 'Branch' }]),
    },
    pharmacyMigrationBatch: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'batch_a',
        label: 'Example',
        status: 'PROFILED',
        profilerVersion: '1',
        source: { id: 'source_a', fileName: 'synthetic', contentHash: 'a'.repeat(64) },
      }),
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([]),
    },
    pharmacyMigrationRow: {
      findMany: vi.fn().mockResolvedValue([row]),
      findFirst: vi.fn().mockResolvedValue(row),
      count: vi.fn().mockResolvedValue(26),
    },
    pharmacyMigrationException: { groupBy: vi.fn().mockResolvedValue([]) },
  };
}
let db = makeDb();
function caller(
  options: {
    role?: string;
    status?: string;
    tenant?: string;
    enabled?: boolean;
    revoked?: boolean;
  } = {}
) {
  db.user.findUnique.mockResolvedValue({
    role: options.role ?? 'ADMIN',
    status: options.status ?? 'ACTIVE',
    organizationId: 'org_a',
    organizationRole: null,
    permissionOverrides: [],
  });
  return pharmacyStagedReviewRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules: options.enabled === false ? [] : ['pharmacy-core'],
      modules: [],
    },
    session: {
      expires: 'later',
      user: {
        id: 'user_a',
        organizationId: options.tenant ?? 'org_a',
        role: options.role ?? 'ADMIN',
        status: options.status ?? 'ACTIVE',
        sessionRevoked: options.revoked,
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacyMedicine;
}
beforeEach(() => {
  db = makeDb();
});
describe('staged review authorization and reads', () => {
  it.each([
    { role: 'EMPLOYEE' },
    { status: 'INACTIVE' },
    { revoked: true },
    { tenant: 'org_b' },
    { enabled: false },
  ])('denies invalid actor before reading sources: %j', async (options) => {
    await expect(caller(options).stagedRows(scope)).rejects.toBeDefined();
    expect(db.pharmacyMigrationBatch.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyMigrationRow.findMany).not.toHaveBeenCalled();
  });
  it('rejects branch substitution before reading source or batch', async () => {
    db.pharmacyBranch.findFirst.mockResolvedValue(null);
    await expect(caller().stagedRows(scope)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyBranch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org_a', id: 'branch_a', active: true } })
    );
    expect(db.pharmacyMigrationBatch.findFirst).not.toHaveBeenCalled();
  });
  it('rejects wrong source/batch pairing before rows are read', async () => {
    db.pharmacyMigrationBatch.findFirst.mockResolvedValue(null);
    await expect(caller().stagedRows(scope)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.pharmacyMigrationBatch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org_a',
          id: 'batch_a',
          sourceId: 'source_a',
          source: { organizationId: 'org_a' },
        },
      })
    );
    expect(db.pharmacyMigrationRow.findMany).not.toHaveBeenCalled();
  });
  it('applies tenant, stable pagination, literal search and stock filter; reads need no mutation methods', async () => {
    const output = await caller().stagedRows({
      ...scope,
      page: 2,
      query: 'Example',
      filter: 'stock',
    });
    expect(output.rows[0].references.QTY).toBe('1.0000');
    expect(output.total).toBe(26);
    expect(db.pharmacyMigrationRow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 25,
        take: 25,
        orderBy: [{ rowNumber: 'asc' }, { id: 'asc' }],
        where: expect.objectContaining({
          organizationId: 'org_a',
          batchId: 'batch_a',
          targetModelKey: 'med.product',
          OR: expect.arrayContaining([
            { productName: { contains: 'Example', mode: 'insensitive' } },
          ]),
          exceptions: {
            some: {
              organizationId: 'org_a',
              status: 'OPEN',
              bucket: { in: ['MISSING_BATCH', 'MISSING_EXPIRY'] },
            },
          },
        }),
      })
    );
  });
  it('includes retained collision flags when targetNaturalKey is null', async () => {
    await caller().stagedRows({ ...scope, filter: 'collision' });
    expect(JSON.stringify(db.pharmacyMigrationRow.findMany.mock.calls)).toContain(
      'NORMALIZED_NAME_COLLISION_NO_MERGE'
    );
  });
  it('scopes detail to the selected tenant and batch', async () => {
    db.pharmacyMigrationRow.findFirst.mockResolvedValue(null);
    await expect(caller().stagedDetail({ ...scope, rowId: 'foreign' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(db.pharmacyMigrationRow.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org_a',
          batchId: 'batch_a',
          id: 'foreign',
          targetModelKey: 'med.product',
        },
      })
    );
  });
  it.each([0, -1, 1.5, 10001])('rejects invalid page %s', async (page) => {
    await expect(caller().stagedRows({ ...scope, page })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(db.pharmacyBranch.findFirst).not.toHaveBeenCalled();
  });
  it('rejects oversized searches and injected fields', async () => {
    await expect(caller().stagedRows({ ...scope, query: 'a'.repeat(121) })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller().stagedRows({ ...scope, organizationId: 'org_b' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
  it('concurrent reads return separate candidates unchanged', async () => {
    const [one, two] = await Promise.all([caller().stagedRows(scope), caller().stagedRows(scope)]);
    expect(one).toEqual(two);
    expect(one.rows[0].sellable).toBe(false);
  });
});
