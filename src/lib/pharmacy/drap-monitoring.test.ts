import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  dismissDrapPriceAlert,
  FileDrapNoticeSource,
  ingestDrapNotice,
  listDrapPriceAlerts,
} from './drap-monitoring';
import { officialPriceText } from './official-price';

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
