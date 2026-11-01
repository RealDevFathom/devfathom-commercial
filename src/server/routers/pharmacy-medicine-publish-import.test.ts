/**
 * Publication must leave a medicine importable by barcode: the reviewed `pack`
 * value becomes a pack size with its unit count, and the reviewed barcode is
 * stored on that pack size (not only on the presentation). The opening-stock
 * importer then matches exactly one pack by that barcode.
 *
 * In-memory delegates stand in for one tenant's rows, so the router and the
 * importer read the same records without a database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const guards = vi.hoisted(() => ({ hasModule: vi.fn(() => true), annotateAudit: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: guards.hasModule,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: guards.annotateAudit,
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { pharmacyMedicineRouter } from './pharmacy-medicine';
import type { TRPCContext } from '../trpc';
import { previewOwnerImport } from '@/lib/pharmacy/migration/owner-import';
import type { OwnerImportInput } from '@/lib/pharmacy/migration/owner-import-input';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const ORG = 'org_publish_import';
const BARCODE = '8964000123456';

type Row = Record<string, unknown> & { id: string };

const rights = {
  acquisition: 'Owner supplied',
  cache: 'Tenant only',
  redistribution: 'None',
  deletion: 'On request',
};

function envelope(value: string) {
  return {
    value,
    connectorId: 'manual-file',
    sourceLabel: 'Owner reference file',
    batchId: 'batch-1',
    rowSourceKey: 'row-1',
    rights,
    blockingIssues: [],
  };
}

function makeStore(values: Record<string, string>) {
  let sequence = 0;
  const next = (prefix: string) => `${prefix}_${++sequence}`;
  const medicines: Row[] = [
    {
      id: 'medicine_amoxil',
      organizationId: ORG,
      productName: 'Amoxil',
      productFamily: 'PHARMACEUTICAL',
      saleable: false,
      coldChain: false,
      drapRegistrationNumber: null,
    },
  ];
  const provenance: Row[] = Object.entries(values).map(([field, value]) => ({
    id: `assertion_${field}`,
    medicineId: 'medicine_amoxil',
    field,
    status: 'ACCEPTED',
    reviewer: 'pharmacist',
    supersedesId: null,
    assertedValue: envelope(value),
  }));
  const presentations: Row[] = [];
  const packLevels: Row[] = [];
  const barcodes: Row[] = [];
  const created = { barcodes: 0 };

  const presentationOf = (id: unknown) => presentations.find((item) => item.id === id)!;
  const medicineOf = (id: unknown) => medicines.find((item) => item.id === id)!;

  const db = {
    user: {
      findUnique: vi.fn(async () => ({ organizationRole: null, permissionOverrides: [] })),
    },
    medicineProvenance: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        provenance.filter((item) => where.id.in.includes(item.id))
      ),
    },
    medicinePublicationEntry: {
      findFirst: vi.fn(async () => null),
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
    },
    medicineReviewDecision: {
      findMany: vi.fn(async () => [
        { payload: { assertionIds: provenance.map((item) => item.id) } },
      ]),
    },
    medicinePublicationBatch: {
      create: vi.fn(async () => ({ id: 'publication_1', status: 'DRAFT' })),
      update: vi.fn(async ({ data }: { data: object }) => ({ id: 'publication_1', ...data })),
    },
    medicine: {
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) =>
        medicineOf(where.id)
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) =>
        Object.assign(medicineOf(where.id), data)
      ),
    },
    ingredient: {
      upsert: vi.fn(async ({ create }: { create: object }) => ({ id: 'ingredient_1', ...create })),
    },
    presentation: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          presentations.find((item) => item.id === where.id) ?? null
      ),
      create: vi.fn(async ({ data }: { data: object }) => {
        const row = { id: next('presentation'), organizationId: ORG, ...data };
        presentations.push(row);
        return row;
      }),
    },
    medicineStrengthComponent: { create: vi.fn(async () => ({ id: 'strength_1' })) },
    medicineAlias: { create: vi.fn(async () => ({ id: 'alias_1' })) },
    packLevel: {
      create: vi.fn(async ({ data }: { data: object }) => {
        const row = {
          id: next('pack'),
          organizationId: ORG,
          parentPackLevelId: null,
          effectiveTo: null,
          referencedAt: null,
          ...data,
        };
        packLevels.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const pack = packLevels.find((item) => item.id === where.id);
        if (!pack) return null;
        return {
          ...pack,
          presentation: { medicineId: presentationOf(pack.presentationId).medicineId },
          barcodes: barcodes.filter((item) => item.packLevelId === pack.id),
          children: packLevels.filter((item) => item.parentPackLevelId === pack.id),
          supersededBy: packLevels.filter((item) => item.supersedesPackLevelId === pack.id),
        };
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; unitsPerParent: number; referencedAt: null; effectiveTo: null };
          data: { unitsPerParent: number };
        }) => {
          const matches = packLevels.filter(
            (item) =>
              item.id === where.id &&
              item.unitsPerParent === where.unitsPerParent &&
              item.referencedAt === null &&
              item.effectiveTo === null
          );
          for (const item of matches) Object.assign(item, data);
          return { count: matches.length };
        }
      ),
      count: vi.fn(
        async ({ where }: { where: { parentPackLevelId: string } }) =>
          packLevels.filter((item) => item.parentPackLevelId === where.parentPackLevelId).length
      ),
    },
    medicineBarcode: {
      findFirst: vi.fn(async ({ where }: { where: { normalizedCode: string } }) => {
        const row = barcodes.find((item) => item.normalizedCode === where.normalizedCode);
        return row
          ? { ...row, presentation: { medicineId: presentationOf(row.presentationId).medicineId } }
          : null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        // The tenant-wide unique index on normalizedCode (schema.prisma).
        if (barcodes.some((item) => item.normalizedCode === data.normalizedCode))
          throw new Error('Unique constraint failed on normalizedCode');
        created.barcodes += 1;
        const row = { id: next('barcode'), organizationId: ORG, packLevelId: null, ...data };
        barcodes.push(row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
          Object.assign(barcodes.find((item) => item.id === where.id)!, data)
      ),
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        const before = barcodes.length;
        for (const id of where.id.in) {
          const index = barcodes.findIndex((item) => item.id === id);
          if (index >= 0) barcodes.splice(index, 1);
        }
        return { count: before - barcodes.length };
      }),
    },
  };
  return Object.assign(db, {
    $transaction: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
    rows: { medicines, presentations, packLevels, barcodes, created },
  });
}

type Store = ReturnType<typeof makeStore>;

function caller(store: Store) {
  return pharmacyMedicineRouter.createCaller({
    db: store,
    entitlements: {
      organizationId: ORG,
      enabledModules: ['pharmacy-core'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: { expires: 'later', user: { id: 'admin', role: 'ADMIN', status: 'ACTIVE' } },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

/** The importer's reads, served from the same rows the publication wrote. */
function importDb(store: Store) {
  const { packLevels, barcodes, presentations, medicines } = store.rows;
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyBranch: { findFirst: vi.fn(async () => ({ id: 'branch' })) },
    pharmacyStockLocation: {
      findFirst: vi.fn(async () => ({ id: 'location', coldChain: false })),
    },
    pharmacyOpeningSession: { findFirst: vi.fn(async () => null) },
    pharmacyStockMovement: { count: vi.fn(async () => 0) },
    pharmacyManufacturingBatch: { findFirst: vi.fn(async () => null) },
    pharmacyInventoryLot: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    packLevel: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            organizationId: string;
            OR: [{ id: string }, { barcodes: { some: { organizationId: string; code: string } } }];
          };
        }) => {
          const [byId, byBarcode] = where.OR;
          return packLevels
            .filter((pack) => pack.organizationId === where.organizationId)
            .filter(
              (pack) =>
                pack.id === byId.id ||
                barcodes.some(
                  (code) =>
                    code.packLevelId === pack.id &&
                    code.organizationId === byBarcode.barcodes.some.organizationId &&
                    code.code === byBarcode.barcodes.some.code
                )
            )
            .slice(0, 2)
            .map((pack) => {
              const presentation = presentations.find((item) => item.id === pack.presentationId)!;
              return {
                ...pack,
                presentation: {
                  ...presentation,
                  medicine: medicines.find((item) => item.id === presentation.medicineId)!,
                  packLevels: packLevels.filter((item) => item.presentationId === presentation.id),
                },
              };
            });
        }
      ),
    },
  } as unknown as ScopedDb;
}

const importMapping = {
  sourceRef: 0,
  pack: 1,
  batch: 2,
  expiry: 3,
  mrp: 4,
  cost: 5,
  expected: 6,
  counted: 7,
  varianceNote: 8,
};

function stockFile(packReference: string): OwnerImportInput {
  const csv = `Source,Pack,Batch,Expiry,MRP,Cost,Expected,Counted,Note\nQA-OPEN-1,${packReference},QA-B001,2099-06-30,50,3,100,100,`;
  return {
    fileName: 'opening.csv',
    content: Buffer.from(csv).toString('base64'),
    branchId: 'branch',
    stockLocationId: 'location',
    mapping: importMapping,
  };
}

const reviewed = {
  productName: 'Amoxil',
  strength: '500 mg',
  dosageForm: 'Capsule',
  pack: '10 capsules',
  drapRegistrationNumber: '012345',
  barcode: BARCODE,
};

beforeEach(() => {
  guards.hasModule.mockReturnValue(true);
  guards.annotateAudit.mockClear();
});

describe('publish, then import opening stock by barcode', () => {
  it('creates the default pack with its unit count and the import matches it by barcode', async () => {
    const store = makeStore(reviewed);
    await caller(store).publishAssertions({
      assertionIds: Object.keys(reviewed).map((field) => `assertion_${field}`),
    });

    const [pack] = store.rows.packLevels;
    expect(store.rows.packLevels).toHaveLength(1);
    expect(pack).toMatchObject({
      presentationId: store.rows.presentations[0]!.id,
      level: 'BOX',
      unitsPerParent: 10,
      version: 1,
      parentPackLevelId: null,
    });
    expect(store.rows.barcodes).toEqual([
      expect.objectContaining({ code: BARCODE, packLevelId: pack!.id, type: 'GTIN' }),
    ]);
    expect(store.rows.medicines[0]).toMatchObject({ saleable: true });

    const preview = await previewOwnerImport(
      importDb(store),
      { organizationId: ORG, branchId: 'branch', actorId: 'owner' },
      stockFile(BARCODE)
    );
    expect(preview.blockers).toEqual([]);
    expect(preview.lines[0]).toMatchObject({
      packLevelId: pack!.id,
      medicineId: 'medicine_amoxil',
      unitsPerPack: 10,
      countedUnits: 100,
      errors: [],
    });
    expect(preview.canCommit).toBe(true);
  });

  it('moves this medicine’s own unpacked barcode onto the pack instead of inserting a duplicate', async () => {
    const store = makeStore(reviewed);
    store.rows.presentations.push({ id: 'old_presentation', medicineId: 'medicine_amoxil' });
    store.rows.barcodes.push({
      id: 'legacy_barcode',
      organizationId: ORG,
      presentationId: 'old_presentation',
      packLevelId: null,
      type: 'GTIN',
      code: BARCODE,
      normalizedCode: BARCODE,
    });
    await caller(store).publishAssertions({
      assertionIds: Object.keys(reviewed).map((field) => `assertion_${field}`),
    });
    const pack = store.rows.packLevels[0]!;
    expect(store.rows.created.barcodes).toBe(0);
    expect(store.rows.barcodes).toEqual([
      expect.objectContaining({ id: 'legacy_barcode', packLevelId: pack.id }),
    ]);
  });

  it('refuses a barcode that belongs to another medicine', async () => {
    const store = makeStore(reviewed);
    store.rows.presentations.push({ id: 'other_presentation', medicineId: 'medicine_other' });
    store.rows.barcodes.push({
      id: 'other_barcode',
      organizationId: ORG,
      presentationId: 'other_presentation',
      packLevelId: null,
      type: 'GTIN',
      code: BARCODE,
      normalizedCode: BARCODE,
    });
    await expect(
      caller(store).publishAssertions({
        assertionIds: Object.keys(reviewed).map((field) => `assertion_${field}`),
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(store.rows.created.barcodes).toBe(0);
    expect(store.rows.barcodes[0]).toMatchObject({ presentationId: 'other_presentation' });
  });

  it('blocks publication when the pack size has no safe unit count', async () => {
    const store = makeStore({ ...reviewed, pack: 'Box of 3 strips of 10' });
    await expect(
      caller(store).publishAssertions({
        assertionIds: Object.keys(reviewed).map((field) => `assertion_${field}`),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: /Pack size/ });
    expect(store.rows.packLevels).toHaveLength(0);
    expect(store.rows.medicines[0]).toMatchObject({ saleable: false });
  });
});

describe('setPackBarcode', () => {
  async function publishedWithout(barcode?: string) {
    const values: Record<string, string> = { ...reviewed };
    if (barcode === undefined) delete values.barcode;
    const store = makeStore(values);
    await caller(store).publishAssertions({
      assertionIds: Object.keys(values).map((field) => `assertion_${field}`),
    });
    return { store, pack: store.rows.packLevels[0]! };
  }

  it('attaches a barcode to a published pack so the import matches it', async () => {
    const { store, pack } = await publishedWithout();
    expect(store.rows.barcodes).toHaveLength(0);
    await caller(store).setPackBarcode({ packLevelId: pack.id, code: ' 5012345678900 ' });
    expect(store.rows.barcodes).toEqual([
      expect.objectContaining({ code: '5012345678900', packLevelId: pack.id }),
    ]);
    const preview = await previewOwnerImport(
      importDb(store),
      { organizationId: ORG, branchId: 'branch', actorId: 'owner' },
      stockFile('5012345678900')
    );
    expect(preview.canCommit).toBe(true);
    expect(guards.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetType: 'PackLevel', targetId: pack.id })
    );
  });

  it('replaces the pack’s previous barcode when edited', async () => {
    const { store, pack } = await publishedWithout(BARCODE);
    await caller(store).setPackBarcode({ packLevelId: pack.id, code: '5012345678900' });
    expect(store.rows.barcodes).toEqual([
      expect.objectContaining({ code: '5012345678900', packLevelId: pack.id }),
    ]);
  });

  it('refuses a barcode already on another medicine and leaves both rows intact', async () => {
    const { store, pack } = await publishedWithout(BARCODE);
    store.rows.presentations.push({ id: 'other_presentation', medicineId: 'medicine_other' });
    store.rows.barcodes.push({
      id: 'other_barcode',
      organizationId: ORG,
      presentationId: 'other_presentation',
      packLevelId: null,
      type: 'GTIN',
      code: '777',
      normalizedCode: '777',
    });
    await expect(
      caller(store).setPackBarcode({ packLevelId: pack.id, code: '777' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(store.rows.barcodes.map((item) => item.code).sort()).toEqual(['777', BARCODE].sort());
  });

  it('reports a pack outside this workspace as not found', async () => {
    const { store } = await publishedWithout();
    await expect(
      caller(store).setPackBarcode({ packLevelId: 'foreign_pack', code: '123' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('pack chains built after publication, then imported', () => {
  const scope = { organizationId: ORG, branchId: 'branch', actorId: 'owner' };

  async function publishedBox() {
    // "10 x 10" publishes one BOX of 100 individual units.
    const store = makeStore({ ...reviewed, pack: '10 x 10' });
    await caller(store).publishAssertions({
      assertionIds: Object.keys(reviewed).map((field) => `assertion_${field}`),
    });
    const box = store.rows.packLevels[0]!;
    expect(box).toMatchObject({ level: 'BOX', unitsPerParent: 100 });
    return { store, box };
  }

  async function unitsFor(store: Store, reference: string) {
    const preview = await previewOwnerImport(importDb(store), scope, stockFile(reference));
    return preview.lines[0]!;
  }

  it('imports every level of a nested chain built from printed totals', async () => {
    const { store, box } = await publishedBox();
    const strip = (
      await caller(store).addInnerPackLevel({
        parentPackLevelId: box.id,
        versionGroupId: 'strip-group',
        level: 'STRIP',
        totalUnits: 10,
      })
    ).pack;
    const unit = (
      await caller(store).addInnerPackLevel({
        parentPackLevelId: strip.id,
        versionGroupId: 'unit-group',
        level: 'UNIT',
        totalUnits: 1,
      })
    ).pack;
    expect(
      store.rows.packLevels.map((item) => [item.level, item.unitsPerParent, item.parentPackLevelId])
    ).toEqual([
      ['BOX', 10, null],
      ['STRIP', 10, box.id],
      ['UNIT', 1, strip.id],
    ]);
    expect(guards.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetType: 'PackLevel',
        targetId: box.id,
        changes: expect.objectContaining({ unitsPerParent: { before: 100, after: 10 } }),
      })
    );
    await caller(store).setPackBarcode({ packLevelId: strip.id, code: '5012345678900' });

    expect(await unitsFor(store, BARCODE)).toMatchObject({
      packLevelId: box.id, unitsPerPack: 100, errors: [],
    });
    expect(await unitsFor(store, '5012345678900')).toMatchObject({
      packLevelId: strip.id, unitsPerPack: 10, errors: [],
    });
    expect(await unitsFor(store, unit.id)).toMatchObject({
      packLevelId: unit.id, unitsPerPack: 1, errors: [],
    });
  });

  it('refuses an inner pack that does not divide the outer total, leaving the outer pack', async () => {
    const { store, box } = await publishedBox();
    await expect(
      caller(store).addInnerPackLevel({
        parentPackLevelId: box.id,
        versionGroupId: 'strip-group',
        level: 'STRIP',
        totalUnits: 30,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: /whole number/ });
    expect(store.rows.packLevels).toHaveLength(1);
    expect(box).toMatchObject({ unitsPerParent: 100 });
  });

  it('refuses a second inner pack, a referenced outer pack, and a foreign pack', async () => {
    const { store, box } = await publishedBox();
    await caller(store).addInnerPackLevel({
      parentPackLevelId: box.id,
      versionGroupId: 'strip-group',
      level: 'STRIP',
      totalUnits: 10,
    });
    await expect(
      caller(store).addInnerPackLevel({
        parentPackLevelId: box.id,
        versionGroupId: 'other-group',
        level: 'STRIP',
        totalUnits: 5,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: /innermost/ });

    const referenced = await publishedBox();
    referenced.box.referencedAt = new Date('2026-10-01');
    await expect(
      caller(referenced.store).addInnerPackLevel({
        parentPackLevelId: referenced.box.id,
        versionGroupId: 'strip-group',
        level: 'STRIP',
        totalUnits: 10,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: /locked/ });
    expect(referenced.box).toMatchObject({ unitsPerParent: 100 });

    await expect(
      caller(store).addInnerPackLevel({
        parentPackLevelId: 'foreign_pack',
        versionGroupId: 'strip-group',
        level: 'STRIP',
        totalUnits: 10,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('imports flat packs created side by side when their totals divide evenly', async () => {
    const { store, box } = await publishedBox();
    const flat = async (level: 'STRIP' | 'UNIT', unitsPerParent: number) =>
      caller(store).createPackLevel({
        presentationId: box.presentationId as string,
        versionGroupId: `${level}-group`,
        level,
        unitsPerParent,
        effectiveFrom: new Date('2020-01-01'),
      });
    const strip = await flat('STRIP', 10);
    const unit = await flat('UNIT', 1);
    expect(store.rows.packLevels.every((item) => item.parentPackLevelId === null)).toBe(true);
    await caller(store).setPackBarcode({ packLevelId: strip.id, code: '5012345678900' });

    expect(await unitsFor(store, BARCODE)).toMatchObject({
      packLevelId: box.id, unitsPerPack: 100, errors: [],
    });
    expect(await unitsFor(store, '5012345678900')).toMatchObject({
      packLevelId: strip.id, unitsPerPack: 10, errors: [],
    });
    expect(await unitsFor(store, unit.id)).toMatchObject({
      packLevelId: unit.id, unitsPerPack: 1, errors: [],
    });
  });

  it('refuses flat packs whose totals do not divide evenly', async () => {
    const { store, box } = await publishedBox();
    await caller(store).createPackLevel({
      presentationId: box.presentationId as string,
      versionGroupId: 'strip-group',
      level: 'STRIP',
      unitsPerParent: 30,
      effectiveFrom: new Date('2020-01-01'),
    });
    const line = await unitsFor(store, BARCODE);
    expect(line.unitsPerPack).toBeNull();
    expect(line.errors).toEqual([expect.stringMatching(/do not divide evenly/)]);
  });
});
