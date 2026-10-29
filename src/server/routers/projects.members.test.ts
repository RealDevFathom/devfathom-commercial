import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('../activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { projectsRouter } from './projects';

type Member = { role: 'LEAD' | 'MEMBER' };
type MemberWhere = { where: { projectId_userId: { userId: string } } };
type MemberUpdate = MemberWhere & { data: Member };
type MemberUpsert = MemberWhere & { create: Member; update: Member };

function projectDb() {
  const members = new Map<string, Member>([
    ['lead-a', { role: 'LEAD' }],
    ['lead-b', { role: 'LEAD' }],
  ]);
  const calls: string[] = [];
  let transactionTail = Promise.resolve();

  const tx = {
    $queryRaw: vi.fn(async () => {
      calls.push('lock');
      return [{ id: 'project-1' }];
    }),
    projectMember: {
      findUnique: vi.fn(async ({ where }: MemberWhere) => {
        calls.push('read');
        return members.get(where.projectId_userId.userId) ?? null;
      }),
      count: vi.fn(async () => {
        calls.push('count');
        return [...members.values()].filter(({ role }) => role === 'LEAD').length;
      }),
      delete: vi.fn(async ({ where }: MemberWhere) => {
        calls.push('delete');
        members.delete(where.projectId_userId.userId);
      }),
      update: vi.fn(async ({ where, data }: MemberUpdate) => {
        calls.push('update');
        const member = members.get(where.projectId_userId.userId);
        if (!member) throw new Error('missing member');
        member.role = data.role;
        return { userId: where.projectId_userId.userId, ...member };
      }),
      upsert: vi.fn(async ({ where, create, update }: MemberUpsert) => {
        calls.push('upsert');
        const userId = where.projectId_userId.userId;
        const member = members.get(userId);
        members.set(userId, { role: member ? update.role : create.role });
        return { userId, ...members.get(userId)! };
      }),
    },
    user: { findMany: vi.fn(async () => [{ id: 'lead-a' }, { id: 'lead-b' }]) },
  };

  const db = {
    ...tx,
    project: { findUnique: vi.fn(async () => ({ name: 'Project' })) },
    user: { findUnique: vi.fn(async () => ({ name: 'Lead' })) },
    $transaction: vi.fn(<T>(callback: (client: typeof tx) => Promise<T>) => {
      // Model the serialization provided in Postgres by the project-row FOR UPDATE.
      const result = transactionTail.then(() => callback(tx));
      transactionTail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    }),
  };

  return { db, members, calls };
}

function caller(db: ReturnType<typeof projectDb>['db'], userId: string) {
  return projectsRouter.createCaller({
    db,
    session: {
      user: { id: userId, organizationId: 'organization-1', role: 'EMPLOYEE', status: 'ACTIVE' },
    },
    entitlements: { enabledModules: ['projects'] },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

describe('project lead invariant', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serializes concurrent lead removals and rejects the last one', async () => {
    const { db, members, calls } = projectDb();

    const results = await Promise.allSettled([
      caller(db, 'lead-a').removeMember({ projectId: 'project-1', userId: 'lead-a' }),
      caller(db, 'lead-b').removeMember({ projectId: 'project-1', userId: 'lead-b' }),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    expect([...members.values()].filter(({ role }) => role === 'LEAD')).toHaveLength(1);
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: { code: 'BAD_REQUEST' },
    });
    expect(calls[0]).toBe('lock');
  });

  it('serializes concurrent lead demotions and rejects the last one', async () => {
    const { db, members, calls } = projectDb();

    const results = await Promise.allSettled([
      caller(db, 'lead-a').setMemberRole({
        projectId: 'project-1',
        userId: 'lead-a',
        role: 'MEMBER',
      }),
      caller(db, 'lead-b').setMemberRole({
        projectId: 'project-1',
        userId: 'lead-b',
        role: 'MEMBER',
      }),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    expect([...members.values()].filter(({ role }) => role === 'LEAD')).toHaveLength(1);
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: { code: 'BAD_REQUEST' },
    });
    expect(calls[0]).toBe('lock');
  });

  it('rejects demoting the last lead through the add-member upsert', async () => {
    const { db, members, calls } = projectDb();
    members.delete('lead-b');

    await expect(
      caller(db, 'lead-a').addMember({
        projectId: 'project-1',
        userId: 'lead-a',
        role: 'MEMBER',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(members.get('lead-a')).toEqual({ role: 'LEAD' });
    expect(calls[0]).toBe('lock');
    expect(calls).not.toContain('upsert');
  });
});
