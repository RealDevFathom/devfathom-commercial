import { describe, expect, it, vi } from 'vitest';
import { commitImportBatch } from './entity-import-service';
import type { EntityImportWriter } from './entity-committers';

const context = { batchId: 'batch', actorId: 'owner', branchId: 'branch', stockLocationId: 'stock', awardImportedLoyalty: false };

describe('entity import service', () => {
  it('loads every validation result before making the first commit write', async () => {
    const setStatus = vi.fn();
    const repository = {
      batch: vi.fn(async () => ({ status: 'PREVIEW' })), rows: vi.fn(async () => []),
      openBlockingCount: vi.fn(async () => 1), manifest: vi.fn(async () => []), setStatus,
    };
    await expect(commitImportBatch(repository, {} as EntityImportWriter, context)).rejects.toThrow('blocking preview');
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('moves PREVIEW through COMMITTING to COMMITTED', async () => {
    const audit = vi.fn();
    const writer = { audit } as unknown as EntityImportWriter;
    const setStatus = vi.fn();
    await commitImportBatch({
      batch: async () => ({ status: 'PREVIEW' }), rows: async () => [], openBlockingCount: async () => 0,
      manifest: async () => [], setStatus,
    }, writer, context);
    expect(setStatus.mock.calls).toEqual([['batch', 'COMMITTING'], ['batch', 'COMMITTED']]);
    expect(audit).toHaveBeenCalledWith('pharmacy.import.commit', context, { created: 0 });
  });
});
