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
  platformAudit: vi.fn(),
  exportJobs: vi.fn(),
  ownerExport: null as null | ((...args: unknown[]) => Promise<unknown>),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: m.scope }));
vi.mock('@/lib/pharmacy/counter-evidence', () => ({
  PHARMACY_CAMERA_SNAPSHOT_JOB: 'pharmacy.camera.snapshot.v1',
  runCounterEvidenceSnapshotJob: m.snapshot,
  runCameraEvidenceRetentionJob: m.retention,
}));
vi.mock('@/lib/pharmacy/owner-data-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pharmacy/owner-data-export')>();
  return {
    ...actual,
    runPharmacyOwnerDataExportJob: (
      ...args: Parameters<typeof actual.runPharmacyOwnerDataExportJob>
    ) => (m.ownerExport ? m.ownerExport(...args) : actual.runPharmacyOwnerDataExportJob(...args)),
  };
});
import { OwnerDataExportTimeLimitError } from '@/lib/pharmacy/owner-data-export';
import { processPlatformJobs } from './jobs';

const db = {
  $executeRaw: vi.fn().mockResolvedValue(0),
  $queryRaw: m.query,
  $executeRawUnsafe: m.execute,
  platformJob: {
    createMany: m.createMany,
    updateMany: m.updateMany,
    update: m.update,
    findUnique: m.findJob,
    findMany: m.exportJobs,
  },
  organization: { findUnique: m.organization, update: m.organizationUpdate },
  organizationLifecycleEvent: { create: m.lifecycle },
  platformAuditLog: { create: m.platformAudit },
  organizationDeployment: { updateMany: m.deployment },
  organizationIdentityConnection: { findFirst: vi.fn(), update: vi.fn() },
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
    requestedById: 'platform-admin-1',
    ...extra,
  };
}
const AUDIT_SUMMARY = {
  rows: 2,
  earliest: new Date('2026-01-02T03:04:05.000Z'),
  latest: new Date('2026-09-10T11:12:13.000Z'),
  digest: 'abc123',
};
const NO_AUDIT = { rows: 0, earliest: null, latest: null, digest: null };
function queue(
  item: ReturnType<typeof job>,
  dependencies: unknown[] = [],
  auditSummary: unknown = NO_AUDIT
) {
  let claimed = false;
  m.query.mockImplementation(async (sql: { text?: string; strings?: string[] }) => {
    const text = sql.text ?? sql.strings?.join('') ?? '';
    if (text.includes('FOR UPDATE SKIP LOCKED')) {
      if (claimed) return [];
      claimed = true;
      return [{ id: item.id }];
    }
    if (text.includes('WITH tenant_tables')) return dependencies;
    if (text.includes('FROM "audit_logs"')) return [auditSummary];
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
  m.exportJobs.mockResolvedValue([]);
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
  m.platformAudit.mockResolvedValue({ id: 'purge-record-1' });
});
afterEach(() => {
  m.ownerExport = null;
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('composed platform worker boundaries', () => {
  it('expires consent evidence on an idle worker run without an archive key', async () => {
    vi.stubEnv('PLATFORM_ENCRYPTION_KEY', '');
    await expect(processPlatformJobs()).resolves.toMatchObject({ claimed: 0 });
    expect(m.archiveDelete).toHaveBeenCalledExactlyOnceWith({
      where: { expiresAt: { lte: now } },
    });
    expect(m.archiveCreate).not.toHaveBeenCalled();
  });

  it('ends SSO cleanup on a partial batch and caps work per pass', async () => {
    db.$executeRaw.mockResolvedValueOnce(500).mockResolvedValueOnce(2);
    await processPlatformJobs();
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
    expect(db.$executeRaw.mock.calls[0]?.[0].join('')).toContain(
      'DELETE FROM "organization_sso_states"'
    );
    db.$executeRaw.mockClear().mockResolvedValue(500);
    await processPlatformJobs();
    expect(db.$executeRaw).toHaveBeenCalledTimes(16);
  });

  it('revalidates a stored discovery destination in the identity worker', async () => {
    db.organizationIdentityConnection.findFirst.mockResolvedValue({
      id: 'fixture',
      protocol: 'OIDC',
      clientId: 'client',
      issuer: 'https://idp.example',
      discoveryUrl: 'https://192.0.2.1/doc',
    });
    queue(job('SYNC_IDENTITY', { payload: { connectionId: 'fixture' } }));
    await expect(processPlatformJobs(1)).resolves.toMatchObject({ succeeded: 0, retried: 1 });
    expect(db.organizationIdentityConnection.update).toHaveBeenCalledWith({
      where: { id: 'fixture' },
      data: expect.objectContaining({ status: 'ERROR' }),
    });
  });

  const purgeScans = () =>
    m.query.mock.calls.filter(([sql]) =>
      String(sql?.text ?? '').includes('pharmacy_retention_days(')
    );

  it('enqueues exactly one platform-wide pharmacy record retention purge per UTC hour', async () => {
    await processPlatformJobs();
    await processPlatformJobs();
    const keys = m.createMany.mock.calls.flatMap(([{ data }]) =>
      data
        .filter((row: { type: string }) => row.type === 'PHARMACY_RECORD_RETENTION_V1')
        .map((row: { idempotencyKey: string; organizationId: unknown }) => [
          row.idempotencyKey,
          row.organizationId,
        ])
    );
    expect(keys).toEqual([
      ['pharmacy.record.retention.v1:2026-10-12T01', null],
      ['pharmacy.record.retention.v1:2026-10-12T01', null],
    ]);
    expect(m.createMany.mock.calls.every(([args]) => args.skipDuplicates === true)).toBe(true);
    // Enqueueing never runs the purge inline.
    expect(purgeScans()).toHaveLength(0);
  });

  it('runs the retention purge as its own job with the long timeout', async () => {
    queue(job('PHARMACY_RECORD_RETENTION_V1', { organizationId: null }));
    await expect(processPlatformJobs(1)).resolves.toMatchObject({ claimed: 1, succeeded: 1 });
    // One scan per purgeable class: register, prescription, fiscal. Never audit_logs.
    expect(purgeScans()).toHaveLength(3);
    expect(purgeScans().some(([sql]) => String(sql?.text ?? '').includes('"audit_logs" r'))).toBe(
      false
    );
    expect(m.scope).toHaveBeenCalledWith(expect.any(Function), { timeout: 120_000 });
  });

  it('resumes the retention purge where the last successful run stopped (QA-3)', async () => {
    queue(job('PHARMACY_RECORD_RETENTION_V1', { organizationId: null }));
    const query = m.query.getMockImplementation()!;
    m.query.mockImplementation(async (sql: { text?: string; strings?: string[] }) => {
      const text = sql.text ?? sql.strings?.join('') ?? '';
      if (text.includes(`"type" = 'pharmacy.record.retention.v1'`)) {
        return [
          {
            result: {
              resumeAfter: { FISCAL: { anchor: '2014-05-06T07:08:09.000Z', id: 'sale-1000' } },
            },
          },
        ];
      }
      return query(sql);
    });
    await expect(processPlatformJobs(1)).resolves.toMatchObject({ claimed: 1, succeeded: 1 });
    const fiscal = purgeScans().find(([sql]) =>
      String(sql?.text ?? '').includes('"pharmacy_sales" r')
    );
    expect(String(fiscal?.[0]?.text ?? '')).toContain('r."id") > (');
    expect(fiscal?.[0]?.values).toEqual(
      expect.arrayContaining([new Date('2014-05-06T07:08:09.000Z'), 'sale-1000'])
    );
    // Classes with no stored resume point start from the oldest record.
    const register = purgeScans().find(([sql]) =>
      String(sql?.text ?? '').includes('"pharmacy_controlled_register_entries" r')
    );
    expect(String(register?.[0]?.text ?? '')).not.toContain('r."id") > (');
  });

  it('retries a failed retention purge without affecting other work', async () => {
    queue(job('PHARMACY_RECORD_RETENTION_V1', { organizationId: null }));
    const query = m.query.getMockImplementation()!;
    m.query.mockImplementation(async (sql: { text?: string }) => {
      if (String(sql?.text ?? '').includes('pharmacy_retention_days(')) {
        throw new Error('retention purge timed out');
      }
      return query(sql);
    });
    await expect(processPlatformJobs(1)).resolves.toMatchObject({
      recovered: 2,
      claimed: 1,
      retried: 1,
      failed: 0,
    });
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
      {
        organizationId: null,
        type: 'PHARMACY_RECORD_RETENTION_V1',
        idempotencyKey: 'pharmacy.record.retention.v1:2026-10-12T01',
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
  it('builds the owner data export in one repeatable-read snapshot', async () => {
    queue(job('PHARMACY_OWNER_DATA_EXPORT_V1', { payload: { from: null, to: null } }));
    await processPlatformJobs(1);
    expect(m.scope).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 120_000,
      isolationLevel: 'RepeatableRead',
    });
  });

  it('fails an owner data export past its build time limit permanently, without a retry', async () => {
    queue(job('PHARMACY_OWNER_DATA_EXPORT_V1', { payload: { from: null, to: null } }));
    m.ownerExport = async () => {
      throw new OwnerDataExportTimeLimitError(90_000);
    };
    await expect(processPlatformJobs(1)).resolves.toMatchObject({ retried: 0, failed: 1 });
    expect(m.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          error: expect.stringContaining('shorter sales date range'),
        }),
      })
    );
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
  it('writes the permanent platform record of the audit purge before deleting any tenant row', async () => {
    queue(
      job('PURGE_DATA', { payload: { reason: 'Contract ended; retention elapsed.' } }),
      [{ tableName: 'audit_logs', parentTable: null, nullableColumns: [] }],
      AUDIT_SUMMARY
    );
    m.execute.mockResolvedValue(2);
    await expect(processPlatformJobs(1)).resolves.toMatchObject({ succeeded: 1, failed: 0 });
    expect(m.platformAudit).toHaveBeenCalledWith({
      data: {
        organizationId: 'tenant-a',
        actorPlatformUserId: 'platform-admin-1',
        action: 'organization.audit_logs.purge',
        targetType: 'AuditLog',
        requestId: 'job-1',
        reason: 'Contract ended; retention elapsed.',
        metadata: {
          jobId: 'job-1',
          table: 'audit_logs',
          rows: 2,
          earliestCreatedAt: '2026-01-02T03:04:05.000Z',
          latestCreatedAt: '2026-09-10T11:12:13.000Z',
          idDigest: 'sha256:abc123',
        },
      },
      select: { id: true },
    });
    // `$queryRaw` is called both as a tag (strings, ...values) and with Prisma.sql.
    const sql = m.query.mock.calls.map(([q, ...rest]) => {
      if (Array.isArray(q)) return { text: q.join('?'), values: rest };
      const query = q as { strings?: string[]; values?: unknown[] };
      return { text: query.strings?.join('?') ?? '', values: query.values ?? [] };
    });
    const nameRecord = sql.findIndex(
      ({ text, values }) =>
        text.includes("set_config('app.audit_purge_record_id'") && values[0] === 'purge-record-1'
    );
    expect(nameRecord).toBeGreaterThan(-1);
    const recordCall = m.platformAudit.mock.invocationCallOrder[0];
    const nameCall = m.query.mock.invocationCallOrder[nameRecord];
    const deleteCall = m.execute.mock.invocationCallOrder[0];
    expect(recordCall).toBeLessThan(nameCall);
    expect(nameCall).toBeLessThan(deleteCall);
    expect(m.execute.mock.calls).toEqual([
      ['DELETE FROM "audit_logs" WHERE "organizationId" = $1', 'tenant-a'],
    ]);
  });
  it('falls back to the retention reason when the purge request carried none', async () => {
    queue(job('PURGE_DATA', { payload: {} }), []);
    await expect(processPlatformJobs(1)).resolves.toMatchObject({ succeeded: 1 });
    expect(m.platformAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reason: 'Retention window elapsed and the organization is being purged.',
        }),
      })
    );
  });
  it('fails a purge with no platform actor at once, before recording or deleting anything', async () => {
    // First attempt of three: no retry can supply the missing actor.
    queue(job('PURGE_DATA', { attempts: 1, requestedById: null }), [
      { tableName: 'audit_logs', parentTable: null, nullableColumns: [] },
    ]);
    await expect(processPlatformJobs(1)).resolves.toMatchObject({
      failed: 1,
      retried: 0,
      succeeded: 0,
    });
    expect(m.platformAudit).not.toHaveBeenCalled();
    expect(m.execute).not.toHaveBeenCalled();
    expect(m.organizationUpdate).not.toHaveBeenCalled();
    expect(m.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          error: expect.stringContaining(
            'A purge requires the platform actor who requested it: this job names no requesting platform administrator.'
          ),
        }),
      })
    );
  });
  it('rolls the purge back when audit rows arrive between the record and the delete', async () => {
    queue(
      job('PURGE_DATA', { attempts: 1 }),
      [{ tableName: 'audit_logs', parentTable: null, nullableColumns: [] }],
      AUDIT_SUMMARY
    );
    // The record summarised two rows; a third was written before the DELETE.
    m.execute.mockResolvedValue(3);
    await expect(processPlatformJobs(1)).resolves.toMatchObject({ retried: 1, succeeded: 0 });
    expect(m.organizationUpdate).not.toHaveBeenCalled();
    expect(m.lifecycle).not.toHaveBeenCalled();
    expect(m.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'QUEUED',
          error: 'Audit rows changed during the purge: recorded 2, deleted 3.',
        }),
      })
    );
  });
});
