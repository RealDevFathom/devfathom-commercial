import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  confirmDrapRecall,
  dismissDrapPriceAlert,
  dismissDrapRecall,
  drapRecallReviewQueue,
  FileDrapNoticeSource,
  ingestDrapNotice,
  listDrapPriceAlerts,
} from './drap-monitoring';
import { officialPriceText } from './official-price';

const quarantinePart = vi.hoisted(() =>
  vi.fn(async () => ({ removed: { id: 'move-removed' }, held: { id: 'move-held' } }))
);
vi.mock('./inventory-operations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./inventory-operations')>()),
  quarantinePart,
}));

describe('DRAP monitoring', () => {
  it('parses the shipped file adapter without implying a live feed', async () => {
    const source = new FileDrapNoticeSource(
      JSON.stringify([
        {
          kind: 'PRICE',
          sourceReference: 'SRO-1',
          drapRegistrationNumber: '01234',
          notifiedPriceMinor: 1250,
          effectiveDate: '2026-09-12T00:00:00.000Z',
        },
      ])
    );
    await expect(source.read()).resolves.toEqual([
      {
        kind: 'PRICE',
        sourceReference: 'SRO-1',
        drapRegistrationNumber: '01234',
        notifiedPriceMinor: 1250,
        effectiveDate: new Date('2026-09-12T00:00:00.000Z'),
      },
    ]);
    expect(source.adapter).toBe('FILE');
  });

  it('surfaces an ambiguous medicine match and never quarantines it', async () => {
    const create = vi.fn(async ({ data }) => ({ id: 'ingest-1', ...data }));
    const updateMany = vi.fn();
    const movementCreate = vi.fn();
    const db = {
      $queryRaw: vi.fn(async () => []),
      pharmacyDrapIngest: { findFirst: vi.fn(async () => null), create },
      medicine: { findMany: vi.fn(async () => [{ id: 'med-a' }, { id: 'med-b' }]) },
      pharmacyManufacturingBatch: { updateMany },
      pharmacyStockMovement: { create: movementCreate },
    } as unknown as ScopedDb;
    const result = await ingestDrapNotice(
      db,
      { organizationId: 'org-a', actorId: 'pharmacist-a' },
      'MANUAL',
      {
        kind: 'RECALL',
        sourceReference: 'DRAP-R-7',
        drapRegistrationNumber: 'duplicate',
        reason: 'Recall',
      }
    );
    expect(result).toMatchObject({ matchStatus: 'AMBIGUOUS' });
    expect(updateMany).not.toHaveBeenCalled();
    expect(movementCreate).not.toHaveBeenCalled();
  });

  it('is idempotent and rejects a reused reference with changed contents', async () => {
    const notice = {
      kind: 'RECALL' as const,
      sourceReference: 'DRAP-R-8',
      drapRegistrationNumber: '123',
      reason: 'Recall',
    };
    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256').update(JSON.stringify(notice)).digest('hex');
    const db = {
      $queryRaw: vi.fn(async () => []),
      pharmacyDrapIngest: { findFirst: vi.fn(async () => ({ id: 'existing', payloadHash: hash })) },
    } as unknown as ScopedDb;
    await expect(
      ingestDrapNotice(db, { organizationId: 'org-a', actorId: 'p' }, 'FILE', notice)
    ).resolves.toMatchObject({ id: 'existing' });
    await expect(
      ingestDrapNotice(db, { organizationId: 'org-a', actorId: 'p' }, 'FILE', {
        ...notice,
        reason: 'Changed',
      })
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  });

  describe('DEV-692 recall review queue', () => {
    const scope = { organizationId: 'org-a', actorId: 'pharmacist-a' };
    const notice = {
      kind: 'RECALL' as const,
      sourceReference: 'DRAP-WEB:I/S/10-26-45:1',
      drapRegistrationNumber: '060235',
      batchNumbers: ['26A059'],
      reason: 'Substandard',
      productName: 'Carapamin Injection 200mg',
    };

    function matchedDb() {
      const ingestCreate = vi.fn(async ({ data }) => ({ id: 'ingest-1', ...data }));
      const db = {
        $queryRaw: vi.fn(async () => []),
        pharmacyDrapIngest: { findFirst: vi.fn(async () => null), create: ingestCreate },
        medicine: { findMany: vi.fn(async () => [{ id: 'med-a' }]) },
        pharmacyManufacturingBatch: {
          findMany: vi.fn(async () => [{ id: 'batch-a', batchNumber: '26A059' }]),
          updateMany: vi.fn(),
        },
        pharmacyRecallNotice: { create: vi.fn() },
        pharmacyStockBalance: { findMany: vi.fn(async () => []) },
        pharmacyRecallQuarantineAction: { create: vi.fn() },
      };
      return { db, ingestCreate };
    }

    it('files a matched alert as a pending draft and never recalls or quarantines', async () => {
      const { db, ingestCreate } = matchedDb();
      const result = await ingestDrapNotice(db as unknown as ScopedDb, scope, 'DRAP_WEB', notice);
      expect(result).toMatchObject({
        matchStatus: 'MATCHED',
        reviewStatus: 'PENDING_REVIEW',
        adapter: 'DRAP_WEB',
        matchDetails: { medicineId: 'med-a', batchIds: ['batch-a'], recallScope: 'BATCH' },
        recallPayload: expect.objectContaining({ productName: 'Carapamin Injection 200mg' }),
      });
      expect(ingestCreate.mock.calls[0]![0].data).not.toHaveProperty('recallNoticeId');
      expect(db.pharmacyRecallNotice.create).not.toHaveBeenCalled();
      expect(db.pharmacyManufacturingBatch.updateMany).not.toHaveBeenCalled();
      expect(db.pharmacyStockBalance.findMany).not.toHaveBeenCalled();
      expect(quarantinePart).not.toHaveBeenCalled();
    });

    it('queues an alert without a registration number as NO_MATCH without a catalog lookup', async () => {
      const { db } = matchedDb();
      const result = await ingestDrapNotice(db as unknown as ScopedDb, scope, 'DRAP_WEB', {
        ...notice,
        drapRegistrationNumber: '',
      });
      expect(result).toMatchObject({ matchStatus: 'NO_MATCH', reviewStatus: 'PENDING_REVIEW' });
      expect(db.medicine.findMany).not.toHaveBeenCalled();
    });

    function draftDb(draft: Record<string, unknown>) {
      const state = { ...draft };
      const db = {
        $queryRaw: vi.fn(async () => []),
        pharmacyDrapIngest: {
          findFirst: vi.fn(async () => state),
          findFirstOrThrow: vi.fn(async () => state),
          updateMany: vi.fn(async ({ where, data }) => {
            if (state.reviewStatus !== where.reviewStatus) return { count: 0 };
            Object.assign(state, data);
            return { count: 1 };
          }),
        },
        pharmacyManufacturingBatch: {
          findMany: vi.fn(async () => [{ id: 'batch-a' }]),
          updateMany: vi.fn(),
        },
        pharmacyRecallNotice: { create: vi.fn(async () => ({ id: 'recall-1' })) },
        pharmacyStockBalance: {
          findMany: vi.fn(async () => [
            {
              branchId: 'branch-a',
              inventoryLotId: 'lot-a',
              stockLocationId: 'loc-a',
              onHandUnits: 12,
              disposition: 'AVAILABLE',
            },
          ]),
        },
        pharmacyRecallQuarantineAction: { create: vi.fn() },
      };
      return { db, state };
    }
    const matchedDraft = {
      id: 'ingest-1',
      kind: 'RECALL',
      sourceReference: notice.sourceReference,
      matchStatus: 'MATCHED',
      reviewStatus: 'PENDING_REVIEW',
      recallPayload: notice,
      matchDetails: { medicineId: 'med-a', batchIds: ['batch-a'] },
    };

    it('opens the recall and quarantines stock only when a person confirms', async () => {
      quarantinePart.mockClear();
      const { db, state } = draftDb(matchedDraft);
      await confirmDrapRecall(db as unknown as ScopedDb, scope, 'ingest-1', 'Checked shelf');
      expect(db.pharmacyRecallNotice.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          batchId: 'batch-a',
          reference: notice.sourceReference,
          reason: 'Substandard',
          createdById: 'pharmacist-a',
        }),
      });
      expect(state).toMatchObject({
        reviewStatus: 'CONFIRMED',
        recallNoticeId: 'recall-1',
        reviewedById: 'pharmacist-a',
        reviewNote: 'Checked shelf',
      });
      expect(db.pharmacyManufacturingBatch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ state: 'RECALLED' }) })
      );
      expect(quarantinePart).toHaveBeenCalledTimes(1);
      expect(db.pharmacyRecallQuarantineAction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ ingestId: 'ingest-1', quantityUnits: 12 }),
      });
      await expect(
        confirmDrapRecall(db as unknown as ScopedDb, scope, 'ingest-1')
      ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    });

    it('DEV-825: locks the batches, then every balance sorted, before recalling or quarantining', async () => {
      quarantinePart.mockClear();
      const { db } = draftDb(matchedDraft);
      db.pharmacyStockBalance.findMany.mockResolvedValue([
        {
          branchId: 'branch-b',
          inventoryLotId: 'lot-b',
          stockLocationId: 'loc-a',
          onHandUnits: 1,
          disposition: 'AVAILABLE',
        },
        {
          branchId: 'branch-a',
          inventoryLotId: 'lot-a',
          stockLocationId: 'loc-a',
          onHandUnits: 1,
          disposition: 'AVAILABLE',
        },
      ]);
      await confirmDrapRecall(db as unknown as ScopedDb, scope, 'ingest-1');
      const statements = (db.$queryRaw.mock.calls as unknown[][]).map(
        ([sql]) => sql as { strings?: string[]; values: unknown[] }
      );
      const at = (kind: string) =>
        statements.findIndex((sql) => sql.strings?.join('').includes(`stock_lock:${kind}`));
      const order = db.$queryRaw.mock.invocationCallOrder;
      expect(at('batch')).toBeGreaterThanOrEqual(0);
      expect(order[at('batch')]!).toBeLessThan(
        db.pharmacyManufacturingBatch.updateMany.mock.invocationCallOrder[0]!
      );
      expect(at('balance')).toBeGreaterThan(at('batch'));
      expect(statements[at('balance')]!.values.slice(1)).toEqual([
        'lot-a',
        'loc-a',
        'AVAILABLE',
        'lot-a',
        'loc-a',
        'QUARANTINE',
        'lot-b',
        'loc-a',
        'AVAILABLE',
        'lot-b',
        'loc-a',
        'QUARANTINE',
      ]);
      expect(order[at('balance')]!).toBeLessThan(quarantinePart.mock.invocationCallOrder[0]!);
    });

    it('recalls every current batch when an alert that names no batch is confirmed', async () => {
      const { db } = draftDb({
        ...matchedDraft,
        matchDetails: {
          medicineId: 'med-a',
          batchIds: ['batch-a', 'batch-b'],
          batchesNamed: false,
        },
      });
      db.pharmacyManufacturingBatch.findMany.mockResolvedValue([
        { id: 'batch-a' },
        { id: 'batch-b' },
        { id: 'batch-received-later' },
      ]);
      await confirmDrapRecall(db as unknown as ScopedDb, scope, 'ingest-1');
      expect(db.pharmacyManufacturingBatch.findMany).toHaveBeenCalledWith({
        where: { organizationId: 'org-a', medicineId: 'med-a' },
        select: { id: true },
      });
      expect(db.pharmacyRecallNotice.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ medicineId: 'med-a', batchId: undefined }),
      });
      expect(db.pharmacyManufacturingBatch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: 'org-a',
            id: { in: ['batch-a', 'batch-b', 'batch-received-later'] },
          },
        })
      );
    });

    it('refuses to broaden a named-batch draft when another batch has since arrived', async () => {
      const { db } = draftDb({
        ...matchedDraft,
        matchDetails: { medicineId: 'med-a', batchIds: ['batch-a', 'batch-b'], batchesNamed: true },
      });
      db.pharmacyManufacturingBatch.findMany.mockResolvedValue([
        { id: 'batch-a' },
        { id: 'batch-b' },
        { id: 'batch-received-later' },
      ]);
      await expect(
        confirmDrapRecall(db as unknown as ScopedDb, scope, 'ingest-1')
      ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
      expect(db.pharmacyRecallNotice.create).not.toHaveBeenCalled();
      expect(db.pharmacyManufacturingBatch.updateMany).not.toHaveBeenCalled();
    });

    it('files an alert whose batches could not be read as AMBIGUOUS, never medicine-wide', async () => {
      const { db } = matchedDb();
      const result = await ingestDrapNotice(db as unknown as ScopedDb, scope, 'DRAP_WEB', {
        ...notice,
        batchNumbers: undefined,
        batchNumbersUnresolved: true,
      });
      expect(result).toMatchObject({
        matchStatus: 'AMBIGUOUS',
        reviewStatus: 'PENDING_REVIEW',
        matchDetails: { batchNumbersUnresolved: true },
      });
    });

    it.each(['AMBIGUOUS', 'NO_MATCH'])('refuses to confirm a %s draft', async (matchStatus) => {
      const { db } = draftDb({ ...matchedDraft, matchStatus });
      await expect(
        confirmDrapRecall(db as unknown as ScopedDb, scope, 'ingest-1')
      ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
      expect(db.pharmacyRecallNotice.create).not.toHaveBeenCalled();
    });

    it('dismisses a draft with a reason and leaves stock untouched', async () => {
      const { db, state } = draftDb(matchedDraft);
      await expect(
        dismissDrapRecall(db as unknown as ScopedDb, scope, 'ingest-1', '  ')
      ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
      await dismissDrapRecall(db as unknown as ScopedDb, scope, 'ingest-1', 'Not stocked');
      expect(state).toMatchObject({ reviewStatus: 'DISMISSED', reviewNote: 'Not stocked' });
      expect(db.pharmacyRecallNotice.create).not.toHaveBeenCalled();
      expect(db.pharmacyStockBalance.findMany).not.toHaveBeenCalled();
    });

    it('lists pending drafts with matched batches and available units from SQL', async () => {
      const db = {
        $queryRaw: vi.fn(async () => [{ batchId: 'batch-a', units: 12 }]),
        pharmacyDrapIngest: {
          findMany: vi.fn(async ({ where }) =>
            where.reviewStatus === 'PENDING_REVIEW'
              ? [
                  {
                    ...matchedDraft,
                    adapter: 'DRAP_WEB',
                    createdAt: new Date('2026-11-15'),
                    reviewNote: null,
                    reviewedAt: null,
                    recallNoticeId: null,
                    matchDetails: {
                      ...matchedDraft.matchDetails,
                      batches: [{ id: 'batch-a', batchNumber: '26A059' }],
                    },
                  },
                ]
              : []
          ),
        },
        medicine: {
          findMany: vi.fn(async () => [
            {
              id: 'med-a',
              productName: 'Dopamine',
              brandName: 'Carapamin',
              drapRegistrationNumber: '060235',
            },
          ]),
        },
      };
      const queue = await drapRecallReviewQueue(db as unknown as ScopedDb, scope);
      expect(queue.pending[0]).toMatchObject({
        recallScope: 'BATCH',
        medicine: { id: 'med-a' },
        batches: [{ id: 'batch-a', batchNumber: '26A059', availableUnits: 12 }],
        alert: { registrationNumber: '060235', batchNumbers: ['26A059'] },
      });
      expect(queue.decided).toEqual([]);
    });
  });
});

describe('DEV-693 DRAP price notices are information only', () => {
  const priceNotice = {
    kind: 'PRICE' as const,
    sourceReference: 'SRO-1092(I)/2023 / 012345',
    drapRegistrationNumber: '012345',
    presentation: 'Tablet 500 mg',
    packLevel: 'BOX' as const,
    notifiedPriceMinor: 31500,
    effectiveDate: new Date('2026-12-01T00:00:00.000Z'),
  };
  function fakeDb(medicines: { id: string }[]) {
    const create = vi.fn(async ({ data }) => ({ id: 'ingest-1', ...data }));
    const proposalCreate = vi.fn();
    const packPriceCreate = vi.fn();
    const medicineFindMany = vi.fn(async () => medicines);
    const db = {
      pharmacyDrapIngest: { findFirst: vi.fn(async () => null), create },
      medicine: { findMany: medicineFindMany },
      pharmacyPriceChangeProposal: { create: proposalCreate },
      pharmacyPackPrice: { create: packPriceCreate },
    } as unknown as ScopedDb;
    return { db, create, proposalCreate, packPriceCreate, medicineFindMany };
  }

  it('creates an alert for a matching medicine and no price change or proposal', async () => {
    const { db, create, proposalCreate, packPriceCreate, medicineFindMany } = fakeDb([
      { id: 'med-a' },
    ]);
    await ingestDrapNotice(
      db,
      { organizationId: 'org-a', actorId: 'owner-a' },
      'FILE',
      priceNotice
    );
    expect(medicineFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', drapRegistrationNumber: '012345' },
      })
    );
    expect(create).toHaveBeenCalledOnce();
    const { data } = create.mock.calls[0]![0];
    expect(data).toMatchObject({
      organizationId: 'org-a',
      matchStatus: 'MATCHED',
      priceAlerts: {
        create: {
          medicineId: 'med-a',
          notifiedPriceMinor: 31500,
          effectiveDate: priceNotice.effectiveDate,
        },
      },
    });
    expect(data).not.toHaveProperty('priceChanges');
    expect(proposalCreate).not.toHaveBeenCalled();
    expect(packPriceCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['no', []],
    ['an ambiguous', [{ id: 'med-a' }, { id: 'med-b' }]],
  ])('creates no alert or proposal for %s catalogue match', async (_label, medicines) => {
    const { db, create, proposalCreate, packPriceCreate } = fakeDb(medicines);
    await ingestDrapNotice(
      db,
      { organizationId: 'org-a', actorId: 'owner-a' },
      'FILE',
      priceNotice
    );
    const { data } = create.mock.calls[0]![0];
    expect(data).not.toHaveProperty('priceAlerts');
    expect(data).not.toHaveProperty('priceChanges');
    expect(proposalCreate).not.toHaveBeenCalled();
    expect(packPriceCreate).not.toHaveBeenCalled();
  });

  it('lists and dismisses alerts only inside the caller organization', async () => {
    const findMany = vi.fn(async () => [
      {
        id: 'alert-1',
        medicineId: 'med-a',
        notifiedPriceMinor: 31500,
        effectiveDate: priceNotice.effectiveDate,
        createdAt: new Date('2026-11-15'),
        medicine: { productName: 'Example tablet' },
        ingest: {
          sourceReference: priceNotice.sourceReference,
          priceNotice: { presentation: 'Tablet 500 mg', packLevel: 'BOX' },
        },
      },
    ]);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const db = { pharmacyDrapPriceAlert: { findMany, updateMany } } as unknown as ScopedDb;
    const scope = { organizationId: 'org-a', actorId: 'owner-a' };
    await expect(listDrapPriceAlerts(db, scope, ['med-a'])).resolves.toEqual([
      expect.objectContaining({
        id: 'alert-1',
        medicine: 'Example tablet',
        presentation: 'Tablet 500 mg',
        packLevel: 'BOX',
        notifiedPriceMinor: 31500,
      }),
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', dismissedAt: null, medicineId: { in: ['med-a'] } },
      })
    );
    await dismissDrapPriceAlert(db, scope, 'alert-1');
    expect(updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', id: 'alert-1', dismissedAt: null },
      data: { dismissedById: 'owner-a', dismissedAt: expect.any(Date) },
    });
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(dismissDrapPriceAlert(db, scope, 'other-org-alert')).rejects.toMatchObject({
      reason: 'NOT_FOUND',
    });
  });

  it('words the alert as the official figure and date only', () => {
    expect(
      officialPriceText({ effectiveDate: priceNotice.effectiveDate, notifiedPriceMinor: 31500 })
    ).toMatch(/^Official price changed as of 2026-12-01: Rs\s?315\.00$/);
  });
});
