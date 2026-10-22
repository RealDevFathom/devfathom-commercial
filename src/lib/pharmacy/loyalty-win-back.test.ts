import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const allow = vi.fn(async () => true);
vi.mock('@/lib/abac', () => ({ can: (...args: unknown[]) => allow(...args) }));
const issueVoucher = vi.fn(async (_store: unknown, input: { organizationId: string; branchId: string }) => ({
  id: `voucher-${input.organizationId}-${input.branchId}`,
}));
// Loyalty vouchers are a sibling feature. Win-back tests exercise only the contract at this seam.
vi.mock('./loyalty-vouchers', () => ({ issueVoucher: (...args: unknown[]) => issueVoucher(...args) }));

import {
  calculateWinBackPreview,
  changeWinBackRules,
  enableWinBack,
  generateWinBackPreview,
  processWinBackCampaigns,
  selectWinBackCustomers,
  tierForSpend,
  validateWinBackRules,
  MAX_MONEY_MINOR,
  type WinBackCustomer,
  type WinBackRules,
} from './loyalty-win-back';

const NOW = new Date('2026-10-22T00:00:00.000Z');
const rules: WinBackRules = {
  inactivityDays: 45,
  windowDays: 30,
  minimumSpendMinor: 50_000,
  minNextBasketMinor: 100_000,
  defaultMarginBasisPoints: 1450,
  redemptionBasisPoints: 2500,
  tiers: [
    { minimumSpendMinor: 50_000, maximumSpendMinor: 199_999, voucherValueMinor: 20_000 },
    { minimumSpendMinor: 200_000, maximumSpendMinor: null, voucherValueMinor: 100_000 },
  ],
  categoryMargins: { beauty: 2000 },
};
const customer = (overrides: Partial<WinBackCustomer> = {}): WinBackCustomer => ({
  customerId: 'customer-1', branchId: 'branch-1', phone: '+923001234567',
  lastSaleAt: new Date('2026-08-01T00:00:00.000Z'), pastSpendMinor: 100_000,
  expectedBasketMinor: 200_000, primaryCategoryId: 'beauty', active: true,
  whatsappOptIn: true, loyaltyConsentGranted: true, ...overrides,
});

describe('win-back rules', () => {
  beforeEach(() => {
    allow.mockReset();
    allow.mockResolvedValue(true);
    issueVoucher.mockClear();
  });

  it('selects only inactive customers meeting spend, consent, opt-in, and active gates', () => {
    const rows = [customer(), customer({ customerId: 'recent', lastSaleAt: new Date('2026-10-01') }),
      customer({ customerId: 'low', pastSpendMinor: 49_999 }),
      customer({ customerId: 'optout', whatsappOptIn: false }),
      customer({ customerId: 'no-consent', loyaltyConsentGranted: false })];
    expect(selectWinBackCustomers(rows, rules, NOW).map((row) => row.customerId)).toEqual(['customer-1']);
  });

  it('uses inclusive, editable spend tiers with rupee values stored in paisa', () => {
    expect(tierForSpend(rules.tiers, 199_999)?.voucherValueMinor).toBe(20_000);
    expect(tierForSpend(rules.tiers, 200_000)?.voucherValueMinor).toBe(100_000);
  });

  it('calculates liability, expected redemption cost, category margin, and net impact in integers', () => {
    const preview = calculateWinBackPreview([
      customer(), customer({ customerId: 'customer-2', primaryCategoryId: null }),
      customer({ customerId: 'customer-3', primaryCategoryId: null }),
      customer({ customerId: 'customer-4', primaryCategoryId: null }),
    ], rules, NOW);
    expect(preview).toMatchObject({ eligibleCustomerCount: 4, totalVoucherLiabilityMinor: 80_000,
      expectedRedemptions: 1, expectedVoucherCostMinor: 20_000,
      expectedMarginMinor: 31_750, netMarginImpactMinor: 11_750 });
  });

  it('requires an owner-generated preview matching the current settings hash before enable', async () => {
    const store = {
      authorizationDb: {} as never, readRules: vi.fn(async () => rules),
      enableAndAuditIfPreviewCurrent: vi.fn(async () => false),
      saveRulesAndAudit: vi.fn(), readCandidates: vi.fn(), savePreview: vi.fn(),
    };
    await expect(enableWinBack(store, { organizationId: 'org-1', subject: { id: 'owner', role: 'OWNER' },
      previewId: 'preview-1', now: NOW })).rejects.toMatchObject({ reason: 'PREVIEW_REQUIRED' });
    expect(store.enableAndAuditIfPreviewCurrent).toHaveBeenCalledWith(expect.objectContaining({
      previewId: 'preview-1', expectedSettingsHash: expect.any(String),
    }));
  });

  it('rejects values that cannot be represented by database INTEGER money columns', () => {
    expect(() => validateWinBackRules({ ...rules, minimumSpendMinor: MAX_MONEY_MINOR + 1 }))
      .toThrow(expect.objectContaining({ reason: 'INVALID_RULES' }));
    expect(() => selectWinBackCustomers([customer({ expectedBasketMinor: MAX_MONEY_MINOR + 1 })], rules, NOW))
      .toThrow(expect.objectContaining({ reason: 'INVALID_CANDIDATE' }));
  });

  it.each([
    ['fractional minimum spend', { minimumSpendMinor: 50_000.5 }],
    ['negative minimum basket', { minNextBasketMinor: -1 }],
    ['fractional voucher value', { tiers: [
      { minimumSpendMinor: 50_000, maximumSpendMinor: null, voucherValueMinor: 20_000.5 },
    ] }],
  ])('rejects %s rather than rounding persisted paisa', (_label, override) => {
    expect(() => validateWinBackRules({ ...rules, ...override }))
      .toThrow(expect.objectContaining({ reason: 'INVALID_RULES' }));
  });

  it('never accepts a negative customer spend balance', () => {
    expect(() => selectWinBackCustomers([customer({ pastSpendMinor: -1 })], rules, NOW))
      .toThrow(expect.objectContaining({ reason: 'INVALID_CANDIDATE' }));
    expect(() => tierForSpend(rules.tiers, -1)).toThrow('INVALID_MONEY');
  });

  it('keeps every preview money field in integer paisa, including a negative net impact', () => {
    const preview = calculateWinBackPreview([customer({ expectedBasketMinor: 50_001 })], {
      ...rules, redemptionBasisPoints: 3_333,
    }, NOW);
    for (const value of [preview.totalVoucherLiabilityMinor, preview.expectedVoucherCostMinor,
      preview.expectedMarginMinor, preview.netMarginImpactMinor]) expect(Number.isInteger(value)).toBe(true);
    expect(preview.netMarginImpactMinor).toBeLessThan(0);
  });

  it('routes owner changes through central can and writes old/new audit state with tenant and actor', async () => {
    const oldRules = { ...rules, inactivityDays: 60 };
    const saveRulesAndAudit = vi.fn().mockResolvedValue(undefined);
    const store = { authorizationDb: {} as never, readRules: vi.fn().mockResolvedValue(oldRules),
      saveRulesAndAudit, readCandidates: vi.fn(), savePreview: vi.fn(),
      enableAndAuditIfPreviewCurrent: vi.fn() };
    const subject = { id: 'owner-1', role: 'OWNER' as const };
    await changeWinBackRules(store, { organizationId: 'org-a', subject, rules, now: NOW });
    expect(allow).toHaveBeenCalledWith(subject, 'pharmacy:loyalty-manage', undefined,
      { db: store.authorizationDb, now: NOW });
    expect(saveRulesAndAudit).toHaveBeenCalledWith({ organizationId: 'org-a', actorId: 'owner-1',
      oldValue: oldRules, newValue: rules });
  });

  it('honours central can DENY even for an owner and creates no audit entry', async () => {
    allow.mockResolvedValue(false);
    const saveRulesAndAudit = vi.fn();
    const store = { authorizationDb: {} as never, readRules: vi.fn(), saveRulesAndAudit,
      readCandidates: vi.fn(), savePreview: vi.fn(), enableAndAuditIfPreviewCurrent: vi.fn() };
    await expect(changeWinBackRules(store, { organizationId: 'org-a',
      subject: { id: 'owner-1', role: 'OWNER' }, rules, now: NOW }))
      .rejects.toMatchObject({ reason: 'FORBIDDEN' });
    expect(store.readRules).not.toHaveBeenCalled();
    expect(saveRulesAndAudit).not.toHaveBeenCalled();
  });

  it('records preview and enable audit contracts with the same tenant and actor', async () => {
    const savePreview = vi.fn().mockResolvedValue(undefined);
    const enableAndAuditIfPreviewCurrent = vi.fn().mockResolvedValue(true);
    const store = { authorizationDb: {} as never, readRules: vi.fn().mockResolvedValue(rules),
      readCandidates: vi.fn().mockResolvedValue([customer()]), saveRulesAndAudit: vi.fn(),
      savePreview, enableAndAuditIfPreviewCurrent };
    const subject = { id: 'owner-1', role: 'OWNER' as const };
    const preview = await generateWinBackPreview(store, { organizationId: 'org-a', subject, now: NOW });
    expect(savePreview).toHaveBeenCalledWith(expect.objectContaining({ id: preview.id,
      organizationId: 'org-a', actorId: 'owner-1', generatedAt: NOW }));
    await enableWinBack(store, { organizationId: 'org-a', subject, previewId: preview.id, now: NOW });
    expect(enableAndAuditIfPreviewCurrent).toHaveBeenCalledWith({ organizationId: 'org-a',
      actorId: 'owner-1', previewId: preview.id, expectedSettingsHash: preview.settingsHash });
  });

  it('makes preview enablement depend on the adapter atomic lock-and-recheck result', async () => {
    const enableAndAuditIfPreviewCurrent = vi.fn(async () => false);
    const store = {
      authorizationDb: {} as never, readRules: vi.fn(async () => rules), enableAndAuditIfPreviewCurrent,
      saveRulesAndAudit: vi.fn(), readCandidates: vi.fn(), savePreview: vi.fn(),
    };
    await expect(enableWinBack(store, { organizationId: 'org-1', subject: { id: 'owner', role: 'OWNER' },
      previewId: 'preview-1', now: NOW })).rejects.toMatchObject({ reason: 'PREVIEW_REQUIRED' });
    expect(enableAndAuditIfPreviewCurrent).toHaveBeenCalledTimes(1);
  });
});

describe('win-back scheduled job', () => {
  beforeEach(() => {
    allow.mockReset();
    allow.mockResolvedValue(true);
    issueVoucher.mockClear();
  });

  it('issues once per campaign window through voucher service and respects opt-out', async () => {
    const claims = new Set<string>(); const inserted: string[] = []; const messages: string[] = [];
    const campaign = { organizationId: 'org-1', rules, enabledPreviewId: 'preview-1', enabledPreviewHash: '' };
    const { winBackRulesHash } = await import('./loyalty-win-back');
    campaign.enabledPreviewHash = winBackRulesHash(rules);
    const store = {
      listEnabledCampaigns: async () => [campaign],
      authorizationDb: () => ({} as never),
      readCandidates: async () => [customer(), customer({ customerId: 'optout', whatsappOptIn: false })],
      transaction: async (_organizationId: string, operation: (tx: any) => Promise<unknown>) => operation({
        lockCandidate: async () => customer(),
        vouchers: {} as never,
        claimIssuance: async ({ customerId, campaignWindowStart }: any) => {
          const key = `${customerId}:${campaignWindowStart.toISOString()}`;
          if (claims.has(key)) return false; claims.add(key); return true;
        },
        attachVoucher: async ({ voucherId }: { voucherId: string }) => { inserted.push(voucherId); },
        enqueueTransactionalMessage: async ({ dedupeKey }: any) => { messages.push(dedupeKey); },
      }),
    };
    await expect(processWinBackCampaigns(store, { subject: { id: 'job', role: 'OWNER' }, now: NOW })).resolves.toMatchObject({ issued: 1 });
    await expect(processWinBackCampaigns(store, { subject: { id: 'job', role: 'OWNER' }, now: NOW })).resolves.toMatchObject({ issued: 0, duplicates: 1 });
    expect(inserted).toHaveLength(1);
    expect(messages).toHaveLength(1);
  });

  it('has exactly one winner when two jobs race for the same tenant campaign window', async () => {
    const { winBackRulesHash } = await import('./loyalty-win-back');
    let claimed = false;
    let arrivals = 0;
    let release!: () => void;
    const bothAtClaim = new Promise<void>((resolve) => { release = resolve; });
    const attachVoucher = vi.fn().mockResolvedValue(undefined);
    const store = {
      listEnabledCampaigns: async () => [{ organizationId: 'org-a', rules,
        enabledPreviewId: 'preview-1', enabledPreviewHash: winBackRulesHash(rules) }],
      authorizationDb: () => ({} as never), readCandidates: async () => [customer()],
      transaction: async (organizationId: string, operation: (tx: any) => Promise<unknown>) => operation({
        lockCandidate: async () => customer(), vouchers: {} as never,
        claimIssuance: async () => {
          arrivals += 1;
          if (arrivals === 2) release();
          await bothAtClaim;
          if (claimed) return false;
          claimed = true;
          return organizationId === 'org-a';
        },
        attachVoucher, enqueueTransactionalMessage: vi.fn().mockResolvedValue(undefined),
      }),
    };
    const outcomes = await Promise.all([
      processWinBackCampaigns(store, { subject: { id: 'job', role: 'OWNER' }, now: NOW }),
      processWinBackCampaigns(store, { subject: { id: 'job', role: 'OWNER' }, now: NOW }),
    ]);
    expect(outcomes.reduce((sum, outcome) => sum + outcome.issued, 0)).toBe(1);
    expect(outcomes.reduce((sum, outcome) => sum + outcome.duplicates, 0)).toBe(1);
    expect(issueVoucher).toHaveBeenCalledTimes(1);
    expect(attachVoucher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['refund', { pastSpendMinor: 49_999 }],
    ['void', { pastSpendMinor: 49_999 }],
  ])('rechecks the locked candidate after a %s reversal before issuing', async (_kind, reversal) => {
    const { winBackRulesHash } = await import('./loyalty-win-back');
    const claimIssuance = vi.fn();
    const store = {
      listEnabledCampaigns: async () => [{ organizationId: 'org-a', rules,
        enabledPreviewId: 'preview-1', enabledPreviewHash: winBackRulesHash(rules) }],
      authorizationDb: () => ({} as never), readCandidates: async () => [customer()],
      transaction: async (organizationId: string, operation: (tx: any) => Promise<unknown>) => operation({
        lockCandidate: async () => organizationId === 'org-a' ? customer(reversal) : null,
        vouchers: {} as never, claimIssuance, attachVoucher: vi.fn(),
        enqueueTransactionalMessage: vi.fn(),
      }),
    };
    await expect(processWinBackCampaigns(store, {
      subject: { id: 'job', role: 'OWNER' }, now: NOW,
    })).resolves.toMatchObject({ issued: 0, duplicates: 1 });
    expect(claimIssuance).not.toHaveBeenCalled();
    expect(issueVoucher).not.toHaveBeenCalled();
  });

  it('keeps campaign reads, transactions, voucher issuance, and outbox writes tenant-scoped', async () => {
    const { winBackRulesHash } = await import('./loyalty-win-back');
    const observed: string[] = [];
    const store = {
      listEnabledCampaigns: async () => [{ organizationId: 'org-a', rules,
        enabledPreviewId: 'preview-1', enabledPreviewHash: winBackRulesHash(rules) }],
      authorizationDb: (organizationId: string) => { observed.push(`auth:${organizationId}`); return {} as never; },
      readCandidates: async (organizationId: string) => { observed.push(`read:${organizationId}`); return [customer()]; },
      transaction: async (organizationId: string, operation: (tx: any) => Promise<unknown>) => {
        observed.push(`tx:${organizationId}`);
        return operation({ lockCandidate: async () => customer(), vouchers: {} as never,
          claimIssuance: async () => true,
          attachVoucher: async () => { observed.push(`attach:${organizationId}`); },
          enqueueTransactionalMessage: async () => { observed.push(`outbox:${organizationId}`); } });
      },
    };
    await processWinBackCampaigns(store, { subject: { id: 'job', role: 'OWNER' }, now: NOW });
    expect(observed).toEqual(['auth:org-a', 'read:org-a', 'tx:org-a', 'attach:org-a', 'outbox:org-a']);
    expect(issueVoucher).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ organizationId: 'org-a', branchId: 'branch-1' }));
  });

  it('denies the scheduled mutation before opening a transaction when central can denies', async () => {
    allow.mockResolvedValueOnce(false);
    const transaction = vi.fn();
    const store = {
      listEnabledCampaigns: async () => [{ organizationId: 'org-1', rules,
        enabledPreviewId: 'preview-1', enabledPreviewHash: 'unused' }],
      authorizationDb: () => ({} as never), readCandidates: vi.fn(), transaction,
    };
    await expect(processWinBackCampaigns(store, {
      subject: { id: 'job', role: 'OWNER' }, now: NOW,
    })).rejects.toMatchObject({ reason: 'FORBIDDEN' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rechecks consent and branch under the issuance transaction lock', async () => {
    const { winBackRulesHash } = await import('./loyalty-win-back');
    const insertVoucher = vi.fn();
    const claimIssuance = vi.fn();
    const store = {
      listEnabledCampaigns: async () => [{ organizationId: 'org-1', rules,
        enabledPreviewId: 'preview-1', enabledPreviewHash: winBackRulesHash(rules) }],
      authorizationDb: () => ({} as never), readCandidates: async () => [customer()],
      transaction: async (_organizationId: string, operation: (tx: any) => Promise<unknown>) => operation({
        lockCandidate: async () => customer({ loyaltyConsentGranted: false }),
        claimIssuance, attachVoucher: vi.fn(), enqueueTransactionalMessage: vi.fn(),
        vouchers: { countActivity: vi.fn(), insertVoucher },
      }),
    };
    await expect(processWinBackCampaigns(store, {
      subject: { id: 'job', role: 'OWNER' }, now: NOW,
    })).resolves.toMatchObject({ issued: 0, duplicates: 1 });
    expect(claimIssuance).not.toHaveBeenCalled();
    expect(insertVoucher).not.toHaveBeenCalled();
  });

});
