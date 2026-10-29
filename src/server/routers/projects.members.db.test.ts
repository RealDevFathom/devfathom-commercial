/**
 * @vitest-environment node
 *
 * Exercises the project-lead invariant through the real router, Prisma and a
 * migrated PostgreSQL database. TEST_DATABASE_URL must name the gate's
 * restricted runtime role; without it this suite is explicitly skipped.
 */
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

vi.mock('server-only', () => ({}));
vi.mock('../activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const organizationId = `project_leads_${suffix}`;
const departmentId = `project_department_${suffix}`;
const projectId = `project_${suffix}`;
const leadA = `project_lead_a_${suffix}`;
const leadB = `project_lead_b_${suffix}`;

suite('project lead invariant, against PostgreSQL', () => {
  let fixture: pg.Client;
  let createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  let projectsRouter: (typeof import('./projects'))['projectsRouter'];

  beforeAll(async () => {
    fixture = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await fixture.connect();
    const role = await fixture.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const rls = await fixture.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE oid = 'project_members'::regclass`
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);

    await fixture.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await fixture.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", status, "updatedAt")
       VALUES ($1, $1, $1, $1, 'ACTIVE', now())`,
      [organizationId]
    );
    await fixture.query(
      `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
       VALUES ($1, $2, 'PROJECTS', 'Projects', now())`,
      [departmentId, organizationId]
    );
    await fixture.query(
      `INSERT INTO users (id, "organizationId", name, email, role, department, title, "updatedAt")
       VALUES ($1, $3, 'Lead A', $1 || '@test.invalid', 'EMPLOYEE', 'PROJECTS', 'Lead', now()),
              ($2, $3, 'Lead B', $2 || '@test.invalid', 'EMPLOYEE', 'PROJECTS', 'Lead', now())`,
      [leadA, leadB, organizationId]
    );
    await fixture.query(
      `INSERT INTO projects (id, "organizationId", name, type, "updatedAt")
       VALUES ($1, $2, 'Lead race', 'INTERNAL', now())`,
      [projectId, organizationId]
    );
    await fixture.query(
      `INSERT INTO project_members (id, "organizationId", "projectId", "userId", role)
       VALUES ($1, $3, $4, $5, 'LEAD'), ($2, $3, $4, $6, 'LEAD')`,
      [`pm_a_${suffix}`, `pm_b_${suffix}`, organizationId, projectId, leadA, leadB]
    );

    ({ createTenantDb } = await import('@/lib/tenancy/scoped-db'));
    ({ projectsRouter } = await import('./projects'));
  }, 30_000);

  afterAll(async () => {
    if (fixture) {
      await fixture.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
      await fixture.end();
    }
    const { db } = await import('@/lib/db');
    await db.$disconnect();
  });

  function caller(userId: string) {
    return projectsRouter.createCaller({
      db: createTenantDb(organizationId, userId),
      session: {
        user: { id: userId, organizationId, role: 'EMPLOYEE', status: 'ACTIVE' },
      },
      organization: { id: organizationId },
      entitlements: { enabledModules: ['projects'] },
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as never);
  }

  it('serializes concurrent addMember upsert demotions under RLS', async () => {
    const results = await Promise.allSettled([
      caller(leadA).addMember({ projectId, userId: leadA, role: 'MEMBER' }),
      caller(leadB).addMember({ projectId, userId: leadB, role: 'MEMBER' }),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: { code: 'BAD_REQUEST' },
    });
    const remaining = await fixture.query<{ userId: string }>(
      `SELECT "userId" FROM project_members WHERE "projectId" = $1 AND role = 'LEAD'`,
      [projectId]
    );
    expect(remaining.rows).toHaveLength(1);
  });
});
