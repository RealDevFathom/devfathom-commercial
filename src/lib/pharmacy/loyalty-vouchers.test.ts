import { describe, expect, it, vi } from 'vitest';

import {
  generateVoucherCode, issueVoucher, PharmacyVoucherError, publicVoucherResult,
  redeemVoucher, VOUCHER_ALPHABET, voucherEligibleMinor, voucherRedemptionMinor,
  updateLoyaltySettings, type VoucherRedemptionStore,
} from './loyalty-vouchers';

function store(overrides: Partial<VoucherRedemptionStore> = {}): VoucherRedemptionStore {
  return {
    insertVoucher: vi.fn().mockResolvedValue(undefined),
    countActivity: vi.fn().mockResolvedValue({ customer: 0, phone: 0 }),
    lockVoucher: vi.fn().mockResolvedValue({
      id: 'v1', organizationId: 'org-a', branchId: 'b1', status: 'ISSUED', valueMinor: 1_000,
      scope: 'WHOLE_BASKET', customerId: 'c1', phone: '+923001234567',
      expiresAt: new Date('2026-12-01'), minNextBasketMinor: 500, redeemedSaleId: null,
    }),
    saleVoucherCount: vi.fn().mockResolvedValue(0),
    saleLines: vi.fn().mockResolvedValue([
      { quantity: 1, unitPriceMinor: 800, discountMinor: 0, rx: true, otc: false },
      { quantity: 1, unitPriceMinor: 700, discountMinor: 0, rx: false, otc: false },
    ]),
    markRedeemed: vi.fn().mockResolvedValue(true),
    createLoyaltyTender: vi.fn().mockResolvedValue({ tenderId: 't1' }),
    writeOverrideAudit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('pharmacy voucher codes', () => {
  it('uses the CSPRNG seam, has at least ten characters, and excludes ambiguous symbols', () => {
    const pick = vi.fn((max: number) => max - 1);
    const code = generateVoucherCode(10, pick);
    expect(code).toHaveLength(10);
    expect(code).toMatch(/^[2-9A-HJ-KM-NP-Z]+$/);
    expect([...code].every((character) => VOUCHER_ALPHABET.includes(character))).toBe(true);
    expect(pick).toHaveBeenCalledTimes(10);
  });

  it('retries an organization-unique collision', async () => {
    const db = store();
    vi.mocked(db.insertVoucher).mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    const result = await issueVoucher(db, {
      organizationId: 'org-a', branchId: 'b1', valueMinor: 500, actorId: 'owner',
    }, vi.fn().mockReturnValueOnce('2222222222').mockReturnValueOnce('3333333333'));
    expect(result.code).toBe('3333333333');
    expect(db.insertVoucher).toHaveBeenCalledTimes(2);
    expect(result.scope).toBe('WHOLE_BASKET');
    expect(result.expiresAt.getTime() - result.issuedAt.getTime()).toBe(30 * 86_400_000);
  });

  it('enforces issue abuse limits independently for customer and phone', async () => {
    const db = store({ countActivity: vi.fn().mockResolvedValue({ customer: 0, phone: 5 }) });
    await expect(issueVoucher(db, { organizationId: 'org-a', branchId: 'b1', valueMinor: 1,
      phone: 'x', actorId: 'a' })).rejects.toMatchObject({ reason: 'ABUSE_LIMIT' });
  });
});

describe('voucher eligibility and privacy', () => {
  const lines = [
    { quantity: 1, unitPriceMinor: 800, discountMinor: 100, rx: true, otc: false },
    { quantity: 2, unitPriceMinor: 500, discountMinor: 100, rx: false, otc: false },
  ];
  it('defaults issuance to whole basket and caps redemption at the eligible subtotal', () => {
    expect(voucherRedemptionMinor({ valueMinor: 2_000, minNextBasketMinor: 0,
      scope: 'WHOLE_BASKET', lines })).toBe(1_600);
  });
  it('excludes catalogue-classified Rx and OTC lines only in the owner option', () => {
    expect(voucherEligibleMinor('NON_DRUG_ONLY', lines)).toBe(900);
  });
  it.each([null, { status: 'EXPIRED', expiresAt: new Date('2026-01-01') },
    { status: 'REDEEMED', expiresAt: new Date('2027-01-01') }])('gives no enumeration hint', (voucher) => {
    expect(() => publicVoucherResult(voucher as never, new Date('2026-06-01')))
      .toThrow(new PharmacyVoucherError('VOUCHER_NOT_FOUND'));
  });
});

describe('owner settings', () => {
  it('requires authorization and writes a complete old/new audit atomically', async () => {
    const oldValue = { voucherScope: 'WHOLE_BASKET' as const, voucherValidityDays: 30,
      maxIssuedPerCustomerPerPeriod: 5, maxIssuedPerPhonePerPeriod: 5,
      maxRedeemedPerCustomerPerPeriod: 5, maxRedeemedPerPhonePerPeriod: 5,
      abusePeriodDays: 30, expiryOverrideGraceDays: 0 };
    const next = { ...oldValue, voucherScope: 'NON_DRUG_ONLY' as const };
    const settingsStore = { readSettings: vi.fn().mockResolvedValue(oldValue),
      updateSettingsAndAudit: vi.fn().mockResolvedValue(next) };
    await updateLoyaltySettings(settingsStore, { organizationId: 'org-a', actorId: 'owner',
      authorized: true, settings: next });
    expect(settingsStore.updateSettingsAndAudit).toHaveBeenCalledWith({ organizationId: 'org-a',
      actorId: 'owner', oldValue, newValue: next });
    await expect(updateLoyaltySettings(settingsStore, { organizationId: 'org-a', actorId: 'cashier',
      authorized: false, settings: oldValue })).rejects.toMatchObject({ reason: 'OVERRIDE_REQUIRED' });
  });
});

describe('transactional redemption', () => {
  const input = { organizationId: 'org-a', branchId: 'b1', saleId: 's1', code: 'CODE234567',
    actorId: 'cashier', deviceId: 'd1', businessDate: new Date('2026-10-22'),
    idempotencyKey: 'checkout-1', now: new Date('2026-10-22') };

  it('redeems whole-basket by default through one LOYALTY tender', async () => {
    const db = store();
    await expect(redeemVoucher(db, input)).resolves.toMatchObject({ amountMinor: 1_000, scope: 'WHOLE_BASKET' });
    expect(db.markRedeemed).toHaveBeenCalledBefore(vi.mocked(db.createLoyaltyTender));
  });
  it('makes a double-redeem race have exactly one winner via conditional status update', async () => {
    const db = store({ markRedeemed: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) });
    const outcomes = await Promise.allSettled([redeemVoucher(db, input), redeemVoucher(db, { ...input, saleId: 's2' })]);
    expect(outcomes.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  });
  it('blocks stacking and one-per-visit/sale', async () => {
    const db = store({ saleVoucherCount: vi.fn().mockResolvedValue(1) });
    await expect(redeemVoucher(db, input)).rejects.toMatchObject({ reason: 'ALREADY_HAS_VOUCHER' });
  });
  it('requires an authorized, reasoned and audited override for minimum/expiry', async () => {
    const db = store({ lockVoucher: vi.fn().mockResolvedValue({
      id: 'v1', organizationId: 'org-a', branchId: 'b1', status: 'ISSUED', valueMinor: 1_000,
      scope: 'WHOLE_BASKET', customerId: null, phone: null, expiresAt: new Date('2026-10-21'),
      minNextBasketMinor: 2_000, redeemedSaleId: null,
    }) });
    await expect(redeemVoucher(db, input)).rejects.toMatchObject({ reason: 'OVERRIDE_REQUIRED' });
    await redeemVoucher(db, { ...input, override: { authorized: true, reason: 'manager approved', expiryGraceDays: 2 } });
    expect(db.writeOverrideAudit).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'manager approved', violations: ['EXPIRED', 'MINIMUM_BASKET'],
    }));
  });
  it('collapses a cross-tenant lookup to not-found', async () => {
    const db = store({ lockVoucher: vi.fn().mockResolvedValue(null) });
    await expect(redeemVoucher(db, { ...input, organizationId: 'org-b' }))
      .rejects.toMatchObject({ reason: 'VOUCHER_NOT_FOUND' });
  });
});
