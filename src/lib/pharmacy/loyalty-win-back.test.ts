import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const allow = vi.fn(async () => true);
vi.mock('@/lib/abac', () => ({ can: (...args: unknown[]) => allow(...args) }));

import {
  calculateWinBackPreview,
  enableWinBack,
  processWinBackCampaigns,
  selectWinBackCustomers,
  tierForSpend,
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
  beforeEach(() => allow.mockResolvedValue(true));

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
      readPreview: vi.fn(async () => ({ id: 'preview-1', settingsHash: 'stale' })),
      enableAndAudit: vi.fn(), saveRulesAndAudit: vi.fn(), readCandidates: vi.fn(), savePreview: vi.fn(),
    };
    await expect(enableWinBack(store, { organizationId: 'org-1', subject: { id: 'owner', role: 'OWNER' },
      previewId: 'preview-1', now: NOW })).rejects.toMatchObject({ reason: 'PREVIEW_REQUIRED' });
    expect(store.enableAndAudit).not.toHaveBeenCalled();
  });
});

describe('win-back scheduled job', () => {
  it('issues once per campaign window through voucher service and respects opt-out', async () => {
    const claims = new Set<string>(); const inserted: string[] = []; const messages: string[] = [];
    const campaign = { organizationId: 'org-1', rules, enabledPreviewId: 'preview-1', enabledPreviewHash: '' };
    const { winBackRulesHash } = await import('./loyalty-win-back');
    campaign.enabledPreviewHash = winBackRulesHash(rules);
    const store = {
      listEnabledCampaigns: async () => [campaign],
      readCandidates: async () => [customer(), customer({ customerId: 'optout', whatsappOptIn: false })],
      transaction: async (_organizationId: string, operation: (tx: any) => Promise<unknown>) => operation({
        vouchers: {
          countActivity: async () => ({ customer: 0, phone: 0 }),
          insertVoucher: async (row: { id: string }) => { inserted.push(row.id); },
        },
        claimIssuance: async ({ customerId, campaignWindowStart }: any) => {
          const key = `${customerId}:${campaignWindowStart.toISOString()}`;
          if (claims.has(key)) return false; claims.add(key); return true;
        },
        attachVoucher: async () => undefined,
        enqueueTransactionalMessage: async ({ dedupeKey }: any) => { messages.push(dedupeKey); },
      }),
    };
    await expect(processWinBackCampaigns(store, { now: NOW })).resolves.toMatchObject({ issued: 1 });
    await expect(processWinBackCampaigns(store, { now: NOW })).resolves.toMatchObject({ issued: 0, duplicates: 1 });
    expect(inserted).toHaveLength(1);
    expect(messages).toHaveLength(1);
  });
});
