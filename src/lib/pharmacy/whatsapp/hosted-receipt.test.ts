import { describe, expect, it } from 'vitest';
import {
  buildReceiptMessage,
  createReceiptOtpProof,
  hasValidReceiptOtp,
  issueHostedReceipt,
  lintReceiptMessage,
  readHostedReceipt,
} from './hosted-receipt';
const secret = 'a-production-length-secret-that-is-not-real';
const now = new Date('2026-10-29T00:00:00.000Z');
const input = {
  consent: 'CUSTOMER_REQUEST' as const,
  branch: 'Gulberg',
  receiptNumber: 'R-42',
  total: 'PKR 1,250.00',
  paymentMethod: 'Card',
  expiryDays: 30,
  rx: false,
};
describe('neutral hosted pharmacy receipt', () => {
  it('creates an opaque authenticated token with bounded expiry', () => {
    const issued = issueHostedReceipt({ ...input, now }, secret);
    expect(issued.token).not.toContain('R-42');
    expect(readHostedReceipt(issued.token, secret, new Date('2026-11-27'))).toMatchObject({
      receiptNumber: 'R-42',
      rx: false,
    });
    expect(() =>
      readHostedReceipt(issued.token, secret, new Date('2026-11-29T00:00:00.001Z'))
    ).toThrow('expired');
    expect(() => issueHostedReceipt({ ...input, expiryDays: 29 }, secret)).toThrow('30 and 90');
    expect(() => readHostedReceipt(`${issued.token}x`, secret, now)).toThrow('Invalid');
  });
  it('requires a recent phone-bound OTP proof for Rx receipts', () => {
    const { token } = issueHostedReceipt(
      { ...input, rx: true, phone: '+92 300 1234567', now },
      secret
    );
    expect(hasValidReceiptOtp(token, undefined, secret, now)).toBe(false);
    expect(() => createReceiptOtpProof(token, '+92 311 0000000', secret, now)).toThrow(
      'does not match'
    );
    const proof = createReceiptOtpProof(token, '+92 300 1234567', secret, now);
    expect(hasValidReceiptOtp(token, proof, secret, new Date(now.getTime() + 14 * 60_000))).toBe(
      true
    );
    expect(hasValidReceiptOtp(token, proof, secret, new Date(now.getTime() + 16 * 60_000))).toBe(
      false
    );
  });
  it('builds only the five neutral utility fields and lints catalog terms', () => {
    const text = buildReceiptMessage({ ...input, link: 'https://example.test/r/token' });
    expect(text).toBe(
      'Receipt from Gulberg\nReceipt: R-42\nTotal: PKR 1,250.00\nMethod: Card\nSecure receipt: https://example.test/r/token'
    );
    expect(() => lintReceiptMessage(`${text}\nAspirin`, ['Aspirin'])).toThrow(
      'medicine information'
    );
  });
  it('carries optional FBR evidence only in the protected hosted receipt', () => {
    const issued = issueHostedReceipt(
      { ...input, now, fbrInvoiceNumber: 'FBR-9', fbrQrUrl: 'https://fbr.example/qr/9' },
      secret
    );
    expect(readHostedReceipt(issued.token, secret, now)).toMatchObject({
      fbrInvoiceNumber: 'FBR-9',
      fbrQrUrl: 'https://fbr.example/qr/9',
    });
  });
});
