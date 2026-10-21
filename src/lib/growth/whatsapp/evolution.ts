import { decryptSecret } from '@/lib/secret-crypto';

import type { GrowthSettings } from './types';
import type { WhatsAppConnection, WhatsAppProvider, WhatsAppSendResult } from './provider';

export type EvolutionConfig = {
  baseUrl: string;
  apiKey: string;
  instance: string;
};

type FetchImpl = typeof fetch;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function evolutionConfigFrom(
  settings: GrowthSettings | null,
  env: NodeJS.ProcessEnv = process.env
): EvolutionConfig | null {
  const baseUrl = (settings?.waApiUrl || env.EVOLUTION_API_URL || '').trim().replace(/\/$/, '');
  const instance = (settings?.waInstanceName || settings?.organizationId || '').trim();
  let apiKey = (env.EVOLUTION_API_KEY || '').trim();
  if (settings?.waApiKeyEnc) apiKey = decryptSecret(settings.waApiKeyEnc);
  if (!baseUrl || !apiKey || !instance) return null;
  return { baseUrl, apiKey, instance };
}

export function evolutionConfigured(
  settings: GrowthSettings | null,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const baseUrl = (settings?.waApiUrl || env.EVOLUTION_API_URL || '').trim();
  const instance = (settings?.waInstanceName || settings?.organizationId || '').trim();
  const hasKey = Boolean(settings?.waApiKeyEnc || env.EVOLUTION_API_KEY?.trim());
  return Boolean(baseUrl && instance && hasKey);
}

function messageId(payload: unknown): string | null {
  const root = record(payload);
  const key = record(root?.key);
  if (text(key?.id)) return key?.id as string;
  const message = record(root?.message);
  const messageKey = record(message?.key);
  if (text(messageKey?.id)) return messageKey?.id as string;
  return text(root?.id);
}

function connectionState(payload: unknown): string | null {
  const root = record(payload);
  const instance = record(root?.instance);
  return text(instance?.state) ?? text(root?.state);
}

/**
 * Evolution API v2. `fetchImpl` is injectable so tests never touch the network.
 * Numbers are sent as digits; the caller passes E.164.
 */
export class EvolutionWhatsAppProvider implements WhatsAppProvider {
  constructor(
    private readonly config: EvolutionConfig,
    private readonly fetchImpl: FetchImpl = fetch
  ) {}

  async sendText(to: string, body: string): Promise<WhatsAppSendResult> {
    const number = to.replace(/\D/g, '');
    const url = `${this.config.baseUrl}/message/sendText/${encodeURIComponent(this.config.instance)}`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        apikey: this.config.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ number, text: body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = (await response.json().catch(() => null)) as unknown;
    const id = messageId(json);
    if (!id) throw new Error('Evolution response missing message id');
    return { providerMessageId: id };
  }

  async getStatus(): Promise<WhatsAppConnection> {
    const url = `${this.config.baseUrl}/instance/connectionState/${encodeURIComponent(this.config.instance)}`;
    try {
      const response = await this.fetchImpl(url, {
        headers: { apikey: this.config.apiKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return 'unavailable';
      const state = connectionState(await response.json().catch(() => null));
      if (state === 'open') return 'connected';
      return 'needs_pairing';
    } catch {
      return 'unavailable';
    }
  }
}

export function createEvolutionProvider(
  settings: GrowthSettings | null,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchImpl = fetch
): WhatsAppProvider | null {
  const config = evolutionConfigFrom(settings, env);
  if (!config) return null;
  return new EvolutionWhatsAppProvider(config, fetchImpl);
}

export type ParsedWebhook =
  | {
      kind: 'inbound';
      instance: string;
      waMessageId: string;
      fromE164: string;
      text: string;
    }
  | {
      kind: 'status';
      instance: string;
      waMessageId: string;
      status: 'sent' | 'delivered' | 'read' | 'failed';
    }
  | { kind: 'ignore'; instance: string | null };

function jidToE164(jid: string): string | null {
  if (jid.endsWith('@g.us')) return null;
  const user = jid.split('@')[0] ?? '';
  if (!/^\d{8,15}$/.test(user)) return null;
  return `+${user}`;
}

function messageText(message: unknown): string | null {
  const value = record(message);
  if (!value) return null;
  if (typeof value.conversation === 'string') return value.conversation;
  const extended = record(value.extendedTextMessage);
  if (typeof extended?.text === 'string') return extended.text;
  return null;
}

function mapStatus(value: unknown): 'sent' | 'delivered' | 'read' | 'failed' | null {
  if (typeof value === 'number') {
    if (value <= 0) return 'failed';
    if (value === 1 || value === 2) return 'sent';
    if (value === 3) return 'delivered';
    if (value >= 4) return 'read';
  }
  if (typeof value !== 'string') return null;
  const status = value.toUpperCase();
  if (status === 'DELIVERY_ACK' || status === 'DELIVERED') return 'delivered';
  if (status === 'READ' || status === 'PLAYED') return 'read';
  if (status === 'ERROR' || status === 'FAILED') return 'failed';
  if (status === 'SERVER_ACK' || status === 'SENT' || status === 'PENDING') return 'sent';
  return null;
}

function firstRecord(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) return record(data[0]);
  return record(data);
}

function parseUpsert(instance: string, data: unknown): ParsedWebhook {
  const value = firstRecord(data);
  const key = record(value?.key);
  if (!value || !key || key.fromMe === true) return { kind: 'ignore', instance };
  const waMessageId = text(key.id);
  const remoteJid = text(key.remoteJid);
  const body = messageText(value.message);
  if (!waMessageId || !remoteJid || !body?.trim()) return { kind: 'ignore', instance };
  const fromE164 = jidToE164(remoteJid);
  if (!fromE164) return { kind: 'ignore', instance };
  return { kind: 'inbound', instance, waMessageId, fromE164, text: body };
}

function parseUpdate(instance: string, data: unknown): ParsedWebhook {
  const value = firstRecord(data);
  if (!value) return { kind: 'ignore', instance };
  const key = record(value.key);
  const update = record(value.update);
  const waMessageId = text(value.keyId) ?? text(value.messageId) ?? text(key?.id);
  const status = mapStatus(value.status ?? update?.status);
  if (!waMessageId || !status) return { kind: 'ignore', instance };
  return { kind: 'status', instance, waMessageId, status };
}

/** Unknown events become `{ kind: 'ignore' }` so the webhook can answer 200. */
export function parseEvolutionWebhook(payload: unknown): ParsedWebhook | null {
  const root = record(payload);
  if (!root) return null;
  const event = String(root.event ?? '')
    .toLowerCase()
    .replace(/_/g, '.');
  const instance = text(root.instance);
  if (!event) return null;
  if (!instance) return { kind: 'ignore', instance: null };
  if (event === 'messages.upsert') return parseUpsert(instance, root.data);
  if (event === 'messages.update') return parseUpdate(instance, root.data);
  return { kind: 'ignore', instance };
}
