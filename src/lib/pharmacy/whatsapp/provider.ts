import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * PH-B3 — pharmacy WhatsApp provider seam. `PHARMACY_WHATSAPP_PROVIDER`
 * selects `meta` (Meta WhatsApp Cloud API) or `mock` (the default, which never
 * touches the network). Every credential and template name comes from the
 * environment; see docs/pharmacy/whatsapp.md.
 */

export type WhatsAppTemplateKey = 'refillReminder' | 'khataReminder';

export type WhatsAppConfig = {
  provider: 'meta' | 'mock';
  accessToken: string | null;
  phoneNumberId: string | null;
  /** Explicit owner of this deployment's configured sender. */
  organizationId?: string | null;
  appSecret: string | null;
  verifyToken: string | null;
  /** Owner-facing Meta Account Quality destination included in strike alerts. */
  accountAppealUrl: string;
  graphVersion: string;
  templateLanguage: string;
  templates: Record<WhatsAppTemplateKey, string | null>;
  reminderLeadDays: number;
};

export type WhatsAppSendResult = {
  providerMessageId: string;
  /** True only for a real provider acknowledgement; mock preparation is false. */
  acceptedByProvider?: boolean;
};

export type WhatsAppInboundMessage = {
  providerMessageId: string;
  /** Sender WhatsApp id: international digits without `+` (e.g. 923001234567). */
  from: string;
  text: string;
  receivedAt: Date;
  phoneNumberId: string | null;
};

export interface WhatsAppProvider {
  readonly name: 'meta' | 'mock';
  sendTemplate(input: {
    to: string;
    template: WhatsAppTemplateKey;
    parameters: string[];
  }): Promise<WhatsAppSendResult>;
  sendText(input: { to: string; body: string }): Promise<WhatsAppSendResult>;
  /** Verifies Meta's `X-Hub-Signature-256` HMAC over the raw request body. Fails closed. */
  verifyWebhook(rawBody: string, signatureHeader: string | null): boolean;
  parseInbound(payload: unknown): WhatsAppInboundMessage[];
}

export class WhatsAppProviderError extends Error {
  constructor(
    readonly reason: 'NOT_CONFIGURED' | 'TEMPLATE_NOT_CONFIGURED' | 'SEND_FAILED',
    detail?: string,
    readonly definitive = reason !== 'SEND_FAILED'
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'WhatsAppProviderError';
  }
}

type Env = Record<string, string | undefined>;

function envValue(env: Env, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

const DEFAULT_ACCOUNT_APPEAL_URL = 'https://business.facebook.com/accountquality';

function accountAppealUrl(value: string | null): string {
  if (!value) return DEFAULT_ACCOUNT_APPEAL_URL;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'business.facebook.com') return url.href;
  } catch {
    // Invalid or untrusted configuration falls back to Meta's canonical account-quality page.
  }
  return DEFAULT_ACCOUNT_APPEAL_URL;
}

export function readWhatsAppConfig(env: Env = process.env): WhatsAppConfig {
  const leadDays = Number(envValue(env, 'PHARMACY_WHATSAPP_REMINDER_LEAD_DAYS') ?? 3);
  return {
    provider: envValue(env, 'PHARMACY_WHATSAPP_PROVIDER') === 'meta' ? 'meta' : 'mock',
    accessToken: envValue(env, 'PHARMACY_WHATSAPP_ACCESS_TOKEN'),
    phoneNumberId: envValue(env, 'PHARMACY_WHATSAPP_PHONE_NUMBER_ID'),
    organizationId: envValue(env, 'PHARMACY_WHATSAPP_ORGANIZATION_ID'),
    appSecret: envValue(env, 'PHARMACY_WHATSAPP_APP_SECRET'),
    verifyToken: envValue(env, 'PHARMACY_WHATSAPP_VERIFY_TOKEN'),
    accountAppealUrl: accountAppealUrl(envValue(env, 'PHARMACY_WHATSAPP_ACCOUNT_APPEAL_URL')),
    graphVersion: envValue(env, 'PHARMACY_WHATSAPP_GRAPH_VERSION') ?? 'v21.0',
    templateLanguage: envValue(env, 'PHARMACY_WHATSAPP_TEMPLATE_LANGUAGE') ?? 'en',
    templates: {
      refillReminder: envValue(env, 'PHARMACY_WHATSAPP_TEMPLATE_REFILL_REMINDER'),
      khataReminder: envValue(env, 'PHARMACY_WHATSAPP_TEMPLATE_KHATA_REMINDER'),
    },
    reminderLeadDays:
      Number.isSafeInteger(leadDays) && leadDays >= 0 && leadDays <= 30 ? leadDays : 3,
  };
}

export function verifyMetaSignature(
  appSecret: string | null,
  rawBody: string,
  signatureHeader: string | null
): boolean {
  if (!appSecret || !signatureHeader?.startsWith('sha256=')) return false;
  const expected = Buffer.from(
    createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex'),
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

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Extracts text messages from a Meta Cloud API `whatsapp_business_account`
 * webhook payload. Status callbacks, media and malformed entries are ignored.
 */
export function parseMetaInbound(payload: unknown): WhatsAppInboundMessage[] {
  const root = record(payload);
  if (!root || root.object !== 'whatsapp_business_account') return [];
  const messages: WhatsAppInboundMessage[] = [];
  for (const entry of list(root.entry)) {
    for (const change of list(record(entry)?.changes)) {
      const value = record(record(change)?.value);
      if (!value) continue;
      const phoneNumberId = record(value.metadata)?.phone_number_id;
      for (const raw of list(value.messages)) {
        const message = record(raw);
        const body = record(message?.text)?.body;
        if (
          !message ||
          message.type !== 'text' ||
          typeof message.id !== 'string' ||
          typeof message.from !== 'string' ||
          !/^\d{8,15}$/.test(message.from) ||
          typeof body !== 'string'
        )
          continue;
        const seconds = Number(message.timestamp);
        if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 8_640_000_000_000) continue;
        messages.push({
          providerMessageId: message.id,
          from: message.from,
          text: body.slice(0, 1000),
          receivedAt: new Date(seconds * 1000),
          phoneNumberId: typeof phoneNumberId === 'string' ? phoneNumberId : null,
        });
      }
    }
  }
  return messages;
}

export class MetaWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'meta' as const;

  constructor(
    private readonly config: WhatsAppConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async post(body: Record<string, unknown>): Promise<WhatsAppSendResult> {
    const { accessToken, phoneNumberId, graphVersion } = this.config;
    if (!accessToken || !phoneNumberId) throw new WhatsAppProviderError('NOT_CONFIGURED');
    const response = await this.fetchImpl(
      `https://graph.facebook.com/${encodeURIComponent(graphVersion)}/${encodeURIComponent(phoneNumberId)}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
        signal: AbortSignal.timeout(10_000),
      }
    );
    const json = (await response.json().catch(() => null)) as {
      messages?: Array<{ id?: unknown }>;
    } | null;
    const id = json?.messages?.[0]?.id;
    if (!response.ok || typeof id !== 'string') {
      throw new WhatsAppProviderError(
        'SEND_FAILED',
        `HTTP ${response.status}`,
        !response.ok && response.status >= 400 && response.status < 500 && response.status !== 408
      );
    }
    return { providerMessageId: id, acceptedByProvider: true };
  }

  sendTemplate(input: { to: string; template: WhatsAppTemplateKey; parameters: string[] }) {
    const name = this.config.templates[input.template];
    if (!name) return Promise.reject(new WhatsAppProviderError('TEMPLATE_NOT_CONFIGURED'));
    return this.post({
      to: input.to,
      type: 'template',
      template: {
        name,
        language: { code: this.config.templateLanguage },
        components: [
          {
            type: 'body',
            parameters: input.parameters.map((text) => ({ type: 'text', text })),
          },
        ],
      },
    });
  }

  sendText(input: { to: string; body: string }) {
    return this.post({
      to: input.to,
      type: 'text',
      text: { preview_url: false, body: input.body },
    });
  }

  verifyWebhook(rawBody: string, signatureHeader: string | null) {
    return verifyMetaSignature(this.config.appSecret, rawBody, signatureHeader);
  }

  parseInbound(payload: unknown) {
    return parseMetaInbound(payload);
  }
}

export type MockWhatsAppCall =
  | {
      kind: 'template';
      to: string;
      template: WhatsAppTemplateKey;
      templateName: string;
      parameters: string[];
    }
  | { kind: 'text'; to: string; body: string };

/** Records every send in memory; never performs network I/O. */
export class MockWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'mock' as const;
  readonly calls: MockWhatsAppCall[] = [];
  private sequence = 0;

  constructor(private readonly config: WhatsAppConfig) {}

  private nextId() {
    this.sequence += 1;
    return { providerMessageId: `mock-wamid-${this.sequence}`, acceptedByProvider: false };
  }

  async sendTemplate(input: { to: string; template: WhatsAppTemplateKey; parameters: string[] }) {
    const templateName = this.config.templates[input.template];
    if (!templateName) throw new WhatsAppProviderError('TEMPLATE_NOT_CONFIGURED');
    this.calls.push({
      kind: 'template',
      ...input,
      parameters: [...input.parameters],
      templateName,
    });
    return this.nextId();
  }

  async sendText(input: { to: string; body: string }) {
    this.calls.push({ kind: 'text', ...input });
    return this.nextId();
  }

  verifyWebhook(rawBody: string, signatureHeader: string | null) {
    return verifyMetaSignature(this.config.appSecret, rawBody, signatureHeader);
  }

  parseInbound(payload: unknown) {
    return parseMetaInbound(payload);
  }
}

/** Provider selected by `PHARMACY_WHATSAPP_PROVIDER` (default `mock`). */
export function createWhatsAppProvider(
  config: WhatsAppConfig = readWhatsAppConfig()
): WhatsAppProvider {
  if (config.provider !== 'meta') return new MockWhatsAppProvider(config);
  const provider = new MetaWhatsAppProvider(config);
  // Owner sender/template approval remains pending. Environment alone cannot enable sending.
  const disabled = async (): Promise<WhatsAppSendResult> => {
    throw new WhatsAppProviderError(
      'NOT_CONFIGURED',
      'Live sending is disabled pending owner approval.'
    );
  };
  return {
    name: 'meta',
    sendText: disabled,
    sendTemplate: disabled,
    verifyWebhook: provider.verifyWebhook.bind(provider),
    parseInbound: provider.parseInbound.bind(provider),
  };
}
