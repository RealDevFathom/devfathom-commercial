import { beforeEach, describe, expect, it, vi } from 'vitest';
const guards = vi.hoisted(() => ({ solo: vi.fn(), pin: vi.fn() }));
vi.mock('./solo-owner', () => ({ isSoloPharmacyOwner: guards.solo }));
vi.mock('./owner-data-export-pin', () => ({ verifyOwnerExportPin: guards.pin }));
import {
  decideCatalogueEdit,
  requireIndependentCatalogueReviewer,
  submitCatalogueEdit,
} from './catalogue-approvals';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const scope = { organizationId: 'org_a', actorId: 'reviewer', actorOrganizationId: 'org_a' };
const timestamp = new Date('2026-11-01T00:00:00Z');
function fixture(editorId = 'editor') {
  const medicine = {
    id: 'medicine',
    updatedAt: timestamp,
    productFamily: 'FRONT_SHOP',
    saleable: true,
    drapRegistrationNumber: null,
  };
  const proposal = {
    id: 'edit',
    editorId,
    medicineId: medicine.id,
    operation: 'UPDATE_MEDICINE',
    changes: { productName: 'New name' },
    expectedUpdatedAt: timestamp,
    status: 'PENDING',
  };
  const raw = {
    medicine: {
      findFirst: vi.fn(async () => medicine),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    pharmacyCatalogueEdit: {
      create: vi.fn(async ({ data }: { data: unknown }) => ({ id: 'edit', ...(data as object) })),
      findFirst: vi.fn(async () => proposal),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLog: { create: vi.fn(async () => ({ id: 'audit' })) },
    $queryRaw: vi.fn(),
  };
  const db = Object.assign(raw, {
    $transaction: vi.fn(async (run: (tx: typeof raw) => unknown) => run(raw)),
  });
  return { db: db as unknown as ScopedDb, raw, proposal };
}

beforeEach(() => {
  vi.clearAllMocks();
  guards.solo.mockResolvedValue(false);
  guards.pin.mockResolvedValue('OK');
});

describe('DEV-766 durable catalogue approvals', () => {
  it('holds a validated edit with editor and version evidence without changing the catalogue', async () => {
    const f = fixture();
    await submitCatalogueEdit(f.db, scope, 'medicine', { productName: 'New name' });
    expect(f.raw.pharmacyCatalogueEdit.create).toHaveBeenCalledWith({
      data: {
        medicineId: 'medicine',
        editorId: 'reviewer',
        changes: { productName: 'New name' },
        expectedUpdatedAt: timestamp,
      },
    });
    expect(f.raw.medicine.updateMany).not.toHaveBeenCalled();
  });
  it('applies an edit and records an audit atomically for a different reviewer', async () => {
    const f = fixture();
    await expect(
      decideCatalogueEdit(f.db, scope, { editId: 'edit', decision: 'APPROVE' })
    ).resolves.toEqual({ id: 'edit', status: 'APPROVED' });
    expect(f.raw.medicine.updateMany).toHaveBeenCalledWith({
      where: { id: 'medicine', updatedAt: timestamp },
      data: { productName: 'New name' },
    });
    expect(f.raw.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'reviewer',
        action: 'pharmacy.catalogueApproval',
        metadata: { soloOwner: false, pinVerified: false },
      }),
    });
    expect(guards.pin).not.toHaveBeenCalled();
  });
  it.each([undefined, '1234'])(
    'blocks editor self-approval without the solo-owner rule (PIN %s)',
    async (soloPin) => {
      const f = fixture('reviewer');
      await expect(
        decideCatalogueEdit(f.db, scope, { editId: 'edit', decision: 'APPROVE', soloPin })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.raw.pharmacyCatalogueEdit.updateMany).not.toHaveBeenCalled();
      expect(f.raw.medicine.updateMany).not.toHaveBeenCalled();
      expect(f.raw.auditLog.create).not.toHaveBeenCalled();
    }
  );
  it('requires a new PIN verification on every solo-owner approval and audits the exception', async () => {
    guards.solo.mockResolvedValue(true);
    const f = fixture('reviewer');
    const input = { editId: 'edit', decision: 'APPROVE' as const, soloPin: '2468' };
    await decideCatalogueEdit(f.db, scope, input);
    expect(guards.pin).toHaveBeenCalledWith({
      organizationId: 'org_a',
      userId: 'reviewer',
      pin: '2468',
    });
    expect(f.raw.pharmacyCatalogueEdit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reviewerId: 'reviewer',
          soloPinVerifiedAt: expect.any(Date),
        }),
      })
    );
    expect(f.raw.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'pharmacy.catalogueSoloOwnerApproval',
        metadata: { soloOwner: true, pinVerified: true },
      }),
    });
    guards.pin.mockResolvedValue('REJECTED');
    f.raw.medicine.updateMany.mockClear();
    await expect(decideCatalogueEdit(f.db, scope, input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(guards.pin).toHaveBeenCalledTimes(2);
    expect(f.raw.medicine.updateMany).not.toHaveBeenCalled();
  });
  it.each(['NO_PIN', 'REJECTED', 'LOCKED'])(
    'refuses a solo owner when PIN verification returns %s',
    async (result) => {
      guards.solo.mockResolvedValue(true);
      guards.pin.mockResolvedValue(result);
      const f = fixture('reviewer');
      await expect(
        decideCatalogueEdit(f.db, scope, { editId: 'edit', decision: 'APPROVE', soloPin: '2468' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.raw.medicine.updateMany).not.toHaveBeenCalled();
    }
  );
  it('rejects stale edits instead of overwriting a later catalogue change', async () => {
    const f = fixture();
    f.raw.medicine.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      decideCatalogueEdit(f.db, scope, { editId: 'edit', decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.raw.auditLog.create).not.toHaveBeenCalled();
  });
  it('refuses concurrent and repeated decisions', async () => {
    const f = fixture();
    f.raw.pharmacyCatalogueEdit.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      decideCatalogueEdit(f.db, scope, { editId: 'edit', decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.raw.medicine.updateMany).not.toHaveBeenCalled();
    f.proposal.status = 'APPROVED';
    await expect(
      decideCatalogueEdit(f.db, scope, { editId: 'edit', decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('rejects a proposal without publishing it', async () => {
    const f = fixture('reviewer');
    await decideCatalogueEdit(f.db, scope, { editId: 'edit', decision: 'REJECT' });
    expect(f.raw.pharmacyCatalogueEdit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'REJECTED', soloPinVerifiedAt: null }),
      })
    );
    expect(f.raw.medicine.updateMany).not.toHaveBeenCalled();
  });
  it('fails closed for missing tenant targets and forbids saleability/family injection', async () => {
    const f = fixture();
    f.raw.medicine.findFirst.mockResolvedValueOnce(null as never);
    await expect(
      submitCatalogueEdit(f.db, scope, 'foreign', { productName: 'x' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      submitCatalogueEdit(f.db, scope, 'medicine', { saleable: true })
    ).rejects.toThrow();
    await expect(
      submitCatalogueEdit(f.db, scope, 'medicine', { productFamily: 'FRONT_SHOP' })
    ).rejects.toThrow();
    expect(f.raw.pharmacyCatalogueEdit.create).not.toHaveBeenCalled();
  });
  it('enforces the separation check for assertions as well as catalogue proposals', async () => {
    await expect(
      requireIndependentCatalogueReviewer(fixture().db, scope, ['reviewer'])
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
