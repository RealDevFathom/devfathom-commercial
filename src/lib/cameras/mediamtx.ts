import { request as httpsRequest } from 'node:https';
import { isIPv4 } from 'node:net';

import { isH265Codec } from './diagnostic-messages';

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
  | 'unsupported-stream'
  /** The relay answered with a flow this client does not support (version or set-up). */
  | 'relay-unsupported';

export class CameraTransportError extends Error {
  constructor(readonly code: CameraTransportFailure) {
    super(code);
    this.name = 'CameraTransportError';
  }
}

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
/**
 * One deadline per read (DEV-1004): every request a read makes (the playlist, the relay's
 * session step, a renewal and the retry) shares it, so a slow relay cannot stretch one read to
 * several times this.
 */
export const CAMERA_READ_DEADLINE_MS = 10_000;
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

/** The video codec named by a playlist's CODECS attributes; never a guess from bytes. */
export type CameraVideoCodec = 'h264' | 'h265' | 'unknown';

/**
 * H.264 (`avc1`/`avc3`) or H.265 (`hvc1`/`hev1`) from `CODECS="…"` in a master
 * playlist. The app never transcodes, so an H.265 camera plays only where the
 * browser itself decodes H.265.
 */
export function cameraVideoCodec(manifest: string): CameraVideoCodec {
  const codecs = [...manifest.matchAll(/\bCODECS="([^"]*)"/g)].flatMap((match) =>
    match[1].split(',').map((codec) => codec.trim().toLowerCase())
  );
  if (codecs.some(isH265Codec)) return 'h265';
  if (codecs.some((codec) => codec.startsWith('avc1') || codec.startsWith('avc3'))) return 'h264';
  return 'unknown';
}

// MediaMTX v1.18.0+ HLS sessions (internal/servers/hls/http_server.go, session.go,
// muxer_instance.go): GET <path>/index.m3u8 answers 302 to the same path with
// `?cookieCheck=1`; that request checks the reader login and opens a session whose
// UUID secret arrives as the `hlsSession` cookie (or a `session` query parameter for
// clients without cookies). Later playlist and segment requests must carry it from
// the same client address; the relay drops a session after 30 s without requests.
const COOKIE_CHECK = 'cookieCheck=1';
const SESSION_COOKIE = 'hlsSession';
const SESSION_SECRET = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_QUERY =
  /\?session=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=["\r\n]|$)/gm;

type Upstream = { status: number; location?: string; cookies: string[]; bytes: Buffer };

function sessionCookie(cookies: string[]): string | undefined {
  const values = cookies
    .map((cookie) => cookie.split(';', 1)[0].trim())
    .filter((pair) => pair.startsWith(`${SESSION_COOKIE}=`))
    .map((pair) => pair.slice(SESSION_COOKIE.length + 1));
  if (!values.length) return undefined;
  // Older releases send the same value twice (plain and partitioned); anything else
  // is not a session this client understands.
  if (values.some((value) => value !== values[0] || !SESSION_SECRET.test(value)))
    throw new CameraTransportError('relay-unsupported');
  return values[0];
}

/**
 * Remove the relay session secret from playlist references so the bytes handed to
 * the route (and so to the browser) never contain it, then prove it is gone.
 */
function withoutSessionSecret(bytes: Buffer, known?: string) {
  let text = bytes.toString('utf8');
  const found = new Set([...text.matchAll(SESSION_QUERY)].map((match) => match[1]));
  if (found.size > 1 || (known && found.size === 1 && !found.has(known)))
    throw new CameraTransportError('relay-unsupported');
  const secret = known ?? [...found][0];
  if (!secret) return { bytes, secret };
  text = text.replace(SESSION_QUERY, '');
  if (text.includes(secret)) throw new CameraTransportError('unsupported-stream');
  return { bytes: Buffer.from(text, 'utf8'), secret };
}

export function createMediaMtxTransport(raw: string, request = httpsRequest) {
  const bindings = parseBindings(raw);
  let active = 0;
  // Latest relay session per binding: at most one entry per configured binding.
  // Server-side only; never returned, logged or sent anywhere but its own relay.
  const sessions = new Map<Binding, string>();
  const renewing = new Map<Binding, Promise<string | undefined>>();

  function get(
    binding: Binding,
    pathAndQuery: string,
    maximum: number,
    deadline: number,
    session?: string
  ): Promise<Upstream> {
    const target = new URL(`${binding.path}/${pathAndQuery}`, binding.baseUrl);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new CameraTransportError('gateway-unreachable'));
    return new Promise<Upstream>((resolve, reject) => {
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
            // `cookieCheck=1` keeps the relay in cookie mode, so its playlists name
            // segments without the session secret in a query string.
            Cookie: session ? `${COOKIE_CHECK}; ${SESSION_COOKIE}=${session}` : COOKIE_CHECK,
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const location = res.headers.location;
          const cookies = res.headers['set-cookie'] ?? [];
          if (status !== 200) {
            res.destroy();
            resolve({ status, location, cookies, bytes: Buffer.alloc(0) });
            return;
          }
          if (
            Number(res.headers['content-length'] ?? 0) > maximum ||
            res.headers['content-encoding']
          ) {
            fail('gateway-unreachable');
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
          res.on('end', () => resolve({ status, location, cookies, bytes: Buffer.concat(chunks) }));
        }
      );
      const timer = setTimeout(
        () => req.destroy(new CameraTransportError('gateway-unreachable')),
        remaining
      );
      req.on('error', () => fail('gateway-unreachable'));
      req.on('close', () => clearTimeout(timer));
      req.end();
    });
  }

  function refuse(status: number): never {
    throw new CameraTransportError(
      status === 401 || status === 403
        ? 'auth-failed'
        : status === 404 || status === 415
          ? 'unsupported-stream'
          : status >= 300 && status < 400
            ? 'relay-unsupported'
            : 'gateway-unreachable'
    );
  }

  /**
   * Read the master playlist, opening a relay session when the relay manages them.
   * The only redirect ever followed is the relay's own same-path `?cookieCheck=1`
   * step, compared as an exact string: never another host, port, scheme or path.
   */
  async function open(binding: Binding, deadline: number) {
    let res = await get(binding, 'index.m3u8', MAX_MANIFEST_BYTES, deadline);
    if (res.status === 302 || res.status === 303 || res.status === 307) {
      if (res.location !== `/${binding.path}/index.m3u8?${COOKIE_CHECK}`)
        throw new CameraTransportError('relay-unsupported');
      res = await get(binding, `index.m3u8?${COOKIE_CHECK}`, MAX_MANIFEST_BYTES, deadline);
      if (res.status >= 300 && res.status < 400)
        throw new CameraTransportError('relay-unsupported');
    }
    if (res.status !== 200) refuse(res.status);
    const cookie = sessionCookie(res.cookies);
    const { bytes, secret } = withoutSessionSecret(res.bytes, cookie);
    // A relay without sessions (before v1.18.0) authenticates every request instead.
    if (secret) sessions.set(binding, secret);
    else sessions.delete(binding);
    return { bytes, secret };
  }

  /**
   * One renewal per binding at a time; concurrent reads share its result. The renewal has its
   * own deadline (DEV-1004), so it never inherits the time left to whichever read started it,
   * and each read waits for it only until its own deadline (`untilDeadline`).
   */
  function renew(binding: Binding) {
    let pending = renewing.get(binding);
    if (!pending) {
      pending = open(binding, Date.now() + CAMERA_READ_DEADLINE_MS)
        .then((result) => result.secret)
        .finally(() => renewing.delete(binding));
      renewing.set(binding, pending);
    }
    return pending;
  }

  /** `work`, or `gateway-unreachable` once this read's own deadline has passed. */
  function untilDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new CameraTransportError('gateway-unreachable'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CameraTransportError('gateway-unreachable')), remaining);
    });
    return Promise.race([work, expired]).finally(() => clearTimeout(timer));
  }

  async function fetchResource(
    binding: Binding,
    resource: string,
    maximum: number,
    deadline: number
  ) {
    if (resource === 'index.m3u8') return (await open(binding, deadline)).bytes;
    const session = sessions.get(binding);
    let res = await get(binding, resource, maximum, deadline, session);
    if (res.status === 401) {
      // The relay ended the session (idle, restart) or none was open yet: open a
      // fresh one and retry once. A relay without sessions answers 401 only for a
      // refused login, and that refusal stands.
      const renewed = await untilDeadline(renew(binding), deadline);
      if (!renewed) refuse(res.status);
      res = await get(binding, resource, maximum, deadline, renewed);
      if (res.status === 401) throw new CameraTransportError('relay-unsupported');
    }
    if (res.status !== 200) refuse(res.status);
    if (!resource.endsWith('.m3u8')) return res.bytes;
    return withoutSessionSecret(res.bytes, sessions.get(binding)).bytes;
  }

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
    const deadline = Date.now() + CAMERA_READ_DEADLINE_MS;
    active++;
    try {
      const bytes = await fetchResource(binding, resource, maximum, deadline);
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
    /**
     * Reads the master playlist and its first media playlist, so `ok` also proves
     * the relay's session flow. It still proves no frames or browser decoding.
     */
    async diagnose(scope: CameraBindingScope) {
      try {
        const result = await read(scope);
        const text = result.bytes.toString('utf8');
        const names: string[] = [];
        rewriteCameraManifest(text, (name) => {
          names.push(name);
          return name;
        });
        const media = names.find((name) => name.endsWith('.m3u8'));
        if (media)
          rewriteCameraManifest((await read(scope, media)).bytes.toString('utf8'), (name) => name);
        return {
          outcome: 'ok' as const,
          discoveredProfile: 'Configured HLS gateway',
          videoCodec: cameraVideoCodec(text),
        };
      } catch (error) {
        return {
          outcome:
            error instanceof CameraTransportError ? error.code : ('gateway-unreachable' as const),
        };
      }
    },
  };
}
