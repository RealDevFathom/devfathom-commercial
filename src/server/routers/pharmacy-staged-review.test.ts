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
  annotateAudit: vi.fn(),
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
    $transaction: vi.fn(async (run) => run(db)),
    pharmacyMigrationSource: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi
        .fn()
        .mockResolvedValue({ id: 'source_a', kind: 'EXCEL_CSV', contentHash: 'a'.repeat(64) }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ organizationRole: null, permissionOverrides: [] }),
    },
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch_a' }),
      findMany: vi.fn().mockResolvedValue([{ id: 'branch_a', name: 'Branch' }]),
    },
    pharmacyMigrationBatch: {
      create: vi.fn().mockResolvedValue({ id: 'batch_new' }),
      update: vi.fn().mockResolvedValue({}),
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
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([row]),
      findFirst: vi.fn().mockResolvedValue(row),
      count: vi.fn().mockResolvedValue(26),
    },
    pharmacyMigrationException: {
      createMany: vi.fn().mockResolvedValue({}),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
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

const staging = {
  branchId: 'branch_a',
  fileName: 'legacy.csv',
  content: Buffer.from('Product,Pack,Qty\nExample,30,29').toString('base64'),
  mapping: { product: 0, pack: 1, quantity: 2 },
  quantityUnit: 'PACKS' as const,
};
describe('production batch staging', () => {
  it('imports a NARCOTICS-class row as controlled with no review hold (DEV-854)', async () => {
    const csv = [
      'Name,classname,saleprice,purprice,QTY',
      'Synthetic Opioid 50mg, narcotics ,450.00,380.50,12',
      'Synthetic Paracetamol,Example Distributors,35.00,28.00,120',
    ].join('\n');
    db.$queryRaw.mockResolvedValue([{ id: 'med_opioid' }]);
    const saved = await caller().stageBatch({
      ...staging,
      content: Buffer.from(csv).toString('base64'),
      mapping: { product: 0, mrp: 2, cost: 3, quantity: 4 },
      quantityUnit: 'UNITS',
    });
    expect(saved).toMatchObject({ controlledFromClass: 1, controlledMedicinesFlagged: 1 });
    // One tenant-scoped update, keyed only by the NARCOTICS row's normalized name.
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    const [, ...params] = db.$queryRaw.mock.calls[0]!;
    expect(params).toContain('org_a');
    expect(JSON.stringify(params)).toContain('"synthetic opioid 50mg"');
    expect(JSON.stringify(params)).not.toContain('paracetamol');
    // Prices are imported as values, not held for confirmation.
    expect(db.pharmacyMigrationRow.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ mrpMinor: BigInt(45000), costMinor: BigInt(38050) }),
        expect.objectContaining({ mrpMinor: BigInt(3500), costMinor: BigInt(2800) }),
      ],
    });
    // Nothing is held: no exception is raised for the controlled class or its prices.
    const held = JSON.stringify(
      db.pharmacyMigrationException.createMany.mock.calls,
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value)
    );
    expect(held).not.toMatch(/MISSING_MRP|controlled|narcotic/i);
  });
  it('flags nothing when no row is in the NARCOTICS class', async () => {
    const saved = await caller().stageBatch(staging);
    expect(saved).toMatchObject({ controlledFromClass: 0, controlledMedicinesFlagged: 0 });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
  it.each(['PACKS', 'UNITS'] as const)(
    'persists the explicit %s choice on the batch',
    async (quantityUnit) => {
      const saved = await caller().stageBatch({ ...staging, quantityUnit });
      expect(saved.batchId).toBe('batch_new');
      expect(db.pharmacyMigrationBatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ quantityUnit }),
      });
      expect(db.pharmacyMigrationRow.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            quantityCanonical: BigInt(quantityUnit === 'PACKS' ? 870 : 29),
            rawPayload: expect.objectContaining({ Qty: '29' }),
          }),
        ],
      });
      expect(db.$transaction).toHaveBeenCalledOnce();
      expect(db.pharmacyMigrationBatch.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'batch_new' } })
      );
    }
  );
  it.each([undefined, '', 'boxes'])(
    'rejects missing/invalid quantity choice %s before any writes',
    async (quantityUnit) => {
      await expect(
        caller().stageBatch({ ...staging, quantityUnit } as never)
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(db.pharmacyMigrationSource.create).not.toHaveBeenCalled();
      expect(db.pharmacyMigrationBatch.create).not.toHaveBeenCalled();
    }
  );
  it.each(['__source_row', '__source_sha256'])(
    'rejects an upload whose header shadows lineage evidence (%s)',
    async (header) => {
      await expect(
        caller().stageBatch({
          ...staging,
          content: Buffer.from(`Product,Pack,Qty,${header}\nExample,30,29,x`).toString('base64'),
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(db.pharmacyMigrationBatch.create).not.toHaveBeenCalled();
    }
  );
  it('never invents a pack factor', async () => {
    await caller().stageBatch({
      ...staging,
      content: Buffer.from('Product,Pack,Qty\nExample,,29').toString('base64'),
    });
    expect(db.pharmacyMigrationRow.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ quantityCanonical: null })],
    });
    expect(db.pharmacyMigrationException.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ bucket: 'UNIT_AMBIGUOUS', severity: 'BLOCKING' }),
      ]),
    });
  });
  it.each([{ role: 'EMPLOYEE' }, { enabled: false }, { tenant: 'org_b' }, { status: 'INACTIVE' }])(
    'denies staging for %j',
    async (options) => {
      await expect(caller(options).stageBatch(staging)).rejects.toBeDefined();
      expect(db.pharmacyMigrationSource.create).not.toHaveBeenCalled();
    }
  );
  it('rejects a foreign branch before any writes', async () => {
    db.pharmacyBranch.findFirst.mockResolvedValue(null);
    await expect(caller().stageBatch(staging)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyMigrationBatch.create).not.toHaveBeenCalled();
  });
  it.each([
    { product: 0, pack: 1, quantity: 1 },
    { product: 0, quantity: 39 },
  ])('rejects invalid column mapping %j', async (mapping) => {
    await expect(caller().stageBatch({ ...staging, mapping })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(db.pharmacyMigrationBatch.create).not.toHaveBeenCalled();
  });
});
