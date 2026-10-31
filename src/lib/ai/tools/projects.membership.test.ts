import { describe, expect, it, vi } from 'vitest';
import { buildProjectsTools } from './projects';

describe('assistant project membership mutations', () => {
  it('does not demote the sole lead through addProjectMember', async () => {
    const upsert = vi.fn();
    const db = {
      $queryRaw: vi.fn(async () => [{ id: 'project_1' }]),
      $transaction: vi.fn(async (callback: (tx: never) => Promise<unknown>) =>
        callback(db as never)
      ),
      project: {
        findMany: vi.fn(async () => [{ id: 'project_1', name: 'Apollo' }]),
      },
      projectMember: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ userId: 'lead_1', role: 'LEAD' })
          .mockResolvedValueOnce({ userId: 'lead_1', role: 'LEAD' }),
        count: vi.fn(async () => 1),
        upsert,
      },
    };
    const tools = buildProjectsTools({
      db,
      ctx: { organizationId: 'org_1', userId: 'lead_1', name: 'Lead' },
      isAdmin: false,
      now: () => new Date(),
      resolveNamed: (_name: string, rows: unknown[]) => ({ kind: 'resolved', value: rows[0] }),
      resolvePerson: vi.fn(async () => ({
        kind: 'resolved',
        value: { id: 'lead_1', name: 'Lead' },
      })),
      activity: vi.fn(),
      audit: vi.fn(),
    } as never);

    await expect(
      tools.addProjectMember.execute!(
        { project: 'Apollo', person: 'Lead', role: 'MEMBER' },
        { toolCallId: 'test', messages: [] }
      )
    ).resolves.toEqual({ error: 'Cannot demote the last lead. Promote another member first.' });
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('demotes a lead through addProjectMember when another lead remains', async () => {
    const upsert = vi.fn(async () => ({
      projectId: 'project_1',
      userId: 'lead_1',
      role: 'MEMBER',
    }));
    const db = {
      $queryRaw: vi.fn(async () => [{ id: 'project_1' }]),
      $transaction: vi.fn(async (callback: (tx: never) => Promise<unknown>) =>
        callback(db as never)
      ),
      project: {
        findMany: vi.fn(async () => [{ id: 'project_1', name: 'Apollo' }]),
      },
      projectMember: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ userId: 'lead_1', role: 'LEAD' })
          .mockResolvedValueOnce({ userId: 'lead_1', role: 'LEAD' }),
        count: vi.fn(async () => 2),
        upsert,
      },
    };
    const activity = vi.fn();
    const tools = buildProjectsTools({
      db,
      ctx: { organizationId: 'org_1', userId: 'lead_1', name: 'Lead' },
      isAdmin: false,
      now: () => new Date(),
      resolveNamed: (_name: string, rows: unknown[]) => ({ kind: 'resolved', value: rows[0] }),
      resolvePerson: vi.fn(async () => ({
        kind: 'resolved',
        value: { id: 'lead_1', name: 'Lead' },
      })),
      activity,
      audit: vi.fn(),
    } as never);

    await expect(
      tools.addProjectMember.execute!(
        { project: 'Apollo', person: 'Lead', role: 'MEMBER' },
        { toolCallId: 'test', messages: [] }
      )
    ).resolves.toEqual({
      added: 'Lead',
      to: 'Apollo',
      role: 'MEMBER',
      scopeNote: undefined,
    });
    expect(upsert).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId: 'project_1', userId: 'lead_1' } },
      create: {
        projectId: 'project_1',
        userId: 'lead_1',
        organizationId: 'org_1',
        role: 'MEMBER',
      },
      update: { role: 'MEMBER' },
    });
    expect(activity).toHaveBeenCalledOnce();
  });
});
