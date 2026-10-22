import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { decryptSecret } from '@/lib/secret-crypto';
import {
  assertWhatsAppSendAllowed,
  type WhatsAppAdapter,
  type WhatsAppInboundMessage,
  type WhatsAppSendResult,
  type WhatsAppSessionTextSend,
  type WhatsAppTemplateSend,
} from './adapter';

export type WhatsAppCloudApiConfig = {
  phoneNumberId: string;
  /** Ciphertext produced by encryptSecret; plaintext tokens are never accepted. */
  encryptedAccessToken: string;
  /** Ciphertext produced by encryptSecret; used for X-Hub-Signature-256 verification. */
  encryptedAppSecret: string;
  graphVersion?: string;
};

export class WhatsAppCloudApiError extends Error {
  constructor(
    readonly status: number,
    message = 'WhatsApp Cloud API request failed.'
  ) {
    super(message);
    this.name = 'WhatsAppCloudApiError';
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Parse only supported text messages; status updates and malformed records are ignored. */
export function parseCloudApiWebhook(payload: unknown): WhatsAppInboundMessage[] {
  const root = object(payload);
  if (root?.object !== 'whatsapp_business_account') return [];
  const result: WhatsAppInboundMessage[] = [];
  for (const entry of array(root.entry)) {
    for (const change of array(object(entry)?.changes)) {
      const value = object(object(change)?.value);
      const phoneNumberId = object(value?.metadata)?.phone_number_id;
      for (const rawMessage of array(value?.messages)) {
        const message = object(rawMessage);
        const text = object(message?.text)?.body;
        const timestamp = Number(message?.timestamp);
        if (
          message?.type !== 'text' ||
          typeof message.id !== 'string' ||
          typeof message.from !== 'string' ||
          !/^\d{8,15}$/.test(message.from) ||
          typeof text !== 'string' ||
          !Number.isSafeInteger(timestamp) ||
          timestamp <= 0
        )
          continue;
        result.push({
          providerMessageId: message.id,
          from: message.from,
          text,
          receivedAt: new Date(timestamp * 1000),
          phoneNumberId: typeof phoneNumberId === 'string' ? phoneNumberId : null,
        });
      }
    }
  }
  return result;
}

export class WhatsAppCloudApiAdapter implements WhatsAppAdapter {
  private readonly graphVersion: string;

  constructor(
    private readonly config: WhatsAppCloudApiConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.graphVersion = config.graphVersion ?? 'v21.0';
  }

  private async send(body: Record<string, unknown>): Promise<WhatsAppSendResult> {
    const accessToken = decryptSecret(this.config.encryptedAccessToken);
    const response = await this.fetchImpl(
      `https://graph.facebook.com/${encodeURIComponent(this.graphVersion)}/${encodeURIComponent(this.config.phoneNumberId)}/messages`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
        signal: AbortSignal.timeout(10_000),
      }
    );
    const payload = (await response.json().catch(() => null)) as {
      messages?: Array<{ id?: unknown }>;
    } | null;
    const providerMessageId = payload?.messages?.[0]?.id;
    if (!response.ok || typeof providerMessageId !== 'string') {
      throw new WhatsAppCloudApiError(response.status);
    }
    return { providerMessageId };
  }

  sendTemplate(input: WhatsAppTemplateSend): Promise<WhatsAppSendResult> {
    assertWhatsAppSendAllowed(input);
    return this.send({
      to: input.to,
      type: 'template',
      template: {
        name: input.templateName,
        language: { code: input.languageCode },
        components: input.parameters?.length
          ? [{ type: 'body', parameters: input.parameters.map((text) => ({ type: 'text', text })) }]
          : [],
      },
    });
  }

  sendSessionText(input: WhatsAppSessionTextSend): Promise<WhatsAppSendResult> {
    assertWhatsAppSendAllowed(input);
    return this.send({
      to: input.to,
      type: 'text',
      text: { preview_url: false, body: input.body },
    });
  }

  verifyWebhook(rawBody: string | Uint8Array, signature: string | null): boolean {
    if (!signature?.startsWith('sha256=')) return false;
    const suppliedHex = signature.slice(7);
    if (!/^[a-f\d]{64}$/i.test(suppliedHex)) return false;
    const secret = decryptSecret(this.config.encryptedAppSecret);
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    const supplied = Buffer.from(suppliedHex, 'hex');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  parseWebhook(payload: unknown): WhatsAppInboundMessage[] {
    return parseCloudApiWebhook(payload);
  }
}
