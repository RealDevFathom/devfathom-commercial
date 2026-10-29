import { describe, expect, it } from 'vitest';
import {
  backInStockPreview,
  backInStockTemplateParameters,
  eligibleRestockRequests,
  isRecoverableSale,
  recoveryDashboard,
  sendBackInStockNotice,
} from './back-in-stock';
import { MockWhatsAppProvider, readWhatsAppConfig } from './whatsapp/provider';

const now = new Date('2026-10-29T12:00:00Z');

describe('back-in-stock policy', () => {
  it('never places product, salt, or category data in template variables or text', () => {
    const input = { branch: 'Gulberg', requestedOn: new Date('2026-10-20'), reference: 'A123' };
    expect(backInStockTemplateParameters(input)).toEqual(['Gulberg', '2026-10-20', 'A123']);
    const output = backInStockPreview(input);
    for (const prohibited of ['Panadol', 'paracetamol', 'analgesic', 'medicine', 'drug', 'salt'])
      expect(output.toLowerCase()).not.toContain(prohibited.toLowerCase());
  });

  it('uses a separately configurable approved utility template', () => {
    const config = readWhatsAppConfig({
      PHARMACY_WHATSAPP_TEMPLATE_BACK_IN_STOCK: 'stock_available_v1',
    });
    expect(config.templates.backInStock).toBe('stock_available_v1');
  });

  it('sends only the approved non-product parameters through the provider', async () => {
    const provider = new MockWhatsAppProvider(
      readWhatsAppConfig({ PHARMACY_WHATSAPP_TEMPLATE_BACK_IN_STOCK: 'stock_available_v1' })
    );
    await sendBackInStockNotice(provider, '923001234567', {
      branch: 'Gulberg',
      requestedOn: new Date('2026-10-20'),
      reference: 'A123',
    });
    expect(provider.calls).toEqual([
      {
        kind: 'template',
        to: '923001234567',
        template: 'backInStock',
        parameters: ['Gulberg', '2026-10-20', 'A123'],
        templateName: 'stock_available_v1',
      },
    ]);
  });

  it('selects FIFO, once per request, and expires requests after 14 days', () => {
    expect(
      eligibleRestockRequests(
        [
          { id: 'new', createdAt: new Date('2026-10-28') },
          { id: 'expired', createdAt: new Date('2026-10-15T11:59:59Z') },
          { id: 'sent', createdAt: new Date('2026-10-20'), notifiedAt: now },
          { id: 'old', createdAt: new Date('2026-10-20') },
        ],
        now
      ).map((row) => row.id)
    ).toEqual(['old', 'new']);
  });

  it('links same-customer or same-SKU sales only within seven days', () => {
    const notifiedAt = new Date('2026-10-20T12:00:00Z');
    expect(
      isRecoverableSale({
        notifiedAt,
        soldAt: new Date('2026-10-27T12:00:00Z'),
        sameCustomer: true,
        sameSku: false,
      })
    ).toBe(true);
    expect(
      isRecoverableSale({
        notifiedAt,
        soldAt: new Date('2026-10-27T12:00:01Z'),
        sameCustomer: false,
        sameSku: true,
      })
    ).toBe(false);
    expect(
      isRecoverableSale({
        notifiedAt,
        soldAt: new Date('2026-10-21'),
        sameCustomer: false,
        sameSku: false,
      })
    ).toBe(false);
  });

  it('totals estimated lost, recovered PKR and net by dashboard dimensions', () => {
    const report = recoveryDashboard([
      {
        branch: 'A',
        salt: 'S1',
        distributor: 'D1',
        estimatedLostMinor: 10_000,
        recoveredMinor: 4_000,
      },
      {
        branch: 'A',
        salt: 'S1',
        distributor: 'D1',
        estimatedLostMinor: 2_000,
        recoveredMinor: 1_000,
      },
      {
        branch: 'B',
        salt: 'S2',
        distributor: 'D2',
        estimatedLostMinor: 8_000,
        recoveredMinor: 3_000,
      },
    ]);
    expect(report).toMatchObject({
      label: 'Estimate',
      currency: 'PKR',
      estimatedLostMinor: 20_000,
      recoveredMinor: 8_000,
      netMinor: 12_000,
    });
    expect(report.rows[0]).toMatchObject({
      estimatedLostMinor: 12_000,
      recoveredMinor: 5_000,
      netMinor: 7_000,
    });
  });
});
