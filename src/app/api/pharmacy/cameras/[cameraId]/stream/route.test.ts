/**
 * DEV-740 pharmacy stream route: per-request authorization and containment.
 *
 * Identity, tenant database and transport are mocked; the mocked database
 * honours the `where` filters the route sends. These cases prove the route's
 * decisions and response shaping, not RLS, TLS, codecs or physical frames.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actor: null as unknown,
  hasModule: vi.fn(() => true),
  can: vi.fn(async () => true),
  read: vi.fn(),
  runtime: { available: true, mode: 'mediamtx', transport: {} as unknown } as {
    available: boolean;
    mode: string;
    transport?: unknown;
  },
  db: null as unknown,
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
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: ['pharmacy-core'] })),
}));
vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: { id: string; role?: string }) => ({ id: user.id, role: user.role }),
}));
vi.mock('@/lib/auth/session-state', () => ({ responseForPasswordChange: () => null }));
vi.mock('@/lib/cameras/camera-gateway-runtime', () => ({ cameraGatewayRuntime: mocks.runtime }));

import { CameraTransportError } from '@/lib/cameras/mediamtx';
import { GET } from './route';

type Where = Record<string, unknown>;
type Grant = {
  id: string;
  organizationId: string;
  cameraId: string;
  viewerId: string;
  revokedAt: Date | null;
  expiresAt: Date;
};
const BASE = 'https://camera-gateway.example.internal/';
const UPSTREAM_SECRET = 'synthetic-reader-secret';
let grants: Grant[];
let camera: Record<string, unknown> | null;
let branches: { id: string; organizationId: string; active: boolean }[];
let assignments: { organizationId: string; branchId: string; userId: string; active: boolean }[];

function gateway(over: Record<string, unknown> = {}) {
  return {
    id: 'gw_1',
    organizationId: 'org_a',
    branchId: 'branch_a',
    status: 'ACTIVE',
    revokedAt: null,
    baseUrl: BASE,
    ...over,
  };
}
function cameraRow(over: Record<string, unknown> = {}) {
  return {
    id: 'cam_1',
    organizationId: 'org_a',
    branchId: 'branch_a',
    enabled: true,
    gateway: gateway(),
    ...over,
  };
}
const matches = (row: Record<string, unknown>, where: Where) =>
  Object.entries(where).every(([k, v]) => row[k] === v);

function makeDb() {
  return {
    cameraStreamGrant: {
      findFirst: vi.fn(
        async ({ where }: { where: Where }) => grants.find((g) => matches(g, where)) ?? null
      ),
    },
    camera: {
      findFirst: vi.fn(async ({ where }: { where: Where }) =>
        camera && matches(camera, where) ? camera : null
      ),
    },
    pharmacyBranch: {
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        const hit = branches.find((b) => matches(b, where));
        return hit ? { id: hit.id } : null;
      }),
    },
    pharmacyBranchAssignment: {
      findFirst: vi.fn(async ({ where }: { where: Where }) =>
        assignments.find((a) => matches(a, where)) ? { id: 'assignment' } : null
      ),
    },
  };
}

function actor(
  over: {
    user?: Record<string, unknown>;
    organization?: Record<string, unknown>;
    support?: unknown;
  } = {}
) {
  return {
    session: {
      user: {
        id: 'owner_1',
        role: 'ADMIN',
        status: 'ACTIVE',
        organizationId: 'org_a',
        ...over.user,
      },
    },
    organization: { id: 'org_a', isDemo: false, vertical: 'PHARMACY', ...over.organization },
    support: over.support ?? null,
  };
}
function grant(over: Partial<Grant> = {}): Grant {
  return {
    id: 'grant_1',
    organizationId: 'org_a',
    cameraId: 'cam_1',
    viewerId: 'owner_1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...over,
  };
}
const MANIFEST = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nseg_1.ts\n';
function call(query = '?grant=grant_1', cameraId = 'cam_1') {
  return GET(
    new Request(`https://tenant.example/api/pharmacy/cameras/${cameraId}/stream${query}`),
    {
      params: Promise.resolve({ cameraId }),
    }
  );
}

beforeEach(() => {
  grants = [grant()];
  camera = cameraRow();
  branches = [
    { id: 'branch_a', organizationId: 'org_a', active: true },
    { id: 'branch_b', organizationId: 'org_a', active: true },
  ];
  assignments = [];
  mocks.actor = actor();
  mocks.db = makeDb();
  mocks.hasModule.mockReset().mockReturnValue(true);
  mocks.can.mockReset().mockResolvedValue(true);
  mocks.read.mockReset().mockResolvedValue({
    bytes: Buffer.from(MANIFEST),
    manifest: true,
    contentType: 'application/vnd.apple.mpegurl',
  });
  mocks.runtime.available = true;
  mocks.runtime.mode = 'mediamtx';
  mocks.runtime.transport = { read: mocks.read };
});

describe('authorized playback', () => {
  it('serves a rewritten manifest through the same-origin endpoint only', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const body = await res.text();
    expect(body).toContain('/api/pharmacy/cameras/cam_1/stream?grant=grant_1&segment=seg_1.ts');
    expect(body).not.toContain(BASE);
    expect(body).not.toContain('10.');
    expect(mocks.read).toHaveBeenCalledWith(
      {
        vertical: 'pharmacy',
        organizationId: 'org_a',
        branchId: 'branch_a',
        gatewayId: 'gw_1',
        cameraId: 'cam_1',
        baseUrl: BASE,
      },
      'index.m3u8'
    );
  });

  it('passes media bytes unchanged with their content type', async () => {
    mocks.read.mockResolvedValue({
      bytes: Buffer.from([1, 2, 3]),
      manifest: false,
      contentType: 'video/mp2t',
    });
    const res = await call('?grant=grant_1&segment=seg_1.ts');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('video/mp2t');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(mocks.read).toHaveBeenCalledWith(expect.anything(), 'seg_1.ts');
  });

  it('admits an assigned non-ADMIN for their branch only', async () => {
    mocks.actor = actor({ user: { id: 'manager_1', role: 'MANAGER' } });
    grants = [grant({ viewerId: 'manager_1' })];
    expect((await call()).status).toBe(403);
    assignments.push({
      organizationId: 'org_a',
      branchId: 'branch_b',
      userId: 'manager_1',
      active: true,
    });
    expect((await call()).status).toBe(403);
    assignments.push({
      organizationId: 'org_a',
      branchId: 'branch_a',
      userId: 'manager_1',
      active: true,
    });
    expect((await call()).status).toBe(200);
  });

  it('ignores any caller-supplied upstream URL', async () => {
    const res = await call('?grant=grant_1&url=https://169.254.169.254/latest/meta-data');
    expect(res.status).toBe(200);
    expect(JSON.stringify(mocks.read.mock.calls)).not.toContain('169.254');
  });
});

describe('denials before any upstream read', () => {
  it.each([
    ['no session', () => (mocks.actor = null), 401],
    ['a demo tenant', () => (mocks.actor = actor({ organization: { isDemo: true } })), 403],
    ['a support session', () => (mocks.actor = actor({ support: { id: 'support_1' } })), 403],
    [
      'a restaurant tenant',
      () => (mocks.actor = actor({ organization: { vertical: 'RESTAURANT' } })),
      403,
    ],
    [
      'a session from another organization',
      () => (mocks.actor = actor({ user: { organizationId: 'org_b' } })),
      403,
    ],
    ['a missing entitlement', () => mocks.hasModule.mockReturnValue(false), 403],
    ['a removed admin capability', () => mocks.can.mockResolvedValue(false), 403],
    ['simulator mode', () => (mocks.runtime.mode = 'simulated'), 503],
    [
      'an unconfigured gateway',
      () => ((mocks.runtime.available = false), (mocks.runtime.mode = 'unavailable')),
      503,
    ],
    ['a missing grant', () => (grants = []), 401],
    ['an expired grant', () => (grants = [grant({ expiresAt: new Date(Date.now() - 1) })]), 401],
    ['a revoked grant', () => (grants = [grant({ revokedAt: new Date() })]), 401],
    ["another viewer's grant", () => (grants = [grant({ viewerId: 'someone_else' })]), 401],
    ["another tenant's grant", () => (grants = [grant({ organizationId: 'org_b' })]), 401],
    ['a grant for another camera', () => (grants = [grant({ cameraId: 'cam_2' })]), 403],
    ['a disabled camera', () => (camera = cameraRow({ enabled: false })), 403],
    ['a missing camera', () => (camera = null), 403],
    ['another tenant camera', () => (camera = cameraRow({ organizationId: 'org_b' })), 403],
    [
      'a revoked gateway',
      () => (camera = cameraRow({ gateway: gateway({ revokedAt: new Date() }) })),
      403,
    ],
    [
      'an inactive gateway',
      () => (camera = cameraRow({ gateway: gateway({ status: 'REVOKED' }) })),
      403,
    ],
    [
      'a gateway bound to another branch',
      () => (camera = cameraRow({ gateway: gateway({ branchId: 'branch_b' }) })),
      403,
    ],
    [
      'a gateway in another tenant',
      () => (camera = cameraRow({ gateway: gateway({ organizationId: 'org_b' }) })),
      403,
    ],
    ['an inactive branch', () => (branches = branches.map((b) => ({ ...b, active: false }))), 403],
  ])('refuses %s', async (_label, arrange, status) => {
    arrange();
    const res = await call();
    expect(res.status).toBe(status);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each(['?', '?grant=', '?grant=../../x', '?grant=a%20b'])(
    'refuses malformed grant %s',
    async (query) => {
      expect((await call(query)).status).toBe(401);
      expect(mocks.read).not.toHaveBeenCalled();
    }
  );

  it('refuses a malformed camera id and recording playback', async () => {
    expect((await call('?grant=grant_1', 'cam%2F..')).status).toBe(403);
    expect((await call('?grant=grant_1&recording=1')).status).toBe(400);
    expect(mocks.read).not.toHaveBeenCalled();
  });
});

describe('revocation, expiry and failure containment', () => {
  it('withholds the response when the grant is revoked during the upstream read', async () => {
    mocks.read.mockImplementation(async () => {
      grants[0]!.revokedAt = new Date();
      return {
        bytes: Buffer.from(MANIFEST),
        manifest: true,
        contentType: 'application/vnd.apple.mpegurl',
      };
    });
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('Unauthorized');
  });

  it('withholds the response when the grant expires during the upstream read', async () => {
    mocks.read.mockImplementation(async () => {
      grants[0]!.expiresAt = new Date(Date.now() - 1);
      return { bytes: Buffer.from([1]), manifest: false, contentType: 'video/mp2t' };
    });
    expect((await call('?grant=grant_1&segment=seg_1.ts')).status).toBe(401);
  });

  it.each([
    'not-configured',
    'credentials-missing',
    'auth-failed',
    'gateway-unreachable',
    'unsupported-stream',
  ] as const)('returns only the fixed %s code on transport failure', async (code) => {
    mocks.read.mockRejectedValue(new CameraTransportError(code));
    const res = await call();
    expect(res.status).toBe(502);
    expect(await res.text()).toBe(code);
  });

  it('never leaks an unexpected error message', async () => {
    mocks.read.mockRejectedValue(new Error(`connect https://user:${UPSTREAM_SECRET}@10.20.30.40/`));
    const res = await call();
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toBe('gateway-unreachable');
    expect(body).not.toContain(UPSTREAM_SECRET);
  });

  it('fails closed on an unsafe upstream manifest', async () => {
    mocks.read.mockResolvedValue({
      bytes: Buffer.from('#EXTM3U\nhttps://10.20.30.40/seg.ts\n'),
      manifest: true,
      contentType: 'application/vnd.apple.mpegurl',
    });
    const res = await call();
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('unsupported-stream');
  });
});
