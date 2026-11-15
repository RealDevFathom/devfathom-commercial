/**
 * DEV-837 (security scan F15/F17) — a client-supplied file URL can never bind
 * or re-bind someone else's upload. Attaching another file's URL to a project,
 * task or contract is refused, nothing is bound, and the file's readers are
 * unchanged; the caller's own unattached upload binds to the new record.
 */
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
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});
vi.mock('../activity', () => ({ logActivity: vi.fn() }));

import { clientsRouter } from './clients';
import { projectsRouter } from './projects';

const OWN = { id: 'upl_own', uploadedById: 'user_1', ownerType: null, ownerId: null };
const FOREIGN = { id: 'upl_foreign', uploadedById: 'user_victim', ownerType: null, ownerId: null };
const BOUND_ELSEWHERE = {
  id: 'upl_bound',
  uploadedById: 'user_1',
  ownerType: 'PROJECT_FILE',
  ownerId: 'pf_original',
};

function makeDb() {
  const db = {
    uploadedFile: { findFirst: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    projectMember: { findUnique: vi.fn(async () => ({ role: 'MEMBER' })) },
    task: { findUnique: vi.fn(async () => ({ column: { board: { projectId: 'project_1' } } })) },
    projectFile: { create: vi.fn(async ({ data }) => ({ id: 'pf_new', ...data })) },
    taskAttachment: { create: vi.fn(async ({ data }) => ({ id: 'ta_new', ...data })) },
    client: { findMany: vi.fn(async () => [{ id: 'client_1' }]) },
    project: { findMany: vi.fn(async () => []) },
    contract: {
      create: vi.fn(async ({ data }) => ({ id: 'contract_new', title: 'MSA', ...data })),
      update: vi.fn(async ({ where, data }) => ({ id: where.id, title: 'MSA', ...data })),
      findUnique: vi.fn(async () => null),
    },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  return db;
}

let db: ReturnType<typeof makeDb>;

function context(role: string) {
  return {
    db,
    session: {
      expires: 'later',
      user: {
        id: 'user_1',
        role,
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
  } as never;
}

const attach = {
  addFile: (url: string) =>
    projectsRouter
      .createCaller(context('EMPLOYEE'))
      .addFile({ projectId: 'project_1', name: 'plan.pdf', url }),
  addTaskAttachment: (url: string) =>
    projectsRouter
      .createCaller(context('EMPLOYEE'))
      .addTaskAttachment({ taskId: 'task_1', name: 'spec.png', url }),
  addContract: (url: string) =>
    clientsRouter
      .createCaller(context('ADMIN'))
      .addContract({ clientId: 'client_1', title: 'MSA', fileUrl: url }),
  updateContract: (url: string) =>
    clientsRouter.createCaller(context('ADMIN')).updateContract({ id: 'contract_1', fileUrl: url }),
};
const OWNERS = {
  addFile: { ownerType: 'PROJECT_FILE', ownerId: 'pf_new' },
  addTaskAttachment: { ownerType: 'TASK_ATTACHMENT', ownerId: 'ta_new' },
  addContract: { ownerType: 'CONTRACT', ownerId: 'contract_new' },
  updateContract: { ownerType: 'CONTRACT', ownerId: 'contract_1' },
} as const;

beforeEach(() => {
  db = makeDb();
});

describe.each(Object.keys(attach) as Array<keyof typeof attach>)('%s', (procedure) => {
  it.each([
    ["another member's unattached upload (a logo, a brand image)", FOREIGN],
    ['a file already bound to another record', BOUND_ELSEWHERE],
    ['an object the registry does not know', null],
  ])('refuses %s and binds nothing', async (_label, row) => {
    db.uploadedFile.findFirst.mockResolvedValue(row);
    await expect(attach[procedure]('/api/files/someone-else.png')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Upload this file again to attach it here.',
    });
    expect(db.uploadedFile.updateMany).not.toHaveBeenCalled();
    // The claim runs inside the owner row's transaction, so the refusal
    // rolls the new row back.
    expect(db.$transaction).toHaveBeenCalledOnce();
  });

  it("binds the caller's own unattached upload to the record", async () => {
    db.uploadedFile.findFirst.mockResolvedValue(OWN);
    await expect(attach[procedure]('/api/files/u1-mine.pdf')).resolves.toBeTruthy();
    expect(db.uploadedFile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { name: 'u1-mine.pdf' } })
    );
    expect(db.uploadedFile.updateMany).toHaveBeenCalledWith({
      where: { id: 'upl_own', ownerType: null },
      data: { ...OWNERS[procedure], boundAt: expect.any(Date) },
    });
  });
});

it('updateContract re-saves the document already bound to the same contract', async () => {
  db.uploadedFile.findFirst.mockResolvedValue({
    id: 'upl_doc',
    uploadedById: 'another_admin',
    ownerType: 'CONTRACT',
    ownerId: 'contract_1',
  });
  await expect(attach.updateContract('/api/files/signed.pdf')).resolves.toMatchObject({
    id: 'contract_1',
  });
  expect(db.uploadedFile.updateMany).not.toHaveBeenCalled();
});
