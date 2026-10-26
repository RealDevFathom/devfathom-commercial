import 'server-only';

import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const ALLOWED_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
]);

const denied = new BlockList();
for (const [network, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['2001::', 23, 'ipv6'],
  ['2002::', 16, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
] as const) {
  denied.addSubnet(network, prefix, family);
}

function isUnsafeAddress(address: string) {
  const normalized = address.toLowerCase().split('%')[0] ?? address;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return denied.check(mapped, 'ipv4');
  const family = isIP(normalized);
  if (family === 4) return denied.check(normalized, 'ipv4');
  if (family !== 6) return true;
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
  return first < 0x2000 || first > 0x3fff || denied.check(normalized, 'ipv6');
}

export type RemoteImage = { body: Uint8Array; contentType: string };

/** Fetch a public HTTPS image while pinning the validated DNS result to prevent SSRF/rebinding. */
export async function loadRemoteImage(value: string): Promise<RemoteImage> {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Logo must use a public HTTPS URL.');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    (isIP(hostname) !== 0 && isUnsafeAddress(hostname))
  ) {
    throw new Error('Logo URL may not target a local or private network.');
  }
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await dnsLookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isUnsafeAddress(address))) {
    throw new Error('Logo URL may not resolve to a local or private network.');
  }
  const target = addresses[0]!;

  return new Promise((resolve, reject) => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = <T>(callback: (value: T) => void, value: T) => {
      if (deadline) clearTimeout(deadline);
      callback(value);
    };
    const request = httpsRequest(url, {
      method: 'GET',
      servername: hostname,
      headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml' },
      lookup: (_host, _options, callback) => callback(null, target.address, target.family),
    });
    deadline = setTimeout(
      () => request.destroy(new Error('Logo request timed out.')),
      REQUEST_TIMEOUT_MS
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () =>
      request.destroy(new Error('Logo request timed out.'))
    );
    request.on('error', (error) => finish(reject, error));
    request.on('response', (response) => {
      const contentType = (response.headers['content-type'] ?? '').split(';')[0]!.toLowerCase();
      if (response.statusCode !== 200 || !ALLOWED_TYPES.has(contentType)) {
        response.resume();
        finish(reject, new Error('Logo server did not return a supported image.'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) request.destroy(new Error('Logo exceeds the size limit.'));
        else chunks.push(chunk);
      });
      response.on('end', () =>
        finish(resolve, { body: Buffer.concat(chunks), contentType })
      );
      response.on('error', (error) => finish(reject, error));
    });
    request.end();
  });
}
