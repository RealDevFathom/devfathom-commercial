import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * #723 — pharmacy SMS gateway seam. `PHARMACY_SMS_PROVIDER` selects `mock`
 * (the default, which never touches the network) or `aggregator` (a Pakistani
 * SMS aggregator, chosen later). Until the aggregator adapter and its
 * credentials are approved, `aggregator` refuses to send; environment alone
 * cannot enable live SMS. See docs/pharmacy/sms.md.
 */

export type SmsLanguage = 'en' | 'ur';

export type SmsConfig = {
  provider: 'mock' | 'aggregator';
  /** Explicit owner of this deployment's configured SMS sender. */
  organizationId: string | null;
  /** Masking / sender id registered with the aggregator. */
  senderId: string | null;
  /** HMAC-SHA256 secret for inbound (STOP/START) webhook signatures. */
  webhookSecret: string | null;
  language: SmsLanguage;
};

export type SmsSendResult = {
  providerMessageId: string;
  /** True only for a real gateway acknowledgement; mock preparation is false. */
  acceptedByProvider?: boolean;
};

export type SmsInboundMessage = {
  providerMessageId: string;
  /** Sender MSISDN: international digits without `+` (e.g. 923001234567). */
  from: string;
  text: string;
  receivedAt: Date;
};

export interface SmsProvider {
  readonly name: 'mock' | 'aggregator';
  sendText(input: { to: string; body: string }): Promise<SmsSendResult>;
  /** Verifies `sha256=<hex>` HMAC over the raw request body. Fails closed. */
  verifyWebhook(rawBody: string, signatureHeader: string | null): boolean;
  parseInbound(payload: unknown): SmsInboundMessage[];
}

export class SmsProviderError extends Error {
  constructor(
    readonly reason: 'NOT_CONFIGURED' | 'INVALID_RECIPIENT' | 'SEND_FAILED',
    detail?: string,
    readonly definitive = reason !== 'SEND_FAILED'
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'SmsProviderError';
  }
}

type Env = Record<string, string | undefined>;

function envValue(env: Env, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

export function readSmsConfig(env: Env = process.env): SmsConfig {
  return {
    provider: envValue(env, 'PHARMACY_SMS_PROVIDER') === 'aggregator' ? 'aggregator' : 'mock',
    organizationId: envValue(env, 'PHARMACY_SMS_ORGANIZATION_ID'),
    senderId: envValue(env, 'PHARMACY_SMS_SENDER_ID'),
    webhookSecret: envValue(env, 'PHARMACY_SMS_WEBHOOK_SECRET'),
    language: envValue(env, 'PHARMACY_SMS_LANGUAGE') === 'ur' ? 'ur' : 'en',
  };
}

/**
 * Fallback runs only for the organization that explicitly owns the sender, and
 * never through the not-yet-approved aggregator (mirrors the WhatsApp `meta` gate).
 */
export function smsFallbackEnabled(config: SmsConfig, organizationId: string): boolean {
  return (
    config.provider === 'mock' &&
    Boolean(config.organizationId) &&
    config.organizationId === organizationId
  );
}

/** `sha256=<hex>` HMAC-SHA256 over the raw body; fails closed without a secret. */
export function verifySmsSignature(
  secret: string | null,
  rawBody: string,
  signatureHeader: string | null
): boolean {
  if (!secret || !signatureHeader?.startsWith('sha256=')) return false;
  const expected = Buffer.from(
    createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex'),
    'utf8'
  );
  const received = Buffer.from(signatureHeader.slice('sha256='.length).toLowerCase(), 'utf8');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Provider-neutral inbound envelope the aggregator adapter maps onto:
 * `{ "messages": [{ "id", "from", "text", "receivedAt" }] }` where
 * `receivedAt` is epoch seconds or an ISO-8601 string. Malformed entries are ignored.
 */
export function parseSmsInbound(payload: unknown): SmsInboundMessage[] {
  const messages = record(payload)?.messages;
  if (!Array.isArray(messages)) return [];
  const parsed: SmsInboundMessage[] = [];
  for (const raw of messages.slice(0, 500)) {
    const message = record(raw);
    if (
      !message ||
      typeof message.id !== 'string' ||
      message.id.length < 1 ||
      message.id.length > 256 ||
      typeof message.from !== 'string' ||
      !/^\d{8,15}$/.test(message.from) ||
      typeof message.text !== 'string'
    )
      continue;
    const receivedAt =
      typeof message.receivedAt === 'number'
        ? new Date(message.receivedAt * 1000)
        : typeof message.receivedAt === 'string'
          ? new Date(message.receivedAt)
          : null;
    if (!receivedAt || !Number.isFinite(receivedAt.getTime()) || receivedAt.getTime() <= 0)
      continue;
    parsed.push({
      providerMessageId: message.id,
      from: message.from,
      text: message.text.slice(0, 1000),
      receivedAt,
    });
  }
  return parsed;
}

/** Records every send in memory; never performs network I/O. */
export class MockSmsProvider implements SmsProvider {
  readonly name = 'mock' as const;
  readonly calls: Array<{ to: string; body: string }> = [];
  private sequence = 0;

  constructor(private readonly config: SmsConfig) {}

  async sendText(input: { to: string; body: string }): Promise<SmsSendResult> {
    if (!/^\d{8,15}$/.test(input.to)) throw new SmsProviderError('INVALID_RECIPIENT');
    this.calls.push({ to: input.to, body: input.body });
    this.sequence += 1;
    return { providerMessageId: `mock-sms-${this.sequence}`, acceptedByProvider: false };
  }

  verifyWebhook(rawBody: string, signatureHeader: string | null) {
    return verifySmsSignature(this.config.webhookSecret, rawBody, signatureHeader);
  }

  parseInbound(payload: unknown) {
    return parseSmsInbound(payload);
  }
}

/** Provider selected by `PHARMACY_SMS_PROVIDER` (default `mock`). */
export function createSmsProvider(config: SmsConfig = readSmsConfig()): SmsProvider {
  if (config.provider !== 'aggregator') return new MockSmsProvider(config);
  // The aggregator is chosen later. Until its adapter is approved, sending is refused.
  return {
    name: 'aggregator',
    sendText: async () => {
      throw new SmsProviderError(
        'NOT_CONFIGURED',
        'Live SMS sending is disabled pending aggregator approval.'
      );
    },
    verifyWebhook: (rawBody, signatureHeader) =>
      verifySmsSignature(config.webhookSecret, rawBody, signatureHeader),
    parseInbound: parseSmsInbound,
  };
}
