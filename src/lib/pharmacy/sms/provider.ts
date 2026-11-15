import { verifyMetaSignature } from '../whatsapp/provider';

/**
 * DEV-87 — pharmacy SMS gateway seam. The Pakistani aggregator is chosen later;
 * until an adapter exists `PHARMACY_SMS_PROVIDER` accepts only `mock` (the
 * default, which never touches the network). Any other value disables sending.
 * SMS is a utility fallback only: refill-due, order-ready and khata-due.
 */

export type SmsConfig = {
  provider: 'mock' | 'disabled';
  /** Explicit owner of this deployment's configured SMS sender. */
  organizationId: string | null;
  /** HMAC secret the gateway signs inbound (STOP/START) callbacks with. */
  webhookSecret: string | null;
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
  readonly name: 'mock' | 'disabled';
  send(input: { to: string; body: string }): Promise<SmsSendResult>;
  /** Verifies `sha256=<hex>` HMAC over the raw callback body. Fails closed. */
  verifyWebhook(rawBody: string, signatureHeader: string | null): boolean;
  parseInbound(payload: unknown): SmsInboundMessage[];
}

export class SmsProviderError extends Error {
  constructor(
    readonly reason: 'NOT_CONFIGURED' | 'SEND_FAILED',
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
  const provider = envValue(env, 'PHARMACY_SMS_PROVIDER');
  return {
    provider: provider === null || provider === 'mock' ? 'mock' : 'disabled',
    organizationId: envValue(env, 'PHARMACY_SMS_ORGANIZATION_ID'),
    webhookSecret: envValue(env, 'PHARMACY_SMS_WEBHOOK_SECRET'),
  };
}

/** SMS fallback runs only for the organization explicitly bound to the sender. */
export function smsEnabledFor(config: SmsConfig, organizationId: string): boolean {
  return config.provider !== 'disabled' && config.organizationId === organizationId;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Gateway-neutral inbound shape: `{ "messages": [{ "id", "from", "text",
 * "timestamp" }] }` with a unix-seconds timestamp. An aggregator adapter maps
 * its own callback onto this; malformed entries are ignored.
 */
export function parseSmsInbound(payload: unknown): SmsInboundMessage[] {
  const root = record(payload);
  if (!root || !Array.isArray(root.messages)) return [];
  const messages: SmsInboundMessage[] = [];
  for (const raw of root.messages.slice(0, 500)) {
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
    const seconds = Number(message.timestamp);
    if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 8_640_000_000_000) continue;
    messages.push({
      providerMessageId: message.id,
      from: message.from,
      text: message.text.slice(0, 1000),
      receivedAt: new Date(seconds * 1000),
    });
  }
  return messages;
}

/** Records every send in memory; never performs network I/O. */
export class MockSmsProvider implements SmsProvider {
  readonly name = 'mock' as const;
  readonly calls: Array<{ to: string; body: string }> = [];
  private sequence = 0;

  constructor(private readonly config: SmsConfig) {}

  async send(input: { to: string; body: string }) {
    this.calls.push({ ...input });
    this.sequence += 1;
    return { providerMessageId: `mock-sms-${this.sequence}`, acceptedByProvider: false };
  }

  verifyWebhook(rawBody: string, signatureHeader: string | null) {
    return verifyMetaSignature(this.config.webhookSecret, rawBody, signatureHeader);
  }

  parseInbound(payload: unknown) {
    return parseSmsInbound(payload);
  }
}

/** Provider selected by `PHARMACY_SMS_PROVIDER` (default `mock`). */
export function createSmsProvider(config: SmsConfig = readSmsConfig()): SmsProvider {
  if (config.provider === 'mock') return new MockSmsProvider(config);
  return {
    name: 'disabled',
    send: async () => {
      throw new SmsProviderError('NOT_CONFIGURED', 'No SMS gateway adapter is configured.');
    },
    verifyWebhook: (rawBody, signatureHeader) =>
      verifyMetaSignature(config.webhookSecret, rawBody, signatureHeader),
    parseInbound: parseSmsInbound,
  };
}
