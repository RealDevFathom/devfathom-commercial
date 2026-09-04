import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readPharmacyOwnerCommandCentre } = vi.hoisted(() => ({
  readPharmacyOwnerCommandCentre: vi.fn(),
}));
vi.mock('./reports', () => ({
  readPharmacyOwnerCommandCentre,
  PHARMACY_METRIC_CONTRACT: [
    'salesMinor',
    'marginMinor',
    'cashMinor',
    'refundsMinor',
    'openStockSignals',
    'expiryValueMinor30',
    'openRecalls',
    'quarantineUnits',
    'safetyQueue',
    'deviceFiscalOfflineExceptions',
  ].map((key) => ({ key, label: key, definition: `${key} definition`, source: `${key} source` })),
}));

import { CaptureChannel, composeOwnerDigest, WhatsAppChannel } from './owner-digest';

describe('RPT-03 owner digest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readPharmacyOwnerCommandCentre.mockResolvedValue({
      freshness: { status: 'CURRENT', asOf: '2026-09-04T08:00:00.000Z', source: 'ledgers' },
      metrics: {
        salesMinor: 10000,
        marginMinor: 2500,
        cashMinor: 6000,
        refundsMinor: 500,
        openStockSignals: 3,
        expiryValueMinor30: 700,
        openRecalls: 1,
        quarantineUnits: 2,
        safetyQueue: 4,
        deviceFiscalOfflineExceptions: null,
      },
    });
  });

  it('composes one branch-day by calling the RPT-01 reader and retaining its contracts', async () => {
    const digest = await composeOwnerDigest({} as never, {
      organizationId: 'org_1',
      userId: 'user_1',
      branchId: 'branch_1',
      branchName: 'Main',
      businessDate: '2026-09-04',
    });

    expect(readPharmacyOwnerCommandCentre).toHaveBeenCalledWith(expect.anything(), {
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
      'openRecalls',
      'quarantineUnits',
      'safetyQueue',
      'deviceFiscalOfflineExceptions',
    ]);
    expect(digest.rendered).toContain('cashMinor: PKR 60.00');
    expect(digest.rendered).not.toContain('cashVarianceMinor');
    expect(digest.rendered).toContain('deviceFiscalOfflineExceptions: Not available');
  });

  it('persists capture delivery with the daily idempotency key', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'capture_1' });
    const digest = await composeOwnerDigest({} as never, {
      organizationId: 'org_1',
      userId: 'user_1',
      branchId: 'branch_1',
      branchName: 'Main',
      businessDate: '2026-09-04',
    });

    await expect(
      new CaptureChannel().deliver({ pharmacyOwnerDigestCapture: { upsert } } as never, digest)
    ).resolves.toEqual({ delivered: true, reference: 'capture_1' });
    expect(upsert).toHaveBeenCalledWith(
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
});
