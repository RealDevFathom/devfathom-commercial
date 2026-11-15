import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-630: the counter's money writes (drawer open, tender, refund, points tender and
// khata repayment) book on the branch's current business day: today in the workspace
// zone. QA booked a drawer, a sale and a refund on a client-sent date two days ahead.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/pharmacy/refund-authorization', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/refund-authorization')>()),
  actorMayRefund: async () => true,
  authenticateRefundPin: async () => ({ verified: true }),
}));
vi.mock('@/lib/pharmacy/customer-loyalty', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/customer-loyalty')>()),
  redeemSalePoints: vi.fn(async () => ({ points: 10, amountMinor: 100, replayed: false })),
}));
vi.mock('@/lib/pharmacy/khata-repayment', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/khata-repayment')>()),
  recordKhataRepayment: vi.fn(async () => ({ receiptReference: 'KP-1', replayed: false })),
}));
// The regulatory operate gate has its own suites; it stays ahead of the date check.
vi.mock('@/lib/pharmacy/regulatory', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/regulatory')>()),
  assertStoredPharmacyMayOperate: vi.fn(async () => undefined),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordAudit: vi.fn(),
  recordTrpcAudit: vi.fn(),
}));

import { redeemSalePoints } from '@/lib/pharmacy/customer-loyalty';
import { recordKhataRepayment } from '@/lib/pharmacy/khata-repayment';
import { assertStoredPharmacyMayOperate } from '@/lib/pharmacy/regulatory';
import {
  PharmacySettlementError,
  requireCurrentPharmacyBusinessDate,
} from '@/lib/pharmacy/settlement';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
// The QA run: 2026-11-03 00:40 PKT, which is still 2026-11-02 in UTC.
const NOW = new Date('2026-11-02T19:40:00.000Z');
const TODAY = new Date('2026-11-03T00:00:00.000Z');
const AHEAD = new Date('2026-11-05T00:00:00.000Z');
const UTC_DAY = new Date('2026-11-02T00:00:00.000Z');
const NOT_CURRENT = { code: 'BAD_REQUEST', message: 'BUSINESS_DATE_NOT_CURRENT' };

function fixture(options: { recordedResult?: object } = {}) {
  let commandType = '';
  let payloadHash = '';
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: {
          permissions: [
            { capability: 'pharmacy:counter', effect: 'ALLOW' },
            { capability: 'pharmacy:dispense', effect: 'ALLOW' },
          ],
        },
        permissionOverrides: [],
      }),
    },
    organization: {
      findUnique: vi.fn().mockResolvedValue({ timezone: 'Asia/Karachi', status: 'ACTIVE' }),
    },
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch-1' }),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
    },
    pharmacyBranchAssignment: {
      findMany: vi.fn().mockResolvedValue([{ branchId: 'branch-1' }]),
    },
    $executeRaw: vi.fn(async (query: { values: unknown[] }) => {
      commandType = String(query.values[4]);
      payloadHash = String(query.values[5]);
      return 1;
    }),
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyMoneyIdempotencyKey: {
      findUnique: vi.fn(async () => ({
        id: 'idem-1',
        commandType,
        payloadHash,
        resultPayload: options.recordedResult ?? null,
      })),
    },
    pharmacyTender: { findFirst: vi.fn().mockResolvedValue({ type: 'CASH' }) },
    pharmacySale: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyDrawerSession: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }: { data: object }) => ({ id: 'drawer-1', ...data })),
    },
    pharmacyDrawerMovement: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown): Promise<unknown> =>
      callback(db)
    ),
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'actor-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, caller: app.createCaller(context).pharmacySales };
}

const drawer = (businessDate: Date) => ({
  branchId: 'branch-1',
  deviceId: 'device-1',
  businessDate,
  openingFloatMinor: 0,
});
const tender = (businessDate: Date) => ({
  branchId: 'branch-1',
  saleId: 'sale-1',
  deviceId: 'device-1',
  businessDate,
  type: 'CASH' as const,
  amountMinor: 100,
  idempotencyKey: 'tender-1',
});
const refund = (businessDate: Date) => ({
  branchId: 'branch-1',
  originalTenderId: 'tender-1',
  deviceId: 'device-1',
  businessDate,
  amountMinor: 100,
  reason: 'Returned medicine',
  idempotencyKey: 'refund-1',
  managerPin: '1234',
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('DEV-630 the server keeps money on the current business day', () => {
  it.each([
    ['two days ahead', AHEAD],
    ['the UTC day, already yesterday in Karachi', UTC_DAY],
  ])('refuses a drawer opened on %s before writing it', async (_, businessDate) => {
    const f = fixture();
    await expect(f.caller.openDrawer(drawer(businessDate))).rejects.toMatchObject(NOT_CURRENT);
    expect(f.db.pharmacyDrawerSession.create).not.toHaveBeenCalled();
  });

  it('opens a drawer on today in the workspace zone', async () => {
    const f = fixture();
    await expect(f.caller.openDrawer(drawer(TODAY))).resolves.toMatchObject({ id: 'drawer-1' });
    expect(f.db.pharmacyDrawerSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ businessDate: TODAY }),
    });
    expect(f.db.organization.findUnique).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      select: { timezone: true },
    });
  });

  it('refuses a tender on another business day before touching the sale', async () => {
    const f = fixture();
    await expect(f.caller.tender(tender(AHEAD))).rejects.toMatchObject(NOT_CURRENT);
    expect(assertStoredPharmacyMayOperate).toHaveBeenCalledTimes(1);
    expect(f.db.pharmacySale.findFirst).not.toHaveBeenCalled();
    expect(f.db.pharmacyDailyClose.findFirst).not.toHaveBeenCalled();
  });

  it('still replays a tender recorded on an earlier day', async () => {
    const f = fixture({ recordedResult: { tenderId: 'tender-1', remainingMinor: 0 } });
    await expect(f.caller.tender(tender(UTC_DAY))).resolves.toEqual({
      tenderId: 'tender-1',
      remainingMinor: 0,
      replayed: true,
    });
  });

  it('refuses a refund on another business day before any money moves', async () => {
    const f = fixture();
    await expect(f.caller.refundTender(refund(AHEAD))).rejects.toMatchObject(NOT_CURRENT);
    expect(f.db.pharmacyDailyClose.findFirst).not.toHaveBeenCalled();
    expect(f.db.pharmacySale.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a points tender on another business day', async () => {
    const f = fixture();
    await expect(
      f.caller.redeemPoints({
        branchId: 'branch-1',
        saleId: 'sale-1',
        points: 10,
        deviceId: 'device-1',
        businessDate: AHEAD,
        idempotencyKey: 'redeem-1',
      })
    ).rejects.toMatchObject(NOT_CURRENT);
    expect(redeemSalePoints).not.toHaveBeenCalled();
  });

  it('refuses a khata repayment on another business day', async () => {
    const f = fixture();
    await expect(
      f.caller.recordKhataPayment({
        branchId: 'branch-1',
        familyAccountId: 'family-1',
        amountMinor: 500,
        tender: 'CASH',
        deviceId: 'device-1',
        businessDate: AHEAD,
        idempotencyKey: 'khata-1',
      })
    ).rejects.toMatchObject(NOT_CURRENT);
    expect(recordKhataRepayment).not.toHaveBeenCalled();
  });
});

describe('requireCurrentPharmacyBusinessDate', () => {
  const db = (timezone: string | null) =>
    ({
      organization: {
        findUnique: vi.fn().mockResolvedValue(timezone === null ? null : { timezone }),
      },
    }) as unknown as ScopedDb;
  const scope = { organizationId: 'org-1' };

  it('accepts only today in the workspace zone', async () => {
    await expect(
      requireCurrentPharmacyBusinessDate(db('Asia/Karachi'), scope, TODAY, NOW)
    ).resolves.toBeUndefined();
    for (const date of [AHEAD, UTC_DAY, new Date('2026-11-04T00:00:00.000Z')])
      await expect(
        requireCurrentPharmacyBusinessDate(db('Asia/Karachi'), scope, date, NOW)
      ).rejects.toEqual(new PharmacySettlementError('BUSINESS_DATE_NOT_CURRENT'));
  });

  it('reads a missing or refused zone as UTC, as the counter and the close do', async () => {
    for (const zone of [null, 'Not/AZone'])
      await expect(
        requireCurrentPharmacyBusinessDate(db(zone), scope, UTC_DAY, NOW)
      ).resolves.toBeUndefined();
  });
});
