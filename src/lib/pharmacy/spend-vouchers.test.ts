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

  it.each([
    null,
    [],
    [{ thresholdMinor: 1, valueMinor: 1, injected: true }],
    [{ thresholdMinor: 1.5, valueMinor: 1 }],
    [{ thresholdMinor: 1, valueMinor: 2_147_483_648 }],
    [{ thresholdMinor: 1, valueMinor: Number.MAX_SAFE_INTEGER + 1 }],
  ])('rejects malformed or unsafe persisted tier JSON %#', (tiers) => {
    expect(() => validateSpendVoucherTiers(tiers)).toThrow('INVALID_SPEND_VOUCHER_TIERS');
  });
});

describe('spend-threshold voucher transaction effects', () => {
  const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };
  const voucher = { id: 'voucher-a', code: 'ABCDEFGH2345', valueMinor: 50_000 };
  function db(options: {
    prior?: boolean;
    consent?: boolean;
    consentRecordedAt?: Date;
    tenders?: Array<{ type: string; amountMinor: number }>;
    createError?: Error;
  } = {}) {
    return {
      pharmacyVoucher: {
        findFirst: vi.fn().mockResolvedValue(options.prior ? voucher : null),
        create: options.createError ? vi.fn().mockRejectedValue(options.createError) :
          vi.fn().mockResolvedValue(voucher),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      pharmacySale: { findFirst: vi.fn().mockResolvedValue({
        id: 'sale-a', customerId: 'customer-a',
        tenders: options.tenders ?? [{ type: 'CASH', amountMinor: 1_000_000 }],
        customer: { id: 'customer-a', patientId: 'patient-a', phoneLast4: '1234',
          whatsappOptIn: options.consent === true, patient: { phone: '+923001234567' } },
      }) },
      pharmacyLoyaltySettings: { findUnique: vi.fn().mockResolvedValue(null) },
      patientConsent: { findFirst: vi.fn().mockImplementation(({ where }) => {
        if (!options.consent || (options.consentRecordedAt &&
          options.consentRecordedAt > where.recordedAt.lte)) return null;
        return { granted: true, revokedAt: null };
      }) },
    };
  }

  it('returns the original voucher without creating another on sale replay', async () => {
    const store = db({ prior: true });
    await expect(issueSpendVoucherForCompletedSale(store as never, scope, 'sale-a'))
      .resolves.toEqual({ voucher, replayed: true });
    expect(store.pharmacyVoucher.create).not.toHaveBeenCalled();
    expect(store.pharmacyVoucher.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', branchId: 'branch-a', issuedSaleId: 'sale-a' },
    });
  });

  it('issues at the boundary and queues only for explicit current consent', async () => {
    mocks.claimMessage.mockClear();
    const store = db({ consent: true });
    await expect(issueSpendVoucherForCompletedSale(store as never, scope, 'sale-a'))
      .resolves.toMatchObject({ replayed: false, voucher });
    expect(store.pharmacySale.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'sale-a', organizationId: 'org-a', branchId: 'branch-a' },
    }));
    expect(store.pharmacyLoyaltySettings.findUnique).toHaveBeenCalledWith({
      where: { organizationId: 'org-a' },
    });
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

  it('does not use consent recorded after the voucher transaction time', async () => {
    mocks.claimMessage.mockClear();
    const issuedAt = new Date('2026-10-22T12:00:00.000Z');
    await issueSpendVoucherForCompletedSale(db({
      consent: true,
      consentRecordedAt: new Date('2026-10-22T12:00:01.000Z'),
    }) as never, scope, 'sale-a', issuedAt);
    expect(mocks.claimMessage).not.toHaveBeenCalled();
  });

  it('counts mixed paid tenders after discounts but excludes loyalty value', async () => {
    const store = db({ tenders: [
      { type: 'CASH', amountMinor: 600_000 },
      { type: 'CARD', amountMinor: 400_000 },
      { type: 'LOYALTY', amountMinor: 900_000 },
    ] });
    await issueSpendVoucherForCompletedSale(store as never, scope, 'sale-a');
    expect(store.pharmacyVoucher.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        organizationId: 'org-a', branchId: 'branch-a', valueMinor: 50_000,
        issuedByActorId: 'cashier-a', issuedSaleId: 'sale-a',
      }),
    }));
  });

  it('fails closed when persisted tender totals overflow safe integer money', async () => {
    const store = db({ tenders: [
      { type: 'CASH', amountMinor: Number.MAX_SAFE_INTEGER },
      { type: 'CARD', amountMinor: 1 },
    ] });
    await expect(issueSpendVoucherForCompletedSale(store as never, scope, 'sale-a'))
      .rejects.toThrow('INVALID_MONEY');
    expect(store.pharmacyVoucher.create).not.toHaveBeenCalled();
  });

  it('classifies issued-sale races without treating unrelated unique errors as replay', async () => {
    const issuedSaleRace = Object.assign(new Error('unique'), {
      code: 'P2002', meta: { target: 'pharmacy_vouchers_issued_sale_key' },
    });
    const store = db({ createError: issuedSaleRace });
    store.pharmacyVoucher.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(voucher);
    await expect(issueSpendVoucherForCompletedSale(store as never, scope, 'sale-a'))
      .resolves.toEqual({ voucher, replayed: true });

    const unrelated = Object.assign(new Error('unique'), {
      code: 'P2002', meta: { target: 'some_other_constraint' },
    });
    await expect(issueSpendVoucherForCompletedSale(
      db({ createError: unrelated }) as never, scope, 'sale-a'
    )).rejects.toBe(unrelated);

    const crossBranch = db({ createError: issuedSaleRace });
    await expect(issueSpendVoucherForCompletedSale(crossBranch as never, scope, 'sale-a'))
      .rejects.toThrow('VOUCHER_ISSUED_SALE_SCOPE_CONFLICT');
  });

  it('voids only an issued voucher belonging to the refunded qualifying sale', async () => {
    const store = db();
    await voidUnredeemedSpendVoucherForRefund(store as never, scope, 'sale-a');
    expect(store.pharmacyVoucher.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', branchId: 'branch-a', issuedSaleId: 'sale-a', status: 'ISSUED' },
      data: { status: 'VOID' },
    });
  });

  it('makes refund/void reversal idempotent without touching redeemed or foreign vouchers', async () => {
    const store = db();
    store.pharmacyVoucher.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    await expect(voidUnredeemedSpendVoucherForRefund(store as never, scope, 'sale-a'))
      .resolves.toEqual({ count: 1 });
    await expect(voidUnredeemedSpendVoucherForRefund(store as never, scope, 'sale-a'))
      .resolves.toEqual({ count: 0 });
    expect(store.pharmacyVoucher.updateMany).toHaveBeenNthCalledWith(2, {
      where: { organizationId: 'org-a', branchId: 'branch-a', issuedSaleId: 'sale-a', status: 'ISSUED' },
      data: { status: 'VOID' },
    });
  });
});
