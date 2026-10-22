import { describe, expect, it } from 'vitest';

import {
  createSelfHostedWhatsAppAdapter,
  SelfHostedWhatsAppAdapter,
  WHATSAPP_SELFHOSTED_EXPERIMENTAL,
} from './selfhosted-stub';

describe('self-hosted WhatsApp stub', () => {
  it('is never chosen by default', () => {
    expect(WHATSAPP_SELFHOSTED_EXPERIMENTAL).toBe(false);
    expect(createSelfHostedWhatsAppAdapter({})).toBeNull();
    expect(
      createSelfHostedWhatsAppAdapter({ WHATSAPP_SELFHOSTED_EXPERIMENTAL: 'false' })
    ).toBeNull();
  });

  it('remains non-operational after explicit experimental opt-in', async () => {
    const adapter = createSelfHostedWhatsAppAdapter({
      WHATSAPP_SELFHOSTED_EXPERIMENTAL: 'true',
    });

    expect(adapter).toBeInstanceOf(SelfHostedWhatsAppAdapter);
    await expect(
      adapter!.send({ organizationId: 'org-a', to: '15551234567', text: 'test' })
    ).rejects.toMatchObject({ name: 'NotEnabled', message: 'NotEnabled' });
  });
});
