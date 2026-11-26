import { expect, it, vi } from 'vitest';
import { createWhatsAppProvider, readWhatsAppConfig } from './provider';
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('./waha-policy', () => ({ guardedWahaSend: send }));
it('selects WAHA explicitly and delivers approved parameters only within the requested tenant', async () => {
  const config = readWhatsAppConfig({
    PHARMACY_WHATSAPP_PROVIDER: 'waha',
    PHARMACY_WAHA_REFILL_EN: 'Refill due {{1}}.',
  });
  const provider = createWhatsAppProvider({ ...config, organizationId: 'business-a' });
  expect(provider.name).toBe('waha');
  await provider.sendTemplate({
    to: '12025550101',
    template: 'refillReminder',
    parameters: ['2026-11-26'],
  });
  expect(send).toHaveBeenCalledWith('business-a', '12025550101', 'refillReminder', {
    text: 'Refill due 2026-11-26.',
  });
  await expect(
    provider.sendTemplate({ to: '12025550101', template: 'receiptLink', parameters: [] })
  ).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(1);
});

it('dispatches the receipt link and neutral PDF together in one approved message', async () => {
  send.mockClear();
  const config = readWhatsAppConfig({
    PHARMACY_WHATSAPP_PROVIDER: 'waha',
    PHARMACY_WAHA_RECEIPT_EN: '{{1}} receipt {{2}}, {{3}}, {{4}}. Open {{5}}',
  });
  const provider = createWhatsAppProvider({ ...config, organizationId: 'synthetic-business' });
  const token = (await import('node:crypto')).randomBytes(16).toString('hex');
  const url = 'https://pharmacy.example.invalid/receipt/' + token;
  await provider.sendTemplate({
    to: '12025550101',
    template: 'receiptLink',
    parameters: ['Pharmacy', '42', 'PKR 10.00', 'Cash', url],
  });
  expect(send).toHaveBeenCalledTimes(1);
  const content = send.mock.calls[0][3];
  expect(content.mime).toBe('application/pdf');
  expect(Buffer.from(content.bytes).subarray(0, 5).toString()).toBe('%PDF-');
  expect(content.caption.endsWith(url)).toBe(true);
});
