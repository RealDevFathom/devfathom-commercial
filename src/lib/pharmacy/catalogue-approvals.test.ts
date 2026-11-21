import { beforeEach, describe, expect, it, vi } from 'vitest';
const guards = vi.hoisted(() => ({ solo: vi.fn(), pin: vi.fn() }));
vi.mock('./solo-owner', () => ({ isSoloPharmacyOwner: guards.solo }));
vi.mock('./owner-data-export-pin', () => ({
  verifyOwnerExportPin: guards.pin,
}));
import {
  decideCatalogueEdit,
  listPendingCatalogueEdits,
  requireIndependentCatalogueReviewer,
  submitCatalogueEdit,
} from './catalogue-approvals';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { NO_PIN_SET_MESSAGE } from './own-pin-policy';

const scope = {
  organizationId: 'org_a',
  actorId: 'reviewer',
  actorOrganizationId: 'org_a',
};
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
      findFirst: vi.fn(async (): Promise<typeof medicine | null> => medicine),
      updateMany: vi.fn(
        async (args: { where: unknown; data: { productName?: string; updatedAt: Date } }) => {
          Object.assign(medicine, args.data);
          return { count: 1 };
        }
      ),
    },
    pharmacyCatalogueEdit: {
      create: vi.fn(async ({ data }: { data: unknown }) => ({
        id: 'edit',
        ...(data as object),
      })),
      findFirst: vi.fn(async () => proposal),
      updateMany: vi.fn(async () => ({ count: 1 })),
      count: vi.fn(async () => 0),
      findMany: vi.fn(async (): Promise<unknown[]> => []),
    },
    auditLog: { create: vi.fn(async () => ({ id: 'audit' })) },
    packLevel: {
      findMany: vi.fn(async () => [
        {
          id: 'pack_strip',
          level: 'STRIP',
          unitsPerParent: 10,
          presentation: { presentation: '3 x 10 tablets' },
        },
      ]),
    },
    presentation: {
      findMany: vi.fn(async () => [{ id: 'presentation_a', presentation: '3 x 10 tablets' }]),
    },
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
    await submitCatalogueEdit(f.db, scope, 'medicine', {
      productName: 'New name',
    });
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
    ).resolves.toEqual({ id: 'edit', status: 'APPROVED', staleEdits: 0 });
    expect(f.raw.medicine.updateMany).toHaveBeenCalledWith({
      where: { id: 'medicine', updatedAt: timestamp },
      data: { productName: 'New name', updatedAt: expect.any(Date) },
    });
    expect(f.raw.medicine.updateMany.mock.calls[0]![0].data.updatedAt.getTime()).toBeGreaterThan(
      timestamp.getTime()
    );
    expect(f.raw.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'reviewer',
        action: 'pharmacy.catalogueApproval',
        metadata: { soloOwner: false, pinVerified: false },
      }),
    });
    expect(guards.pin).not.toHaveBeenCalled();
  });
  it('marks an approved controlled-flag change in its audit record (DEV-925)', async () => {
    const f = fixture();
    f.proposal.changes = { controlled: false } as unknown as typeof f.proposal.changes;
    await decideCatalogueEdit(f.db, scope, { editId: 'edit', decision: 'APPROVE' });
    expect(f.raw.medicine.updateMany).toHaveBeenCalledWith({
      where: { id: 'medicine', updatedAt: timestamp },
      data: { controlled: false, updatedAt: expect.any(Date) },
    });
    expect(f.raw.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'pharmacy.catalogueApproval',
        metadata: { soloOwner: false, pinVerified: false, controlledReviewed: true },
      }),
    });
  });
  it("marks a solo owner's PIN approval of a controlled-flag change too (DEV-925)", async () => {
    guards.solo.mockResolvedValue(true);
    const f = fixture('reviewer');
    f.proposal.changes = { controlled: false } as unknown as typeof f.proposal.changes;
    await decideCatalogueEdit(f.db, scope, {
      editId: 'edit',
      decision: 'APPROVE',
      soloPin: '2468',
    });
    expect(guards.pin).toHaveBeenCalledOnce();
    expect(f.raw.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'pharmacy.catalogueSoloOwnerApproval',
        metadata: { soloOwner: true, pinVerified: true, controlledReviewed: true },
      }),
    });
  });
  it.each([undefined, '1234'])(
    'blocks editor self-approval without the solo-owner rule (PIN %s)',
    async (soloPin) => {
      const f = fixture('reviewer');
      await expect(
        decideCatalogueEdit(f.db, scope, {
          editId: 'edit',
          decision: 'APPROVE',
          soloPin,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.raw.pharmacyCatalogueEdit.updateMany).not.toHaveBeenCalled();
      expect(f.raw.medicine.updateMany).not.toHaveBeenCalled();
      expect(f.raw.auditLog.create).not.toHaveBeenCalled();
    }
  );
  it('requires a new PIN verification on every solo-owner approval and audits the exception', async () => {
    guards.solo.mockResolvedValue(true);
    const f = fixture('reviewer');
    const input = {
      editId: 'edit',
      decision: 'APPROVE' as const,
      soloPin: '2468',
    };
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
        decideCatalogueEdit(f.db, scope, {
          editId: 'edit',
          decision: 'APPROVE',
          soloPin: '2468',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.raw.medicine.updateMany).not.toHaveBeenCalled();
    }
  );
  it('sends a solo owner who has not created a PIN to Your PIN (DEV-931)', async () => {
    guards.solo.mockResolvedValue(true);
    guards.pin.mockResolvedValue('NO_PIN');
    const f = fixture('reviewer');
    await expect(
      decideCatalogueEdit(f.db, scope, { editId: 'edit', decision: 'APPROVE', soloPin: '2468' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: NO_PIN_SET_MESSAGE });
    guards.pin.mockResolvedValue('REJECTED');
    await expect(
      decideCatalogueEdit(f.db, scope, { editId: 'edit', decision: 'APPROVE', soloPin: '2468' })
    ).rejects.toMatchObject({ message: 'Fresh owner PIN verification failed.' });
  });
  it('tells a solo owner whose PIN is locked that it is locked, not wrong (DEV-976)', async () => {
    guards.solo.mockResolvedValue(true);
    guards.pin.mockResolvedValue('LOCKED');
    const f = fixture('reviewer');
    await expect(
      decideCatalogueEdit(f.db, scope, { editId: 'edit', decision: 'APPROVE', soloPin: '2468' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Your PIN is locked after too many wrong tries. Wait and try again.',
    });
    expect(f.raw.medicine.updateMany).not.toHaveBeenCalled();
  });
  it('rejects stale edits instead of overwriting a later catalogue change', async () => {
    const f = fixture();
    f.raw.medicine.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      decideCatalogueEdit(f.db, scope, { editId: 'edit', decision: 'APPROVE' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.raw.auditLog.create).not.toHaveBeenCalled();
  });
  it('reports the other pending edits on the item that an approval made stale', async () => {
    const f = fixture();
    f.raw.pharmacyCatalogueEdit.count.mockResolvedValue(2);
    await expect(
      decideCatalogueEdit(f.db, scope, { editId: 'edit', decision: 'APPROVE' })
    ).resolves.toEqual({ id: 'edit', status: 'APPROVED', staleEdits: 2 });
    expect(f.raw.pharmacyCatalogueEdit.count).toHaveBeenCalledWith({
      where: { medicineId: 'medicine', status: 'PENDING', id: { not: 'edit' } },
    });
  });
  it('explains a stale approval clearly instead of failing silently', async () => {
    const f = fixture();
    f.raw.medicine.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      decideCatalogueEdit(f.db, scope, { editId: 'edit', decision: 'APPROVE' })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('out of date'),
    });
  });
  it('flags pending edits whose item changed after submission', async () => {
    const f = fixture();
    const later = new Date(timestamp.getTime() + 1000);
    f.raw.pharmacyCatalogueEdit.findMany.mockResolvedValue([
      {
        id: 'current',
        expectedUpdatedAt: later,
        medicine: { productName: 'Lotion', updatedAt: later },
        editor: { name: 'Editor' },
      },
      {
        id: 'older',
        expectedUpdatedAt: timestamp,
        medicine: { productName: 'Lotion', updatedAt: later },
        editor: { name: 'Editor' },
      },
    ]);
    const edits = await listPendingCatalogueEdits(f.db);
    expect(edits.map(({ id, stale }) => ({ id, stale }))).toEqual([
      { id: 'current', stale: false },
      { id: 'older', stale: true },
    ]);
    expect(edits[1]!.medicine).toEqual({ productName: 'Lotion' });
    expect(f.raw.pharmacyCatalogueEdit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'PENDING' } })
    );
  });
  it('names the pack and presentation each queued command targets', async () => {
    const f = fixture();
    const row = (id: string, operation: string, json: Record<string, unknown>) => ({
      id,
      operation,
      changes: { json },
      expectedUpdatedAt: timestamp,
      medicine: { productName: 'Tablets', updatedAt: timestamp },
      editor: { name: 'Editor' },
    });
    f.raw.pharmacyCatalogueEdit.findMany.mockResolvedValue([
      row('barcode', 'setPackBarcode', { packLevelId: 'pack_strip', code: '501' }),
      row('pack', 'createPackLevel', { presentationId: 'presentation_a', level: 'BOX' }),
      row('revise', 'revisePackLevel', { id: 'pack_strip', unitsPerParent: 12 }),
      row('missing', 'recordPrintedMrp', { packLevelId: 'pack_gone', printedMrpMinor: 500 }),
      {
        ...row('details', 'UPDATE_MEDICINE', {}),
        changes: { productName: 'Renamed', id: 'x' },
      },
    ]);
    const edits = await listPendingCatalogueEdits(f.db);
    expect(Object.fromEntries(edits.map((edit) => [edit.id, edit.targets]))).toEqual({
      barcode: [{ label: 'Pack', value: 'STRIP (10 per pack), 3 x 10 tablets' }],
      pack: [{ label: 'Presentation', value: '3 x 10 tablets' }],
      revise: [{ label: 'Pack', value: 'STRIP (10 per pack), 3 x 10 tablets' }],
      missing: [{ label: 'Pack', value: 'Pack not found' }],
      details: [],
    });
    expect(f.raw.packLevel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['pack_strip', 'pack_gone'] } } })
    );
  });
  it('names the pack and branch a queued pack price applies to (DEV-923)', async () => {
    const f = fixture();
    const row = (id: string, json: Record<string, unknown>) => ({
      id,
      operation: 'setPackPrice',
      changes: { json },
      expectedUpdatedAt: timestamp,
      medicine: { productName: 'Tablets', updatedAt: timestamp },
      editor: { name: 'Editor' },
    });
    const branches = vi.fn(async () => [{ id: 'branch_a', name: 'Saddar' }]);
    Object.assign(f.raw, { pharmacyBranch: { findMany: branches } });
    f.raw.pharmacyCatalogueEdit.findMany.mockResolvedValue([
      row('shop', { packLevelId: 'pack_strip', mrpMinor: 500, sellingPriceMinor: null }),
      row('branch', { packLevelId: 'pack_strip', branchId: 'branch_a', mrpMinor: 500 }),
      row('gone', { packLevelId: 'pack_strip', branchId: 'branch_gone', mrpMinor: 500 }),
    ]);
    const edits = await listPendingCatalogueEdits(f.db);
    const pack = { label: 'Pack', value: 'STRIP (10 per pack), 3 x 10 tablets' };
    expect(Object.fromEntries(edits.map((edit) => [edit.id, edit.targets]))).toEqual({
      shop: [pack, { label: 'Applies to', value: 'All branches' }],
      branch: [pack, { label: 'Applies to', value: 'Saddar only' }],
      gone: [pack, { label: 'Applies to', value: 'Branch not found only' }],
    });
    expect(branches).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['branch_a', 'branch_gone'] } } })
    );
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
    await decideCatalogueEdit(f.db, scope, {
      editId: 'edit',
      decision: 'REJECT',
    });
    expect(f.raw.pharmacyCatalogueEdit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'REJECTED',
          soloPinVerifiedAt: null,
        }),
      })
    );
    expect(f.raw.medicine.updateMany).not.toHaveBeenCalled();
  });
  it('fails closed for missing tenant targets and forbids saleability/family injection', async () => {
    const f = fixture();
    f.raw.medicine.findFirst.mockResolvedValueOnce(null);
    await expect(
      submitCatalogueEdit(f.db, scope, 'foreign', { productName: 'x' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      submitCatalogueEdit(f.db, scope, 'medicine', { saleable: true })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      submitCatalogueEdit(f.db, scope, 'medicine', {
        productFamily: 'FRONT_SHOP',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // An out-of-range price is a validation error, never an internal server error.
    await expect(
      submitCatalogueEdit(f.db, scope, 'medicine', { retailPriceMinor: 2_147_483_648 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.raw.pharmacyCatalogueEdit.create).not.toHaveBeenCalled();
  });
  it('enforces the separation check for assertions as well as catalogue proposals', async () => {
    await expect(
      requireIndependentCatalogueReviewer(fixture().db, scope, ['reviewer'])
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('applies a queued new ingredient, which names no medicine, without touching any medicine (DEV-19)', async () => {
    const f = fixture();
    Object.assign(f.proposal, {
      medicineId: null,
      operation: 'createIngredient',
      changes: { json: { name: 'Paracetamol' } },
    });
    const apply = vi.fn(async () => ({ id: 'ingredient' }));
    await expect(
      decideCatalogueEdit(f.db, scope, { editId: 'edit', decision: 'APPROVE' }, apply)
    ).resolves.toEqual({ id: 'edit', status: 'APPROVED', staleEdits: 0 });
    expect(apply).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      'createIngredient',
      { json: { name: 'Paracetamol' } },
      'editor'
    );
    expect(f.raw.medicine.findFirst).not.toHaveBeenCalled();
    expect(f.raw.medicine.updateMany).not.toHaveBeenCalled();
    expect(f.raw.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'pharmacy.catalogueApproval', targetId: 'edit' }),
      })
    );
  });
  it('holds a solo-owner approval to a fresh PIN even for an edit someone else submitted', async () => {
    guards.solo.mockResolvedValue(true);
    const f = fixture('former_editor');
    const input = { editId: 'edit', decision: 'APPROVE' as const };
    await expect(
      decideCatalogueEdit(f.db, scope, input, undefined, { soloOwnerAuthority: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.raw.medicine.updateMany).not.toHaveBeenCalled();
    await decideCatalogueEdit(f.db, scope, { ...input, soloPin: '2468' }, undefined, {
      soloOwnerAuthority: true,
    });
    expect(guards.pin).toHaveBeenCalledWith({
      organizationId: 'org_a',
      userId: 'reviewer',
      pin: '2468',
    });
    expect(f.raw.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'pharmacy.catalogueSoloOwnerApproval' }),
    });
  });
  it('refuses any other medicine-less edit instead of applying it', async () => {
    const f = fixture();
    Object.assign(f.proposal, { medicineId: null, operation: 'addAlias' });
    const apply = vi.fn();
    await expect(
      decideCatalogueEdit(f.db, scope, { editId: 'edit', decision: 'APPROVE' }, apply)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(apply).not.toHaveBeenCalled();
    expect(f.raw.auditLog.create).not.toHaveBeenCalled();
  });
  it('lists a queued new ingredient as current, never stale', async () => {
    const f = fixture();
    f.raw.pharmacyCatalogueEdit.findMany.mockResolvedValue([
      {
        id: 'ingredient_edit',
        operation: 'createIngredient',
        changes: { json: { name: 'Paracetamol' } },
        expectedUpdatedAt: timestamp,
        medicine: null,
        editor: { name: 'Editor' },
      },
    ]);
    const [edit] = await listPendingCatalogueEdits(f.db);
    expect(edit).toMatchObject({
      id: 'ingredient_edit',
      stale: false,
      medicine: { productName: 'New ingredient' },
      targets: [],
    });
  });
});
