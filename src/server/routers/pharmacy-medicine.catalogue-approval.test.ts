import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ verifyPin: vi.fn(async () => 'OK') }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/pharmacy/owner-data-export-pin', () => ({ verifyOwnerExportPin: mocks.verifyPin }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { pharmacyMedicineRouter } from './pharmacy-medicine';
import type { TRPCContext } from '../trpc';

function fixture(
  actorId = 'reviewer',
  options: { owner?: boolean; others?: number; review?: boolean; role?: string } = {}
) {
  const medicine = {
    id: 'medicine',
    organizationId: 'org-a',
    productName: 'Soap',
    productFamily: 'FRONT_SHOP',
    updatedAt: new Date('2030-01-01'),
    retailPriceMinor: 100,
  };
  const edit = {
    id: 'edit',
    organizationId: 'org-a',
    editorId: 'editor',
    medicineId: 'medicine',
    status: 'PENDING',
    baseUpdatedAt: medicine.updatedAt,
    changes: { productName: 'Reviewed soap' },
  };
  const permissions = [
    ...(options.review === false
      ? []
      : [{ capability: 'pharmacy:catalogue-review', effect: 'ALLOW' }]),
    ...(options.owner ? [{ capability: '*', effect: 'ALLOW' }] : []),
    { capability: 'admin:access', effect: 'ALLOW' },
  ];
  const db = {
    user: {
      findUnique: vi.fn(async () => ({
        role: options.role ?? 'ADMIN',
        status: 'ACTIVE',
        organizationRole: {
          key: options.owner ? 'owner' : 'pharmacist',
          isSystem: true,
          permissions,
        },
        permissionOverrides: [],
      })),
      count: vi.fn(async () => options.others ?? 0),
    },
    medicine: {
      findFirst: vi.fn(async () => medicine),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(),
    },
    pharmacyCatalogueEdit: {
      findFirst: vi.fn(async () => edit),
      findMany: vi.fn(async () => [edit]),
      create: vi.fn(async ({ data }) => ({ id: 'new-edit', status: 'PENDING', ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    pharmacyReferenceConnectorRun: { findFirst: vi.fn(async () => ({ triggeredBy: 'editor' })) },
    pharmacyReferenceConnectorProposal: {
      findFirst: vi.fn(async () => ({ id: 'proposal', runId: 'run', status: 'PENDING' })),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    medicineProvenance: {
      create: vi.fn(async ({ data }) => ({ id: 'reviewed-assertion', ...data })),
      findMany: vi.fn(async () => [
        { id: 'assertion', medicineId: 'medicine', editorId: 'editor', status: 'UNREVIEWED' },
      ]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    medicineReviewDecision: { create: vi.fn(async ({ data }) => data) },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  Object.assign(db.medicine, { count: vi.fn(async () => 1) });
  const transactional = Object.assign(db, {
    $transaction: vi.fn(async (run: (tx: typeof db) => unknown) => run(db)),
  });
  const caller = pharmacyMedicineRouter.createCaller({
    db: transactional,
    entitlements: {
      organizationId: 'org-a',
      enabledModules: ['pharmacy-core'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: actorId, role: options.role ?? 'ADMIN', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
  return { db, caller, edit, medicine };
}

beforeEach(() => {
  mocks.verifyPin.mockReset().mockResolvedValue('OK');
});

describe('DEV-766 durable catalogue approvals', () => {
  it('queues an attributed edit without changing the live catalogue', async () => {
    const { db, caller, medicine } = fixture('editor');
    await expect(
      caller.submitCatalogueEdit({ medicineId: medicine.id, changes: { productName: 'New name' } })
    ).resolves.toMatchObject({ status: 'PENDING', editorId: 'editor' });
    expect(db.pharmacyCatalogueEdit.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org-a',
        medicineId: 'medicine',
        editorId: 'editor',
        baseUpdatedAt: medicine.updatedAt,
        changes: { productName: 'New name' },
      },
    });
    expect(db.medicine.updateMany).not.toHaveBeenCalled();
    expect(db.medicine.update).not.toHaveBeenCalled();
  });

  it('approves with a different reviewer and writes audit evidence atomically', async () => {
    const { db, caller, edit } = fixture();
    await expect(
      caller.decideCatalogueEdit({ editId: edit.id, decision: 'APPROVE' })
    ).resolves.toEqual({ status: 'APPROVED' });
    expect(db.medicine.updateMany).toHaveBeenCalledWith({
      where: { id: 'medicine', organizationId: 'org-a', updatedAt: edit.baseUpdatedAt },
      data: edit.changes,
    });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'reviewer',
        metadata: {
          editorIds: ['editor'],
          reviewerId: 'reviewer',
          policy: 'DIFFERENT_REVIEWER',
          pinVerified: false,
        },
      }),
    });
    expect(mocks.verifyPin).not.toHaveBeenCalled();
  });

  it.each([
    { owner: false, others: 0 },
    { owner: true, others: 1 },
  ])('refuses self-approval with %j even with a PIN', async (options) => {
    const { caller, db } = fixture('editor', options);
    await expect(
      caller.decideCatalogueEdit({ editId: 'edit', decision: 'APPROVE', pin: '1234' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyCatalogueEdit.updateMany).not.toHaveBeenCalled();
    expect(db.medicine.updateMany).not.toHaveBeenCalled();
    expect(mocks.verifyPin).not.toHaveBeenCalled();
  });

  it('requires a fresh PIN for every solo-owner approval and audits the exception', async () => {
    const { caller, db } = fixture('editor', { owner: true });
    await expect(
      caller.decideCatalogueEdit({ editId: 'edit', decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await caller.decideCatalogueEdit({ editId: 'edit', decision: 'APPROVE', pin: '1234' });
    expect(mocks.verifyPin).toHaveBeenCalledExactlyOnceWith({
      organizationId: 'org-a',
      userId: 'editor',
      pin: '1234',
    });
    expect(db.user.count).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', status: 'ACTIVE', id: { not: 'editor' } },
    });
    expect(db.pharmacyCatalogueEdit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ soloOwnerReauthenticatedAt: expect.any(Date) }),
      })
    );
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({ policy: 'PHARMACY_SOLO_OWNER_PIN', pinVerified: true }),
      }),
    });
    await expect(
      caller.decideCatalogueEdit({ editId: 'another-edit', decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.medicine.updateMany).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(db.auditLog.create.mock.calls)).not.toContain('1234');
  });

  it.each(['REJECTED', 'LOCKED', 'NO_PIN'])(
    'refuses a solo owner whose credential result is %s',
    async (result) => {
      mocks.verifyPin.mockResolvedValue(result);
      const { caller, db } = fixture('editor', { owner: true });
      await expect(
        caller.decideCatalogueEdit({ editId: 'edit', decision: 'APPROVE', pin: 'wrong' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.medicine.updateMany).not.toHaveBeenCalled();
      expect(db.auditLog.create).not.toHaveBeenCalled();
    }
  );

  it('rejects a proposal without touching the live catalogue', async () => {
    const { caller, db } = fixture();
    await expect(
      caller.decideCatalogueEdit({ editId: 'edit', decision: 'REJECT' })
    ).resolves.toEqual({ status: 'REJECTED' });
    expect(db.pharmacyCatalogueEdit.updateMany).toHaveBeenCalledOnce();
    expect(db.medicine.updateMany).not.toHaveBeenCalled();
  });

  it('requires the explicit reviewer capability', async () => {
    const { caller, db } = fixture('editor', { owner: true, review: false });
    await expect(
      caller.decideCatalogueEdit({ editId: 'edit', decision: 'APPROVE', pin: '1234' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyCatalogueEdit.findFirst).not.toHaveBeenCalled();
  });

  it('refuses stale proposals and concurrent/repeated decisions', async () => {
    const { caller, db, edit } = fixture();
    db.medicine.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      caller.decideCatalogueEdit({ editId: 'edit', decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.auditLog.create).not.toHaveBeenCalled();
    db.pharmacyCatalogueEdit.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      caller.decideCatalogueEdit({ editId: 'edit', decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.medicine.updateMany).toHaveBeenCalledTimes(1);
    edit.status = 'APPROVED';
    await expect(
      caller.decideCatalogueEdit({ editId: 'edit', decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('does not reveal missing or other-tenant proposals', async () => {
    const { caller, db } = fixture();
    db.pharmacyCatalogueEdit.findFirst.mockResolvedValue(null as never);
    await expect(
      caller.decideCatalogueEdit({ editId: 'foreign', decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Catalogue proposal not found.' });
    expect(db.pharmacyCatalogueEdit.findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign', organizationId: 'org-a' },
    });
    expect(db.medicine.updateMany).not.toHaveBeenCalled();
  });

  it('blocks self-confirmation through the import path too', async () => {
    const { caller, db } = fixture('editor', { others: 1 });
    await expect(
      caller.decideReferenceConnectorProposal({ proposalId: 'proposal', decision: 'CONFIRM' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyReferenceConnectorProposal.updateMany).not.toHaveBeenCalled();
  });

  it('blocks manual assertion self-approval and allows a different reviewer', async () => {
    const input = {
      duplicateKey: 'reference:medicine',
      action: 'ACCEPT' as const,
      medicineIds: ['medicine'],
      payload: { assertionIds: ['assertion'] },
    };
    const self = fixture('editor');
    await expect(self.caller.recordReviewDecision(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(self.db.medicineProvenance.updateMany).not.toHaveBeenCalled();
    const other = fixture('reviewer');
    await other.caller.recordReviewDecision(input);
    expect(other.db.medicineProvenance.updateMany).not.toHaveBeenCalled();
    expect(other.db.medicineProvenance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        supersedesId: 'assertion',
        status: 'ACCEPTED',
        editorId: 'editor',
        reviewer: 'reviewer',
      }),
    });
  });

  it('rejects unknown authors rather than inventing attribution', async () => {
    const { caller, db } = fixture();
    db.medicineProvenance.findMany.mockResolvedValue([
      { id: 'assertion', medicineId: 'medicine', editorId: null, status: 'UNREVIEWED' },
    ] as never);
    await expect(
      caller.recordReviewDecision({
        duplicateKey: 'reference:medicine',
        action: 'ACCEPT',
        medicineIds: ['medicine'],
        payload: { assertionIds: ['assertion'] },
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses unreviewable fields and out-of-range money', async () => {
    const { caller, db } = fixture();
    await expect(
      caller.submitCatalogueEdit({ medicineId: 'medicine', changes: { saleable: true } as never })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.submitCatalogueEdit({
        medicineId: 'medicine',
        changes: { retailPriceMinor: 2_147_483_648 },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyCatalogueEdit.create).not.toHaveBeenCalled();
  });
  it('keeps corrected values pending for a different reviewer', async () => {
    const { caller, db } = fixture('reviewer');
    db.medicineProvenance.findMany.mockResolvedValue([
      {
        id: 'assertion',
        medicineId: 'medicine',
        editorId: 'editor',
        status: 'UNREVIEWED',
        field: 'productName',
        source: 'Synthetic fixture',
        sourceType: 'USER',
        retrievedAt: new Date(),
        assertedValue: {
          value: 'Old value',
          connectorId: 'manual-file',
          sourceLabel: 'Fixture',
          batchId: 'batch',
          rowSourceKey: 'row',
          rights: {
            acquisition: 'Local test',
            cache: 'Local test',
            redistribution: 'Local test',
            deletion: 'Local test',
          },
          blockingIssues: [],
        },
      },
    ] as never);
    await caller.recordReviewDecision({
      duplicateKey: 'reference:medicine',
      action: 'CORRECT',
      medicineIds: ['medicine'],
      payload: {
        assertionIds: ['assertion'],
        corrections: [{ assertionId: 'assertion', value: 'Corrected value' }],
      },
    });
    expect(db.medicineProvenance.updateMany).not.toHaveBeenCalled();
    const version = db.medicineProvenance.create.mock.calls[0]![0].data;
    expect(version).toMatchObject({
      editorId: 'reviewer',
      reviewer: null,
      status: 'UNREVIEWED',
      supersedesId: 'assertion',
      assertedValue: { value: 'Corrected value' },
    });
    db.medicineProvenance.findMany.mockResolvedValue([
      { id: 'reviewed-assertion', ...version },
    ] as never);
    await expect(
      caller.recordReviewDecision({
        duplicateKey: 'reference:medicine',
        action: 'ACCEPT',
        medicineIds: ['medicine'],
        payload: { assertionIds: ['reviewed-assertion'] },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each(['CONFIRM', 'REJECT'] as const)(
    'does not overwrite a concurrent connector decision with %s',
    async (decision) => {
      const { caller, db } = fixture();
      db.pharmacyReferenceConnectorProposal.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        caller.decideReferenceConnectorProposal({ proposalId: 'proposal', decision })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(db.pharmacyReferenceConnectorProposal.update).not.toHaveBeenCalled();
      expect(db.medicine.update).not.toHaveBeenCalled();
    }
  );

  it('cannot remove the registration required by a published medicine', async () => {
    const { caller, db, medicine } = fixture();
    Object.assign(medicine, { productFamily: 'PHARMACEUTICAL', saleable: true });
    await expect(
      caller.submitCatalogueEdit({
        medicineId: medicine.id,
        changes: { drapRegistrationNumber: null },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyCatalogueEdit.create).not.toHaveBeenCalled();
  });
});
