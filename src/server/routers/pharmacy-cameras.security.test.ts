/**
 * WHA-1370 private camera security cases S1–S4 against the recovered router
 * (src/server/routers/pharmacy-cameras.ts, manifest sha256 6f752cf4…).
 *
 * The mocked client below honours the `where` filters the router sends, so a
 * filter the router drops (viewer, camera, expiry, tenant, active branch) lets a
 * wrong row through and the case fails. Nothing here proves concurrency, a
 * physical camera, live video or the HTTP transaction wrapper.
 *
 * Place next to the source: src/server/routers/pharmacy-cameras.security.test.ts
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasModule: vi.fn(() => true),
  runtime: {
    available: true,
    mode: 'simulated',
    adapter: { getSnapshot: vi.fn(async () => ({ bytes: new Uint8Array([1]) })) },
  } as {
    available: boolean;
    mode: string;
    adapter: { getSnapshot: ReturnType<typeof vi.fn> } | null;
  },
  capture: vi.fn(async () => ({})),
  still: vi.fn(async () => 'data:image/png;base64,AA=='),
  seal: vi.fn(() => 'sealed'),
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
vi.mock('@/lib/cameras/evidence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cameras/evidence')>()),
  captureCameraEvidence: mocks.capture,
  evidenceSnapshotAdapter: vi.fn(() => ({})),
}));
vi.mock('@/lib/storage', () => ({ deleteUpload: vi.fn(), putUpload: vi.fn() }));
vi.mock('@/lib/pharmacy/counter-evidence', () => ({ stillDataUrl: mocks.still }));
vi.mock('@/lib/restaurant/camera-credentials', () => ({ sealCameraCredential: mocks.seal }));

import type { TRPCContext } from '../trpc';
import { pharmacyCamerasRouter } from './pharmacy-cameras';

type Where = Record<string, unknown>;

// Branches: two active in org_a, one inactive in org_a, one in org_b.
const BRANCHES = [
  { id: 'branch_a', organizationId: 'org_a', active: true },
  { id: 'branch_b', organizationId: 'org_a', active: true },
  { id: 'branch_closed', organizationId: 'org_a', active: false },
  { id: 'branch_x', organizationId: 'org_b', active: true },
];
const GATEWAY = { id: 'gw_1', status: 'ACTIVE', retentionDays: 7, revokedAt: null as Date | null };
function cameraRow(over: Partial<{ id: string; organizationId: string; branchId: string }> = {}) {
  return {
    id: 'cam_1',
    organizationId: 'org_a',
    branchId: 'branch_a',
    gatewayId: 'gw_1',
    enabled: true,
    gateway: { ...GATEWAY },
    ...over,
  };
}

type Grant = {
  id: string;
  organizationId: string;
  cameraId: string;
  viewerId: string;
  revokedAt: Date | null;
  expiresAt: Date;
};

/** Applies only the conditions present in `where`; a dropped filter widens the match. */
function grantMatches(g: Grant, where: Where) {
  for (const key of ['id', 'organizationId', 'cameraId', 'viewerId'] as const)
    if (key in where && g[key] !== where[key]) return false;
  if ('revokedAt' in where && where.revokedAt === null && g.revokedAt !== null) return false;
  const expires = where.expiresAt as { gt?: Date } | undefined;
  if (expires?.gt && !(g.expiresAt > expires.gt)) return false;
  return true;
}

let cameras: ReturnType<typeof cameraRow>[];
let grants: Grant[];

function makeDb() {
  return {
    user: {
      count: vi.fn().mockResolvedValue(2),
      findUnique: vi.fn(async () => ({
        role: 'ADMIN',
        status: 'ACTIVE',
        organizationId: 'org_a',
        organizationRole: null,
        permissionOverrides: [],
      })),
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
    pharmacyStockLocation: {
      findFirst: vi.fn(async () => ({ id: 'zone_1' })),
      findMany: vi.fn(async () => []),
    },
    cameraGateway: {
      findFirst: vi.fn(async () => null as unknown),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: 'gw_new' })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    camera: {
      findFirst: vi.fn(async ({ where }: { where: Where }): Promise<unknown> => {
        // Camera lookups by id must carry the tenant; prior-camera lookups by gateway+source do not hit here.
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
      update: vi.fn(async ({ data }: { data: object }) => ({ id: 'cam_1', ...data })),
    },
    cameraCredential: { create: vi.fn(async () => ({ id: 'cred_1' })) },
    cameraStreamGrant: {
      findFirst: vi.fn(
        async ({ where }: { where: Where }) => grants.find((g) => grantMatches(g, where)) ?? null
      ),
      create: vi.fn(async ({ data }: { data: Omit<Grant, 'id' | 'revokedAt'> }) => ({
        id: 'grant_new',
        expiresAt: data.expiresAt,
      })),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: { revokedAt: Date } }) => {
        const hit = grants.filter((g) => grantMatches(g, where));
        for (const g of hit) g.revokedAt = data.revokedAt;
        return { count: hit.length };
      }),
    },
    cameraEvidence: { findMany: vi.fn(async () => [] as unknown[]) },
    $executeRaw: vi.fn<(sql: unknown) => Promise<number>>().mockResolvedValue(0),
  };
}

let db = makeDb();
function caller(over: { userId?: string; role?: string; organizationId?: string } = {}) {
  db.user.findUnique.mockResolvedValue({
    role: over.role ?? 'ADMIN',
    status: 'ACTIVE',
    organizationId: 'org_a',
    organizationRole: null,
    permissionOverrides: [],
  });
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
    organization: { id: over.organizationId ?? 'org_a' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

const inMinute = () => new Date(Date.now() + 60_000);
const minuteAgo = () => new Date(Date.now() - 60_000);
function grant(over: Partial<Grant> = {}): Grant {
  return {
    id: 'grant_1',
    organizationId: 'org_a',
    cameraId: 'cam_1',
    viewerId: 'owner_1',
    revokedAt: null,
    expiresAt: inMinute(),
    ...over,
  };
}
const registerInput = {
  branchId: 'branch_a',
  gatewayId: 'gw_1',
  name: 'Counter',
  sourceRef: 'sim-counter-1' as const,
  username: 'placeholder',
  password: 'placeholder-secret',
  registerAnyway: false,
};

beforeEach(() => {
  cameras = [cameraRow()];
  grants = [];
  db = makeDb();
  mocks.hasModule.mockReset().mockReturnValue(true);
  mocks.runtime.available = true;
  mocks.runtime.mode = 'simulated';
  mocks.runtime.adapter = { getSnapshot: vi.fn(async () => ({ bytes: new Uint8Array([1]) })) };
  mocks.capture.mockClear();
  mocks.still.mockClear();
  mocks.seal.mockClear();
  mocks.annotate.mockClear();
  delete process.env.CAMERA_CREDENTIAL_KEY;
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.CAMERA_CREDENTIAL_KEY;
});

/* ---------------------------------------------------------------- S1 ---- */
// Existing convention (policies.ts, pharmacy-sales.ts counterEvidence, growth
// `branchMatch`): there is no user→branch assignment model; an ADMIN is
// organisation-wide, and the only narrowing is the optional
// `app.current_branch_id` setting. These cases pin the guard that does exist:
// tenant + active-branch on every branch-taking and camera-taking procedure.
describe('S1 branch scope (organisation-wide admin convention)', () => {
  it('an organisation admin may act on any active branch of the same organisation', async () => {
    await expect(caller().setRetention({ branchId: 'branch_b', days: 14 })).resolves.toEqual({
      days: 14,
      gateways: 1,
    });
    expect(db.pharmacyBranch.findFirst).toHaveBeenCalledWith({
      where: { id: 'branch_b', organizationId: 'org_a', active: true },
      select: { id: true },
    });
  });

  it.each(['branch_x', 'branch_closed', 'branch_missing'])(
    'refuses %s on every branch-taking procedure before any write',
    async (branchId) => {
      process.env.CAMERA_CREDENTIAL_KEY = 'synthetic-test-only';
      db.cameraGateway.findFirst.mockResolvedValue(GATEWAY);
      const c = caller();
      await expect(
        c.enrollGateway({ branchId, name: 'Front', retentionDays: 7 })
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Branch unavailable.' });
      await expect(c.testConnection({ branchId, sourceRef: 'sim-camera-1' })).rejects.toMatchObject(
        { code: 'FORBIDDEN' }
      );
      await expect(c.register({ ...registerInput, branchId })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(c.setRetention({ branchId, days: 30 })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(db.$executeRaw).not.toHaveBeenCalled();
      expect(db.cameraGateway.create).not.toHaveBeenCalled();
      expect(db.cameraGateway.updateMany).not.toHaveBeenCalled();
      expect(db.cameraCredential.create).not.toHaveBeenCalled();
      expect(db.camera.create).not.toHaveBeenCalled();
      expect(mocks.seal).not.toHaveBeenCalled();
      expect(mocks.runtime.adapter!.getSnapshot).not.toHaveBeenCalled();
    }
  );

  it('re-checks the camera branch: a camera on a closed branch is refused everywhere', async () => {
    cameras = [cameraRow({ branchId: 'branch_closed' })];
    grants = [grant()];
    const c = caller();
    await expect(
      c.configure({ cameraId: 'cam_1', preset: 'COUNTER', enabled: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Branch unavailable.' });
    await expect(c.issueViewerGrant({ cameraId: 'cam_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(c.evidence({ cameraId: 'cam_1', grantId: 'grant_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(c.capturePending({ cameraId: 'cam_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.camera.update).not.toHaveBeenCalled();
    expect(db.cameraStreamGrant.create).not.toHaveBeenCalled();
    expect(db.cameraEvidence.findMany).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("treats another organisation's camera id as not found, without reading evidence", async () => {
    cameras = [cameraRow({ organizationId: 'org_b', branchId: 'branch_x' })];
    grants = [grant({ organizationId: 'org_b' })];
    await expect(
      caller().evidence({ cameraId: 'cam_1', grantId: 'grant_1' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.camera.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cam_1', organizationId: 'org_a' } })
    );
    expect(db.cameraStreamGrant.findFirst).not.toHaveBeenCalled();
    expect(db.cameraEvidence.findMany).not.toHaveBeenCalled();
  });
});

/* ---------------------------------------------------------------- S2 ---- */
describe('S2 retention at read time', () => {
  it('never fetches storage for PURGED, FAILED or PENDING rows, even with a storage key', async () => {
    grants = [grant()];
    db.cameraEvidence.findMany.mockResolvedValue(
      (['PURGED', 'FAILED', 'PENDING'] as const).map((status, i) => ({
        id: `ev_${i}`,
        subjectKind: 'PHARMACY_TENDER',
        subjectId: `tender_${i}`,
        status,
        storageKey: `private/key_${i}`,
        requestedAt: new Date(),
        capturedAt: null,
        failureReason: null,
      }))
    );
    const rows = await caller().evidence({ cameraId: 'cam_1', grantId: 'grant_1' });
    expect(rows.map((r) => r.image)).toEqual([null, null, null]);
    expect(mocks.still).not.toHaveBeenCalled();
    for (const row of rows) expect(row).not.toHaveProperty('storageKey');
  });

  it('red: expired CAPTURED still is withheld before the purge job runs', async () => {
    grants = [grant()];
    const longAgo = new Date(Date.now() - 200 * 86_400_000);
    db.cameraEvidence.findMany.mockResolvedValue([
      {
        id: 'ev_old',
        subjectKind: 'PHARMACY_TENDER',
        subjectId: 'tender_old',
        status: 'CAPTURED',
        storageKey: 'private/old',
        requestedAt: longAgo,
        capturedAt: longAgo,
        failureReason: null,
      },
    ]);
    const rows = await caller().evidence({ cameraId: 'cam_1', grantId: 'grant_1' });
    expect(db.cameraEvidence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org_a', branchId: 'branch_a', cameraId: 'cam_1' },
      })
    );
    expect(rows[0]).toMatchObject({ id: 'ev_old', status: 'CAPTURED', image: null });
    expect(mocks.still).not.toHaveBeenCalled();
  });

  it('red: fresh still keeps its private data URL', async () => {
    grants = [grant()];
    db.cameraEvidence.findMany.mockResolvedValue([
      {
        id: 'ev_fresh',
        subjectKind: 'PHARMACY_TENDER',
        subjectId: 'tender_fresh',
        status: 'CAPTURED',
        storageKey: 'private/fresh',
        requestedAt: new Date(),
        capturedAt: new Date(),
        failureReason: null,
      },
    ]);
    const rows = await caller().evidence({ cameraId: 'cam_1', grantId: 'grant_1' });
    expect(rows[0]).toMatchObject({ id: 'ev_fresh', image: 'data:image/png;base64,AA==' });
    expect(mocks.still).toHaveBeenCalledExactlyOnceWith('org_a', 'private/fresh');
  });

  it.each([-1, 0, 1])(
    'uses the inclusive cutoff with offset %sms and the current gateway policy',
    async (offset) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const now = new Date('2026-10-12T12:00:00Z');
      vi.setSystemTime(now);
      grants = [grant()];
      const capturedAt = new Date(now.getTime() - 7 * 86_400_000 + offset);
      db.cameraEvidence.findMany.mockResolvedValue([
        {
          id: 'ev_boundary',
          subjectKind: 'PHARMACY_TENDER',
          subjectId: 'tender_1',
          status: 'CAPTURED',
          storageKey: 'private/boundary',
          requestedAt: capturedAt,
          capturedAt,
          failureReason: null,
        },
      ]);
      const read = () => caller().evidence({ cameraId: 'cam_1', grantId: 'grant_1' });
      expect((await read())[0]?.image).toBe(offset > 0 ? 'data:image/png;base64,AA==' : null);
      expect(mocks.still).toHaveBeenCalledTimes(offset > 0 ? 1 : 0);
      cameras[0]!.gateway.retentionDays = 8;
      expect((await read())[0]?.image).toBe('data:image/png;base64,AA==');
      cameras[0]!.gateway.retentionDays = 1;
      mocks.still.mockClear();
      expect((await read())[0]?.image).toBeNull();
      expect(mocks.still).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['serves a still captured during the evidence query', 1_000, 'data:image/png;base64,AA=='],
    ['withholds a still expired during the evidence query', -7 * 86_400_000 + 1_000, null],
    ['withholds a genuinely future still after the evidence query', 2_001, null],
  ] as const)('query timing: %s', async (_label, capturedOffset, expectedImage) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const grantNow = new Date('2026-10-12T12:00:00Z');
    vi.setSystemTime(grantNow);
    grants = [grant()];
    const capturedAt = new Date(grantNow.getTime() + capturedOffset);
    db.cameraEvidence.findMany.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(grantNow.getTime() + 2_000));
      return [
        {
          id: 'ev_query',
          subjectKind: 'PHARMACY_TENDER',
          subjectId: 'tender_query',
          status: 'CAPTURED',
          storageKey: 'private/query',
          requestedAt: grantNow,
          capturedAt,
          failureReason: null,
        },
      ];
    });

    const rows = await caller().evidence({ cameraId: 'cam_1', grantId: 'grant_1' });
    expect(db.cameraStreamGrant.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'grant_1',
        organizationId: 'org_a',
        cameraId: 'cam_1',
        viewerId: 'owner_1',
        revokedAt: null,
        expiresAt: { gt: grantNow },
      },
    });
    expect(rows[0]).toMatchObject({ id: 'ev_query', status: 'CAPTURED', image: expectedImage });
    if (expectedImage) {
      expect(mocks.still).toHaveBeenCalledExactlyOnceWith('org_a', 'private/query');
    } else {
      expect(mocks.still).not.toHaveBeenCalled();
    }
  });

  it.each([
    { capturedAt: null },
    { capturedAt: undefined },
    { capturedAt: new Date(NaN) },
    { capturedAt: new Date('2026-10-13T12:00:00Z') },
    { storageKey: null },
    ...[undefined, null, 0, 3651, 1.5, NaN].map((retentionDays) => ({ retentionDays })),
  ])('withholds malformed evidence metadata %o', async (over) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    grants = [grant()];
    if ('retentionDays' in over) cameras[0]!.gateway.retentionDays = over.retentionDays as never;
    const row = {
      id: 'ev_bad',
      subjectKind: 'PHARMACY_TENDER',
      subjectId: 'tender_1',
      status: 'CAPTURED',
      storageKey: 'private/bad',
      requestedAt: new Date(),
      capturedAt: new Date(),
      failureReason: null,
      ...over,
    };
    db.cameraEvidence.findMany.mockResolvedValue([row]);
    const result = await caller().evidence({ cameraId: 'cam_1', grantId: 'grant_1' });
    expect(result[0]).toMatchObject({ id: 'ev_bad', status: 'CAPTURED', image: null });
    expect(mocks.still).not.toHaveBeenCalled();
  });

  it('accepts a 3650-day database policy and snapshots the server clock once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = new Date('2026-10-12T12:00:00Z');
    vi.setSystemTime(now);
    grants = [grant()];
    cameras[0]!.gateway.retentionDays = 3650;
    const capturedAt = new Date(now.getTime() - 100 * 86_400_000);
    db.cameraEvidence.findMany.mockResolvedValue(
      ['a', 'b'].map((id) => ({
        id,
        subjectKind: 'PHARMACY_TENDER',
        subjectId: id,
        status: 'CAPTURED',
        storageKey: `private/${id}`,
        requestedAt: capturedAt,
        capturedAt,
        failureReason: null,
      }))
    );
    mocks.still.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(now.getTime() + 4000 * 86_400_000));
      return 'data:image/png;base64,AA==';
    });
    const result = await caller().evidence({ cameraId: 'cam_1', grantId: 'grant_1' });
    expect(result.map((r) => r.image)).toEqual([
      'data:image/png;base64,AA==',
      'data:image/png;base64,AA==',
    ]);
    expect(db.cameraStreamGrant.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'grant_1',
        organizationId: 'org_a',
        cameraId: 'cam_1',
        viewerId: 'owner_1',
        revokedAt: null,
        expiresAt: { gt: now },
      },
    });
    expect(db.cameraEvidence.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        branchId: 'branch_a',
        cameraId: 'cam_1',
      },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: 10,
    });
  });

  it('rejects a client supplied clock or retention period', async () => {
    grants = [grant()];
    await expect(
      caller().evidence({
        cameraId: 'cam_1',
        grantId: 'grant_1',
        now: new Date(),
        retentionDays: 3650,
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.cameraEvidence.findMany).not.toHaveBeenCalled();
    expect(mocks.still).not.toHaveBeenCalled();
  });
});

/* ---------------------------------------------------------------- S3 ---- */
describe('S3 viewer grants', () => {
  it('serves stills for the viewer own live grant (positive control)', async () => {
    grants = [grant()];
    await expect(caller().evidence({ cameraId: 'cam_1', grantId: 'grant_1' })).resolves.toEqual([]);
    expect(db.cameraEvidence.findMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['expired', grant({ expiresAt: minuteAgo() })],
    ['revoked', grant({ revokedAt: minuteAgo() })],
    ["another viewer's", grant({ viewerId: 'owner_2' })],
    ['another camera', grant({ cameraId: 'cam_2' })],
    ['another organisation', grant({ organizationId: 'org_b' })],
  ])('refuses evidence with an %s grant before reading stills', async (_label, g) => {
    grants = [g];
    await expect(
      caller().evidence({ cameraId: 'cam_1', grantId: 'grant_1' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Viewer access expired or was revoked.',
    });
    expect(db.cameraEvidence.findMany).not.toHaveBeenCalled();
    expect(mocks.still).not.toHaveBeenCalled();
  });

  it('a live grant does not survive a role downgrade: refused before the grant is read', async () => {
    grants = [grant()];
    await expect(
      caller({ role: 'EMPLOYEE' }).evidence({ cameraId: 'cam_1', grantId: 'grant_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.cameraStreamGrant.findFirst).not.toHaveBeenCalled();
    expect(db.cameraEvidence.findMany).not.toHaveBeenCalled();
  });

  it('a live grant does not survive losing the pharmacy module', async () => {
    grants = [grant()];
    mocks.hasModule.mockReturnValue(false);
    await expect(
      caller().evidence({ cameraId: 'cam_1', grantId: 'grant_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.cameraStreamGrant.findFirst).not.toHaveBeenCalled();
  });

  it('a live grant does not survive the gateway being revoked or the camera disabled', async () => {
    grants = [grant()];
    cameras = [{ ...cameraRow(), gateway: { ...GATEWAY, revokedAt: minuteAgo() } }];
    await expect(
      caller().evidence({ cameraId: 'cam_1', grantId: 'grant_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    cameras = [{ ...cameraRow(), enabled: false }];
    await expect(
      caller().evidence({ cameraId: 'cam_1', grantId: 'grant_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.cameraEvidence.findMany).not.toHaveBeenCalled();
  });

  it("refuses renewal from another viewer's live grant, without issuing", async () => {
    grants = [grant({ id: 'grant_other', viewerId: 'owner_2' })];
    await expect(
      caller().issueViewerGrant({ cameraId: 'cam_1', previousGrantId: 'grant_other' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.cameraStreamGrant.create).not.toHaveBeenCalled();
  });

  it('issues grants only to the session user, for 60 seconds, and rejects a supplied viewer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T10:00:00.000Z'));
    await caller({ userId: 'owner_7' }).issueViewerGrant({ cameraId: 'cam_1' });
    expect(db.cameraStreamGrant.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org_a',
        cameraId: 'cam_1',
        viewerId: 'owner_7',
        expiresAt: new Date('2026-10-11T10:01:00.000Z'),
      },
      select: { id: true, expiresAt: true },
    });
    await expect(
      caller().issueViewerGrant({ cameraId: 'cam_1', viewerId: 'owner_2' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.cameraStreamGrant.create).toHaveBeenCalledTimes(1);
  });

  it("cannot revoke another viewer's grant: nothing changes", async () => {
    const other = grant({ id: 'grant_other', viewerId: 'owner_2' });
    grants = [other];
    await expect(
      caller().revokeViewerGrant({ cameraId: 'cam_1', grantId: 'grant_other' })
    ).resolves.toEqual({ revoked: 0 });
    expect(other.revokedAt).toBeNull();
  });

  it('own revocation takes effect immediately for evidence reads', async () => {
    grants = [grant()];
    await expect(
      caller().revokeViewerGrant({ cameraId: 'cam_1', grantId: 'grant_1' })
    ).resolves.toEqual({ revoked: 1 });
    await expect(
      caller().evidence({ cameraId: 'cam_1', grantId: 'grant_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.cameraEvidence.findMany).not.toHaveBeenCalled();
  });

  it('never writes the camera password to the audit detail', async () => {
    process.env.CAMERA_CREDENTIAL_KEY = 'synthetic-test-only';
    db.cameraGateway.findFirst.mockResolvedValue(GATEWAY);
    await caller().register(registerInput);
    expect(mocks.annotate).toHaveBeenCalledWith(expect.anything(), { skipInput: true });
    expect(JSON.stringify(mocks.annotate.mock.calls)).not.toContain('placeholder-secret');
    expect(mocks.seal).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------- S4 + production lockout ---- */
describe('S4 serialisation order and production lockout (mocked; not a concurrency proof)', () => {
  it.each([
    { available: false, mode: 'unavailable' },
    { available: true, mode: 'onvif' },
  ])('runtime %o refuses every gateway-touching procedure without writing', async (state) => {
    process.env.CAMERA_CREDENTIAL_KEY = 'synthetic-test-only';
    mocks.runtime.available = state.available;
    mocks.runtime.mode = state.mode;
    db.cameraGateway.findFirst.mockResolvedValue(GATEWAY);
    const c = caller();
    for (const run of [
      () => c.enrollGateway({ branchId: 'branch_a', name: 'Front', retentionDays: 7 }),
      () => c.testConnection({ branchId: 'branch_a', sourceRef: 'sim-camera-1' }),
      () => c.register(registerInput),
      () => c.capturePending({ cameraId: 'cam_1' }),
    ])
      await expect(run()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.cameraGateway.create).not.toHaveBeenCalled();
    expect(db.cameraCredential.create).not.toHaveBeenCalled();
    expect(db.camera.create).not.toHaveBeenCalled();
    expect(mocks.seal).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.runtime.adapter!.getSnapshot).not.toHaveBeenCalled();
  });

  it('enrollGateway takes the tenant-keyed lock before its duplicate check and create', async () => {
    await caller().enrollGateway({ branchId: 'branch_a', name: 'Front', retentionDays: 7 });
    const lock = db.$executeRaw.mock.invocationCallOrder[0]!;
    expect(lock).toBeLessThan(db.cameraGateway.findFirst.mock.invocationCallOrder[0]!);
    expect(lock).toBeLessThan(db.cameraGateway.create.mock.invocationCallOrder[0]!);
    const sql = db.$executeRaw.mock.calls[0]![0] as unknown as { values: unknown[] };
    expect(sql.values).toEqual(['org_a', 'camera-gateway:branch_a:Front']);
  });

  it('register takes the lock before its duplicate check, and a replay creates no credential', async () => {
    process.env.CAMERA_CREDENTIAL_KEY = 'synthetic-test-only';
    db.cameraGateway.findFirst.mockResolvedValue(GATEWAY);
    const priorLookup = vi.fn(async () => ({ id: 'cam_existing' }));
    db.camera.findFirst.mockImplementation(async ({ where }: { where: Where }) =>
      'gatewayId' in where ? priorLookup() : null
    );
    await expect(caller().register(registerInput)).resolves.toEqual({ id: 'cam_existing' });
    expect(db.$executeRaw.mock.invocationCallOrder[0]!).toBeLessThan(
      priorLookup.mock.invocationCallOrder[0]!
    );
    const sql = db.$executeRaw.mock.calls[0]![0] as unknown as { values: unknown[] };
    expect(sql.values).toEqual(['org_a', 'camera:gw_1:sim-counter-1']);
    expect(db.cameraCredential.create).not.toHaveBeenCalled();
    expect(mocks.seal).not.toHaveBeenCalled();
  });

  it('register refuses a gateway from another branch before locking or sealing', async () => {
    process.env.CAMERA_CREDENTIAL_KEY = 'synthetic-test-only';
    db.cameraGateway.findFirst.mockResolvedValue(null);
    await expect(
      caller().register({ ...registerInput, branchId: 'branch_b' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Gateway unavailable in branch.' });
    expect(db.cameraGateway.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        id: 'gw_1',
        branchId: 'branch_b',
        status: 'ACTIVE',
        revokedAt: null,
      },
    });
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(mocks.seal).not.toHaveBeenCalled();
  });
});
