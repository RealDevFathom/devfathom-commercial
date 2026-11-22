import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Outbound webhook URLs are chosen by a tenant. Syntax checks are not enough:
 * a public name can resolve to loopback, a private range, or the cloud
 * metadata address. Resolve first, refuse if any answer is blocked, then
 * connect only to an address that passed that check. `http.request` does not
 * follow redirects, so a 3xx is recorded and not chased.
 */

export class WebhookUrlError extends Error {
  constructor() {
    super('Webhook URL is not allowed.');
    this.name = 'WebhookUrlError';
  }
}

const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal']);

const blocked = new BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(addr, bits, 'ipv4');
}
blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
blocked.addSubnet('::', 96, 'ipv6');
blocked.addSubnet('100::', 64, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('64:ff9b::', 96, 'ipv6');
blocked.addSubnet('64:ff9b:1::', 48, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');
blocked.addSubnet('ff00::', 8, 'ipv6');

export type ResolvedAddress = { address: string; family: number };

export type WebhookLookup = (hostname: string) => Promise<ResolvedAddress[]>;

export type WebhookRequest = (input: {
  url: URL;
  address: string;
  family: number;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}) => Promise<{ statusCode: number }>;

export interface WebhookDeliveryResult {
  statusCode: number | null;
  success: boolean;
  error: string | null;
}

function hostnameOf(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function unwrapMapped(address: string): { address: string; family: 4 | 6 } | null {
  const mapped = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped?.[1] && isIP(mapped[1]) === 4) return { address: mapped[1], family: 4 };
  const family = isIP(address);
  if (family === 4) return { address, family: 4 };
  if (family === 6) return { address, family: 6 };
  return null;
}

export function isBlockedAddress(address: string): boolean {
  const parsed = unwrapMapped(address);
  if (!parsed) return true;
  return blocked.check(parsed.address, parsed.family === 4 ? 'ipv4' : 'ipv6');
}

function blockedHostname(host: string): boolean {
  if (!host || BLOCKED_HOSTS.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))
    return true;
  if (/^\d+$/.test(host)) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) && isIP(host) === 0) return true;
  const parsed = unwrapMapped(host);
  return parsed ? isBlockedAddress(parsed.address) : false;
}

/** Syntax and literal-address checks. Does not resolve DNS. */
export function assertWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlError();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WebhookUrlError();
  if (url.username || url.password) throw new WebhookUrlError();
  if (blockedHostname(hostnameOf(url))) throw new WebhookUrlError();
  return url;
}

export async function resolveWebhookAddresses(
  url: URL,
  lookup: WebhookLookup = defaultLookup
): Promise<ResolvedAddress[]> {
  const host = hostnameOf(url);
  const literal = unwrapMapped(host);
  const answers = literal
    ? [{ address: literal.address, family: literal.family }]
    : await lookup(host);
  if (answers.length === 0 || answers.some((answer) => isBlockedAddress(answer.address))) {
    throw new WebhookUrlError();
  }
  return answers;
}

export async function assertWebhookUrlAllowed(raw: string, lookup?: WebhookLookup): Promise<URL> {
  const url = assertWebhookUrl(raw);
  await resolveWebhookAddresses(url, lookup);
  return url;
}

const defaultLookup: WebhookLookup = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family }));
};

function pinnedRequestOptions(url: URL, target: ResolvedAddress): https.RequestOptions {
  return {
    hostname: hostnameOf(url),
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    agent: false,
    family: target.family,
    lookup: (_hostname, _options, done) => done(null, target.address, target.family),
  };
}

function defaultRequest(input: {
  url: URL;
  address: string;
  family: number;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}): Promise<{ statusCode: number }> {
  const lib = input.url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        ...pinnedRequestOptions(input.url, input),
        method: 'POST',
        headers: { ...input.headers, Host: input.url.host },
        timeout: input.timeoutMs,
      },
      (res) => {
        res.resume();
        resolve({ statusCode: res.statusCode ?? 0 });
      }
    );
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }));
    });
    req.on('error', reject);
    req.end(input.body);
  });
}

/**
 * POST one webhook. The returned `error` is safe to show to the tenant: it is
 * one of a fixed set of sentences and never the raw socket or resolver message.
 */
export async function deliverWebhookRequest(
  rawUrl: string,
  init: { headers: Record<string, string>; body: string; timeoutMs: number },
  deps: { lookup?: WebhookLookup; request?: WebhookRequest } = {}
): Promise<WebhookDeliveryResult> {
  try {
    const url = assertWebhookUrl(rawUrl);
    const [target] = await resolveWebhookAddresses(url, deps.lookup);
    if (!target) return { statusCode: null, success: false, error: 'Webhook URL is not allowed.' };
    const response = await (deps.request ?? defaultRequest)({
      url,
      address: target.address,
      family: target.family,
      headers: init.headers,
      body: init.body,
      timeoutMs: init.timeoutMs,
    });
    const statusCode = response.statusCode;
    if (statusCode >= 200 && statusCode < 300) return { statusCode, success: true, error: null };
    return { statusCode, success: false, error: `HTTP ${statusCode}` };
  } catch (error) {
    if (error instanceof WebhookUrlError) {
      return { statusCode: null, success: false, error: 'Webhook URL is not allowed.' };
    }
    const timedOut =
      (error instanceof Error && error.name === 'AbortError') ||
      (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: string }).code === 'TIMEOUT');
    return {
      statusCode: null,
      success: false,
      error: timedOut ? 'Delivery timed out' : 'Delivery failed',
    };
  }
}

// OIDC uses HTTPS on its standard port. Restrict IPv6 destinations to global
// unicast and exclude special-purpose and documentation prefixes within it.
const globalUnicast = new BlockList();
globalUnicast.addSubnet('2000::', 3, 'ipv6');
const specialUnicast = new BlockList();
specialUnicast.addSubnet('2001::', 23, 'ipv6');
specialUnicast.addSubnet('3fff::', 20, 'ipv6');

function assertPublicDestination(address: string) {
  if (
    isIP(address) === 6 &&
    (!globalUnicast.check(address, 'ipv6') || specialUnicast.check(address, 'ipv6'))
  ) {
    throw new WebhookUrlError();
  }
}

export function assertPublicHttpsUrl(raw: string): URL {
  const url = assertWebhookUrl(raw);
  if (url.protocol !== 'https:' || url.port || url.hash) throw new WebhookUrlError();
  assertPublicDestination(hostnameOf(url));
  return url;
}

export async function resolvePublicHttpsUrl(raw: string, signal = AbortSignal.timeout(10_000)) {
  const url = assertPublicHttpsUrl(raw);
  signal.throwIfAborted();
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  const answers = await Promise.race([resolveWebhookAddresses(url), aborted]).finally(() =>
    signal.removeEventListener('abort', abort)
  );
  for (const answer of answers) assertPublicDestination(answer.address);
  return { url, target: answers[0]! };
}

/** One pinned TLS connection. Original Host and certificate identity are
 * preserved. Node does not follow redirects or decompress the response. */
export async function fetchPublicHttps(
  raw: string,
  options: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    maxBytes: number;
    signal?: AbortSignal;
  }
): Promise<Response> {
  const deadline = AbortSignal.timeout(10_000);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const { url, target } = await resolvePublicHttpsUrl(raw, signal);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        ...pinnedRequestOptions(url, target),
        method: options.method,
        headers: { ...options.headers, host: url.host, 'accept-encoding': 'identity' },
        signal,
      },
      async (res) => {
        try {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) throw new Error('Identity provider request failed.');
          if (Number(res.headers['content-length']) > options.maxBytes)
            throw new Error('Identity provider response too large.');
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of res) {
            bytes += chunk.length;
            if (bytes > options.maxBytes) throw new Error('Identity provider response too large.');
            chunks.push(chunk);
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status,
              headers: {
                'content-type': res.headers['content-type'] ?? 'application/octet-stream',
              },
            })
          );
        } catch (error) {
          res.destroy();
          reject(error);
        }
      }
    );
    req.on('error', reject);
    req.end(options.body);
  });
}
