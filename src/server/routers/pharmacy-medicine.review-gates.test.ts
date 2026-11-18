/**
 * DEV-923 (DEV-19 follow-up): a single administrator can no longer change a pack
 * price or publish catalogue content alone.
 *
 * - setPackPrice is a reviewed catalogue edit: queued, and written only when a
 *   different reviewer approves it, or DEV-19's owner fallback (an owner while no
 *   other active member can review) approves with a fresh PIN.
 * - recordReviewDecision, publishAssertions and supersedePublication are reviewer
 *   work: they need the exact pharmacy:catalogue-review grant (no tenant-admin
 *   requirement, so a Pharmacist can do them) or that owner fallback.
 *
 * The ABAC engine and the DEV-19 helpers are real; only the PIN check is stubbed.
 * Members use the shipped role shapes: the system Owner role (pharmacy:*) paired with
 * ADMIN, and the Pharmacist and Cashier roles paired with EMPLOYEE.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const guards = vi.hoisted(() => ({ pin: vi.fn(async () => 'OK') }));
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
vi.mock('@/lib/pharmacy/owner-data-export-pin', () => ({ verifyOwnerExportPin: guards.pin }));

import { pharmacyMedicineRouter } from './pharmacy-medicine';
import type { TRPCContext } from '../trpc';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
type MemberRecord = {
  role: 'ADMIN' | 'EMPLOYEE';
  organizationRole: { key: string; isSystem: boolean; permissions: Rule[] } | null;
  permissionOverrides: Rule[];
};

const owner = (): MemberRecord => ({
  role: 'ADMIN',
  organizationRole: {
    key: 'owner',
    isSystem: true,
    permissions: [{ capability: 'pharmacy:*', effect: 'ALLOW' }],
  },
  permissionOverrides: [],
});
const pharmacist = (): MemberRecord => ({
  role: 'EMPLOYEE',
  organizationRole: {
    key: 'pharmacist',
    isSystem: true,
    permissions: [
      { capability: 'pharmacy:dispense', effect: 'ALLOW' },
      { capability: 'pharmacy:catalogue-review', effect: 'ALLOW' },
      { capability: 'pharmacy:close', effect: 'ALLOW' },
    ],
  },
  permissionOverrides: [],
});
const cashier = (): MemberRecord => ({
  role: 'EMPLOYEE',
  organizationRole: {
    key: 'cashier',
    isSystem: true,
    permissions: [
      { capability: 'pharmacy:counter', effect: 'ALLOW' },
      { capability: 'pharmacy:orders', effect: 'ALLOW' },
    ],
  },
  permissionOverrides: [],
});
// An administrator with no organization role: holds admin access and catalogue editing
// through the admin fallback, but neither the review grant nor owner authority.
const admin = (): MemberRecord => ({
  role: 'ADMIN',
  organizationRole: null,
  permissionOverrides: [],
});
const REVIEW_DENY: Rule = { capability: 'pharmacy:catalogue-review', effect: 'DENY' };

const PRICE = {
  packLevelId: 'pack_a',
  mrpMinor: 50_000,
  sellingPriceMinor: 45_000,
  effectiveFrom: new Date('2030-01-01T00:00:00Z'),
};

function makeDb() {
  const members = new Map<string, MemberRecord>();
  const edits: Array<Record<string, unknown> & { id: string }> = [];
  const db = {
    members,
    edits,
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const member = members.get(where.id);
        return member ? { ...member, status: 'ACTIVE' } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: { id?: { not?: string } } }) =>
        [...members.entries()]
          .filter(([id]) => id !== where.id?.not)
          .map(([id, member]) => ({ id, role: member.role, status: 'ACTIVE', department: null }))
      ),
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

function shop(members: Record<string, MemberRecord>) {
  for (const [id, record] of Object.entries(members)) db.members.set(id, record);
}

function caller(actorId: string) {
  const member = db.members.get(actorId)!;
  return pharmacyMedicineRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules: ['pharmacy-core'],
      activeSeats: db.members.size,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: actorId, role: member.role, status: 'ACTIVE', organizationId: 'org_a' },
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
  guards.pin.mockReset().mockResolvedValue('OK');
});

describe('DEV-923: a pack price is a reviewed catalogue edit', () => {
  it('queues an owner’s pack price and writes no price', async () => {
    shop({ owner_a: owner(), pharmacist_b: pharmacist() });
    const edit = await caller('owner_a').setPackPrice(PRICE);

    expect(edit).toMatchObject({
      status: 'PENDING',
      operation: 'setPackPrice',
      medicineId: 'medicine_a',
      editorId: 'owner_a',
    });
    expect(db.pharmacyPackPrice.create).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('refuses a selling price above the MRP, or a pack outside this workspace, before queueing', async () => {
    shop({ owner_a: owner() });
    await expect(
      caller('owner_a').setPackPrice({ ...PRICE, sellingPriceMinor: PRICE.mrpMinor + 1 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    db.packLevel.findFirst.mockResolvedValueOnce(null as never);
    await expect(caller('owner_a').setPackPrice(PRICE)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(db.pharmacyCatalogueEdit.create).not.toHaveBeenCalled();
  });

  it('refuses a pharmacist or cashier submitting a price', async () => {
    shop({ owner_a: owner(), pharmacist_b: pharmacist(), cashier_c: cashier() });
    for (const id of ['pharmacist_b', 'cashier_c'])
      await expect(caller(id).setPackPrice(PRICE)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyCatalogueEdit.create).not.toHaveBeenCalled();
  });

  it('Owner + Pharmacist: the owner cannot approve their own price; the pharmacist applies it', async () => {
    shop({ owner_a: owner(), pharmacist_b: pharmacist() });
    const edit = await caller('owner_a').setPackPrice({ ...PRICE, branchId: 'branch_a' });

    await expect(
      caller('owner_a').decideCatalogueEdit({ editId: edit.id, decision: 'APPROVE', soloPin: '1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(guards.pin).not.toHaveBeenCalled();
    expect(db.pharmacyPackPrice.create).not.toHaveBeenCalled();

    // The pharmacist is not a tenant administrator: the replay runs under their own review
    // authority and still writes the price.
    await expect(
      caller('pharmacist_b').decideCatalogueEdit({ editId: edit.id, decision: 'APPROVE' })
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
      editorId: 'owner_a',
      reviewerId: 'pharmacist_b',
      soloPinVerifiedAt: null,
    });
    expect(auditActions()).toEqual(
      expect.arrayContaining(['pharmacyMedicine.setPackPrice', 'pharmacy.catalogueApproval'])
    );
  });

  it('DEV-928: the price row and its one audit entry name proposer, approver, old price, new price and pack', async () => {
    shop({ owner_a: owner(), pharmacist_b: pharmacist() });
    const edit = await caller('owner_a').setPackPrice(PRICE);
    db.pharmacyPackPrice.findFirst.mockResolvedValue({
      id: 'price_0',
      mrpMinor: 40_000,
      sellingPriceMinor: 36_000,
    } as never);

    await caller('pharmacist_b').decideCatalogueEdit({ editId: edit.id, decision: 'APPROVE' });

    expect(db.pharmacyPackPrice.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ proposedById: 'owner_a', createdById: 'pharmacist_b' }),
    });
    const priceAudits = db.auditLog.create.mock.calls
      .map((call) => (call as unknown as [{ data: Record<string, unknown> }])[0].data)
      .filter((data) => data.action === 'pharmacyMedicine.setPackPrice');
    expect(priceAudits).toHaveLength(1);
    // The old price is the one in force at the new price's date, never a later-dated row.
    expect(db.pharmacyPackPrice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          packLevelId: 'pack_a',
          effectiveFrom: { lte: PRICE.effectiveFrom },
        }),
      })
    );
    expect(priceAudits[0]).toMatchObject({
      actorId: 'pharmacist_b',
      changes: {
        proposedById: 'owner_a',
        approvedById: 'pharmacist_b',
        packLevelId: 'pack_a',
        previousMrpMinor: 40_000,
        previousSellingPriceMinor: 36_000,
        mrpMinor: 50_000,
        sellingPriceMinor: 45_000,
      },
    });
  });

  it('writes no price when the reviewer rejects it', async () => {
    shop({ owner_a: owner(), pharmacist_b: pharmacist() });
    const edit = await caller('owner_a').setPackPrice(PRICE);
    await caller('pharmacist_b').decideCatalogueEdit({ editId: edit.id, decision: 'REJECT' });
    expect(db.pharmacyPackPrice.create).not.toHaveBeenCalled();
    expect(db.edits[0]).toMatchObject({ status: 'REJECTED' });
  });

  it('Owner + Cashier: the owner approves their own price only with a fresh PIN, audited', async () => {
    shop({ owner_a: owner(), cashier_c: cashier() });
    const edit = await caller('owner_a').setPackPrice(PRICE);

    await expect(
      caller('owner_a').decideCatalogueEdit({ editId: edit.id, decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    guards.pin.mockResolvedValueOnce('INVALID');
    await expect(
      caller('owner_a').decideCatalogueEdit({ editId: edit.id, decision: 'APPROVE', soloPin: '0' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyPackPrice.create).not.toHaveBeenCalled();

    await caller('owner_a').decideCatalogueEdit({
      editId: edit.id,
      decision: 'APPROVE',
      soloPin: '2468',
    });
    expect(db.pharmacyPackPrice.create).toHaveBeenCalledOnce();
    expect(db.edits[0]).toMatchObject({
      status: 'APPROVED',
      reviewerId: 'owner_a',
      soloPinVerifiedAt: expect.any(Date),
    });
    expect(auditActions()).toContain('pharmacy.catalogueSoloOwnerApproval');
  });

  it('Owner + Owner: neither approves their own price, but the other owner does with a PIN', async () => {
    shop({ owner_a: owner(), owner_b: owner() });
    const edit = await caller('owner_a').setPackPrice(PRICE);

    await expect(
      caller('owner_a').decideCatalogueEdit({ editId: edit.id, decision: 'APPROVE', soloPin: '1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyPackPrice.create).not.toHaveBeenCalled();

    await caller('owner_b').decideCatalogueEdit({
      editId: edit.id,
      decision: 'APPROVE',
      soloPin: '1357',
    });
    expect(guards.pin).toHaveBeenCalledExactlyOnceWith({
      organizationId: 'org_a',
      userId: 'owner_b',
      pin: '1357',
    });
    expect(db.pharmacyPackPrice.create).toHaveBeenCalledOnce();
    expect(db.edits[0]).toMatchObject({ status: 'APPROVED', reviewerId: 'owner_b' });
  });
});

describe('DEV-923: reviewing and publishing need the catalogue review permission', () => {
  const unreviewed = (editorId: string) => ({
    id: 'assertion',
    medicineId: 'medicine_a',
    editorId,
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
  });
  const review = {
    duplicateKey: 'fixture',
    action: 'ACCEPT' as const,
    medicineIds: ['medicine_a'],
    payload: { assertionIds: ['assertion'] },
  };
  type Caller = ReturnType<typeof caller>;
  const procedures = [
    ['recordReviewDecision', (c: Caller) => c.recordReviewDecision(review)],
    ['publishAssertions', (c: Caller) => c.publishAssertions({ assertionIds: ['assertion'] })],
    ['supersedePublication', (c: Caller) => c.supersedePublication({ batchId: 'batch' })],
  ] as const;

  it.each(procedures)(
    'Owner + Pharmacist: refuses %s to the owner, lets the pharmacist through',
    async (_name, run) => {
      shop({ owner_a: owner(), pharmacist_b: pharmacist() });
      db.medicineProvenance.findMany.mockResolvedValue([unreviewed('owner_a')]);
      await expect(run(caller('owner_a'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.$transaction).not.toHaveBeenCalled();
      await run(caller('pharmacist_b')).catch(() => undefined);
      expect(db.$transaction).toHaveBeenCalledOnce();
    }
  );

  it.each(procedures)(
    'Owner + Cashier: lets the owner reach %s, refuses the cashier',
    async (_name, run) => {
      shop({ owner_a: owner(), cashier_c: cashier() });
      db.medicineProvenance.findMany.mockResolvedValue([unreviewed('former_x')]);
      await expect(run(caller('cashier_c'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.$transaction).not.toHaveBeenCalled();
      await run(caller('owner_a')).catch(() => undefined);
      expect(db.$transaction).toHaveBeenCalledOnce();
    }
  );

  it.each(procedures)(
    'Owner + Cashier: refuses %s to an owner under an explicit review DENY',
    async (_name, run) => {
      const denied = owner();
      denied.permissionOverrides.push(REVIEW_DENY);
      shop({ owner_a: denied, cashier_c: cashier() });
      await expect(run(caller('owner_a'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(procedures)(
    'refuses %s to an administrator who is neither a reviewer nor an owner',
    async (_name, run) => {
      shop({ admin_a: admin(), cashier_c: cashier() });
      await expect(run(caller('admin_a'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );

  it('does not let a pharmacist accept their own edit', async () => {
    shop({ owner_a: owner(), pharmacist_b: pharmacist() });
    db.medicineProvenance.findMany.mockResolvedValue([unreviewed('pharmacist_b')]);
    await expect(caller('pharmacist_b').recordReviewDecision(review)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.medicineProvenance.create).not.toHaveBeenCalled();
    expect(db.medicineReviewDecision.create).not.toHaveBeenCalled();
  });

  it('Owner + Cashier: the owner accepts only with a fresh PIN, even another person’s edit', async () => {
    shop({ owner_a: owner(), cashier_c: cashier() });
    db.medicineProvenance.findMany.mockResolvedValue([unreviewed('former_x')]);
    await expect(caller('owner_a').recordReviewDecision(review)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.medicineReviewDecision.create).not.toHaveBeenCalled();

    await caller('owner_a').recordReviewDecision({ ...review, soloPin: '2468' });
    expect(guards.pin).toHaveBeenCalledWith({
      organizationId: 'org_a',
      userId: 'owner_a',
      pin: '2468',
    });
    expect(db.medicineReviewDecision.create).toHaveBeenCalledOnce();
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'owner_a',
        action: 'pharmacy.catalogueSoloOwnerApproval',
        targetType: 'MedicineProvenance',
        metadata: { soloOwner: true, pinVerified: true, reason: 'no other reviewer' },
      }),
    });
  });

  it('Owner + Owner: an owner cannot accept their own edit, the other owner can with a PIN', async () => {
    shop({ owner_a: owner(), owner_b: owner() });
    db.medicineProvenance.findMany.mockResolvedValue([unreviewed('owner_a')]);
    await expect(
      caller('owner_a').recordReviewDecision({ ...review, soloPin: '2468' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.medicineReviewDecision.create).not.toHaveBeenCalled();

    await caller('owner_b').recordReviewDecision({ ...review, soloPin: '1357' });
    expect(db.medicineReviewDecision.create).toHaveBeenCalledOnce();
    expect(db.medicineProvenance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'ACCEPTED', reviewer: 'owner_b' }),
    });
  });

  it('does not let anyone publish an assertion nobody reviewed', async () => {
    shop({ owner_a: owner(), pharmacist_b: pharmacist() });
    db.medicineProvenance.findMany.mockResolvedValue([unreviewed('owner_a')]);
    await expect(
      caller('pharmacist_b').publishAssertions({ assertionIds: ['assertion'] })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    db.medicineProvenance.findMany.mockResolvedValue([
      { ...unreviewed('owner_a'), status: 'ACCEPTED', reviewer: 'pharmacist_b' },
    ]);
    // Accepted but without review decision evidence: still refused.
    await expect(
      caller('pharmacist_b').publishAssertions({ assertionIds: ['assertion'] })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.medicinePublicationBatch.create).not.toHaveBeenCalled();
  });

  it('audits every acceptance by a different reviewer as a catalogue approval', async () => {
    shop({ owner_a: owner(), pharmacist_b: pharmacist() });
    db.medicineProvenance.findMany.mockResolvedValue([unreviewed('owner_a')]);
    await caller('pharmacist_b').recordReviewDecision(review);
    expect(guards.pin).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'pharmacist_b',
        action: 'pharmacy.catalogueApproval',
        targetType: 'MedicineProvenance',
        targetId: 'assertion',
        metadata: { soloOwner: false, pinVerified: false },
      }),
    });
  });
});
