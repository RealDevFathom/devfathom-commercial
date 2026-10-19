/**
 * WHA-1370 private receipt-bound stills against the recovered module
 * (src/lib/pharmacy/counter-evidence.ts, manifest sha256 0abfa57f…): branch
 * isolation of reads and requests, no storage-key exposure, missing-still
 * handling, and the legal holds that keep a still past retention (S2).
 *
 * Place next to the source: src/lib/pharmacy/counter-evidence.private.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUpload: vi.fn(async () => Buffer.from([1, 2, 3])),
  purge: vi
    .fn<(db: unknown, options: unknown) => Promise<{ purged: number }>>()
    .mockResolvedValue({ purged: 0 }),
  enterScope: vi
    .fn<(db: unknown, organizationId: string) => Promise<void>>()
    .mockResolvedValue(undefined),
  holds: vi
    .fn<(db: unknown, kind: string, id: string) => Promise<string[]>>()
    .mockResolvedValue([]),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/storage', () => ({ getUpload: mocks.getUpload }));
vi.mock('@/lib/cameras/camera-gateway-runtime', () => ({ cameraGatewayRuntime: {} }));
vi.mock('@/lib/cameras/evidence', () => ({
  captureCameraEvidence: vi.fn(),
  enterCameraTenantScope: mocks.enterScope,
  evidenceSnapshotAdapter: vi.fn(),
  purgeExpiredCameraEvidence: mocks.purge,
}));
vi.mock('./counter', () => {
  class PharmacyCounterError extends Error {
    constructor(public reason: string) {
      super(reason);
    }
  }
  return { PharmacyCounterError };
});
vi.mock('./retention', () => ({ activeLegalHoldKeys: mocks.holds }));

import {
  readCounterEvidence,
  readDailyCloseEvidence,
  requestCounterEvidence,
  runCameraEvidenceRetentionJob,
  stillDataUrl,
} from './counter-evidence';

const scope = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'owner_1' };

function makeDb() {
  return {
    pharmacyTender: { findFirst: vi.fn(async () => null as unknown) },
    pharmacyRefund: { findFirst: vi.fn(async () => null as unknown) },
    pharmacyDailyClose: { findFirst: vi.fn(async () => null as unknown) },
    camera: { findFirst: vi.fn(async () => null as unknown) },
    cameraEvidence: {
      createMany: vi.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: vi.fn(async () => ({ id: 'ev_1' })),
      findMany: vi.fn(async () => [] as unknown[]),
    },
  };
}
let db = makeDb();

beforeEach(() => {
  db = makeDb();
  mocks.getUpload.mockReset().mockResolvedValue(Buffer.from([1, 2, 3]));
  mocks.purge.mockClear();
  mocks.holds.mockReset().mockResolvedValue([]);
});

describe('receipt stills read', () => {
  it('pins tenant and branch after the binding, so a guessed sale id cannot widen it', async () => {
    await readCounterEvidence(db as never, scope, 'sale_guess');
    expect(db.cameraEvidence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          saleId: 'sale_guess',
          subjectKind: { in: ['PHARMACY_TENDER', 'PHARMACY_REFUND'] },
          organizationId: 'org_a',
          branchId: 'branch_a',
        },
      })
    );
    await readDailyCloseEvidence(db as never, scope, 'close_1');
    expect(db.cameraEvidence.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          subjectId: 'close_1',
          subjectKind: 'PHARMACY_DAILY_CLOSE',
          organizationId: 'org_a',
          branchId: 'branch_a',
        },
      })
    );
  });

  it('returns data URLs only for captured stills and never the storage key', async () => {
    const at = new Date('2026-10-11T09:00:00.000Z');
    db.cameraEvidence.findMany.mockResolvedValue([
      {
        id: 'ev_1',
        subjectKind: 'PHARMACY_TENDER',
        status: 'CAPTURED',
        storageKey: 'k/1',
        requestedAt: at,
        capturedAt: at,
      },
      {
        id: 'ev_2',
        subjectKind: 'PHARMACY_REFUND',
        status: 'PURGED',
        storageKey: 'k/2',
        requestedAt: at,
        capturedAt: at,
      },
      {
        id: 'ev_3',
        subjectKind: 'PHARMACY_TENDER',
        status: 'CAPTURED',
        storageKey: null,
        requestedAt: at,
        capturedAt: null,
      },
    ]);
    const rows = await readCounterEvidence(db as never, scope, 'sale_1');
    expect(rows).toEqual([
      {
        id: 'ev_1',
        kind: 'TENDER',
        status: 'CAPTURED',
        requestedAt: at.toISOString(),
        capturedAt: at.toISOString(),
        image: 'data:image/png;base64,AQID',
      },
      {
        id: 'ev_2',
        kind: 'REFUND',
        status: 'PURGED',
        requestedAt: at.toISOString(),
        capturedAt: at.toISOString(),
        image: null,
      },
      {
        id: 'ev_3',
        kind: 'TENDER',
        status: 'CAPTURED',
        requestedAt: at.toISOString(),
        capturedAt: null,
        image: null,
      },
    ]);
    expect(mocks.getUpload).toHaveBeenCalledTimes(1);
    expect(mocks.getUpload).toHaveBeenCalledWith('org_a', 'k/1');
    expect(JSON.stringify(rows)).not.toContain('k/');
  });

  it('a still removed from storage reads as missing; any other storage failure surfaces', async () => {
    mocks.getUpload.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    await expect(stillDataUrl('org_a', 'k/1')).resolves.toBeNull();
    mocks.getUpload.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 404 }));
    await expect(stillDataUrl('org_a', 'k/1')).resolves.toBeNull();
    mocks.getUpload.mockRejectedValueOnce(Object.assign(new Error('denied'), { statusCode: 403 }));
    await expect(stillDataUrl('org_a', 'k/1')).rejects.toThrow('denied');
  });
});

describe('receipt stills request', () => {
  it("refuses another branch's tender before looking for a camera", async () => {
    await expect(
      requestCounterEvidence(db as never, scope, { kind: 'TENDER', subjectId: 'tender_b' })
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    expect(db.pharmacyTender.findFirst).toHaveBeenCalledWith({
      where: { id: 'tender_b', organizationId: 'org_a', branchId: 'branch_a' },
      select: { saleId: true },
    });
    expect(db.camera.findFirst).not.toHaveBeenCalled();
    expect(db.cameraEvidence.createMany).not.toHaveBeenCalled();
  });

  it('uses only an enabled counter camera on an active, unrevoked gateway in this branch', async () => {
    db.pharmacyRefund.findFirst.mockResolvedValue({ saleId: 'sale_1' });
    await expect(
      requestCounterEvidence(db as never, scope, { kind: 'REFUND', subjectId: 'refund_1' })
    ).resolves.toBeNull();
    expect(db.camera.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org_a',
          branchId: 'branch_a',
          enabled: true,
          counterEvidence: true,
          gateway: { status: 'ACTIVE', revokedAt: null },
        },
      })
    );
    expect(db.cameraEvidence.createMany).not.toHaveBeenCalled();
  });

  it('binds the request to this branch, the subject and its sale, idempotently', async () => {
    db.pharmacyTender.findFirst.mockResolvedValue({ saleId: 'sale_1' });
    db.camera.findFirst.mockResolvedValue({ id: 'cam_1' });
    await expect(
      requestCounterEvidence(db as never, scope, { kind: 'TENDER', subjectId: 'tender_1' })
    ).resolves.toEqual({ evidenceId: 'ev_1' });
    expect(db.cameraEvidence.createMany).toHaveBeenCalledWith({
      data: [
        {
          organizationId: 'org_a',
          branchId: 'branch_a',
          subjectKind: 'PHARMACY_TENDER',
          subjectId: 'tender_1',
          saleId: 'sale_1',
          cameraId: 'cam_1',
        },
      ],
      skipDuplicates: true,
    });
  });
});

describe('S2 retention holds', () => {
  type HeldBy = (e: {
    subjectKind: string;
    subjectId: string;
    saleId: string | null;
  }) => Promise<string[]>;
  async function heldBy(): Promise<HeldBy> {
    await runCameraEvidenceRetentionJob(db as never, {
      organizationId: 'org_a',
      type: 'CAMERA_EVIDENCE_RETENTION_V1',
    });
    expect(mocks.enterScope).toHaveBeenCalledWith(db, 'org_a');
    return (mocks.purge.mock.calls.at(-1)![1] as unknown as { heldBy: HeldBy }).heldBy;
  }

  it('refuses to purge without an organisation', async () => {
    await expect(
      runCameraEvidenceRetentionJob(db as never, {
        organizationId: null,
        type: 'CAMERA_EVIDENCE_RETENTION_V1',
      })
    ).rejects.toThrow('requires an organization');
    expect(mocks.purge).not.toHaveBeenCalled();
  });

  it('keeps a counter still under a FISCAL hold on its event or its sale, de-duplicated', async () => {
    mocks.holds.mockImplementation(async (_db: unknown, kind: string, id: string) =>
      kind === 'FISCAL' && id === 'tender_1'
        ? ['hold_b', 'hold_a']
        : kind === 'FISCAL' && id === 'sale_1'
          ? ['hold_a', 'hold_c']
          : []
    );
    const held = await (
      await heldBy()
    )({ subjectKind: 'PHARMACY_TENDER', subjectId: 'tender_1', saleId: 'sale_1' });
    expect(held).toEqual(['hold_a', 'hold_b', 'hold_c']);
  });

  it('keeps a temperature-excursion still only under an AUDIT hold, not a FISCAL one', async () => {
    mocks.holds.mockImplementation(async (_db: unknown, kind: string) =>
      kind === 'AUDIT' ? ['audit_1'] : ['fiscal_1']
    );
    const held = await (
      await heldBy()
    )({ subjectKind: 'PHARMACY_TEMPERATURE_EXCURSION', subjectId: 'reading_1', saleId: null });
    expect(held).toEqual(['audit_1']);
    expect(mocks.holds).toHaveBeenCalledTimes(1);
    expect(mocks.holds).toHaveBeenCalledWith(db, 'AUDIT', 'reading_1');
  });
});
