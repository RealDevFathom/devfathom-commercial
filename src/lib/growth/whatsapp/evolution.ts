import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import { decryptSecret } from '@/lib/secret-crypto';
import {
  assertWebhookUrl,
  isBlockedAddress as webhookAddressBlocked,
  resolveWebhookAddresses,
  type WebhookLookup,
} from '@/lib/webhooks/safe-url';

import type { GrowthSettings } from './types';
import type { WhatsAppConnection, WhatsAppProvider, WhatsAppSendResult } from './provider';

/** Hex IPv4-mapped forms are not a dotted address, so they fail closed. */
function isBlockedAddress(address: string): boolean {
  if (
    address.toLowerCase().startsWith('::ffff:') &&
    !/^::ffff:(?:\d{1,3}\.){3}\d{1,3}$/i.test(address)
  ) {
    return true;
  }
  return webhookAddressBlocked(address);
}

function webhookLookup(resolve: HostLookup): WebhookLookup {
  return async (hostname) =>
    (await resolve(hostname)).map((address) => ({
      address,
      family: isIP(address) === 6 ? 6 : 4,
    }));
}

export type HostLookup = (hostname: string) => Promise<readonly string[]>;

async function publicLookup(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

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

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function sameOrigin(left: string, right: string): boolean {
  const a = httpUrl(left);
  const b = httpUrl(right);
  return Boolean(a && b && a.origin === b.origin);
}

type NodeRequest = typeof httpsRequest;

/**
 * Fetch that connects to the address resolved for this call. A later DNS answer
 * cannot move the socket. A private address is refused unless this origin is the
 * configured Evolution allowlist.
 */
export function createPinnedFetch(
  resolve: HostLookup,
  allowPrivate: boolean,
  requestImpl: { http: NodeRequest; https: NodeRequest } = {
    http: httpRequest,
    https: httpsRequest,
  }
): typeof fetch {
  return async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    const addresses =
      isIP(url.hostname) !== 0 ? [url.hostname] : await resolve(url.hostname.replace(/\.$/, ''));
    if (
      addresses.length === 0 ||
      (!allowPrivate && addresses.some((address) => isBlockedAddress(address)))
    ) {
      throw new Error('Evolution URL is not allowed.');
    }
    const pinned = addresses[0];
    if (!pinned) throw new Error('Evolution URL is not allowed.');
    const library = url.protocol === 'https:' ? requestImpl.https : requestImpl.http;
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : null;
    const status = await new Promise<{ status: number; text: string }>(
      (resolveResponse, reject) => {
        const request = library(
          url,
          {
            method,
            headers: Object.fromEntries(headers.entries()),
            servername: url.hostname,
            lookup: (_hostname, options, callback) => {
              const family = isIP(pinned) === 6 ? 6 : 4;
              if (options.all) {
                callback(null, [{ address: pinned, family }]);
                return;
              }
              callback(null, pinned, family);
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () =>
              resolveResponse({
                status: response.statusCode ?? 0,
                text: Buffer.concat(chunks).toString('utf8'),
              })
            );
          }
        );
        request.setTimeout(10_000, () =>
          request.destroy(new Error('Evolution request timed out.'))
        );
        request.on('error', reject);
        if (body) request.write(body);
        request.end();
      }
    );
    return new Response(status.text, { status: status.status });
  };
}

/** True for an https origin whose host does not resolve to a private or metadata address. */
export async function isPublicHttpsUrl(value: string, resolve: HostLookup): Promise<boolean> {
  try {
    const url = assertWebhookUrl(value);
    if (url.protocol !== 'https:') return false;
    await resolveWebhookAddresses(url, webhookLookup(resolve));
    return true;
  } catch {
    return false;
  }
}

/**
 * The env base URL is the allowlist and may use `EVOLUTION_API_KEY`. A different
 * per-tenant URL must be public https and uses only that tenant's own key.
 */
export async function resolveEvolutionConfig(
  settings: GrowthSettings | null,
  env: NodeJS.ProcessEnv = process.env,
  resolve: HostLookup = publicLookup
): Promise<EvolutionConfig | null> {
  const envUrl = (env.EVOLUTION_API_URL || '').trim().replace(/\/$/, '');
  const tenantUrl = (settings?.waApiUrl || '').trim().replace(/\/$/, '');
  const instance = (settings?.waInstanceName || settings?.organizationId || '').trim();
  const globalKey = (env.EVOLUTION_API_KEY || '').trim();
  let tenantKey = '';
  if (settings?.waApiKeyEnc) {
    try {
      tenantKey = decryptSecret(settings.waApiKeyEnc).trim();
    } catch {
      return null;
    }
  }
  if (!instance) return null;

  if (tenantUrl && !(envUrl && sameOrigin(tenantUrl, envUrl))) {
    if (!tenantKey || !(await isPublicHttpsUrl(tenantUrl, resolve))) return null;
    return { baseUrl: tenantUrl, apiKey: tenantKey, instance };
  }

  const baseUrl = tenantUrl || envUrl;
  const apiKey = tenantKey || globalKey;
  if (!httpUrl(baseUrl) || !apiKey) return null;
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
      redirect: 'manual',
      headers: {
        apikey: this.config.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ number, text: body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status >= 300 && response.status < 400) throw new Error(`HTTP ${response.status}`);
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
        redirect: 'manual',
        headers: { apikey: this.config.apiKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status >= 300 && response.status < 400) return 'unavailable';
      if (!response.ok) return 'unavailable';
      const state = connectionState(await response.json().catch(() => null));
      if (state === 'open') return 'connected';
      return 'needs_pairing';
    } catch {
      return 'unavailable';
    }
  }
}

export async function createEvolutionProvider(
  settings: GrowthSettings | null,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchImpl,
  resolve: HostLookup = publicLookup
): Promise<WhatsAppProvider | null> {
  const config = await resolveEvolutionConfig(settings, env, resolve);
  if (!config) return null;
  const envUrl = (env.EVOLUTION_API_URL || '').trim();
  const allowPrivate = Boolean(envUrl && sameOrigin(config.baseUrl, envUrl));
  return new EvolutionWhatsAppProvider(
    config,
    fetchImpl ?? createPinnedFetch(resolve, allowPrivate)
  );
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
