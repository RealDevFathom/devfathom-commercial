/**
 * DEV-1003 relay sessions. MediaMTX v1.18.0+ answers the first playlist request
 * with a same-path `?cookieCheck=1` redirect, checks the reader login on that
 * request and then wants the session secret (cookie `hlsSession`, or query
 * `session`) on every later playlist and segment request; the relay drops the
 * session after 30 s without requests. A fake `https.request` plays the relay,
 * following the rules in MediaMTX's internal/servers/hls/http_server.go and
 * session.go, so these cases prove the client's requests and refusals. The real
 * binary is exercised by mediamtx.relay.integration.test.ts.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  CAMERA_READ_DEADLINE_MS,
  CameraTransportError,
  cameraVideoCodec,
  createMediaMtxTransport,
} from './mediamtx';

const BASE = 'https://camera-gateway.example.internal/';
const READER = 'dedicated-hls-reader';
const READER_PASSWORD = 'synthetic-reader-secret';
const BASIC = `Basic ${Buffer.from(`${READER}:${READER_PASSWORD}`).toString('base64')}`;
const SECRET_A = '0b0c1d2e-3f40-4152-8364-758697a8b9ca';
const SECRET_B = '1c2d3e4f-5061-4273-8495-a6b7c8d9eafb';
const MASTER =
  '#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-INDEPENDENT-SEGMENTS\n\n#EXT-X-STREAM-INF:BANDWIDTH=300000,CODECS="avc1.42c01e",RESOLUTION=640x360\nvideo1_stream.m3u8\n';
const media = (query = '') =>
  `#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="abc_video1_init.mp4${query}"\n#EXTINF:1.00000,\nabc_video1_seg0.mp4${query}\n`;

const binding = (over: Record<string, unknown> = {}) => ({
  vertical: 'pharmacy',
  organizationId: 'org_a',
  branchId: 'branch_a',
  gatewayId: 'gw_1',
  cameraId: 'cam_1',
  baseUrl: BASE,
  address: '10.20.30.40',
  path: 'pharmacy-counter-1',
  username: READER,
  password: READER_PASSWORD,
  ...over,
});
const scope = (over: Record<string, unknown> = {}) => ({
  vertical: 'pharmacy' as const,
  organizationId: 'org_a',
  branchId: 'branch_a',
  gatewayId: 'gw_1',
  cameraId: 'cam_1',
  baseUrl: BASE,
  ...over,
});

type Reply = {
  status: number;
  body?: string | Buffer;
  headers?: Record<string, string | string[]>;
};
type Call = { url: URL; options: Record<string, unknown>; headers: Record<string, string> };

/** Plays an HTTP relay: `respond` decides each answer from the request. */
function relay(respond: (url: URL, headers: Record<string, string>) => Reply | 'network-error') {
  const calls: Call[] = [];
  const request = vi.fn(
    (url: URL, options: Record<string, unknown>, callback: (res: EventEmitter) => void) => {
      const headers = options.headers as Record<string, string>;
      calls.push({ url, options, headers });
      const req = new EventEmitter() as EventEmitter & {
        end: () => void;
        destroy: (error?: Error) => void;
      };
      req.destroy = () => req.emit('close');
      req.end = () => {
        queueMicrotask(() => {
          const reply = respond(url, headers);
          if (reply === 'network-error') {
            req.emit('error', new Error('ECONNREFUSED 10.20.30.40'));
            req.emit('close');
            return;
          }
          const res = new EventEmitter() as EventEmitter & {
            statusCode: number;
            headers: Record<string, string | string[]>;
            destroy: () => void;
          };
          res.statusCode = reply.status;
          res.headers = reply.headers ?? {};
          res.destroy = () => {};
          callback(res);
          res.emit('data', Buffer.from(reply.body ?? ''));
          res.emit('end');
          req.emit('close');
        });
      };
      return req;
    }
  );
  return { request, calls };
}

const cookieOf = (headers: Record<string, string>, name: string) =>
  headers.Cookie?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);

/**
 * MediaMTX v1.21 rules: plain master request -> 302; `?cookieCheck=1` checks Basic
 * and opens a session; children need a live session secret for the same path.
 */
function mediaMtx121(
  options: {
    password?: string;
    secrets?: string[];
    location?: string;
    cookieCheckStatus?: number;
    sessionCookie?: (secret: string) => string[];
  } = {}
) {
  const live = new Set<string>();
  const secrets = [...(options.secrets ?? [SECRET_A, SECRET_B])];
  const expected = `Basic ${Buffer.from(`${READER}:${options.password ?? READER_PASSWORD}`).toString('base64')}`;
  const state = relay((url, headers): Reply => {
    const [, path, file] = /^\/([^/]+)\/([^/]+)$/.exec(url.pathname) ?? [];
    if (path !== 'pharmacy-counter-1') return { status: 404, body: '404 page not found' };
    if (file === 'index.m3u8' && url.search !== '?cookieCheck=1')
      return {
        status: 302,
        headers: {
          location: options.location ?? `/${path}/index.m3u8?cookieCheck=1`,
          'set-cookie': ['cookieCheck=1; HttpOnly; Secure; SameSite=None; Partitioned'],
        },
      };
    if (file === 'index.m3u8') {
      if (options.cookieCheckStatus) return { status: options.cookieCheckStatus };
      if (headers.Authorization !== expected)
        return { status: 401, body: '{"status":"error","error":"authentication error"}' };
      const secret = secrets.shift() ?? SECRET_B;
      live.add(secret);
      const cookieMode = cookieOf(headers, 'cookieCheck') === '1';
      return {
        status: 200,
        headers: cookieMode
          ? {
              'set-cookie': options.sessionCookie?.(secret) ?? [
                `hlsSession=${secret}; HttpOnly; Secure; SameSite=None; Partitioned`,
              ],
            }
          : {},
        body: cookieMode ? MASTER : MASTER.replace('stream.m3u8', `stream.m3u8?session=${secret}`),
      };
    }
    const secret = cookieOf(headers, 'hlsSession') ?? url.searchParams.get('session');
    if (!secret || !live.has(secret))
      return { status: 401, body: '{"status":"error","error":"session not found"}' };
    const cookieMode = cookieOf(headers, 'cookieCheck') === '1';
    if (file.endsWith('.m3u8'))
      return { status: 200, body: media(cookieMode ? '' : `?session=${secret}`) };
    return { status: 200, body: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]) };
  });
  return { ...state, live };
}

const transportWith = (request: unknown, bindings: unknown[] = [binding()]) =>
  createMediaMtxTransport(JSON.stringify(bindings), request as never);

const leaks = (value: unknown) => {
  const text =
    value instanceof Error
      ? `${value.message} ${value.stack}`
      : JSON.stringify(value, (_k, v: unknown) =>
          v && typeof v === 'object' && 'type' in v && (v as { type: unknown }).type === 'Buffer'
            ? Buffer.from((v as unknown as { data: number[] }).data).toString('utf8')
            : v
        );
  return [SECRET_A, SECRET_B, READER_PASSWORD, BASIC, 'session='].filter((s) => text.includes(s));
};

describe('MediaMTX v1.18+ session flow', () => {
  it('follows only the same-path cookieCheck step and keeps the session secret server-side', async () => {
    const { request, calls } = mediaMtx121();
    const transport = transportWith(request);
    const result = await transport.read(scope());
    expect(calls.map((call) => call.url.href)).toEqual([
      'https://camera-gateway.example.internal/pharmacy-counter-1/index.m3u8',
      'https://camera-gateway.example.internal/pharmacy-counter-1/index.m3u8?cookieCheck=1',
    ]);
    for (const { options, headers } of calls) {
      expect(options).toMatchObject({ rejectUnauthorized: true, family: 4, agent: false });
      const lookup = options.lookup as (
        h: string,
        o: unknown,
        cb: (...a: unknown[]) => void
      ) => void;
      const cb = vi.fn();
      lookup('attacker.example', {}, cb);
      expect(cb).toHaveBeenCalledWith(null, '10.20.30.40', 4);
      expect(headers.Authorization).toBe(BASIC);
      expect(headers.Cookie).toBe('cookieCheck=1');
    }
    expect(result.bytes.toString('utf8')).toBe(MASTER);
    expect(leaks(result)).toEqual([]);
  });

  it('sends the session secret only to its own relay on later playlist and segment reads', async () => {
    const { request, calls } = mediaMtx121();
    const transport = transportWith(request);
    await transport.read(scope());
    const playlist = await transport.read(scope(), 'video1_stream.m3u8');
    const segment = await transport.read(scope(), 'abc_video1_seg0.mp4');
    expect(calls).toHaveLength(4);
    expect(calls[2].url.href).toBe(
      'https://camera-gateway.example.internal/pharmacy-counter-1/video1_stream.m3u8'
    );
    expect(calls[2].headers.Cookie).toBe(`cookieCheck=1; hlsSession=${SECRET_A}`);
    expect(calls[3].headers.Cookie).toBe(`cookieCheck=1; hlsSession=${SECRET_A}`);
    expect(calls[3].url.search).toBe('');
    expect(playlist.bytes.toString('utf8')).toBe(media());
    expect(segment).toMatchObject({ manifest: false, contentType: 'video/mp4' });
    expect(leaks(playlist)).toEqual([]);
  });

  it('opens a session on demand when the first read is a child playlist', async () => {
    const { request, calls } = mediaMtx121();
    const transport = transportWith(request);
    const playlist = await transport.read(scope(), 'video1_stream.m3u8');
    expect(calls.map((call) => call.url.pathname + call.url.search)).toEqual([
      '/pharmacy-counter-1/video1_stream.m3u8',
      '/pharmacy-counter-1/index.m3u8',
      '/pharmacy-counter-1/index.m3u8?cookieCheck=1',
      '/pharmacy-counter-1/video1_stream.m3u8',
    ]);
    expect(calls[0].headers.Cookie).toBe('cookieCheck=1');
    expect(calls[3].headers.Cookie).toBe(`cookieCheck=1; hlsSession=${SECRET_A}`);
    expect(playlist.bytes.toString('utf8')).toBe(media());
  });

  it('renews the session once when the relay ends it, and concurrent reads share the renewal', async () => {
    const { request, calls, live } = mediaMtx121();
    const transport = transportWith(request);
    await transport.read(scope());
    live.clear(); // 30 s idle, or a relay restart
    const reads = await Promise.all([
      transport.read(scope(), 'video1_stream.m3u8'),
      transport.read(scope(), 'abc_video1_seg0.mp4'),
      transport.read(scope(), 'abc_video1_init.mp4'),
    ]);
    expect(reads.map((read) => read.manifest)).toEqual([true, false, false]);
    const opens = calls.filter((call) => call.url.search === '?cookieCheck=1');
    expect(opens).toHaveLength(2);
    const retried = calls.slice(-3);
    for (const call of retried)
      expect(call.headers.Cookie).toBe(`cookieCheck=1; hlsSession=${SECRET_B}`);
    expect(leaks(reads)).toEqual([]);
  });

  it('reports a wrong viewer password as auth-failed on the cookieCheck step', async () => {
    const { request, calls } = mediaMtx121({ password: 'the-real-one' });
    const transport = transportWith(request);
    const error = await transport.read(scope()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CameraTransportError);
    expect((error as CameraTransportError).code).toBe('auth-failed');
    expect(leaks(error)).toEqual([]);
    expect(calls).toHaveLength(2);
    await expect(transport.read(scope(), 'abc_video1_seg0.mp4')).rejects.toMatchObject({
      code: 'auth-failed',
    });
    await expect(transport.diagnose(scope())).resolves.toEqual({ outcome: 'auth-failed' });
  });

  it('reports relay-unsupported when a fresh session is still refused', async () => {
    const { request, calls } = relay((url) =>
      url.pathname.endsWith('index.m3u8')
        ? {
            status: 200,
            headers: { 'set-cookie': [`hlsSession=${SECRET_A}; HttpOnly`] },
            body: MASTER,
          }
        : { status: 401 }
    );
    const transport = transportWith(request);
    await expect(transport.read(scope(), 'video1_stream.m3u8')).rejects.toMatchObject({
      code: 'relay-unsupported',
    });
    expect(calls).toHaveLength(3);
  });

  it.each([
    ['another host', 'https://attacker.example/pharmacy-counter-1/index.m3u8?cookieCheck=1'],
    ['the same host by absolute URL', `${BASE}pharmacy-counter-1/index.m3u8?cookieCheck=1`],
    ['another scheme', 'http://camera-gateway.example.internal/pharmacy-counter-1/index.m3u8'],
    ['another port', 'https://camera-gateway.example.internal:8443/pharmacy-counter-1/index.m3u8'],
    ['a protocol-relative host', '//attacker.example/pharmacy-counter-1/index.m3u8?cookieCheck=1'],
    ['another stream path', '/other-camera/index.m3u8?cookieCheck=1'],
    ['a traversal', '/pharmacy-counter-1/../other-camera/index.m3u8?cookieCheck=1'],
    ['an encoded path', '/pharmacy%2dcounter-1/index.m3u8?cookieCheck=1'],
    ['an extra parameter', '/pharmacy-counter-1/index.m3u8?cookieCheck=1&x=1'],
    ['another file', '/pharmacy-counter-1/video1_stream.m3u8?cookieCheck=1'],
    ['no location', ''],
  ])('never follows a redirect to %s', async (_label, location) => {
    const { request, calls } = mediaMtx121({ location });
    const transport = transportWith(request);
    await expect(transport.read(scope())).rejects.toMatchObject({ code: 'relay-unsupported' });
    expect(calls).toHaveLength(1);
    await expect(transport.diagnose(scope())).resolves.toEqual({ outcome: 'relay-unsupported' });
  });

  it.each([301, 303, 307, 308])(
    'never follows a %i redirect on the cookieCheck step',
    async (status) => {
      const { request, calls } = mediaMtx121({ cookieCheckStatus: status });
      const transport = transportWith(request);
      await expect(transport.read(scope())).rejects.toMatchObject({ code: 'relay-unsupported' });
      expect(calls).toHaveLength(2);
    }
  );

  it.each([
    ['malformed', () => ['hlsSession=not-a-uuid; HttpOnly']],
    ['header injection', () => [`hlsSession=${SECRET_A}\r\nX-Evil: 1`]],
    ['two different values', (s: string) => [`hlsSession=${s}`, `hlsSession=${SECRET_B}`]],
  ])('refuses a %s session cookie', async (_label, sessionCookie) => {
    const { request } = mediaMtx121({ sessionCookie });
    await expect(transportWith(request).read(scope())).rejects.toMatchObject({
      code: 'relay-unsupported',
    });
  });

  it('accepts the duplicated plain and partitioned cookie of v1.18-v1.20', async () => {
    const { request, calls } = mediaMtx121({
      sessionCookie: (s) => [`hlsSession=${s}`, `hlsSession=${s}; HttpOnly; Secure; Partitioned`],
    });
    const transport = transportWith(request);
    await transport.read(scope());
    await transport.read(scope(), 'video1_stream.m3u8');
    expect(calls[2].headers.Cookie).toBe(`cookieCheck=1; hlsSession=${SECRET_A}`);
  });

  it('strips a query-mode session secret from playlists before returning them', async () => {
    const { request } = relay((url) =>
      url.pathname.endsWith('index.m3u8')
        ? { status: 200, body: MASTER.replace('stream.m3u8', `stream.m3u8?session=${SECRET_A}`) }
        : url.pathname.endsWith('.m3u8')
          ? { status: 200, body: media(`?session=${SECRET_A}`) }
          : { status: 200, body: 'x' }
    );
    const transport = transportWith(request);
    const master = await transport.read(scope());
    const playlist = await transport.read(scope(), 'video1_stream.m3u8');
    expect(master.bytes.toString('utf8')).toBe(MASTER);
    expect(playlist.bytes.toString('utf8')).toBe(media());
    expect(leaks([master, playlist])).toEqual([]);
  });

  it.each([
    ['another session secret', media(`?session=${SECRET_B}`), 'relay-unsupported'],
    [
      'the secret outside a reference',
      `${media()}#EXT-X-MEDIA:NAME="${SECRET_A}"\n`,
      'unsupported-stream',
    ],
    ['the secret with extra parameters', media(`?x=1&session=${SECRET_A}`), 'unsupported-stream'],
  ])('fails closed on a playlist carrying %s', async (_label, body, code) => {
    const { request } = relay((url) =>
      url.pathname.endsWith('index.m3u8')
        ? { status: 200, headers: { 'set-cookie': [`hlsSession=${SECRET_A}`] }, body: MASTER }
        : { status: 200, body }
    );
    const transport = transportWith(request);
    await transport.read(scope());
    const error = await transport.read(scope(), 'video1_stream.m3u8').catch((e: unknown) => e);
    expect((error as CameraTransportError).code).toBe(code);
    expect(leaks(error)).toEqual([]);
  });

  it('keeps sessions apart per binding', async () => {
    const seen: string[] = [];
    let n = 0;
    const secrets = [SECRET_A, SECRET_B];
    const { request } = relay((url, headers) => {
      if (url.pathname.endsWith('index.m3u8'))
        return {
          status: 200,
          headers: { 'set-cookie': [`hlsSession=${secrets[n++]}`] },
          body: MASTER,
        };
      seen.push(`${url.pathname} ${cookieOf(headers, 'hlsSession')}`);
      return { status: 200, body: media() };
    });
    const transport = transportWith(request, [
      binding(),
      binding({ cameraId: 'cam_2', path: 'pharmacy-fridge-2' }),
    ]);
    await transport.read(scope());
    await transport.read(scope({ cameraId: 'cam_2' }));
    await transport.read(scope(), 'video1_stream.m3u8');
    await transport.read(scope({ cameraId: 'cam_2' }), 'video1_stream.m3u8');
    expect(seen).toEqual([
      `/pharmacy-counter-1/video1_stream.m3u8 ${SECRET_A}`,
      `/pharmacy-fridge-2/video1_stream.m3u8 ${SECRET_B}`,
    ]);
  });
});

describe('relay without sessions (v1.17 and earlier)', () => {
  it('reads every resource with the reader login and no session step', async () => {
    const { request, calls } = relay((_url, headers) =>
      headers.Authorization === BASIC ? { status: 200, body: MASTER } : { status: 401 }
    );
    const transport = transportWith(request);
    await transport.read(scope());
    await transport.read(scope(), 'video1_stream.m3u8');
    expect(calls).toHaveLength(2);
    expect(calls[1].headers.Cookie).toBe('cookieCheck=1');
  });

  it('keeps a refused login as auth-failed without looping', async () => {
    const { request, calls } = relay(() => ({ status: 401 }));
    const transport = transportWith(request);
    await expect(transport.read(scope(), 'video1_stream.m3u8')).rejects.toMatchObject({
      code: 'auth-failed',
    });
    expect(calls).toHaveLength(2);
  });

  it('keeps a child 401 as auth-failed when the master still reads without a session', async () => {
    const { request, calls } = relay((url) =>
      url.pathname.endsWith('index.m3u8') ? { status: 200, body: MASTER } : { status: 401 }
    );
    await expect(transportWith(request).read(scope(), 'video1_stream.m3u8')).rejects.toMatchObject({
      code: 'auth-failed',
    });
    expect(calls).toHaveLength(2);
  });
});

describe('fixed failure codes keep their meaning', () => {
  it.each([
    [403, 'auth-failed'],
    [404, 'unsupported-stream'],
    [415, 'unsupported-stream'],
    [500, 'gateway-unreachable'],
    [502, 'gateway-unreachable'],
  ])('maps HTTP %i on the cookieCheck step to %s', async (status, code) => {
    const { request } = mediaMtx121({ cookieCheckStatus: status });
    await expect(transportWith(request).read(scope())).rejects.toMatchObject({ code });
  });

  it.each([
    ['an oversized declared playlist', { 'content-length': String(300 * 1024) }],
    ['a compressed playlist', { 'content-encoding': 'gzip' }],
  ])('keeps %s as gateway-unreachable', async (_label, headers) => {
    const { request } = relay(() => ({ status: 200, headers, body: MASTER }));
    await expect(transportWith(request).read(scope())).rejects.toMatchObject({
      code: 'gateway-unreachable',
    });
  });

  it('refuses a playlist body over 256 KiB as unsupported-stream', async () => {
    const { request } = relay(() => ({ status: 200, body: `#EXTM3U\n${'#'.repeat(300 * 1024)}` }));
    await expect(transportWith(request).read(scope())).rejects.toMatchObject({
      code: 'unsupported-stream',
    });
  });

  it('maps a stopped relay to gateway-unreachable without echoing the network error', async () => {
    const { request } = relay(() => 'network-error');
    const transport = transportWith(request);
    const error = await transport.read(scope()).catch((e: unknown) => e);
    expect((error as CameraTransportError).code).toBe('gateway-unreachable');
    expect(String(error)).not.toContain('10.20.30.40');
    await expect(transport.diagnose(scope())).resolves.toEqual({ outcome: 'gateway-unreachable' });
  });

  it('still caps concurrent upstream reads at sixteen', async () => {
    const pending: (() => void)[] = [];
    const request = vi.fn(() => {
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.end = () => pending.push(() => req.emit('error', new Error('x')));
      req.destroy = () => req.emit('close');
      return req;
    });
    const transport = transportWith(request);
    const reads = Array.from({ length: 16 }, () =>
      transport.read(scope(), 'abc_video1_seg0.mp4').catch((e: CameraTransportError) => e.code)
    );
    await expect(transport.read(scope(), 'abc_video1_seg0.mp4')).rejects.toMatchObject({
      code: 'gateway-unreachable',
    });
    expect(request).toHaveBeenCalledTimes(16);
    for (const settle of pending) settle();
    expect(await Promise.all(reads)).toEqual(Array(16).fill('gateway-unreachable'));
  });
});

describe('connection check and codec', () => {
  it('proves the session flow by reading the first media playlist', async () => {
    const { request, calls } = mediaMtx121();
    const result = await transportWith(request).diagnose(scope());
    expect(result).toEqual({
      outcome: 'ok',
      discoveredProfile: 'Configured HLS gateway',
      videoCodec: 'h264',
    });
    expect(calls.map((call) => call.url.pathname + call.url.search)).toEqual([
      '/pharmacy-counter-1/index.m3u8',
      '/pharmacy-counter-1/index.m3u8?cookieCheck=1',
      '/pharmacy-counter-1/video1_stream.m3u8',
    ]);
    expect(leaks(result)).toEqual([]);
  });

  it('names H.265 from the playlist so the camera screen can say which browsers play it', async () => {
    const { request } = relay((url) =>
      url.pathname.endsWith('index.m3u8')
        ? { status: 200, body: MASTER.replace('avc1.42c01e', 'hvc1.1.6.L63.90') }
        : { status: 200, body: media() }
    );
    await expect(transportWith(request).diagnose(scope())).resolves.toMatchObject({
      outcome: 'ok',
      videoCodec: 'h265',
    });
  });

  it.each([
    ['CODECS="avc1.640028,mp4a.40.2"', 'h264'],
    ['CODECS="avc3.640028"', 'h264'],
    ['CODECS="hvc1.1.6.L93.B0"', 'h265'],
    ['CODECS="hev1.1.6.L93.B0,mp4a.40.2"', 'h265'],
    ['CODECS="HVC1.2.4.L120.B0"', 'h265'],
    ['CODECS="av01.0.08M.08"', 'unknown'],
    ['BANDWIDTH=1', 'unknown'],
  ])('reads %s as %s', (attributes, codec) => {
    expect(cameraVideoCodec(`#EXTM3U\n#EXT-X-STREAM-INF:${attributes}\nv.m3u8\n`)).toBe(codec);
  });
});

describe('DEV-1004: one deadline per read', () => {
  /** A relay that answers every request after `delayMs`, with the v1.18+ session step. */
  function slowRelay(delayMs: number) {
    const paths: string[] = [];
    const request = vi.fn(
      (url: URL, _options: Record<string, unknown>, callback: (res: EventEmitter) => void) => {
        paths.push(url.pathname + url.search);
        const req = new EventEmitter() as EventEmitter & {
          end: () => void;
          destroy: (error?: Error) => void;
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        req.destroy = (error?: Error) => {
          clearTimeout(timer);
          if (error) req.emit('error', error);
          req.emit('close');
        };
        req.end = () => {
          timer = setTimeout(() => {
            const res = new EventEmitter() as EventEmitter & {
              statusCode: number;
              headers: Record<string, string | string[]>;
              destroy: () => void;
            };
            const first = url.search === '';
            res.statusCode = first ? 302 : 200;
            res.headers = first
              ? { location: '/pharmacy-counter-1/index.m3u8?cookieCheck=1' }
              : { 'set-cookie': [`hlsSession=${SECRET_A}; HttpOnly; Secure`] };
            res.destroy = () => {};
            callback(res);
            if (!first) res.emit('data', Buffer.from(MASTER));
            res.emit('end');
            req.emit('close');
          }, delayMs);
        };
        return req;
      }
    );
    return { request, paths };
  }

  it('refuses a read whose requests together pass the deadline, though each one is under it', async () => {
    vi.useFakeTimers();
    try {
      // Each answer takes 60% of the deadline: the session step's second request ends past it.
      const { request, paths } = slowRelay(CAMERA_READ_DEADLINE_MS * 0.6);
      const outcome = transportWith(request)
        .read(scope())
        .then(
          () => 'read',
          (error: unknown) => (error as CameraTransportError).code
        );
      await vi.advanceTimersByTimeAsync(CAMERA_READ_DEADLINE_MS + 1);
      await expect(outcome).resolves.toBe('gateway-unreachable');
      expect(paths).toEqual([
        '/pharmacy-counter-1/index.m3u8',
        '/pharmacy-counter-1/index.m3u8?cookieCheck=1',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still reads within the deadline when the relay is quick enough', async () => {
    vi.useFakeTimers();
    try {
      const { request } = slowRelay(CAMERA_READ_DEADLINE_MS * 0.4);
      const outcome = transportWith(request).read(scope());
      await vi.advanceTimersByTimeAsync(CAMERA_READ_DEADLINE_MS);
      await expect(outcome).resolves.toMatchObject({ manifest: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
