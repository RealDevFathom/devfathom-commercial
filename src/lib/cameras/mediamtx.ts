import { request as httpsRequest } from 'node:https';
import { isIPv4 } from 'node:net';

/**
 * The product surface a binding serves. Restaurant and pharmacy cameras live in
 * separate tables, so a binding must name its vertical: an identifier from one
 * vertical can never select a stream bound for the other. Bindings written
 * before pharmacy support omit the field and remain restaurant-only.
 */
export type CameraBindingVertical = 'restaurant' | 'pharmacy';
const VERTICALS: readonly CameraBindingVertical[] = ['restaurant', 'pharmacy'];

export type CameraBindingScope = {
  /** Omitted means restaurant, matching bindings written before pharmacy support. */
  vertical?: CameraBindingVertical;
  organizationId: string;
  branchId: string;
  gatewayId: string;
  cameraId: string;
  baseUrl: string;
};

type Binding = Omit<CameraBindingScope, 'vertical'> & {
  vertical: CameraBindingVertical;
  address: string;
  path: string;
  username?: string;
  password?: string;
};

export type CameraTransportFailure =
  | 'not-configured'
  | 'credentials-missing'
  | 'auth-failed'
  | 'gateway-unreachable'
  | 'unsupported-stream';

export class CameraTransportError extends Error {
  constructor(readonly code: CameraTransportFailure) {
    super(code);
    this.name = 'CameraTransportError';
  }
}

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
const DEADLINE_MS = 10_000;
// MediaMTX's ordinary HLS/fMP4 files are flat. Refuse URL syntax, escapes,
// directories and query strings rather than interpreting attacker-controlled URLs.
const RESOURCE = /^[A-Za-z0-9_-][A-Za-z0-9_-]*\.(m3u8|ts|mp4|m4s)$/;
const PATH = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

/**
 * A registered gateway base URL must be exactly `https://hostname[:port]/`: no
 * IP literal, credentials, path, query or fragment. The URL alone never causes
 * an outbound request; the server-side binding remains the allowlist.
 */
export function isCameraGatewayBaseUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length > 500) return false;
  let base: URL;
  try {
    base = new URL(value);
  } catch {
    return false;
  }
  return (
    base.protocol === 'https:' &&
    /^[a-z][a-z0-9.-]*$/i.test(base.hostname) &&
    !base.username &&
    !base.password &&
    !base.search &&
    !base.hash &&
    base.pathname === '/' &&
    base.href === value
  );
}

/** A flat or slash-separated gateway path name; never a URL, query or traversal. */
export function isCameraGatewayPath(value: string): boolean {
  return typeof value === 'string' && value.length <= 120 && PATH.test(value);
}

export function cameraResourceName(value: string): string {
  if (!RESOURCE.test(value) || value.length > 200)
    throw new CameraTransportError('unsupported-stream');
  return value;
}

function parseBindings(raw: string): Binding[] {
  try {
    const bindings: unknown = JSON.parse(raw);
    if (!Array.isArray(bindings) || !bindings.length || bindings.length > 256) throw new Error();
    const cameras = new Set<string>();
    const streams = new Set<string>();
    return bindings.map((value: unknown) => {
      if (!value || typeof value !== 'object') throw new Error();
      const row = value as Record<string, unknown>;
      const required = [
        'organizationId',
        'branchId',
        'gatewayId',
        'cameraId',
        'baseUrl',
        'address',
        'path',
      ];
      if (
        Object.keys(row).some(
          (key) => ![...required, 'vertical', 'username', 'password'].includes(key)
        )
      )
        throw new Error();
      if (row.vertical !== undefined && !VERTICALS.includes(row.vertical as CameraBindingVertical))
        throw new Error();
      for (const key of required)
        if (typeof row[key] !== 'string' || !row[key] || row[key].length > 500) throw new Error();
      for (const key of ['username', 'password'])
        if (
          row[key] !== undefined &&
          (typeof row[key] !== 'string' || row[key].length > 1024 || /[\r\n]/.test(row[key]))
        )
          throw new Error();
      const binding = {
        ...(row as Omit<Binding, 'vertical'>),
        vertical: (row.vertical ?? 'restaurant') as CameraBindingVertical,
      };
      if (!isCameraGatewayBaseUrl(binding.baseUrl)) throw new Error();
      const base = new URL(binding.baseUrl);
      // Explicit private IPv4 routing only; no DNS, loopback, metadata or public targets.
      const octets = binding.address.split('.').map(Number);
      if (
        !isIPv4(binding.address) ||
        !(
          octets[0] === 10 ||
          (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
          (octets[0] === 192 && octets[1] === 168)
        )
      )
        throw new Error();
      if (!PATH.test(binding.path) || binding.username?.includes(':')) throw new Error();
      const cameraKey = JSON.stringify([
        binding.vertical,
        binding.organizationId,
        binding.cameraId,
      ]);
      const streamKey = `${base.origin}/${binding.path}`;
      if (cameras.has(cameraKey) || streams.has(streamKey)) throw new Error();
      cameras.add(cameraKey);
      streams.add(streamKey);
      return binding;
    });
  } catch {
    throw new CameraTransportError('not-configured');
  }
}

// Explicit tag allowlist. Unknown extensions must not pass new URL-bearing
// attributes straight to the browser. Low-latency HLS and encrypted HLS are
// intentionally unsupported; configure MediaMTX hlsVariant: fmp4 or mpegts.
const TAGS = new Set([
  '#EXTM3U',
  '#EXT-X-VERSION',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-STREAM-INF',
  '#EXT-X-TARGETDURATION',
  '#EXT-X-MEDIA-SEQUENCE',
  '#EXT-X-DISCONTINUITY-SEQUENCE',
  '#EXT-X-PLAYLIST-TYPE',
  '#EXT-X-ENDLIST',
  '#EXT-X-DISCONTINUITY',
  '#EXT-X-GAP',
  '#EXT-X-PROGRAM-DATE-TIME',
  '#EXTINF',
  '#EXT-X-MAP',
  '#EXT-X-MEDIA',
  '#EXT-X-BYTERANGE',
]);

export function rewriteCameraManifest(text: string, resourceUrl: (name: string) => string): string {
  if (!text.startsWith('#EXTM3U\n') && !text.startsWith('#EXTM3U\r\n'))
    throw new CameraTransportError('unsupported-stream');
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line) return line;
      if (!line.startsWith('#')) return resourceUrl(cameraResourceName(line));
      const tag = line.split(':', 1)[0];
      if (!TAGS.has(tag)) throw new CameraTransportError('unsupported-stream');
      // Drop titles, date metadata and device-controlled comments. Keep only the
      // numeric EXTINF duration so untrusted metadata cannot leak source URLs.
      if (tag === '#EXTINF') {
        const duration = /^#EXTINF:(\d+(?:\.\d+)?),/.exec(line)?.[1];
        if (!duration) throw new CameraTransportError('unsupported-stream');
        return `#EXTINF:${duration},`;
      }
      if (tag === '#EXT-X-PROGRAM-DATE-TIME') return '';
      if (/[\u0000-\u001f\u007f]|:\/\/|@|\\/.test(line))
        throw new CameraTransportError('unsupported-stream');
      let count = 0;
      const rewritten = line.replace(/\bURI="([^"]*)"/g, (_match, name: string) => {
        count++;
        return `URI="${resourceUrl(cameraResourceName(name))}"`;
      });
      if (
        (line.match(/URI\s*=/gi)?.length ?? 0) !== count ||
        count > 1 ||
        (count > 0 && tag !== '#EXT-X-MAP' && tag !== '#EXT-X-MEDIA')
      )
        throw new CameraTransportError('unsupported-stream');
      return rewritten;
    })
    .join('\n');
}

export function createMediaMtxTransport(raw: string, request = httpsRequest) {
  const bindings = parseBindings(raw);
  let active = 0;

  async function read(scope: CameraBindingScope, resource = 'index.m3u8') {
    cameraResourceName(resource);
    const vertical = scope.vertical ?? 'restaurant';
    const binding = bindings.find(
      (row) =>
        row.vertical === vertical &&
        row.organizationId === scope.organizationId &&
        row.branchId === scope.branchId &&
        row.gatewayId === scope.gatewayId &&
        row.cameraId === scope.cameraId &&
        row.baseUrl === scope.baseUrl
    );
    if (!binding) throw new CameraTransportError('not-configured');
    if (!binding.username || !binding.password)
      throw new CameraTransportError('credentials-missing');
    if (active >= 16) throw new CameraTransportError('gateway-unreachable');
    const manifest = resource.endsWith('.m3u8');
    const maximum = manifest ? MAX_MANIFEST_BYTES : MAX_SEGMENT_BYTES;
    const target = new URL(`${binding.path}/${resource}`, binding.baseUrl);
    active++;
    try {
      const bytes = await new Promise<Buffer>((resolve, reject) => {
        const fail = (code: CameraTransportFailure) => reject(new CameraTransportError(code));
        const req = request(
          target,
          {
            method: 'GET',
            agent: false,
            family: 4,
            rejectUnauthorized: true,
            // Connect only to the configured address while retaining TLS hostname
            // verification. No attacker-controlled DNS or redirect can change it.
            lookup: (_host, _options, callback) => callback(null, binding.address, 4),
            headers: {
              Authorization: `Basic ${Buffer.from(`${binding.username}:${binding.password}`).toString('base64')}`,
              'Accept-Encoding': 'identity',
            },
          },
          (res) => {
            const status = res.statusCode ?? 0;
            if (
              status !== 200 ||
              Number(res.headers['content-length'] ?? 0) > maximum ||
              res.headers['content-encoding']
            ) {
              fail(
                status === 401 || status === 403
                  ? 'auth-failed'
                  : status === 404 || status === 415
                    ? 'unsupported-stream'
                    : 'gateway-unreachable'
              );
              res.destroy();
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > maximum) {
                fail('unsupported-stream');
                res.destroy();
              } else chunks.push(chunk);
            });
            res.on('error', () => fail('gateway-unreachable'));
            res.on('end', () => resolve(Buffer.concat(chunks)));
          }
        );
        const timer = setTimeout(
          () => req.destroy(new CameraTransportError('gateway-unreachable')),
          DEADLINE_MS
        );
        req.on('error', () => fail('gateway-unreachable'));
        req.on('close', () => clearTimeout(timer));
        req.end();
      });
      return {
        bytes,
        manifest,
        contentType: manifest
          ? 'application/vnd.apple.mpegurl'
          : resource.endsWith('.ts')
            ? 'video/mp2t'
            : 'video/mp4',
      };
    } catch (error) {
      if (error instanceof CameraTransportError) throw error;
      throw new CameraTransportError('gateway-unreachable');
    } finally {
      active--;
    }
  }

  return {
    read,
    async diagnose(scope: CameraBindingScope) {
      try {
        const result = await read(scope);
        rewriteCameraManifest(result.bytes.toString('utf8'), (name) => name);
        return { outcome: 'ok' as const, discoveredProfile: 'Configured HLS gateway' };
      } catch (error) {
        return {
          outcome:
            error instanceof CameraTransportError ? error.code : ('gateway-unreachable' as const),
        };
      }
    },
  };
}
