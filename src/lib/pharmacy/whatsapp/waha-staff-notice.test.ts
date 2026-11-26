import { expect, it } from 'vitest';
import { deliveryNotice } from './waha-staff-notice';
it('explains a known failure and gives staff a different instruction for an uncertain delivery', () => {
  expect(deliveryNotice('NOT_ON_WHATSAPP')).toContain('not on WhatsApp');
  expect(deliveryNotice('UNKNOWN')).toContain('before trying another channel');
  expect(deliveryNotice('ACCEPTED')).toBeNull();
});

it('uses a fixed operator callback origin for a locally published container', async () => {
  const { wahaWebhookUrl } = await import('./waha-session');
  const original = process.env.PHARMACY_WAHA_WEBHOOK_ORIGIN;
  try {
    process.env.PHARMACY_WAHA_WEBHOOK_ORIGIN = 'http://host.docker.internal:3105';
    expect(wahaWebhookUrl(null, 'routing-id')).toBe(
      'http://host.docker.internal:3105/api/pharmacy/whatsapp/webhook?endpoint=routing-id'
    );
    process.env.PHARMACY_WAHA_WEBHOOK_ORIGIN = 'https://example.invalid/other';
    expect(wahaWebhookUrl(null, 'routing-id')).toBeNull();
  } finally {
    if (original === undefined) delete process.env.PHARMACY_WAHA_WEBHOOK_ORIGIN;
    else process.env.PHARMACY_WAHA_WEBHOOK_ORIGIN = original;
  }
});
