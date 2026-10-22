import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { encryptSecret } from '@/lib/secret-crypto';
import { WhatsAppSendRefusedError } from './adapter';
import { parseCloudApiWebhook, WhatsAppCloudApiAdapter } from './cloud-api';

const fetchMock = vi.fn<typeof fetch>();

function adapter() {
  return new WhatsAppCloudApiAdapter(
    {
      phoneNumberId: 'phone-123',
      encryptedAccessToken: encryptSecret('org-access-token'),
      encryptedAppSecret: encryptSecret('org-app-secret'),
      graphVersion: 'v23.0',
    },
    fetchMock
  );
}

beforeEach(() => {
  process.env.PLATFORM_ENCRYPTION_KEY = 'test-only-encryption-key';
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  );
});

describe('WhatsAppCloudApiAdapter sends', () => {
  it('posts an official Cloud API template request using the decrypted org token', async () => {
    await expect(
      adapter().sendTemplate({
        organizationWhatsAppEnabled: true,
        customerOptIn: true,
        to: '923001234567',
        templateName: 'order_ready',
        languageCode: 'en_US',
        parameters: ['Ayesha', '42'],
      })
    ).resolves.toEqual({ providerMessageId: 'wamid.1' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.facebook.com/v23.0/phone-123/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer org-access-token' }),
      })
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      messaging_product: 'whatsapp',
      to: '923001234567',
      type: 'template',
      template: { name: 'order_ready', language: { code: 'en_US' } },
    });
  });

  it('posts session text when both gates allow it', async () => {
    await adapter().sendSessionText({
      organizationWhatsAppEnabled: true,
      customerOptIn: true,
      to: '923001234567',
      body: 'Your order is ready.',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      type: 'text',
      text: { preview_url: false, body: 'Your order is ready.' },
    });
  });

  it.each([
    ['disabled tenant', false, true, 'ORGANIZATION_DISABLED'],
    ['false opt-in', true, false, 'CUSTOMER_NOT_OPTED_IN'],
    ['missing opt-in', true, null, 'CUSTOMER_NOT_OPTED_IN'],
  ] as const)('refuses %s without touching the network', async (_case, enabled, optIn, reason) => {
    await expect(
      adapter().sendSessionText({
        organizationWhatsAppEnabled: enabled,
        customerOptIn: optIn,
        to: '923001234567',
        body: 'No send',
      })
    ).rejects.toMatchObject({ reason } satisfies Partial<WhatsAppSendRefusedError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('WhatsAppCloudApiAdapter webhooks', () => {
  it('verifies X-Hub-Signature-256 over the exact raw body', () => {
    const raw = JSON.stringify({ object: 'whatsapp_business_account' });
    const signature = `sha256=${createHmac('sha256', 'org-app-secret').update(raw).digest('hex')}`;
    expect(adapter().verifyWebhook(raw, signature)).toBe(true);
    expect(adapter().verifyWebhook(`${raw} `, signature)).toBe(false);
    expect(adapter().verifyWebhook(raw, null)).toBe(false);
  });

  it('parses text messages and ignores statuses and unsupported messages', () => {
    const messages = parseCloudApiWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'phone-123' },
                statuses: [{ id: 'ignored' }],
                messages: [
                  {
                    id: 'wamid.in',
                    from: '923001234567',
                    timestamp: '1792684800',
                    type: 'text',
                    text: { body: 'Hello' },
                  },
                  {
                    id: 'wamid.image',
                    from: '923001234567',
                    timestamp: '1792684800',
                    type: 'image',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(messages).toEqual([
      {
        providerMessageId: 'wamid.in',
        from: '923001234567',
        text: 'Hello',
        receivedAt: new Date('2026-10-22T16:00:00.000Z'),
        phoneNumberId: 'phone-123',
      },
    ]);
  });
});
