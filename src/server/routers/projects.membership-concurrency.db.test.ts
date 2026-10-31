/**
 * @vitest-environment node
 *
 * PostgreSQL regression for the last-project-lead invariant. Requires a migrated
 * disposable TEST_DATABASE_URL; it skips when that database is not configured.
 */
import { randomBytes } from 'node:crypto';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '@/server/trpc';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(), sendEmail: vi.fn(), templates: {} }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const ORG = `project_lead_${suffix}`;
const PROJECT = `project_${suffix}`;
const ADMIN = `admin_${suffix}`;
const LEAD_A = `lead_a_${suffix}`;
const LEAD_B = `lead_b_${suffix}`;
let setup: pg.Client;
let projectCaller: ReturnType<(typeof import('./projects'))['projectsRouter']['createCaller']>;
let projectContext: (db: ScopedDb) => TRPCContext;

const concurrentMutations = [
  ['setMemberRole', 'setMemberRole'],
  ['addMember', 'addMember'],
  ['addMember', 'setMemberRole'],
  ['removeMember', 'setMemberRole'],
  ['removeMember', 'addMember'],
  ['removeMember', 'removeMember'],
] as const;

/** Use the real HTTP batch adapter inside the same tenant wrapper as the route. */
async function sharedTransactionBatch(
  calls: { method: (typeof concurrentMutations)[number][number]; userId: string }[]
) {
  const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
  const { projectsRouter } = await import('./projects');
  return withTenantDb(
    ORG,
    async (tx) => {
      const response = await fetchRequestHandler({
        endpoint: '/api/trpc',
        router: projectsRouter,
        createContext: () => projectContext(tx),
        req: new Request(
          `http://localhost/api/trpc/${calls.map((call) => call.method).join(',')}?batch=1`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(
              Object.fromEntries(
                calls.map((call, index) => [
                  index,
                  { json: { projectId: PROJECT, userId: call.userId, role: 'MEMBER' } },
                ])
              )
            ),
          }
        ),
      });
      const entries = (await response.json()) as {
        result?: { data: { json: { id: string } } };
        error?: { json: { data: { code: string } } };
      }[];
      const leadCount = await tx.projectMember.count({
        where: { projectId: PROJECT, role: 'LEAD' },
      });
      // Like the HTTP route, reject the owning transaction if any sibling fails.
      if (entries.some((entry) => entry.error)) {
        throw Object.assign(new Error('Membership batch rolled back'), {
          leadCount,
          outcomes: entries.map((entry) => entry.error?.json.data.code ?? 'SUCCESS'),
        });
      }
      return entries;
    },
    { userId: ADMIN }
  );
}

describeIfDatabase('project membership concurrency against PostgreSQL', () => {
  beforeAll(async () => {
    setup = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await setup.connect();
    await setup.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await setup.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", status, "updatedAt")
       VALUES ($1, $1, $1, $1, 'ACTIVE', now())`,
      [ORG]
    );
    await setup.query(
      `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
       VALUES ($1, $2, 'OPS', 'Operations', now())`,
      [`dept_${suffix}`, ORG]
    );
    await setup.query(
      `INSERT INTO users (id, "organizationId", name, email, role, department, title, "updatedAt")
       VALUES ($1,$4,'Admin',$1 || '@test.invalid','ADMIN','OPS','Admin',now()),
              ($2,$4,'Lead A',$2 || '@test.invalid','EMPLOYEE','OPS','Lead',now()),
              ($3,$4,'Lead B',$3 || '@test.invalid','EMPLOYEE','OPS','Lead',now())`,
      [ADMIN, LEAD_A, LEAD_B, ORG]
    );
    await setup.query(
      `INSERT INTO projects (id, "organizationId", name, type, "updatedAt")
       VALUES ($1, $2, 'Concurrent project', 'INTERNAL', now())`,
      [PROJECT, ORG]
    );
    const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
    const { projectsRouter } = await import('./projects');
    projectContext = (db) =>
      ({
        db,
        session: {
          expires: 'later',
          user: { id: ADMIN, role: 'ADMIN', status: 'ACTIVE', organizationId: ORG },
        },
        organization: { id: ORG, isDemo: false },
        entitlements: { organizationId: ORG, enabledModules: [], modules: [], limits: {} },
        support: null,
        requestMeta: { ip: null, userAgent: null },
        audit: { detail: {} },
      }) as never;
    projectCaller = projectsRouter.createCaller(projectContext(createTenantDb(ORG, ADMIN)));
  });

  beforeEach(async () => {
    await setup.query(`DELETE FROM project_members WHERE "projectId" = $1`, [PROJECT]);
    await setup.query(
      `INSERT INTO project_members (id, "organizationId", "projectId", "userId", role)
       VALUES ($1,$5,$6,$3,'LEAD'), ($2,$5,$6,$4,'LEAD')`,
      [`pm_a_${suffix}`, `pm_b_${suffix}`, LEAD_A, LEAD_B, ORG, PROJECT]
    );
  });

  afterAll(async () => {
    if (!setup) return;
    try {
      await setup.query(`DELETE FROM projects WHERE id = $1`, [PROJECT]);
      await setup.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    } finally {
      await setup.end();
    }
  });

  it.each(concurrentMutations)(
    'preserves a lead during concurrent %s and %s',
    async (first, second) => {
      const results = await Promise.allSettled([
        projectCaller[first]({ projectId: PROJECT, userId: LEAD_A, role: 'MEMBER' }),
        projectCaller[second]({ projectId: PROJECT, userId: LEAD_B, role: 'MEMBER' }),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected?.reason).toMatchObject({ code: 'BAD_REQUEST' });
      const remaining = await setup.query<{ count: string }>(
        `SELECT count(*) FROM project_members WHERE "projectId" = $1 AND role = 'LEAD'`,
        [PROJECT]
      );
      expect(remaining.rows[0]?.count).toBe('1');
    }
  );

  it('keeps duplicate adds idempotent within one HTTP batch transaction', async () => {
    // ADMIN starts outside the project, so both calls would otherwise read a
    // missing membership and the second INSERT would abort the whole batch.
    const entries = await sharedTransactionBatch([
      { method: 'addMember', userId: ADMIN },
      { method: 'addMember', userId: ADMIN },
    ]);

    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.result && !entry.error)).toBe(true);
    expect(entries[0].result?.data.json.id).toBe(entries[1].result?.data.json.id);
    const added = await setup.query<{ count: string }>(
      `SELECT count(*) FROM project_members WHERE "projectId" = $1 AND "userId" = $2`,
      [PROJECT, ADMIN]
    );
    expect(added.rows[0]?.count).toBe('1');
  });

  it.each(concurrentMutations)(
    'preserves the last lead in a shared-transaction HTTP batch of %s and %s',
    async (first, second) => {
      await expect(
        sharedTransactionBatch([
          { method: first, userId: LEAD_A },
          { method: second, userId: LEAD_B },
        ])
      ).rejects.toMatchObject({
        leadCount: 1,
        outcomes: expect.arrayContaining(['SUCCESS', 'BAD_REQUEST']),
      });

      // The failed batch rolls back its successful sibling too.
      const remaining = await setup.query<{ count: string }>(
        `SELECT count(*) FROM project_members WHERE "projectId" = $1 AND role = 'LEAD'`,
        [PROJECT]
      );
      expect(remaining.rows[0]?.count).toBe('2');
    }
  );
});
