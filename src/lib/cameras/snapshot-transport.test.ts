// @vitest-environment node
import { EventEmitter } from 'node:events';
import type { RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makePng } from './png-still.fixtures';
import {
  CAMERA_SNAPSHOT_DEADLINE_MS,
  CameraSnapshotError,
  createCameraSnapshotTransport,
  type CameraSnapshotScope,
} from './snapshot-transport';

const SECRET = 'reader-secret-0123456789abcdef';
const binding = {
  vertical: 'pharmacy',
  organizationId: 'org-a',
  branchId: 'branch-a',
  gatewayId: 'gateway-a',
  cameraId: 'camera-a',
  baseUrl: 'https://gateway.pharmacy.test/',
  snapshotBaseUrl: 'https://gateway.pharmacy.test:8899/',
  address: '10.20.30.40',
  path: 'pharmacy/branch-a/counter-1',
  username: 'app-snapshot',
  password: SECRET,
};
const scope: CameraSnapshotScope = {
  vertical: 'pharmacy',
  organizationId: 'org-a',
  branchId: 'branch-a',
  gatewayId: 'gateway-a',
  cameraId: 'camera-a',
  baseUrl: 'https://gateway.pharmacy.test/',
};

type Reply = {
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer;
  /** Drop the connection after this many body bytes. */
  dropAfter?: number;
  /** Never answer. */
  hang?: boolean;
  /** Emit a socket error instead of a response. */
  error?: boolean;
};

function fakeRequest(reply: Reply | (() => Reply)) {
  const calls: Array<{ url: URL; options: RequestOptions }> = [];
  const request = vi.fn(
    (url: URL, options: RequestOptions, onResponse: (res: PassThrough) => void) => {
      calls.push({ url, options });
      const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
      req.destroy = () => setImmediate(() => req.emit('close'));
      req.end = () => {
        const r = typeof reply === 'function' ? reply() : reply;
        if (r.hang) return;
        setImmediate(() => {
          if (r.error) {
            req.emit('error', new Error(`connect ECONNREFUSED ${binding.address} ${SECRET}`));
            req.emit('close');
            return;
          }
          const res = new PassThrough() as PassThrough & {
            statusCode: number;
            headers: Record<string, string>;
            complete: boolean;
          };
          res.statusCode = r.status ?? 200;
          res.headers = r.headers ?? { 'content-type': 'image/png' };
          res.complete = false;
          onResponse(res);
          const body = r.body ?? Buffer.alloc(0);
          if (r.dropAfter !== undefined) {
            res.write(body.subarray(0, r.dropAfter));
            setImmediate(() => res.destroy());
          } else {
            res.complete = true;
            res.end(body);
          }
          res.on('close', () => req.emit('close'));
        });
      };
      return req;
    }
  );
  return { request: request as unknown as typeof import('node:https').request, calls };
}

const create = (reply: Reply | (() => Reply), bindings: unknown[] = [binding]) => {
  const fake = fakeRequest(reply);
  return {
    transport: createCameraSnapshotTransport(JSON.stringify(bindings), fake.request),
    ...fake,
  };
};

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(CameraSnapshotError);
  const text = `${(error as Error).message} ${(error as Error).stack ?? ''}`;
  for (const leak of [SECRET, binding.address, binding.path, 'gateway.pharmacy.test'])
    expect(text).not.toContain(leak);
  return (error as CameraSnapshotError).code;
}

afterEach(() => vi.useRealTimers());

describe('CAMERA_SNAPSHOT_BINDINGS validation', () => {
  it.each([
    ['empty list', []],
    ['not a list', {}],
    ['unknown key', [{ ...binding, extra: 'x' }]],
    ['missing key', [{ ...binding, password: undefined }]],
    ['restaurant vertical', [{ ...binding, vertical: 'restaurant' }]],
    ['http snapshot URL', [{ ...binding, snapshotBaseUrl: 'http://gateway.pharmacy.test/' }]],
    ['different snapshot host', [{ ...binding, snapshotBaseUrl: 'https://evil.test/' }]],
    [
      'IP literal host',
      [{ ...binding, baseUrl: 'https://10.0.0.1/', snapshotBaseUrl: 'https://10.0.0.1/' }],
    ],
    ['URL with path', [{ ...binding, snapshotBaseUrl: 'https://gateway.pharmacy.test/x/' }]],
    [
      'URL with credentials',
      [{ ...binding, snapshotBaseUrl: 'https://u:p@gateway.pharmacy.test/' }],
    ],
    ['public address', [{ ...binding, address: '8.8.8.8' }]],
    ['loopback address', [{ ...binding, address: '127.0.0.1' }]],
    ['metadata address', [{ ...binding, address: '169.254.169.254' }]],
    ['hostname address', [{ ...binding, address: 'gateway.local' }]],
    ['path traversal', [{ ...binding, path: '../admin' }]],
    ['path with query', [{ ...binding, path: 'cam?x=1' }]],
    ['colon username', [{ ...binding, username: 'a:b' }]],
    ['non-ASCII username', [{ ...binding, username: 'caf\u00e9' }]],
    ['space in username', [{ ...binding, username: 'app snapshot' }]],
    ['weak secret', [{ ...binding, password: 'short' }]],
    ['header injection', [{ ...binding, password: `${SECRET}\r\nX: y` }]],
    ['duplicate camera', [binding, { ...binding, path: 'other' }]],
    ['duplicate stream', [binding, { ...binding, cameraId: 'camera-b' }]],
  ])('rejects %s without echoing it', (_label, rows) => {
    let error: unknown;
    try {
      createCameraSnapshotTransport(JSON.stringify(rows), fakeRequest({}).request);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CameraSnapshotError);
    expect((error as CameraSnapshotError).code).toBe('not-configured');
    expect(String((error as Error).message)).not.toContain(SECRET);
  });

  it('rejects malformed JSON', () => {
    expect(() => createCameraSnapshotTransport('{', fakeRequest({}).request)).toThrow(
      CameraSnapshotError
    );
  });
});

describe('scope-bound still reads', () => {
  it('reads only the exact provisioned scope, pinned, verified and authenticated', async () => {
    const png = makePng();
    const { transport, calls } = create({ body: png, headers: { 'content-type': 'image/png' } });
    expect(transport.supports(scope)).toBe(true);
    const bytes = await transport.readSnapshot(scope);
    expect(Buffer.from(bytes).equals(png)).toBe(true);

    expect(calls).toHaveLength(1);
    const { url, options } = calls[0];
    expect(url.href).toBe(
      'https://gateway.pharmacy.test:8899/pharmacy/branch-a/counter-1/snapshot.png'
    );
    expect(options).toMatchObject({
      method: 'GET',
      agent: false,
      family: 4,
      rejectUnauthorized: true,
      headers: {
        Authorization: `Basic ${Buffer.from(`app-snapshot:${SECRET}`).toString('base64')}`,
        Accept: 'image/png',
        'Accept-Encoding': 'identity',
      },
    });
    const resolved = await new Promise((resolve) =>
      (options.lookup as unknown as (h: string, o: object, cb: (...a: unknown[]) => void) => void)(
        'attacker.example',
        {},
        (_e, address, family) => resolve([address, family])
      )
    );
    expect(resolved).toEqual(['10.20.30.40', 4]);
  });

  it.each([
    ['vertical', { vertical: 'restaurant' }],
    ['organization', { organizationId: 'org-b' }],
    ['branch', { branchId: 'branch-b' }],
    ['gateway', { gatewayId: 'gateway-b' }],
    ['camera', { cameraId: 'camera-b' }],
    ['gateway URL', { baseUrl: 'https://other.pharmacy.test/' }],
  ])('a different %s is unsupported and makes no request', async (_label, change) => {
    const { transport, request } = create({ body: makePng() });
    const other = { ...scope, ...change } as CameraSnapshotScope;
    expect(transport.supports(other)).toBe(false);
    expect(await failure(transport.readSnapshot(other))).toBe('unsupported');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'auth-failed'],
    [403, 'auth-failed'],
    [404, 'unsupported'],
    [302, 'gateway-unreachable'],
    [500, 'gateway-unreachable'],
    [502, 'gateway-unreachable'],
    [503, 'gateway-unreachable'],
    [504, 'gateway-unreachable'],
  ])('status %i fails as %s and never follows a redirect', async (status, code) => {
    const { transport, request } = create({
      status,
      headers: { 'content-type': 'image/png', location: 'https://evil.test/' },
      body: makePng(),
    });
    expect(await failure(transport.readSnapshot(scope))).toBe(code);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['text/html', { 'content-type': 'text/html' }],
    ['missing type', {}],
    ['compressed', { 'content-type': 'image/png', 'content-encoding': 'gzip' }],
    [
      'oversized declared length',
      { 'content-type': 'image/png', 'content-length': String(5 * 1024 * 1024) },
    ],
  ])('a 200 with %s is an invalid still', async (_label, headers) => {
    const { transport } = create({ headers, body: makePng() });
    expect(await failure(transport.readSnapshot(scope))).toBe('invalid-still');
  });

  it('stops reading an oversized body', async () => {
    const { transport } = create({ body: Buffer.alloc(4 * 1024 * 1024 + 1) });
    expect(await failure(transport.readSnapshot(scope))).toBe('invalid-still');
  });

  it('a dropped connection or socket error is unreachable without leaking detail', async () => {
    expect(
      await failure(create({ body: makePng(), dropAfter: 10 }).transport.readSnapshot(scope))
    ).toBe('gateway-unreachable');
    expect(await failure(create({ error: true }).transport.readSnapshot(scope))).toBe(
      'gateway-unreachable'
    );
  });

  it('times out a silent gateway', async () => {
    vi.useFakeTimers();
    const { transport } = create({ hang: true });
    const pending = failure(transport.readSnapshot(scope));
    await vi.advanceTimersByTimeAsync(CAMERA_SNAPSHOT_DEADLINE_MS + 1);
    expect(await pending).toBe('gateway-unreachable');
  });

  it('caps concurrent reads and frees the slot afterwards', async () => {
    vi.useFakeTimers();
    let hang = true;
    const { transport } = create(() => (hang ? { hang: true } : { body: makePng() }));
    const held = Array.from({ length: 4 }, () => failure(transport.readSnapshot(scope)));
    expect(await failure(transport.readSnapshot(scope))).toBe('gateway-unreachable');
    await vi.advanceTimersByTimeAsync(CAMERA_SNAPSHOT_DEADLINE_MS + 1);
    await Promise.all(held);
    vi.useRealTimers();
    hang = false;
    await expect(transport.readSnapshot(scope)).resolves.toBeInstanceOf(Uint8Array);
  });
});
