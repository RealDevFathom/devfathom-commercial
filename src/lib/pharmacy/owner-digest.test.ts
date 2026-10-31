import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readPharmacyOwnerCommandCentre: vi.fn(),
  readPharmacyAnomalySignals: vi.fn(),
  refreshPharmacyAnomalySignals: vi.fn(),
  can: vi.fn(),
  resolveOrganizationEntitlements: vi.fn(),
  sendAndLog: vi.fn(),
  activeTenantTransactions: 0,
  platformDb: { pharmacyOwnerDigestSetting: { findMany: vi.fn() } },
  tenantDb: {
    $queryRaw: vi.fn(),
    pharmacyOwnerDigestSetting: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    pharmacyOwnerDigestCapture: {
      findUnique: vi.fn(),
      createMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
  },
}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', async () => ({
  ...(await vi.importActual<typeof import('@/lib/entitlements')>('@/lib/entitlements')),
  resolveOrganizationEntitlements: mocks.resolveOrganizationEntitlements,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (callback) => callback(mocks.platformDb)),
  withTenantDb: vi.fn(async (_organizationId, callback) => {
    mocks.activeTenantTransactions += 1;
    try {
      return await callback(mocks.tenantDb);
    } finally {
      mocks.activeTenantTransactions -= 1;
    }
  }),
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
vi.mock('./whatsapp/message-log', () => ({ sendAndLog: mocks.sendAndLog }));

import {
  CaptureChannel,
  composeOwnerDigest,
  nextDigestDueAt,
  ownerDigestWhatsAppPhoneHash,
  ownerDigestWhatsAppParameters,
  processDueOwnerDigests,
  readOwnerBriefingFigures,
  renderOwnerBriefing,
  WhatsAppChannel,
} from './owner-digest';
import { MetaWhatsAppProvider } from './whatsapp/provider';

describe('RPT-03 owner digest', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeTenantTransactions = 0;
    mocks.can.mockResolvedValue(true);
    mocks.resolveOrganizationEntitlements.mockResolvedValue({
      enabledModules: ['pharmacy-reports'],
    });
    mocks.tenantDb.pharmacyOwnerDigestSetting.updateMany.mockResolvedValue({ count: 1 });
    mocks.platformDb.pharmacyOwnerDigestSetting.findMany.mockResolvedValue([]);
    mocks.readPharmacyAnomalySignals.mockResolvedValue([]);
    mocks.refreshPharmacyAnomalySignals.mockResolvedValue({ evaluated: 0, signals: [] });
    mocks.sendAndLog.mockResolvedValue('SENT');
    mocks.tenantDb.$queryRaw.mockResolvedValue([]);
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

  it('composes one branch-day by calling the RPT-01 reader and retaining its contracts', async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([]) } as never;
    const digest = await composeOwnerDigest(db, {
      organizationId: 'org_1',
      userId: 'user_1',
      branchId: 'branch_1',
      branchName: 'Main',
      businessDate: '2026-09-04',
    });

    expect(mocks.readPharmacyOwnerCommandCentre).toHaveBeenCalledWith(db, {
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
    expect(digest.briefings.weekly.from).toBe('2026-08-29');
    expect(digest.briefings.weekly.to).toBe('2026-09-04');
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
    const digest = await composeOwnerDigest({ $queryRaw: vi.fn().mockResolvedValue([]) } as never, {
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
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUniqueOrThrow = vi.fn().mockResolvedValue({ id: 'capture_1' });
    const digest = await composeOwnerDigest({ $queryRaw: vi.fn().mockResolvedValue([]) } as never, {
      organizationId: 'org_1',
      userId: 'user_1',
      branchId: 'branch_1',
      branchName: 'Main',
      businessDate: '2026-09-04',
    });

    await expect(
      new CaptureChannel().deliver(
        { pharmacyOwnerDigestCapture: { createMany, findUniqueOrThrow } } as never,
        digest
      )
    ).resolves.toEqual({ delivered: true, reference: 'capture_1' });
    expect(createMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org_1',
        userId: 'user_1',
        branchId: 'branch_1',
        businessDate: '2026-09-04',
      }),
      skipDuplicates: true,
    });
    expect(findUniqueOrThrow).toHaveBeenCalledWith({
      where: {
        organizationId_userId_branchId_businessDate: {
          organizationId: 'org_1',
          userId: 'user_1',
          branchId: 'branch_1',
          businessDate: '2026-09-04',
        },
      },
      select: { id: true },
    });
  });

  it('schedules a digest in UTC for a stored zone Intl refuses, instead of throwing', () => {
    const now = new Date('2026-09-04T06:30:00.000Z');
    expect(nextDigestDueAt(now, 'PKT', 480)).toEqual(nextDigestDueAt(now, 'UTC', 480));
    expect(nextDigestDueAt(now, 'PKT', 480)).toEqual(new Date('2026-09-04T08:00:00.000Z'));
  });

  it('queries organization-local day boundaries and excludes recovered events from open loss', async () => {
    const query = vi.fn().mockResolvedValue([]);
    await readOwnerBriefingFigures(
      { $queryRaw: query } as never,
      'branch_1',
      '2026-09-04',
      '2026-09-04',
      'Asia/Karachi'
    );
    const statement = query.mock.calls[0][0];
    expect(statement.values).toEqual(
      expect.arrayContaining([
        'branch_1',
        new Date('2026-09-03T19:00:00.000Z'),
        new Date('2026-09-04T19:00:00.000Z'),
      ])
    );
    expect(statement.sql).toContain("SELECT * FROM all_period_demand WHERE status='OPEN'");
    expect(statement.sql).toContain('FROM open_period_demand GROUP BY');
    expect(statement.sql).toContain('SUM("estimatedValueMinor") FROM open_period_demand');
  });

  it('delivers the safe briefing through the configured owner template and audit log', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ messages: [{ id: 'wamid.owner' }] }), { status: 200 })
    );
    const config = {
      provider: 'meta' as const,
      accessToken: 'token',
      phoneNumberId: 'sender',
      organizationId: 'org_1',
      appSecret: null,
      verifyToken: null,
      graphVersion: 'v21.0',
      templateLanguage: 'en',
      templates: { refillReminder: null, khataReminder: null, ownerDigest: 'owner_digest_v1' },
      reminderLeadDays: 3,
    };
    const digest = await composeOwnerDigest({ $queryRaw: vi.fn().mockResolvedValue([]) } as never, {
      organizationId: 'org_1',
      userId: 'user_1',
      branchId: 'branch_1',
      branchName: 'Main',
      ownerPhone: '0300 1234567',
      whatsappPhoneHash: ownerDigestWhatsAppPhoneHash('0300 1234567'),
      businessDate: '2026-09-04',
    });

    const provider = new MetaWhatsAppProvider(config, fetchImpl);
    await expect(new WhatsAppChannel(config, provider).deliver(digest)).resolves.toEqual({
      delivered: true,
      reference: 'SENT',
    });
    expect(mocks.sendAndLog).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'OWNER_DIGEST',
        dedupeKey: 'owner-digest:user_1:branch_1:2026-09-04',
        phoneLast4: '4567',
        templateName: 'owner_digest_v1',
      }),
      expect.any(Function)
    );
    const send = mocks.sendAndLog.mock.calls[0][1];
    await send();
    const payload = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(payload.template.name).toBe('owner_digest_v1');
    const parameters = payload.template.components[0].parameters.map(
      (p: { text: string }) => p.text
    );
    expect(parameters).toEqual([
      '2026-09-04',
      'PKR 100.00',
      'PKR 60.00',
      'PKR 0.00',
      '0',
      'PKR 0.00',
      'No',
      'PKR 0.00',
      'PKR 7.00',
      'Not available',
      '2026-08-29',
      '2026-09-04',
      'PKR 100.00',
      'PKR 60.00',
      'PKR 0.00',
      '0',
      'PKR 0.00',
      'No',
      'PKR 0.00',
      'PKR 7.00',
      'Not available',
    ]);
    expect(parameters.every((value: string) => !/[\r\n\t]| {5}/.test(value))).toBe(true);
    expect(parameters.join(' ')).not.toContain('Main');
  });

  it('fails closed when the sender is not explicitly bound to this organization', async () => {
    const config = {
      provider: 'meta' as const,
      accessToken: 'token',
      phoneNumberId: 'sender',
      organizationId: 'another_org',
      appSecret: null,
      verifyToken: null,
      graphVersion: 'v21.0',
      templateLanguage: 'en',
      templates: { refillReminder: null, khataReminder: null, ownerDigest: 'owner_digest_v1' },
      reminderLeadDays: 3,
    };
    const digest = await composeOwnerDigest({ $queryRaw: vi.fn().mockResolvedValue([]) } as never, {
      organizationId: 'org_1',
      userId: 'user_1',
      branchId: 'branch_1',
      branchName: 'Main',
      ownerPhone: '0300 1234567',
      whatsappPhoneHash: ownerDigestWhatsAppPhoneHash('0300 1234567'),
      businessDate: '2026-09-04',
    });
    await expect(
      new WhatsAppChannel(config, { sendTemplate: vi.fn() } as never).deliver(digest)
    ).resolves.toEqual({ delivered: false });
    expect(mocks.sendAndLog).not.toHaveBeenCalled();
  });

  it.each([null, 'changed', 'invalid'])(
    'does not claim a message without consent for the current valid phone: %s',
    async (consent) => {
      const config = {
        provider: 'meta' as const,
        accessToken: 'token',
        phoneNumberId: 'sender',
        organizationId: 'org_1',
        appSecret: null,
        verifyToken: null,
        graphVersion: 'v21.0',
        templateLanguage: 'en',
        reminderLeadDays: 3,
        templates: { refillReminder: null, khataReminder: null, ownerDigest: 'owner_digest_v1' },
      };
      const digest = await composeOwnerDigest(mocks.tenantDb as never, {
        organizationId: 'org_1',
        userId: 'user_1',
        branchId: 'branch_1',
        branchName: 'Main',
        businessDate: '2026-09-04',
        ownerPhone: consent === 'invalid' ? 'bad' : '0300 1234567',
        whatsappPhoneHash: consent ? ownerDigestWhatsAppPhoneHash('0300 7654321') : null,
      });
      await expect(new WhatsAppChannel(config).deliver(digest)).resolves.toEqual({
        delivered: false,
      });
      expect(mocks.sendAndLog).not.toHaveBeenCalled();
    }
  );

  it('converts bigint aggregates above PostgreSQL int32 into serializable figures', async () => {
    mocks.tenantDb.$queryRaw.mockResolvedValueOnce([
      {
        lost: BigInt(3_000_000_000),
        walkOuts: BigInt(2),
        recovered: BigInt(4_000_000_000),
        topGapValue: BigInt(3_000_000_000),
        topGapName: 'Medicine',
        topGapDraftPo: true,
      },
    ]);
    const figures = await readOwnerBriefingFigures(
      mocks.tenantDb as never,
      'branch_1',
      '2026-09-04',
      '2026-09-04',
      'UTC'
    );
    expect(figures).toMatchObject({
      lostDemandEstimatedMinor: 3_000_000_000,
      walkOuts: 2,
      recoveredEstimatedMinor: 4_000_000_000,
      topGapEstimatedMinor: 3_000_000_000,
    });
    expect(() => JSON.stringify(figures)).not.toThrow();
    expect(mocks.tenantDb.$queryRaw.mock.calls[0][0].sql).not.toContain('::int');
  });

  it('keeps catalog, salt, category and even branch names out of WhatsApp copy', () => {
    const briefing = renderOwnerBriefing({
      variant: 'DAILY',
      branchName: 'Amoxicillin Antibiotics',
      from: '2026-09-04',
      to: '2026-09-04',
      figures: {
        salesMinor: 125_000,
        cashMinor: 80_000,
        lostDemandEstimatedMinor: 32_500,
        walkOuts: 7,
        topGapName: 'Panadol Paracetamol Analgesic',
        topGapEstimatedMinor: 12_000,
        topGapDraftPo: true,
        recoveredEstimatedMinor: 4_500,
        expiryAtRiskMinor: 8_000,
        khataDueMinor: 25_000,
      },
    });
    expect(briefing.appBody).toContain('Panadol Paracetamol Analgesic');
    expect(briefing.whatsappBody).not.toMatch(
      /Panadol|Paracetamol|Analgesic|Amoxicillin|Antibiotics/i
    );
    expect(briefing.whatsappBody.split('\n')).toHaveLength(6);
    expect(briefing.whatsappBody).toContain('Lost demand estimate PKR 325.00 · walk-outs 7');
    const parameters = ownerDigestWhatsAppParameters({
      briefings: { daily: briefing, weekly: briefing },
    } as never);
    expect(parameters.join(' ')).not.toMatch(
      /Panadol|Paracetamol|Analgesic|Amoxicillin|Antibiotics/i
    );
    expect(parameters).toHaveLength(21);
    expect(parameters[6]).toBe('Yes');
    expect(parameters[10]).toBe('2026-09-04');
  });

  function dueSetting(now: Date) {
    return {
      id: 'setting_1',
      organizationId: 'org_1',
      userId: 'user_1',
      branchId: 'branch_1',
      enabled: true,
      whatsappPhoneHash: ownerDigestWhatsAppPhoneHash('0300 1234567'),
      nextDueAt: now,
      updatedAt: now,
      timeMinutes: 480,
      organization: { status: 'ACTIVE', vertical: 'PHARMACY', timezone: 'UTC' },
      branch: { name: 'Main', active: true, organizationId: 'org_1' },
      user: {
        id: 'user_1',
        organizationId: 'org_1',
        role: 'ADMIN',
        status: 'ACTIVE',
        department: 'Management',
        phone: '0300 1234567',
      },
    };
  }

  it.each(['compose', 'recheck', 'log', 'provider'])(
    'continues processing the next owner after a %s failure',
    async (failure) => {
      vi.stubEnv('PHARMACY_WHATSAPP_PROVIDER', 'meta');
      vi.stubEnv('PHARMACY_WHATSAPP_ACCESS_TOKEN', 'token');
      vi.stubEnv('PHARMACY_WHATSAPP_PHONE_NUMBER_ID', 'sender');
      vi.stubEnv('PHARMACY_WHATSAPP_ORGANIZATION_ID', 'org_1');
      vi.stubEnv('PHARMACY_WHATSAPP_TEMPLATE_OWNER_DIGEST', 'owner_digest_v1');
      const now = new Date('2026-09-04T08:00:00Z');
      const first = dueSetting(now);
      const second = { ...dueSetting(now), id: 'setting_2', userId: 'user_2' };
      mocks.platformDb.pharmacyOwnerDigestSetting.findMany.mockResolvedValue([first, second]);
      let firstReads = 0;
      mocks.tenantDb.pharmacyOwnerDigestSetting.findFirst.mockImplementation(async ({ where }) => {
        if (where.id === second.id) return second;
        firstReads += 1;
        if (failure === 'recheck' && firstReads === 4) throw new Error('private database error');
        return first;
      });
      mocks.tenantDb.pharmacyOwnerDigestCapture.findUnique.mockResolvedValue(null);
      mocks.tenantDb.pharmacyOwnerDigestCapture.findUniqueOrThrow.mockResolvedValue({
        id: 'capture',
      });
      mocks.tenantDb.pharmacyOwnerDigestCapture.createMany.mockResolvedValue({ count: 1 });
      if (failure === 'compose')
        mocks.readPharmacyOwnerCommandCentre.mockRejectedValueOnce(new Error('private SQL error'));
      if (failure === 'log')
        mocks.sendAndLog.mockRejectedValueOnce(new Error('private persistence error'));
      if (failure === 'provider') mocks.sendAndLog.mockResolvedValueOnce('FAILED');
      await expect(processDueOwnerDigests(now)).resolves.toEqual({
        due: 2,
        captured: failure === 'compose' ? 1 : 2,
        failed: 1,
      });
      expect(mocks.sendAndLog).toHaveBeenCalledWith(
        expect.objectContaining({ dedupeKey: 'owner-digest:user_2:branch_1:2026-09-04' }),
        expect.any(Function)
      );
    }
  );

  it.each(['disabled', 'revoked', 'opted out', 'phone changed', 'unchanged'])(
    'rechecks the WhatsApp recipient after capture commits: %s',
    async (change) => {
      vi.stubEnv('PHARMACY_WHATSAPP_PROVIDER', 'meta');
      vi.stubEnv('PHARMACY_WHATSAPP_ACCESS_TOKEN', 'token');
      vi.stubEnv('PHARMACY_WHATSAPP_PHONE_NUMBER_ID', 'sender');
      vi.stubEnv('PHARMACY_WHATSAPP_ORGANIZATION_ID', 'org_1');
      vi.stubEnv('PHARMACY_WHATSAPP_TEMPLATE_OWNER_DIGEST', 'owner_digest_v1');
      const now = new Date('2026-09-04T08:00:00.000Z');
      const setting = dueSetting(now);
      mocks.platformDb.pharmacyOwnerDigestSetting.findMany.mockResolvedValue([setting]);
      mocks.tenantDb.pharmacyOwnerDigestSetting.findFirst.mockResolvedValue(setting);
      mocks.tenantDb.pharmacyOwnerDigestCapture.findUnique.mockResolvedValue(null);
      mocks.tenantDb.pharmacyOwnerDigestCapture.findUniqueOrThrow.mockResolvedValue({
        id: 'capture_1',
      });
      mocks.tenantDb.pharmacyOwnerDigestCapture.createMany.mockImplementation(async () => {
        if (change === 'disabled') {
          mocks.tenantDb.pharmacyOwnerDigestSetting.findFirst.mockResolvedValue(null);
        } else if (change === 'revoked') {
          mocks.can.mockResolvedValue(false);
        } else if (change === 'opted out') {
          setting.whatsappPhoneHash = null;
        } else if (change === 'phone changed') {
          setting.user.phone = '0300 7654321';
        }
        return { count: 1 };
      });

      mocks.sendAndLog.mockImplementation(async () => {
        expect(mocks.activeTenantTransactions).toBe(0);
        return 'SENT';
      });
      await expect(processDueOwnerDigests(now)).resolves.toEqual({
        due: 1,
        captured: 1,
        failed: 0,
      });

      if (change !== 'unchanged') {
        expect(mocks.sendAndLog).not.toHaveBeenCalled();
      } else {
        expect(mocks.sendAndLog).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ phoneLast4: '4567' }),
          expect.any(Function)
        );
      }
    }
  );

  async function expectDeniedDigestDisabled() {
    const now = new Date('2026-09-04T08:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    mocks.platformDb.pharmacyOwnerDigestSetting.findMany.mockResolvedValue([
      {
        id: 'setting_1',
        organizationId: 'org_1',
        userId: 'user_1',
        branchId: 'branch_1',
        timeMinutes: 480,
        organization: { timezone: 'UTC' },
      },
    ]);
    mocks.tenantDb.pharmacyOwnerDigestSetting.findFirst.mockResolvedValue({
      id: 'setting_1',
      organizationId: 'org_1',
      userId: 'user_1',
      branchId: 'branch_1',
      enabled: true,
      nextDueAt: now,
      updatedAt: now,
      timeMinutes: 480,
      organization: { status: 'ACTIVE', vertical: 'PHARMACY', timezone: 'UTC' },
      branch: { name: 'Main', active: true, organizationId: 'org_1' },
      user: {
        id: 'user_1',
        organizationId: 'org_1',
        role: 'ADMIN',
        status: 'ACTIVE',
        department: 'Management',
      },
    });
    await expect(processDueOwnerDigests(now)).resolves.toEqual({ due: 1, captured: 0, failed: 0 });
    expect(mocks.readPharmacyOwnerCommandCentre).not.toHaveBeenCalled();
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
});
