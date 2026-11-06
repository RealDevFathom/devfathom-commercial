// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  createMany: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  findJob: vi.fn(),
  organization: vi.fn(),
  organizationUpdate: vi.fn(),
  lifecycle: vi.fn(),
  deployment: vi.fn(),
  support: vi.fn(),
  scope: vi.fn(),
  snapshot: vi.fn(),
  retention: vi.fn(),
  consent: vi.fn(),
  archiveCreate: vi.fn(),
  archiveDelete: vi.fn(),
  catalogue: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: m.scope }));
vi.mock('@/lib/pharmacy/counter-evidence', () => ({
  PHARMACY_CAMERA_SNAPSHOT_JOB: 'pharmacy.camera.snapshot.v1',
  runCounterEvidenceSnapshotJob: m.snapshot,
  runCameraEvidenceRetentionJob: m.retention,
}));
vi.mock('@/lib/pharmacy/default-catalogue', () => ({ runDefaultCatalogueJob: m.catalogue }));
import { processPlatformJobs } from './jobs';

const db = {
  $queryRaw: m.query,
  $executeRawUnsafe: m.execute,
  platformJob: {
    createMany: m.createMany,
    updateMany: m.updateMany,
    update: m.update,
    findUnique: m.findJob,
  },
  organization: { findUnique: m.organization, update: m.organizationUpdate },
  organizationLifecycleEvent: { create: m.lifecycle },
  organizationDeployment: { updateMany: m.deployment },
  platformSupportSession: { updateMany: m.support },
  pharmacyCustomer: { findMany: m.consent },
  pharmacyWhatsAppConsentArchive: { createMany: m.archiveCreate, deleteMany: m.archiveDelete },
};
const now = new Date('2026-10-12T01:15:00.000Z');
function job(type: string, extra = {}) {
  return {
    id: 'job-1',
    organizationId: 'tenant-a',
    type,
    payload: { arbitrary: true },
    attempts: 1,
    maxAttempts: 3,
    ...extra,
  };
}
function queue(item: ReturnType<typeof job>, dependencies: unknown[] = []) {
  let claimed = false;
  m.query.mockImplementation(async (sql: { text?: string; strings?: string[] }) => {
    const text = sql.text ?? sql.strings?.join('') ?? '';
    if (text.includes('FOR UPDATE SKIP LOCKED')) {
      if (claimed) return [];
      claimed = true;
      return [{ id: item.id }];
    }
    if (text.includes('WITH tenant_tables')) return dependencies;
    return [];
  });
  m.update.mockImplementation(async ({ data }) => (data.status === 'RUNNING' ? item : data));
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  m.scope.mockImplementation(async (work) => work(db));
  m.query.mockResolvedValue([]);
  m.updateMany.mockResolvedValue({ count: 2 });
  m.findJob.mockResolvedValue({ status: 'RUNNING' });
  m.createMany.mockResolvedValue({ count: 0 });
  m.snapshot.mockResolvedValue({ captured: true });
  m.retention.mockResolvedValue({ purged: 1 });
  m.organization.mockResolvedValue({ status: 'PURGING', purgeScheduledAt: new Date('2026-10-01') });
  m.execute.mockResolvedValue(1);
  m.deployment.mockResolvedValue({ count: 1 });
  m.consent.mockResolvedValue([]);
  m.archiveCreate.mockResolvedValue({ count: 0 });
  m.archiveDelete.mockResolvedValue({ count: 0 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('composed platform worker boundaries', () => {
  it('runs the default catalogue apply outside the platform transaction', async () => {
    const applied = { organizationId: 'tenant-a', created: 50, batches: 1 };
    let insideScope = false;
    m.scope.mockImplementation(async (work) => {
      insideScope = true;
      try {
        return await work(db);
      } finally {
        insideScope = false;
      }
    });
    m.catalogue.mockImplementation(async () => {
      expect(insideScope).toBe(false);
      return applied;
    });
    queue(job('PHARMACY_DEFAULT_CATALOGUE_V1'));
    await expect(processPlatformJobs(1)).resolves.toMatchObject({ claimed: 1, succeeded: 1 });
    expect(m.catalogue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: 'PHARMACY_DEFAULT_CATALOGUE_V1', organizationId: 'tenant-a' })
    );
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SUCCEEDED', result: applied }),
      })
    );
  });

  it('expires consent evidence on an idle worker run without an archive key', async () => {
    vi.stubEnv('PLATFORM_ENCRYPTION_KEY', '');
    await expect(processPlatformJobs()).resolves.toMatchObject({ claimed: 0 });
    expect(m.archiveDelete).toHaveBeenCalledExactlyOnceWith({
      where: { expiresAt: { lte: now } },
    });
    expect(m.archiveCreate).not.toHaveBeenCalled();
  });

  it('propagates enqueue failure before stale recovery or any claim', async () => {
    const error = new Error('camera enqueue unavailable');
    m.createMany.mockRejectedValue(error);
    await expect(processPlatformJobs()).rejects.toBe(error);
    expect(m.updateMany).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
    expect(m.snapshot).not.toHaveBeenCalled();
    expect(m.deployment).not.toHaveBeenCalled();
  });
  it('recovers stale work and preserves suspend revocation after a successful enqueue', async () => {
    queue(job('SUSPEND'));
    await expect(processPlatformJobs(1)).resolves.toEqual({
      recovered: 2,
      claimed: 1,
      succeeded: 1,
      retried: 0,
      failed: 0,
    });
    expect(m.createMany.mock.invocationCallOrder[0]).toBeLessThan(
      m.updateMany.mock.invocationCallOrder[0]
    );
    expect(m.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'RUNNING', startedAt: { lt: new Date(now.getTime() - 15 * 60_000) } },
      })
    );
    expect(m.support).toHaveBeenCalledWith({
      where: { organizationId: 'tenant-a', status: 'ACTIVE' },
      data: { status: 'REVOKED', endedAt: now },
    });
    expect(m.deployment).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'tenant-a', status: { not: 'DECOMMISSIONED' } },
      })
    );
  });
  it('keeps tenant-scoped snapshot and hourly retention keys stable across repeated relays', async () => {
    m.query.mockImplementation(async (sql: { text: string; values: unknown[] }) => {
      if (sql.text.includes('LEFT JOIN "platform_jobs"')) {
        expect(sql.text).toContain('j."id" IS NULL');
        expect(sql.text).toContain('e."requestedAt" >=');
        expect(sql.values).toContain(50);
        expect(sql.values).toContainEqual(new Date(now.getTime() - 15 * 60_000));
        return [
          { id: 'e-a', organizationId: 'tenant-a' },
          { id: 'e-b', organizationId: 'tenant-b' },
        ];
      }
      if (sql.text.includes('SELECT DISTINCT'))
        return [{ organizationId: 'tenant-a' }, { organizationId: 'tenant-b' }];
      return [];
    });
    await processPlatformJobs();
    await processPlatformJobs();
    const first = m.createMany.mock.calls[0][0];
    expect(m.createMany.mock.calls[1][0]).toEqual(first);
    expect(first.skipDuplicates).toBe(true);
    expect(first.data).toEqual([
      {
        organizationId: 'tenant-a',
        type: 'PHARMACY_CAMERA_SNAPSHOT_V1',
        payload: { evidenceId: 'e-a' },
        idempotencyKey: 'pharmacy.camera.snapshot.v1:e-a',
      },
      {
        organizationId: 'tenant-b',
        type: 'PHARMACY_CAMERA_SNAPSHOT_V1',
        payload: { evidenceId: 'e-b' },
        idempotencyKey: 'pharmacy.camera.snapshot.v1:e-b',
      },
      {
        organizationId: 'tenant-a',
        type: 'CAMERA_EVIDENCE_RETENTION_V1',
        idempotencyKey: 'camera.evidence.retention.v1:tenant-a:2026-10-12T01',
      },
      {
        organizationId: 'tenant-b',
        type: 'CAMERA_EVIDENCE_RETENTION_V1',
        idempotencyKey: 'camera.evidence.retention.v1:tenant-b:2026-10-12T01',
      },
    ]);
  });
  it('dispatches retention with the long timeout without passing generic payload as options', async () => {
    const item = job('CAMERA_EVIDENCE_RETENTION_V1');
    queue(item);
    await processPlatformJobs(1);
    expect(m.retention).toHaveBeenCalledExactlyOnceWith(db, item);
    expect(m.scope).toHaveBeenCalledWith(expect.any(Function), { timeout: 120_000 });
  });
  it.each([1, 3])('retains retry/exhaustion accounting at attempt %s', async (attempts) => {
    queue(job('PHARMACY_CAMERA_SNAPSHOT_V1', { attempts }));
    m.snapshot.mockRejectedValue(new Error('snapshot unavailable'));
    const result = await processPlatformJobs(1);
    expect(result).toMatchObject(
      attempts === 1 ? { retried: 1, failed: 0 } : { retried: 0, failed: 1 }
    );
    expect(m.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: attempts === 1 ? 'QUEUED' : 'FAILED',
          error: 'snapshot unavailable',
        }),
      })
    );
  });
  it('does not overwrite a cancelled job completion', async () => {
    queue(job('PHARMACY_CAMERA_SNAPSHOT_V1'));
    m.findJob.mockResolvedValue({ status: 'CANCELLED' });
    await processPlatformJobs(1);
    expect(m.update).toHaveBeenCalledTimes(1);
  });
  it('preserves support history, platform audit/lifecycle and the organization shell while deleting business data', async () => {
    vi.stubEnv('PLATFORM_ENCRYPTION_KEY', '');
    queue(job('PURGE_DATA'), [
      { tableName: 'platform_support_sessions', parentTable: 'organizations', nullableColumns: [] },
      { tableName: 'organizations', parentTable: null, nullableColumns: [] },
      { tableName: 'users', parentTable: 'organizations', nullableColumns: [] },
      { tableName: 'platform_audit_logs', parentTable: 'organizations', nullableColumns: [] },
      {
        tableName: 'organization_lifecycle_events',
        parentTable: 'organizations',
        nullableColumns: [],
      },
    ]);
    await expect(processPlatformJobs(1)).resolves.toMatchObject({ succeeded: 1, failed: 0 });
    expect(m.execute.mock.calls).toEqual([
      ['DELETE FROM "users" WHERE "organizationId" = $1', 'tenant-a'],
    ]);
    expect(m.lifecycle).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'tenant-a',
        action: 'PURGED',
        metadata: { jobId: 'job-1', deletedRows: { users: 1 } },
      }),
    });
    expect(m.consent).toHaveBeenCalledWith({
      where: {
        organizationId: 'tenant-a',
        whatsappOptIn: { not: null },
        whatsappOptInChangedAt: { not: null },
      },
      select: { id: true, whatsappOptIn: true, whatsappOptInChangedAt: true },
    });
  });
  it('does not destroy tenant data when consent evidence cannot be archived', async () => {
    vi.stubEnv('PLATFORM_ENCRYPTION_KEY', 'archive-test-key');
    queue(job('PURGE_DATA', { attempts: 3 }), [
      { tableName: 'pharmacy_customers', parentTable: 'organizations', nullableColumns: [] },
    ]);
    m.consent.mockResolvedValue([
      { id: 'customer-a', whatsappOptIn: true, whatsappOptInChangedAt: now },
    ]);
    m.archiveCreate.mockRejectedValue(new Error('consent archive unavailable'));
    await expect(processPlatformJobs(1)).resolves.toMatchObject({ failed: 1, succeeded: 0 });
    expect(m.execute).not.toHaveBeenCalled();
    expect(m.organizationUpdate).not.toHaveBeenCalled();
    expect(m.lifecycle).not.toHaveBeenCalled();
    expect(m.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ error: 'consent archive unavailable' }),
      })
    );
  });
  it('propagates a business-data deletion failure and never marks the organization purged', async () => {
    queue(job('PURGE_DATA', { attempts: 3 }), [
      { tableName: 'users', parentTable: 'organizations', nullableColumns: [] },
    ]);
    m.execute.mockRejectedValue(new Error('business-data deletion failed'));
    await expect(processPlatformJobs(1)).resolves.toMatchObject({ failed: 1, succeeded: 0 });
    expect(m.organizationUpdate).not.toHaveBeenCalled();
    expect(m.lifecycle).not.toHaveBeenCalled();
    expect(m.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ error: 'business-data deletion failed' }),
      })
    );
  });
  it.each(['ACTIVE', 'future', 'cycle'])(
    'retains purge prerequisite/cycle failure: %s',
    async (kind) => {
      const dependencies =
        kind === 'cycle'
          ? [
              { tableName: 'a', parentTable: 'b', nullableColumns: [] },
              { tableName: 'b', parentTable: 'a', nullableColumns: [] },
            ]
          : [];
      queue(job('PURGE_DATA', { attempts: 3 }), dependencies);
      if (kind === 'ACTIVE')
        m.organization.mockResolvedValue({
          status: 'ACTIVE',
          purgeScheduledAt: new Date('2026-10-01'),
        });
      if (kind === 'future')
        m.organization.mockResolvedValue({
          status: 'PURGING',
          purgeScheduledAt: new Date('2026-12-01'),
        });
      await expect(processPlatformJobs(1)).resolves.toMatchObject({ failed: 1 });
      expect(m.execute).not.toHaveBeenCalled();
      expect(m.organizationUpdate).not.toHaveBeenCalled();
    }
  );
});
