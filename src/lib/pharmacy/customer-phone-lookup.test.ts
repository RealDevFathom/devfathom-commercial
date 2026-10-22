import { describe, expect, it, vi } from 'vitest';
import { lookupPharmacyCustomerByPhone, normalizePhoneE164 } from './customer-phone-lookup';

describe('Pakistani phone normalization', () => {
  it.each([
    ['0300-1234567', '+923001234567'],
    ['300 123 4567', '+923001234567'],
    ['+92 (300) 1234567', '+923001234567'],
    ['0092 300 1234567', '+923001234567'],
    ['۰۳۰۰ ۱۲۳۴۵۶۷', '+923001234567'],
  ])('normalizes %s', (raw, expected) => expect(normalizePhoneE164(raw)).toBe(expected));

  it.each(['', '123', '0300123456789', '+0123456789'])('rejects %s', (raw) =>
    expect(normalizePhoneE164(raw)).toBeNull()
  );
});

describe('scoped customer phone lookup', () => {
  it('passes only the normalized number to the RLS-scoped database routine', async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([]) };
    await expect(lookupPharmacyCustomerByPhone(db as never, '0300 1234567')).resolves.toBeNull();
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    expect(db.$queryRaw.mock.calls[0]?.[0].values).toEqual(['+923001234567']);
  });
});
