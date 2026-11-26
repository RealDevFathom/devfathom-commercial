// @vitest-environment node
// Actor, scoped database and storage are explicit substitutes; no HTTP or provider access.
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  tenantDb: vi.fn(),
  getUpload: vi.fn(),
  granted: new Set<string>(),
}));
vi.mock('@/lib/abac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/abac')>()),
  can: vi.fn(async (_subject: unknown, action: string) => mocks.granted.has(action)),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.tenantDb }));
vi.mock('@/lib/storage', async (importOriginal) => {
  const { StorageUnavailableError } = await importOriginal<typeof import('@/lib/storage')>();
  return { getUpload: mocks.getUpload, StorageUnavailableError };
});
import { StorageUnavailableError } from '@/lib/storage';
import { GET } from './route';
const db = {
  user: { findUnique: vi.fn() },
  branchRegulatoryProfile: { findFirst: vi.fn() },
  restaurantSopEvidence: { findFirst: vi.fn() },
  restaurantBranchAssignment: { findUnique: vi.fn() },
  messageAttachment: { findFirst: vi.fn() },
  channelMember: { findUnique: vi.fn() },
  pharmacySopSite: { findFirst: vi.fn() },
  pharmacyBranchAssignment: { findFirst: vi.fn() },
  restaurantStaffProfile: { findMany: vi.fn() },
  restaurantStaffJobRole: { findMany: vi.fn() },
  restaurantSopTemplateVersion: { findFirst: vi.fn() },
  uploadedFile: { findFirst: vi.fn() },
  uploadedFileLegacyBinding: { findMany: vi.fn() },
  client: { findFirst: vi.fn() },
  projectFile: { findUnique: vi.fn() },
  taskAttachment: { findUnique: vi.fn() },
  contract: { findUnique: vi.fn() },
  projectMember: { findUnique: vi.fn() },
  task: { findUnique: vi.fn() },
};
function actor(role = 'EMPLOYEE', id = 'user_1') {
  return { session: { user: { id, role } }, organization: { id: 'org_a' } };
}
const read = (name: string) =>
  GET(new Request(`https://example.invalid/api/files/${name}`), {
    params: Promise.resolve({ name }),
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue(actor());
  mocks.tenantDb.mockImplementation(async (_org, fn) => fn(db));
  mocks.getUpload.mockResolvedValue(Buffer.from([1, 2, 3]));
  db.branchRegulatoryProfile.findFirst.mockResolvedValue(null);
  db.restaurantSopEvidence.findFirst.mockResolvedValue(null);
  db.messageAttachment.findFirst.mockResolvedValue(null);
  db.pharmacySopSite.findFirst.mockResolvedValue(null);
  // A registered upload no record has bound yet (DEV-837).
  db.uploadedFile.findFirst.mockResolvedValue({
    ownerType: null,
    ownerId: null,
    uploadedById: 'user_1',
  });
  db.uploadedFileLegacyBinding.findMany.mockResolvedValue([]);
  db.projectFile.findUnique.mockResolvedValue(null);
  db.taskAttachment.findUnique.mockResolvedValue(null);
  db.contract.findUnique.mockResolvedValue(null);
  db.projectMember.findUnique.mockResolvedValue(null);
  db.task.findUnique.mockResolvedValue(null);
  mocks.granted = new Set();
});
describe('private attachment delivery', () => {
  it.each([
    'camera-snapshot-12345678-1234-1234-1234-123456789abc.png',
    'CAMERA-SNAPSHOT-12345678-1234-1234-1234-123456789ABC.PNG',
    'CaMeRa-SnApShOt-fixture.png',
    'camera-ſnapshot-inert.png',
    'CAMERA-ſNAPSHOT-INERT.PNG',
  ])('reserved snapshot %s is refused before database or storage', async (name) => {
    for (const role of ['EMPLOYEE', 'ADMIN']) {
      mocks.actor.mockResolvedValue(actor(role));
      expect((await read(name)).status).toBe(404);
    }
    expect(mocks.tenantDb).not.toHaveBeenCalled();
    expect(mocks.getUpload).not.toHaveBeenCalled();
  });

  it.each([
    'owner-data-export-job-1.zip',
    'owner-data-export-job-1-0123456789abcdef0123456789abcdef.zip',
    'OWNER-DATA-EXPORT-job-1.zip',
    'Owner-Data-Export-job-1.ZIP',
  ])('owner data export %s is never served as a generic file', async (name) => {
    // Only the PIN-gated, audited, expiry-checked export route releases these.
    for (const role of ['EMPLOYEE', 'ADMIN']) {
      mocks.actor.mockResolvedValue(actor(role));
      expect((await read(name)).status).toBe(404);
    }
    expect(mocks.tenantDb).not.toHaveBeenCalled();
    expect(mocks.getUpload).not.toHaveBeenCalled();
  });

  it('keeps session validation ahead of the camera refusal', async () => {
    mocks.actor.mockResolvedValue(null);
    expect((await read('camera-snapshot-fixture.png')).status).toBe(401);
    expect(mocks.tenantDb).not.toHaveBeenCalled();
    expect(mocks.getUpload).not.toHaveBeenCalled();
  });

  it.each(['', '../file.png', 'nested/file.png', 'nested\\file.png'])(
    'rejects unsafe path %s',
    async (name) => {
      expect((await read(name)).status).toBe(400);
      expect(mocks.tenantDb).not.toHaveBeenCalled();
      expect(mocks.getUpload).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['ordinary.PNG', 'image/png'],
    ['document.pdf', 'application/pdf'],
    ['voice.webm', 'audio/webm'],
    ['camera-snapshots-report.txt', 'text/plain'],
    ['ordinary.bin', 'application/octet-stream'],
  ])('fresh ordinary attachment %s preserves bytes, MIME and private cache', async (name, mime) => {
    const response = await read(name);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(mime);
    expect(response.headers.get('content-disposition')).toBe('inline');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(mocks.getUpload).toHaveBeenCalledExactlyOnceWith('org_a', name);
    expect(db.restaurantSopEvidence.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { storageRef: '/api/files/' + name } })
    );
    expect(db.messageAttachment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { url: '/api/files/' + name } })
    );
    expect(mocks.tenantDb.mock.calls.every(([org]) => org === 'org_a')).toBe(true);
  });

  it('keeps the SOP branch membership gate and admin exception', async () => {
    db.restaurantSopEvidence.findFirst.mockResolvedValue({
      serverCaptured: true,
      occurrence: { branchId: 'branch_a' },
    });
    expect((await read('sop.png')).status).toBe(404);
    expect(db.pharmacySopSite.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org_a', sopBranchId: 'branch_a' } })
    );
    expect(mocks.getUpload).not.toHaveBeenCalled();
    expect(db.restaurantBranchAssignment.findUnique).toHaveBeenCalledWith({
      where: { branchId_userId: { branchId: 'branch_a', userId: 'user_1' } },
      select: { id: true },
    });
    db.restaurantBranchAssignment.findUnique.mockResolvedValue({ id: 'assignment_1' });
    expect((await read('sop.png')).status).toBe(200);
    mocks.actor.mockResolvedValue(actor('ADMIN'));
    db.restaurantBranchAssignment.findUnique.mockResolvedValue(null);
    expect((await read('sop.png')).status).toBe(200);
  });

  describe('proof on a pharmacy SOP site', () => {
    const OCCURRENCE = {
      branchId: 'sop_branch_p',
      templateVersionId: 'ver_1',
      assignedStaffProfileId: 'staff_owner',
      claimedByStaffProfileId: null,
    };
    beforeEach(() => {
      db.restaurantSopEvidence.findFirst.mockResolvedValue({
        uploaderStaffProfileId: 'staff_owner',
        occurrence: OCCURRENCE,
      });
      db.pharmacySopSite.findFirst.mockResolvedValue({ pharmacyBranchId: 'pbranch_1' });
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue({ id: 'pba_1' });
      db.restaurantStaffProfile.findMany.mockResolvedValue([{ id: 'staff_verifier' }]);
      db.restaurantStaffJobRole.findMany.mockResolvedValue([
        { jobRole: { key: 'pharmacy-qualified-person' } },
      ]);
      db.restaurantSopTemplateVersion.findFirst.mockResolvedValue({
        template: { name: 'Pharmacy — opening' },
      });
    });

    it('lets an assigned verifier with sop:verify and a verifier role read it', async () => {
      mocks.granted = new Set(['sop:verify']);
      expect((await read('pharmacy-sop-proof.png')).status).toBe(200);
      expect(db.pharmacySopSite.findFirst).toHaveBeenCalledWith({
        where: { organizationId: 'org_a', sopBranchId: 'sop_branch_p' },
        select: { pharmacyBranchId: true },
      });
      expect(db.pharmacyBranchAssignment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            branchId: 'pbranch_1',
            userId: 'user_1',
            active: true,
          }),
        })
      );
      // The restaurant branch rule is not what decides a pharmacy site.
      expect(db.restaurantBranchAssignment.findUnique).not.toHaveBeenCalled();
    });

    it('hides it from someone not assigned to the pharmacy branch, whatever they hold', async () => {
      mocks.granted = new Set(['sop:manage', 'sop:verify', 'sop:complete']);
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
      db.restaurantBranchAssignment.findUnique.mockResolvedValue({ id: 'restaurant_assignment' });
      expect((await read('pharmacy-sop-proof.png')).status).toBe(404);
      expect(mocks.getUpload).not.toHaveBeenCalled();
    });

    it('hides it from an assigned verifier who holds no verifier role for the pack', async () => {
      mocks.granted = new Set(['sop:verify']);
      db.restaurantStaffJobRole.findMany.mockResolvedValue([
        { jobRole: { key: 'pharmacy-assistant' } },
      ]);
      expect((await read('pharmacy-sop-proof.png')).status).toBe(404);
      expect(mocks.getUpload).not.toHaveBeenCalled();
    });

    it('hides it from assigned staff with no SOP capability', async () => {
      db.restaurantStaffProfile.findMany.mockResolvedValue([{ id: 'staff_owner' }]);
      expect((await read('pharmacy-sop-proof.png')).status).toBe(404);
    });

    it('lets the owner with sop:complete and a manager read it', async () => {
      mocks.granted = new Set(['sop:complete']);
      db.restaurantStaffProfile.findMany.mockResolvedValue([{ id: 'staff_owner' }]);
      expect((await read('pharmacy-sop-proof.png')).status).toBe(200);

      mocks.granted = new Set(['sop:complete']);
      db.restaurantStaffProfile.findMany.mockResolvedValue([{ id: 'staff_someone_else' }]);
      expect((await read('pharmacy-sop-proof.png')).status).toBe(404);

      mocks.granted = new Set(['sop:manage']);
      expect((await read('pharmacy-sop-proof.png')).status).toBe(200);
    });

    it('refuses the same evidence link when an administrator loses the branch', async () => {
      mocks.actor.mockResolvedValue(actor('ADMIN'));
      mocks.granted = new Set(['sop:manage']);
      const name = 'pharmacy-sop-proof.png';
      expect((await read(name)).status).toBe(200);
      mocks.getUpload.mockClear();
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
      db.user.findUnique.mockResolvedValue({
        role: 'ADMIN',
        status: 'ACTIVE',
        organizationRole: null,
        permissionOverrides: [],
      });
      expect((await read(name)).status).toBe(404);
      expect(mocks.getUpload).not.toHaveBeenCalled();
    });

    it('allows the installed workspace owner with sop:manage at an unassigned branch', async () => {
      mocks.actor.mockResolvedValue(actor('ADMIN'));
      mocks.granted = new Set(['sop:manage']);
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
      db.user.findUnique.mockResolvedValue({
        role: 'ADMIN',
        status: 'ACTIVE',
        organizationRole: { key: 'owner', isSystem: true, permissions: [] },
        permissionOverrides: [],
      });
      expect((await read('pharmacy-sop-proof.png')).status).toBe(200);
      expect(db.pharmacySopSite.findFirst).toHaveBeenCalledOnce();
    });

    it('refuses an unassigned administrator before storage', async () => {
      mocks.actor.mockResolvedValue(actor('ADMIN'));
      mocks.granted = new Set(['sop:manage']);
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
      expect((await read('pharmacy-sop-proof.png')).status).toBe(404);
      expect(db.pharmacySopSite.findFirst).toHaveBeenCalledExactlyOnceWith({
        where: { organizationId: 'org_a', sopBranchId: 'sop_branch_p' },
        select: { pharmacyBranchId: true },
      });
      expect(mocks.getUpload).not.toHaveBeenCalled();
    });
  });

  describe('DEV-837: SOP proof binding (F17)', () => {
    const LEGACY_CAPTURE = 'sop-12345678-1234-1234-1234-123456789abc.jpg';

    it('ignores a caller-attached SOP reference to an unrelated file', async () => {
      db.restaurantSopEvidence.findFirst.mockResolvedValue({
        serverCaptured: false,
        uploaderStaffProfileId: 'staff_x',
        occurrence: { branchId: 'branch_other' },
      });
      const response = await read('company-logo.png');
      expect(response.status).toBe(200);
      expect(db.restaurantSopEvidence.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { storageRef: '/api/files/company-logo.png' },
          orderBy: [{ serverCaptured: 'desc' }, { createdAt: 'asc' }],
        })
      );
      expect(db.restaurantBranchAssignment.findUnique).not.toHaveBeenCalled();
      expect(db.pharmacySopSite.findFirst).not.toHaveBeenCalled();
    });

    it('keeps the branch gate on proof captured before the provenance flag', async () => {
      db.restaurantSopEvidence.findFirst.mockResolvedValue({
        serverCaptured: false,
        occurrence: { branchId: 'branch_a' },
      });
      expect((await read(LEGACY_CAPTURE)).status).toBe(404);
      expect(mocks.getUpload).not.toHaveBeenCalled();
      db.restaurantBranchAssignment.findUnique.mockResolvedValue({ id: 'assignment_1' });
      expect((await read(LEGACY_CAPTURE)).status).toBe(200);
    });

    it('denies a capture-named blob that no evidence row binds, even to admins', async () => {
      mocks.actor.mockResolvedValue(actor('ADMIN'));
      expect((await read(LEGACY_CAPTURE)).status).toBe(404);
      expect((await read('pharmacy-sop-orphan.png')).status).toBe(404);
      expect(mocks.getUpload).not.toHaveBeenCalled();
    });
  });

  describe('DEV-837: server-recorded upload ownership at download (F15)', () => {
    const bound = (ownerType: string, ownerId: string) =>
      db.uploadedFile.findFirst.mockResolvedValue({ ownerType, ownerId, uploadedById: 'user_1' });

    it('serves an unattached upload to its uploader and hides it from another member', async () => {
      expect((await read('plan.pdf')).status).toBe(200);
      expect(db.uploadedFile.findFirst).toHaveBeenCalledWith({
        where: { name: 'plan.pdf' },
        select: { ownerType: true, ownerId: true, uploadedById: true },
      });
      mocks.getUpload.mockClear();
      mocks.actor.mockResolvedValue(actor('EMPLOYEE', 'user_2'));
      expect((await read('plan.pdf')).status).toBe(404);
      expect(mocks.getUpload).not.toHaveBeenCalled();
    });

    it('denies a registration with neither an owner nor a known uploader', async () => {
      db.uploadedFile.findFirst.mockResolvedValue({
        ownerType: null,
        ownerId: null,
        uploadedById: null,
      });
      mocks.actor.mockResolvedValue(actor('ADMIN'));
      expect((await read('orphan.pdf')).status).toBe(404);
      expect(mocks.getUpload).not.toHaveBeenCalled();
    });

    it('denies an object the registry does not know, even to admins', async () => {
      db.uploadedFile.findFirst.mockResolvedValue(null);
      for (const role of ['EMPLOYEE', 'ADMIN']) {
        mocks.actor.mockResolvedValue(actor(role));
        expect((await read('legacy-orphan.pdf')).status).toBe(404);
      }
      expect(mocks.getUpload).not.toHaveBeenCalled();
    });

    it('denies a removed project member a saved project file URL and allows members', async () => {
      bound('PROJECT_FILE', 'pf_1');
      db.projectFile.findUnique.mockResolvedValue({ projectId: 'project_1' });

      expect((await read('plan.pdf')).status).toBe(404);
      expect(mocks.getUpload).not.toHaveBeenCalled();
      expect(db.projectFile.findUnique).toHaveBeenCalledWith({
        where: { id: 'pf_1' },
        select: { projectId: true },
      });
      expect(db.projectMember.findUnique).toHaveBeenCalledWith({
        where: { projectId_userId: { projectId: 'project_1', userId: 'user_1' } },
        select: { role: true },
      });

      mocks.actor.mockResolvedValue(actor('EMPLOYEE', 'user_2'));
      db.projectMember.findUnique.mockResolvedValue({ role: 'MEMBER' });
      expect((await read('plan.pdf')).status).toBe(200);

      db.projectMember.findUnique.mockResolvedValue(null);
      mocks.actor.mockResolvedValue(actor('ADMIN'));
      expect((await read('plan.pdf')).status).toBe(200);
    });

    it('resolves a task attachment to its project and denies a removed member', async () => {
      bound('TASK_ATTACHMENT', 'ta_1');
      db.taskAttachment.findUnique.mockResolvedValue({ taskId: 'task_1' });
      db.task.findUnique.mockResolvedValue({ column: { board: { projectId: 'project_2' } } });
      expect((await read('spec.png')).status).toBe(404);
      expect(mocks.getUpload).not.toHaveBeenCalled();

      db.projectMember.findUnique.mockResolvedValue({ role: 'LEAD' });
      expect((await read('spec.png')).status).toBe(200);
      expect(db.projectMember.findUnique).toHaveBeenLastCalledWith({
        where: { projectId_userId: { projectId: 'project_2', userId: 'user_1' } },
        select: { role: true },
      });
    });

    it('denies a demoted administrator a signed contract document', async () => {
      bound('CONTRACT', 'contract_1');
      db.contract.findUnique.mockResolvedValue({ id: 'contract_1' });
      for (const role of ['EMPLOYEE', 'MANAGER']) {
        mocks.actor.mockResolvedValue(actor(role));
        expect((await read('signed-contract.pdf')).status).toBe(404);
      }
      expect(mocks.getUpload).not.toHaveBeenCalled();

      mocks.actor.mockResolvedValue(actor('ADMIN'));
      expect((await read('signed-contract.pdf')).status).toBe(200);
    });

    it.each([
      ['project file', 'PROJECT_FILE', 'projectFile'],
      ['task attachment', 'TASK_ATTACHMENT', 'taskAttachment'],
      ['contract', 'CONTRACT', 'contract'],
    ] as const)(
      'keeps denying after the owning %s is deleted, even to admins',
      async (_label, ownerType, model) => {
        bound(ownerType, 'deleted_owner');
        db[model].findUnique.mockResolvedValue(null);
        db.projectMember.findUnique.mockResolvedValue({ role: 'LEAD' });
        for (const role of ['EMPLOYEE', 'ADMIN']) {
          mocks.actor.mockResolvedValue(actor(role));
          expect((await read('was-attached.pdf')).status).toBe(404);
        }
        expect(mocks.getUpload).not.toHaveBeenCalled();
      }
    );

    describe('a file several records shared before the registry (grandfathered)', () => {
      beforeEach(() => {
        bound('PROJECT_FILE', 'pf_1');
        db.projectFile.findUnique.mockResolvedValue({ projectId: 'project_1' });
        db.uploadedFileLegacyBinding.findMany.mockResolvedValue([
          { ownerType: 'PROJECT_FILE', ownerId: 'pf_1' },
          { ownerType: 'TASK_ATTACHMENT', ownerId: 'ta_1' },
        ]);
        db.taskAttachment.findUnique.mockResolvedValue({ taskId: 'task_1' });
        db.task.findUnique.mockResolvedValue({ column: { board: { projectId: 'project_2' } } });
      });
      const memberOf = (projects: string[]) =>
        db.projectMember.findUnique.mockImplementation(
          async ({ where }: { where: { projectId_userId: { projectId: string } } }) =>
            projects.includes(where.projectId_userId.projectId) ? { role: 'MEMBER' } : null
        );

      it("keeps it readable for the other record's members", async () => {
        memberOf(['project_2']);
        expect((await read('shared.pdf')).status).toBe(200);
        expect(db.uploadedFileLegacyBinding.findMany).toHaveBeenCalledWith({
          where: { name: 'shared.pdf' },
          select: { ownerType: true, ownerId: true },
        });
      });

      it("keeps it readable for the primary record's members", async () => {
        memberOf(['project_1']);
        expect((await read('shared.pdf')).status).toBe(200);
      });

      it('denies someone who can read none of its records', async () => {
        memberOf(['project_9']);
        expect((await read('shared.pdf')).status).toBe(404);
        expect(mocks.getUpload).not.toHaveBeenCalled();
      });

      it('denies once every record it was shared by is deleted', async () => {
        memberOf(['project_1', 'project_2']);
        db.projectFile.findUnique.mockResolvedValue(null);
        db.taskAttachment.findUnique.mockResolvedValue(null);
        expect((await read('shared.pdf')).status).toBe(404);
      });
    });

    it('denies an object bound to an owner kind it does not know', async () => {
      mocks.actor.mockResolvedValue(actor('ADMIN'));
      bound('SOMETHING_ELSE', 'x');
      expect((await read('odd.pdf')).status).toBe(404);
    });

    it('lets the binding alone decide: other rows naming the URL are not consulted', async () => {
      bound('PROJECT_FILE', 'pf_1');
      db.projectFile.findUnique.mockResolvedValue({ projectId: 'project_1' });
      db.projectMember.findUnique.mockResolvedValue({ role: 'MEMBER' });
      expect((await read('plan.pdf')).status).toBe(200);
      expect(db.contract.findUnique).not.toHaveBeenCalled();
      expect(db.taskAttachment.findUnique).not.toHaveBeenCalled();
    });

    it('leaves SOP proof to its own rules and never to the registry', async () => {
      db.restaurantSopEvidence.findFirst.mockResolvedValue({
        serverCaptured: true,
        occurrence: { branchId: 'branch_a' },
      });
      db.restaurantBranchAssignment.findUnique.mockResolvedValue({ id: 'assignment_1' });
      db.uploadedFile.findFirst.mockResolvedValue(null);
      expect((await read('sop-proof.jpg')).status).toBe(200);
      expect(db.uploadedFile.findFirst).not.toHaveBeenCalled();
    });

    it.each([
      'restaurant-menu-import__cm0import1.pdf',
      'owner-data-export-cm0job1.zip',
      'Restaurant-Menu-Import__cm0import1.PNG',
    ])('never serves server-only blob %s, even to admins', async (name) => {
      for (const role of ['EMPLOYEE', 'ADMIN']) {
        mocks.actor.mockResolvedValue(actor(role));
        expect((await read(name)).status).toBe(404);
      }
      expect(mocks.tenantDb).not.toHaveBeenCalled();
      expect(mocks.getUpload).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['CLIENT_LOGO', 'logo.png'],
    ['CHAT_ATTACHMENT', 'chat.png'],
    ['PHARMACY_LICENCE_EVIDENCE', 'licence.pdf'],
    ['PHARMACY_COVERAGE_ROSTER', 'roster.pdf'],
  ])('enforces the live %s policy on a legacy upload', async (ownerType, name) => {
    db.uploadedFile.findFirst.mockResolvedValue({
      ownerType,
      ownerId: 'record',
      uploadedById: null,
    });
    const ref = '/api/files/' + name;
    const profileField =
      ownerType === 'PHARMACY_LICENCE_EVIDENCE'
        ? 'licenceEvidenceFileRef'
        : 'qualifiedPersonCoverageRosterRef';
    db.branchRegulatoryProfile.findFirst.mockImplementation(async ({ where }) =>
      where[profileField] === ref && (!where.branchId || where.branchId === 'record')
        ? { branchId: 'record' }
        : null
    );
    db.messageAttachment.findFirst.mockImplementation(async ({ where }) =>
      ownerType === 'CHAT_ATTACHMENT' &&
      where.url === ref &&
      (!where.id || (where.id === 'record' && where.message.deletedAt === null))
        ? { message: { channelId: 'channel' } }
        : null
    );
    db.client.findFirst.mockResolvedValue(null);
    expect((await read(name)).status).toBe(404);
    expect(mocks.getUpload).not.toHaveBeenCalled();
    db.client.findFirst.mockImplementation(async ({ where }) =>
      where.id === 'record' && where.logo === ref ? { id: 'record' } : null
    );
    db.channelMember.findUnique.mockResolvedValue({ id: 'member' });
    db.pharmacyBranchAssignment.findFirst.mockResolvedValue({ id: 'assignment' });
    if (ownerType === 'PHARMACY_LICENCE_EVIDENCE') {
      expect((await read(name)).status).toBe(404);
      mocks.granted.add('pharmacy:manage');
    }
    expect((await read(name)).status).toBe(200);
    if (ownerType === 'CLIENT_LOGO') expect((await read('logo.pdf')).status).toBe(404);
    if (ownerType === 'CHAT_ATTACHMENT') {
      db.messageAttachment.findFirst.mockResolvedValue(null);
      expect((await read(name)).status).toBe(404);
    }
    mocks.actor.mockResolvedValue({ ...actor(), organization: { id: 'org_b' } });
    mocks.tenantDb.mockImplementation(async (org, callback) =>
      callback(
        org === 'org_a'
          ? db
          : {
              ...db,
              branchRegulatoryProfile: { findFirst: async () => null },
              uploadedFile: { findFirst: async () => null },
              restaurantSopEvidence: { findFirst: async () => null },
            }
      )
    );
    mocks.getUpload.mockClear();
    expect((await read(name)).status).toBe(404);
    expect(mocks.getUpload).not.toHaveBeenCalled();
  });

  it('honours a live grandfathered chat binding when the primary logo was replaced', async () => {
    db.uploadedFile.findFirst.mockResolvedValue({
      ownerType: 'CLIENT_LOGO',
      ownerId: 'client',
      uploadedById: null,
    });
    db.client.findFirst.mockResolvedValue(null);
    db.uploadedFileLegacyBinding.findMany.mockResolvedValue([
      { ownerType: 'CHAT_ATTACHMENT', ownerId: 'attachment' },
    ]);
    db.messageAttachment.findFirst.mockImplementation(async ({ where }) =>
      where.id === 'attachment' &&
      where.url === '/api/files/shared.png' &&
      where.message.deletedAt === null
        ? { message: { channelId: 'channel' } }
        : null
    );
    expect((await read('shared.png')).status).toBe(404);
    db.channelMember.findUnique.mockResolvedValue({ id: 'member' });
    expect((await read('shared.png')).status).toBe(200);
  });

  it('requires both channel membership and licence evidence access on a shared file', async () => {
    db.uploadedFile.findFirst.mockResolvedValue({
      ownerType: 'CHAT_ATTACHMENT',
      ownerId: 'attachment',
      uploadedById: null,
    });
    db.branchRegulatoryProfile.findFirst.mockResolvedValue({ id: 'profile' });
    db.messageAttachment.findFirst.mockResolvedValue({ message: { channelId: 'private' } });
    db.channelMember.findUnique.mockResolvedValue({ id: 'member' });
    expect((await read('shared.pdf')).status).toBe(404);
    expect(mocks.getUpload).not.toHaveBeenCalled();
    mocks.actor.mockResolvedValue(actor('ADMIN'));
    db.uploadedFile.findFirst.mockResolvedValue({
      ownerType: 'PHARMACY_LICENCE_EVIDENCE',
      ownerId: 'branch',
      uploadedById: null,
    });
    db.channelMember.findUnique.mockResolvedValue(null);
    expect((await read('shared.pdf')).status).toBe(404);
    expect(mocks.getUpload).not.toHaveBeenCalled();
  });

  it('hides pharmacy licence evidence from non-admin tenant members before storage', async () => {
    db.uploadedFile.findFirst.mockResolvedValue({
      ownerType: 'PHARMACY_LICENCE_EVIDENCE',
      ownerId: 'branch_a',
      uploadedById: null,
    });
    db.branchRegulatoryProfile.findFirst.mockResolvedValue({ branchId: 'branch_a' });

    const response = await read('licence.pdf');

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
    expect(db.branchRegulatoryProfile.findFirst).toHaveBeenCalledWith({
      where: { licenceEvidenceFileRef: '/api/files/licence.pdf' },
      select: { id: true },
    });
    expect(mocks.tenantDb).toHaveBeenCalledWith('org_a', expect.any(Function));
    expect(db.restaurantSopEvidence.findFirst).not.toHaveBeenCalled();
    expect(db.messageAttachment.findFirst).not.toHaveBeenCalled();
    expect(mocks.getUpload).not.toHaveBeenCalled();
  });

  it('allows admins to read pharmacy licence evidence', async () => {
    mocks.actor.mockResolvedValue(actor('ADMIN'));
    db.uploadedFile.findFirst.mockResolvedValue({
      ownerType: 'PHARMACY_LICENCE_EVIDENCE',
      ownerId: 'branch_a',
      uploadedById: null,
    });
    db.branchRegulatoryProfile.findFirst.mockResolvedValue({ branchId: 'branch_a' });

    expect((await read('licence.pdf')).status).toBe(200);
    expect(mocks.getUpload).toHaveBeenCalledExactlyOnceWith('org_a', 'licence.pdf');
  });

  it('keeps chat membership required even for admins', async () => {
    mocks.actor.mockResolvedValue(actor('ADMIN'));
    db.uploadedFile.findFirst.mockResolvedValue({
      ownerType: 'CHAT_ATTACHMENT',
      ownerId: 'attachment_1',
      uploadedById: null,
    });
    db.messageAttachment.findFirst.mockResolvedValue({ message: { channelId: 'private_1' } });
    expect((await read('chat.png')).status).toBe(404);
    expect(mocks.getUpload).not.toHaveBeenCalled();
    expect(db.channelMember.findUnique).toHaveBeenCalledWith({
      where: { channelId_userId: { channelId: 'private_1', userId: 'user_1' } },
      select: { id: true },
    });
    db.channelMember.findUnique.mockResolvedValue({ id: 'member_1' });
    expect((await read('chat.png')).status).toBe(200);
  });

  it.each(['disabled', 'invalid_configuration'] as const)(
    'preserves accepted %s storage 503 without leaking provider details',
    async (reason) => {
      mocks.getUpload.mockRejectedValueOnce(new StorageUnavailableError(reason));
      const response = await read('ordinary.png');
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('Files are unavailable.');
      expect(mocks.getUpload).toHaveBeenCalledExactlyOnceWith('org_a', 'ordinary.png');
    }
  );

  it('retains storage 404 behavior and database error propagation', async () => {
    mocks.getUpload.mockRejectedValueOnce(new Error('storage unavailable'));
    expect((await read('ordinary.png')).status).toBe(404);
    const error = new Error('database unavailable');
    db.restaurantSopEvidence.findFirst.mockRejectedValueOnce(error);
    await expect(read('ordinary.png')).rejects.toBe(error);
  });
});
