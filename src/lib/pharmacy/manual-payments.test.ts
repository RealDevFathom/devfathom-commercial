import { describe, expect, it } from 'vitest';
import {
  MANUAL_TENDER_TYPES, manualPaymentSettingsSchema, merchantQrSchema,
  validateManualTender, manualMerchantPolicies, aggregateTenderTotals, manualCardCaptureSchema,
} from './manual-payments';

const settings = { RAAST: { destination: 'PK00TEST000000', allowReferenceSkip: false } };
describe('#710 manual merchant capture', () => {
  it.each(MANUAL_TENDER_TYPES)('requires payer and 4–6 reference digits for %s', (type) => {
    const branch = { [type]: { destination: 'Merchant till', allowReferenceSkip: false } };
    expect(validateManualTender(branch, { type, providerRef: '001234', payerName: ' Ayesha ' }))
      .toMatchObject({ type, providerRef: '001234', payerName: 'Ayesha' });
    for (const providerRef of [undefined, '', '123', '1234567', '12x4'])
      expect(() => validateManualTender(branch, { type, providerRef, payerName: 'Ayesha' })).toThrow();
    expect(() => validateManualTender(branch, { type, providerRef: '1234', payerName: ' ' })).toThrow();
  });
  it('allows an explicit skip only under branch policy and still requires the payer', () => {
    const capture = { type: 'RAAST', payerName: 'Ayesha', referenceSkipped: true };
    expect(() => validateManualTender(settings, capture)).toThrow('requires a transaction reference');
    const permitted = { RAAST: { ...settings.RAAST, allowReferenceSkip: true } };
    expect(validateManualTender(permitted, capture)).toMatchObject(capture);
    expect(() => validateManualTender(permitted, { type: 'RAAST', payerName: 'Ayesha' })).toThrow();
    expect(() => validateManualTender(permitted, { ...capture, providerRef: '1234' })).toThrow();
    expect(() => validateManualTender(permitted, { ...capture, payerName: '' })).toThrow();
    expect(() => validateManualTender({}, capture)).toThrow('not enabled at this branch');
  });
  it('accepts QR-only, destination-only or detail-free settings and rejects executable or remote uploads', () => {
    const qrImageDataUrl = 'data:image/png;base64,aGVsbG8=';
    expect(manualPaymentSettingsSchema.parse({ RAAST: { destination: '', qrImageDataUrl } }).RAAST?.allowReferenceSkip).toBe(false);
    expect(() => manualPaymentSettingsSchema.parse({ RAAST: { destination: 'x'.repeat(121) } })).toThrow();
    expect(() => manualPaymentSettingsSchema.parse({ RAAST: { destination: '', extra: 1 } })).toThrow();
    for (const value of ['https://example.com/qr.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'javascript:alert(1)', `data:image/png;base64,${'A'.repeat(350_000)}`])
      expect(merchantQrSchema.safeParse(value).success).toBe(false);
    expect(manualMerchantPolicies({ RAAST: { ...settings.RAAST, qrImageDataUrl } })).toEqual({ RAAST: { allowReferenceSkip: false } });
  });
  it('keeps each tender separate, credits cash refunds to the drawer, and uses exact minor units', () => {
    expect(aggregateTenderTotals([
      { type: 'CASH', amountMinor: 500 }, { type: 'RAAST', amountMinor: 1001 },
      { type: 'RAAST', amountMinor: 2000 }, { type: 'JAZZCASH', amountMinor: 333 },
      { type: 'EASYPAISA', amountMinor: 77 },
    ], [
      { amountMinor: 100, drawerSessionId: null, originalTender: { type: 'RAAST' } },
      { amountMinor: 25, drawerSessionId: 'drawer', originalTender: { type: 'JAZZCASH' } },
    ])).toEqual([
      { type: 'CASH', amountMinor: 500, refundMinor: 25, netMinor: 475 },
      { type: 'EASYPAISA', amountMinor: 77, refundMinor: 0, netMinor: 77 },
      { type: 'JAZZCASH', amountMinor: 333, refundMinor: 0, netMinor: 333 },
      { type: 'RAAST', amountMinor: 3001, refundMinor: 100, netMinor: 2901 },
    ]);
  });
});

describe('DEV-713 manual card and optional merchant details', () => {
  it.each(MANUAL_TENDER_TYPES)('accepts %s when enabled without an IBAN, till number or QR', (type) => {
    const enabled = manualPaymentSettingsSchema.parse({ [type]: {} });
    expect(enabled[type]).toEqual({ destination: '', allowReferenceSkip: false });
    expect(validateManualTender(enabled, { type, providerRef: '4321', payerName: 'Bilal' }))
      .toMatchObject({ type, providerRef: '4321' });
    expect(() => validateManualTender(enabled, { type, payerName: 'Bilal', referenceSkipped: true }))
      .toThrow('requires a transaction reference');
  });
  it('requires a card reference or last 4 digits and an approval code', () => {
    expect(manualCardCaptureSchema.parse({ providerRef: ' 1234 ', approvalCode: 'A1B2C3' }))
      .toEqual({ providerRef: '1234', approvalCode: 'A1B2C3' });
    expect(manualCardCaptureSchema.safeParse({ providerRef: 'RRN000123456', approvalCode: '0042' }).success).toBe(true);
    for (const capture of [
      { providerRef: '1234' }, { approvalCode: 'A1B2' }, { providerRef: '123', approvalCode: 'A1B2' },
      { providerRef: '1234', approvalCode: 'A' }, { providerRef: '12-34', approvalCode: 'A1B2' },
      { providerRef: '1234', approvalCode: 'A1B2', payerName: 'x' },
    ]) expect(manualCardCaptureSchema.safeParse(capture).success).toBe(false);
  });
  it('reports manual confirmers by tender type at the end of the day', () => {
    const names = new Map([['u1', 'Ayesha'], ['u2', 'Bilal']]);
    expect(aggregateTenderTotals([
      { type: 'CASH', amountMinor: 500, confirmedById: null },
      { type: 'CARD', amountMinor: 1000, confirmedById: 'u2' },
      { type: 'CARD', amountMinor: 250, confirmedById: 'u1' },
      { type: 'CARD', amountMinor: 50, confirmedById: 'u2' },
      { type: 'JAZZCASH', amountMinor: 70, confirmedById: 'gone' },
    ], [], names)).toEqual([
      { type: 'CARD', amountMinor: 1300, refundMinor: 0, netMinor: 1300, confirmers: [
        { id: 'u1', name: 'Ayesha', count: 1, amountMinor: 250 }, { id: 'u2', name: 'Bilal', count: 2, amountMinor: 1050 },
      ] },
      { type: 'CASH', amountMinor: 500, refundMinor: 0, netMinor: 500 },
      { type: 'JAZZCASH', amountMinor: 70, refundMinor: 0, netMinor: 70, confirmers: [
        { id: 'gone', name: 'Unknown user', count: 1, amountMinor: 70 },
      ] },
    ]);
  });
  it('keeps two confirmers with the same name apart', () => {
    expect(aggregateTenderTotals([
      { type: 'CARD', amountMinor: 10, confirmedById: 'b' },
      { type: 'CARD', amountMinor: 20, confirmedById: 'a' },
    ], [])).toEqual([
      { type: 'CARD', amountMinor: 30, refundMinor: 0, netMinor: 30, confirmers: [
        { id: 'a', name: 'Unknown user', count: 1, amountMinor: 20 },
        { id: 'b', name: 'Unknown user', count: 1, amountMinor: 10 },
      ] },
    ]);
  });
});
