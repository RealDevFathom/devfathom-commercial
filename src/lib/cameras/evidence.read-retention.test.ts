// @vitest-environment node
// Database, storage, runtime and holds are substitutes; this is no auth/RLS or hardware proof.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUpload: vi.fn(),
  deleteUpload: vi.fn(),
  putUpload: vi.fn(),
  holds: vi.fn(),
}));
vi.mock('@/lib/storage', () => mocks);
vi.mock('@/lib/cameras/camera-gateway-runtime', () => ({ cameraGatewayRuntime: {} }));
vi.mock('@/lib/pharmacy/counter', () => ({ PharmacyCounterError: class extends Error {} }));
vi.mock('@/lib/pharmacy/retention', () => ({ activeLegalHoldKeys: mocks.holds }));

import {
  readCounterEvidence,
  readDailyCloseEvidence,
  stillDataUrl,
} from '@/lib/pharmacy/counter-evidence';
import { readExcursionEvidence } from './excursion-evidence';

const NOW = new Date('2026-10-12T12:00:00.000Z');
const DAY = 86_400_000;
const scope = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'owner_1' };
const PNG = 'data:image/png;base64,AQID';
function evidence(over: Record<string, unknown> = {}) {
  return {
    id: 'ev_1',
    subjectKind: 'PHARMACY_TENDER',
    status: 'CAPTURED',
    storageKey: 'camera-snapshot-fixture.png',
    subjectId: 'tender_1',
    saleId: 'sale_1',
    requestedAt: NOW,
    capturedAt: new Date(NOW.getTime() - DAY),
    camera: { gateway: { retentionDays: 7 } },
    temperatureZoneId: 'zone_1',
    readingTemperatureC: 12,
    readingRecordedAt: NOW,
    failureReason: null,
    ...over,
  };
}
let rows: ReturnType<typeof evidence>[];
const db = { cameraEvidence: { findMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() } };
const readStill = vi.fn((key: string) => stillDataUrl(scope.organizationId, key));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mocks.getUpload.mockReset().mockResolvedValue(Buffer.from([1, 2, 3]));
  mocks.holds.mockResolvedValue(['hold_1']);
  rows = [evidence()];
  db.cameraEvidence.findMany.mockImplementation(async () => rows);
});
afterEach(() => vi.useRealTimers());

for (const kind of ['receipt', 'daily close', 'excursion'] as const) {
  describe(`${kind} read retention`, () => {
    const read = () =>
      kind === 'receipt'
        ? readCounterEvidence(db as never, scope, 'sale_1')
        : kind === 'daily close'
          ? readDailyCloseEvidence(db as never, scope, 'close_1')
          : readExcursionEvidence(db as never, scope, readStill);

    it('red: expired still is withheld with held file and row state kept', async () => {
      rows = [evidence({ capturedAt: new Date(NOW.getTime() - 7 * DAY), holdKeys: ['hold_1'] })];
      const before = structuredClone(rows);
      expect((await read())[0]).toMatchObject({ id: 'ev_1', status: 'CAPTURED', image: null });
      expect(rows).toEqual(before);
      expect(mocks.getUpload).not.toHaveBeenCalled();
      expect(readStill).not.toHaveBeenCalled();
      expect(mocks.deleteUpload).not.toHaveBeenCalled();
      expect(mocks.holds).not.toHaveBeenCalled();
      expect(db.cameraEvidence.updateMany).not.toHaveBeenCalled();
      expect(db.cameraEvidence.deleteMany).not.toHaveBeenCalled();
    });

    it('red: fresh still keeps its private data URL', async () => {
      const result = await read();
      expect(result[0]).toMatchObject({ id: 'ev_1', status: 'CAPTURED', image: PNG });
      expect(result[0]).not.toHaveProperty('storageKey');
      expect(result[0]).not.toHaveProperty('camera');
      expect(mocks.getUpload).toHaveBeenCalledExactlyOnceWith(
        'org_a',
        'camera-snapshot-fixture.png'
      );
    });

    it.each([-1, 0, 1])('inclusive expiry offset %sms', async (offset) => {
      rows = [evidence({ capturedAt: new Date(NOW.getTime() - 7 * DAY + offset) })];
      expect((await read())[0]?.image).toBe(offset > 0 ? PNG : null);
      expect(mocks.getUpload).toHaveBeenCalledTimes(offset > 0 ? 1 : 0);
    });

    it('uses each gateway current policy including the DB-valid 3650-day period', async () => {
      const at = new Date(NOW.getTime() - 100 * DAY);
      rows = [
        evidence({ capturedAt: at, camera: { gateway: { retentionDays: 90 } } }),
        evidence({ id: 'ev_2', capturedAt: at, camera: { gateway: { retentionDays: 3650 } } }),
      ];
      expect((await read()).map((r) => r.image)).toEqual([null, PNG]);
      rows[0]!.camera.gateway.retentionDays = 3650;
      rows[1]!.camera.gateway.retentionDays = 1;
      expect((await read()).map((r) => r.image)).toEqual([PNG, null]);
    });

    it.each([
      { capturedAt: null },
      { capturedAt: undefined },
      { capturedAt: new Date(NOW.getTime() + 1) },
      { storageKey: null },
      { storageKey: '' },
      { status: 'PENDING' },
      { status: 'FAILED' },
      { status: 'PURGED' },
      { camera: undefined },
      { camera: { gateway: undefined } },
      { camera: { gateway: {} } },
      ...[0, -1, 3651, 1.5, NaN, Infinity, null, '7'].map((retentionDays) => ({
        camera: { gateway: { retentionDays } },
      })),
    ])('fails closed before storage for invalid metadata %o', async (over) => {
      rows = [evidence(over)];
      expect((await read())[0]?.image).toBeNull();
      expect(mocks.getUpload).not.toHaveBeenCalled();
      expect(readStill).not.toHaveBeenCalled();
    });

    it('an invalid captured date cannot reach storage', async () => {
      rows = [evidence({ capturedAt: new Date(NaN) })];
      await expect(read()).rejects.toThrow(RangeError);
      expect(mocks.getUpload).not.toHaveBeenCalled();
      expect(readStill).not.toHaveBeenCalled();
    });

    it('uses one server clock snapshot across the entire response', async () => {
      rows = [evidence(), evidence({ id: 'ev_2' })];
      mocks.getUpload.mockImplementationOnce(async () => {
        vi.setSystemTime(new Date(NOW.getTime() + 30 * DAY));
        return Buffer.from([1, 2, 3]);
      });
      expect((await read()).map((r) => r.image)).toEqual([PNG, PNG]);
    });

    it('retains tenant, branch, subject, order and take while fetching gateway policy', async () => {
      await read();
      const query = db.cameraEvidence.findMany.mock.calls[0]![0];
      expect(query.where).toMatchObject({ organizationId: 'org_a', branchId: 'branch_a' });
      const camera = { select: { gateway: { select: { retentionDays: true } } } };
      if (kind === 'excursion') {
        expect(query).toMatchObject({
          where: { subjectKind: 'PHARMACY_TEMPERATURE_EXCURSION' },
          orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
          take: 20,
          include: { camera },
        });
        await readExcursionEvidence(db as never, scope, readStill, 3);
        expect(db.cameraEvidence.findMany.mock.calls[1]![0].take).toBe(3);
      } else {
        expect(query).toMatchObject({
          orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
          select: { camera },
        });
        expect(query.where).toEqual(
          kind === 'receipt'
            ? {
                organizationId: 'org_a',
                branchId: 'branch_a',
                saleId: 'sale_1',
                subjectKind: { in: ['PHARMACY_TENDER', 'PHARMACY_REFUND'] },
              }
            : {
                organizationId: 'org_a',
                branchId: 'branch_a',
                subjectId: 'close_1',
                subjectKind: 'PHARMACY_DAILY_CLOSE',
              }
        );
      }
    });

    it('preserves missing-file compatibility and propagates other storage errors', async () => {
      for (const error of [{ code: 'ENOENT' }, { statusCode: 404 }]) {
        mocks.getUpload.mockRejectedValueOnce(error);
        expect((await read())[0]?.image).toBeNull();
      }
      const denied = Object.assign(new Error('storage denied'), { statusCode: 403 });
      mocks.getUpload.mockRejectedValueOnce(denied);
      await expect(read()).rejects.toBe(denied);
    });
  });
}
