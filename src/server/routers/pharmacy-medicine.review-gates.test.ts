/**
 * DEV-923 (DEV-19 follow-up): a single administrator can no longer change a pack
 * price or publish catalogue content alone.
 *
 * - setPackPrice is a reviewed catalogue edit: queued, and written only when a
 *   different reviewer approves it, or a solo owner approves with a fresh PIN.
 * - recordReviewDecision, publishAssertions and supersedePublication are reviewer
 *   work: tenant administration alone is not enough, they need the exact
 *   pharmacy:catalogue-review grant, except for a solo owner.
 *
 * The ABAC engine is real; only the solo-owner lookup and the PIN check are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const guards = vi.hoisted(() => ({
  solo: vi.fn(async () => false),
  pin: vi.fn(async () => 'OK'),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/solo-owner', () => ({ isSoloPharmacyOwner: guards.solo }));
vi.mock('@/lib/pharmacy/owner-data-export-pin', () => ({ verifyOwnerExportPin: guards.pin }));

import { pharmacyMedicineRouter } from './pharmacy-medicine';
import type { TRPCContext } from '../trpc';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };

const REVIEW_GRANT: Rule[] = [{ capability: 'pharmacy:catalogue-review', effect: 'ALLOW' }];
const REVIEW_DENY: Rule[] = [
  ...REVIEW_GRANT,
  { capability: 'pharmacy:catalogue-review', effect: 'DENY' },
];

const PRICE = {
  packLevelId: 'pack_a',
  mrpMinor: 50_000,
  sellingPriceMinor: 45_000,
  effectiveFrom: new Date('2030-01-01T00:00:00Z'),
};

function makeDb() {
  const grants = new Map<string, Rule[]>();
  const edits: Array<Record<string, unknown> & { id: string }> = [];
  const db = {
    grants,
    edits,
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        organizationRole: null,
        permissionOverrides: grants.get(where.id) ?? [],
      })),
    },
    $queryRaw: vi.fn(async () => []),
    medicine: {
      findFirst: vi.fn(async () => ({
        id: 'medicine_a',
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        drapRegistrationNumber: 'REG-1',
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      count: vi.fn(async () => 1),
    },
    packLevel: {
      findFirst: vi.fn(async () => ({
        id: 'pack_a',
        presentationId: 'presentation_a',
        presentation: { id: 'presentation_a', organizationId: 'org_a', medicineId: 'medicine_a' },
      })),
    },
    pharmacyBranch: { findFirst: vi.fn(async () => ({ id: 'branch_a' })) },
    pharmacyPackPrice: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'price_1',
        ...data,
      })),
    },
    pharmacyCatalogueEdit: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const edit = { id: `edit_${edits.length + 1}`, status: 'PENDING', ...data };
        edits.push(edit);
        return edit;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        edits.find((edit) => edit.id === where.id)
      ),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
        const edit = edits.find((item) => item.id === where.id && item.status === 'PENDING');
        if (!edit) return { count: 0 };
        Object.assign(edit, data);
        return { count: 1 };
      }),
      count: vi.fn(async () => 0),
    },
    auditLog: { create: vi.fn(async () => ({ id: 'audit' })) },
    medicineProvenance: {
      findMany: vi.fn(async () => [] as unknown[]),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(async ({ data }: { data: object }) => ({ id: 'reviewed', ...data })),
    },
    medicineReviewDecision: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: object }) => ({ id: 'decision', ...data })),
    },
    medicinePublicationEntry: { findFirst: vi.fn(async () => null) },
    medicinePublicationBatch: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(),
    },
  };
  return Object.assign(db, {
    $transaction: vi.fn(async (run: (tx: typeof db) => unknown) => run(db)),
  });
}

let db = makeDb();

function caller(actorId = 'editor', grants: Rule[] = []) {
  db.grants.set(actorId, grants);
  return pharmacyMedicineRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules: ['pharmacy-core'],
      activeSeats: 2,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: actorId, role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_a' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

function auditActions() {
  return db.auditLog.create.mock.calls.map(
    (call) => (call as unknown as [{ data: { action: string } }])[0].data.action
  );
}

beforeEach(() => {
  db = makeDb();
  guards.solo.mockReset().mockResolvedValue(false);
  guards.pin.mockReset().mockResolvedValue('OK');
});

describe('DEV-923: a pack price is a reviewed catalogue edit', () => {
  it('queues an administrator’s pack price and writes no price', async () => {
    const edit = await caller().setPackPrice(PRICE);

    expect(edit).toMatchObject({
      status: 'PENDING',
      operation: 'setPackPrice',
      medicineId: 'medicine_a',
      editorId: 'editor',
    });
    expect(db.pharmacyPackPrice.create).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('refuses a selling price above the MRP before queueing it', async () => {
    await expect(
      caller().setPackPrice({ ...PRICE, sellingPriceMinor: PRICE.mrpMinor + 1 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyCatalogueEdit.create).not.toHaveBeenCalled();
  });

  it('refuses a pack outside this workspace before queueing it', async () => {
    db.packLevel.findFirst.mockResolvedValueOnce(null as never);
    await expect(caller().setPackPrice(PRICE)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.pharmacyCatalogueEdit.create).not.toHaveBeenCalled();
  });

  it('does not let the administrator who set the price approve it alone', async () => {
    const edit = await caller().setPackPrice(PRICE);

    await expect(
      caller().decideCatalogueEdit({ editId: edit.id, decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A PIN does not help an administrator who is not a solo owner.
    await expect(
      caller().decideCatalogueEdit({ editId: edit.id, decision: 'APPROVE', soloPin: '2468' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(guards.pin).not.toHaveBeenCalled();
    expect(db.pharmacyPackPrice.create).not.toHaveBeenCalled();
    expect(db.edits[0]).toMatchObject({ status: 'PENDING' });
  });

  it('writes the price only when a different reviewer approves, and audits the approval', async () => {
    const edit = await caller().setPackPrice({ ...PRICE, branchId: 'branch_a' });

    await expect(
      caller('reviewer').decideCatalogueEdit({ editId: edit.id, decision: 'APPROVE' })
    ).resolves.toMatchObject({ status: 'APPROVED' });

    expect(db.pharmacyPackPrice.create).toHaveBeenCalledOnce();
    expect(db.pharmacyPackPrice.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        packLevelId: 'pack_a',
        branchId: 'branch_a',
        mrpMinor: 50_000,
        sellingPriceMinor: 45_000,
        effectiveFrom: PRICE.effectiveFrom,
        isOverride: true,
      }),
    });
    expect(db.edits[0]).toMatchObject({
      status: 'APPROVED',
      editorId: 'editor',
      reviewerId: 'reviewer',
      soloPinVerifiedAt: null,
    });
    expect(auditActions()).toEqual(
      expect.arrayContaining(['pharmacyMedicine.setPackPrice', 'pharmacy.catalogueApproval'])
    );
  });

  it('writes no price when the reviewer rejects it', async () => {
    const edit = await caller().setPackPrice(PRICE);
    await caller('reviewer').decideCatalogueEdit({ editId: edit.id, decision: 'REJECT' });
    expect(db.pharmacyPackPrice.create).not.toHaveBeenCalled();
    expect(db.edits[0]).toMatchObject({ status: 'REJECTED' });
  });

  it('lets a solo owner approve their own price only with a fresh PIN, audited', async () => {
    guards.solo.mockResolvedValue(true);
    const edit = await caller('owner').setPackPrice(PRICE);

    await expect(
      caller('owner').decideCatalogueEdit({ editId: edit.id, decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    guards.pin.mockResolvedValueOnce('INVALID');
    await expect(
      caller('owner').decideCatalogueEdit({ editId: edit.id, decision: 'APPROVE', soloPin: '0000' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyPackPrice.create).not.toHaveBeenCalled();

    await caller('owner').decideCatalogueEdit({
      editId: edit.id,
      decision: 'APPROVE',
      soloPin: '2468',
    });
    expect(db.pharmacyPackPrice.create).toHaveBeenCalledOnce();
    expect(db.edits[0]).toMatchObject({
      status: 'APPROVED',
      reviewerId: 'owner',
      soloPinVerifiedAt: expect.any(Date),
    });
    expect(auditActions()).toContain('pharmacy.catalogueSoloOwnerApproval');
  });
});

describe('DEV-923: reviewing and publishing need the catalogue review permission', () => {
  const unreviewed = {
    id: 'assertion',
    medicineId: 'medicine_a',
    editorId: 'editor',
    supersededBy: [],
    supersedesId: null,
    field: 'productName',
    source: 'Owner file',
    sourceType: 'IMPORT',
    retrievedAt: new Date('2026-01-01'),
    status: 'UNREVIEWED',
    confidence: null,
    reviewer: null,
    assertedValue: { value: 'Amoxil' },
  };
  const review = {
    duplicateKey: 'fixture',
    action: 'ACCEPT' as const,
    medicineIds: ['medicine_a'],
    payload: { assertionIds: ['assertion'] },
  };
  const procedures = [
    ['recordReviewDecision', (c: ReturnType<typeof caller>) => c.recordReviewDecision(review)],
    [
      'publishAssertions',
      (c: ReturnType<typeof caller>) => c.publishAssertions({ assertionIds: ['assertion'] }),
    ],
    [
      'supersedePublication',
      (c: ReturnType<typeof caller>) => c.supersedePublication({ batchId: 'batch' }),
    ],
  ] as const;

  it.each(procedures)(
    'refuses %s to an administrator without the review permission',
    async (_name, run) => {
      await expect(run(caller('reviewer'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(procedures)('refuses %s under an explicit review DENY', async (_name, run) => {
    await expect(run(caller('reviewer', REVIEW_DENY))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each(procedures)('lets a reviewer holding the grant reach %s', async (_name, run) => {
    db.medicineProvenance.findMany.mockResolvedValue([unreviewed]);
    await run(caller('reviewer', REVIEW_GRANT)).catch(() => undefined);
    expect(db.$transaction).toHaveBeenCalledOnce();
  });

  it.each(procedures)('lets a solo owner reach %s', async (_name, run) => {
    guards.solo.mockResolvedValue(true);
    db.medicineProvenance.findMany.mockResolvedValue([unreviewed]);
    await run(caller('owner')).catch(() => undefined);
    expect(db.$transaction).toHaveBeenCalledOnce();
  });

  it('does not let a single administrator accept their own edit, even holding the grant', async () => {
    db.medicineProvenance.findMany.mockResolvedValue([unreviewed]);
    await expect(caller('editor', REVIEW_GRANT).recordReviewDecision(review)).rejects.toMatchObject(
      { code: 'FORBIDDEN' }
    );
    expect(db.medicineProvenance.create).not.toHaveBeenCalled();
    expect(db.medicineReviewDecision.create).not.toHaveBeenCalled();
  });

  it('does not let an administrator publish an assertion nobody else reviewed', async () => {
    db.medicineProvenance.findMany.mockResolvedValue([unreviewed]);
    await expect(
      caller('editor', REVIEW_GRANT).publishAssertions({ assertionIds: ['assertion'] })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    db.medicineProvenance.findMany.mockResolvedValue([
      { ...unreviewed, status: 'ACCEPTED', reviewer: 'reviewer' },
    ]);
    // Accepted but without review decision evidence: still refused.
    await expect(
      caller('editor', REVIEW_GRANT).publishAssertions({ assertionIds: ['assertion'] })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.medicinePublicationBatch.create).not.toHaveBeenCalled();
  });

  it('audits every acceptance by a different reviewer as a catalogue approval', async () => {
    db.medicineProvenance.findMany.mockResolvedValue([unreviewed]);
    await caller('reviewer', REVIEW_GRANT).recordReviewDecision(review);
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'reviewer',
        action: 'pharmacy.catalogueApproval',
        targetType: 'MedicineProvenance',
        targetId: 'assertion',
        metadata: { soloOwner: false, pinVerified: false },
      }),
    });
  });
});
