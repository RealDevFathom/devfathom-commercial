/** DEV-837 — a Trello import can never point an attachment at a workspace upload. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { trelloImportRouter } from './trello-import';

const db = {
  project: { create: vi.fn(async () => ({ id: 'project_new' })) },
  projectMember: { findMany: vi.fn(async () => []), findUnique: vi.fn() },
  board: { findUnique: vi.fn(async () => null) },
  $transaction: vi.fn(),
};

function caller() {
  return trelloImportRouter.createCaller({
    db,
    session: {
      expires: 'later',
      user: { id: 'user_1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org_1' },
    },
    organization: { id: 'org_1' },
    entitlements: { organizationId: 'org_1', enabledModules: [], modules: [], limits: {} },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

function exportWith(url: string) {
  return {
    name: 'Board',
    lists: [{ id: 'list_1', name: 'Todo', closed: false, pos: 1 }],
    cards: [
      {
        id: 'card_1',
        name: 'Card',
        desc: '',
        idList: 'list_1',
        closed: false,
        pos: 1,
        idLabels: [],
        idMembers: [],
        attachments: [{ name: 'file', url }],
      },
    ],
  };
}

beforeEach(() => vi.clearAllMocks());

describe('trelloImport.importBoard attachment links', () => {
  it.each([
    '/api/files/someone-else.pdf',
    'https://app.example.com/api/files/someone-else.pdf',
    '/api/files/../x.pdf',
  ])('refuses an export linking %s before writing anything', async (url) => {
    await expect(
      caller().importBoard({
        trelloJson: exportWith(url),
        newProjectName: 'Imported',
        memberMapping: {},
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.project.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('lets an ordinary external attachment link through the check', async () => {
    await caller()
      .importBoard({
        trelloJson: exportWith('https://trello.com/1/cards/abc/attachments/file.pdf'),
        newProjectName: 'Imported',
        memberMapping: {},
      })
      .catch(() => undefined);
    // Past the attachment check: the import went on to create the project.
    expect(db.project.create).toHaveBeenCalledOnce();
  });
});
