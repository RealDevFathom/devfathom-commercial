// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

vi.mock('../activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = `${process.pid}-${Date.now()}`;
const organizationId = `membership-batch-org-${suffix}`;
const projectId = `membership-batch-project-${suffix}`;
const leadIds = [`membership-batch-lead-1-${suffix}`, `membership-batch-lead-2-${suffix}`];
const mutations = ['addMember', 'setMemberRole', 'removeMember'] as const;

describeIfDatabase('project membership mutations in an HTTP batch', () => {
  beforeAll(async () => {
    const { db } = await import('@/lib/db');
    await db.organization.create({
      data: {
        id: organizationId,
        slug: organizationId,
        legalName: 'Batch test',
        displayName: 'Batch test',
      },
    });
    await db.organizationDepartment.create({
      data: { organizationId, key: 'ENGINEERING', name: 'Engineering' },
    });
    await db.user.createMany({
      data: leadIds.map((id) => ({
        id,
        organizationId,
        name: id,
        email: `${id}@example.invalid`,
        department: 'ENGINEERING',
        title: 'Lead',
        role: 'EMPLOYEE' as const,
      })),
    });
    await db.project.create({
      data: { id: projectId, organizationId, name: 'Batch test', type: 'INTERNAL' },
    });
  });

  beforeEach(async () => {
    const { db } = await import('@/lib/db');
    await db.projectMember.deleteMany({ where: { projectId } });
    await db.projectMember.createMany({
      data: leadIds.map((userId) => ({ organizationId, projectId, userId, role: 'LEAD' as const })),
    });
  });

  afterAll(async () => {
    const { db } = await import('@/lib/db');
    await db.organization.deleteMany({ where: { id: organizationId } });
  });

  it.each(
    mutations.flatMap((first) =>
      mutations.flatMap((second) =>
        (['EMPLOYEE', 'ADMIN'] as const).map((actorRole) => [first, second, actorRole] as const)
      )
    )
  )(
    'retains the last lead when %s and %s share a transaction as %s',
    async (first, second, actorRole) => {
      const [{ db }, { withTenantDb }, { router }, { projectsRouter }] = await Promise.all([
        import('@/lib/db'),
        import('@/lib/tenancy/scoped-db'),
        import('@/server/trpc'),
        import('./projects'),
      ]);
      const response = await withTenantDb(organizationId, async (tx) => {
        const req = new Request(
          `http://test.invalid/api/trpc/projects.${first},projects.${second}?batch=1`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // Batch calls can enter the queue out of wire order. Both lead-count
            // and authorization checks must observe the preceding operation.
            body: JSON.stringify({
              0: {
                json: {
                  projectId,
                  userId: leadIds[1],
                  ...(first === 'removeMember' ? {} : { role: 'MEMBER' }),
                },
              },
              1: {
                json: {
                  projectId,
                  userId: leadIds[0],
                  ...(second === 'removeMember' ? {} : { role: 'MEMBER' }),
                },
              },
            }),
          }
        );
        const result = await fetchRequestHandler({
          endpoint: '/api/trpc',
          req,
          router: router({ projects: projectsRouter }),
          createContext: () =>
            ({
              db: tx,
              session: {
                expires: 'later',
                user: {
                  id: leadIds[0],
                  organizationId,
                  role: actorRole,
                  status: 'ACTIVE',
                  department: 'ENGINEERING',
                },
              },
              organization: { id: organizationId },
              support: null,
              entitlements: {
                organizationId,
                enabledModules: ['projects'],
                modules: [],
                limits: {},
              },
              requestMeta: { ip: null, userAgent: null },
              audit: { detail: {} },
            }) as never,
        });
        return { status: result.status, body: await result.json() };
      });

      // The adapter itself serializes procedure errors. Committing here also
      // proves the invariant holds independently of the route's batch rollback.
      expect(response.status).toBe(207);
      expect(response.body.filter((entry: { result?: unknown }) => entry.result)).toHaveLength(1);
      const failure = response.body.find((entry: { error?: unknown }) => entry.error);
      expect(actorRole === 'ADMIN' ? ['BAD_REQUEST'] : ['BAD_REQUEST', 'FORBIDDEN']).toContain(
        failure.error.json.data.code
      );
      expect(await db.projectMember.count({ where: { projectId, role: 'LEAD' } })).toBe(1);
    }
  );
});
