// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createSnapshotHandler,
  ffmpegArgs,
  isSupportedFfmpegVersion,
  procHidesOtherUsers,
  isPngStill,
  parseConfig,
} from '../../docker/camera-snapshot-gateway/server.mjs';

import {
  basic,
  fakeReq,
  FakeRes,
  fakeSpawn,
  makePng,
  PATH,
  rawConfig,
  RTSP_READER_PASS,
  SECRET,
  sha256Hex,
  STDERR_MARKER,
  tick,
  USERNAME,
} from './helpers';

const CONFIG_ERROR = 'Invalid snapshot gateway configuration.';
const URL = `/${PATH}/snapshot.png`;
const AUTH = basic(USERNAME, SECRET);

type LogEntry = { at: string; path: string | null; status: number; ms: number; bytes: number };

function setup(overrides: Record<string, unknown> = {}, spawnOverride?: unknown) {
  const config = parseConfig(JSON.stringify(rawConfig(overrides)));
  const fake = fakeSpawn();
  const logs: LogEntry[] = [];
  const handler = createSnapshotHandler({
    config,
    spawn: (spawnOverride ?? fake.spawn) as never,
    log: (entry: LogEntry) => logs.push(entry),
  });
  const request = (url = URL, authorization: string | null = AUTH, method = 'GET') => {
    const res = new FakeRes();
    handler(fakeReq(url, authorization ?? undefined, method) as never, res as never);
    return res;
  };
  return { config, ...fake, logs, request };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('parseConfig', () => {
  test('refuses the shipped example until its placeholders are replaced, then applies defaults', () => {
    const example = readFileSync(
      resolve('docker/camera-snapshot-gateway/config.example.json'),
      'utf8'
    );
    expect(() => parseConfig(example)).toThrow('Invalid snapshot gateway configuration.');
    const filled = JSON.parse(example);
    filled.rtspReader.password = 'generated-url-safe-reader-secret-0123456789';
    filled.paths[0].passwordSha256 = sha256Hex(SECRET);
    const parsed = parseConfig(JSON.stringify(filled));
    expect(parsed.paths[0].path).toBe('pharmacy/branch-1/counter-1');
    expect(parsed.rtspOrigin).toBe('rtsp://127.0.0.1:8554');

    const minimal = parseConfig(JSON.stringify(rawConfig()));
    expect(minimal).toMatchObject({
      timeoutMs: 4000,
      maxBytes: 4194304,
      maxConcurrent: 2,
      maxWidth: 1280,
    });
    expect(Object.isFrozen(minimal)).toBe(true);
    expect(Object.isFrozen(minimal.paths)).toBe(true);
    expect(Object.isFrozen(minimal.paths[0])).toBe(true);
    expect(Object.isFrozen(minimal.listen)).toBe(true);
    expect(
      parseConfig(JSON.stringify(rawConfig({ rtspOrigin: 'rtsp://[::1]:8554' }))).rtspOrigin
    ).toBe('rtsp://[::1]:8554');
  });

  const entry = { path: PATH, username: USERNAME, passwordSha256: sha256Hex(SECRET) };
  const base = rawConfig();
  const cases: Array<[string, unknown]> = [
    ['unknown top-level key', { ...base, extra: 1 }],
    ['unknown listen key', { ...base, listen: { host: '10.0.0.10', port: 8899, x: 1 } }],
    ['unknown tls key', { ...base, tls: { ...base.tls, ca: '/x' } }],
    ['unknown path key', { ...base, paths: [{ ...entry, record: true }] }],
    ['missing paths', { ...base, paths: undefined }],
    ['missing tls', { ...base, tls: undefined }],
    ['empty paths', { ...base, paths: [] }],
    [
      'too many paths',
      { ...base, paths: Array.from({ length: 257 }, (_, i) => ({ ...entry, path: `p${i}` })) },
    ],
    ['duplicate path', { ...base, paths: [entry, { ...entry, username: 'other' }] }],
    ['missing rtspReader', { ...base, rtspReader: undefined }],
    ['rtspReader extra key', { ...base, rtspReader: { ...base.rtspReader, ips: [] } }],
    [
      'rtspReader weak password',
      { ...base, rtspReader: { ...base.rtspReader, password: 'short' } },
    ],
    [
      'rtspReader URL syntax in password',
      { ...base, rtspReader: { ...base.rtspReader, password: 'abcdefghijklmnopqrstuvwx@evil' } },
    ],
    ['rtspReader colon username', { ...base, rtspReader: { ...base.rtspReader, username: 'a:b' } }],
    ['non-loopback rtspOrigin', { ...base, rtspOrigin: 'rtsp://10.0.0.5:8554' }],
    ['hostname rtspOrigin', { ...base, rtspOrigin: 'rtsp://localhost:8554' }],
    ['rtspOrigin with path', { ...base, rtspOrigin: 'rtsp://127.0.0.1:8554/live' }],
    ['rtspOrigin with creds', { ...base, rtspOrigin: 'rtsp://u:p@127.0.0.1:8554' }],
    ['rtspOrigin trailing slash', { ...base, rtspOrigin: 'rtsp://127.0.0.1:8554/' }],
    ['rtsps origin', { ...base, rtspOrigin: 'rtsps://127.0.0.1:8322' }],
    ['rtspOrigin without port', { ...base, rtspOrigin: 'rtsp://127.0.0.1' }],
    ['rtspOrigin port 0', { ...base, rtspOrigin: 'rtsp://127.0.0.1:0' }],
    ['rtspOrigin port too big', { ...base, rtspOrigin: 'rtsp://127.0.0.1:70000' }],
    ['other loopback address', { ...base, rtspOrigin: 'rtsp://127.0.0.2:8554' }],
    ['uppercase hash', { ...base, paths: [{ ...entry, passwordSha256: 'A'.repeat(64) }] }],
    ['short hash', { ...base, paths: [{ ...entry, passwordSha256: '0'.repeat(63) }] }],
    ['path traversal', { ...base, paths: [{ ...entry, path: 'a/../b' }] }],
    ['leading slash path', { ...base, paths: [{ ...entry, path: '/a' }] }],
    ['double slash path', { ...base, paths: [{ ...entry, path: 'a//b' }] }],
    ['space in path', { ...base, paths: [{ ...entry, path: 'a b' }] }],
    ['path too long', { ...base, paths: [{ ...entry, path: 'a'.repeat(121) }] }],
    ['username with colon', { ...base, paths: [{ ...entry, username: 'a:b' }] }],
    ['username with CRLF', { ...base, paths: [{ ...entry, username: 'a\r\nb' }] }],
    ['empty username', { ...base, paths: [{ ...entry, username: '' }] }],
    ['username too long', { ...base, paths: [{ ...entry, username: 'u'.repeat(257) }] }],
    ['hostname listen host', { ...base, listen: { host: 'localhost', port: 8899 } }],
    ['IPv6 listen host', { ...base, listen: { host: '::1', port: 8899 } }],
    ['listen port 0', { ...base, listen: { host: '10.0.0.10', port: 0 } }],
    ['listen port 65536', { ...base, listen: { host: '10.0.0.10', port: 65536 } }],
    ['relative cert path', { ...base, tls: { ...base.tls, certFile: 'tls.crt' } }],
    ['relative ffmpeg path', { ...base, ffmpegPath: 'ffmpeg' }],
    ['timeoutMs below range', { ...base, timeoutMs: 999 }],
    ['timeoutMs above range', { ...base, timeoutMs: 8001 }],
    ['timeoutMs fractional', { ...base, timeoutMs: 1500.5 }],
    ['timeoutMs string', { ...base, timeoutMs: '4000' }],
    ['maxBytes 0', { ...base, maxBytes: 0 }],
    ['maxBytes above range', { ...base, maxBytes: 4194305 }],
    ['maxConcurrent 0', { ...base, maxConcurrent: 0 }],
    ['maxConcurrent 5', { ...base, maxConcurrent: 5 }],
    ['maxWidth 159', { ...base, maxWidth: 159 }],
    ['maxWidth above 1920', { ...base, maxWidth: 1921 }],
    [
      'placeholder reader password',
      {
        ...base,
        rtspReader: {
          ...base.rtspReader,
          password: 'REPLACE-with-generated-url-safe-secret-32plus',
        },
      },
    ],
    [
      'short reader password',
      { ...base, rtspReader: { ...base.rtspReader, password: 'a'.repeat(31) } },
    ],
    ['all-zero path hash', { ...base, paths: [{ ...entry, passwordSha256: '0'.repeat(64) }] }],
    ['non-ASCII username', { ...base, paths: [{ ...entry, username: 'caf\u00e9' }] }],
    ['array root', [base]],
    ['null root', null],
  ];

  test.each(cases)('rejects %s', (_name, value) => {
    expect(() => parseConfig(JSON.stringify(value))).toThrow(new Error(CONFIG_ERROR));
  });

  test('rejects invalid JSON without echoing the input', () => {
    const marker = 'MARKER-should-not-be-echoed';
    let message = '';
    try {
      parseConfig(`{"${marker}": `);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(CONFIG_ERROR);
    try {
      parseConfig(JSON.stringify({ ...base, [marker]: SECRET }));
    } catch (error) {
      message = (error as Error).message + String((error as Error).stack);
    }
    expect(message).not.toContain(marker);
    expect(message).not.toContain(SECRET);
    expect(() => parseConfig(undefined as unknown as string)).toThrow(CONFIG_ERROR);
  });
});

describe('ffmpegArgs', () => {
  test('builds the exact argument vector', () => {
    const config = parseConfig(JSON.stringify(rawConfig({ timeoutMs: 3000, maxWidth: 1280 })));
    expect(ffmpegArgs(config, PATH)).toEqual([
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-filter_threads',
      '1',
      '-threads',
      '1',
      '-rtsp_transport',
      'tcp',
      '-timeout',
      '3000000',
      '-i',
      'rtsp://snapshot-reader:fixture-mediamtx-reader-0123456789@127.0.0.1:8554/pharmacy/branch-1/counter-1',
      '-frames:v',
      '1',
      '-an',
      '-sn',
      '-dn',
      '-vf',
      "scale='min(1280,iw)':-2",
      '-threads',
      '1',
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      'pipe:1',
    ]);
    expect(() => ffmpegArgs(config, '../x')).toThrow();
  });
});

describe('isPngStill', () => {
  const png = makePng(4, 3);

  test('accepts a complete PNG', () => {
    expect(isPngStill(png)).toBe(true);
    expect(isPngStill(new Uint8Array(png))).toBe(true);
  });

  test.each<[string, unknown]>([
    ['non-buffer', 'not a buffer'],
    ['empty', Buffer.alloc(0)],
    ['bad signature', Buffer.concat([Buffer.from('GIF89a..'), png.subarray(8)])],
    ['truncated', png.subarray(0, png.length - 4)],
    ['trailing bytes', Buffer.concat([png, Buffer.from([0])])],
    ['missing IEND', png.subarray(0, png.length - 12)],
    ['zero width', makePng(0, 3)],
    ['too wide', makePng(5000, 1)],
    ['too tall', makePng(1, 5000)],
    [
      'bad CRC',
      (() => {
        const copy = Buffer.from(png);
        copy[copy.length - 13] ^= 0xff;
        return copy;
      })(),
    ],
  ])('rejects %s', (_name, value) => {
    expect(isPngStill(value)).toBe(false);
  });

  test('rejects anything over maxBytes', () => {
    expect(isPngStill(png, png.length)).toBe(true);
    expect(isPngStill(png, png.length - 1)).toBe(false);
  });
});

describe('createSnapshotHandler', () => {
  test.each(['POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'])('%s → 405', (method) => {
    const { request, calls, logs } = setup();
    const res = request(URL, AUTH, method);
    expect(res.status).toBe(405);
    expect(res.headers.Allow).toBe('GET');
    expect(calls).toHaveLength(0);
    expect(logs).toHaveLength(1);
  });

  test.each([
    `${URL}?x=1`,
    `${URL}?`,
    '/pharmacy%2Fbranch-1/counter-1/snapshot.png',
    '/pharmacy/branch-1/counter%2D1/snapshot.png',
    '/pharmacy/../pharmacy/branch-1/counter-1/snapshot.png',
    `/${PATH}/../snapshot.png`,
    `/${PATH}/./snapshot.png`,
    `/${PATH}//snapshot.png`,
    `//${PATH}/snapshot.png`,
    '/pharmacy//branch-1/counter-1/snapshot.png',
    `/${PATH}/snapshot.jpg`,
    `/${PATH}/snapshot.png/`,
    `/${PATH}/snapshot.PNG`,
    `/${PATH}`,
    '/snapshot.png',
    '/',
    `http://gateway/${PATH}/snapshot.png`,
    `/${'a'.repeat(121)}/snapshot.png`,
  ])('rejects URL %s with 404', (url) => {
    const { request, calls, logs } = setup();
    const res = request(url);
    expect(res.status).toBe(404);
    expect(res.body?.toString()).toBe('Not found\n');
    expect(calls).toHaveLength(0);
    expect(logs[0].path).toBeNull();
  });

  test('unknown path, wrong secret, wrong user and missing header give identical 401s', () => {
    const { request, calls, logs } = setup();
    const responses = [
      request('/pharmacy/branch-9/counter-9/snapshot.png', AUTH),
      request(URL, basic(USERNAME, `${SECRET}x`)),
      request(URL, basic('someone-else', SECRET)),
      request(URL, null),
      request(URL, `Bearer ${SECRET}`),
      request(URL, 'Basic !!!'),
      request(URL, `Basic ${Buffer.from(SECRET).toString('base64')}`),
      request(URL, basic('', '')),
    ];
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.headers).toEqual(responses[0].headers);
      expect(res.body).toEqual(responses[0].body);
    }
    expect(responses[0].headers['WWW-Authenticate']).toBe('Basic realm="camera-snapshot"');
    expect(calls).toHaveLength(0);
    // Path is logged only when it is configured.
    expect(logs[0].path).toBeNull();
    expect(logs[1].path).toBe(PATH);
  });

  test('success returns the PNG with strict headers and spawns ffmpeg exactly', async () => {
    const { request, calls, children, logs, config } = setup();
    const png = makePng(8, 6);
    const res = request();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('/usr/bin/ffmpeg');
    expect(calls[0].args).toEqual(ffmpegArgs(config, PATH));
    expect(calls[0].options).toEqual({
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin' },
    });
    await children[0].finish(png);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(png);
    expect(res.headers).toMatchObject({
      'Content-Type': 'image/png',
      'Content-Length': String(png.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    expect(children[0].killed).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ path: PATH, status: 200, bytes: png.length });
    expect(Object.keys(logs[0]).sort()).toEqual(['at', 'bytes', 'ms', 'path', 'status']);
    expect(new Date(logs[0].at).toISOString()).toBe(logs[0].at);
  });

  test('oversized output → 502 and SIGKILL', async () => {
    const { request, children, logs } = setup({ maxBytes: 100 });
    const res = request();
    children[0].stdout.write(Buffer.alloc(150));
    await tick();
    expect(res.status).toBe(502);
    expect(children[0].killed).toEqual(['SIGKILL']);
    expect(logs).toHaveLength(1);
  });

  test('non-PNG output → 502', async () => {
    const { request, children } = setup();
    const res = request();
    await children[0].finish(Buffer.from('not a png at all, just text from somewhere'));
    expect(res.status).toBe(502);
    expect(res.body?.toString()).toBe('Bad gateway\n');
  });

  test('nonzero exit → 502 even with PNG bytes', async () => {
    const { request, children } = setup();
    const res = request();
    await children[0].finish(makePng(), 1);
    expect(res.status).toBe(502);
  });

  test('hard deadline → 504 and SIGKILL', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { request, children, logs } = setup({ timeoutMs: 1000 });
    const res = request();
    vi.advanceTimersByTime(1999);
    expect(res.status).toBeNull();
    vi.advanceTimersByTime(1);
    expect(res.status).toBe(504);
    expect(children[0].killed).toEqual(['SIGKILL']);
    expect(logs).toEqual([expect.objectContaining({ status: 504 })]);
  });

  test('client disconnect kills ffmpeg', async () => {
    const { request, children, logs } = setup();
    const res = request();
    res.emit('close');
    expect(children[0].killed).toEqual(['SIGKILL']);
    expect(res.status).toBeNull();
    expect(logs).toEqual([expect.objectContaining({ status: 499, path: PATH })]);
    await tick();
  });

  test('concurrency limit → 503 with Retry-After, then frees the slot', async () => {
    const { request, children, calls } = setup({ maxConcurrent: 1 });
    const first = request();
    const second = request();
    expect(second.status).toBe(503);
    expect(second.headers['Retry-After']).toBe('1');
    expect(calls).toHaveLength(1);
    await children[0].finish(makePng());
    expect(first.status).toBe(200);
    request();
    expect(calls).toHaveLength(2);
  });

  test('a killed child keeps its slot until it has exited', async () => {
    const { request, calls } = setup({ maxConcurrent: 1 });
    const first = request();
    first.emit('close');
    expect(request().status).toBe(503);
    await tick();
    request();
    expect(calls).toHaveLength(2);
  });

  test('spawn ENOENT (async error) → 502 and releases the slot', async () => {
    const { request, children, calls } = setup({ maxConcurrent: 1 });
    const res = request();
    const error = Object.assign(new Error('spawn /usr/bin/ffmpeg ENOENT'), { code: 'ENOENT' });
    children[0].emit('error', error);
    expect(res.status).toBe(502);
    expect(res.body?.toString()).toBe('Bad gateway\n');
    request();
    expect(calls).toHaveLength(2);
  });

  test('an error from a running ffmpeg kills it and keeps the slot until it exits', async () => {
    const { request, children, calls } = setup({ maxConcurrent: 1 });
    const res = request();
    const child = children[0] as unknown as { pid?: number; killed: string[] };
    child.pid = 4242;
    children[0].emit('error', new Error('kill EPERM'));
    expect(res.status).toBe(502);
    expect(child.killed).toEqual(['SIGKILL']);
    // Still counted until 'close' confirms the process is gone.
    expect(request().status).toBe(503);
    await tick();
    request();
    expect(calls).toHaveLength(2);
  });

  test('spawn throwing synchronously → 502', () => {
    const { request } = setup({}, () => {
      throw new Error('EAGAIN');
    });
    expect(request().status).toBe(502);
  });

  test('logs and bodies never contain credentials, Authorization or stderr', async () => {
    const { request, children, logs } = setup({ maxConcurrent: 1 });
    const bodies: FakeRes[] = [];
    bodies.push(request(URL, basic(USERNAME, 'wrong')));
    bodies.push(request(`/unknown/snapshot.png`, AUTH));
    bodies.push(request(`${URL}?token=${SECRET}`, AUTH));
    const ok = request();
    bodies.push(request());
    await children[0].finish(makePng());
    bodies.push(ok);
    const bad = request();
    await children[1].finish(Buffer.from(STDERR_MARKER));
    bodies.push(bad);
    const text = JSON.stringify(logs);
    for (const secret of [
      SECRET,
      USERNAME,
      'Basic',
      AUTH.slice(6),
      STDERR_MARKER,
      'hunter2',
      RTSP_READER_PASS,
    ]) {
      expect(text).not.toContain(secret);
    }
    for (const res of bodies) {
      const visible = `${JSON.stringify(res.headers)}${res.status === 200 ? '' : res.body?.toString()}`;
      expect(visible).not.toContain(SECRET);
      expect(visible).not.toContain(USERNAME);
      expect(visible).not.toContain(STDERR_MARKER);
      expect(visible).not.toContain(PATH);
    }
    expect(logs.map((entry) => entry.status)).toEqual([401, 401, 404, 503, 200, 502]);
  });
});

describe('isSupportedFfmpegVersion', () => {
  test.each([
    ['ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023', true],
    ['ffmpeg version 5.0 Copyright', true],
    ['ffmpeg version n7.1 Copyright', true],
    ['ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright', false],
    ['ffmpeg version N-112345-gabcdef Copyright', false],
    ['', false],
  ])('%s → %s', (line, expected) => {
    expect(isSupportedFfmpegVersion(line)).toBe(expected);
  });
});

describe('procHidesOtherUsers', () => {
  const line = (superOptions: string, mountOptions = 'rw,nosuid,nodev,noexec,relatime') =>
    `23 28 0:22 / /proc ${mountOptions} shared:12 - proc proc ${superOptions}`;
  const other = '30 28 0:26 / /sys rw,relatime shared:7 - sysfs sysfs rw';

  test.each([
    ['hidepid=invisible', true],
    ['rw,hidepid=2,gid=27', true],
    ['rw,hidepid=noaccess', true],
    ['rw,hidepid=1', true],
    ['rw', false],
    ['rw,hidepid=0', false],
    ['rw,hidepid=off', false],
  ])('%s → %s', (options, expected) => {
    expect(procHidesOtherUsers([other, line(options)].join('\n'))).toBe(expected);
  });

  test('uses the /proc mount in effect (the last one) and needs a proc mount at all', () => {
    expect(procHidesOtherUsers([line('rw,hidepid=invisible'), line('rw')].join('\n'))).toBe(false);
    expect(procHidesOtherUsers([line('rw'), line('rw,hidepid=invisible')].join('\n'))).toBe(true);
    expect(procHidesOtherUsers(other)).toBe(false);
    expect(procHidesOtherUsers('')).toBe(false);
    // A non-proc filesystem mounted at /proc does not count.
    expect(procHidesOtherUsers('23 28 0:22 / /proc rw - tmpfs tmpfs rw,hidepid=2')).toBe(false);
  });

  test("this container's real /proc mountinfo parses", () => {
    const real = readFileSync('/proc/self/mountinfo', 'utf8');
    expect(typeof procHidesOtherUsers(real)).toBe('boolean');
  });
});
