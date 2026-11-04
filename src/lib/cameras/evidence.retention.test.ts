/**
 * WHA-1370 S2 (retention) and production lockout against the real evidence job
 * (src/lib/cameras/evidence.ts, sha256 0cef4021…). Storage and the snapshot
 * store are mocked; the database is a recorder that returns scripted rows.
 *
 * What this cannot prove: the SQL predicate's behaviour on PostgreSQL (row
 * selection by retentionDays, RLS). Those need a real database.
 *
 * Place next to the source: src/lib/cameras/evidence.retention.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteUpload: vi.fn<(org: string, key: string) => Promise<void>>().mockResolvedValue(undefined),
  store: vi
    .fn<
      (
        adapter: unknown,
        input: { organizationId: string; cameraId: string }
      ) => Promise<{ filename: string; byteLength: number }>
    >()
    .mockResolvedValue({
      filename: 'cam/ev_1.jpg',
      byteLength: 1234,
    }),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/storage', () => ({ deleteUpload: mocks.deleteUpload }));
vi.mock('./snapshots', () => ({ storeCameraSnapshot: mocks.store }));

import {
  CAMERA_EVIDENCE_CAPTURE_WINDOW_MS,
  cameraEvidenceDueSql,
  canReadCameraEvidence,
  captureCameraEvidence,
  enterCameraTenantScope,
  evidenceSnapshotAdapter,
  purgeExpiredCameraEvidence,
  type ExpiredCameraEvidence,
} from './evidence';

const now = new Date('2026-10-11T12:00:00.000Z');
const adapter = { getSnapshot: vi.fn() };

type Sql = { strings: readonly string[]; values: unknown[] };
const sqlText = (sql: unknown) => (sql as Sql).strings.join('?');

function makeDb() {
  return {
    $queryRaw: vi.fn<(sql: unknown) => Promise<ExpiredCameraEvidence[]>>().mockResolvedValue([]),
    $queryRawUnsafe: vi.fn<(...args: unknown[]) => Promise<unknown[]>>().mockResolvedValue([]),
    cameraEvidence: {
      findFirst: vi.fn<(args: unknown) => Promise<unknown>>(async () => pending()),
      updateMany: vi
        .fn<(args: unknown) => Promise<{ count: number }>>()
        .mockResolvedValue({ count: 1 }),
    },
  };
}
let db = makeDb();

function pending() {
  return {
    id: 'ev_1',
    organizationId: 'org_a',
    branchId: 'branch_a',
    status: 'PENDING',
    requestedAt: new Date(now.getTime() - 60_000),
    camera: {
      enabled: true,
      branchId: 'branch_a',
      sourceRef: 'sim-counter-1',
      gateway: { status: 'ACTIVE', revokedAt: null as Date | null },
    },
  };
}

function due(id: string, minute: number): ExpiredCameraEvidence {
  return {
    id,
    storageKey: `cam/${id}.jpg`,
    subjectKind: 'PHARMACY_SALE',
    subjectId: `sale_${id}`,
    saleId: `sale_${id}`,
    capturedAt: new Date(Date.UTC(2026, 6, 1, 0, minute)),
  };
}

const capture = (finalAttempt = true, a: typeof adapter | null = adapter) =>
  captureCameraEvidence(db as never, {
    organizationId: 'org_a',
    evidenceId: 'ev_1',
    adapter: a as never,
    now,
    finalAttempt,
  });

beforeEach(() => {
  db = makeDb();
  mocks.deleteUpload.mockClear().mockResolvedValue(undefined);
  mocks.store.mockClear().mockResolvedValue({ filename: 'cam/ev_1.jpg', byteLength: 1234 });
});

describe('production lockout', () => {
  it('only an available simulated gateway yields a snapshot adapter', () => {
    const runtime = (available: boolean, mode: string) =>
      evidenceSnapshotAdapter({ available, mode, adapter } as never);
    expect(runtime(true, 'simulated')).toBe(adapter);
    expect(runtime(false, 'simulated')).toBeNull();
    expect(runtime(true, 'mediamtx')).toBeNull();
    expect(runtime(true, 'production')).toBeNull();
  });

  it('with no adapter the capture fails closed as SNAPSHOT_UNSUPPORTED', async () => {
    await expect(capture(true, null)).resolves.toEqual({
      evidenceId: 'ev_1',
      outcome: 'FAILED',
      reason: 'SNAPSHOT_UNSUPPORTED',
    });
    expect(mocks.store).not.toHaveBeenCalled();
    expect(db.cameraEvidence.updateMany).toHaveBeenCalledWith({
      where: { id: 'ev_1', organizationId: 'org_a', status: 'PENDING' },
      data: { status: 'FAILED', failureReason: 'SNAPSHOT_UNSUPPORTED' },
    });
  });

  it('the job drops platform privileges and binds the tenant for its transaction', async () => {
    await enterCameraTenantScope(db as never, 'org_a');
    const [sql, org] = db.$queryRawUnsafe.mock.calls[0]!;
    expect(org).toBe('org_a');
    expect(sql).toContain("set_config('app.current_organization_id', $1, true)");
    expect(sql).toContain("set_config('app.current_user_id', '', true)");
    expect(sql).toContain("set_config('app.is_platform_admin', 'false', true)");
  });
});

describe('capture guards', () => {
  it('reads the evidence row by id and tenant', async () => {
    await capture();
    expect(db.cameraEvidence.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ev_1', organizationId: 'org_a' } })
    );
  });

  it('a settled row is reported and never written', async () => {
    db.cameraEvidence.findFirst.mockResolvedValueOnce({ ...pending(), status: 'CAPTURED' });
    await expect(capture()).resolves.toEqual({
      evidenceId: 'ev_1',
      outcome: 'ALREADY_SETTLED',
      status: 'CAPTURED',
    });
    expect(db.cameraEvidence.updateMany).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });

  type Row = ReturnType<typeof pending>;
  it.each<[string, (row: Row) => void]>([
    [
      'the camera is disabled',
      (r) => {
        r.camera.enabled = false;
      },
    ],
    [
      'the camera moved to another branch',
      (r) => {
        r.camera.branchId = 'branch_b';
      },
    ],
    [
      'the gateway is not ACTIVE',
      (r) => {
        r.camera.gateway.status = 'SUSPENDED';
      },
    ],
    [
      'the gateway was revoked',
      (r) => {
        r.camera.gateway.revokedAt = new Date(now.getTime() - 1);
      },
    ],
  ])('fails CAMERA_UNAVAILABLE when %s, without taking a still', async (_label, mutate) => {
    const row = pending();
    mutate(row);
    db.cameraEvidence.findFirst.mockResolvedValueOnce(row);
    await expect(capture()).resolves.toMatchObject({
      outcome: 'FAILED',
      reason: 'CAMERA_UNAVAILABLE',
    });
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it('refuses a still requested more than the capture window ago', async () => {
    db.cameraEvidence.findFirst.mockResolvedValueOnce({
      ...pending(),
      requestedAt: new Date(now.getTime() - CAMERA_EVIDENCE_CAPTURE_WINDOW_MS - 1),
    });
    await expect(capture()).resolves.toMatchObject({ reason: 'CAPTURE_WINDOW_ELAPSED' });
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it('still captures exactly at the window boundary', async () => {
    db.cameraEvidence.findFirst.mockResolvedValueOnce({
      ...pending(),
      requestedAt: new Date(now.getTime() - CAMERA_EVIDENCE_CAPTURE_WINDOW_MS),
    });
    await expect(capture()).resolves.toMatchObject({ outcome: 'CAPTURED' });
  });
});

describe('capture outcomes', () => {
  it('stores under the evidence tenant using the camera source ref, then settles', async () => {
    await expect(capture()).resolves.toEqual({
      evidenceId: 'ev_1',
      outcome: 'CAPTURED',
      byteLength: 1234,
    });
    expect(mocks.store).toHaveBeenCalledWith(adapter, {
      organizationId: 'org_a',
      cameraId: 'sim-counter-1',
      // DEV-745: the authorized scope travels with every capture.
      target: expect.objectContaining({ organizationId: 'org_a', branchId: 'branch_a' }),
    });
    expect(db.cameraEvidence.updateMany).toHaveBeenCalledWith({
      where: { id: 'ev_1', organizationId: 'org_a', status: 'PENDING' },
      data: { status: 'CAPTURED', storageKey: 'cam/ev_1.jpg', byteLength: 1234, capturedAt: now },
    });
    expect(mocks.deleteUpload).not.toHaveBeenCalled();
  });

  it('a concurrent settle deletes the orphan still and binds nothing', async () => {
    db.cameraEvidence.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(capture()).resolves.toEqual({
      evidenceId: 'ev_1',
      outcome: 'ALREADY_SETTLED',
      status: 'SETTLED_CONCURRENTLY',
    });
    expect(mocks.deleteUpload).toHaveBeenCalledWith('org_a', 'cam/ev_1.jpg');
  });

  it('a database error on settle cleans up the still and rethrows the database error', async () => {
    const dbError = new Error('db down');
    db.cameraEvidence.updateMany.mockRejectedValueOnce(dbError);
    mocks.deleteUpload.mockRejectedValueOnce(new Error('storage down'));
    await expect(capture()).rejects.toBe(dbError);
    expect(mocks.deleteUpload).toHaveBeenCalledWith('org_a', 'cam/ev_1.jpg');
  });

  it('an adapter error is rethrown while attempts remain', async () => {
    const gatewayError = new Error('gateway said: rtsp://user:secret@cam');
    mocks.store.mockRejectedValueOnce(gatewayError);
    await expect(capture(false)).rejects.toBe(gatewayError);
    expect(db.cameraEvidence.updateMany).not.toHaveBeenCalled();
  });

  it('on the final attempt an adapter error is recorded only as a stable code', async () => {
    mocks.store.mockRejectedValueOnce(new Error('gateway said: rtsp://user:secret@cam'));
    await expect(capture(true)).resolves.toMatchObject({ reason: 'SNAPSHOT_UNAVAILABLE' });
    expect(db.cameraEvidence.updateMany).toHaveBeenCalledWith({
      where: { id: 'ev_1', organizationId: 'org_a', status: 'PENDING' },
      data: { status: 'FAILED', failureReason: 'SNAPSHOT_UNAVAILABLE' },
    });
  });
});

describe('S2 retention purge', () => {
  const purge = (heldBy: (e: ExpiredCameraEvidence) => Promise<string[]>, maxPurges?: number) =>
    purgeExpiredCameraEvidence(db as never, { organizationId: 'org_a', now, heldBy, maxPurges });

  it('the due predicate is captured stills older than their own gateway retention', () => {
    const sql = cameraEvidenceDueSql(now) as unknown as Sql;
    expect(sqlText(sql)).toContain(`e."status" = 'CAPTURED'`);
    expect(sqlText(sql)).toContain('make_interval(days => g."retentionDays")');
    expect(sql.values).toEqual([now]);
  });

  it('closes abandoned pending captures by tenant and window', async () => {
    db.cameraEvidence.updateMany.mockResolvedValueOnce({ count: 3 });
    await expect(purge(async () => [])).resolves.toMatchObject({ abandonedPending: 3 });
    expect(db.cameraEvidence.updateMany.mock.calls[0]![0]).toEqual({
      where: {
        organizationId: 'org_a',
        status: 'PENDING',
        requestedAt: { lt: new Date(now.getTime() - CAMERA_EVIDENCE_CAPTURE_WINDOW_MS) },
      },
      data: { status: 'FAILED', failureReason: 'CAPTURE_WINDOW_ELAPSED' },
    });
  });

  it('scans one tenant and joins cameras and gateways within that tenant', async () => {
    await purge(async () => []);
    const scan = db.$queryRaw.mock.calls[0]![0];
    const text = sqlText(scan);
    expect(text).toContain('c."organizationId" = e."organizationId"');
    expect(text).toContain('g."organizationId" = c."organizationId"');
    expect(text).toContain('WHERE e."organizationId" = ');
    expect((scan as Sql).values).toContain('org_a');
  });

  it('skips held stills, clears the image row first, then deletes the file', async () => {
    db.$queryRaw.mockResolvedValueOnce([due('ev_held', 1), due('ev_free', 2)]);
    const heldBy = vi.fn(async (e: ExpiredCameraEvidence) =>
      e.id === 'ev_held' ? ['hold:case-7'] : []
    );
    await expect(purge(heldBy)).resolves.toEqual({
      purgedIds: ['ev_free'],
      held: [{ id: 'ev_held', holdKeys: ['hold:case-7'] }],
      abandonedPending: 1,
    });
    const clear = db.cameraEvidence.updateMany.mock.calls[1]!;
    expect(clear[0]).toEqual({
      where: { id: 'ev_free', organizationId: 'org_a', status: 'CAPTURED' },
      data: { status: 'PURGED', storageKey: null, purgedAt: now },
    });
    expect(mocks.deleteUpload).toHaveBeenCalledTimes(1);
    expect(mocks.deleteUpload).toHaveBeenCalledWith('org_a', 'cam/ev_free.jpg');
    expect(db.cameraEvidence.updateMany.mock.invocationCallOrder[1]!).toBeLessThan(
      mocks.deleteUpload.mock.invocationCallOrder[0]!
    );
  });

  it('a still already cleared by another pass is not deleted or counted', async () => {
    db.$queryRaw.mockResolvedValueOnce([due('ev_1', 1)]);
    db.cameraEvidence.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    await expect(purge(async () => [])).resolves.toMatchObject({ purgedIds: [] });
    expect(mocks.deleteUpload).not.toHaveBeenCalled();
  });

  it('stops at maxPurges without consulting holds for the rest', async () => {
    db.$queryRaw.mockResolvedValueOnce([due('ev_1', 1), due('ev_2', 2), due('ev_3', 3)]);
    const heldBy = vi.fn(async () => [] as string[]);
    await expect(purge(heldBy, 2)).resolves.toMatchObject({ purgedIds: ['ev_1', 'ev_2'] });
    expect(heldBy).toHaveBeenCalledTimes(2);
    expect(mocks.deleteUpload).toHaveBeenCalledTimes(2);
  });

  it('a full batch of held stills cannot starve the next due still', async () => {
    const heldBatch = Array.from({ length: 200 }, (_, i) =>
      due(`ev_h${String(i).padStart(3, '0')}`, i)
    );
    const last = heldBatch[199]!;
    db.$queryRaw.mockResolvedValueOnce(heldBatch).mockResolvedValueOnce([due('ev_free', 300)]);
    const heldBy = vi.fn(async (e: ExpiredCameraEvidence) => (e.id === 'ev_free' ? [] : ['hold']));
    const result = await purge(heldBy);
    expect(result.purgedIds).toEqual(['ev_free']);
    expect(result.held).toHaveLength(200);
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    // The second scan resumes after the last held row's (capturedAt, id).
    const values = (db.$queryRaw.mock.calls[1]![0] as Sql).values;
    expect(values).toContain(last.id);
    expect(values).toContainEqual(last.capturedAt);
  });
});

describe('pure read eligibility', () => {
  const row = { status: 'CAPTURED', storageKey: 'private/key', capturedAt: now };
  it.each([1, 7, 90, 91, 3650])('accepts every DB-valid period including %s days', (days) => {
    for (const offset of [-1, 0, 1]) {
      const capturedAt = new Date(now.getTime() - days * 86_400_000 + offset);
      expect(canReadCameraEvidence({ ...row, capturedAt }, days, now)).toBe(offset > 0);
    }
  });
  it.each([0, -1, 3651, 1.5, NaN, Infinity, null, undefined, '7'])(
    'refuses invalid policy %s',
    (days) => {
      expect(canReadCameraEvidence(row, days as never, now)).toBe(false);
    }
  );
  it.each([null, undefined, new Date(NaN), new Date(now.getTime() + 1), now.toISOString()])(
    'refuses invalid capture clock %s',
    (capturedAt) => {
      expect(canReadCameraEvidence({ ...row, capturedAt } as never, 7, now)).toBe(false);
    }
  );
  it.each([new Date(NaN), null, undefined])('refuses invalid server clock %s', (clock) => {
    expect(canReadCameraEvidence(row, 7, clock as never)).toBe(false);
  });
  it.each([null, undefined, '', 1])('refuses a missing or invalid storage key %s', (storageKey) => {
    expect(canReadCameraEvidence({ ...row, storageKey } as never, 7, now)).toBe(false);
  });
  it.each(['PENDING', 'FAILED', 'PURGED', '', undefined])(
    'refuses unsettled or unknown status %s',
    (status) => {
      expect(canReadCameraEvidence({ ...row, status } as never, 7, now)).toBe(false);
    }
  );
});
