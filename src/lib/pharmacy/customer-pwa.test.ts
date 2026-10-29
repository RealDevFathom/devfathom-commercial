import { describe, expect, it } from 'vitest';
import {
  createCustomerOtp,
  customerWhatsAppText,
  transitionRxRequest,
  verifyCustomerOtp,
  visibleCustomerOffers,
} from './customer-pwa';

describe('pharmacy customer PWA policy', () => {
  it('scopes OTP verification to exactly one customer and tenant', () => {
    const created = createCustomerOtp('customer-a', 'org-a', new Date('2026-01-01T00:00:00Z'));
    expect(
      verifyCustomerOtp(created.challenge, {
        code: created.code,
        customerId: 'customer-b',
        organizationId: 'org-a',
      })
    ).toEqual({ ok: false, reason: 'SCOPE_MISMATCH' });
    expect(
      verifyCustomerOtp(created.challenge, {
        code: created.code,
        customerId: 'customer-a',
        organizationId: 'org-a',
      })
    ).toMatchObject({ ok: true, customerId: 'customer-a' });
  });
  it('requires pharmacist approval before an Rx request can be fulfilled', () => {
    expect(() => transitionRxRequest('AWAITING_PHARMACIST', 'FULFIL')).toThrow(
      'PHARMACIST_VERIFICATION_REQUIRED'
    );
    expect(
      transitionRxRequest(transitionRxRequest('AWAITING_PHARMACIST', 'APPROVE'), 'FULFIL')
    ).toBe('FULFILLED');
  });
  it('keeps WhatsApp templates free of clinical and product content', () => {
    for (const kind of ['OTP', 'REFILL', 'RX_UPDATE', 'RECEIPT'] as const) {
      const text = customerWhatsAppText(kind, kind === 'OTP' ? '123456' : undefined);
      expect(text).not.toMatch(/drug|medicine|tablet|capsule|salt|prescription/i);
    }
  });
  it('shows only active non-drug offers when configured', () => {
    const offers = [
      { kind: 'NON_DRUG' as const, active: true, id: 1 },
      { kind: 'DRUG' as const, active: true, id: 2 },
      { kind: 'NON_DRUG' as const, active: false, id: 3 },
    ];
    expect(visibleCustomerOffers(offers, true)).toEqual([offers[0]]);
    expect(visibleCustomerOffers(offers, false)).toEqual([]);
  });
});
