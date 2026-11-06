/**
 * DEV-740 shared MediaMTX transport: vertical isolation, SSRF allowlisting and
 * the shared gateway URL/path validators. A fake `https.request` stands in for
 * the network, so these cases prove request construction and refusal, not TLS,
 * RTSP, codecs or a physical device.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  CameraTransportError,
  createMediaMtxTransport,
  isCameraGatewayBaseUrl,
  isCameraGatewayPath,
  rewriteCameraManifest,
} from './mediamtx';

const BASE = 'https://camera-gateway.example.internal/';
const READER_PASSWORD = 'synthetic-reader-secret';
const binding = (over: Record<string, unknown> = {}) => ({
  organizationId: 'org_a',
  branchId: 'branch_a',
  gatewayId: 'gw_1',
  cameraId: 'cam_1',
  baseUrl: BASE,
  address: '10.20.30.40',
  path: 'pharmacy-counter-1',
  username: 'dedicated-hls-reader',
  password: READER_PASSWORD,
  ...over,
});
const scope = (over: Record<string, unknown> = {}) => ({
  organizationId: 'org_a',
  branchId: 'branch_a',
  gatewayId: 'gw_1',
  cameraId: 'cam_1',
  baseUrl: BASE,
  ...over,
});

type Captured = { url: URL; options: Record<string, unknown> };
function fakeRequest(body = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2.0,\nseg_1.ts\n', status = 200) {
  const calls: Captured[] = [];
  const request = vi.fn(
    (url: URL, options: Record<string, unknown>, callback: (res: EventEmitter) => void) => {
      calls.push({ url, options });
      const req = new EventEmitter() as EventEmitter & {
        end: () => void;
        destroy: (error?: Error) => void;
      };
      req.destroy = () => req.emit('close');
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
          destroy: () => void;
        };
        res.statusCode = status;
        res.headers = {};
        res.destroy = () => {};
        callback(res);
        res.emit('data', Buffer.from(body));
        res.emit('end');
        req.emit('close');
      };
      return req;
    }
  );
  return { request, calls };
}
const transportWith = (bindings: unknown[], request = fakeRequest().request) =>
  createMediaMtxTransport(JSON.stringify(bindings), request as never);

describe('vertical isolation', () => {
  it('serves a pharmacy binding only to a pharmacy-scoped read', async () => {
    const { request, calls } = fakeRequest();
    const transport = transportWith([binding({ vertical: 'pharmacy' })], request);
    await expect(transport.read(scope())).rejects.toMatchObject({ code: 'not-configured' });
    await expect(transport.read(scope({ vertical: 'restaurant' }))).rejects.toMatchObject({
      code: 'not-configured',
    });
    expect(request).not.toHaveBeenCalled();
    const result = await transport.read(scope({ vertical: 'pharmacy' }));
    expect(result.manifest).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('keeps legacy bindings without a vertical restaurant-only', async () => {
    const { request } = fakeRequest();
    const transport = transportWith([binding()], request);
    await expect(transport.read(scope({ vertical: 'pharmacy' }))).rejects.toMatchObject({
      code: 'not-configured',
    });
    expect(request).not.toHaveBeenCalled();
    await expect(transport.read(scope())).resolves.toMatchObject({ manifest: true });
    await expect(transport.read(scope({ vertical: 'restaurant' }))).resolves.toMatchObject({
      manifest: true,
    });
  });

  it('allows the same IDs in both verticals but never one upstream path twice', () => {
    expect(() =>
      transportWith([
        binding({ vertical: 'pharmacy' }),
        binding({ vertical: 'restaurant', path: 'restaurant-kitchen-1' }),
      ])
    ).not.toThrow();
    expect(() =>
      transportWith([binding({ vertical: 'pharmacy' }), binding({ vertical: 'restaurant' })])
    ).toThrow(CameraTransportError);
    expect(() =>
      transportWith([
        binding({ vertical: 'pharmacy' }),
        binding({ vertical: 'pharmacy', path: 'another' }),
      ])
    ).toThrow(CameraTransportError);
  });

  it.each(['PHARMACY', 'agency', '', 1, null])('rejects vertical %j at startup', (vertical) => {
    expect(() => transportWith([binding({ vertical })])).toThrow(CameraTransportError);
  });

  it.each(['organizationId', 'branchId', 'gatewayId', 'cameraId', 'baseUrl'])(
    'requires an exact %s match',
    async (key) => {
      const { request } = fakeRequest();
      const transport = transportWith([binding({ vertical: 'pharmacy' })], request);
      await expect(
        transport.read(
          scope({
            vertical: 'pharmacy',
            [key]: key === 'baseUrl' ? 'https://other.example.internal/' : 'other',
          })
        )
      ).rejects.toMatchObject({ code: 'not-configured' });
      expect(request).not.toHaveBeenCalled();
    }
  );
});

describe('request construction and SSRF containment', () => {
  it('pins the private address, keeps TLS verification and sends reader auth only upstream', async () => {
    const { request, calls } = fakeRequest();
    const transport = transportWith([binding({ vertical: 'pharmacy' })], request);
    await transport.read(scope({ vertical: 'pharmacy' }), 'seg_1.ts');
    const [{ url, options }] = calls;
    expect(url.href).toBe('https://camera-gateway.example.internal/pharmacy-counter-1/seg_1.ts');
    expect(options).toMatchObject({
      method: 'GET',
      rejectUnauthorized: true,
      family: 4,
      agent: false,
    });
    const lookup = options.lookup as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void;
    const cb = vi.fn();
    lookup('attacker.example', {}, cb);
    expect(cb).toHaveBeenCalledWith(null, '10.20.30.40', 4);
    expect(String((options.headers as Record<string, string>).Authorization)).toMatch(/^Basic /);
  });

  it.each([
    '127.0.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '8.8.8.8',
    '172.32.0.1',
    '192.169.0.1',
    'localhost',
    '::1',
    '10.0.0.1.nip.io',
  ])('rejects non-RFC1918 address %s at startup', (address) => {
    expect(() => transportWith([binding({ vertical: 'pharmacy', address })])).toThrow(
      CameraTransportError
    );
  });

  it.each([
    '../index.m3u8',
    'a/b.ts',
    'https://evil.example/x.ts',
    'seg.ts?x=1',
    'seg.php',
    '%2e%2e.ts',
  ])('refuses resource %s without a request', async (resource) => {
    const { request } = fakeRequest();
    const transport = transportWith([binding({ vertical: 'pharmacy' })], request);
    await expect(transport.read(scope({ vertical: 'pharmacy' }), resource)).rejects.toMatchObject({
      code: 'unsupported-stream',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('maps upstream failures to fixed codes without echoing bodies', async () => {
    const { request } = fakeRequest('secret upstream body https://10.20.30.40/', 401);
    const transport = transportWith([binding({ vertical: 'pharmacy' })], request);
    const error = await transport.read(scope({ vertical: 'pharmacy' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CameraTransportError);
    expect((error as Error).message).toBe('auth-failed');
  });

  it('reports missing reader credentials without opening a connection', async () => {
    const { request } = fakeRequest();
    const transport = transportWith(
      [binding({ vertical: 'pharmacy', username: undefined, password: undefined })],
      request
    );
    await expect(transport.diagnose(scope({ vertical: 'pharmacy' }))).resolves.toEqual({
      outcome: 'credentials-missing',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('never reflects configuration values in startup errors', () => {
    try {
      transportWith([binding({ vertical: 'pharmacy', address: '8.8.8.8' })]);
    } catch (error) {
      expect(String(error)).not.toContain(READER_PASSWORD);
      expect(String(error)).not.toContain('8.8.8.8');
      expect((error as Error).message).toBe('not-configured');
    }
  });
});

describe('shared validators', () => {
  it.each([BASE, 'https://gw.example.internal:8443/', 'https://g/'])(
    'accepts gateway URL %s',
    (value) => expect(isCameraGatewayBaseUrl(value)).toBe(true)
  );

  it.each([
    'http://camera-gateway.example.internal/',
    'https://10.0.0.5/',
    'https://[::1]/',
    'https://user:pass@camera-gateway.example.internal/',
    'https://camera-gateway.example.internal/hls/',
    'https://camera-gateway.example.internal/?q',
    'https://camera-gateway.example.internal/#f',
    'https://camera-gateway.example.internal',
    'rtsp://camera-gateway.example.internal/',
    'not a url',
    '',
  ])('rejects gateway URL %s', (value) => expect(isCameraGatewayBaseUrl(value)).toBe(false));

  it.each(['counter-1', 'branch_a/fridge-2'])('accepts path %s', (value) =>
    expect(isCameraGatewayPath(value)).toBe(true)
  );
  it.each(['', '/lead', 'trail/', '../x', 'a b', 'a?b', 'rtsp://x', 'a'.repeat(121)])(
    'rejects path %j',
    (value) => expect(isCameraGatewayPath(value)).toBe(false)
  );

  it('rewrites every playlist reference to the authorized prefix and drops device metadata', () => {
    const out = rewriteCameraManifest(
      '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.0,camera title\n#EXT-X-PROGRAM-DATE-TIME:2026-01-01\nseg_1.m4s\n',
      (name) => `/api/pharmacy/cameras/cam_1/stream?grant=g&segment=${name}`
    );
    expect(out).toContain('URI="/api/pharmacy/cameras/cam_1/stream?grant=g&segment=init.mp4"');
    expect(out).toContain('/api/pharmacy/cameras/cam_1/stream?grant=g&segment=seg_1.m4s');
    expect(out).not.toContain('camera title');
    expect(out).not.toContain('2026-01-01');
  });

  it.each([
    '#EXTM3U\nhttps://10.0.0.1/seg.ts\n',
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n',
    '#EXTM3U\n#EXT-X-MAP:URI="https://evil.example/init.mp4"\n',
    '#EXTM3U\n#EXT-X-UNKNOWN:URI="x.ts"\n',
    'not a playlist',
  ])('fails closed on unsafe manifest %#', (manifest) => {
    expect(() => rewriteCameraManifest(manifest, (n) => n)).toThrow(CameraTransportError);
  });
});
