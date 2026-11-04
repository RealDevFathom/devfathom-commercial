/**
 * DEV-745 end to end, inside one container, with no device or network access:
 *
 *   evidence row → captureCameraEvidence → evidenceSnapshotAdapter (mediamtx)
 *   → app snapshot transport (real HTTPS, certificate + hostname verified)
 *   → gateway snapshot service (real server.mjs handler, Basic auth)
 *   → real /usr/bin/ffmpeg PNG encoder → PNG validation → private storage.
 *
 * Two substitutions, and only these:
 * 1. ffmpeg's input: `-rtsp_transport tcp -timeout N -i rtsp://127.0.0.1:8554/<path>`
 *    becomes `-f lavfi -i testsrc=...`, because no RTSP server (MediaMTX) is
 *    available here. The RTSP leg is therefore NOT tested.
 * 2. The socket target: the binding's pinned RFC1918 address is asserted, then
 *    the connection goes to 127.0.0.1 with the test CA, because the 10.x address
 *    does not exist here. TLS still verifies the gateway hostname.
 *
 * This proves nothing about MediaMTX, the Dahua DVR or any camera.
 */
// @vitest-environment node
import { execFileSync, spawn as realSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpsRequest, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('server-only', () => ({}));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(async (name: string, bytes: Buffer) => {
    files.set(name, Buffer.from(bytes));
  }),
  readFile: vi.fn(async (name: string) => files.get(name)),
  rm: vi.fn(async (name: string) => {
    files.delete(name);
  }),
}));
vi.mock('@azure/identity', () => ({ DefaultAzureCredential: vi.fn() }));
vi.mock('@azure/storage-blob', () => ({ BlobServiceClient: vi.fn() }));

import {
  createGatewayServer,
  parseConfig,
} from '../../../docker/camera-snapshot-gateway/server.mjs';
import type { CameraGatewayRuntime } from './camera-gateway-runtime';
import { captureCameraEvidence, evidenceSnapshotAdapter } from './evidence';
import { inspectPngStill } from './png-still';
import { createCameraSnapshotTransport } from './snapshot-transport';

const FFMPEG = '/usr/bin/ffmpeg';
const HOST = 'gateway.pharmacy.test';
const PATH = 'pharmacy/branch-a/counter-1';
const SECRET = 'e2e-reader-secret-0123456789abcdef';
const PINNED = '10.20.30.40';
const runnable = existsSync(FFMPEG);

let dir = '';
let server: Server | null = null;
let port = 0;
let ca: Buffer = Buffer.alloc(0);
const spawnedArgs: string[][] = [];
const pinnedLookups: string[] = [];

/** Real ffmpeg; only the RTSP input segment is replaced by a test pattern. */
const testPatternSpawn = ((command: string, args: string[], options: object) => {
  spawnedArgs.push(args);
  const start = args.indexOf('-rtsp_transport');
  const input = args.indexOf('-i');
  const replaced = [
    ...args.slice(0, start),
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=2560x1440:rate=5',
    ...args.slice(input + 2),
  ];
  return realSpawn(command, replaced, options as never);
}) as unknown as typeof realSpawn;

/** Asserts the pinned address, then connects to loopback with the test CA. */
const loopbackRequest = ((url: URL, options: Record<string, unknown>, onResponse: never) => {
  const lookup = options.lookup as (
    h: string,
    o: object,
    cb: (e: unknown, a: string) => void
  ) => void;
  lookup(HOST, {}, (_e, address) => pinnedLookups.push(address));
  return httpsRequest(
    url,
    {
      ...options,
      ca,
      lookup: (_h: string, _o: object, cb: (e: null, a: string, f: number) => void) =>
        cb(null, '127.0.0.1', 4),
    } as never,
    onResponse
  );
}) as unknown as typeof httpsRequest;

function bindings(password = SECRET) {
  return JSON.stringify([
    {
      vertical: 'pharmacy',
      organizationId: 'org_a',
      branchId: 'branch_a',
      gatewayId: 'gw_a',
      cameraId: 'cam_a',
      baseUrl: `https://${HOST}/`,
      snapshotBaseUrl: `https://${HOST}:${port}/`,
      address: PINNED,
      path: PATH,
      username: 'app-snapshot',
      password,
    },
  ]);
}

function runtimeFor(password?: string) {
  return {
    available: true,
    mode: 'mediamtx',
    adapter: {} as never,
    transport: {} as never,
    snapshots: createCameraSnapshotTransport(bindings(password), loopbackRequest),
  } as unknown as CameraGatewayRuntime;
}

function db() {
  return {
    cameraEvidence: {
      findFirst: vi.fn(async () => ({
        id: 'ev_1',
        organizationId: 'org_a',
        branchId: 'branch_a',
        status: 'PENDING',
        subjectKind: 'PHARMACY_TENDER',
        requestedAt: new Date(Date.now() - 30_000),
        camera: {
          id: 'cam_a',
          enabled: true,
          counterEvidence: true,
          branchId: 'branch_a',
          gatewayId: 'gw_a',
          sourceRef: PATH,
          gateway: {
            status: 'ACTIVE',
            revokedAt: null,
            branchId: 'branch_a',
            baseUrl: `https://${HOST}/`,
          },
        },
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
}

const capture = (runtime: CameraGatewayRuntime, database = db()) =>
  captureCameraEvidence(database as never, {
    organizationId: 'org_a',
    evidenceId: 'ev_1',
    adapter: evidenceSnapshotAdapter(runtime, { vertical: 'pharmacy' }),
    now: new Date(),
    finalAttempt: true,
  });

describe.skipIf(!runnable)('real gateway service + real ffmpeg + app transport', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dev745-e2e-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '1',
        '-subj',
        `/CN=${HOST}`,
        '-addext',
        `subjectAltName=DNS:${HOST}`,
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' }
    );
    ca = readFileSync(join(dir, 'cert.pem'));
    const config = parseConfig(
      JSON.stringify({
        listen: { host: '127.0.0.1', port: 8899 },
        tls: { certFile: join(dir, 'cert.pem'), keyFile: join(dir, 'key.pem') },
        rtspOrigin: 'rtsp://127.0.0.1:8554',
        rtspReader: { username: 'snapshot-reader', password: 'e2e-mediamtx-reader-0123456789' },
        ffmpegPath: FFMPEG,
        timeoutMs: 6000,
        maxWidth: 1920,
        paths: [
          {
            path: PATH,
            username: 'app-snapshot',
            passwordSha256: createHash('sha256').update(SECRET).digest('hex'),
          },
        ],
      })
    );
    server = createGatewayServer(config, { spawn: testPatternSpawn, log: () => undefined });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(null)));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    files.clear();
    spawnedArgs.length = 0;
    pinnedLookups.length = 0;
    vi.stubEnv('STORAGE_ADAPTER', 'local');
    vi.stubEnv('NODE_ENV', 'test');
  });

  it('captures a real ffmpeg PNG still into private storage for the exact scope', async () => {
    const database = db();
    const result = await capture(runtimeFor(), database);
    expect(result).toMatchObject({ evidenceId: 'ev_1', outcome: 'CAPTURED' });

    // The gateway asked ffmpeg for the configured MediaMTX loopback path only.
    expect(spawnedArgs).toHaveLength(1);
    expect(spawnedArgs[0]).toContain(
      `rtsp://snapshot-reader:e2e-mediamtx-reader-0123456789@127.0.0.1:8554/${PATH}`
    );
    expect(pinnedLookups).toEqual([PINNED]);

    const stored = [...files.values()];
    expect(stored).toHaveLength(1);
    // Scaled down to maxWidth by the gateway, and a complete decodable PNG.
    expect(inspectPngStill(stored[0])).toEqual({ width: 1920, height: 1080 });
  }, 30_000);

  it('a wrong reader secret is refused by the gateway and nothing is stored', async () => {
    const result = await capture(runtimeFor('wrong-reader-secret-0000000000'));
    expect(result).toMatchObject({ outcome: 'FAILED', reason: 'SNAPSHOT_UNAVAILABLE' });
    expect(spawnedArgs).toHaveLength(0);
    expect(files.size).toBe(0);
  }, 30_000);

  it('a certificate for another hostname is refused before any request', async () => {
    const transport = createCameraSnapshotTransport(
      bindings().replaceAll(HOST, 'other.pharmacy.test'),
      loopbackRequest
    );
    await expect(
      transport.readSnapshot({
        vertical: 'pharmacy',
        organizationId: 'org_a',
        branchId: 'branch_a',
        gatewayId: 'gw_a',
        cameraId: 'cam_a',
        baseUrl: 'https://other.pharmacy.test/',
      })
    ).rejects.toMatchObject({ code: 'gateway-unreachable' });
    expect(spawnedArgs).toHaveLength(0);
  }, 30_000);
});
