import { createHmac, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createSmsProvider,
  MockSmsProvider,
  parseSmsInbound,
  readSmsConfig,
  smsFallbackEnabled,
  SmsProviderError,
} from './provider';

describe('readSmsConfig', () => {
  it('defaults to the network-free mock, English and no tenant binding', () => {
    expect(readSmsConfig({})).toEqual({
      provider: 'mock',
      organizationId: null,
      senderId: null,
      webhookSecret: null,
      language: 'en',
    });
  });

  it('reads the aggregator, tenant binding and Urdu language', () => {
    expect(
      readSmsConfig({
        PHARMACY_SMS_PROVIDER: 'aggregator',
        PHARMACY_SMS_ORGANIZATION_ID: ' org_a ',
        PHARMACY_SMS_SENDER_ID: 'PHARMA',
        PHARMACY_SMS_WEBHOOK_SECRET: 'secret',
        PHARMACY_SMS_LANGUAGE: 'ur',
      })
    ).toEqual({
      provider: 'aggregator',
      organizationId: 'org_a',
      senderId: 'PHARMA',
      webhookSecret: 'secret',
      language: 'ur',
    });
  });
});

describe('smsFallbackEnabled', () => {
  it('requires the mock provider bound to the same organization', () => {
    const bound = readSmsConfig({ PHARMACY_SMS_ORGANIZATION_ID: 'org_a' });
    const live = readSmsConfig({
      PHARMACY_SMS_ORGANIZATION_ID: 'org_a',
      PHARMACY_SMS_PROVIDER: 'aggregator',
    });
    expect(smsFallbackEnabled(bound, 'org_a')).toBe(true);
    expect(smsFallbackEnabled(bound, 'org_b')).toBe(false);
    expect(smsFallbackEnabled(readSmsConfig({}), 'org_a')).toBe(false);
    expect(smsFallbackEnabled(live, 'org_a')).toBe(false);
  });
});

describe('SMS providers', () => {
  it('mock records sends without network I/O and reports preparation, not acceptance', async () => {
    const provider = new MockSmsProvider(readSmsConfig({}));
    await expect(provider.sendText({ to: '923001234567', body: 'hi' })).resolves.toEqual({
      providerMessageId: 'mock-sms-1',
      acceptedByProvider: false,
    });
    expect(provider.calls).toEqual([{ to: '923001234567', body: 'hi' }]);
  });

  it('mock rejects a malformed recipient definitively', async () => {
    const provider = new MockSmsProvider(readSmsConfig({}));
    await expect(provider.sendText({ to: '+92 300', body: 'hi' })).rejects.toMatchObject({
      reason: 'INVALID_RECIPIENT',
      definitive: true,
    });
  });

  it('the unapproved aggregator refuses to send', async () => {
    const provider = createSmsProvider(readSmsConfig({ PHARMACY_SMS_PROVIDER: 'aggregator' }));
    const error = await provider.sendText({ to: '923001234567', body: 'hi' }).catch((e) => e);
    expect(error).toBeInstanceOf(SmsProviderError);
    expect(error).toMatchObject({ reason: 'NOT_CONFIGURED', definitive: true });
  });

  it('only a transport SEND_FAILED is non-definitive by default', () => {
    expect(new SmsProviderError('SEND_FAILED').definitive).toBe(false);
    expect(new SmsProviderError('NOT_CONFIGURED').definitive).toBe(true);
  });

  it('verifies the webhook HMAC and fails closed without a secret', () => {
    const body = '{"messages":[]}';
    // Per-run fixture key (not a hardcoded secret).
    const webhookSecret = randomBytes(32).toString('hex');
    const signature = `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`;
    const signed = createSmsProvider(
      readSmsConfig({ PHARMACY_SMS_WEBHOOK_SECRET: webhookSecret })
    );
    expect(signed.verifyWebhook(body, signature)).toBe(true);
    expect(signed.verifyWebhook(`${body} `, signature)).toBe(false);
    expect(signed.verifyWebhook(body, null)).toBe(false);
    expect(createSmsProvider(readSmsConfig({})).verifyWebhook(body, signature)).toBe(false);
  });
});

describe('parseSmsInbound', () => {
  it('parses the neutral envelope and drops malformed entries', () => {
    expect(
      parseSmsInbound({
        messages: [
          { id: 'a', from: '923001234567', text: 'STOP', receivedAt: 1_792_000_000 },
          { id: 'b', from: '923001234567', text: 'START', receivedAt: '2026-10-21T08:00:00Z' },
          { id: 'c', from: '+923001234567', text: 'STOP', receivedAt: 1_792_000_000 },
          { id: 'd', from: '923001234567', text: 7, receivedAt: 1_792_000_000 },
          { id: 'e', from: '923001234567', text: 'STOP', receivedAt: 'not-a-date' },
          null,
        ],
      })
    ).toEqual([
      {
        providerMessageId: 'a',
        from: '923001234567',
        text: 'STOP',
        receivedAt: new Date(1_792_000_000 * 1000),
      },
      {
        providerMessageId: 'b',
        from: '923001234567',
        text: 'START',
        receivedAt: new Date('2026-10-21T08:00:00Z'),
      },
    ]);
    expect(parseSmsInbound(null)).toEqual([]);
    expect(parseSmsInbound({ messages: 'x' })).toEqual([]);
  });
});
