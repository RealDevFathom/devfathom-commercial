import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('../activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/lib/webhooks', () => ({ emitEvent: vi.fn() }));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(() => ''), templates: {} }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));

import { projectsRouter } from './projects';

const committedProjects: Array<{ id: string; name: string }> = [];
const projectCreate = vi.fn(async ({ data }: { data: { name: string } }) => ({
  id: 'project-1',
  name: data.name,
}));
const boardCreate = vi.fn(async () => ({}));

const db = {
  user: { findMany: vi.fn(async () => [{ id: 'user-1' }]) },
  client: { findMany: vi.fn(async () => []) },
  $transaction: vi.fn(
    async (run: (tx: { project: typeof dbProject; board: typeof dbBoard }) => Promise<unknown>) => {
      const pendingProjects: Array<{ id: string; name: string }> = [];
      const transactionProject = {
        create: vi.fn(async (args: { data: { name: string } }) => {
          const project = await projectCreate(args);
          pendingProjects.push(project);
          return project;
        }),
      };
      const result = await run({ project: transactionProject, board: dbBoard });
      committedProjects.push(...pendingProjects);
      return result;
    }
  ),
};
const dbProject = { create: projectCreate };
const dbBoard = { create: boardCreate };

function caller() {
  return projectsRouter.createCaller({
    db,
    session: {
      user: { id: 'user-1', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1' },
    entitlements: { enabledModules: ['projects'] },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

describe('projects.create atomicity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    committedProjects.length = 0;
  });

  it('rolls back the project when default board creation fails', async () => {
    boardCreate.mockRejectedValueOnce(new Error('board write failed'));

    await expect(caller().create({ name: 'Atomic project', type: 'INTERNAL' })).rejects.toThrow(
      'board write failed'
    );

    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(projectCreate).toHaveBeenCalledOnce();
    expect(boardCreate).toHaveBeenCalledOnce();
    expect(committedProjects).toEqual([]);
  });

  it('preserves project creation without a default board', async () => {
    await expect(
      caller().create({
        name: 'Boardless project',
        type: 'INTERNAL',
        createDefaultBoard: false,
      })
    ).resolves.toMatchObject({ id: 'project-1', name: 'Boardless project' });

    expect(boardCreate).not.toHaveBeenCalled();
    expect(committedProjects).toEqual([{ id: 'project-1', name: 'Boardless project' }]);
  });
});
