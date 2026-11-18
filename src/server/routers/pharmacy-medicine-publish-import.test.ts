/**
 * Publication must leave a medicine importable by barcode: the reviewed `pack`
 * value becomes a pack size with its unit count, and the reviewed barcode is
 * stored on that pack size (not only on the presentation). The opening-stock
 * importer then matches exactly one pack by that barcode.
 *
 * In-memory delegates stand in for one tenant's rows, so the router and the
 * importer read the same records without a database. Barcode UPDATE and DELETE
 * throw, as the `pharmacy_barcodes_append_only` trigger does in Postgres.
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

function makeStore(values: Record<string, string>, sourceType?: 'IMPORT' | 'REGULATOR') {
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
      updatedAt: new Date('2026-01-01'),
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
    ...(sourceType ? { sourceType } : {}),
  }));
  const edits: Row[] = [];
  const presentations: Row[] = [];
  const packLevels: Row[] = [];
  const barcodes: Row[] = [];
  const created = { barcodes: 0 };

  const presentationOf = (id: unknown) => presentations.find((item) => item.id === id)!;
  const medicineOf = (id: unknown) => medicines.find((item) => item.id === id)!;

  const db = {
    user: {
      // The reviewer holds the exact grant that catalogue approval requires (DEV-19).
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        organizationRole: null,
        permissionOverrides:
          where.id === 'reviewer'
            ? [{ capability: 'pharmacy:catalogue-review', effect: 'ALLOW' }]
            : [],
      })),
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
    auditLog: { create: vi.fn(async () => ({ id: 'audit' })) },
    pharmacyCatalogueEdit: {
      create: vi.fn(async ({ data }: { data: object }) => {
        const edit = { id: next('edit'), status: 'PENDING', ...data };
        edits.push(edit);
        return edit;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        edits.find((row) => row.id === where.id)
      ),
      count: vi.fn(
        async ({ where }: { where: { medicineId: string; status: string; id: { not: string } } }) =>
          edits.filter(
            (row) =>
              (row as { medicineId?: string }).medicineId === where.medicineId &&
              row.status === where.status &&
              row.id !== where.id.not
          ).length
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string; status: string }; data: object }) => {
          const edit = edits.find((row) => row.id === where.id && row.status === where.status);
          if (!edit) return { count: 0 };
          Object.assign(edit, data);
          return { count: 1 };
        }
      ),
    },
    medicine: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => medicineOf(where.id)),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string; updatedAt: Date }; data: object }) => {
          const medicine = medicineOf(where.id);
          if (medicine.updatedAt !== where.updatedAt) return { count: 0 };
          Object.assign(medicine, data);
          return { count: 1 };
        }
      ),
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
        };
      }),
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
      // pharmacy_barcodes_append_only (migration 20260902130000) rejects these.
      update: vi.fn(async () => {
        throw new Error('pharmacy_medicine_barcodes is append-only');
      }),
      deleteMany: vi.fn(async () => {
        throw new Error('pharmacy_medicine_barcodes is append-only');
      }),
    },
  };
  return Object.assign(db, {
    $transaction: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
    rows: { medicines, presentations, packLevels, barcodes, created, edits },
  });
}

type Store = ReturnType<typeof makeStore>;

function caller(store: Store, actorId = 'admin') {
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
    session: {
      expires: 'later',
      user: { id: actorId, role: 'ADMIN', status: 'ACTIVE', organizationId: ORG },
    },
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

  it('refuses to move this medicine’s own unpacked barcode, since barcode rows are append-only', async () => {
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
    await expect(
      caller(store).publishAssertions({
        assertionIds: Object.keys(reviewed).map((field) => `assertion_${field}`),
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: /cannot be moved/ });
    expect(store.rows.created.barcodes).toBe(0);
    expect(store.rows.barcodes).toEqual([
      expect.objectContaining({ id: 'legacy_barcode', packLevelId: null }),
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

  it.each([
    'Box of 3 strips of 10',
    '2 x 10 strips',
    '2×10 blisters',
    '2 * 10 boxes',
    '2 x 10 cartons',
    '2 x 10 packs',
    '2 x 10 packets',
    '1 x 10 strip',
    '1 x 10 x 10 carton',
    '100 grams tube',
    '100 millilitres bottle',
    '2 x 100 grams tubes',
    '10 x 5 millilitres ampoules',
  ])('blocks publication when %j has no safe unit count', async (pack) => {
    const store = makeStore({ ...reviewed, pack });
    await expect(
      caller(store).publishAssertions({
        assertionIds: Object.keys(reviewed).map((field) => `assertion_${field}`),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: /Pack size/ });
    expect(store.rows.presentations).toHaveLength(0);
    expect(store.rows.packLevels).toHaveLength(0);
    expect(store.rows.barcodes).toHaveLength(0);
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
    const edit = await caller(store).setPackBarcode({
      packLevelId: pack.id,
      code: ' 5012345678900 ',
    });
    expect(edit).toMatchObject({ status: 'PENDING' });
    expect(store.rows.barcodes).toHaveLength(0);
    await caller(store, 'reviewer').decideCatalogueEdit({ editId: edit.id, decision: 'APPROVE' });
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

  it('refuses to replace a pack’s barcode, keeping the append-only row', async () => {
    const { store, pack } = await publishedWithout(BARCODE);
    await expect(
      caller(store).setPackBarcode({ packLevelId: pack.id, code: '5012345678900' })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: /cannot be replaced/ });
    expect(store.rows.barcodes).toEqual([
      expect.objectContaining({ code: BARCODE, packLevelId: pack.id }),
    ]);
  });

  it('returns the existing row without writing when the same code is submitted again', async () => {
    const { store, pack } = await publishedWithout(BARCODE);
    const row = await caller(store).setPackBarcode({ packLevelId: pack.id, code: BARCODE });
    expect(row).toMatchObject({ code: BARCODE, packLevelId: pack.id });
    expect(store.medicineBarcode.update).not.toHaveBeenCalled();
    expect(store.medicineBarcode.deleteMany).not.toHaveBeenCalled();
    expect(guards.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetId: pack.id,
        changes: { barcode: { before: [BARCODE], after: [BARCODE] } },
      })
    );
  });

  it('refuses packs that are superseded or not yet in effect', async () => {
    const { store, pack } = await publishedWithout();
    pack.effectiveTo = new Date('2020-01-01');
    await expect(
      caller(store).setPackBarcode({ packLevelId: pack.id, code: '5012345678900' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: /not in effect/ });
    pack.effectiveTo = null;
    pack.effectiveFrom = new Date('2099-01-01');
    await expect(
      caller(store).setPackBarcode({ packLevelId: pack.id, code: '5012345678900' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: /not in effect/ });
    expect(store.rows.barcodes).toHaveLength(0);
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

  it('imports flat packs created side by side when their totals divide evenly', async () => {
    const { store, box } = await publishedBox();
    const flat = async (level: 'STRIP' | 'UNIT', unitsPerParent: number) => {
      const edit = await caller(store).createPackLevel({
        presentationId: box.presentationId as string,
        versionGroupId: `${level}-group`,
        level,
        unitsPerParent,
        effectiveFrom: new Date('2020-01-01'),
      });
      expect(edit).toMatchObject({ status: 'PENDING' });
      await caller(store, 'reviewer').decideCatalogueEdit({ editId: edit.id, decision: 'APPROVE' });
      return store.rows.packLevels.at(-1)!;
    };
    const strip = await flat('STRIP', 10);
    const unit = await flat('UNIT', 1);
    expect(store.rows.packLevels.every((item) => item.parentPackLevelId === null)).toBe(true);
    const edit = await caller(store).setPackBarcode({
      packLevelId: strip.id,
      code: '5012345678900',
    });
    await caller(store, 'reviewer').decideCatalogueEdit({ editId: edit.id, decision: 'APPROVE' });

    expect(await unitsFor(store, BARCODE)).toMatchObject({
      packLevelId: box.id,
      unitsPerPack: 100,
      errors: [],
    });
    expect(await unitsFor(store, '5012345678900')).toMatchObject({
      packLevelId: strip.id,
      unitsPerPack: 10,
      errors: [],
    });
    expect(await unitsFor(store, unit.id)).toMatchObject({
      packLevelId: unit.id,
      unitsPerPack: 1,
      errors: [],
    });
  });

  it('reports a second pending edit on the same item as stale once the first is approved', async () => {
    const { store, box } = await publishedBox();
    const queue = (level: 'STRIP' | 'UNIT', unitsPerParent: number) =>
      caller(store).createPackLevel({
        presentationId: box.presentationId as string,
        versionGroupId: `${level}-group`,
        level,
        unitsPerParent,
        effectiveFrom: new Date('2020-01-01'),
      });
    const first = await queue('STRIP', 10);
    const second = await queue('UNIT', 1);
    const packs = store.rows.packLevels.length;

    await expect(
      caller(store, 'reviewer').decideCatalogueEdit({ editId: first.id, decision: 'APPROVE' })
    ).resolves.toEqual({ id: first.id, status: 'APPROVED', staleEdits: 1 });
    expect(store.rows.packLevels).toHaveLength(packs + 1);

    await expect(
      caller(store, 'reviewer').decideCatalogueEdit({ editId: second.id, decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: /out of date/ });
    // The refused approval created nothing; the database rolls back its claim.
    expect(store.rows.packLevels).toHaveLength(packs + 1);
  });

  it('imports independent side-by-side packs on their own totals even when they do not divide', async () => {
    const { store, box } = await publishedBox();
    const edit = await caller(store).createPackLevel({
      presentationId: box.presentationId as string,
      versionGroupId: 'box-30-group',
      level: 'BOX',
      unitsPerParent: 30,
      effectiveFrom: new Date('2020-01-01'),
    });
    expect(await unitsFor(store, BARCODE)).toMatchObject({
      packLevelId: box.id,
      unitsPerPack: 100,
      errors: [],
    });
    await caller(store, 'reviewer').decideCatalogueEdit({ editId: edit.id, decision: 'APPROVE' });
    const other = store.rows.packLevels.at(-1)!;
    expect(await unitsFor(store, other.id)).toMatchObject({
      packLevelId: other.id,
      unitsPerPack: 30,
      errors: [],
    });
  });
});

describe('DEV-766 front-shop publication', () => {
  it('publishes a reviewed front-shop item without fabricating strength or ingredients', async () => {
    const values = { productName: 'Baby lotion', dosageForm: 'Bottle', pack: '200 ml bottle' };
    const store = makeStore(values);
    store.rows.medicines[0]!.productFamily = 'FRONT_SHOP';
    await caller(store).publishAssertions({
      assertionIds: Object.keys(values).map((field) => `assertion_${field}`),
    });
    expect(store.rows.medicines[0]).toMatchObject({ saleable: true, productName: 'Baby lotion' });
    expect(store.medicineStrengthComponent.create).not.toHaveBeenCalled();
    expect(store.ingredient.upsert).not.toHaveBeenCalled();
    expect(store.rows.packLevels).toEqual([expect.objectContaining({ unitsPerParent: 1 })]);
  });
  it('still requires strength for medicines', async () => {
    const values = {
      productName: 'Amoxil',
      dosageForm: 'Capsule',
      pack: '10 capsules',
      drapRegistrationNumber: '012345',
    };
    const store = makeStore(values);
    await expect(
      caller(store).publishAssertions({
        assertionIds: Object.keys(values).map((field) => `assertion_${field}`),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Publication requires strength.' });
    expect(store.rows.medicines[0]).toMatchObject({ saleable: false });
  });
});

describe('DEV-852 imported medicines without strength or registration', () => {
  const legacy = { productName: 'Amoxil', dosageForm: 'Capsule', pack: '10 capsules' };
  const publish = (store: Store, values: Record<string, string>) =>
    caller(store).publishAssertions({
      assertionIds: Object.keys(values).map((field) => `assertion_${field}`),
    });

  it('publishes an imported medicine with neither value, leaving both not recorded', async () => {
    const store = makeStore(legacy, 'IMPORT');
    await publish(store, legacy);
    expect(store.rows.medicines[0]).toMatchObject({ saleable: true });
    // Prisma leaves an undefined column unchanged, so the registration stays null.
    expect(store.rows.medicines[0]!.drapRegistrationNumber ?? null).toBeNull();
    expect(store.medicineStrengthComponent.create).not.toHaveBeenCalled();
    expect(store.rows.packLevels).toEqual([expect.objectContaining({ unitsPerParent: 10 })]);
  });

  it('publishes an imported medicine missing only one of the two values', async () => {
    const withStrength = { ...legacy, strength: '500 mg' };
    const store = makeStore(withStrength, 'IMPORT');
    await publish(store, withStrength);
    expect(store.rows.medicines[0]).toMatchObject({ saleable: true });
    expect(store.rows.medicines[0]!.drapRegistrationNumber ?? null).toBeNull();
    expect(store.medicineStrengthComponent.create).toHaveBeenCalledTimes(1);

    const withRegistration = { ...legacy, drapRegistrationNumber: '012345' };
    const other = makeStore(withRegistration, 'IMPORT');
    await publish(other, withRegistration);
    expect(other.rows.medicines[0]).toMatchObject({
      saleable: true,
      drapRegistrationNumber: '012345',
    });
    expect(other.medicineStrengthComponent.create).not.toHaveBeenCalled();
  });

  it('publishes an imported medicine that has both values exactly as before', async () => {
    const values = { ...legacy, strength: '500 mg', drapRegistrationNumber: '012345' };
    const store = makeStore(values, 'IMPORT');
    await publish(store, values);
    expect(store.rows.medicines[0]).toMatchObject({
      saleable: true,
      drapRegistrationNumber: '012345',
    });
    expect(store.medicineStrengthComponent.create).toHaveBeenCalledTimes(1);
  });

  it('keeps the schedule flags of an imported controlled, prescription-only medicine', async () => {
    const values = { ...legacy, rx: 'true', controlled: 'true' };
    const store = makeStore(values, 'IMPORT');
    await publish(store, values);
    expect(store.rows.medicines[0]).toMatchObject({ saleable: true, rx: true, controlled: true });
  });

  it('still blocks an imported medicine with no dosage form, pack or an unreadable strength', async () => {
    const noForm = { productName: 'Amoxil', pack: '10 capsules' };
    const store = makeStore(noForm, 'IMPORT');
    await expect(publish(store, noForm)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Publication requires dosageForm.',
    });
    const badStrength = { ...legacy, strength: 'strong' };
    const other = makeStore(badStrength, 'IMPORT');
    await expect(publish(other, badStrength)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: /Strength cannot be safely structured/,
    });
    expect(store.rows.medicines[0]).toMatchObject({ saleable: false });
    expect(other.rows.medicines[0]).toMatchObject({ saleable: false });
  });

  it('still requires strength and registration when the identity came from the regulator', async () => {
    const store = makeStore(legacy, 'REGULATOR');
    await expect(publish(store, legacy)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Publication requires strength.',
    });
    const noRegistration = { ...legacy, strength: '500 mg' };
    const other = makeStore(noRegistration, 'REGULATOR');
    await expect(publish(other, noRegistration)).rejects.toThrow();
    expect(other.rows.medicines[0]).toMatchObject({ saleable: false });
  });
});
