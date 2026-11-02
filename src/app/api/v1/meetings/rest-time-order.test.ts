// @vitest-environment node
/**
 * REST `POST /api/v1/meetings` time order, against a REAL PostgreSQL
 * (DEV-249 / #451).
 *
 * This route writes through Prisma directly and never consults the meetings
 * router, so the router's check does not cover it. These cases pin the route's
 * own refusal: an end at or before the start is a 400 that names the field,
 * and nothing is written.
 *
 * No row level security guard: nothing here depends on tenant isolation.
 *
 * Requires TEST_DATABASE_URL (a migrated, throwaway database, never
 * DATABASE_URL). Without it the suite reports itself skipped rather than
 * passing vacuously.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MEETING_TIME_ORDER_MESSAGE } from '@/lib/meetings/time-order';
import { seedDepartments } from '@/lib/test-support/departments';

// REST audit writes are fire-and-forget and would race teardown. Nothing here
// tests auditing.
vi.mock('@/server/audit', () => ({ recordRestAudit: vi.fn() }));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// `@/lib/db` reads DATABASE_URL when its module is evaluated, so this has to
// happen before the dynamic imports in `beforeAll`.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const suffix = randomBytes(6).toString('hex');
const id = (name: string) => `${name}_rest_order_${suffix}`;

const ORGANIZATION = id('org');
const OWNER = id('user_owner');

const HOUR = 60 * 60 * 1000;
const BASE = Math.ceil((Date.now() + 7 * 24 * HOUR) / HOUR) * HOUR;
const at = (hours: number) => new Date(BASE + hours * HOUR).toISOString();

type Deps = {
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  POST: (typeof import('./route'))['POST'];
};

let deps: Deps;
let token = '';

const callPost = async (body: unknown) => {
  const response = await deps.POST(
    new Request('https://acme.example.test/api/v1/meetings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      data?: { id: string; startTime: string; endTime: string };
      error?: string;
      details?: Array<{ path: string[]; message: string }>;
    },
  };
};

const countTitled = (title: string) =>
  deps.withTenantDb(ORGANIZATION, (db) => db.meeting.count({ where: { title } }));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('POST /api/v1/meetings time order, against PostgreSQL', () => {
  beforeAll(async () => {
    const scopedDb = await import('@/lib/tenancy/scoped-db');
    deps = {
      withPlatformDb: scopedDb.withPlatformDb,
      withTenantDb: scopedDb.withTenantDb,
      POST: (await import('./route')).POST,
    };

    const { generateApiToken } = await import('@/lib/api-auth');
    const minted = await generateApiToken();
    token = minted.token;

    await deps.withPlatformDb(async (db) => {
      await db.organization.create({
        data: {
          id: ORGANIZATION,
          slug: ORGANIZATION.replaceAll('_', '-'),
          legalName: 'REST Time Order',
          displayName: 'REST Time Order',
          status: 'ACTIVE',
        },
      });
      await seedDepartments(db, [ORGANIZATION], ['ENGINEERING']);

      // The route is gated on the `api` and `meetings` modules. Catalog rows
      // may already exist in a migrated database, so upsert by key.
      for (const [key, name] of [
        ['api', 'API'],
        ['meetings', 'Meetings'],
      ] as const) {
        const platformModule = await db.platformModule.upsert({
          where: { key },
          create: { key, name, category: 'core', band: 'PLATFORM', active: true },
          update: { active: true },
        });
        await db.organizationModule.create({
          data: { organizationId: ORGANIZATION, moduleId: platformModule.id, status: 'ENABLED' },
        });
      }
    });

    await deps.withTenantDb(ORGANIZATION, async (db) => {
      await db.user.create({
        data: {
          id: OWNER,
          organizationId: ORGANIZATION,
          email: `${OWNER}@example.test`,
          name: OWNER,
          title: 'Engineer',
          department: 'ENGINEERING',
          role: 'EMPLOYEE',
          status: 'ACTIVE',
        },
      });
      await db.apiToken.create({
        data: {
          organizationId: ORGANIZATION,
          name: 'writer token',
          prefix: minted.prefix,
          tokenHash: minted.hash,
          scopes: ['meetings:write'],
          userId: OWNER,
        },
      });
    });
  }, 60_000);

  afterAll(async () => {
    if (!deps) return;
    await deps.withPlatformDb(async (db) => {
      await db.meeting.deleteMany({ where: { organizationId: ORGANIZATION } });
      await db.apiToken.deleteMany({ where: { organizationId: ORGANIZATION } });
      await db.user.deleteMany({ where: { organizationId: ORGANIZATION } });
      await db.organizationModule.deleteMany({ where: { organizationId: ORGANIZATION } });
      await db.organization.deleteMany({ where: { id: ORGANIZATION } });
    });
  }, 60_000);

  it.each([
    ['equal to', 10],
    ['before', 9],
  ])('refuses an end %s the start with a 400 naming endTime', async (_label, endHour) => {
    const title = id(`bad_${endHour}`);
    const { status, body } = await callPost({
      title,
      startTime: at(10),
      endTime: at(endHour),
    });

    expect(status).toBe(400);
    expect(body.error).toBe(MEETING_TIME_ORDER_MESSAGE);
    expect(body.details).toEqual([{ path: ['endTime'], message: MEETING_TIME_ORDER_MESSAGE }]);
    expect(body.data).toBeUndefined();
    expect(await countTitled(title)).toBe(0);
  });

  it('creates a meeting whose end is after its start', async () => {
    const title = id('ok');
    const { status, body } = await callPost({ title, startTime: at(10), endTime: at(11) });

    expect(status).toBe(201);
    expect(new Date(body.data!.endTime).getTime()).toBeGreaterThan(
      new Date(body.data!.startTime).getTime()
    );
    expect(await countTitled(title)).toBe(1);
  });
});
