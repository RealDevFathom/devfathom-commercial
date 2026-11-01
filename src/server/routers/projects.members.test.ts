import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('../authz', () => ({
  assertProjectAccess: vi.fn(),
  assertBoardAccess: vi.fn(),
  assertColumnAccess: vi.fn(),
  assertTaskAccess: vi.fn(),
}));
vi.mock('../activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/lib/webhooks', () => ({ emitEvent: vi.fn() }));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(() => ''), templates: {} }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));

import { projectsRouter } from './projects';

type Member = { projectId: string; userId: string; role: string };

function testHarness(initialMembers?: Member[]) {
  const members: Member[] = initialMembers ?? [
    { projectId: 'project-1', userId: 'lead-a', role: 'LEAD' },
    { projectId: 'project-1', userId: 'lead-b', role: 'LEAD' },
  ];
  const queryRaw = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => [
    { pg_advisory_xact_lock: null },
  ]);
  const projectMember = {
    findUnique: vi.fn(async ({ where }: { where: { projectId_userId: Member } }) => {
      const key = where.projectId_userId;
      return members.find(
        (member) => member.projectId === key.projectId && member.userId === key.userId
      );
    }),
    count: vi.fn(
      async ({ where }: { where: { projectId: string; role: string } }) =>
        members.filter(
          (member) => member.projectId === where.projectId && member.role === where.role
        ).length
    ),
    delete: vi.fn(async ({ where }: { where: { projectId_userId: Member } }) => {
      const key = where.projectId_userId;
      const index = members.findIndex(
        (member) => member.projectId === key.projectId && member.userId === key.userId
      );
      return members.splice(index, 1)[0];
    }),
    update: vi.fn(
      async ({ where, data }: { where: { projectId_userId: Member }; data: { role: string } }) => {
        const key = where.projectId_userId;
        const member = members.find(
          (candidate) => candidate.projectId === key.projectId && candidate.userId === key.userId
        )!;
        member.role = data.role;
        return member;
      }
    ),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { projectId_userId: Member };
        create: Member;
        update: { role: string };
      }) => {
        const key = where.projectId_userId;
        const member = members.find(
          (candidate) => candidate.projectId === key.projectId && candidate.userId === key.userId
        );
        if (member) {
          member.role = update.role;
          return member;
        }
        members.push(create);
        return create;
      }
    ),
  };

  // Model independent transactions; only the advisory lock serializes their callbacks.
  let lockTail = Promise.resolve();
  const transaction = vi.fn(async <T>(callback: (client: never) => Promise<T>) => {
    let releaseLock: (() => void) | undefined;
    const tx = {
      projectMember,
      $queryRaw: async (...args: unknown[]) => {
        queryRaw(...args);
        const previousLock = lockTail;
        lockTail = new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
        await previousLock;
        return [{ pg_advisory_xact_lock: null }];
      },
    };
    try {
      return await callback(tx as never);
    } finally {
      releaseLock?.();
    }
  });
  const db = {
    $transaction: transaction,
    project: { findUnique: vi.fn(async () => ({ name: 'Project' })) },
    user: {
      findUnique: vi.fn(async () => ({ name: 'User' })),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
    },
  };
  const caller = projectsRouter.createCaller({
    db,
    session: {
      user: { id: 'admin', role: 'ADMIN', status: 'ACTIVE', organizationId: 'organization-1' },
    },
    entitlements: { enabledModules: ['projects'] },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);

  return { caller, members, queryRaw, transaction };
}

describe('project lead invariant', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serializes concurrent lead removals and preserves the last lead', async () => {
    const { caller, members, queryRaw, transaction } = testHarness();

    const results = await Promise.allSettled([
      caller.removeMember({ projectId: 'project-1', userId: 'lead-a' }),
      caller.removeMember({ projectId: 'project-1', userId: 'lead-b' }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(members.filter((member) => member.role === 'LEAD')).toHaveLength(1);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent lead demotions and preserves the last lead', async () => {
    const { caller, members, queryRaw, transaction } = testHarness();

    const results = await Promise.allSettled([
      caller.setMemberRole({ projectId: 'project-1', userId: 'lead-a', role: 'MEMBER' }),
      caller.setMemberRole({ projectId: 'project-1', userId: 'lead-b', role: 'MEMBER' }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(members.filter((member) => member.role === 'LEAD')).toHaveLength(1);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('rejects demoting the last lead through addMember', async () => {
    const { caller, members, queryRaw } = testHarness([
      { projectId: 'project-1', userId: 'lead-a', role: 'LEAD' },
    ]);

    await expect(
      caller.addMember({ projectId: 'project-1', userId: 'lead-a', role: 'MEMBER' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(members).toEqual([{ projectId: 'project-1', userId: 'lead-a', role: 'LEAD' }]);
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  it('serializes removal with addMember demotion and preserves the last lead', async () => {
    const { caller, members, queryRaw, transaction } = testHarness();

    const results = await Promise.allSettled([
      caller.removeMember({ projectId: 'project-1', userId: 'lead-a' }),
      caller.addMember({ projectId: 'project-1', userId: 'lead-b', role: 'MEMBER' }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(members.filter((member) => member.role === 'LEAD')).toHaveLength(1);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});
