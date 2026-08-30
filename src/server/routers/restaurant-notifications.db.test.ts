import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const runtimeUrl = process.env.WHA910_TEST_RUNTIME_DATABASE_URL;
const ownerUrl = process.env.WHA910_TEST_OWNER_DATABASE_URL;
if (!runtimeUrl || !ownerUrl) {
  throw new Error(
    'WHA910_TEST_RUNTIME_DATABASE_URL and WHA910_TEST_OWNER_DATABASE_URL are required'
  );
}
if (runtimeUrl === ownerUrl) throw new Error('Runtime and owner database URLs must differ');
process.env.DATABASE_URL = runtimeUrl;

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let restaurantNotificationsRouter: typeof import('./restaurant-notifications').restaurantNotificationsRouter;

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const organizationId = `wha910_retry_org_${suffix}`;
const deadJobId = `wha910_dead_${suffix}`;
const eventId = `wha910_event_${suffix}`;
const owner = new pg.Client({ connectionString: ownerUrl });

function caller(db: ScopedDb) {
  return restaurantNotificationsRouter.createCaller({
    db,
    entitlements: {
      organizationId,
      enabledModules: ['restaurant-core'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: {
        id: 'admin_1',
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId,
      },
    },
    organization: { id: organizationId },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

describe('restaurant webhook manual retry against PostgreSQL', () => {
  beforeAll(async () => {
    ({ withTenantDb } = await import('@/lib/tenancy/scoped-db'));
    ({ restaurantNotificationsRouter } = await import('./restaurant-notifications'));
    await owner.connect();
    await owner.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await owner.query(
      `INSERT INTO organizations
         (id, slug, "legalName", "displayName", status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now())`,
      [organizationId]
    );
    await owner.query(
      `INSERT INTO restaurant_jobs
         (id, "organizationId", type, payload, status, attempts, "maxAttempts",
          "idempotencyKey", "updatedAt")
       VALUES ($1,$2,'notification.webhook.deliver.v1',$3::jsonb,'DEAD',5,5,$4,now())`,
      [
        deadJobId,
        organizationId,
        JSON.stringify({
          eventId,
          notificationId: `notification_${suffix}`,
          attemptOffset: 2,
          version: '1.0',
        }),
        `notification-webhook:${eventId}`,
      ]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
    await owner.end();
  });

  it('uses a LOGIN NOSUPERUSER NOBYPASSRLS runtime role', async () => {
    await withTenantDb(organizationId, async (db) => {
      const rows = await db.$queryRaw<
        { rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }[]
      >`SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      expect(rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
    });
  });

  it('returns one successor from true concurrent production retries', async () => {
    const results = await Promise.all([
      withTenantDb(organizationId, (db) => caller(db).retryWebhook({ eventId: deadJobId })),
      withTenantDb(organizationId, (db) => caller(db).retryWebhook({ eventId: deadJobId })),
    ]);

    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ status: 'QUEUED' });

    await withTenantDb(organizationId, async (db) => {
      const original = await db.restaurantJob.findUniqueOrThrow({ where: { id: deadJobId } });
      expect(original).toMatchObject({ status: 'DEAD', attempts: 5 });
      const successors = await db.restaurantJob.findMany({
        where: {
          idempotencyKey: `notification-webhook:${eventId}:retry:${deadJobId}`,
        },
      });
      expect(successors).toHaveLength(1);
      expect(successors[0]?.payload).toMatchObject({ attemptOffset: 7 });
      expect(await db.restaurantJobExecution.count({ where: { jobId: deadJobId } })).toBe(0);
    });
  });
});
