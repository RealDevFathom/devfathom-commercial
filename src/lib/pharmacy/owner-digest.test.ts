import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readPharmacyOwnerCommandCentre: vi.fn(),
  readPharmacyAnomalySignals: vi.fn(),
  refreshPharmacyAnomalySignals: vi.fn(),
  can: vi.fn(),
  resolveOrganizationEntitlements: vi.fn(),
  withTenantDb: vi.fn(),
  platformDb: { pharmacyOwnerDigestSetting: { findMany: vi.fn() } },
  tenantDb: {
    pharmacyOwnerDigestSetting: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    pharmacyOwnerDigestCapture: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      createMany: vi.fn(),
    },
  },
}));
vi.mock('@/lib/entitlements', async () => ({
  ...(await vi.importActual<typeof import('@/lib/entitlements')>('@/lib/entitlements')),
  resolveOrganizationEntitlements: mocks.resolveOrganizationEntitlements,
}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (callback) => callback(mocks.platformDb)),
  withTenantDb: mocks.withTenantDb,
}));
vi.mock('./reports', () => ({
  readPharmacyOwnerCommandCentre: mocks.readPharmacyOwnerCommandCentre,
  PHARMACY_METRIC_CONTRACT: [
    'salesMinor',
    'marginMinor',
    'cashMinor',
    'refundsMinor',
    'openStockSignals',
    'expiryValueMinor30',
    'expiryValueMinor60',
    'expiryValueMinor90',
    'expiryValueMinor180',
    'openRecalls',
    'quarantineUnits',
    'safetyQueue',
    'deviceFiscalOfflineExceptions',
  ].map((key) => ({ key, label: key, definition: `${key} definition`, source: `${key} source` })),
}));
vi.mock('./anomaly-signals-operations', () => ({
  readPharmacyAnomalySignals: mocks.readPharmacyAnomalySignals,
  refreshPharmacyAnomalySignals: mocks.refreshPharmacyAnomalySignals,
  renderAnomalyDigest: (signals: Array<{ explanation: string }>) => [
    `Anomaly review signals: ${signals.length}`,
    ...signals.map((signal) => `- ${signal.explanation}`),
  ],
}));

import {
  CaptureChannel,
  composeOwnerDigest,
  processDueOwnerDigests,
  WhatsAppChannel,
} from './owner-digest';

const now = new Date('2026-09-04T08:00:00.000Z');
const due = { id: 'setting_1', organizationId: 'org_1' };
const digestInput = {
  organizationId: 'org_1',
  userId: 'user_1',
  branchId: 'branch_1',
  branchName: 'Main',
  businessDate: '2026-09-04',
};
function initialState() {
  return {
    setting: {
      ...due,
      userId: 'user_1',
      branchId: 'branch_1',
      enabled: true,
      nextDueAt: now as Date | null,
      updatedAt: new Date('2026-09-03T08:00:00.000Z'),
      timeMinutes: 480,
    },
    organization: { status: 'ACTIVE', vertical: 'PHARMACY', timezone: 'UTC' },
    branch: { name: 'Main', active: true, organizationId: 'org_1' },
    user: {
      id: 'user_1',
      organizationId: 'org_1',
      role: 'ADMIN',
      status: 'ACTIVE',
      department: 'Management',
    },
    licensed: true,
    captures: new Map<string, { id: string; rendered: string }>(),
    anomalyWrites: 0,
  };
}
let state = initialState();
const captureKey = (key: Record<string, string>) =>
  [key.organizationId, key.userId, key.branchId, key.businessDate].join(':');

function scheduleDue() {
  mocks.platformDb.pharmacyOwnerDigestSetting.findMany.mockResolvedValue([due]);
}

describe('RPT-03 owner digest', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    state = initialState();
    // Transaction double: only digest-owned writes roll back. Authority changes
    // stand for separately committed revocations, not part of this transaction.
    mocks.withTenantDb.mockImplementation(async (_organizationId, callback) => {
      const snapshot = {
        setting: { ...state.setting },
        captures: new Map(state.captures),
        anomalyWrites: state.anomalyWrites,
      };
      try {
        return await callback(mocks.tenantDb);
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      }
    });
    mocks.tenantDb.pharmacyOwnerDigestSetting.findFirst.mockImplementation(async ({ where }) => {
      if (
        where.id !== state.setting.id ||
        where.organizationId !== state.setting.organizationId ||
        (where.enabled && !state.setting.enabled) ||
        (where.nextDueAt &&
          (!state.setting.nextDueAt || state.setting.nextDueAt > where.nextDueAt.lte))
      )
        return null;
      return {
        ...state.setting,
        organization: { ...state.organization },
        branch: { ...state.branch },
        user: { ...state.user },
      };
    });
    mocks.tenantDb.pharmacyOwnerDigestSetting.updateMany.mockImplementation(
      async ({ where, data }) => {
        if (
          where.id !== state.setting.id ||
          where.organizationId !== state.setting.organizationId ||
          where.enabled !== state.setting.enabled ||
          where.nextDueAt.getTime() !== state.setting.nextDueAt?.getTime() ||
          where.updatedAt.getTime() !== state.setting.updatedAt.getTime()
        )
          return { count: 0 };
        Object.assign(state.setting, data);
        return { count: 1 };
      }
    );
    mocks.tenantDb.pharmacyOwnerDigestSetting.update.mockImplementation(async ({ data }) => {
      Object.assign(state.setting, data);
      return state.setting;
    });
    mocks.tenantDb.pharmacyOwnerDigestCapture.findUnique.mockImplementation(
      async ({ where }) =>
        state.captures.get(captureKey(where.organizationId_userId_branchId_businessDate)) ?? null
    );
    mocks.tenantDb.pharmacyOwnerDigestCapture.findUniqueOrThrow.mockImplementation(
      async ({ where }) => {
        const capture = state.captures.get(
          captureKey(where.organizationId_userId_branchId_businessDate)
        );
        if (!capture) throw new Error('Capture missing');
        return capture;
      }
    );
    mocks.tenantDb.pharmacyOwnerDigestCapture.createMany.mockImplementation(
      async ({ data, skipDuplicates }) => {
        expect(skipDuplicates).toBe(true);
        const key = captureKey(data);
        if (state.captures.has(key)) return { count: 0 };
        state.captures.set(key, { id: 'capture_1', rendered: data.rendered });
        return { count: 1 };
      }
    );
    mocks.resolveOrganizationEntitlements.mockImplementation(async () => ({
      enabledModules: state.licensed ? ['pharmacy-reports'] : [],
    }));
    mocks.can.mockResolvedValue(true);
    mocks.platformDb.pharmacyOwnerDigestSetting.findMany.mockResolvedValue([]);
    mocks.readPharmacyAnomalySignals.mockResolvedValue([]);
    mocks.refreshPharmacyAnomalySignals.mockImplementation(async () => {
      state.anomalyWrites += 1;
      return { evaluated: 0, signals: [] };
    });
    mocks.readPharmacyOwnerCommandCentre.mockResolvedValue({
      freshness: { status: 'CURRENT', asOf: '2026-09-04T08:00:00.000Z', source: 'ledgers' },
      metrics: {
        salesMinor: 10000,
        marginMinor: 2500,
        cashMinor: 6000,
        refundsMinor: 500,
        openStockSignals: 3,
        expiryValueMinor30: 700,
        expiryValueMinor60: 900,
        expiryValueMinor90: 1100,
        expiryValueMinor180: 1300,
        openRecalls: 1,
        quarantineUnits: 2,
        safetyQueue: 4,
        deviceFiscalOfflineExceptions: null,
      },
    });
  });
  afterEach(() => vi.useRealTimers());

  it('composes one branch-day by calling the RPT-01 reader and retaining its contracts', async () => {
    const digest = await composeOwnerDigest({} as never, {
      organizationId: 'org_1',
      userId: 'user_1',
      branchId: 'branch_1',
      branchName: 'Main',
      businessDate: '2026-09-04',
    });

    expect(mocks.readPharmacyOwnerCommandCentre).toHaveBeenCalledWith(expect.anything(), {
      branchIds: ['branch_1'],
      from: '2026-09-04',
      to: '2026-09-04',
    });
    expect(digest.metrics.map(({ key }) => key)).toEqual([
      'salesMinor',
      'marginMinor',
      'cashMinor',
      'refundsMinor',
      'openStockSignals',
      'expiryValueMinor30',
      'expiryValueMinor60',
      'expiryValueMinor90',
      'expiryValueMinor180',
      'openRecalls',
      'quarantineUnits',
      'safetyQueue',
      'deviceFiscalOfflineExceptions',
    ]);
    expect(digest.rendered).toContain('cashMinor: PKR 60.00');
    expect(digest.rendered).not.toContain('cashVarianceMinor');
    expect(digest.rendered).toContain('deviceFiscalOfflineExceptions: Not available');
    expect(digest.rendered).toContain('Anomaly review signals: 0');
  });

  it('includes explainable anomaly events in the existing owner digest', async () => {
    mocks.readPharmacyAnomalySignals.mockResolvedValue([
      {
        kind: 'CASH_VARIANCE',
        status: 'OPEN',
        severity: 'REVIEW',
        explanation: 'Counted PKR 1,000 below the expected cash; review the close evidence.',
      },
    ]);
    const digest = await composeOwnerDigest({} as never, {
      organizationId: 'org_1',
      userId: 'user_1',
      branchId: 'branch_1',
      branchName: 'Main',
      businessDate: '2026-09-04',
    });
    expect(digest.rendered).toContain('Anomaly review signals: 1');
    expect(digest.rendered).toContain('review the close evidence');
  });

  it('persists capture delivery with the daily idempotency key', async () => {
    const digest = await composeOwnerDigest({} as never, {
      organizationId: 'org_1',
      userId: 'user_1',
      branchId: 'branch_1',
      branchName: 'Main',
      businessDate: '2026-09-04',
    });

    await expect(new CaptureChannel().deliver(mocks.tenantDb as never, digest)).resolves.toEqual({
      delivered: true,
      reference: 'capture_1',
    });
    expect(mocks.tenantDb.pharmacyOwnerDigestCapture.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_userId_branchId_businessDate: {
            organizationId: 'org_1',
            userId: 'user_1',
            branchId: 'branch_1',
            businessDate: '2026-09-04',
          },
        },
      })
    );
  });

  it('never reports a WhatsApp send from the stub', async () => {
    await expect(new WhatsAppChannel().deliver()).resolves.toEqual({ delivered: false });
  });

  async function expectDeniedDigestDisabled() {
    scheduleDue();
    await expect(processDueOwnerDigests(now)).resolves.toEqual({ due: 1, captured: 0 });
    expect(mocks.readPharmacyOwnerCommandCentre).not.toHaveBeenCalled();
    expect(mocks.refreshPharmacyAnomalySignals).not.toHaveBeenCalled();
    expect(state.captures.size).toBe(0);
    expect(mocks.tenantDb.pharmacyOwnerDigestSetting.update).toHaveBeenCalledWith({
      where: { id: 'setting_1' },
      data: { enabled: false, nextDueAt: null },
    });
    return now;
  }

  it('disables a due digest before composition when operational access was revoked', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action !== 'reports:operational');
    const now = await expectDeniedDigestDisabled();
    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user_1', role: 'ADMIN', status: 'ACTIVE' }),
      'reports:operational',
      undefined,
      expect.objectContaining({ db: mocks.tenantDb, source: 'SYSTEM', now })
    );
  });

  it('disables a due digest before composition when financial access was revoked', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action !== 'reports:financial');
    const now = await expectDeniedDigestDisabled();
    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user_1', role: 'ADMIN', status: 'ACTIVE' }),
      'reports:financial',
      undefined,
      expect.objectContaining({ db: mocks.tenantDb, source: 'SYSTEM', now })
    );
  });

  describe('scheduled execution controls', () => {
    it('captures once and advances the schedule using tenant settings', async () => {
      scheduleDue();
      await expect(processDueOwnerDigests(now)).resolves.toEqual({ due: 1, captured: 1 });
      expect(state.captures.size).toBe(1);
      expect(state.anomalyWrites).toBe(1);
      expect(state.setting.nextDueAt).toEqual(new Date('2026-09-05T08:00:00.000Z'));
      expect(mocks.withTenantDb).toHaveBeenCalledWith('org_1', expect.any(Function));
      expect(mocks.resolveOrganizationEntitlements).toHaveBeenCalledTimes(2);
    });

    it('skips a setting disabled after platform discovery without effects', async () => {
      scheduleDue();
      state.setting.enabled = false;
      state.setting.nextDueAt = null;
      await expect(processDueOwnerDigests(now)).resolves.toEqual({ due: 1, captured: 0 });
      expect(mocks.tenantDb.pharmacyOwnerDigestSetting.updateMany).not.toHaveBeenCalled();
      expect(mocks.refreshPharmacyAnomalySignals).not.toHaveBeenCalled();
      expect(state.captures.size).toBe(0);
      expect(state.setting.nextDueAt).toBeNull();
    });

    it.each(['disable', 'reschedule'] as const)(
      'honors a concurrent %s before the claim',
      async (change) => {
        scheduleDue();
        const updateMany =
          mocks.tenantDb.pharmacyOwnerDigestSetting.updateMany.getMockImplementation()!;
        mocks.tenantDb.pharmacyOwnerDigestSetting.updateMany.mockImplementationOnce(
          async (args) => {
            state.setting.updatedAt = now;
            if (change === 'disable') {
              state.setting.enabled = false;
              state.setting.nextDueAt = null;
            } else state.setting.nextDueAt = new Date('2026-09-06T09:00:00.000Z');
            return updateMany(args);
          }
        );
        await expect(processDueOwnerDigests(now)).resolves.toEqual({ due: 1, captured: 0 });
        expect(mocks.refreshPharmacyAnomalySignals).not.toHaveBeenCalled();
        expect(mocks.tenantDb.pharmacyOwnerDigestSetting.update).not.toHaveBeenCalled();
        expect(state.captures.size).toBe(0);
        expect(state.setting.nextDueAt).toEqual(
          change === 'disable' ? null : new Date('2026-09-06T09:00:00.000Z')
        );
      }
    );

    it.each(['PROSPECT', 'SUSPENDED', 'TERMINATED', 'PURGING', 'PURGED'])(
      'disables execution for company status %s',
      async (status) => {
        state.organization.status = status;
        await expectDeniedDigestDisabled();
      }
    );

    it.each([
      [
        'wrong industry',
        () => {
          state.organization.vertical = 'RESTAURANT';
        },
      ],
      [
        'inactive user',
        () => {
          state.user.status = 'INACTIVE';
        },
      ],
      [
        'non-owner user',
        () => {
          state.user.role = 'EMPLOYEE';
        },
      ],
      [
        'foreign user',
        () => {
          state.user.organizationId = 'org_2';
        },
      ],
      [
        'inactive branch',
        () => {
          state.branch.active = false;
        },
      ],
      [
        'foreign branch',
        () => {
          state.branch.organizationId = 'org_2';
        },
      ],
      [
        'revoked module',
        () => {
          state.licensed = false;
        },
      ],
    ])('denies %s before anomaly or capture effects', async (_label, revoke) => {
      (revoke as () => void)();
      await expectDeniedDigestDisabled();
    });

    it.each(['company', 'module', 'user', 'branch', 'operational', 'financial'])(
      'rolls back all digest effects when %s authority changes during composition',
      async (change) => {
        scheduleDue();
        const compose = mocks.readPharmacyOwnerCommandCentre.getMockImplementation()!;
        mocks.readPharmacyOwnerCommandCentre.mockImplementationOnce(async (...args) => {
          const report = await compose(...args);
          if (change === 'company') state.organization.status = 'SUSPENDED';
          if (change === 'module') state.licensed = false;
          if (change === 'user') state.user.status = 'INACTIVE';
          if (change === 'branch') state.branch.active = false;
          if (change === 'operational' || change === 'financial')
            mocks.can.mockImplementation(
              async (_subject, action) => action !== `reports:${change}`
            );
          return report;
        });
        await expect(processDueOwnerDigests(now)).resolves.toEqual({ due: 1, captured: 0 });
        expect(mocks.refreshPharmacyAnomalySignals).toHaveBeenCalledOnce();
        expect(mocks.tenantDb.pharmacyOwnerDigestCapture.createMany).not.toHaveBeenCalled();
        expect(state.anomalyWrites).toBe(0);
        expect(state.captures.size).toBe(0);
        expect(state.setting.nextDueAt).toEqual(now);
      }
    );

    it('uses current authority time even when replaying a historical scheduler cutoff', async () => {
      scheduleDue();
      const current = new Date('2026-09-06T09:00:00.000Z');
      vi.setSystemTime(current);
      mocks.resolveOrganizationEntitlements.mockImplementation(
        async (_organizationId, _db, at) => ({
          enabledModules: at < new Date('2026-09-05T00:00:00.000Z') ? ['pharmacy-reports'] : [],
        })
      );
      await expectDeniedDigestDisabled();
      expect(mocks.resolveOrganizationEntitlements).toHaveBeenCalledWith(
        'org_1',
        mocks.tenantDb,
        current
      );
    });

    it('keeps the scheduled local business date when processing after midnight', async () => {
      scheduleDue();
      state.organization.timezone = 'Asia/Karachi';
      state.setting.nextDueAt = new Date('2026-09-03T20:00:00.000Z');
      const later = new Date('2026-09-04T22:00:00.000Z');
      vi.setSystemTime(later);
      await expect(processDueOwnerDigests(later)).resolves.toEqual({ due: 1, captured: 1 });
      expect(mocks.readPharmacyOwnerCommandCentre).toHaveBeenCalledWith(mocks.tenantDb, {
        branchIds: ['branch_1'],
        from: '2026-09-04',
        to: '2026-09-04',
      });
      expect(state.setting.nextDueAt).toEqual(new Date('2026-09-05T03:00:00.000Z'));
    });

    it('skips an existing daily receipt without composing or refreshing anomalies', async () => {
      scheduleDue();
      state.captures.set(captureKey(digestInput), {
        id: 'original',
        rendered: 'Original evidence',
      });
      await expect(processDueOwnerDigests(now)).resolves.toEqual({ due: 1, captured: 0 });
      expect(mocks.readPharmacyOwnerCommandCentre).not.toHaveBeenCalled();
      expect(mocks.refreshPharmacyAnomalySignals).not.toHaveBeenCalled();
      expect(mocks.tenantDb.pharmacyOwnerDigestCapture.createMany).not.toHaveBeenCalled();
      expect([...state.captures.values()]).toEqual([
        { id: 'original', rendered: 'Original evidence' },
      ]);
    });

    it('returns one delivered receipt for concurrent captures and preserves the first content', async () => {
      const digest = await composeOwnerDigest(mocks.tenantDb as never, digestInput);
      const channel = new CaptureChannel();
      const receipts = await Promise.all([
        channel.deliver(mocks.tenantDb as never, digest),
        channel.deliver(mocks.tenantDb as never, { ...digest, rendered: 'Changed retry' }),
      ]);
      expect(receipts).toEqual([
        { delivered: true, reference: 'capture_1' },
        { delivered: false, reference: 'capture_1' },
      ]);
      expect(state.captures.size).toBe(1);
      expect([...state.captures.values()][0].rendered).toBe(digest.rendered);
    });

    it('counts the channel receipt rather than claiming a duplicate insert was delivered', async () => {
      scheduleDue();
      mocks.tenantDb.pharmacyOwnerDigestCapture.createMany.mockImplementationOnce(
        async ({ data }) => {
          state.captures.set(captureKey(data), {
            id: 'other_capture',
            rendered: 'Concurrent receipt',
          });
          return { count: 0 };
        }
      );
      await expect(processDueOwnerDigests(now)).resolves.toEqual({ due: 1, captured: 0 });
      expect([...state.captures.values()]).toEqual([
        { id: 'other_capture', rendered: 'Concurrent receipt' },
      ]);
    });

    it('allows only one worker to effect a due setting when both read it before claiming', async () => {
      scheduleDue();
      let attempts = 0;
      let release!: () => void;
      const bothClaiming = new Promise<void>((resolve) => {
        release = resolve;
      });
      const updateMany =
        mocks.tenantDb.pharmacyOwnerDigestSetting.updateMany.getMockImplementation()!;
      mocks.tenantDb.pharmacyOwnerDigestSetting.updateMany.mockImplementation(async (args) => {
        attempts += 1;
        if (attempts === 2) release();
        await bothClaiming;
        return updateMany(args);
      });
      const results = await Promise.all([processDueOwnerDigests(now), processDueOwnerDigests(now)]);
      expect(attempts).toBe(2);
      expect(results.map((result) => result.captured).sort()).toEqual([0, 1]);
      expect(results.every((result) => result.due === 1)).toBe(true);
      expect(mocks.refreshPharmacyAnomalySignals).toHaveBeenCalledOnce();
      expect(state.anomalyWrites).toBe(1);
      expect(state.captures.size).toBe(1);
    });

    it.each(['refresh', 'compose', 'capture', 'receipt'])(
      'propagates a %s failure through the transaction and retains the due occurrence',
      async (phase) => {
        scheduleDue();
        const error = new Error(`${phase} failed`);
        const operation = {
          refresh: mocks.refreshPharmacyAnomalySignals,
          compose: mocks.readPharmacyOwnerCommandCentre,
          capture: mocks.tenantDb.pharmacyOwnerDigestCapture.createMany,
          receipt: mocks.tenantDb.pharmacyOwnerDigestCapture.findUniqueOrThrow,
        }[phase]!;
        operation.mockRejectedValueOnce(error);
        await expect(processDueOwnerDigests(now)).rejects.toBe(error);
        expect(state.anomalyWrites).toBe(0);
        expect(state.captures.size).toBe(0);
        expect(state.setting.nextDueAt).toEqual(now);
      }
    );

    it('does not report success when the owning transaction fails to commit', async () => {
      scheduleDue();
      const error = new Error('Commit failed');
      mocks.withTenantDb.mockImplementationOnce(async (_organizationId, callback) => {
        await callback(mocks.tenantDb);
        throw error;
      });
      await expect(processDueOwnerDigests(now)).rejects.toBe(error);
    });
  });
});
