import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('../activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/lib/webhooks', () => ({ emitEvent: vi.fn() }));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(() => ''), templates: {} }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));

import { projectsRouter } from './projects';

const projectCreate = vi.fn();
const userFindMany = vi.fn();
const db = {
  project: { create: projectCreate },
  user: { findMany: userFindMany },
  client: { findMany: vi.fn() },
};

function caller() {
  return projectsRouter.createCaller({
    db,
    session: {
      expires: 'later',
      user: {
        id: 'user_1',
        role: 'EMPLOYEE',
        department: 'ENGINEERING',
        status: 'ACTIVE',
        organizationId: 'org_1',
      },
    },
    organization: { id: 'org_1' },
    entitlements: { organizationId: 'org_1', enabledModules: [], modules: [], limits: {} },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

describe('projects.create atomic default board', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFindMany.mockResolvedValue([{ id: 'user_1' }]);
    projectCreate.mockResolvedValue({ id: 'project_1', name: 'Launch' });
  });

  it('creates the project, board, columns, and labels in one nested database write', async () => {
    await caller().create({ name: 'Launch', type: 'CLIENT', createDefaultBoard: true });

    expect(projectCreate).toHaveBeenCalledOnce();
    expect(projectCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Launch',
        members: { create: [{ userId: 'user_1', role: 'LEAD' }] },
        boards: {
          create: expect.objectContaining({
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
            labels: { create: expect.arrayContaining([expect.objectContaining({ name: 'Bug' })]) },
          }),
        },
      }),
    });
  });

  it('omits the nested board when the caller disables it', async () => {
    await caller().create({ name: 'No board', type: 'INTERNAL', createDefaultBoard: false });

    expect(projectCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ boards: undefined }),
    });
  });
});
