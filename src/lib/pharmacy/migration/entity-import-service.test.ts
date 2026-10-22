import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { Subject } from '@/lib/abac';
import type { EntityImportWriter } from './entity-committers';

const can = vi.fn();
vi.mock('@/lib/abac', () => ({ can }));

import { commitImportBatch, rollbackImportBatch, type EntityImportRepository } from './entity-import-service';

const subject = { id: 'owner', role: 'OWNER', status: 'ACTIVE' } as Subject;
const db = {} as ScopedDb;
const context = { batchId: 'batch', branchId: 'branch', stockLocationId: 'stock', awardImportedLoyalty: false };

function dependencies(status = 'PREVIEW') {
  const writer = { audit: vi.fn() } as unknown as EntityImportWriter;
  const repository = {
    transaction: vi.fn(async (work) => work(repository, writer)),
    batchForUpdate: vi.fn(async () => ({ status, organizationId: 'org', branchId: 'branch' })),
    rows: vi.fn(async () => []),
    openBlockingCount: vi.fn(async () => 0),
    manifest: vi.fn(async () => []),
    stockLocationBelongsToBranch: vi.fn(async () => true),
    loyaltyDecision: vi.fn(async () => ({ enabled: true })),
    hasOwnerAuthority: vi.fn(async () => true),
    transition: vi.fn(async () => true),
  } as EntityImportRepository;
  return { repository, writer };
}

describe('authenticated entity import transaction', () => {
  beforeEach(() => can.mockReset().mockResolvedValue(true));

  it('performs zero reads and writes when central authorization denies', async () => {
    can.mockResolvedValue(false);
    const { repository, writer } = dependencies();
    await expect(commitImportBatch(subject, db, 'org', repository, context)).rejects.toThrow('Forbidden');
    expect(repository.transaction).not.toHaveBeenCalled();
    expect(writer.audit).not.toHaveBeenCalled();
  });

  it.each([
    ['another organization', 'other-org', context],
    ['another branch', 'org', { ...context, branchId: 'other-branch' }],
  ])('rejects a batch belonging to %s before reading import rows', async (_label, organizationId, scopedContext) => {
    const { repository, writer } = dependencies();

    await expect(
      commitImportBatch(subject, db, organizationId, repository, scopedContext)
    ).rejects.toThrow('outside the authenticated branch scope');

    expect(repository.rows).not.toHaveBeenCalled();
    expect(repository.transition).not.toHaveBeenCalled();
    expect(writer.audit).not.toHaveBeenCalled();
  });

  it('claims, re-checks blockers, writes and finalizes in one transaction', async () => {
    const { repository, writer } = dependencies();
    await commitImportBatch(subject, db, 'org', repository, context);
    expect(repository.transaction).toHaveBeenCalledOnce();
    expect(repository.transition).toHaveBeenNthCalledWith(1, 'batch', 'PREVIEW', 'COMMITTING');
    expect(vi.mocked(repository.transition).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(repository.openBlockingCount).mock.invocationCallOrder[0]!);
    expect(repository.transition).toHaveBeenNthCalledWith(2, 'batch', 'COMMITTING', 'COMMITTED');
    expect(writer.audit).toHaveBeenCalledWith(
      'pharmacy.import.commit',
      expect.objectContaining({ organizationId: 'org', branchId: 'branch', actorId: 'owner' }),
      { created: 0 }
    );
  });

  it('rejects a concurrent commit when the atomic claim loses', async () => {
    const { repository } = dependencies();
    vi.mocked(repository.transition).mockResolvedValueOnce(false);
    await expect(commitImportBatch(subject, db, 'org', repository, context)).rejects.toThrow('concurrently');
    expect(repository.rows).not.toHaveBeenCalled();
  });

  it('requires both owner authority and a persisted loyalty decision', async () => {
    const { repository } = dependencies();
    vi.mocked(repository.loyaltyDecision).mockResolvedValue(null);
    await expect(commitImportBatch(subject, db, 'org', repository, { ...context, awardImportedLoyalty: true })).rejects.toThrow('owner approval');
    expect(repository.transition).not.toHaveBeenCalled();
  });

  it('makes a repeated rollback lose the committed-state check without compensating twice', async () => {
    const { repository, writer } = dependencies('ROLLED_BACK');
    await expect(rollbackImportBatch(subject, db, 'org', repository, context)).rejects.toThrow('committed');
    expect(writer.audit).not.toHaveBeenCalled();
  });

  it('writes a tenant-scoped audit receipt for a committed rollback', async () => {
    const { repository, writer } = dependencies('COMMITTED');

    await rollbackImportBatch(subject, db, 'org', repository, context);

    expect(writer.audit).toHaveBeenCalledWith(
      'pharmacy.import.rollback',
      expect.objectContaining({ organizationId: 'org', branchId: 'branch', actorId: 'owner' }),
      { entities: 0 }
    );
    expect(repository.transition).toHaveBeenCalledWith('batch', 'COMMITTED', 'ROLLED_BACK');
  });
});
