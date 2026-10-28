// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  raw: vi.fn(),
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
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: m.scope }));
vi.mock('@/lib/pharmacy/counter-evidence', () => ({
  PHARMACY_CAMERA_SNAPSHOT_JOB: 'pharmacy.camera.snapshot.v1',
  runCounterEvidenceSnapshotJob: m.snapshot,
  runCameraEvidenceRetentionJob: m.retention,
}));
import { processPlatformJobs } from './jobs';

const db = {
  $queryRaw: m.query,
  $executeRaw: m.raw,
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
  m.raw.mockResolvedValue(1);
  m.deployment.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.useRealTimers());

describe('composed platform worker boundaries', () => {
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
  });
  it('propagates a business-data deletion failure and never marks the organization purged', async () => {
    queue(job('PURGE_DATA', { attempts: 3 }), [
      { tableName: 'users', parentTable: 'organizations', nullableColumns: [] },
    ]);
    m.execute.mockRejectedValue(new Error('business-data deletion failed'));
    await expect(processPlatformJobs(1)).resolves.toMatchObject({ failed: 1, succeeded: 0 });
    expect(m.organizationUpdate).not.toHaveBeenCalled();
    expect(m.lifecycle).not.toHaveBeenCalled();
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

it('expires archived consent proof on worker passes without queued jobs', async () => {
  await processPlatformJobs(1);
  expect(m.raw.mock.calls[0][0].join('')).toContain('DELETE FROM growth_wa_consent_retention WHERE "expiresAt" <= now()');
});

it('archives consent proof without storing message text and aborts on archive failure', async () => {
  queue(job('PURGE_DATA', { attempts: 3 }));
  m.raw.mockImplementation(async (sql) => {
    const text = sql.join('');
    if (text.includes('INSERT INTO')) throw new Error('archive failed');
    return 0;
  });
  await expect(processPlatformJobs(1)).resolves.toMatchObject({ failed: 1 });
  expect(m.execute).not.toHaveBeenCalled();
  expect(m.organizationUpdate).not.toHaveBeenCalled();
});

it.each(['STOP.', 'رک جاؤ', 'بند', 'band kar do', 'رُک جاؤ'])(
  'archives normalized opt-out proof for %s', async (body) => {
    queue(job('PURGE_DATA'));
    const baseQuery = m.query.getMockImplementation()!;
    m.query.mockImplementation(async (sql) => {
      if (sql.text?.includes('AS phone')) return [{
        id: 'in-1', waMessageId: 'wa-1', phone: '+923001234567', timestamp: now, body,
      }];
      return baseQuery(sql);
    });
    await expect(processPlatformJobs(1)).resolves.toMatchObject({ succeeded: 1 });
    const archive = m.raw.mock.calls.find((call) => call[0].join('').includes('VALUES ('));
    expect(archive).toBeDefined();
    expect(JSON.parse(archive![3])).toMatchObject({ keyword: 'STOP', timestamp: now.toISOString() });
    const customerArchive = m.raw.mock.calls.find((call) => call[0].join('').includes("'customer'"));
    expect(customerArchive![0].join('')).toContain("'optOutAt', \"whatsappOptOutAt\"");
  }
);

it.each(['yes', 'haan', 'ہاں', "Yes, I'll pick it up tomorrow", 'haan kal', 'START offers'])(
  'does not archive ordinary conversation as opt-in: %s', async (body) => {
    queue(job('PURGE_DATA'));
    const baseQuery = m.query.getMockImplementation()!;
    m.query.mockImplementation(async (sql) => {
      if (sql.text?.includes('AS phone')) return [{
        id: 'in-1', waMessageId: 'wa-1', phone: '+923001234567', timestamp: now, body,
      }];
      return baseQuery(sql);
    });
    await expect(processPlatformJobs(1)).resolves.toMatchObject({ succeeded: 1 });
    expect(m.raw.mock.calls.some((call) => call[0].join('').includes('VALUES ('))).toBe(false);
  }
);
