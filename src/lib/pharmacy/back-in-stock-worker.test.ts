import { describe, expect, it, vi } from 'vitest';

import { deliverBackInStockNotification } from './back-in-stock-worker';
import { MockWhatsAppProvider, readWhatsAppConfig } from './whatsapp/provider';

const scope = { organizationId: 'org-a', branchId: 'branch01' };

describe('back-in-stock durable delivery worker', () => {
  it('sends once, records provider acknowledgement, and advances the interest audit state', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const updateInterest = vi.fn().mockResolvedValue({});
    const db = {
      pharmacyRestockNotification: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'notice01',
          branchId: scope.branchId,
          destination: '923001234567',
          interest: { id: 'interest01', createdAt: new Date('2026-10-20'), status: 'OPEN' },
        }),
        updateMany,
      },
      pharmacyRestockInterest: { update: updateInterest },
    };
    const provider = new MockWhatsAppProvider(
      readWhatsAppConfig({ PHARMACY_WHATSAPP_TEMPLATE_BACK_IN_STOCK: 'stock_available_v1' })
    );
    provider.sendTemplate = vi.fn(provider.sendTemplate.bind(provider)).mockResolvedValue({
      providerMessageId: 'wamid.1',
      acceptedByProvider: true,
    });

    await expect(
      deliverBackInStockNotification(db as never, scope, 'notice01', {
        provider,
        now: new Date('2026-10-29'),
      })
    ).resolves.toBe('SENT');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'CAPTURED', organizationId: 'org-a' }),
        data: expect.objectContaining({ status: 'PROCESSING' }),
      })
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'PROCESSING', organizationId: 'org-a' }),
        data: expect.objectContaining({ status: 'SENT', providerMessageId: 'wamid.1' }),
      })
    );
    expect(updateInterest).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'NOTIFIED' } })
    );
  });

  it('does not send a cancelled, sent, cross-tenant, or opted-out row', async () => {
    const provider = new MockWhatsAppProvider(
      readWhatsAppConfig({ PHARMACY_WHATSAPP_TEMPLATE_BACK_IN_STOCK: 'stock_available_v1' })
    );
    const db = {
      pharmacyRestockNotification: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    await expect(
      deliverBackInStockNotification(db as never, scope, 'notice01', { provider })
    ).resolves.toBe('SKIPPED');
    expect(provider.calls).toHaveLength(0);
    expect(db.pharmacyRestockNotification.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          status: 'CAPTURED',
        }),
      })
    );
  });
});
