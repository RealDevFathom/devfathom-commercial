/**
 * DEV-740 pharmacy configured-gateway (MediaMTX) router cases: gateway and camera
 * registration, configured diagnostics, live-view grants and branch scope.
 *
 * The mocked client honours the `where` filters the router sends, so a dropped
 * tenant, viewer, camera, expiry or branch filter widens the match and the case
 * fails. Nothing here proves a physical DVR, live frames, RLS or concurrency.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasModule: vi.fn(() => true),
  diagnose: vi.fn(async () => ({ outcome: 'ok' as string })),
  runtime: {
    available: true,
    mode: 'mediamtx',
    adapter: { getSnapshot: vi.fn() },
    transport: {} as { diagnose?: (scope: unknown) => Promise<{ outcome: string }> },
  } as {
    available: boolean;
    mode: string;
    adapter: { getSnapshot: ReturnType<typeof vi.fn> } | null;
    transport?: { diagnose?: (scope: unknown) => Promise<{ outcome: string }> };
  },
  seal: vi.fn((plain: string) => `sealed:${plain.length}`),
  annotate: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: mocks.annotate,
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/cameras/camera-gateway-runtime', () => ({
  cameraGatewayRuntime: mocks.runtime,
  cameraGatewayPublicState: (runtime: { available: boolean; mode: string }) =>
    runtime.available
      ? { available: true, mode: runtime.mode }
      : { available: false, mode: runtime.mode, reason: 'not-configured' },
}));
vi.mock('@/lib/storage', () => ({ deleteUpload: vi.fn(), putUpload: vi.fn() }));
vi.mock('@/lib/pharmacy/counter-evidence', () => ({ stillDataUrl: vi.fn() }));
vi.mock('@/lib/restaurant/camera-credentials', () => ({ sealCameraCredential: mocks.seal }));

import type { TRPCContext } from '../trpc';
import { pharmacyCamerasRouter } from './pharmacy-cameras';

type Where = Record<string, unknown>;
const BRANCHES = [
  { id: 'branch_a', organizationId: 'org_a', active: true },
  { id: 'branch_b', organizationId: 'org_a', active: true },
  { id: 'branch_closed', organizationId: 'org_a', active: false },
  { id: 'branch_x', organizationId: 'org_b', active: true },
];
type Assignment = { organizationId: string; branchId: string; userId: string; active: boolean };
type Gateway = {
  id: string;
  organizationId: string;
  branchId: string;
  status: string;
  revokedAt: Date | null;
  baseUrl: string;
  retentionDays: number;
};
type Camera = {
  id: string;
  organizationId: string;
  branchId: string;
  gatewayId: string;
  enabled: boolean;
  gateway: Gateway;
};
type Grant = {
  id: string;
  organizationId: string;
  cameraId: string;
  viewerId: string;
  revokedAt: Date | null;
  expiresAt: Date;
};

const BASE = 'https://camera-gateway.example.internal/';
function gateway(over: Partial<Gateway> = {}): Gateway {
  return {
    id: 'gw_1',
    organizationId: 'org_a',
    branchId: 'branch_a',
    status: 'ACTIVE',
    revokedAt: null,
    baseUrl: BASE,
    retentionDays: 7,
    ...over,
  };
}
function cameraRow(over: Partial<Camera> = {}): Camera {
  return {
    id: 'cam_1',
    organizationId: 'org_a',
    branchId: 'branch_a',
    gatewayId: 'gw_1',
    enabled: true,
    gateway: gateway(),
    ...over,
  };
}

let cameras: Camera[];
let grants: Grant[];
let assignments: Assignment[];
let gateways: Gateway[];
let grantSeq = 0;

function grantMatches(g: Grant, where: Where) {
  for (const key of ['id', 'organizationId', 'cameraId', 'viewerId'] as const)
    if (key in where && g[key] !== where[key]) return false;
  if ('revokedAt' in where && where.revokedAt === null && g.revokedAt !== null) return false;
  const expires = where.expiresAt as { gt?: Date } | undefined;
  if (expires?.gt && !(g.expiresAt > expires.gt)) return false;
  return true;
}

function makeDb() {
  return {
    user: {
      // A non-ADMIN session reaches the console only through an explicit
      // admin:access role grant; branch scope is then decided by assignment.
      findUnique: vi.fn(async ({ where }: { where: Where }) =>
        where.id === 'manager_1'
          ? {
              organizationRole: { permissions: [{ capability: 'admin:access', effect: 'ALLOW' }] },
              permissionOverrides: [],
            }
          : { organizationRole: null, permissionOverrides: [] }
      ),
    },
    pharmacyBranch: {
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        const hit = BRANCHES.find(
          (b) =>
            b.id === where.id &&
            (!('organizationId' in where) || b.organizationId === where.organizationId) &&
            (!('active' in where) || b.active === where.active)
        );
        return hit ? { id: hit.id } : null;
      }),
      findMany: vi.fn(async () => []),
    },
    pharmacyBranchAssignment: {
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        const hit = assignments.find(
          (a) =>
            a.organizationId === where.organizationId &&
            a.branchId === where.branchId &&
            a.userId === where.userId &&
            (!('active' in where) || a.active === where.active)
        );
        return hit ? { id: 'assignment' } : null;
      }),
    },
    pharmacyStockLocation: { findMany: vi.fn(async () => []) },
    cameraGateway: {
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        return (
          gateways.find((g) =>
            Object.entries(where).every(([k, v]) => (g as Record<string, unknown>)[k] === v)
          ) ?? null
        );
      }),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Partial<Gateway> }) => ({ id: 'gw_new', ...data })),
    },
    camera: {
      findFirst: vi.fn(async ({ where }: { where: Where }): Promise<unknown> => {
        if (!('id' in where)) return null;
        return (
          cameras.find(
            (c) =>
              c.id === where.id &&
              (!('organizationId' in where) || c.organizationId === where.organizationId)
          ) ?? null
        );
      }),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: 'cam_new' })),
      update: vi.fn(async () => ({ id: 'cam_1' })),
    },
    cameraCredential: { create: vi.fn(async () => ({ id: 'cred_1' })) },
    cameraStreamGrant: {
      findFirst: vi.fn(
        async ({ where }: { where: Where }) => grants.find((g) => grantMatches(g, where)) ?? null
      ),
      create: vi.fn(async ({ data }: { data: Omit<Grant, 'id' | 'revokedAt'> }) => {
        const row = { id: `grant_${++grantSeq}`, revokedAt: null, ...data };
        grants.push(row);
        return { id: row.id, expiresAt: row.expiresAt };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: { revokedAt: Date } }) => {
        const hit = grants.filter((g) => grantMatches(g, where));
        for (const g of hit) g.revokedAt = data.revokedAt;
        return { count: hit.length };
      }),
    },
    $executeRaw: vi.fn<(sql: unknown) => Promise<number>>().mockResolvedValue(0),
  };
}

let db = makeDb();
function caller(
  over: {
    userId?: string;
    role?: string;
    vertical?: string;
    support?: unknown;
  } = {}
) {
  return pharmacyCamerasRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules: ['pharmacy-core'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: {
        id: over.userId ?? 'owner_1',
        role: over.role ?? 'ADMIN',
        status: 'ACTIVE',
        organizationId: 'org_a',
      },
    },
    organization: { id: 'org_a', vertical: over.vertical ?? 'PHARMACY' },
    support: over.support ?? null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

const inMinute = () => new Date(Date.now() + 60_000);
function grant(over: Partial<Grant> = {}): Grant {
  return {
    id: 'grant_prev',
    organizationId: 'org_a',
    cameraId: 'cam_1',
    viewerId: 'owner_1',
    revokedAt: null,
    expiresAt: inMinute(),
    ...over,
  };
}

beforeEach(() => {
  cameras = [cameraRow()];
  grants = [];
  assignments = [];
  gateways = [];
  grantSeq = 0;
  db = makeDb();
  mocks.hasModule.mockReset().mockReturnValue(true);
  mocks.runtime.available = true;
  mocks.runtime.mode = 'mediamtx';
  mocks.runtime.adapter = { getSnapshot: vi.fn() };
  mocks.diagnose.mockReset().mockResolvedValue({ outcome: 'ok' });
  mocks.runtime.transport = { diagnose: mocks.diagnose };
  mocks.seal.mockClear();
  mocks.annotate.mockClear();
  process.env.CAMERA_CREDENTIAL_KEY = 'placeholder-test-key';
});

describe('configured gateway registration', () => {
  it('records the exact https base URL with no device connection', async () => {
    await expect(
      caller().enrollGateway({
        branchId: 'branch_a',
        name: 'Main',
        retentionDays: 7,
        baseUrl: BASE,
      })
    ).resolves.toMatchObject({ id: 'gw_new' });
    expect(db.cameraGateway.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          baseUrl: BASE,
          branchId: 'branch_a',
          organizationId: 'org_a',
        }),
      })
    );
    expect(mocks.diagnose).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['http scheme', 'http://camera-gateway.example.internal/'],
    ['private IP literal', 'https://10.0.0.5/'],
    ['metadata IP literal', 'https://169.254.169.254/'],
    ['embedded credentials', 'https://user:pass@camera-gateway.example.internal/'],
    ['path', 'https://camera-gateway.example.internal/live/'],
    ['query', 'https://camera-gateway.example.internal/?a=1'],
    ['fragment', 'https://camera-gateway.example.internal/#x'],
    ['rtsp scheme', 'rtsp://camera-gateway.example.internal/'],
    ['non-canonical', 'https://CAMERA-gateway.example.internal'],
  ])('rejects a %s gateway URL before any write', async (_label, baseUrl) => {
    await expect(
      caller().enrollGateway({ branchId: 'branch_a', name: 'Main', retentionDays: 7, baseUrl })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.cameraGateway.create).not.toHaveBeenCalled();
  });

  it('refuses a same-named gateway that points at another URL', async () => {
    gateways = [
      gateway({ name: 'Main', baseUrl: 'https://other-gateway.example.internal/' } as never),
    ];
    await expect(
      caller().enrollGateway({
        branchId: 'branch_a',
        name: 'Main',
        retentionDays: 7,
        baseUrl: BASE,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.cameraGateway.create).not.toHaveBeenCalled();
    gateways = [gateway({ name: 'Main' } as never)];
    await expect(
      caller().enrollGateway({
        branchId: 'branch_a',
        name: 'Main',
        retentionDays: 7,
        baseUrl: BASE,
      })
    ).resolves.toEqual({ id: 'gw_1' });
  });

  it.each(['branch_x', 'branch_closed'])('refuses %s', async (branchId) => {
    await expect(
      caller().enrollGateway({ branchId, name: 'Main', retentionDays: 7, baseUrl: BASE })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.cameraGateway.create).not.toHaveBeenCalled();
  });

  it('requires a branch assignment for a non-ADMIN session', async () => {
    const nonAdmin = caller({ userId: 'manager_1', role: 'MANAGER' });
    await expect(
      nonAdmin.enrollGateway({
        branchId: 'branch_a',
        name: 'Main',
        retentionDays: 7,
        baseUrl: BASE,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    assignments.push({
      organizationId: 'org_a',
      branchId: 'branch_a',
      userId: 'manager_1',
      active: true,
    });
    await expect(
      nonAdmin.enrollGateway({
        branchId: 'branch_a',
        name: 'Main',
        retentionDays: 7,
        baseUrl: BASE,
      })
    ).resolves.toMatchObject({ id: 'gw_new' });
  });

  it('refuses support sessions and non-pharmacy organizations', async () => {
    const input = { branchId: 'branch_a', name: 'Main', retentionDays: 7, baseUrl: BASE };
    await expect(caller({ support: { id: 'support' } }).enrollGateway(input)).rejects.toMatchObject(
      {
        code: 'FORBIDDEN',
      }
    );
    await expect(caller({ vertical: 'RESTAURANT' }).enrollGateway(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('keeps the simulator path URL-free', async () => {
    mocks.runtime.mode = 'simulated';
    await expect(
      caller().enrollGateway({ branchId: 'branch_a', name: 'Sim', retentionDays: 7, baseUrl: BASE })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await caller().enrollGateway({ branchId: 'branch_a', name: 'Sim', retentionDays: 7 });
    expect(db.cameraGateway.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ baseUrl: 'http://127.0.0.1' }) })
    );
  });

  it('never lets the simulator adopt a same-named configured gateway', async () => {
    mocks.runtime.mode = 'simulated';
    gateways = [gateway({ name: 'Main' } as never)];
    await expect(
      caller().enrollGateway({ branchId: 'branch_a', name: 'Main', retentionDays: 7 })
    ).resolves.toMatchObject({ id: 'gw_new' });
    expect(db.cameraGateway.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ baseUrl: 'http://127.0.0.1' }) })
    );
  });

  it('fails closed when no gateway is configured', async () => {
    mocks.runtime.available = false;
    mocks.runtime.mode = 'unavailable';
    await expect(
      caller().enrollGateway({
        branchId: 'branch_a',
        name: 'Main',
        retentionDays: 7,
        baseUrl: BASE,
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('configured camera registration', () => {
  beforeEach(() => {
    gateways = [gateway()];
  });
  const input = {
    branchId: 'branch_a',
    gatewayId: 'gw_1',
    name: 'Counter',
    sourceRef: 'counter-1',
  };

  it('registers disabled and seals a no-secret marker, never DVR credentials', async () => {
    await expect(caller().register(input)).resolves.toEqual({ id: 'cam_new' });
    expect(db.camera.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ enabled: false, sourceRef: 'counter-1' }),
      })
    );
    expect(mocks.seal).toHaveBeenCalledWith(
      JSON.stringify({ provisioning: 'gateway-owner' }),
      'placeholder-test-key'
    );
    expect(mocks.annotate).toHaveBeenCalledWith(expect.anything(), { skipInput: true });
  });

  it('rejects DVR credentials outright', async () => {
    await expect(
      caller().register({ ...input, username: 'admin', password: 'synthetic-dvr-password' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.seal).not.toHaveBeenCalled();
    expect(db.camera.create).not.toHaveBeenCalled();
  });

  it.each([
    'rtsp://10.0.0.9:554/cam/realmonitor?channel=1',
    'https://camera-gateway.example.internal/counter-1',
    '../admin',
    'counter-1?x=1',
    'user@counter',
    'counter 1',
    '/counter-1',
  ])('rejects stream path %s', async (sourceRef) => {
    await expect(caller().register({ ...input, sourceRef })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(db.camera.create).not.toHaveBeenCalled();
  });

  it('refuses a gateway from another branch', async () => {
    await expect(caller().register({ ...input, branchId: 'branch_b' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('keeps the simulator path restricted to simulator sources', async () => {
    mocks.runtime.mode = 'simulated';
    await expect(
      caller().register({ ...input, username: 'placeholder', password: 'placeholder' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller().register({ ...input, sourceRef: 'sim-counter-1' })).rejects.toMatchObject(
      {
        code: 'BAD_REQUEST',
      }
    );
  });

  it('points the pre-registration simulator test at the configured check', async () => {
    await expect(
      caller().testConnection({ branchId: 'branch_a', sourceRef: 'sim-counter-1' })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('configured connection diagnostics', () => {
  it('reads only the pharmacy-scoped binding for the registered camera', async () => {
    await expect(caller().configuredConnectionDiagnostics({ cameraId: 'cam_1' })).resolves.toEqual({
      outcome: 'ok',
    });
    expect(mocks.diagnose).toHaveBeenCalledWith({
      vertical: 'pharmacy',
      organizationId: 'org_a',
      branchId: 'branch_a',
      gatewayId: 'gw_1',
      cameraId: 'cam_1',
      baseUrl: BASE,
    });
  });

  it('works for a disabled camera so the owner can verify before enabling', async () => {
    cameras = [cameraRow({ enabled: false })];
    await expect(caller().configuredConnectionDiagnostics({ cameraId: 'cam_1' })).resolves.toEqual({
      outcome: 'ok',
    });
  });

  it('never returns transport detail beyond the fixed outcome code', async () => {
    mocks.diagnose.mockResolvedValue({ outcome: 'auth-failed', detail: 'https://x/' } as never);
    await expect(caller().configuredConnectionDiagnostics({ cameraId: 'cam_1' })).resolves.toEqual({
      outcome: 'auth-failed',
    });
  });

  it.each([
    [
      'another tenant camera',
      () => (cameras = [cameraRow({ organizationId: 'org_b' })]),
      'NOT_FOUND',
    ],
    [
      'an inactive branch',
      () => (cameras = [cameraRow({ branchId: 'branch_closed' })]),
      'FORBIDDEN',
    ],
    [
      'a revoked gateway',
      () => (cameras = [cameraRow({ gateway: gateway({ revokedAt: new Date() }) })]),
      'FORBIDDEN',
    ],
    [
      'a gateway bound to another branch',
      () => (cameras = [cameraRow({ gateway: gateway({ branchId: 'branch_b' }) })]),
      'FORBIDDEN',
    ],
  ])('refuses %s without probing', async (_label, arrange, code) => {
    arrange();
    await expect(
      caller().configuredConnectionDiagnostics({ cameraId: 'cam_1' })
    ).rejects.toMatchObject({
      code,
    });
    expect(mocks.diagnose).not.toHaveBeenCalled();
  });

  it('refuses an unassigned non-ADMIN without probing', async () => {
    await expect(
      caller({ userId: 'manager_1', role: 'MANAGER' }).configuredConnectionDiagnostics({
        cameraId: 'cam_1',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.diagnose).not.toHaveBeenCalled();
  });

  it('reports not-configured in simulator mode without a transport', async () => {
    mocks.runtime.mode = 'simulated';
    await expect(caller().configuredConnectionDiagnostics({ cameraId: 'cam_1' })).resolves.toEqual({
      outcome: 'not-configured',
    });
  });
});

describe('live view grants', () => {
  it('issues a one-minute grant for this viewer and camera', async () => {
    const issued = await caller().issueLiveViewGrant({ cameraId: 'cam_1' });
    expect(issued.grantId).toBe('grant_1');
    const remaining = new Date(issued.expiresAt).getTime() - Date.now();
    expect(remaining).toBeGreaterThan(55_000);
    expect(remaining).toBeLessThanOrEqual(60_000);
    expect(grants[0]).toMatchObject({
      organizationId: 'org_a',
      cameraId: 'cam_1',
      viewerId: 'owner_1',
    });
  });

  it('renews only from a live grant the viewer holds, leaving it to lapse', async () => {
    grants.push(grant());
    const renewed = await caller().issueLiveViewGrant({
      cameraId: 'cam_1',
      previousGrantId: 'grant_prev',
    });
    expect(renewed.grantId).toBe('grant_1');
    // Still usable for in-flight player requests until the new grant is applied.
    expect(grants.find((g) => g.id === 'grant_prev')?.revokedAt).toBeNull();
    expect(db.cameraStreamGrant.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', grant({ expiresAt: new Date(Date.now() - 1_000) })],
    ['revoked', grant({ revokedAt: new Date() })],
    ["another viewer's", grant({ viewerId: 'someone_else' })],
    ['another camera', grant({ cameraId: 'cam_2' })],
    ['another tenant', grant({ organizationId: 'org_b' })],
  ])('refuses renewal from a %s grant', async (_label, previous) => {
    grants.push(previous);
    await expect(
      caller().issueLiveViewGrant({ cameraId: 'cam_1', previousGrantId: 'grant_prev' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.cameraStreamGrant.create).not.toHaveBeenCalled();
  });

  it.each([
    ['a disabled camera', () => (cameras = [cameraRow({ enabled: false })]), 'FORBIDDEN'],
    [
      'a revoked gateway',
      () => (cameras = [cameraRow({ gateway: gateway({ status: 'REVOKED' }) })]),
      'FORBIDDEN',
    ],
    [
      'another tenant camera',
      () => (cameras = [cameraRow({ organizationId: 'org_b' })]),
      'NOT_FOUND',
    ],
    [
      'an inactive branch',
      () => (cameras = [cameraRow({ branchId: 'branch_closed' })]),
      'FORBIDDEN',
    ],
  ])('refuses %s', async (_label, arrange, code) => {
    arrange();
    await expect(caller().issueLiveViewGrant({ cameraId: 'cam_1' })).rejects.toMatchObject({
      code,
    });
    expect(db.cameraStreamGrant.create).not.toHaveBeenCalled();
  });

  it('applies the branch assignment rule to non-ADMIN sessions', async () => {
    const manager = caller({ userId: 'manager_1', role: 'MANAGER' });
    await expect(manager.issueLiveViewGrant({ cameraId: 'cam_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    assignments.push({
      organizationId: 'org_a',
      branchId: 'branch_b',
      userId: 'manager_1',
      active: true,
    });
    await expect(manager.issueLiveViewGrant({ cameraId: 'cam_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    assignments.push({
      organizationId: 'org_a',
      branchId: 'branch_a',
      userId: 'manager_1',
      active: false,
    });
    await expect(manager.issueLiveViewGrant({ cameraId: 'cam_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    assignments.push({
      organizationId: 'org_a',
      branchId: 'branch_a',
      userId: 'manager_1',
      active: true,
    });
    await expect(manager.issueLiveViewGrant({ cameraId: 'cam_1' })).resolves.toMatchObject({
      grantId: 'grant_1',
    });
  });

  it('refuses support sessions, other verticals, missing entitlement and simulator mode', async () => {
    await expect(
      caller({ support: { id: 'support' } }).issueLiveViewGrant({ cameraId: 'cam_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller({ vertical: 'RESTAURANT' }).issueLiveViewGrant({ cameraId: 'cam_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    mocks.runtime.mode = 'simulated';
    await expect(caller().issueLiveViewGrant({ cameraId: 'cam_1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    mocks.runtime.mode = 'mediamtx';
    mocks.hasModule.mockReturnValue(false);
    await expect(caller().issueLiveViewGrant({ cameraId: 'cam_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.cameraStreamGrant.create).not.toHaveBeenCalled();
  });

  it('keeps the renewal grant identifier out of the audit input', async () => {
    grants.push(grant());
    await caller().issueLiveViewGrant({ cameraId: 'cam_1', previousGrantId: 'grant_prev' });
    expect(mocks.annotate).toHaveBeenCalledWith(expect.anything(), { skipInput: true });
    expect(JSON.stringify(mocks.annotate.mock.calls)).not.toContain('grant_prev');
  });

  it('lets the viewer revoke only their own live grant', async () => {
    grants.push(grant(), grant({ id: 'grant_other', viewerId: 'someone_else' }));
    await expect(
      caller().revokeViewerGrant({ cameraId: 'cam_1', grantId: 'grant_other' })
    ).resolves.toEqual({ revoked: 0 });
    await expect(
      caller().revokeViewerGrant({ cameraId: 'cam_1', grantId: 'grant_prev' })
    ).resolves.toEqual({ revoked: 1 });
  });
});

describe('configured camera settings', () => {
  it('applies the live branch rule before a non-ADMIN can enable a camera', async () => {
    const manager = caller({ userId: 'manager_1', role: 'MANAGER' });
    const input = { cameraId: 'cam_1', preset: null, enabled: true };
    await expect(manager.configure(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.camera.update).not.toHaveBeenCalled();
    assignments.push({
      organizationId: 'org_a',
      branchId: 'branch_a',
      userId: 'manager_1',
      active: true,
    });
    await expect(manager.configure(input)).resolves.toEqual({ id: 'cam_1' });
  });

  it('refuses support sessions and non-pharmacy organizations before any write', async () => {
    const input = { cameraId: 'cam_1', preset: null, enabled: false };
    await expect(caller({ support: { id: 'support' } }).configure(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller({ vertical: 'RESTAURANT' }).configure(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.camera.update).not.toHaveBeenCalled();
  });
});
