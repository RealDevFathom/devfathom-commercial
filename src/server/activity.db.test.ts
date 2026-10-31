/**
 * @vitest-environment node
 *
 * Regression coverage for activity writes made from a real interactive Prisma
 * transaction. Requires a migrated PostgreSQL database in TEST_DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const organizationId = `activity_tx_${suffix}`;
const userId = `activity_user_${suffix}`;

type Dependencies = {
  logActivity: (typeof import('./activity'))['logActivity'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
};

let deps: Dependencies;

describeIfDatabase('activity writes in PostgreSQL tenant transactions', () => {
  beforeAll(async () => {
    const [activity, scopedDb] = await Promise.all([
      import('./activity'),
      import('@/lib/tenancy/scoped-db'),
    ]);
    deps = { logActivity: activity.logActivity, ...scopedDb };

    await deps.withPlatformDb(async (tx) => {
      await tx.organization.create({
        data: {
          id: organizationId,
          slug: organizationId,
          legalName: 'Activity transaction test',
          displayName: 'Activity transaction test',
        },
      });
    });
    await deps.withTenantDb(organizationId, async (tx) => {
      await tx.organizationDepartment.create({
        data: { id: `activity_dept_${suffix}`, key: 'OPS', name: 'Operations' },
      });
      await tx.user.create({
        data: {
          id: userId,
          name: 'Activity test user',
          email: `${userId}@example.test`,
          department: 'OPS',
          title: 'Tester',
        },
      });
    });
  });

  afterAll(async () => {
    if (!deps) return;
    await deps.withPlatformDb(async (tx) => {
      await tx.activity.deleteMany({ where: { organizationId } });
      await tx.organization.deleteMany({ where: { id: organizationId } });
    });
  });

  it('commits the activity before the interactive transaction closes', async () => {
    await expect(
      deps.withTenantDb(organizationId, async (tx) => {
        deps.logActivity(tx, userId, {
          type: 'project_created',
          message: 'created project through a tenant transaction',
          entityType: 'Project',
          entityId: `project_${suffix}`,
        });
      })
    ).resolves.toBeUndefined();

    const activity = await deps.withTenantDb(organizationId, (tx) =>
      tx.activity.findFirst({ where: { userId, entityId: `project_${suffix}` } })
    );
    expect(activity).toMatchObject({
      organizationId,
      userId,
      type: 'project_created',
      message: 'created project through a tenant transaction',
    });
  });
});
