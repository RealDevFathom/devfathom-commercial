import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ claimMessage: vi.fn().mockResolvedValue('message-a') }));
vi.mock('server-only', () => ({}));
vi.mock('./whatsapp/message-log', () => ({ claimMessageLogInTransaction: mocks.claimMessage }));

import {
  DEFAULT_SPEND_VOUCHER_TIERS,
  issueSpendVoucherForCompletedSale,
  qualifyingSpendVoucherTier,
  validateSpendVoucherTiers,
  voidUnredeemedSpendVoucherForRefund,
} from './spend-vouchers';

describe('spend-threshold voucher tiers', () => {
  it.each([
    [999_999, null],
    [1_000_000, 50_000],
    [1_999_900, 50_000],
    [2_000_000, 100_000],
  ])('selects the highest tier at %i paisa', (netPaidMinor, valueMinor) => {
    expect(qualifyingSpendVoucherTier(netPaidMinor, DEFAULT_SPEND_VOUCHER_TIERS)?.valueMinor ?? null)
      .toBe(valueMinor);
  });

  it('sorts valid owner edits and rejects duplicate thresholds', () => {
    expect(validateSpendVoucherTiers([
      { thresholdMinor: 2_000_000, valueMinor: 100_000 },
      { thresholdMinor: 1_000_000, valueMinor: 50_000 },
    ])).toEqual(DEFAULT_SPEND_VOUCHER_TIERS);
    expect(() => validateSpendVoucherTiers([
      { thresholdMinor: 1_000_000, valueMinor: 50_000 },
      { thresholdMinor: 1_000_000, valueMinor: 60_000 },
    ])).toThrow('INVALID_SPEND_VOUCHER_TIERS');
  });
});

describe('spend-threshold voucher transaction effects', () => {
  const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };
  const voucher = { id: 'voucher-a', code: 'ABCDEFGH2345', valueMinor: 50_000 };
  function db(options: { prior?: boolean; consent?: boolean } = {}) {
    return {
      pharmacyVoucher: {
        findFirst: vi.fn().mockResolvedValue(options.prior ? voucher : null),
        create: vi.fn().mockResolvedValue(voucher),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      pharmacySale: { findFirst: vi.fn().mockResolvedValue({
        id: 'sale-a', customerId: 'customer-a',
        tenders: [{ type: 'CASH', amountMinor: 1_000_000 }],
        customer: { id: 'customer-a', patientId: 'patient-a', phoneLast4: '1234',
          whatsappOptIn: options.consent === true, patient: { phone: '+923001234567' } },
      }) },
      pharmacyLoyaltySettings: { findUnique: vi.fn().mockResolvedValue(null) },
      patientConsent: { findFirst: vi.fn().mockResolvedValue(options.consent ?
        { granted: true, revokedAt: null } : null) },
    };
  }

  it('returns the original voucher without creating another on sale replay', async () => {
    const store = db({ prior: true });
    await expect(issueSpendVoucherForCompletedSale(store as never, scope, 'sale-a'))
      .resolves.toEqual({ voucher, replayed: true });
    expect(store.pharmacyVoucher.create).not.toHaveBeenCalled();
  });

  it('issues at the boundary and queues only for explicit current consent', async () => {
    mocks.claimMessage.mockClear();
    const store = db({ consent: true });
    await expect(issueSpendVoucherForCompletedSale(store as never, scope, 'sale-a'))
      .resolves.toMatchObject({ replayed: false, voucher });
    expect(store.patientConsent.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ purpose: 'LOYALTY', channel: 'WHATSAPP' }),
    }));
    expect(mocks.claimMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      kind: 'SPEND_VOUCHER', status: 'PENDING', dedupeKey: 'spend-voucher:sale-a',
    }));

    mocks.claimMessage.mockClear();
    await issueSpendVoucherForCompletedSale(db() as never, scope, 'sale-a');
    expect(mocks.claimMessage).not.toHaveBeenCalled();
  });

  it('voids only an issued voucher belonging to the refunded qualifying sale', async () => {
    const store = db();
    await voidUnredeemedSpendVoucherForRefund(store as never, scope, 'sale-a');
    expect(store.pharmacyVoucher.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', branchId: 'branch-a', issuedSaleId: 'sale-a', status: 'ISSUED' },
      data: { status: 'VOID' },
    });
  });
});
