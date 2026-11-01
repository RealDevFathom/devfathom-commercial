/**
 * @vitest-environment node
 *
 * The team directory against a REAL migrated PostgreSQL, through the real router
 * and the real ABAC engine.
 *
 * `team.getById` reads a colleague's projects and tasks with relation filters;
 * this proves those filters on rows, under forced row-level security: a member
 * sees only the projects they share and the tasks they may see, HR the whole
 * project list (as for the contact details) but only the tasks HR may see, and
 * an administrator or the person everything. `team.getAll` answers a DENY on
 * `team:view` with the viewer's own row alone.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the
 * restricted runtime role (neither SUPERUSER nor BYPASSRLS — asserted first).
 * Without it the suite reports itself skipped rather than passing vacuously.
 */
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
// `@/lib/db` reads DATABASE_URL on first use; everything that reaches it is
// imported inside the suite, after this line.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(), sendEmail: vi.fn(), templates: {} }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const ORG = `harden_team_${suffix}`;
const id = (name: string) => `harden_${name}_${suffix}`;
const MEMBER = id('member');
const COLLEAGUE = id('colleague');
const PEOPLE_OPS = id('hr');
const ADMIN = id('admin');
const DENIED = id('denied');
/** The colleague and the member are both on it. */
const SHARED_PROJECT = id('project_shared');
/** Only the colleague is on it. */
const PRIVATE_PROJECT = id('project_private');
/** On the shared project, assigned to the colleague. */
const SHARED_TASK = id('task_shared');
/** On the private project, assigned to the colleague alone. */
const PRIVATE_TASK = id('task_private');
/** On the private project, assigned to the colleague and the member. */
const CO_ASSIGNED_TASK = id('task_coassigned');

type Role = 'EMPLOYEE' | 'HR' | 'ADMIN';
let client: pg.Client;
let createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
let team: (
  userId: string,
  role: Role
) => Promise<{
  getById: (input: { id: string }) => Promise<unknown>;
  getAll: () => Promise<unknown>;
}>;

/** The ids a list of `{ project: { id } }` or `{ task: { id } }` rows names, sorted. */
function idsOf(rows: Array<{ project?: { id: string }; task?: { id: string } }>) {
  return rows.map((row) => (row.project ?? row.task)!.id).sort();
}

describeIfDatabase('team directory, against PostgreSQL', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);

    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await client.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt")
       VALUES ($1, $1, $1, $1, now())`,
      [ORG]
    );
    await client.query(
      `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
       VALUES ($1, $2, 'OPS', 'Operations', now())`,
      [id('dept'), ORG]
    );
    await client.query(
      `INSERT INTO users (id, "organizationId", name, email, phone, role, department, title, "updatedAt")
       SELECT u.id, $1, u.name, u.id || '@test.invalid', '+92 300 0000000', u.role::"Role", 'OPS', 'Staff', now()
         FROM (VALUES ($2, 'Member', 'EMPLOYEE'), ($3, 'Colleague', 'EMPLOYEE'),
                      ($4, 'People ops', 'HR'), ($5, 'Admin', 'ADMIN'),
                      ($6, 'Denied', 'EMPLOYEE')) AS u(id, name, role)`,
      [ORG, MEMBER, COLLEAGUE, PEOPLE_OPS, ADMIN, DENIED]
    );
    await client.query(
      `INSERT INTO user_permission_overrides (id, "organizationId", "userId", capability, effect, reason, "updatedAt")
       VALUES ($1, $2, $3, 'team:view', 'DENY', 'Synthetic directory denial', now())`,
      [id('deny'), ORG, DENIED]
    );
    await client.query(
      `INSERT INTO projects (id, "organizationId", name, type, "updatedAt")
       VALUES ($1, $3, 'Shared project', 'INTERNAL', now()), ($2, $3, 'Private project', 'INTERNAL', now())`,
      [SHARED_PROJECT, PRIVATE_PROJECT, ORG]
    );
    await client.query(
      `INSERT INTO project_members (id, "organizationId", "projectId", "userId")
       VALUES ($1, $4, $5, $6), ($2, $4, $5, $7), ($3, $4, $8, $6)`,
      [id('pm1'), id('pm2'), id('pm3'), ORG, SHARED_PROJECT, COLLEAGUE, MEMBER, PRIVATE_PROJECT]
    );
    await client.query(
      `INSERT INTO boards (id, "organizationId", name, "projectId", "updatedAt")
       VALUES ($1, $3, 'Shared board', $4, now()), ($2, $3, 'Private board', $5, now())`,
      [id('board_shared'), id('board_private'), ORG, SHARED_PROJECT, PRIVATE_PROJECT]
    );
    await client.query(
      `INSERT INTO columns (id, "organizationId", name, "boardId", "order", "updatedAt")
       VALUES ($1, $3, 'To do', $4, 0, now()), ($2, $3, 'To do', $5, 0, now())`,
      [id('column_shared'), id('column_private'), ORG, id('board_shared'), id('board_private')]
    );
    await client.query(
      `INSERT INTO tasks (id, "organizationId", title, "columnId", "order", "createdById", "updatedAt")
       VALUES ($1, $4, 'Shared task', $5, 0, $7, now()),
              ($2, $4, 'Private task', $6, 0, $7, now()),
              ($3, $4, 'Co-assigned task', $6, 1, $7, now())`,
      [
        SHARED_TASK,
        PRIVATE_TASK,
        CO_ASSIGNED_TASK,
        ORG,
        id('column_shared'),
        id('column_private'),
        ADMIN,
      ]
    );
    await client.query(
      `INSERT INTO task_assignees (id, "organizationId", "taskId", "userId")
       VALUES ($1, $5, $6, $9), ($2, $5, $7, $9), ($3, $5, $8, $9), ($4, $5, $8, $10)`,
      [
        id('ta1'),
        id('ta2'),
        id('ta3'),
        id('ta4'),
        ORG,
        SHARED_TASK,
        PRIVATE_TASK,
        CO_ASSIGNED_TASK,
        COLLEAGUE,
        MEMBER,
      ]
    );

    ({ createTenantDb } = await import('@/lib/tenancy/scoped-db'));
    const { router } = await import('../trpc');
    const { teamRouter } = await import('./team');
    const app = router({ team: teamRouter });
    team = async (userId, userRole) =>
      app.createCaller({
        db: createTenantDb(ORG, userId),
        entitlements: {
          organizationId: ORG,
          enabledModules: ['hr'],
          modules: [{ key: 'hr', name: 'HR', enabled: true }],
          activeSeats: 5,
          seatLimit: 50,
        },
        session: {
          expires: 'later',
          user: { id: userId, role: userRole, status: 'ACTIVE', organizationId: ORG },
        },
        organization: { id: ORG, isDemo: false },
        support: null,
        requestMeta: { ip: null, userAgent: null },
        audit: { detail: {} },
      } as never).team;
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    // Projects first: their tasks name a creator, which the users cascade cannot drop.
    await client.query(`DELETE FROM projects WHERE "organizationId" = $1`, [ORG]);
    await client.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await client.end();
  });

  type Profile = {
    email: string;
    phone: string | null;
    projectMembers: Array<{ project: { id: string } }>;
    assignedTasks: Array<{ task: { id: string } }>;
    workScope: { projects: string; tasks: string };
  };
  const profile = async (viewer: string, role: Role, of = COLLEAGUE) =>
    (await (await team(viewer, role)).getById({ id: of })) as Profile;

  it('shows a member only the projects they share and the tasks they may see', async () => {
    const seen = await profile(MEMBER, 'EMPLOYEE');
    expect(idsOf(seen.projectMembers)).toEqual([SHARED_PROJECT]);
    // The shared project's task, and a private-project task the member is assigned to too.
    expect(idsOf(seen.assignedTasks)).toEqual([CO_ASSIGNED_TASK, SHARED_TASK].sort());
    expect(seen.workScope).toEqual({ projects: 'SHARED', tasks: 'VISIBLE' });
    expect(seen).toMatchObject({ email: '', phone: null });
  });

  it('shows HR the whole project list, as the contact details, but only the tasks HR may see', async () => {
    const seen = await profile(PEOPLE_OPS, 'HR');
    expect(idsOf(seen.projectMembers)).toEqual([PRIVATE_PROJECT, SHARED_PROJECT].sort());
    expect(seen.assignedTasks).toEqual([]);
    expect(seen.workScope).toEqual({ projects: 'ALL', tasks: 'VISIBLE' });
    expect(seen.email).toBe(`${COLLEAGUE}@test.invalid`);
  });

  it('shows an administrator and the person themself every project and task', async () => {
    for (const [viewer, role] of [
      [ADMIN, 'ADMIN'],
      [COLLEAGUE, 'EMPLOYEE'],
    ] as const) {
      const seen = await profile(viewer, role);
      expect(idsOf(seen.projectMembers), viewer).toEqual([PRIVATE_PROJECT, SHARED_PROJECT].sort());
      expect(idsOf(seen.assignedTasks), viewer).toEqual(
        [CO_ASSIGNED_TASK, PRIVATE_TASK, SHARED_TASK].sort()
      );
      expect(seen.workScope, viewer).toEqual({ projects: 'ALL', tasks: 'ALL' });
    }
  });

  it('answers a DENY on team:view in getAll with the viewer’s own row, as getById refuses', async () => {
    const denied = await team(DENIED, 'EMPLOYEE');
    await expect(denied.getAll()).resolves.toEqual([expect.objectContaining({ id: DENIED })]);
    await expect(denied.getById({ id: COLLEAGUE })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Without the denial the directory lists everyone, a colleague's contact redacted.
    const listed = (await (await team(MEMBER, 'EMPLOYEE')).getAll()) as Array<{
      id: string;
      email: string;
    }>;
    expect(listed.map((row) => row.id).sort()).toEqual(
      [ADMIN, COLLEAGUE, DENIED, MEMBER, PEOPLE_OPS].sort()
    );
    expect(listed.find((row) => row.id === COLLEAGUE)).toMatchObject({ email: '' });
  });
});
