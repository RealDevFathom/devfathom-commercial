/**
 * @vitest-environment node
 *
 * Real PostgreSQL coverage for competing HR decisions. Requires a migrated,
 * disposable TEST_DATABASE_URL; the suite is skipped when one is not supplied.
 */
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const effects = vi.hoisted(() => ({ notify: vi.fn(), annotateAudit: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: vi.fn(async () => true),
}));
vi.mock('@/lib/notifications', () => ({ notify: effects.notify }));
vi.mock('@/lib/email', () => ({
  appUrl: () => 'https://example.test',
  sendEmail: vi.fn(),
  templates: {
    leaveRequest: vi.fn(() => ({ subject: '', html: '', text: '' })),
    resignationDecision: vi.fn(() => ({ subject: '', html: '', text: '' })),
  },
}));
vi.mock('../audit', () => ({
  annotateAudit: effects.annotateAudit,
  diffChanges: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const ORG = `hr_race_${suffix}`;
const id = (name: string) => `hr_race_${name}_${suffix}`;
const EMPLOYEE = id('employee');
const APPROVER = id('approver');
const DECLINER = id('decliner');
const LEAVE = id('leave');
const RESIGNATION = id('resignation');

type DecisionCaller = {
  team: { updateLeaveStatus(input: { id: string; status: 'APPROVED' | 'REJECTED' }): Promise<unknown> };
  resignations: {
    review(input: { id: string; decision: 'APPROVED' | 'DECLINED' }): Promise<unknown>;
  };
};

let client: pg.Client;
let caller: (reviewerId: string) => DecisionCaller;

function expectSingleWinner(results: PromiseSettledResult<unknown>[]) {
  expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  expect(failures).toHaveLength(1);
  expect(failures[0]?.reason).toMatchObject({ code: 'CONFLICT' });
}

describeIfDatabase('atomic HR decisions, against PostgreSQL', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await client.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt")
       VALUES ($1, $1, $1, $1, now())`,
      [ORG]
    );
    await client.query(
      `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
       VALUES ($1, $2, 'OPS', 'Operations', now())`,
      [id('department'), ORG]
    );
    await client.query(
      `INSERT INTO users (id, "organizationId", name, email, role, department, title, "updatedAt")
       SELECT u.id, $1, u.name, u.id || '@test.invalid', u.role::"Role", 'OPS', 'Staff', now()
         FROM (VALUES ($2, 'Employee', 'EMPLOYEE'), ($3, 'Approver', 'ADMIN'),
                      ($4, 'Decliner', 'ADMIN')) AS u(id, name, role)`,
      [ORG, EMPLOYEE, APPROVER, DECLINER]
    );

    const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
    const { router } = await import('../trpc');
    const { teamRouter } = await import('./team');
    const { resignationsRouter } = await import('./resignations');
    const app = router({ team: teamRouter, resignations: resignationsRouter });
    caller = (reviewerId) =>
      app.createCaller({
        db: createTenantDb(ORG, reviewerId),
        entitlements: {
          organizationId: ORG,
          enabledModules: ['hr'],
          modules: [{ key: 'hr', name: 'HR', enabled: true }],
          activeSeats: 3,
          seatLimit: 10,
        },
        session: {
          expires: 'later',
          user: { id: reviewerId, role: 'ADMIN', status: 'ACTIVE', organizationId: ORG },
        },
        organization: { id: ORG, isDemo: false },
        support: null,
        requestMeta: { ip: null, userAgent: null },
        audit: { detail: {} },
      } as never) as DecisionCaller;
  }, 120_000);

  beforeEach(async () => {
    effects.notify.mockClear();
    effects.annotateAudit.mockClear();
    await client.query(`DELETE FROM resignations WHERE "organizationId" = $1`, [ORG]);
    await client.query(`DELETE FROM leave_requests WHERE "organizationId" = $1`, [ORG]);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await client.end();
  });

  it('admits exactly one approval-vs-rejection leave transition', async () => {
    await client.query(
      `INSERT INTO leave_requests
         (id, "organizationId", "userId", type, "startDate", "endDate", status, "updatedAt")
       VALUES ($1, $2, $3, 'VACATION', now() + interval '7 days',
               now() + interval '8 days', 'PENDING', now())`,
      [LEAVE, ORG, EMPLOYEE]
    );

    const results = await Promise.allSettled([
      caller(APPROVER).team.updateLeaveStatus({ id: LEAVE, status: 'APPROVED' }),
      caller(DECLINER).team.updateLeaveStatus({ id: LEAVE, status: 'REJECTED' }),
    ]);

    expectSingleWinner(results);
    const stored = await client.query<{ status: string; approvedById: string }>(
      `SELECT status, "approvedById" FROM leave_requests WHERE id = $1`,
      [LEAVE]
    );
    expect(['APPROVED', 'REJECTED']).toContain(stored.rows[0]?.status);
    expect(stored.rows[0]?.approvedById).toBe(
      stored.rows[0]?.status === 'APPROVED' ? APPROVER : DECLINER
    );
    expect(effects.notify).toHaveBeenCalledOnce();
  });

  it('serializes approval-vs-decline resignation review to one winner', async () => {
    await client.query(
      `INSERT INTO resignations
         (id, "organizationId", "userId", reason, "proposedLastDay", status, "updatedAt")
       VALUES ($1, $2, $3, 'Moving to a new role', now() + interval '30 days', 'PENDING', now())`,
      [RESIGNATION, ORG, EMPLOYEE]
    );

    const results = await Promise.allSettled([
      caller(APPROVER).resignations.review({ id: RESIGNATION, decision: 'APPROVED' }),
      caller(DECLINER).resignations.review({ id: RESIGNATION, decision: 'DECLINED' }),
    ]);

    expectSingleWinner(results);
    const stored = await client.query<{ status: string; reviewedById: string }>(
      `SELECT status, "reviewedById" FROM resignations WHERE id = $1`,
      [RESIGNATION]
    );
    expect(['APPROVED', 'DECLINED']).toContain(stored.rows[0]?.status);
    expect(stored.rows[0]?.reviewedById).toBe(
      stored.rows[0]?.status === 'APPROVED' ? APPROVER : DECLINER
    );
    expect(effects.annotateAudit).toHaveBeenCalledOnce();
    expect(effects.notify).toHaveBeenCalledOnce();
  });
});
