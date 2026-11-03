import { describe, expect, it } from 'vitest';
import {
  MANUAL_TENDER_TYPES,
  manualPaymentSettingsSchema,
  merchantQrSchema,
  validateManualTender,
  manualMerchantPolicies,
  aggregateTenderTotals,
} from './manual-payments';

const settings = { RAAST: { destination: 'PK00TEST000000', allowReferenceSkip: false } };
describe('#710 manual merchant capture', () => {
  it.each(MANUAL_TENDER_TYPES)('requires 4–6 reference digits for %s', (type) => {
    const branch = { [type]: { destination: 'Merchant till', allowReferenceSkip: false } };
    expect(
      validateManualTender(branch, { type, providerRef: '001234', payerName: ' Ayesha ' })
    ).toMatchObject({ type, providerRef: '001234', payerName: 'Ayesha' });
    for (const providerRef of [undefined, '', '123', '1234567', '12x4'])
      expect(() =>
        validateManualTender(branch, { type, providerRef, payerName: 'Ayesha' })
      ).toThrow();
    expect(validateManualTender(branch, { type, providerRef: '1234' })).toMatchObject({
      type,
      providerRef: '1234',
    });
  });
  it('allows an explicit skip only under branch policy', () => {
    const capture = { type: 'RAAST', payerName: 'Ayesha', referenceSkipped: true };
    expect(() => validateManualTender(settings, capture)).toThrow(
      'requires a transaction reference'
    );
    const permitted = { RAAST: { ...settings.RAAST, allowReferenceSkip: true } };
    expect(validateManualTender(permitted, capture)).toMatchObject(capture);
    expect(() => validateManualTender(permitted, { type: 'RAAST', payerName: 'Ayesha' })).toThrow();
    expect(() => validateManualTender(permitted, { ...capture, providerRef: '1234' })).toThrow();
    expect(
      validateManualTender(permitted, { type: 'RAAST', referenceSkipped: true })
    ).toMatchObject({
      type: 'RAAST',
      referenceSkipped: true,
    });
    expect(() => validateManualTender({}, capture)).toThrow('no merchant details');
  });
  it('accepts QR-only or destination-only settings and rejects executable or remote uploads', () => {
    const qrImageDataUrl = 'data:image/png;base64,aGVsbG8=';
    expect(
      manualPaymentSettingsSchema.parse({ RAAST: { destination: '', qrImageDataUrl } }).RAAST
        ?.allowReferenceSkip
    ).toBe(false);
    expect(() => manualPaymentSettingsSchema.parse({ RAAST: { destination: '' } })).toThrow();
    for (const value of [
      'https://example.com/qr.png',
      'data:image/svg+xml;base64,PHN2Zz4=',
      'javascript:alert(1)',
      `data:image/png;base64,${'A'.repeat(350_000)}`,
    ])
      expect(merchantQrSchema.safeParse(value).success).toBe(false);
    expect(manualMerchantPolicies({ RAAST: { ...settings.RAAST, qrImageDataUrl } })).toEqual({
      RAAST: { allowReferenceSkip: false },
    });
  });
  it('keeps each tender separate, credits cash refunds to the drawer, and uses exact minor units', () => {
    expect(
      aggregateTenderTotals(
        [
          { type: 'CASH', amountMinor: 500 },
          { type: 'RAAST', amountMinor: 1001 },
          { type: 'RAAST', amountMinor: 2000 },
          { type: 'JAZZCASH', amountMinor: 333 },
          { type: 'EASYPAISA', amountMinor: 77 },
        ],
        [
          { amountMinor: 100, drawerSessionId: null, originalTender: { type: 'RAAST' } },
          { amountMinor: 25, drawerSessionId: 'drawer', originalTender: { type: 'JAZZCASH' } },
        ]
      )
    ).toEqual([
      { type: 'CASH', amountMinor: 500, refundMinor: 25, netMinor: 475 },
      { type: 'EASYPAISA', amountMinor: 77, refundMinor: 0, netMinor: 77 },
      { type: 'JAZZCASH', amountMinor: 333, refundMinor: 0, netMinor: 333 },
      { type: 'RAAST', amountMinor: 3001, refundMinor: 100, netMinor: 2901 },
    ]);
  });
});
