import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createWhatsAppProvider,
  MetaWhatsAppProvider,
  MockWhatsAppProvider,
  readWhatsAppConfig,
  WhatsAppProviderError,
} from './provider';

const ENV = {
  PHARMACY_WHATSAPP_PROVIDER: 'mock',
  PHARMACY_WHATSAPP_APP_SECRET: 'test-app-secret',
  PHARMACY_WHATSAPP_ACCESS_TOKEN: 'test-token',
  PHARMACY_WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  PHARMACY_WHATSAPP_TEMPLATE_REFILL_REMINDER: 'refill_due_v1',
  PHARMACY_WHATSAPP_TEMPLATE_LANGUAGE: 'ur',
};

function sign(body: string, secret = ENV.PHARMACY_WHATSAPP_APP_SECRET) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function metaPayload(messages: unknown[]) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba',
        changes: [
          {
            field: 'messages',
            value: { metadata: { phone_number_id: '1234567890' }, messages },
          },
        ],
      },
    ],
  };
}

describe('readWhatsAppConfig', () => {
  it('defaults to the mock provider and reads names only from the environment', () => {
    const config = readWhatsAppConfig({});
    expect(config.provider).toBe('mock');
    expect(config.templates.refillReminder).toBeNull();
    expect(config.appSecret).toBeNull();
    expect(config.reminderLeadDays).toBe(3);
    expect(createWhatsAppProvider(config)).toBeInstanceOf(MockWhatsAppProvider);
  });

  it('selects meta only when explicitly configured', () => {
    const config = readWhatsAppConfig({ ...ENV, PHARMACY_WHATSAPP_PROVIDER: 'meta' });
    expect(createWhatsAppProvider(config).name).toBe('meta');
    expect(readWhatsAppConfig({ PHARMACY_WHATSAPP_PROVIDER: 'twilio' }).provider).toBe('mock');
  });

  it('rejects an out-of-range reminder lead', () => {
    expect(readWhatsAppConfig({ PHARMACY_WHATSAPP_REMINDER_LEAD_DAYS: '5' }).reminderLeadDays).toBe(
      5
    );
    expect(
      readWhatsAppConfig({ PHARMACY_WHATSAPP_REMINDER_LEAD_DAYS: '-1' }).reminderLeadDays
    ).toBe(3);
  });
});

describe('MockWhatsAppProvider', () => {
  it('records template and text sends with the env-configured template name', async () => {
    const provider = new MockWhatsAppProvider(readWhatsAppConfig(ENV));
    const first = await provider.sendTemplate({
      to: '923001234567',
      template: 'refillReminder',
      parameters: ['Ayesha', 'Panadol', '2026-10-02'],
    });
    const second = await provider.sendText({ to: '923001234567', body: 'hello' });
    expect(first.providerMessageId).not.toBe(second.providerMessageId);
    expect(provider.calls).toEqual([
      {
        kind: 'template',
        to: '923001234567',
        template: 'refillReminder',
        templateName: 'refill_due_v1',
        parameters: ['Ayesha', 'Panadol', '2026-10-02'],
      },
      { kind: 'text', to: '923001234567', body: 'hello' },
    ]);
  });

  it('refuses to send a template that is not configured', async () => {
    const provider = new MockWhatsAppProvider(readWhatsAppConfig({}));
    await expect(
      provider.sendTemplate({ to: '923001234567', template: 'refillReminder', parameters: [] })
    ).rejects.toBeInstanceOf(WhatsAppProviderError);
    expect(provider.calls).toHaveLength(0);
  });

  it('verifies the X-Hub-Signature-256 HMAC and fails closed without a secret', () => {
    const body = JSON.stringify(metaPayload([]));
    const provider = new MockWhatsAppProvider(readWhatsAppConfig(ENV));
    expect(provider.verifyWebhook(body, sign(body))).toBe(true);
    expect(provider.verifyWebhook(`${body} `, sign(body))).toBe(false);
    expect(provider.verifyWebhook(body, sign(body, 'wrong-secret'))).toBe(false);
    expect(provider.verifyWebhook(body, null)).toBe(false);
    expect(provider.verifyWebhook(body, 'sha256=')).toBe(false);
    const unconfigured = new MockWhatsAppProvider(readWhatsAppConfig({}));
    expect(unconfigured.verifyWebhook(body, sign(body))).toBe(false);
  });

  it('parses only well-formed text messages from a Meta payload', () => {
    const provider = new MockWhatsAppProvider(readWhatsAppConfig(ENV));
    const messages = provider.parseInbound(
      metaPayload([
        {
          id: 'wamid.1',
          from: '923001234567',
          timestamp: '1790000000',
          type: 'text',
          text: { body: 'Panadol 2 packs' },
        },
        { id: 'wamid.2', from: '923001234567', type: 'image', image: {} },
        { id: 'wamid.3', from: 'not-a-number', type: 'text', text: { body: 'x' } },
      ])
    );
    expect(messages).toEqual([
      {
        providerMessageId: 'wamid.1',
        from: '923001234567',
        text: 'Panadol 2 packs',
        receivedAt: new Date(1_790_000_000_000),
        phoneNumberId: '1234567890',
      },
    ]);
    expect(provider.parseInbound({ object: 'page' })).toEqual([]);
    expect(provider.parseInbound(null)).toEqual([]);
  });
});

describe('MetaWhatsAppProvider', () => {
  it('blocks text and template sends even when Meta credentials are configured', async () => {
    const provider = new MetaWhatsAppProvider(
      readWhatsAppConfig({ ...ENV, PHARMACY_WHATSAPP_PROVIDER: 'meta' })
    );
    await expect(provider.sendText({ to: '923001234567', body: 'x' })).rejects.toMatchObject({
      reason: 'NOT_CONFIGURED',
      message: expect.stringContaining('Live sending is disabled'),
    });
    await expect(
      provider.sendTemplate({
        to: '923001234567',
        template: 'refillReminder',
        parameters: ['Ayesha', 'Panadol', '2026-10-02'],
      })
    ).rejects.toMatchObject({
      reason: 'NOT_CONFIGURED',
      message: expect.stringContaining('Live sending is disabled'),
    });
  });

  it('also blocks sends without credentials', async () => {
    const unconfigured = new MetaWhatsAppProvider(readWhatsAppConfig({}));
    await expect(unconfigured.sendText({ to: '923001234567', body: 'x' })).rejects.toThrow(
      'NOT_CONFIGURED'
    );
  });
});

it('keeps configured Meta sending disabled in the production factory', async () => {
  const { createWhatsAppProvider } = await import('./provider');
  const provider = createWhatsAppProvider(
    readWhatsAppConfig({ ...ENV, PHARMACY_WHATSAPP_PROVIDER: 'meta' })
  );
  await expect(provider.sendText({ to: 'synthetic', body: 'synthetic' })).rejects.toMatchObject({
    reason: 'NOT_CONFIGURED',
  });
});
