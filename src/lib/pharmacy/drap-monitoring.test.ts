import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { FileDrapNoticeSource, ingestDrapNotice } from './drap-monitoring';

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
