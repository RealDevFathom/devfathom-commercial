// Native Bun/Node tests; kept outside the Vitest .test.ts discovery pattern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createServer,
  request as httpRequest,
  type RequestListener,
  type RequestOptions,
} from 'node:http';
import type { request as httpsRequest } from 'node:https';
import { createMediaMtxTransport, rewriteCameraManifest, cameraResourceName } from './mediamtx';

const scope = {
  organizationId: 'tenant-a',
  branchId: 'branch-a',
  gatewayId: 'gateway-a',
  cameraId: 'camera-a',
  baseUrl: 'https://gateway.example.test/',
};
const binding = {
  ...scope,
  address: '10.20.30.40',
  path: 'tenant-a/camera-a',
  username: 'fixture-reader',
  password: 'fixture-only',
};
const master =
  '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.42c028"\nmain_stream.m3u8\n';
const playlist =
  '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.0,\nseg0.mp4\n';

// Real HTTP framing/body fixture on loopback, never a DVR or app service.
// Injection replaces only the socket transport; production has no HTTP switch.
async function fixture(
  handler: RequestListener,
  run: (transport: ReturnType<typeof createMediaMtxTransport>) => Promise<void>,
  config = binding
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const injected = ((
    url: URL,
    options: RequestOptions & { rejectUnauthorized: boolean },
    callback: Parameters<typeof httpRequest>[2]
  ) => {
    assert.equal(url.origin, scope.baseUrl.slice(0, -1));
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.agent, false);
    assert.equal(
      (options.headers as Record<string, string>).Authorization,
      `Basic ${Buffer.from('fixture-reader:fixture-only').toString('base64')}`
    );
    return httpRequest(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: url.pathname,
        method: 'GET',
        headers: options.headers,
      },
      callback
    );
  }) as unknown as typeof httpsRequest;
  try {
    await run(createMediaMtxTransport(JSON.stringify([config]), injected));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('real HTTP fixture carries master, fMP4 playlist, init and segment through confined reads', async () => {
  const paths: string[] = [];
  await fixture(
    (req, res) => {
      paths.push(req.url!);
      const name = req.url!.split('/').pop();
      res.end(
        name === 'index.m3u8'
          ? master
          : name === 'main_stream.m3u8'
            ? playlist
            : Buffer.from([0, 0, 0, 24, 102, 116, 121, 112])
      );
    },
    async (transport) => {
      assert.deepEqual(await transport.diagnose(scope), {
        outcome: 'ok',
        discoveredProfile: 'Configured HLS gateway',
      });
      const result = await transport.read(scope, 'main_stream.m3u8');
      const rewritten = rewriteCameraManifest(
        result.bytes.toString(),
        (name) => `/proxy?grant=short&segment=${name}`
      );
      assert.match(rewritten, /URI="\/proxy\?grant=short&segment=init.mp4"/);
      assert.match(rewritten, /\/proxy\?grant=short&segment=seg0.mp4/);
      for (const name of ['init.mp4', 'seg0.mp4']) {
        const segment = await transport.read(scope, name);
        assert.equal(segment.contentType, 'video/mp4');
        assert.equal(segment.bytes.length, 8);
      }
    }
  );
  assert.deepEqual(
    paths,
    ['index.m3u8', 'main_stream.m3u8', 'init.mp4', 'seg0.mp4'].map(
      (name) => `/tenant-a/camera-a/${name}`
    )
  );
});

test('scope mismatches never open a socket', async () => {
  let requests = 0;
  await fixture(
    (_req, res) => {
      requests++;
      res.end(master);
    },
    async (transport) => {
      for (const key of ['organizationId', 'branchId', 'gatewayId', 'cameraId', 'baseUrl'])
        await assert.rejects(transport.read({ ...scope, [key]: 'other' }), /not-configured/);
    }
  );
  assert.equal(requests, 0);
});

test('credentials missing distinguished before any request', async () => {
  await fixture(
    () => assert.fail('unexpected network'),
    async (transport) => {
      assert.deepEqual(await transport.diagnose(scope), { outcome: 'credentials-missing' });
    },
    { ...binding, password: '' }
  );
});

test('authentication, missing stream, and redirect have safe distinct outcomes', async () => {
  for (const [status, outcome] of [
    [401, 'auth-failed'],
    [403, 'auth-failed'],
    [404, 'unsupported-stream'],
    [415, 'unsupported-stream'],
    [302, 'gateway-unreachable'],
    [500, 'gateway-unreachable'],
  ] as const) {
    let requests = 0;
    await fixture(
      (_req, res) => {
        requests++;
        res.writeHead(status, { Location: 'http://127.0.0.1/private' });
        res.end('rtsp://secret:password@camera');
      },
      async (transport) => {
        assert.deepEqual(await transport.diagnose(scope), { outcome });
      }
    );
    assert.equal(requests, 1);
  }
});

test('streaming body limits reject oversized chunked manifest', async () => {
  await fixture(
    (_req, res) => {
      res.writeHead(200);
      res.write('#EXTM3U\n');
      res.end('x'.repeat(256 * 1024));
    },
    async (transport) => {
      await assert.rejects(transport.read(scope), /unsupported-stream/);
    }
  );
});

test('concurrent reads bounded and capacity released after completion', async () => {
  const responses: import('node:http').ServerResponse[] = [];
  let ready!: () => void;
  const allReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  await fixture(
    (_req, res) => {
      responses.push(res);
      if (responses.length === 16) ready();
      else if (responses.length > 16) res.end(master);
    },
    async (transport) => {
      const pending = Array.from({ length: 16 }, () => transport.read(scope));
      await allReady;
      await assert.rejects(transport.read(scope), /gateway-unreachable/);
      responses.forEach((res) => res.end(master));
      assert.equal((await Promise.all(pending)).length, 16);
      assert.equal((await transport.read(scope)).manifest, true);
    }
  );
});

test('resource URL confinement rejects traversal, encoded paths, external URLs and unsupported tags', () => {
  for (const name of [
    '../other.ts',
    '%2e%2e.ts',
    'http://evil/a.ts',
    '//evil/a.ts',
    '/a.ts',
    'a.ts?x=1',
    'a\\b.ts',
    '.',
    'a.key',
  ]) {
    assert.throws(() => cameraResourceName(name), /unsupported-stream/);
    assert.throws(
      () => rewriteCameraManifest(`#EXTM3U\n${name}\n`, (x) => x),
      /unsupported-stream/
    );
    assert.throws(
      () => rewriteCameraManifest(`#EXTM3U\n#EXT-X-MAP:URI="${name}"\n`, (x) => x),
      /unsupported-stream/
    );
  }
  for (const line of [
    '#EXT-X-KEY:METHOD=AES-128,URI="key.ts"',
    '#EXT-X-MAP:URI=init.mp4',
    '#EXT-X-PART:URI="part.mp4"',
    '#EXT-X-SESSION-DATA:URI="secret.ts"',
  ])
    assert.throws(
      () => rewriteCameraManifest(`#EXTM3U\n${line}\n`, (x) => x),
      /unsupported-stream/
    );
});

test('configuration rejects ambiguous mappings, public/metadata/loopback IPs and URL credentials', () => {
  for (const address of ['127.0.0.1', '169.254.169.254', '8.8.8.8', 'gateway.test', '::1'])
    assert.throws(
      () => createMediaMtxTransport(JSON.stringify([{ ...binding, address }])),
      /not-configured/
    );
  for (const baseUrl of [
    'http://gateway.test/',
    'https://user:secret@gateway.test/',
    'https://10.20.30.40/',
    'https://gateway.test/path/',
    'https://gateway.test/?q=x',
  ])
    assert.throws(
      () => createMediaMtxTransport(JSON.stringify([{ ...binding, baseUrl }])),
      /not-configured/
    );
  assert.throws(
    () => createMediaMtxTransport(JSON.stringify([binding, binding])),
    /not-configured/
  );
  assert.throws(() => createMediaMtxTransport('secret-invalid-json'), /not-configured/);
});
