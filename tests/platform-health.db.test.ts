// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';
import type { TRPCContext } from '@/server/trpc';

const request = vi.hoisted(() => ({ token: '' }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'df_platform_session' && request.token ? { value: request.token } : undefined,
  }),
}));
const url = process.env.TEST_DATABASE_URL;
if (url) {
  assertDisposableRlsDatabase(url);
  process.env.DATABASE_URL = url;
}
const key = `health_${randomUUID().replaceAll('-', '')}`;
const restaurant = `${key}_restaurant`;
const pharmacy = `${key}_pharmacy`;
const purged = `${key}_purged`;
const admin = `${key}_admin`;
const sales = `${key}_sales`;
const now = new Date('2026-10-02T02:00:00Z');
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
let read: (typeof import('@/server/routers/platform-health'))['readPlatformHealth'];
let router: (typeof import('@/server/routers/platform-health'))['platformHealthRouter'];
let scoped: typeof import('@/lib/tenancy/scoped-db');
let db: (typeof import('@/lib/db'))['db'];

// Unit fixtures are independent of the browser lane's disposable database.
describe.skipIf(!url)('platform health with real PostgreSQL and platform sessions', () => {
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    ({ db } = await import('@/lib/db'));
    scoped = await import('@/lib/tenancy/scoped-db');
    ({ readPlatformHealth: read, platformHealthRouter: router } =
      await import('@/server/routers/platform-health'));
    const roles = await db.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await scoped.withPlatformDb(async (tx) => {
      for (const [id, vertical, name] of [
        [restaurant, 'RESTAURANT', 'Health Restaurant'],
        [pharmacy, 'PHARMACY', 'Health Pharmacy'],
        [purged, 'RESTAURANT', 'Purged health tenant'],
      ] as const) {
        await tx.organization.create({
          data: {
            id,
            slug: id,
            legalName: name,
            displayName: name,
            vertical,
            status: id === purged ? 'PURGED' : 'ACTIVE',
          },
        });
      }
      for (const [id, role] of [
        [admin, 'SUPER_ADMIN'],
        [sales, 'SALES'],
      ] as const) {
        await tx.platformUser.create({
          data: {
            id,
            name: role,
            email: `${id}@e2e.invalid`,
            passwordHash: 'unused',
            role,
            mfaRequired: role === 'SUPER_ADMIN',
            mfaEnabledAt: role === 'SUPER_ADMIN' ? now : null,
            // Synthetic enrollment state for session reads, never decrypted.
            encryptedTotpSecret:
              role === 'SUPER_ADMIN' ? 'SYNTHETIC_ENROLLED_SESSION_FIXTURE_NOT_DECRYPTED' : null,
          },
        });
        await tx.platformSession.create({
          data: {
            platformUserId: id,
            tokenHash: createHash('sha256').update(id).digest('hex'),
            expiresAt: new Date('2099-01-01'),
          },
        });
      }
      await tx.platformJob.createMany({
        data: [
          {
            id: `${key}_stale`,
            organizationId: restaurant,
            type: 'EXPORT_DATA',
            status: 'RUNNING',
            startedAt: ago(16),
            createdAt: ago(30),
            payload: { secret: 'payload-must-not-leak' },
          },
          {
            id: `${key}_boundary`,
            organizationId: restaurant,
            type: 'EXPORT_DATA',
            status: 'RUNNING',
            startedAt: ago(15),
          },
          {
            id: `${key}_fallback`,
            organizationId: restaurant,
            type: 'EXPORT_DATA',
            status: 'RUNNING',
            createdAt: ago(17),
          },
          {
            id: `${key}_failed`,
            organizationId: restaurant,
            type: 'EXPORT_DATA',
            status: 'FAILED',
            finishedAt: ago(1440),
            error: 'error-must-not-leak',
          },
          {
            id: `${key}_old`,
            organizationId: restaurant,
            type: 'EXPORT_DATA',
            status: 'FAILED',
            finishedAt: ago(1441),
          },
          { id: `${key}_platform`, type: 'EXPORT_DATA', status: 'QUEUED', createdAt: ago(40) },
          {
            id: `${key}_purgedjob`,
            organizationId: purged,
            type: 'EXPORT_DATA',
            status: 'RUNNING',
            startedAt: ago(20),
          },
        ],
      });
      await tx.restaurantJob.createMany({
        data: [
          {
            id: `${key}_r_stale`,
            organizationId: restaurant,
            type: 'HEALTH_TEST',
            status: 'RUNNING',
            claimedAt: ago(16),
            createdAt: ago(20),
          },
          {
            id: `${key}_r_boundary`,
            organizationId: restaurant,
            type: 'HEALTH_TEST',
            status: 'RUNNING',
            claimedAt: ago(15),
          },
          {
            id: `${key}_dead`,
            organizationId: restaurant,
            type: 'HEALTH_TEST',
            status: 'DEAD',
            updatedAt: ago(10),
          },
          {
            id: `${key}_r_old`,
            organizationId: restaurant,
            type: 'HEALTH_TEST',
            status: 'FAILED',
            updatedAt: ago(1441),
          },
        ],
      });
      const branch = await tx.restaurantBranch.create({
        data: { organizationId: restaurant, name: 'Health branch' },
      });
      await tx.restaurantRegisteredDevice.create({
        data: {
          organizationId: restaurant,
          branchId: branch.id,
          name: 'POS',
          deviceSecretHash: `${key}_device_secret`,
          lastSeenAt: ago(1),
        },
      });
      await tx.organizationDepartment.create({
        data: { organizationId: restaurant, key: 'LEADERSHIP', name: 'Leadership' },
      });
      const user = await tx.user.create({
        data: {
          organizationId: restaurant,
          name: 'Webhook owner',
          department: 'LEADERSHIP',
          title: 'Health test owner',
          email: `${key}@e2e.invalid`,
          password: 'unused',
        },
      });
      for (const [suffix, success] of [
        ['ok', true],
        ['bad', false],
      ] as const) {
        const hook = await tx.webhook.create({
          data: {
            organizationId: restaurant,
            url: 'https://redacted.invalid/private',
            secret: 'hook-must-not-leak',
            createdById: user.id,
          },
        });
        await tx.webhookDelivery.create({
          data: {
            organizationId: restaurant,
            webhookId: hook.id,
            event: suffix,
            payload: { private: true },
            success,
            attemptedAt: ago(success ? 1 : 2),
          },
        });
      }
      const connector = await tx.pharmacyReferenceConnector.create({
        data: {
          organizationId: pharmacy,
          key: 'health',
          label: 'Reference',
          schedule: {},
          createdBy: user.id,
        },
      });
      await tx.pharmacyReferenceConnectorRun.create({
        data: {
          organizationId: pharmacy,
          connectorId: connector.id,
          inputDigest: key,
          batchId: key,
          fileName: 'private.csv',
          triggerKind: 'MANUAL',
          triggeredBy: user.id,
          status: 'FAILED',
          completedAt: ago(5),
        },
      });
    });
  });
  beforeEach(() => {
    request.token = admin;
  });
  afterAll(async () => {
    vi.useRealTimers();
    await db?.$disconnect();
  });

  it('rejects missing and unknown platform sessions', async () => {
    request.token = '';
    await expect(read({})).rejects.toMatchObject({ status: 401 });
    request.token = 'tenant-cookie-is-not-platform-auth';
    await expect(read({})).rejects.toMatchObject({ status: 401 });
  });
  it('rejects a real SALES session without jobs:read', async () => {
    request.token = sales;
    await expect(read({})).rejects.toMatchObject({ status: 403 });
  });
  it('guards the tRPC procedure independently of tenant context', async () => {
    const caller = router.createCaller({} as TRPCContext);
    request.token = sales;
    await expect(caller.overview({})).rejects.toThrow('permission');
    request.token = admin;
    expect((await caller.overview({ organizationId: restaurant })).tenantCount).toBe(1);
  });
  it('enforces exact stale and recent-failure boundaries for both queues', async () => {
    const result = await read({ organizationId: restaurant });
    expect(result.alerts.map((item) => item.id).sort()).toEqual(
      ['stale', 'fallback', 'failed', 'r_stale', 'dead'].map((suffix) => `${key}_${suffix}`).sort()
    );
    expect(result.alertCount).toBe(5);
    expect(
      result.counts.find((item) => item.queue === 'Platform' && item.status === 'RUNNING')?.count
    ).toBe(3);
    expect(
      result.counts.find((item) => item.queue === 'Restaurant' && item.status === 'QUEUED')?.count
    ).toBe(0);
  });
  it('keeps global jobs out of tenant filters and purged tenants out of all scope', async () => {
    const all = await read({});
    expect(
      all.counts.find((item) => item.queue === 'Platform' && item.status === 'QUEUED')?.count
    ).toBeGreaterThanOrEqual(1);
    expect(all.integrations.some((item) => item.organizationId === purged)).toBe(false);
    expect(all.alerts.some((item) => item.id === `${key}_purgedjob`)).toBe(false);
    const filtered = await read({ vertical: 'PHARMACY', organizationId: pharmacy });
    expect(filtered.integrations).toHaveLength(5);
    expect(filtered.integrations.every((item) => item.organizationId === pharmacy)).toBe(true);
    expect(filtered.counts.every((item) => item.count === 0)).toBe(true);
  });
  it('returns empty scope for unknown or mismatched filters and validates inputs', async () => {
    expect((await read({ vertical: 'PHARMACY', organizationId: restaurant })).tenantCount).toBe(0);
    expect((await read({ organizationId: `${key}_missing` })).integrations).toEqual([]);
    await expect(read({ page: 0 })).rejects.toThrow();
  });
  it('uses endpoint outcomes without concealing a failed endpoint behind a newer success', async () => {
    const result = await read({ organizationId: restaurant });
    expect(result.integrations.find((item) => item.integration === 'Webhooks')).toMatchObject({
      status: 'degraded',
      lastSuccess: ago(1),
      lastError: ago(2),
    });
    expect(
      result.integrations.find((item) => item.integration === 'Enrolled devices')
    ).toMatchObject({ status: 'healthy', lastSuccess: null, lastError: null, lastContact: ago(1) });
    expect(result.integrations.find((item) => item.integration === 'Cameras')?.status).toBe(
      'not configured'
    );
    expect(result.workerHeartbeat.status).toBe('not instrumented');
    expect(result.integrations.find((item) => item.integration === 'Print bridges')?.status).toBe(
      'not instrumented'
    );
  });
  it('reports connector failures and never exposes credentials or raw job payloads', async () => {
    const result = await read({ organizationId: pharmacy });
    expect(
      result.integrations.find((item) => item.integration === 'Pharmacy reference connector')
    ).toMatchObject({ status: 'down', lastError: ago(5) });
    const serialized = JSON.stringify(await read({ organizationId: restaurant }));
    for (const secret of [
      'payload-must-not-leak',
      'error-must-not-leak',
      'hook-must-not-leak',
      'redacted.invalid',
      'deviceSecretHash',
      'passwordHash',
    ])
      expect(serialized).not.toContain(secret);
  });
  it('clamps pagination and limits integrations to 25 organizations per page', async () => {
    await scoped.withPlatformDb((tx) =>
      tx.organization.createMany({
        data: Array.from({ length: 26 }, (_, i) => ({
          id: `${key}_page_${i}`,
          slug: `${key}-page-${i}`,
          displayName: `Health agency ${i}`,
          legalName: 'Health agency',
          vertical: 'AGENCY' as const,
        })),
      })
    );
    const first = await read({ vertical: 'AGENCY' });
    expect(first.integrations).toHaveLength(125);
    const last = await read({ vertical: 'AGENCY', page: 100000 });
    expect(last.page).toBe(last.pageCount);
    expect(last.integrations.length).toBeGreaterThan(0);
    expect(last.integrations.length).toBeLessThanOrEqual(125);
    expect(
      last.integrations.every(
        (item) =>
          !first.integrations.some((previous) => previous.organizationId === item.organizationId)
      )
    ).toBe(true);
  });
});
