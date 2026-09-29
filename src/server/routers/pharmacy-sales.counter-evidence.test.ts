import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/settlement', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/settlement')>()),
  applyPharmacyTender: vi.fn(),
  refundPharmacyTender: vi.fn(),
  cutPharmacyDailyClose: vi.fn(),
}));

import {
  applyPharmacyTender,
  cutPharmacyDailyClose,
  refundPharmacyTender,
} from '@/lib/pharmacy/settlement';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

/**
 * CAM-2 wiring: tender, refundTender and dailyClose write the evidence request
 * on the same transaction client as the money event, and do nothing extra when
 * the organization has no configured camera gateway.
 */
const scope = { organizationId: 'org-1', branchId: 'branch-1' };
const businessDate = new Date('2026-09-29T09:00:00.000Z');
const events = [
  {
    kind: 'TENDER',
    subjectKind: 'PHARMACY_TENDER',
    subjectId: 'tender-1',
    settle: applyPharmacyTender,
    result: { tenderId: 'tender-1', settled: true, receiptNumber: 7, remainingMinor: 0 },
    call: (api: Api) =>
      api.tender({
        branchId: 'branch-1',
        saleId: 'sale-1',
        deviceId: 'device-1',
        businessDate,
        type: 'CASH',
        amountMinor: 100,
        idempotencyKey: 'attempt-1',
      }),
  },
  {
    kind: 'REFUND',
    subjectKind: 'PHARMACY_REFUND',
    subjectId: 'refund-1',
    settle: refundPharmacyTender,
    result: { refundId: 'refund-1' },
    call: (api: Api) =>
      api.refundTender({
        branchId: 'branch-1',
        originalTenderId: 'tender-1',
        deviceId: 'device-1',
        businessDate,
        amountMinor: 100,
        reason: 'Returned',
        idempotencyKey: 'refund-attempt-1',
      }),
  },
  {
    kind: 'DAILY_CLOSE',
    subjectKind: 'PHARMACY_DAILY_CLOSE',
    subjectId: 'close-1',
    settle: cutPharmacyDailyClose,
    result: { id: 'close-1' },
    call: (api: Api) => api.dailyClose({ branchId: 'branch-1', businessDate }),
  },
] as const;

const app = router({ pharmacySales: pharmacySalesRouter });
type Api = ReturnType<typeof app.createCaller>['pharmacySales'];

function fixture(camera: { id: string } | null) {
  const tx = {
    camera: { findFirst: vi.fn().mockResolvedValue(camera) },
    cameraEvidence: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'evidence-1' }),
    },
    pharmacyTender: { findFirst: vi.fn().mockResolvedValue({ saleId: 'sale-1' }) },
    pharmacyRefund: { findFirst: vi.fn().mockResolvedValue({ saleId: 'sale-1' }) },
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue({ id: 'close-1' }) },
  };
  const transaction = vi.fn(async (work: (client: typeof tx) => unknown) => work(tx));
  const context = {
    db: { $transaction: transaction },
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'actor-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { tx, transaction, api: app.createCaller(context).pharmacySales };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const event of events) vi.mocked(event.settle).mockResolvedValue(event.result as never);
});

describe('pharmacySales counter evidence wiring', () => {
  it.each(events)(
    '$kind: no configured camera gateway is a no-op beside the money event',
    async (event) => {
      const f = fixture(null);
      await expect(event.call(f.api)).resolves.toEqual(event.result);
      expect(f.transaction).toHaveBeenCalledTimes(1);
      expect(event.settle).toHaveBeenCalledWith(
        f.tx,
        expect.objectContaining(scope),
        expect.anything()
      );
      expect(f.tx.camera.findFirst.mock.calls[0][0].where).toMatchObject({
        ...scope,
        gateway: { status: 'ACTIVE', revokedAt: null },
      });
      expect(f.tx.cameraEvidence.createMany).not.toHaveBeenCalled();
      expect(f.tx.pharmacyTender.findFirst).not.toHaveBeenCalled();
      expect(f.tx.pharmacyRefund.findFirst).not.toHaveBeenCalled();
      expect(f.tx.pharmacyDailyClose.findFirst).not.toHaveBeenCalled();
    }
  );

  it.each(events)(
    '$kind: writes the evidence outbox row on the money transaction',
    async (event) => {
      const f = fixture({ id: 'camera-1' });
      await expect(event.call(f.api)).resolves.toEqual(event.result);
      expect(f.transaction).toHaveBeenCalledTimes(1);
      expect(event.settle).toHaveBeenCalledWith(
        f.tx,
        expect.objectContaining(scope),
        expect.anything()
      );
      expect(f.tx.cameraEvidence.createMany).toHaveBeenCalledWith({
        data: [
          {
            ...scope,
            subjectKind: event.subjectKind,
            subjectId: event.subjectId,
            saleId: event.kind === 'DAILY_CLOSE' ? null : 'sale-1',
            cameraId: 'camera-1',
          },
        ],
        skipDuplicates: true,
      });
      // The request is written after the event, so a failed event writes nothing.
      expect(vi.mocked(event.settle).mock.invocationCallOrder[0]).toBeLessThan(
        f.tx.cameraEvidence.createMany.mock.invocationCallOrder[0]
      );
    }
  );

  it('fails the whole transaction when the outbox write fails', async () => {
    const f = fixture({ id: 'camera-1' });
    f.tx.cameraEvidence.createMany.mockRejectedValue(new Error('outbox down'));
    await expect(events[0].call(f.api)).rejects.toThrow();
    expect(f.transaction).toHaveBeenCalledTimes(1);
  });
});
