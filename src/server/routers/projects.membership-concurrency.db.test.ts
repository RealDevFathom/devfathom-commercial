/**
 * @vitest-environment node
 *
 * PostgreSQL regression for the last-project-lead invariant. Requires a migrated
 * disposable TEST_DATABASE_URL; it skips when that database is not configured.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
    projectCaller = projectsRouter.createCaller({
      db: createTenantDb(ORG, ADMIN),
      session: {
        expires: 'later',
        user: { id: ADMIN, role: 'ADMIN', status: 'ACTIVE', organizationId: ORG },
      },
      organization: { id: ORG, isDemo: false },
      entitlements: { organizationId: ORG, enabledModules: [], modules: [], limits: {} },
      support: null,
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as never);
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

  it.each([
    ['setMemberRole', 'setMemberRole'],
    ['addMember', 'addMember'],
    ['addMember', 'setMemberRole'],
    ['removeMember', 'setMemberRole'],
    ['removeMember', 'addMember'],
    ['removeMember', 'removeMember'],
  ] as const)('preserves a lead during concurrent %s and %s', async (first, second) => {
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
  });
});
