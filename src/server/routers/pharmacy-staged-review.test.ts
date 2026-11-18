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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pharmacyStagedReviewRouter } from './pharmacy-staged-review';
import { syntheticLegacyCatalogue } from '@/lib/pharmacy/migration/fixtures/synthetic-legacy-catalogue';
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
    $executeRaw: vi.fn().mockResolvedValue(0),
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

describe('DEV-851 legacy catalogue staging', () => {
  const legacy = readFileSync(
    join(process.cwd(), 'src/lib/pharmacy/migration/fixtures/legacy-catalogue-export-synthetic.csv')
  );
  const catalogue = Buffer.from(syntheticLegacyCatalogue(18_933));
  const legacyStaging = {
    branchId: 'branch_a',
    fileName: 'legacy-catalogue.csv',
    content: gzipSync(catalogue).toString('base64'),
    encoding: 'gzip' as const,
    mapping: { product: 0, pack: 3, mrp: 4, cost: 5, quantity: 6 },
    quantityUnit: 'PACKS' as const,
  };

  it('suggests the column mapping for the legacy export headers', async () => {
    const read = await caller().stagingUpload({
      branchId: 'branch_a',
      fileName: 'legacy.csv',
      content: legacy.toString('base64'),
    });
    expect(read).toEqual({
      headers: [
        'Name',
        'aliasname',
        'Company',
        'PackUnits',
        'saleprice',
        'purprice',
        'QTY',
        'active',
      ],
      rowCount: 6,
      mapping: { product: 0, pack: 3, quantity: 6, mrp: 4, cost: 5 },
    });
  });

  it('stages all 18,933 products in one batch, in bounded inserts, with no stock', async () => {
    const saved = await caller().stageBatch(legacyStaging);

    expect(saved).toMatchObject({ batchId: 'batch_new', rowCount: 18_933, replayed: false });
    const rowCalls = db.pharmacyMigrationRow.createMany.mock.calls as unknown as [
      { data: { productName: string; rawPayload: Record<string, string> }[] },
    ][];
    expect(rowCalls).toHaveLength(19);
    expect(rowCalls.every(([call]) => call.data.length <= 1_000)).toBe(true);
    const staged = rowCalls.flatMap(([call]) => call.data);
    expect(staged).toHaveLength(18_933);
    expect(staged[18_932]).toMatchObject({
      rawPayload: expect.objectContaining({ aliasname: 'LC-018933' }),
    });
    // The whole stage is one transaction with room for a catalogue-sized write.
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect((db.$transaction.mock.calls[0] as unknown[])[1]).toMatchObject({ timeout: 180_000 });
    expect(db.pharmacyMigrationBatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        profilerVersion: 'manual-columns/3;cost=5,mrp=4,pack=3,product=0,quantity=6',
        quantityUnit: 'PACKS',
      }),
    });
  });

  it('replays an earlier batch for the same file, columns and quantity choice', async () => {
    db.pharmacyMigrationSource.findFirst.mockResolvedValue({
      id: 'source_prev',
      kind: 'EXCEL_CSV',
      fileName: 'legacy-catalogue.csv',
      byteSize: BigInt(catalogue.length),
      contentHash: 'b'.repeat(64),
    });
    db.pharmacyMigrationBatch.findMany.mockResolvedValue([
      { id: 'batch_prev', rowCount: 18_933, exceptionCount: 37_866 },
    ]);

    const saved = await caller().stageBatch(legacyStaging);

    expect(saved).toMatchObject({
      sourceId: 'source_prev',
      batchId: 'batch_prev',
      rowCount: 18_933,
      replayed: true,
    });
    expect(db.$executeRaw).toHaveBeenCalledOnce();
    expect(db.pharmacyMigrationBatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org_a',
          sourceId: 'source_prev',
          profilerVersion: 'manual-columns/3;cost=5,mrp=4,pack=3,product=0,quantity=6',
          quantityUnit: 'PACKS',
          status: 'PROFILED',
        },
      })
    );
    expect(db.pharmacyMigrationSource.create).not.toHaveBeenCalled();
    expect(db.pharmacyMigrationBatch.create).not.toHaveBeenCalled();
    expect(db.pharmacyMigrationRow.createMany).not.toHaveBeenCalled();
  });

  it('refuses a compressed upload that expands past the file limit before any writes', async () => {
    await expect(
      caller().stageBatch({
        ...legacyStaging,
        content: gzipSync(Buffer.alloc(9 * 1024 * 1024, 0x61)).toString('base64'),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.pharmacyMigrationBatch.create).not.toHaveBeenCalled();
  });
});
