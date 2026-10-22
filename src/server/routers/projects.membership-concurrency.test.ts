import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: ['projects'] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('../activity', () => ({ logActivity: vi.fn() }));

import type { Prisma } from '@/generated/prisma/client';
import type { TRPCContext } from '../trpc';
import { projectsRouter } from './projects';

type Member = { projectId: string; userId: string; role: string };

function makeDb() {
  const members: Member[] = [
    { projectId: 'project_a', userId: 'lead_a', role: 'LEAD' },
    { projectId: 'project_a', userId: 'lead_b', role: 'LEAD' },
  ];
  const lockKeys: string[] = [];
  let lockTail = Promise.resolve();

  const projectMember = {
    findUnique: vi.fn(
      async ({ where }: { where: { projectId_userId: { projectId: string; userId: string } } }) =>
        members.find(
          (member) =>
            member.projectId === where.projectId_userId.projectId &&
            member.userId === where.projectId_userId.userId
        ) ?? null
    ),
    count: vi.fn(
      async ({ where }: { where: { projectId: string; role: string } }) =>
        members.filter(
          (member) => member.projectId === where.projectId && member.role === where.role
        ).length
    ),
    delete: vi.fn(
      async ({ where }: { where: { projectId_userId: { projectId: string; userId: string } } }) => {
        const index = members.findIndex(
          (member) =>
            member.projectId === where.projectId_userId.projectId &&
            member.userId === where.projectId_userId.userId
        );
        return members.splice(index, 1)[0];
      }
    ),
    update: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { projectId_userId: { projectId: string; userId: string } };
        data: { role: string };
      }) => {
        const member = members.find(
          (candidate) =>
            candidate.projectId === where.projectId_userId.projectId &&
            candidate.userId === where.projectId_userId.userId
        )!;
        member.role = data.role;
        return member;
      }
    ),
  };

  const db = {
    projectMember,
    project: { findUnique: vi.fn(async () => ({ name: 'Concurrent project' })) },
    user: { findUnique: vi.fn(async () => ({ name: 'Lead' })) },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
      let release!: () => void;
      const previous = lockTail;
      lockTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tx = {
        projectMember,
        $queryRaw: vi.fn(async (query: Prisma.Sql) => {
          lockKeys.push(String(query.values[0]));
          await previous;
        }),
      };
      try {
        return await run(tx);
      } finally {
        release();
      }
    }),
  };

  return { db, members, lockKeys };
}

let state = makeDb();

function caller() {
  return projectsRouter.createCaller({
    db: state.db,
    entitlements: {
      enabledModules: ['projects'],
      activeSeats: 1,
      seatLimit: 5,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: {
        id: 'admin',
        organizationId: 'org_a',
        role: 'ADMIN',
        department: 'OPERATIONS',
        status: 'ACTIVE',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  state = makeDb();
});

describe('project lead concurrency', () => {
  it('serializes concurrent lead removals and rejects the second last-lead removal', async () => {
    const results = await Promise.allSettled([
      caller().removeMember({ projectId: 'project_a', userId: 'lead_a' }),
      caller().removeMember({ projectId: 'project_a', userId: 'lead_b' }),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(state.members.filter(({ role }) => role === 'LEAD')).toHaveLength(1);
    expect(state.lockKeys).toEqual([
      'org_a:project-members:project_a',
      'org_a:project-members:project_a',
    ]);
  });

  it('serializes concurrent lead demotions and rejects the second last-lead demotion', async () => {
    const results = await Promise.allSettled([
      caller().setMemberRole({ projectId: 'project_a', userId: 'lead_a', role: 'MEMBER' }),
      caller().setMemberRole({ projectId: 'project_a', userId: 'lead_b', role: 'MEMBER' }),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(state.members.filter(({ role }) => role === 'LEAD')).toHaveLength(1);
    expect(state.projectMember.update).toHaveBeenCalledTimes(1);
  });
});
