import { describe, expect, it } from 'vitest';

import { smsFallbackReason, smsLanguage, utilitySmsBody } from './messages';
import {
  createSmsProvider,
  parseSmsInbound,
  readSmsConfig,
  smsEnabledFor,
  SmsProviderError,
} from './provider';

describe('utilitySmsBody', () => {
  it.each([
    [{ kind: 'REFILL_REMINDER', dueDate: '2026-10-01' } as const, '2026-10-01'],
    [{ kind: 'ORDER_READY', reference: 'AB12CD', branch: 'Gulberg' } as const, 'AB12CD'],
    [{ kind: 'KHATA_REMINDER', balance: 'Rs 2,500.00' } as const, 'Rs 2,500.00'],
  ])('renders %o in English and Urdu with the STOP instruction', (content, value) => {
    const english = utilitySmsBody(content, 'en');
    const urdu = utilitySmsBody(content, 'ur');
    expect(english).toContain(value);
    expect(urdu).toContain(value);
    expect(english.endsWith('Reply STOP to opt out.')).toBe(true);
    expect(urdu.endsWith('بند کرنے کے لیے STOP لکھیں۔')).toBe(true);
    expect(urdu).not.toBe(english);
  });

  it('keeps placeholders single-line and link-free', () => {
    const body = utilitySmsBody(
      { kind: 'ORDER_READY', reference: 'AB12CD', branch: 'Main\nhttps://evil.example/x branch' },
      'en'
    );
    expect(body).not.toContain('https://');
    expect(body.split('\n')).toHaveLength(2);
  });

  it('defaults to English unless Urdu is preferred', () => {
    expect(smsLanguage('ur')).toBe('ur');
    expect(smsLanguage('en')).toBe('en');
    expect(smsLanguage(null)).toBe('en');
    expect(smsLanguage('pa')).toBe('en');
  });
});

describe('smsFallbackReason', () => {
  it('triggers only without WhatsApp consent or after a permanent failure', () => {
    expect(smsFallbackReason({ whatsappEligible: false })).toBe('NO_WHATSAPP_CONSENT');
    expect(smsFallbackReason({ whatsappEligible: true, whatsappOutcome: 'FAILED' })).toBe(
      'WHATSAPP_PERMANENT_FAILURE'
    );
    for (const outcome of ['SENT', 'PREPARED', 'UNKNOWN', 'DUPLICATE'] as const)
      expect(smsFallbackReason({ whatsappEligible: true, whatsappOutcome: outcome })).toBeNull();
  });
});

describe('SMS provider seam', () => {
  it('defaults to mock and needs an explicit organization binding', () => {
    const config = readSmsConfig({});
    expect(config.provider).toBe('mock');
    expect(smsEnabledFor(config, 'org_a')).toBe(false);
    expect(smsEnabledFor(readSmsConfig({ PHARMACY_SMS_ORGANIZATION_ID: 'org_a' }), 'org_a')).toBe(
      true
    );
  });

  it('disables sending for an unknown gateway value with a definitive error', async () => {
    const config = readSmsConfig({
      PHARMACY_SMS_PROVIDER: 'unknown-gateway',
      PHARMACY_SMS_ORGANIZATION_ID: 'org_a',
    });
    expect(smsEnabledFor(config, 'org_a')).toBe(false);
    const error = await createSmsProvider(config)
      .send({ to: '923001234567', body: 'x' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SmsProviderError);
    expect((error as SmsProviderError).definitive).toBe(true);
  });

  it('fails webhook verification closed without a secret', () => {
    expect(createSmsProvider(readSmsConfig({})).verifyWebhook('{}', 'sha256=00')).toBe(false);
  });

  it('parses only well-formed inbound messages', () => {
    expect(
      parseSmsInbound({
        messages: [
          { id: 'm1', from: '923001234567', text: 'STOP', timestamp: '1790000000' },
          { id: 'm2', from: '+92 300', text: 'STOP', timestamp: '1790000000' },
          { id: 'm3', from: '923001234567', text: 'STOP', timestamp: 'later' },
        ],
      })
    ).toEqual([
      {
        providerMessageId: 'm1',
        from: '923001234567',
        text: 'STOP',
        receivedAt: new Date(1_790_000_000_000),
      },
    ]);
    expect(parseSmsInbound(null)).toEqual([]);
  });
});
