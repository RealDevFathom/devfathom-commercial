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
    const now = new Date('2026-01-01T00:00:00Z');
    const created = createCustomerOtp('customer-a', 'org-a', now);
    expect(
      verifyCustomerOtp(
        created.challenge,
        {
          code: created.code,
          customerId: 'customer-b',
          organizationId: 'org-a',
        },
        now
      )
    ).toEqual({ ok: false, reason: 'SCOPE_MISMATCH' });
    expect(
      verifyCustomerOtp(
        created.challenge,
        {
          code: created.code,
          customerId: 'customer-a',
          organizationId: 'org-a',
        },
        now
      )
    ).toMatchObject({ ok: true, customerId: 'customer-a' });
  });
  it('denies cross-tenant use and consumes a successful code with an audit trail', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const created = createCustomerOtp('customer-a', 'org-a', now);
    const input = { code: created.code, customerId: 'customer-a', organizationId: 'org-a' };
    expect(
      verifyCustomerOtp(created.challenge, { ...input, organizationId: 'org-b' }, now)
    ).toEqual({
      ok: false,
      reason: 'SCOPE_MISMATCH',
    });
    expect(verifyCustomerOtp(created.challenge, input, now)).toMatchObject({ ok: true });
    expect(verifyCustomerOtp(created.challenge, input, now)).toEqual({
      ok: false,
      reason: 'CONSUMED',
    });
    expect(created.challenge.audit.map(({ kind }) => kind)).toEqual([
      'ISSUED',
      'FAILED',
      'VERIFIED',
      'REPLAY_BLOCKED',
    ]);
  });
  it('validates scope and TTL and locks after the configured attempts', () => {
    expect(() => createCustomerOtp('', 'org-a')).toThrow('OTP_SCOPE_REQUIRED');
    expect(() => createCustomerOtp('customer-a', 'org-a', new Date(), 31)).toThrow(
      'OTP_TTL_OUT_OF_RANGE'
    );
    const now = new Date('2026-01-01T00:00:00Z');
    const created = createCustomerOtp('customer-a', 'org-a', now);
    const input = {
      code: created.code === '000000' ? '999999' : '000000',
      customerId: 'customer-a',
      organizationId: 'org-a',
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(verifyCustomerOtp(created.challenge, input, now)).toEqual({
        ok: false,
        reason: 'INVALID',
      });
    }
    expect(verifyCustomerOtp(created.challenge, input, now)).toEqual({
      ok: false,
      reason: 'LOCKED',
    });
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
