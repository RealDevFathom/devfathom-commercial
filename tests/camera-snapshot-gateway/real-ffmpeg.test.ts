// @vitest-environment node
//
// Real ffmpeg + real HTTPS, no RTSP server. The ONLY substitution: the spawn
// wrapper replaces the RTSP input segment
//   -rtsp_transport tcp -timeout <us> -i rtsp://127.0.0.1:8554/<path>
// with a synthetic source
//   -f lavfi -i testsrc=size=1280x720:rate=5
// because no MediaMTX/RTSP server is available here. Every other argument,
// the spawn options, the handler and the TLS server are the real ones.
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  createGatewayServer,
  ffmpegArgs,
  isPngStill,
  parseConfig,
} from '../../docker/camera-snapshot-gateway/server.mjs';

import { basic, PATH, rawConfig, SECRET, USERNAME } from './helpers';

const FFMPEG = '/usr/bin/ffmpeg';
const hasTools = existsSync(FFMPEG) && spawnSync('openssl', ['version']).status === 0;

type Reply = { status: number; headers: Record<string, unknown>; body: Buffer };

describe.skipIf(!hasTools)('snapshot gateway with real ffmpeg over HTTPS', () => {
  let dir = '';
  let cert: Buffer;
  let server: Server;
  let port = 0;
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const logs: unknown[] = [];
  const maxWidth = 640;
  let config: ReturnType<typeof parseConfig>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'snapshot-gateway-'));
    const keyFile = join(dir, 'tls.key');
    const certFile = join(dir, 'tls.crt');
    const made = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        keyFile,
        '-out',
        certFile,
        '-days',
        '1',
        '-subj',
        '/CN=snapshot.test',
        '-addext',
        'subjectAltName=DNS:snapshot.test',
      ],
      { stdio: 'ignore' }
    );
    expect(made.status).toBe(0);
    cert = readFileSync(certFile);
    config = parseConfig(
      JSON.stringify(
        rawConfig({
          listen: { host: '127.0.0.1', port: 8899 },
          tls: { certFile, keyFile },
          ffmpegPath: FFMPEG,
          maxWidth,
        })
      )
    );
    const wrapper = (command: string, args: string[], options: SpawnOptions) => {
      calls.push({ command, args: [...args], options });
      const start = args.indexOf('-rtsp_transport');
      const input = args.indexOf('-i');
      const replaced = [
        ...args.slice(0, start),
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=1280x720:rate=5',
        ...args.slice(input + 2),
      ];
      return spawn(command, replaced, options);
    };
    server = createGatewayServer(config, { spawn: wrapper as never, log: (e) => logs.push(e) });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const get = (authorization: string) =>
    new Promise<Reply>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          servername: 'snapshot.test',
          ca: cert,
          path: `/${PATH}/snapshot.png`,
          method: 'GET',
          agent: false,
          headers: { Authorization: authorization },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            })
          );
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      req.end();
    });

  test('returns one scaled PNG frame', async () => {
    const reply = await get(basic(USERNAME, SECRET));
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('image/png');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    expect(Number(reply.headers['content-length'])).toBe(reply.body.length);
    expect(reply.body.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    expect(reply.body.toString('latin1', 12, 16)).toBe('IHDR');
    const width = reply.body.readUInt32BE(16);
    const height = reply.body.readUInt32BE(20);
    expect(width).toBeLessThanOrEqual(maxWidth);
    expect(width).toBe(640);
    expect(height).toBe(360);
    expect(isPngStill(reply.body)).toBe(true);

    // Only the input segment was substituted; the rest is the real vector.
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(FFMPEG);
    expect(calls[0].args).toEqual(ffmpegArgs(config, PATH));
    expect(calls[0].options).toMatchObject({ shell: false, env: { PATH: '/usr/bin:/bin' } });
  }, 20_000);

  test('rejects a wrong secret over TLS without running ffmpeg', async () => {
    const before = calls.length;
    const reply = await get(basic(USERNAME, 'not-the-secret'));
    expect(reply.status).toBe(401);
    expect(reply.headers['www-authenticate']).toBe('Basic realm="camera-snapshot"');
    expect(calls).toHaveLength(before);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });
});
