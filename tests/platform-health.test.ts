import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  capability: vi.fn(),
  scope: vi.fn(),
  db: {
    organization: { findMany: vi.fn() },
    platformJob: { groupBy: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    restaurantJob: { groupBy: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    restaurantRegisteredDevice: { findMany: vi.fn() },
    pharmacyRegisteredDevice: { findMany: vi.fn() },
    restaurantCamera: { findMany: vi.fn() },
    camera: { findMany: vi.fn() },
    webhook: { findMany: vi.fn() },
    webhookDelivery: { groupBy: vi.fn() },
    restaurantNotificationWebhook: { findMany: vi.fn() },
    pharmacyReferenceConnector: { findMany: vi.fn() },
    pharmacyReferenceConnectorRun: { groupBy: vi.fn() },
  },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/platform/auth', () => ({
  requirePlatformSession: mocks.session,
  assertPlatformCapability: mocks.capability,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: mocks.scope }));
// The suite exercises the reader, not real session/database or tRPC wiring.
vi.mock('@/server/trpc', () => ({
  router: (procedures: unknown) => procedures,
  publicProcedure: { input: () => ({ query: () => ({}) }) },
}));
import { readPlatformHealth } from '@/server/routers/platform-health';

const db = mocks.db;
const now = new Date('2026-10-02T02:00:00Z');
const old = new Date('2026-10-02T01:00:00Z');
const organizations = [
  { id: 'org_restaurant', displayName: 'Restaurant', vertical: 'RESTAURANT' },
  { id: 'org_pharmacy', displayName: 'Pharmacy', vertical: 'PHARMACY' },
];
const visible = (ids: string[]) => ({ organizationId: { in: ids } });
const cameraRow = (result: Awaited<ReturnType<typeof readPlatformHealth>>, id: string) =>
  result.integrations.find((row) => row.organizationId === id && row.integration === 'Cameras');

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  mocks.session.mockResolvedValue({ id: 'operator', role: 'AUDITOR' });
  mocks.scope.mockImplementation(async (work: (client: typeof db) => unknown) => work(db));
  for (const read of [
    db.platformJob.groupBy,
    db.platformJob.findMany,
    db.restaurantJob.groupBy,
    db.restaurantJob.findMany,
    db.restaurantRegisteredDevice.findMany,
    db.pharmacyRegisteredDevice.findMany,
    db.restaurantCamera.findMany,
    db.camera.findMany,
    db.webhook.findMany,
    db.webhookDelivery.groupBy,
    db.restaurantNotificationWebhook.findMany,
    db.pharmacyReferenceConnector.findMany,
    db.pharmacyReferenceConnectorRun.groupBy,
  ]) {
    read.mockResolvedValue([]);
  }
  db.platformJob.count.mockResolvedValue(0);
  db.restaurantJob.count.mockResolvedValue(0);
  db.organization.findMany.mockResolvedValue(organizations);
});
afterEach(() => vi.useRealTimers());

describe('platform health source reader', () => {
  it('rejects missing platform authentication before opening platform scope', async () => {
    mocks.session.mockRejectedValue(new Error('platform authentication required'));
    await expect(readPlatformHealth()).rejects.toThrow('authentication required');
    expect(mocks.capability).not.toHaveBeenCalled();
    expect(mocks.scope).not.toHaveBeenCalled();
    expect(db.organization.findMany).not.toHaveBeenCalled();
  });
  it.each(['jobs:read', 'organizations:read'])(
    'requires %s before opening platform scope',
    async (denied) => {
      mocks.capability.mockImplementation((_identity, capability: string) => {
        if (capability === denied) throw new Error('permission denied');
      });
      await expect(readPlatformHealth()).rejects.toThrow('permission denied');
      expect(mocks.scope).not.toHaveBeenCalled();
      expect(db.organization.findMany).not.toHaveBeenCalled();
    }
  );
  it('combines legacy restaurant and generic pharmacy camera observations', async () => {
    db.restaurantCamera.findMany.mockResolvedValue([
      { organizationId: 'org_restaurant', enabled: true, lastSeenAt: now },
    ]);
    db.camera.findMany.mockResolvedValue([
      {
        organizationId: 'org_pharmacy',
        enabled: true,
        lastSeenAt: now,
        gateway: { status: 'ACTIVE', revokedAt: null },
      },
    ]);
    const result = await readPlatformHealth();
    expect(cameraRow(result, 'org_restaurant')).toMatchObject({
      status: 'healthy',
      lastContact: now,
    });
    expect(cameraRow(result, 'org_pharmacy')).toMatchObject({
      status: 'healthy',
      lastContact: now,
    });
    expect(mocks.capability.mock.calls.map((call) => call[1])).toEqual([
      'jobs:read',
      'organizations:read',
    ]);
    expect(mocks.capability.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.scope.mock.invocationCallOrder[0]
    );
  });
  it.each([
    {
      name: 'disabled camera',
      enabled: false,
      status: 'ACTIVE',
      revokedAt: null,
      seen: now,
      expected: 'down',
    },
    {
      name: 'inactive gateway',
      enabled: true,
      status: 'INACTIVE',
      revokedAt: null,
      seen: now,
      expected: 'down',
    },
    {
      name: 'revoked gateway',
      enabled: true,
      status: 'ACTIVE',
      revokedAt: now,
      seen: now,
      expected: 'down',
    },
    {
      name: 'stale camera with fresh gateway',
      enabled: true,
      status: 'ACTIVE',
      revokedAt: null,
      seen: old,
      expected: 'degraded',
    },
  ])('handles $name without inventing camera contact', async (fixture) => {
    db.camera.findMany.mockResolvedValue([
      {
        organizationId: 'org_pharmacy',
        enabled: fixture.enabled,
        lastSeenAt: fixture.seen,
        gateway: { status: fixture.status, revokedAt: fixture.revokedAt, lastSeenAt: now },
      },
    ]);
    const result = await readPlatformHealth({ organizationId: 'org_pharmacy' });
    expect(cameraRow(result, 'org_pharmacy')).toMatchObject({
      status: fixture.expected,
      lastContact: fixture.seen,
      lastSuccess: null,
      lastError: null,
    });
  });
  it('limits camera reads to visible tenants and selects no credentials', async () => {
    const secret = 'SYNTHETIC_PRIVATE_CAMERA_VALUE';
    db.camera.findMany.mockResolvedValue([
      {
        organizationId: 'org_pharmacy',
        enabled: true,
        lastSeenAt: now,
        credential: secret,
        rtspUrl: secret,
        gateway: { status: 'ACTIVE', revokedAt: null, secret },
      },
      {
        organizationId: 'org_restaurant',
        enabled: true,
        lastSeenAt: now,
        gateway: { status: 'ACTIVE', revokedAt: null },
      },
    ]);
    const result = await readPlatformHealth({ organizationId: 'org_pharmacy' });
    expect(db.restaurantCamera.findMany).toHaveBeenCalledWith({
      where: visible(['org_pharmacy']),
      select: { organizationId: true, enabled: true, lastSeenAt: true },
    });
    expect(db.camera.findMany).toHaveBeenCalledWith({
      where: visible(['org_pharmacy']),
      select: {
        organizationId: true,
        enabled: true,
        lastSeenAt: true,
        gateway: { select: { status: true, revokedAt: true } },
      },
    });
    expect(db.webhook.findMany).toHaveBeenCalledWith({
      where: visible(['org_pharmacy']),
      select: { id: true, organizationId: true, active: true },
    });
    expect(result.integrations).toHaveLength(5);
    expect(result.integrations.every((row) => row.organizationId === 'org_pharmacy')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('returns no health rows for an unknown organization', async () => {
    const result = await readPlatformHealth({ organizationId: 'missing-org' });
    expect(result.tenantCount).toBe(0);
    expect(result.integrations).toEqual([]);
    expect(result.alerts).toEqual([]);
    expect(result.counts.every((row) => row.count === 0)).toBe(true);
    expect(db.camera.findMany.mock.calls[0][0].where).toEqual(visible([]));
    expect(db.restaurantCamera.findMany.mock.calls[0][0].where).toEqual(visible([]));
  });
});
