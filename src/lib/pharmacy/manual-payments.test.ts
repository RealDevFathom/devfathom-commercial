import { describe, expect, it } from 'vitest';
import {
  CONFIGURED_MANUAL_TENDER_TYPES,
  manualPaymentSettingsSchema,
  merchantQrSchema,
  validateManualTender,
  manualMerchantPolicies,
  aggregateTenderTotals,
} from './manual-payments';

const settings = { RAAST: { destination: 'PK00TEST000000', allowReferenceSkip: false } };
describe('#710 manual merchant capture', () => {
  it.each(CONFIGURED_MANUAL_TENDER_TYPES)(
    'requires payer and a bounded transaction ID for %s',
    (type) => {
      const branch = { [type]: { destination: 'Merchant till', allowReferenceSkip: false } };
      expect(
        validateManualTender(branch, { type, providerRef: '001234', payerName: ' Ayesha ' })
      ).toMatchObject({ type, providerRef: '001234', payerName: 'Ayesha' });
      expect(
        validateManualTender(branch, { type, providerRef: 'JC-1234567890', payerName: 'Ayesha' })
      ).toMatchObject({ providerRef: 'JC-1234567890' });
      for (const providerRef of [undefined, '', '123', 'x'.repeat(121)])
        expect(() =>
          validateManualTender(branch, { type, providerRef, payerName: 'Ayesha' })
        ).toThrow();
      expect(() =>
        validateManualTender(branch, { type, providerRef: '1234', payerName: ' ' })
      ).toThrow();
    }
  );
  it('captures a standalone card terminal reference and approval code without merchant settings', () => {
    expect(
      validateManualTender({}, { type: 'CARD', providerRef: '4242', approvalCode: 'OK-19' })
    ).toMatchObject({ type: 'CARD', providerRef: '4242', approvalCode: 'OK-19' });
    expect(() => validateManualTender({}, { type: 'CARD', providerRef: '4242' })).toThrow();
  });
  it('allows an explicit skip only under branch policy and still requires the payer', () => {
    const capture = { type: 'RAAST', payerName: 'Ayesha', referenceSkipped: true };
    expect(() => validateManualTender(settings, capture)).toThrow(
      'requires a transaction reference'
    );
    const permitted = { RAAST: { ...settings.RAAST, allowReferenceSkip: true } };
    expect(validateManualTender(permitted, capture)).toMatchObject(capture);
    expect(() => validateManualTender(permitted, { type: 'RAAST', payerName: 'Ayesha' })).toThrow();
    expect(() => validateManualTender(permitted, { ...capture, providerRef: '1234' })).toThrow();
    expect(() => validateManualTender(permitted, { ...capture, payerName: '' })).toThrow();
    expect(() => validateManualTender({}, capture)).toThrow('no merchant details');
  });
  it('accepts QR-only or destination-only settings and rejects executable or remote uploads', () => {
    const qrImageDataUrl = 'data:image/png;base64,aGVsbG8=';
    expect(
      manualPaymentSettingsSchema.parse({ RAAST: { destination: '', qrImageDataUrl } }).RAAST
        ?.allowReferenceSkip
    ).toBe(false);
    expect(manualPaymentSettingsSchema.parse({ RAAST: { destination: '' } }).RAAST).toMatchObject({
      destination: '',
      allowReferenceSkip: false,
    });
    for (const value of [
      'https://example.com/qr.png',
      'data:image/svg+xml;base64,PHN2Zz4=',
      'javascript:alert(1)',
      `data:image/png;base64,${'A'.repeat(350_000)}`,
    ])
      expect(merchantQrSchema.safeParse(value).success).toBe(false);
    expect(manualMerchantPolicies({ RAAST: { ...settings.RAAST, qrImageDataUrl } })).toEqual({
      CARD: { allowReferenceSkip: false },
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
