import { describe, expect, it } from 'vitest';

import {
  HOSTED_RECEIPT_MAX_TTL_DAYS,
  HOSTED_RECEIPT_MIN_TTL_DAYS,
  HOSTED_RECEIPT_TOKEN_PATTERN,
  HostedReceiptError,
  assertNeutralWhatsAppParameters,
  hashHostedReceiptOtp,
  hashHostedReceiptToken,
  hostedReceiptExpiresAt,
  hostedReceiptOtpMatches,
  hostedReceiptTtlDays,
  isRxSaleLine,
  mintHostedReceiptOtp,
  mintHostedReceiptToken,
  namesMedicineContent,
  receiptLinkParameters,
  receiptMethodLabel,
} from './hosted-receipt';
import { medicineNameSet } from './medicine-names';

// Product, brand and ingredient (salt) names, as the tenant catalogue supplies them.
const names = medicineNameSet([
  'Panadol Extra 500mg Tablet',
  'Panadol',
  'Augmentin',
  'Amoxicillin',
]);

describe('DEV-16 hosted receipt token', () => {
  it('is 160 random bits in one unbroken word, never repeated', () => {
    const tokens = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      const { token } = mintHostedReceiptToken();
      expect(token).toMatch(HOSTED_RECEIPT_TOKEN_PATTERN);
      expect(token).toHaveLength(32);
      tokens.add(token);
    }
    expect(tokens.size).toBe(500);
  });

  it('stores only a SHA-256 digest that does not contain the token', () => {
    const { token, tokenHash } = mintHostedReceiptToken();
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toContain(token);
    expect(hashHostedReceiptToken(token)).toBe(tokenHash);
    expect(hashHostedReceiptToken(`${token.slice(0, -1)}0`)).not.toBe(tokenHash);
  });
});

describe('DEV-16 hosted receipt expiry', () => {
  it('defaults to 30 days and stays within the configured 30-90 day window', () => {
    expect(hostedReceiptTtlDays({})).toBe(30);
    expect(hostedReceiptTtlDays({ PHARMACY_RECEIPT_LINK_TTL_DAYS: '60' })).toBe(60);
    expect(hostedReceiptTtlDays({ PHARMACY_RECEIPT_LINK_TTL_DAYS: '365' })).toBe(
      HOSTED_RECEIPT_MAX_TTL_DAYS
    );
    expect(hostedReceiptTtlDays({ PHARMACY_RECEIPT_LINK_TTL_DAYS: '1' })).toBe(
      HOSTED_RECEIPT_MIN_TTL_DAYS
    );
    expect(hostedReceiptTtlDays({ PHARMACY_RECEIPT_LINK_TTL_DAYS: 'forever' })).toBe(30);
    expect(hostedReceiptTtlDays({ PHARMACY_RECEIPT_LINK_TTL_DAYS: '45.5' })).toBe(30);
  });

  it('expires the link the configured number of days after it is sent', () => {
    const now = new Date('2026-11-15T10:00:00.000Z');
    expect(hostedReceiptExpiresAt(now, 30).toISOString()).toBe('2026-12-15T10:00:00.000Z');
  });
});

describe('DEV-16 Rx protection', () => {
  const medicine = { rx: false, controlled: false, restricted: false };
  it('protects prescription-linked, Rx, controlled and restricted lines', () => {
    expect(isRxSaleLine({ prescriptionLineId: null, medicine })).toBe(false);
    expect(isRxSaleLine({ prescriptionLineId: 'rx-line', medicine })).toBe(true);
    expect(isRxSaleLine({ prescriptionLineId: null, medicine: { ...medicine, rx: true } })).toBe(
      true
    );
    expect(
      isRxSaleLine({ prescriptionLineId: null, medicine: { ...medicine, controlled: true } })
    ).toBe(true);
    expect(
      isRxSaleLine({ prescriptionLineId: null, medicine: { ...medicine, restricted: true } })
    ).toBe(true);
  });
});

describe('DEV-16 neutral receipt template', () => {
  it('carries branch, receipt number, total, method and link only', () => {
    const parameters = receiptLinkParameters({
      branchName: '  Gulberg   Branch ',
      receiptNumber: 1042,
      currency: 'PKR',
      netMinor: 125_050,
      method: receiptMethodLabel([{ type: 'CASH' }, { type: 'CARD' }, { type: 'CASH' }]),
      url: 'https://acme.devfathom.app/receipt/0123456789abcdefghjkmnpqrstvwxyz',
    });
    expect(parameters).toEqual([
      'Gulberg Branch',
      '1042',
      'PKR 1250.50',
      'Cash + Card',
      'https://acme.devfathom.app/receipt/0123456789abcdefghjkmnpqrstvwxyz',
    ]);
    expect(() => assertNeutralWhatsAppParameters(parameters, names)).not.toThrow();
  });

  it('labels unknown tenders neutrally', () => {
    expect(receiptMethodLabel([])).toBe('Other');
    expect(receiptMethodLabel([{ type: 'SOMETHING_NEW' }])).toBe('Other');
  });

  it('refuses any drug, salt or medicine category in WhatsApp text', () => {
    for (const text of [
      'Panadol Extra',
      'panadol',
      'AUGMENTIN',
      'amoxicillin',
      'Your antibiotic order',
      'Rx receipt',
      'syrup',
      'دوا',
    ]) {
      expect(namesMedicineContent(text, names)).toBe(true);
      expect(() => assertNeutralWhatsAppParameters(['Branch', text], names)).toThrow(
        HostedReceiptError
      );
    }
    expect(namesMedicineContent('Gulberg Pharmacy', names)).toBe(false);
  });

  it('never trips on the random link token itself', () => {
    for (let index = 0; index < 200; index += 1) {
      const { token } = mintHostedReceiptToken();
      expect(namesMedicineContent(`https://acme.devfathom.app/receipt/${token}`, names)).toBe(
        false
      );
    }
  });
});

describe('DEV-16 receipt one-time code', () => {
  it('is six digits, salted, and only the right code matches', () => {
    const otp = mintHostedReceiptOtp();
    expect(otp).toMatch(/^\d{6}$/);
    const stored = hashHostedReceiptOtp(otp);
    expect(stored).not.toContain(otp);
    expect(hashHostedReceiptOtp(otp)).not.toBe(stored);
    expect(hostedReceiptOtpMatches(stored, otp)).toBe(true);
    const wrong = String((Number(otp) + 1) % 1_000_000).padStart(6, '0');
    expect(hostedReceiptOtpMatches(stored, wrong)).toBe(false);
    expect(hostedReceiptOtpMatches(stored, '12345')).toBe(false);
    expect(hostedReceiptOtpMatches('malformed', otp)).toBe(false);
  });
});
