// Run with the repository's pinned Bun. Separate .mts avoids mixing Bun module
// mocks into Vitest workers; no packages or application server are required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { mock } = await import('bun:' + 'test');

const organizationId = 'tenant-a';
const actor = {
  support: null as { id: string } | null,
  session: { user: { id: 'viewer-a' } },
  organization: { id: organizationId },
};
let signedIn = true;
let entitled = true;
let calls = 0;
let grant = makeGrant();
let camera = makeCamera();
let gateway = makeGateway();
function makeGrant() {
  return {
    organizationId,
    cameraId: 'camera-a',
    viewerId: 'viewer-a',
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null as Date | null,
  };
}
function makeCamera() {
  return {
    id: 'camera-a',
    organizationId,
    branchId: 'branch-a',
    gatewayId: 'gateway-a',
    enabled: true,
  };
}
function makeGateway() {
  return {
    id: 'gateway-a',
    organizationId,
    branchId: 'branch-a',
    status: 'ACTIVE',
    revokedAt: null as Date | null,
    baseUrl: 'https://gateway.example.test/',
  };
}
const runtime = {
  available: true,
  mode: 'mediamtx',
  transport: {
    read: async () => {
      calls++;
      return {
        bytes: Buffer.from('#EXTM3U\n#EXTINF:2,\nseg0.ts\n'),
        manifest: true,
        contentType: 'application/vnd.apple.mpegurl',
      };
    },
  },
};
mock.module('@/lib/restaurant/camera-gateway-runtime', () => ({ cameraGatewayRuntime: runtime }));
mock.module('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: async () => (signedIn ? actor : null),
}));
mock.module('@/lib/entitlements', () => ({
  hasModule: () => entitled,
  resolveOrganizationEntitlements: async () => ({}),
}));
const db = {
  restaurantCameraStreamGrant: { findUnique: async () => grant },
  restaurantCamera: { findUnique: async () => camera },
  restaurantCameraGateway: { findUnique: async () => gateway },
};
mock.module('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: async (id: string, callback: (db: unknown) => unknown) => {
    assert.equal(id, organizationId);
    return callback(db);
  },
}));
const { GET } = await import('../../../app/api/restaurant/cameras/[cameraId]/stream/route');

function reset() {
  signedIn = true;
  actor.support = null;
  entitled = true;
  calls = 0;
  grant = makeGrant();
  camera = makeCamera();
  gateway = makeGateway();
  runtime.available = true;
}
function get(query = '?grant=grant-a') {
  return GET(
    new Request(`https://app.example.test/api/restaurant/cameras/camera-a/stream${query}`),
    { params: Promise.resolve({ cameraId: 'camera-a' }) }
  );
}

test('authorized route rewrites every playlist request through viewer grant', async () => {
  reset();
  const response = await get();
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.match(
    await response.text(),
    /\/api\/restaurant\/cameras\/camera-a\/stream\?grant=grant-a&segment=seg0.ts/
  );
});

test('support cannot use an existing grant for a playlist or a segment', async () => {
  reset();
  actor.support = { id: 'synthetic-support' };
  for (const query of ['?grant=grant-a', '?grant=grant-a&segment=seg0.ts']) {
    assert.equal((await get(query)).status, 403);
  }
  assert.equal(calls, 0);
});

test('route rejects missing actor, entitlement, runtime and grant without upstream reads', async () => {
  for (const [change, status] of [
    [
      () => {
        signedIn = false;
      },
      401,
    ],
    [
      () => {
        entitled = false;
      },
      403,
    ],
    [
      () => {
        runtime.available = false;
      },
      503,
    ],
  ] as const) {
    reset();
    change();
    assert.equal((await get()).status, status);
    assert.equal(calls, 0);
  }
  reset();
  assert.equal((await get('')).status, 401);
  assert.equal(calls, 0);
});

test('route freshly rejects expired, revoked, wrong-viewer and cross-tenant grants', async () => {
  for (const change of [
    () => {
      grant.expiresAt = new Date(0);
    },
    () => {
      grant.revokedAt = new Date();
    },
    () => {
      grant.viewerId = 'other';
    },
    () => {
      grant.organizationId = 'other';
    },
  ]) {
    reset();
    change();
    assert.equal((await get()).status, 401);
    assert.equal(calls, 0);
  }
});

test('route rejects cross-camera, tenant, branch, disabled camera and revoked gateway', async () => {
  for (const change of [
    () => {
      grant.cameraId = 'other';
    },
    () => {
      camera.organizationId = 'other';
    },
    () => {
      camera.enabled = false;
    },
    () => {
      gateway.organizationId = 'other';
    },
    () => {
      gateway.branchId = 'other';
    },
    () => {
      gateway.status = 'REVOKED';
    },
    () => {
      gateway.revokedAt = new Date();
    },
  ]) {
    reset();
    change();
    assert.equal((await get()).status, 403);
    assert.equal(calls, 0);
  }
});

test('recording requests never substitute live media or read upstream', async () => {
  for (const query of [
    '?grant=grant-a&recording=archive',
    '?grant=grant-a&recording=',
    '?grant=grant-a&segment=seg0.ts&recording=archive',
  ]) {
    reset();
    const result = await get(query);
    assert.equal(result.status, 400);
    assert.equal(await result.text(), 'Recording playback unsupported');
    assert.equal(calls, 0);
  }
});

test('revocation takes effect on the next segment request', async () => {
  reset();
  assert.equal((await get()).status, 200);
  grant.revokedAt = new Date();
  assert.equal((await get('?grant=grant-a&segment=seg0.ts')).status, 401);
  assert.equal(calls, 1);
});
