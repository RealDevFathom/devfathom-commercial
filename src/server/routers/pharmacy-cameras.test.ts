/**
 * Pharmacy cameras router against a mocked client: what each procedure refuses
 * before any read or write, and what it writes when allowed. The simulator is
 * the only gateway; nothing here proves a physical camera or live video.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
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

const activeGateway = { id: 'gw_1', status: 'ACTIVE', retentionDays: 7, revokedAt: null };
const cameraRow = {
  id: 'cam_1',
  organizationId: 'org_a',
  branchId: 'branch_a',
  gatewayId: 'gw_1',
  enabled: true,
  gateway: activeGateway,
};

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
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === 'branch_a' ? { id: 'branch_a' } : null
      ),
      findMany: vi.fn(async () => [{ id: 'branch_a', name: 'Main' }]),
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
      findFirst: vi.fn(async () => cameraRow as unknown),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: 'cam_new' })),
      update: vi.fn(async ({ data }: { data: object }) => ({ id: 'cam_1', ...data })),
    },
    cameraCredential: { create: vi.fn(async () => ({ id: 'cred_1' })) },
    cameraStreamGrant: {
      findFirst: vi.fn(async () => null as unknown),
      create: vi.fn(async () => ({ id: 'grant_1', expiresAt: new Date() })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    cameraEvidence: { findMany: vi.fn(async () => [] as unknown[]) },
    $executeRaw: vi.fn(async () => 0),
  };
}

let db = makeDb();
function caller(overrides: { organizationId?: string; role?: string } = {}) {
  db.user.findUnique.mockResolvedValue({
    role: overrides.role ?? 'ADMIN',
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
        id: 'owner_1',
        role: overrides.role ?? 'ADMIN',
        status: 'ACTIVE',
        organizationId: 'org_a',
      },
    },
    organization: { id: overrides.organizationId ?? 'org_a' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  db = makeDb();
  mocks.hasModule.mockReset().mockReturnValue(true);
  mocks.runtime.available = true;
  mocks.runtime.mode = 'simulated';
  mocks.capture.mockClear();
  mocks.still.mockClear();
  mocks.seal.mockClear();
  delete process.env.CAMERA_CREDENTIAL_KEY;
});

describe('pharmacy cameras authorization', () => {
  it('refuses an organization without the pharmacy module before any read', async () => {
    mocks.hasModule.mockReturnValue(false);
    await expect(caller().workspace()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.camera.findMany).not.toHaveBeenCalled();
  });

  it('refuses a session whose organization does not match the active tenant', async () => {
    await expect(caller({ organizationId: 'org_b' }).workspace()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
  });

  it('refuses a non-owner before any camera read', async () => {
    await expect(caller({ role: 'EMPLOYEE' }).workspace()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.camera.findMany).not.toHaveBeenCalled();
  });

  it('reports simulator availability without a gateway URL', async () => {
    const result = await caller().workspace();
    expect(result.availability).toEqual({ available: true, mode: 'simulated' });
    expect(JSON.stringify(result)).not.toContain('baseUrl');
  });
});

describe('pharmacy cameras simulator-only setup', () => {
  it('accepts only the three simulator source references', async () => {
    await expect(
      caller().testConnection({
        branchId: 'branch_a',
        sourceRef: 'rtsp://10.0.0.5/stream' as never,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    for (const sourceRef of ['sim-camera-1', 'sim-counter-1', 'sim-fridge-1'] as const)
      await expect(caller().testConnection({ branchId: 'branch_a', sourceRef })).resolves.toEqual({
        outcome: 'ok',
        discoveredProfile: 'Diagnostic simulator only; no hardware or live video',
      });
  });

  it('refuses enrollment when the simulator is unavailable, without writing', async () => {
    mocks.runtime.available = false;
    mocks.runtime.mode = 'unavailable';
    await expect(
      caller().enrollGateway({ branchId: 'branch_a', name: 'Front', retentionDays: 7 })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(db.cameraGateway.create).not.toHaveBeenCalled();
  });

  it('refuses another branch before enrolling', async () => {
    await expect(
      caller().enrollGateway({ branchId: 'branch_other', name: 'Front', retentionDays: 7 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.cameraGateway.create).not.toHaveBeenCalled();
  });

  it('fails closed without private credential storage', async () => {
    db.cameraGateway.findFirst.mockResolvedValue(activeGateway);
    await expect(
      caller().register({
        branchId: 'branch_a',
        gatewayId: 'gw_1',
        name: 'Counter',
        sourceRef: 'sim-counter-1',
        username: 'placeholder',
        password: 'placeholder',
        registerAnyway: false,
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(db.cameraCredential.create).not.toHaveBeenCalled();
    expect(mocks.seal).not.toHaveBeenCalled();
  });
});

describe('pharmacy camera presets', () => {
  it('COUNTER explicitly enables counter evidence', async () => {
    await caller().configure({ cameraId: 'cam_1', preset: 'COUNTER', enabled: true });
    expect(db.camera.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { preset: 'COUNTER', temperatureZoneId: null, counterEvidence: true },
      })
    );
  });

  it('clearing the preset stops counter evidence', async () => {
    await caller().configure({ cameraId: 'cam_1', preset: null, enabled: true });
    expect(db.camera.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { preset: null, temperatureZoneId: null, counterEvidence: false },
      })
    );
  });

  it('COLD_CHAIN without a zone is refused before any update', async () => {
    await expect(
      caller().configure({ cameraId: 'cam_1', preset: 'COLD_CHAIN', enabled: true })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'ZONE_REQUIRED' });
    expect(db.camera.update).not.toHaveBeenCalled();
  });

  it('sets retention only on active gateways of an authorized branch', async () => {
    await expect(caller().setRetention({ branchId: 'branch_a', days: 30 })).resolves.toEqual({
      days: 30,
      gateways: 1,
    });
    expect(db.cameraGateway.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_a', branchId: 'branch_a', status: 'ACTIVE', revokedAt: null },
      data: { retentionDays: 30 },
    });
    await expect(
      caller().setRetention({ branchId: 'branch_other', days: 30 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('pharmacy private evidence grants', () => {
  it('refuses evidence with an expired or revoked grant before reading stills', async () => {
    await expect(
      caller().evidence({ cameraId: 'cam_1', grantId: 'grant_old' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Viewer access expired or was revoked.',
    });
    expect(db.cameraEvidence.findMany).not.toHaveBeenCalled();
    expect(mocks.still).not.toHaveBeenCalled();
  });

  it('returns branch-scoped stills, including daily close, for a live grant', async () => {
    db.cameraStreamGrant.findFirst.mockResolvedValue({ id: 'grant_1' });
    db.cameraEvidence.findMany.mockResolvedValue([
      {
        id: 'ev_1',
        subjectKind: 'PHARMACY_DAILY_CLOSE',
        subjectId: 'close_1',
        status: 'CAPTURED',
        storageKey: 'private/key',
        requestedAt: new Date(),
        capturedAt: new Date(),
        failureReason: null,
      },
    ]);
    const rows = await caller().evidence({ cameraId: 'cam_1', grantId: 'grant_1' });
    expect(db.cameraStreamGrant.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ viewerId: 'owner_1', cameraId: 'cam_1', revokedAt: null }),
    });
    expect(db.cameraEvidence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org_a', branchId: 'branch_a', cameraId: 'cam_1' },
      })
    );
    expect(rows[0]).toMatchObject({
      subjectKind: 'PHARMACY_DAILY_CLOSE',
      image: 'data:image/png;base64,AA==',
    });
    expect(rows[0]).not.toHaveProperty('storageKey');
  });

  it('refuses a disabled camera grant', async () => {
    db.camera.findFirst.mockResolvedValue({ ...cameraRow, enabled: false });
    await expect(caller().issueViewerGrant({ cameraId: 'cam_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.cameraStreamGrant.create).not.toHaveBeenCalled();
  });

  it('refuses renewal from a stale grant', async () => {
    await expect(
      caller().issueViewerGrant({ cameraId: 'cam_1', previousGrantId: 'grant_old' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.cameraStreamGrant.create).not.toHaveBeenCalled();
  });

  it("revokes only the viewer's own grant", async () => {
    await caller().revokeViewerGrant({ cameraId: 'cam_1', grantId: 'grant_1' });
    expect(db.cameraStreamGrant.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'grant_1',
        organizationId: 'org_a',
        cameraId: 'cam_1',
        viewerId: 'owner_1',
        revokedAt: null,
      },
      data: { revokedAt: expect.any(Date) },
    });
  });
});

describe('camera evidence scoped mutations', () => {
  it('renews only the current viewer live camera grant', async () => {
    db.cameraStreamGrant.findFirst.mockResolvedValue({ id: 'grant_previous' });
    await caller().issueViewerGrant({ cameraId: 'cam_1', previousGrantId: 'grant_previous' });
    expect(db.cameraStreamGrant.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'grant_previous',
        organizationId: 'org_a',
        cameraId: 'cam_1',
        viewerId: 'owner_1',
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      select: { id: true },
    });
    expect(db.cameraStreamGrant.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org_a',
        cameraId: 'cam_1',
        viewerId: 'owner_1',
        expiresAt: expect.any(Date),
      },
      select: { id: true, expiresAt: true },
    });
  });

  it.each([0, 91, 1.5])('rejects invalid retention %s without writing', async (days) => {
    await expect(caller().setRetention({ branchId: 'branch_a', days })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(db.cameraGateway.updateMany).not.toHaveBeenCalled();
  });

  it('registers a diagnostic camera using branch-scoped gateway and sealed fixture storage', async () => {
    process.env.CAMERA_CREDENTIAL_KEY = 'synthetic-test-only';
    try {
      db.cameraGateway.findFirst.mockResolvedValue(activeGateway);
      db.camera.findFirst.mockResolvedValue(null);
      await expect(
        caller().register({
          branchId: 'branch_a',
          gatewayId: 'gw_1',
          name: 'Counter',
          sourceRef: 'sim-counter-1',
          username: 'placeholder',
          password: 'placeholder',
          registerAnyway: true,
        })
      ).resolves.toEqual({ id: 'cam_new' });
      expect(db.cameraGateway.findFirst).toHaveBeenCalledWith({
        where: {
          organizationId: 'org_a',
          id: 'gw_1',
          branchId: 'branch_a',
          status: 'ACTIVE',
          revokedAt: null,
        },
      });
      expect(db.cameraCredential.create).toHaveBeenCalledWith({
        data: { organizationId: 'org_a', sealedValue: 'sealed' },
      });
      expect(db.camera.create).toHaveBeenCalledWith({
        data: {
          organizationId: 'org_a',
          branchId: 'branch_a',
          gatewayId: 'gw_1',
          credentialId: 'cred_1',
          name: 'Counter',
          sourceRef: 'sim-counter-1',
          enabled: false,
        },
        select: { id: true },
      });
    } finally {
      delete process.env.CAMERA_CREDENTIAL_KEY;
    }
  });

  it('rejects a cold-chain zone outside camera scope without updating', async () => {
    db.pharmacyStockLocation.findFirst.mockResolvedValue(null as never);
    await expect(
      caller().configure({
        cameraId: 'cam_1',
        preset: 'COLD_CHAIN',
        temperatureZoneId: 'zone_other',
        enabled: true,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'ZONE_NOT_COLD_CHAIN' });
    expect(db.pharmacyStockLocation.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'zone_other',
        organizationId: 'org_a',
        branchId: 'branch_a',
        active: true,
        coldChain: true,
      },
      select: { id: true },
    });
    expect(db.camera.update).not.toHaveBeenCalled();
  });
});
