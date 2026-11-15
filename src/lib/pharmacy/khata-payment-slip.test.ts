import { describe, expect, it } from 'vitest';

import { khataPaymentSlipLines, parseMajorToMinor } from './khata-payment-slip';

describe('khata payment slip (DEV-731)', () => {
  it('prints reference, account, amount, tender and remaining balance', () => {
    const lines = khataPaymentSlipLines({
      receiptReference: 'KP-ABCDEF0123',
      accountName: 'Khan family',
      amountMinor: 150_050,
      tender: 'BANK_TRANSFER',
      payerReference: 'TXN-1',
      balanceAfterMinor: 0,
      recordedAt: new Date('2026-11-15T06:30:00.000Z'),
      currency: 'PKR',
    });
    expect(lines).toEqual(
      expect.arrayContaining([
        'KHATA PAYMENT RECEIPT',
        'Ref: KP-ABCDEF0123',
        'Account: Khan family',
        'Received: PKR 1500.50',
        'Tender: Bank transfer',
        'Payer reference: TXN-1',
        'Balance still owed: PKR 0.00',
      ])
    );
  });

  it('parses typed major units without floating-point drift', () => {
    expect(parseMajorToMinor('1500')).toBe(150_000);
    expect(parseMajorToMinor('10.5')).toBe(1_050);
    expect(parseMajorToMinor('0.29')).toBe(29);
    expect(parseMajorToMinor('1.234')).toBe(0);
    expect(parseMajorToMinor('-5')).toBe(0);
    expect(parseMajorToMinor('')).toBe(0);
  });
});
