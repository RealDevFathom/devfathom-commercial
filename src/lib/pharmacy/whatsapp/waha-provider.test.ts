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
