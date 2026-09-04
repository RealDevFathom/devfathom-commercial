import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readPharmacyOwnerCommandCentre: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock('@/lib/pharmacy/reports', () => ({
  readPharmacyOwnerCommandCentre: mocks.readPharmacyOwnerCommandCentre,
}));

vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.withTenantDb }));

import {
  CaptureChannel,
  captureDailyOwnerDigests,
  composeDailyOwnerDigest,
  WhatsAppChannel,
} from './owner-digest';

const metrics = {
  salesMinor: 123400,
  marginMinor: 23400,
  refundsMinor: 500,
  cashVarianceMinor: -100,
  openStockSignals: 3,
  recommendedOrders: 2,
  expiryValueMinor30: 9000,
  expiryValueMinor60: 10000,
  expiryValueMinor90: 11000,
  expiryValueMinor180: 12000,
  openRecalls: 1,
  quarantineUnits: 4,
  openClaims: 0,
  openReceivingExceptions: 0,
  pharmacistCoverage: 1,
  safetyQueue: 2,
  accountsPayableMinor: null,
  accountsReceivableMinor: null,
  khataAgingMinor: null,
  deviceFiscalOfflineExceptions: null,
};

const digest = composeDailyOwnerDigest({
  organizationId: 'org_one',
  branchId: 'branch_one',
  branchName: 'Blue Area',
  businessDate: '2026-09-04',
  snapshot: {
    filters: { branchIds: ['branch_one'], from: '2026-09-04', to: '2026-09-04' },
    freshness: { status: 'CURRENT', asOf: '2026-09-04T03:00:00.000Z', source: 'ledger' },
    metrics,
  },
});

describe('daily owner digest', () => {
  it('renders only the RPT-01 metric snapshot with unavailable fiscal truth preserved', () => {
    expect(digest.rendered).toContain('Sales PKR 1234.00 · margin PKR 234.00');
    expect(digest.rendered).toContain('Stockouts/signals 3');
    expect(digest.rendered).toContain('Recalls 1 · quarantine 4 units · safety queue 2');
    expect(digest.rendered).toContain('Offline/fiscal Unavailable in RPT-01');
    expect(digest.metrics).toBe(metrics);
  });

  it('captures idempotently at the organization, branch, date, and channel boundary', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'digest_one' });
    await new CaptureChannel().deliver({ pharmacyOwnerDigest: { upsert } } as never, digest);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_branchId_businessDate_channel: {
            organizationId: 'org_one',
            branchId: 'branch_one',
            businessDate: '2026-09-04',
            channel: 'CAPTURE',
          },
        },
        update: {},
      })
    );
  });

  it('reads and captures each branch in one tenant transaction', async () => {
    const branchLookupDb = {
      pharmacyBranch: {
        findMany: vi.fn().mockResolvedValue([{ id: 'branch_one', name: 'Blue Area' }]),
      },
    };
    const upsert = vi.fn().mockResolvedValue({ id: 'digest_one' });
    const branchTransactionDb = { pharmacyOwnerDigest: { upsert } };
    mocks.withTenantDb
      .mockImplementationOnce(async (_organizationId, run) => run(branchLookupDb))
      .mockImplementationOnce(async (_organizationId, run) => run(branchTransactionDb));
    mocks.readPharmacyOwnerCommandCentre.mockResolvedValue({
      filters: { branchIds: ['branch_one'], from: '2026-09-04', to: '2026-09-04' },
      freshness: { status: 'CURRENT', asOf: '2026-09-04T03:00:00.000Z', source: 'ledger' },
      metrics,
    });

    await captureDailyOwnerDigests('org_one', '2026-09-04');

    expect(mocks.withTenantDb).toHaveBeenCalledTimes(2);
    expect(mocks.withTenantDb).toHaveBeenNthCalledWith(2, 'org_one', expect.any(Function));
    expect(mocks.readPharmacyOwnerCommandCentre).toHaveBeenCalledWith(branchTransactionDb, {
      branchIds: ['branch_one'],
      from: '2026-09-04',
      to: '2026-09-04',
    });
    expect(upsert).toHaveBeenCalledOnce();
  });

  it('never fabricates a WhatsApp send', async () => {
    await expect(new WhatsAppChannel().deliver({} as never, digest)).rejects.toThrow(
      /disabled|not implemented/
    );
  });
});
