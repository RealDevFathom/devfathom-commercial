// @vitest-environment node
/**
 * DEV-1003 integration test against a REAL MediaMTX release binary.
 *
 * The relay runs the reference configuration from
 * industry-specific-docs/pharmacy/cameras/001-configured-gateway-live-view.md verbatim
 * (placeholders replaced) with HTTPS from a throwaway CA, and pulls its source over RTSP
 * from a second MediaMTX process that stands in for the DVR, fed by ffmpeg's synthetic
 * test pattern (H.264, plus H.265 when ffmpeg has libx265). The real pharmacy and
 * restaurant stream routes then serve playlists and segments through the app; identity
 * and the tenant database are mocked exactly as in the route unit tests.
 *
 * Needs: MEDIAMTX_BINARY (path to the release binary), ffmpeg and openssl on PATH, and a
 * private (RFC 1918) IPv4 address on this machine, because bindings accept only those.
 * Without them the suite is skipped and its title says why.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer as createHttpsServer,
  request as httpsRequest,
  type RequestOptions,
} from 'node:https';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actor: null as unknown,
  db: null as unknown,
  runtime: { available: true, mode: 'mediamtx', transport: undefined as unknown },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: vi.fn(async () => mocks.actor),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: vi.fn(async (_organizationId: string, run: (db: unknown) => unknown) =>
    run(mocks.db)
  ),
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: vi.fn(async () => ({
    enabledModules: ['pharmacy-core', 'restaurant-integrations'],
  })),
}));
vi.mock('@/lib/abac', () => ({
  can: vi.fn(async () => true),
  subjectFromSession: (user: { id: string }) => ({ id: user.id }),
}));
vi.mock('@/lib/auth/session-state', () => ({ responseForPasswordChange: () => null }));
vi.mock('@/lib/cameras/camera-gateway-runtime', () => ({ cameraGatewayRuntime: mocks.runtime }));

import { GET as pharmacyStream } from '@/app/api/pharmacy/cameras/[cameraId]/stream/route';
import { GET as restaurantStream } from '@/app/api/restaurant/cameras/[cameraId]/stream/route';
import { createMediaMtxTransport } from './mediamtx';

const HOST = 'camera-gateway.test';
const BASE_URL_PORT = (port: number) => `https://${HOST}:${port}/`;
const READER = 'devfathom-hls-reader';
const READER_PASSWORD = 'synthetic-reader-pw-0123';
const DVR_USER = 'synthetic-dvr-viewer';
const DVR_PASSWORD = 'synthetic-dvr-pw-0123';
const DOC = 'industry-specific-docs/pharmacy/cameras/001-configured-gateway-live-view.md';

function which(command: string, ...args: string[]) {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const privateAddress = Object.values(networkInterfaces())
  .flat()
  .find(
    (row) =>
      row?.family === 'IPv4' && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(row.address)
  )?.address;
const binary = process.env.MEDIAMTX_BINARY;
const missing = [
  !binary || !existsSync(binary) ? 'MEDIAMTX_BINARY is not set to a MediaMTX release binary' : '',
  !which('ffmpeg', '-version') ? 'ffmpeg is not installed' : '',
  !which('openssl', 'version') ? 'openssl is not installed' : '',
  !privateAddress ? 'no private (RFC 1918) IPv4 address on this machine' : '',
].filter(Boolean);
const version = (() => {
  if (missing.length) return '';
  const help = execFileSync(binary!, ['--help'], { encoding: 'utf8' });
  return /MediaMTX v(\d+\.\d+\.\d+)/.exec(help)?.[1] ?? '';
})();
const [major, minor] = version.split('.').map(Number);
const hasMoq = major > 1 || minor >= 19;
const hasHevc =
  !missing.length &&
  execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).includes('libx265');

const suite = missing.length ? describe.skip : describe;
const title = missing.length
  ? `real MediaMTX relay (skipped: ${missing.join('; ')})`
  : `real MediaMTX v${version} relay`;

async function freePort() {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

suite(title, () => {
  let dir = '';
  const processes: ChildProcess[] = [];
  const relayLog: string[] = [];
  let relay: ChildProcess;
  let hlsPort = 0;
  let baseUrl = '';
  let ca: Buffer;
  let transport: ReturnType<typeof createMediaMtxTransport>;

  /** Production uses NODE_EXTRA_CA_CERTS; the test passes its throwaway CA directly. */
  const requestWithCa = ((url: URL, options: RequestOptions, callback: never) =>
    httpsRequest(url, { ...options, ca }, callback)) as unknown as typeof httpsRequest;

  const bindings = () => [
    {
      vertical: 'pharmacy',
      organizationId: 'org_a',
      branchId: 'branch_a',
      gatewayId: 'gw_1',
      cameraId: 'cam_ph',
      baseUrl,
      address: privateAddress,
      path: 'pharmacy-counter-1',
      username: READER,
      password: READER_PASSWORD,
    },
    {
      organizationId: 'org_a',
      branchId: 'branch_a',
      gatewayId: 'gw_1',
      cameraId: 'cam_rs',
      baseUrl,
      address: privateAddress,
      path: 'restaurant-kitchen-hevc',
      username: READER,
      password: READER_PASSWORD,
    },
  ];
  const pharmacyScope = () => ({
    vertical: 'pharmacy' as const,
    organizationId: 'org_a',
    branchId: 'branch_a',
    gatewayId: 'gw_1',
    cameraId: 'cam_ph',
    baseUrl,
  });

  function start(command: string, args: string[], log?: string[]) {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (chunk: Buffer) => log?.push(chunk.toString('utf8'));
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    processes.push(child);
    return child;
  }
  async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(5_000)]);
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
  }

  function relayConfig() {
    const doc = readFileSync(DOC, 'utf8');
    const block = /<!-- mediamtx-reference-config -->\s*```yaml\n([\s\S]*?)```/.exec(doc)?.[1];
    if (!block) throw new Error('reference configuration block missing from the document');
    const permission = (path: string) => `      - action: read\n        path: ${path}\n`;
    let yaml = block
      .replace('REPLACE_WITH_READER_PASSWORD', READER_PASSWORD)
      // The app server here is this test process, which reaches the relay from the same address.
      .replace("ips: ['10.20.30.50/32']", `ips: ['${privateAddress}/32']`)
      .replace('10.20.30.40:8888', `${privateAddress}:${hlsPort}`)
      .replace('/etc/mediamtx/camera-gateway.key', join(dir, 'relay.key'))
      .replace('/etc/mediamtx/camera-gateway.crt', join(dir, 'relay.crt'))
      .replace(
        permission('pharmacy-counter-1'),
        permission('pharmacy-counter-1') + permission('restaurant-kitchen-hevc')
      );
    const source = /^ {4}source: .*$/m;
    const paths = yaml.slice(yaml.indexOf('\npaths:\n'));
    const pathBlock = (name: string) =>
      paths
        .replace('\npaths:\n', '')
        .replace('pharmacy-counter-1:', `${name}:`)
        .replace(
          source,
          `    source: rtsp://${DVR_USER}:${DVR_PASSWORD}@127.0.0.1:${dvrPort}/${name}`
        );
    yaml =
      yaml.slice(0, yaml.indexOf('\npaths:\n')) +
      `\npaths:\n${pathBlock('pharmacy-counter-1')}${pathBlock('restaurant-kitchen-hevc')}`;
    if (!hasMoq) yaml = yaml.replace(/^moq: false\n/m, '');
    return yaml;
  }

  let dvrPort = 0;
  const encoded = (path: string, codec: 'libx264' | 'libx265') => [
    '-loglevel',
    'error',
    '-re',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=640x360:rate=25',
    '-c:v',
    codec,
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    ...(codec === 'libx264'
      ? ['-tune', 'zerolatency', '-g', '25']
      : ['-x265-params', 'log-level=error:keyint=25']),
    '-f',
    'rtsp',
    '-rtsp_transport',
    'tcp',
    `rtsp://publisher:synthetic-publisher-pw@127.0.0.1:${dvrPort}/${path}`,
  ];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dev1003-relay-'));
    hlsPort = await freePort();
    dvrPort = await freePort();
    baseUrl = BASE_URL_PORT(hlsPort);
    const openssl = (...args: string[]) =>
      execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
    openssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.crt',
      '-days',
      '1',
      '-subj',
      '/CN=DEV-1003 throwaway relay CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign'
    );
    openssl(
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'relay.key',
      '-out',
      'relay.csr',
      '-subj',
      `/CN=${HOST}`
    );
    writeFileSync(
      join(dir, 'ext.cnf'),
      `subjectAltName=DNS:${HOST}\nextendedKeyUsage=serverAuth\n`
    );
    openssl(
      'x509',
      '-req',
      '-in',
      'relay.csr',
      '-CA',
      'ca.crt',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      'relay.crt',
      '-days',
      '1',
      '-extfile',
      'ext.cnf'
    );
    ca = readFileSync(join(dir, 'ca.crt'));

    // Stand-in DVR: an RTSP-only MediaMTX on loopback that the relay pulls with a login.
    writeFileSync(
      join(dir, 'dvr.yml'),
      [
        'logLevel: warn',
        'authMethod: internal',
        'authInternalUsers:',
        '  - user: publisher',
        '    pass: synthetic-publisher-pw',
        "    ips: ['127.0.0.1/32']",
        '    permissions:',
        '      - action: publish',
        `  - user: ${DVR_USER}`,
        `    pass: ${DVR_PASSWORD}`,
        "    ips: ['127.0.0.1/32']",
        '    permissions:',
        '      - action: read',
        'api: false',
        'metrics: false',
        'pprof: false',
        'playback: false',
        'rtsp: true',
        'rtspTransports: [tcp]',
        `rtspAddress: 127.0.0.1:${dvrPort}`,
        'rtmp: false',
        'hls: false',
        'webrtc: false',
        'srt: false',
        ...(hasMoq ? ['moq: false'] : []),
        'paths:',
        '  all_others:',
        '',
      ].join('\n')
    );
    start(binary!, [join(dir, 'dvr.yml')]);
    await sleep(1_000);
    start('ffmpeg', encoded('pharmacy-counter-1', 'libx264'));
    if (hasHevc) start('ffmpeg', encoded('restaurant-kitchen-hevc', 'libx265'));

    writeFileSync(join(dir, 'relay.yml'), relayConfig());
    relay = start(binary!, [join(dir, 'relay.yml')], relayLog);
    transport = createMediaMtxTransport(JSON.stringify(bindings()), requestWithCa);
    mocks.runtime.transport = transport;
    mocks.actor = {
      session: {
        user: { id: 'owner_1', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_a' },
      },
      organization: { id: 'org_a', isDemo: false, vertical: 'PHARMACY' },
      support: null,
    };
    const live = {
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000),
      organizationId: 'org_a',
      viewerId: 'owner_1',
    };
    const gateway = {
      id: 'gw_1',
      organizationId: 'org_a',
      branchId: 'branch_a',
      status: 'ACTIVE',
      revokedAt: null,
      baseUrl,
    };
    mocks.db = {
      cameraStreamGrant: {
        findFirst: async () => ({ id: 'grant_ph', cameraId: 'cam_ph', ...live }),
      },
      camera: {
        findFirst: async () => ({
          id: 'cam_ph',
          organizationId: 'org_a',
          branchId: 'branch_a',
          enabled: true,
          gateway,
        }),
      },
      pharmacyBranch: { findFirst: async () => ({ id: 'branch_a' }) },
      pharmacyBranchAssignment: { findFirst: async () => null },
      restaurantCameraStreamGrant: {
        findUnique: async () => ({ id: 'grant_rs', cameraId: 'cam_rs', ...live }),
      },
      restaurantCamera: {
        findUnique: async () => ({
          id: 'cam_rs',
          organizationId: 'org_a',
          branchId: 'branch_a',
          enabled: true,
          gatewayId: 'gw_1',
        }),
      },
      restaurantCameraGateway: { findUnique: async () => gateway },
    };
    // The relay connects to the stand-in DVR and needs a few segments before it answers.
    let outcome = '';
    for (let attempt = 0; attempt < 40; attempt++) {
      outcome = (await transport.diagnose(pharmacyScope())).outcome;
      if (outcome === 'ok') return;
      await sleep(500);
    }
    throw new Error(
      `relay never became ready (last check: ${outcome}):\n${relayLog.join('').slice(-2000)}`
    );
  }, 60_000);

  afterAll(async () => {
    await Promise.all(processes.map(stop));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const through = (vertical: 'pharmacy' | 'restaurant', query: string) => {
    const cameraId = vertical === 'pharmacy' ? 'cam_ph' : 'cam_rs';
    const grant = vertical === 'pharmacy' ? 'grant_ph' : 'grant_rs';
    const url = `https://tenant.example/api/${vertical}/cameras/${cameraId}/stream?grant=${grant}${query}`;
    const handler = vertical === 'pharmacy' ? pharmacyStream : restaurantStream;
    return handler(new Request(url), { params: Promise.resolve({ cameraId }) });
  };
  const references = (playlist: string) =>
    playlist
      .split('\n')
      .flatMap((line) => (line.startsWith('#') ? [/URI="([^"]+)"/.exec(line)?.[1]] : [line]))
      .filter((line): line is string => Boolean(line))
      .map((reference) =>
        new URL(reference, 'https://tenant.example').searchParams.get('segment')!
      );
  const forbidden = (text: string) =>
    [
      HOST,
      privateAddress!,
      READER_PASSWORD,
      DVR_PASSWORD,
      'hlsSession',
      'session=',
      'rtsp://',
    ].filter((needle) => text.includes(needle));

  it('reports ok for the connection check, with the codec', async () => {
    await expect(transport.diagnose(pharmacyScope())).resolves.toEqual({
      outcome: 'ok',
      discoveredProfile: 'Configured HLS gateway',
      videoCodec: 'h264',
    });
  });

  it('serves the playlist and segments through the pharmacy route for more than 60 seconds', async () => {
    const started = Date.now();
    const segments = new Set<string>();
    let bytes = 0;
    let masters = 0;
    let media = '';
    while (Date.now() - started < 65_000) {
      // The player reloads the master playlist on every grant renewal (about 40 s).
      if (!media || Date.now() - started > masters * 40_000) {
        const master = await through('pharmacy', '');
        expect(master.status).toBe(200);
        const text = await master.text();
        expect(forbidden(text)).toEqual([]);
        media = references(text)[0];
        masters++;
      }
      const playlist = await through('pharmacy', `&segment=${encodeURIComponent(media)}`);
      expect(playlist.status).toBe(200);
      const text = await playlist.text();
      expect(forbidden(text)).toEqual([]);
      for (const name of references(text)) {
        if (segments.has(name)) continue;
        const segment = await through('pharmacy', `&segment=${encodeURIComponent(name)}`);
        expect(segment.status).toBe(200);
        expect(segment.headers.get('Content-Type')).toBe('video/mp4');
        const body = Buffer.from(await segment.arrayBuffer());
        expect(['ftyp', 'moof', 'styp']).toContain(body.subarray(4, 8).toString('latin1'));
        bytes += body.length;
        segments.add(name);
      }
      await sleep(1_000);
    }
    expect(Date.now() - started).toBeGreaterThan(60_000);
    expect(masters).toBeGreaterThanOrEqual(2);
    expect(segments.size).toBeGreaterThan(50);
    expect(bytes).toBeGreaterThan(100_000);
  }, 120_000);

  it('keeps serving after 30 s idle (v1.18+: renews the session the relay closed)', async () => {
    const master = await through('pharmacy', '');
    const media = references(await master.text())[0];
    expect((await through('pharmacy', `&segment=${encodeURIComponent(media)}`)).status).toBe(200);
    await sleep(42_000);
    if (major === 1 && minor >= 18)
      expect(relayLog.join('')).toMatch(/\[HLS\] \[session [0-9a-f]+\] closed: inactive/);
    const after = await through('pharmacy', `&segment=${encodeURIComponent(media)}`);
    expect(after.status).toBe(200);
    expect(forbidden(await after.text())).toEqual([]);
  }, 90_000);

  it.skipIf(!hasHevc)(
    'serves H.265 through the restaurant route and names the codec',
    async () => {
      const scope = { ...pharmacyScope(), vertical: undefined, cameraId: 'cam_rs' };
      let check = await transport.diagnose(scope);
      for (let attempt = 0; attempt < 20 && check.outcome !== 'ok'; attempt++) {
        await sleep(500);
        check = await transport.diagnose(scope);
      }
      expect(check).toMatchObject({ outcome: 'ok', videoCodec: 'h265' });
      const master = await through('restaurant', '');
      expect(master.status).toBe(200);
      const masterText = await master.text();
      expect(masterText).toMatch(/CODECS="(hvc1|hev1)/);
      const playlist = await through(
        'restaurant',
        `&segment=${encodeURIComponent(references(masterText)[0])}`
      );
      const text = await playlist.text();
      expect(forbidden(text)).toEqual([]);
      const segment = await through(
        'restaurant',
        `&segment=${encodeURIComponent(references(text).at(-1)!)}`
      );
      expect(segment.status).toBe(200);
      expect((await segment.arrayBuffer()).byteLength).toBeGreaterThan(0);
    },
    30_000
  );

  it('reports a wrong viewer password as auth-failed', async () => {
    const wrong = createMediaMtxTransport(
      JSON.stringify([{ ...bindings()[0], password: 'not-the-reader-password' }]),
      requestWithCa
    );
    await expect(wrong.diagnose(pharmacyScope())).resolves.toEqual({ outcome: 'auth-failed' });
  }, 30_000);

  it('never follows a redirect to another host, and connects only to the bound address', async () => {
    const hits: string[] = [];
    const key = readFileSync(join(dir, 'relay.key'));
    const cert = readFileSync(join(dir, 'relay.crt'));
    // The "other host" is another listener on loopback; it must never be contacted.
    const other = createHttpsServer({ key, cert }, (req, res) => {
      hits.push(req.url ?? '');
      res.end('#EXTM3U\n');
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const otherPort = (other.address() as AddressInfo).port;
    const rogue = createHttpsServer({ key, cert }, (_req, res) => {
      res.writeHead(302, {
        location: `https://127.0.0.1:${otherPort}/pharmacy-counter-1/index.m3u8?cookieCheck=1`,
      });
      res.end();
    });
    await new Promise<void>((resolve) => rogue.listen(0, privateAddress, resolve));
    const rogueBase = BASE_URL_PORT((rogue.address() as AddressInfo).port);
    const redirected = createMediaMtxTransport(
      JSON.stringify([{ ...bindings()[0], baseUrl: rogueBase }]),
      requestWithCa
    );
    await expect(redirected.diagnose({ ...pharmacyScope(), baseUrl: rogueBase })).resolves.toEqual({
      outcome: 'relay-unsupported',
    });
    expect(hits).toEqual([]);
    await new Promise((resolve) => rogue.close(resolve));
    await new Promise((resolve) => other.close(resolve));
  }, 30_000);

  it('reports a stopped relay as gateway-unreachable, through the route as a fixed code', async () => {
    await stop(relay);
    await expect(transport.diagnose(pharmacyScope())).resolves.toEqual({
      outcome: 'gateway-unreachable',
    });
    const res = await through('pharmacy', '');
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('gateway-unreachable');
  }, 30_000);
});
