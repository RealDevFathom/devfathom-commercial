import 'server-only';

import { z } from 'zod';
import { publicProcedure, router } from '@/server/trpc';
import { assertPlatformCapability, requirePlatformSession } from '@/lib/platform/auth';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import type { Prisma } from '@/generated/prisma/client';

export const healthFilters = z
  .object({
    vertical: z.enum(['AGENCY', 'PHARMACY', 'RESTAURANT']).optional(),
    organizationId: z.string().min(3).max(128).optional(),
    page: z.number().int().min(1).max(100000).default(1),
  })
  .strict();

export type HealthStatus = 'healthy' | 'degraded' | 'down' | 'not configured' | 'not instrumented';
const latest = (dates: (Date | null)[]) =>
  dates.reduce<Date | null>((last, date) => (date && (!last || date > last) ? date : last), null);
const outcome = (success: Date | null, error: Date | null): HealthStatus =>
  error && (!success || error >= success) ? 'down' : success ? 'healthy' : 'degraded';
const combined = (states: HealthStatus[]): HealthStatus =>
  states.length === 0
    ? 'not configured'
    : states.every((s) => s === 'healthy')
      ? 'healthy'
      : states.every((s) => s === 'down')
        ? 'down'
        : 'degraded';

/** Shared by the RSC page and additive tRPC procedure. Never trusts tenant ctx/session. */
export async function readPlatformHealth(raw: z.input<typeof healthFilters> = {}) {
  const identity = await requirePlatformSession();
  assertPlatformCapability(identity, 'jobs:read');
  assertPlatformCapability(identity, 'organizations:read');
  const filters = healthFilters.parse(raw);
  const observedAt = new Date();
  const staleBefore = new Date(observedAt.getTime() - 15 * 60_000);
  const failedSince = new Date(observedAt.getTime() - 24 * 60 * 60_000);
  const contactBefore = new Date(observedAt.getTime() - 2 * 60_000);

  return withPlatformDb(async (db) => {
    const organizations = await db.organization.findMany({
      where: { status: { not: 'PURGED' }, vertical: filters.vertical },
      select: { id: true, displayName: true, vertical: true },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    });
    const matching = organizations.filter(
      (org) => !filters.organizationId || org.id === filters.organizationId
    );
    const ids = matching.map((org) => org.id);
    const pageCount = Math.max(1, Math.ceil(matching.length / 25));
    const page = Math.min(filters.page, pageCount);
    const tenants = matching.slice((page - 1) * 25, page * 25);
    const visible = { organizationId: { in: tenants.map((org) => org.id) } };
    // Unfiltered platform jobs include jobs with no tenant. Tenant filters exclude those.
    const platformWhere: Prisma.PlatformJobWhereInput =
      filters.organizationId || filters.vertical
        ? { organizationId: { in: ids } }
        : { OR: [{ organizationId: null }, { organizationId: { in: ids } }] };
    const restaurantWhere = { organizationId: { in: ids } };
    const platformAlert: Prisma.PlatformJobWhereInput = {
      ...platformWhere,
      OR: [
        { status: 'RUNNING', startedAt: { lt: staleBefore } },
        { status: 'RUNNING', startedAt: null, createdAt: { lt: staleBefore } },
        { status: 'FAILED', finishedAt: { gte: failedSince } },
      ],
      AND: platformWhere,
    };
    const restaurantAlert: Prisma.RestaurantJobWhereInput = {
      ...restaurantWhere,
      OR: [
        { status: 'RUNNING', claimedAt: { lt: staleBefore } },
        { status: 'RUNNING', claimedAt: null, createdAt: { lt: staleBefore } },
        { status: { in: ['FAILED', 'DEAD'] }, updatedAt: { gte: failedSince } },
      ],
    };
    const [
      platformCounts,
      restaurantCounts,
      platformAlerts,
      restaurantAlerts,
      platformAlertCount,
      restaurantAlertCount,
      devices,
      pharmacyDevices,
      cameras,
      registeredCameras,
      webhooks,
      deliveries,
      notifications,
      connectors,
      runs,
    ] = await Promise.all([
      db.platformJob.groupBy({
        by: ['status'],
        where: platformWhere,
        _count: { _all: true },
        _min: { createdAt: true },
      }),
      db.restaurantJob.groupBy({
        by: ['status'],
        where: restaurantWhere,
        _count: { _all: true },
        _min: { createdAt: true },
      }),
      db.platformJob.findMany({
        where: platformAlert,
        take: 50,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          organizationId: true,
          status: true,
          createdAt: true,
          startedAt: true,
          finishedAt: true,
        },
      }),
      db.restaurantJob.findMany({
        where: restaurantAlert,
        take: 50,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          organizationId: true,
          status: true,
          createdAt: true,
          claimedAt: true,
          updatedAt: true,
        },
      }),
      db.platformJob.count({ where: platformAlert }),
      db.restaurantJob.count({ where: restaurantAlert }),
      db.restaurantRegisteredDevice.findMany({
        where: visible,
        select: { organizationId: true, status: true, lastSeenAt: true },
      }),
      db.pharmacyRegisteredDevice.findMany({
        where: visible,
        select: { organizationId: true, status: true, lastSeenAt: true },
      }),
      db.restaurantCamera.findMany({
        where: visible,
        select: { organizationId: true, enabled: true, lastSeenAt: true },
      }),
      db.camera.findMany({
        where: visible,
        select: {
          organizationId: true,
          enabled: true,
          lastSeenAt: true,
          gateway: { select: { status: true, revokedAt: true } },
        },
      }),
      db.webhook.findMany({
        where: visible,
        select: { id: true, organizationId: true, active: true },
      }),
      db.webhookDelivery.groupBy({
        by: ['organizationId', 'webhookId', 'success'],
        where: visible,
        _max: { attemptedAt: true },
      }),
      db.restaurantNotificationWebhook.findMany({
        where: visible,
        select: { organizationId: true, enabled: true, lastSuccessAt: true, lastFailureAt: true },
      }),
      db.pharmacyReferenceConnector.findMany({
        where: visible,
        select: { id: true, organizationId: true, enabled: true, lastRunState: true },
      }),
      db.pharmacyReferenceConnectorRun.groupBy({
        by: ['organizationId', 'connectorId', 'status'],
        where: visible,
        _max: { completedAt: true },
      }),
    ]);
    const integrationRows = tenants.flatMap((org) => {
      const row = (
        integration: string,
        status: HealthStatus,
        lastSuccess: Date | null,
        lastError: Date | null,
        note: string,
        lastContact: Date | null = null
      ) => ({
        organizationId: org.id,
        organization: org.displayName,
        vertical: org.vertical,
        integration,
        status,
        lastSuccess,
        lastError,
        lastContact,
        note,
      });
      const contacts = (items: { active: boolean; lastSeenAt: Date | null }[]) =>
        combined(
          items.map((item) =>
            !item.active
              ? 'down'
              : item.lastSeenAt && item.lastSeenAt >= contactBefore
                ? 'healthy'
                : 'degraded'
          )
        );
      const enrolled = [...devices, ...pharmacyDevices]
        .filter((item) => item.organizationId === org.id)
        .map((item) => ({ active: item.status === 'ACTIVE', lastSeenAt: item.lastSeenAt }));
      const orgCameras = [
        ...cameras.map((item) => ({ ...item, active: item.enabled })),
        ...registeredCameras.map((item) => ({
          organizationId: item.organizationId,
          active: item.enabled && item.gateway.status === 'ACTIVE' && !item.gateway.revokedAt,
          // Gateway contact is not evidence that a camera was observed.
          lastSeenAt: item.lastSeenAt,
        })),
      ].filter((item) => item.organizationId === org.id);
      const hooks = webhooks
        .filter((item) => item.organizationId === org.id)
        .map((hook) => {
          const history = deliveries.filter(
            (item) => item.webhookId === hook.id && item.organizationId === org.id
          );
          const success = latest(
            history.filter((item) => item.success).map((item) => item._max.attemptedAt)
          );
          const error = latest(
            history.filter((item) => !item.success).map((item) => item._max.attemptedAt)
          );
          return {
            success,
            error,
            status: hook.active ? outcome(success, error) : ('down' as HealthStatus),
          };
        });
      for (const hook of notifications.filter((item) => item.organizationId === org.id))
        hooks.push({
          success: hook.lastSuccessAt,
          error: hook.lastFailureAt,
          status: hook.enabled ? outcome(hook.lastSuccessAt, hook.lastFailureAt) : 'down',
        });
      const refs = connectors
        .filter((item) => item.organizationId === org.id)
        .map((connector) => {
          const history = runs.filter(
            (item) => item.connectorId === connector.id && item.organizationId === org.id
          );
          const success = latest(
            history
              .filter((item) => item.status === 'COMPLETED')
              .map((item) => item._max.completedAt)
          );
          const error = latest(
            history.filter((item) => item.status === 'FAILED').map((item) => item._max.completedAt)
          );
          return {
            success,
            error,
            status: !connector.enabled
              ? ('down' as HealthStatus)
              : connector.lastRunState === 'RUNNING'
                ? ('degraded' as HealthStatus)
                : outcome(success, error),
          };
        });
      return [
        row(
          'Print bridges',
          'not instrumented',
          null,
          null,
          'No bridge registry or heartbeat table. Print jobs do not prove bridge health.'
        ),
        row(
          'Enrolled devices',
          contacts(enrolled),
          null,
          null,
          `${enrolled.length} enrolled. Contact freshness: 2 min; success/error outcomes not instrumented.`,
          latest(enrolled.map((item) => item.lastSeenAt))
        ),
        row(
          'Webhooks',
          combined(hooks.map((item) => item.status)),
          latest(hooks.map((item) => item.success)),
          latest(hooks.map((item) => item.error)),
          `${hooks.length} configured. Latest delivery outcome per endpoint; disabled endpoints are down.`
        ),
        row(
          'Cameras',
          contacts(orgCameras),
          null,
          null,
          `${orgCameras.length} registered. Contact freshness: 2 min; success/error outcomes not instrumented.`,
          latest(orgCameras.map((item) => item.lastSeenAt))
        ),
        row(
          'Pharmacy reference connector',
          combined(refs.map((item) => item.status)),
          latest(refs.map((item) => item.success)),
          latest(refs.map((item) => item.error)),
          `${refs.length} configured. Latest completed run per connector; running or unobserved is degraded.`
        ),
      ];
    });
    const names = new Map(organizations.map((org) => [org.id, org.displayName]));
    const counts = [
      ...['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'].map((status) => ({
        queue: 'Platform',
        status,
        data: platformCounts.find((item) => item.status === status),
      })),
      ...['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD'].map((status) => ({
        queue: 'Restaurant',
        status,
        data: restaurantCounts.find((item) => item.status === status),
      })),
    ].map(({ queue, status, data }) => ({
      queue,
      status,
      count: data?._count._all ?? 0,
      oldestCreatedAt: data?._min.createdAt ?? null,
    }));
    return {
      observedAt,
      filters,
      organizations,
      page,
      pageCount,
      tenantCount: matching.length,
      counts,
      alertCount: platformAlertCount + restaurantAlertCount,
      alerts: [
        ...platformAlerts.map((job) => ({
          id: job.id,
          queue: 'Platform',
          organization: job.organizationId
            ? (names.get(job.organizationId) ?? 'Unknown organization')
            : 'Platform',
          status: job.status,
          since: job.status === 'RUNNING' ? (job.startedAt ?? job.createdAt) : job.finishedAt,
        })),
        ...restaurantAlerts.map((job) => ({
          id: job.id,
          queue: 'Restaurant',
          organization: names.get(job.organizationId) ?? 'Unknown organization',
          status: job.status,
          since: job.status === 'RUNNING' ? (job.claimedAt ?? job.createdAt) : job.updatedAt,
        })),
      ],
      workerHeartbeat: {
        status: 'not instrumented' as const,
        note: 'No worker heartbeat table. Job claims and executions are activity, not proof of worker liveness. A heartbeat older than 2 minutes would be down; no heartbeat is fabricated.',
      },
      integrations: integrationRows,
    };
  });
}

export type PlatformHealth = Awaited<ReturnType<typeof readPlatformHealth>>;
export const platformHealthRouter = router({
  overview: publicProcedure.input(healthFilters).query(({ input }) => readPlatformHealth(input)),
});
