import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { buildProjectsTools } from './projects';
import type { AssistantHelpers } from '@/lib/ai/context';

type Member = { projectId: string; userId: string; role: string; name: string };
type ToolResult = { error?: string };

function testHarness(
  initialMembers?: Member[],
  actor: { userId: string; name: string; isAdmin: boolean } = {
    userId: 'admin',
    name: 'Admin',
    isAdmin: true,
  }
) {
  const members = initialMembers ?? [
    { projectId: 'project-1', userId: 'lead-a', role: 'LEAD', name: 'Lead A' },
    { projectId: 'project-1', userId: 'lead-b', role: 'LEAD', name: 'Lead B' },
  ];
  const queryRaw = vi.fn();
  const projectMember = {
    findMany: vi.fn(async () =>
      members.map((member) => ({
        userId: member.userId,
        role: member.role,
        user: { name: member.name },
      }))
    ),
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
        create: Omit<Member, 'name'>;
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
        const created = { ...create, name: create.userId };
        members.push(created);
        return created;
      }
    ),
  };

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
    project: { findMany: vi.fn(async () => [{ id: 'project-1', name: 'Project' }]) },
    projectMember,
  };
  const helpers = {
    db,
    now: vi.fn(() => new Date()),
    isAdmin: actor.isAdmin,
    ctx: { userId: actor.userId, name: actor.name },
    canManageProject: vi.fn(async () => true),
    resolvePerson: vi.fn(async (name: string) => {
      const member = members.find((candidate) => candidate.name === name);
      return member
        ? { kind: 'resolved', value: { id: member.userId, name: member.name } }
        : { kind: 'notfound' };
    }),
    resolveNamed: vi.fn((name: string, candidates: { id: string; name: string }[]) => {
      const candidate = candidates.find((item) => item.name === name);
      return candidate ? { kind: 'resolved', value: candidate } : { kind: 'notfound' };
    }),
    activity: vi.fn(),
    audit: vi.fn(),
  } as unknown as AssistantHelpers;
  const tools = buildProjectsTools(helpers) as unknown as Record<
    string,
    { execute: (input: Record<string, unknown>) => Promise<ToolResult> }
  >;

  return { members, queryRaw, tools, transaction };
}

describe('assistant project lead invariant', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serializes concurrent lead removals and preserves the last lead', async () => {
    const { members, queryRaw, tools, transaction } = testHarness();

    const results = await Promise.all([
      tools.removeProjectMember.execute({ project: 'Project', person: 'Lead A' }),
      tools.removeProjectMember.execute({ project: 'Project', person: 'Lead B' }),
    ]);

    expect(results.filter((result) => result.error)).toHaveLength(1);
    expect(members.filter((member) => member.role === 'LEAD')).toHaveLength(1);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent lead demotions and preserves the last lead', async () => {
    const { members, queryRaw, tools } = testHarness();

    const results = await Promise.all([
      tools.setProjectMemberRole.execute({
        project: 'Project',
        person: 'Lead A',
        role: 'MEMBER',
      }),
      tools.setProjectMemberRole.execute({
        project: 'Project',
        person: 'Lead B',
        role: 'MEMBER',
      }),
    ]);

    expect(results.filter((result) => result.error)).toHaveLength(1);
    expect(members.filter((member) => member.role === 'LEAD')).toHaveLength(1);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('rejects demoting the final lead through addProjectMember', async () => {
    const { members, queryRaw, tools } = testHarness([
      { projectId: 'project-1', userId: 'lead-a', role: 'LEAD', name: 'Lead A' },
    ]);

    const result = await tools.addProjectMember.execute({
      project: 'Project',
      person: 'Lead A',
      role: 'MEMBER',
    });

    expect(result.error).toBe('Cannot demote the last lead. Promote another member to lead first.');
    expect(members[0].role).toBe('LEAD');
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  it('denies a waiting role change after the caller is concurrently demoted', async () => {
    const { members, queryRaw, tools } = testHarness(undefined, {
      userId: 'lead-a',
      name: 'Lead A',
      isAdmin: false,
    });

    const [demotion, waitingChange] = await Promise.all([
      tools.setProjectMemberRole.execute({
        project: 'Project',
        person: 'Lead A',
        role: 'MEMBER',
      }),
      tools.setProjectMemberRole.execute({
        project: 'Project',
        person: 'Lead B',
        role: 'MEMBER',
      }),
    ]);

    expect(demotion.error).toBeUndefined();
    expect(waitingChange.error).toBe('Only the project lead or an admin can change roles.');
    expect(members.find((member) => member.userId === 'lead-b')?.role).toBe('LEAD');
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});
