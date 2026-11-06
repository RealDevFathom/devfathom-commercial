import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('../activity', () => ({ logActivity: vi.fn() }));

import { projectsRouter } from './projects';

const projectCreate = vi.fn();
const boardCreate = vi.fn();
const db = {
  user: {
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id) => ({ id }))
    ),
  },
  client: {
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id) => ({ id }))
    ),
  },
  project: { create: projectCreate },
  board: { create: boardCreate },
};

const caller = () =>
  projectsRouter.createCaller({
    db,
    session: {
      expires: 'later',
      user: {
        id: 'owner_1',
        role: 'ADMIN',
        status: 'ACTIVE',
        organizationId: 'org_1',
      },
    },
    organization: { id: 'org_1' },
    entitlements: {
      organizationId: 'org_1',
      enabledModules: ['projects'],
      modules: [],
      limits: {},
    },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  projectCreate.mockResolvedValue({ id: 'project_1', name: 'Launch' });
});

describe('projects.create', () => {
  it('creates the project, membership, default board, columns, and labels atomically', async () => {
    await caller().create({
      name: 'Launch',
      type: 'CLIENT',
      memberIds: ['member_1'],
      createDefaultBoard: true,
    });

    expect(projectCreate).toHaveBeenCalledOnce();
    expect(projectCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Launch',
        members: {
          create: [
            { userId: 'owner_1', role: 'LEAD' },
            { userId: 'member_1', role: 'MEMBER' },
          ],
        },
        boards: {
          create: {
            name: 'Launch Board',
            columns: {
              create: [
                { name: 'Backlog', order: 0 },
                { name: 'To Do', order: 1 },
                { name: 'In Progress', order: 2 },
                { name: 'Review', order: 3 },
                { name: 'Done', order: 4 },
              ],
            },
            labels: {
              create: [
                { name: 'Bug', color: '#EF4444' },
                { name: 'Feature', color: '#2563EB' },
                { name: 'Enhancement', color: '#0EA5E9' },
                { name: 'Design', color: '#F59E0B' },
                { name: 'Urgent', color: '#DC2626' },
              ],
            },
          },
        },
      }),
    });
    expect(boardCreate).not.toHaveBeenCalled();
  });

  it('does not leave a project for a retry when nested board creation fails', async () => {
    projectCreate.mockRejectedValueOnce(new Error('board write failed'));

    await expect(
      caller().create({ name: 'Launch', type: 'CLIENT', createDefaultBoard: true })
    ).rejects.toThrow('board write failed');

    expect(projectCreate).toHaveBeenCalledOnce();
    expect(boardCreate).not.toHaveBeenCalled();
  });

  it('still supports creating a project without a default board', async () => {
    await caller().create({ name: 'Launch', type: 'INTERNAL', createDefaultBoard: false });

    expect(projectCreate.mock.calls[0]?.[0].data).not.toHaveProperty('boards');
  });
});
