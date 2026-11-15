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
  projectFile: { findFirst: vi.fn() },
  taskAttachment: { findFirst: vi.fn() },
  contract: { findFirst: vi.fn() },
  projectMember: { findUnique: vi.fn() },
  task: { findUnique: vi.fn() },
};
function actor(role = 'EMPLOYEE') {
  return { session: { user: { id: 'user_1', role } }, organization: { id: 'org_a' } };
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
  db.projectFile.findFirst.mockResolvedValue(null);
  db.taskAttachment.findFirst.mockResolvedValue(null);
  db.contract.findFirst.mockResolvedValue(null);
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
    expect(response.headers.get('cache-control')).toBe('private, max-age=3600');
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

    it('keeps the admin exception', async () => {
      mocks.actor.mockResolvedValue(actor('ADMIN'));
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
      expect((await read('pharmacy-sop-proof.png')).status).toBe(200);
      expect(db.pharmacySopSite.findFirst).not.toHaveBeenCalled();
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

  describe('DEV-837: owner bindings are re-checked at download (F15)', () => {
    const T1 = new Date('2026-11-01T10:00:00.000Z');
    const T2 = new Date('2026-11-02T10:00:00.000Z');
    const earliest = (where: Record<string, string>, select: Record<string, true>) => ({
      where,
      orderBy: { createdAt: 'asc' },
      select,
    });

    it('denies a removed project member a saved project file URL and allows members', async () => {
      db.projectFile.findFirst.mockResolvedValue({ projectId: 'project_1', createdAt: T1 });

      const response = await read('plan.pdf');
      expect(response.status).toBe(404);
      expect(mocks.getUpload).not.toHaveBeenCalled();
      expect(db.projectFile.findFirst).toHaveBeenCalledWith(
        earliest({ url: '/api/files/plan.pdf' }, { projectId: true, createdAt: true })
      );
      expect(db.projectMember.findUnique).toHaveBeenCalledWith({
        where: { projectId_userId: { projectId: 'project_1', userId: 'user_1' } },
        select: { role: true },
      });

      db.projectMember.findUnique.mockResolvedValue({ role: 'MEMBER' });
      expect((await read('plan.pdf')).status).toBe(200);

      db.projectMember.findUnique.mockResolvedValue(null);
      mocks.actor.mockResolvedValue(actor('ADMIN'));
      expect((await read('plan.pdf')).status).toBe(200);
    });

    it('resolves a task attachment to its project and denies unresolved bindings', async () => {
      db.taskAttachment.findFirst.mockResolvedValue({ taskId: 'task_1', createdAt: T1 });
      db.task.findUnique.mockResolvedValue({
        column: { board: { projectId: 'project_2' } },
      });
      expect((await read('spec.png')).status).toBe(404);
      expect(mocks.getUpload).not.toHaveBeenCalled();
      expect(db.taskAttachment.findFirst).toHaveBeenCalledWith(
        earliest({ url: '/api/files/spec.png' }, { taskId: true, createdAt: true })
      );

      db.projectMember.findUnique.mockResolvedValue({ role: 'LEAD' });
      expect((await read('spec.png')).status).toBe(200);
      expect(db.projectMember.findUnique).toHaveBeenLastCalledWith({
        where: { projectId_userId: { projectId: 'project_2', userId: 'user_1' } },
        select: { role: true },
      });

      db.task.findUnique.mockResolvedValue(null);
      mocks.getUpload.mockClear();
      expect((await read('spec.png')).status).toBe(404);
      expect(mocks.getUpload).not.toHaveBeenCalled();
    });

    it('denies a demoted administrator a signed contract document', async () => {
      db.contract.findFirst.mockResolvedValue({ id: 'contract_1', createdAt: T1 });
      for (const role of ['EMPLOYEE', 'MANAGER']) {
        mocks.actor.mockResolvedValue(actor(role));
        expect((await read('signed-contract.pdf')).status).toBe(404);
      }
      expect(mocks.getUpload).not.toHaveBeenCalled();
      expect(db.contract.findFirst).toHaveBeenCalledWith(
        earliest({ fileUrl: '/api/files/signed-contract.pdf' }, { id: true, createdAt: true })
      );

      mocks.actor.mockResolvedValue(actor('ADMIN'));
      expect((await read('signed-contract.pdf')).status).toBe(200);
    });

    it('does not let a later project binding widen access to a contract document', async () => {
      // A former admin re-attaches a saved contract URL to a project they lead.
      db.contract.findFirst.mockResolvedValue({ id: 'contract_1', createdAt: T1 });
      db.projectFile.findFirst.mockResolvedValue({ projectId: 'project_mine', createdAt: T2 });
      db.projectMember.findUnique.mockResolvedValue({ role: 'LEAD' });
      expect((await read('signed-contract.pdf')).status).toBe(404);
      expect(mocks.getUpload).not.toHaveBeenCalled();
    });

    it('does not let a later binding to another project restrict the original readers', async () => {
      db.projectFile.findFirst.mockResolvedValue({ projectId: 'project_a', createdAt: T1 });
      db.taskAttachment.findFirst.mockResolvedValue({ taskId: 'task_in_b', createdAt: T2 });
      db.task.findUnique.mockResolvedValue({ column: { board: { projectId: 'project_b' } } });
      db.projectMember.findUnique.mockImplementation(
        async ({ where }: { where: { projectId_userId: { projectId: string } } }) =>
          where.projectId_userId.projectId === 'project_a' ? { role: 'MEMBER' } : null
      );
      // A member of the original project keeps access; project B is never consulted.
      expect((await read('plan.pdf')).status).toBe(200);
      expect(db.task.findUnique).not.toHaveBeenCalled();
    });

    it('leaves a chat or SOP file to its own checks when attached to a project later', async () => {
      db.messageAttachment.findFirst.mockResolvedValue({
        createdAt: T1,
        message: { channelId: 'channel_1' },
      });
      db.channelMember.findUnique.mockResolvedValue({ id: 'member_1' });
      db.projectFile.findFirst.mockResolvedValue({ projectId: 'project_x', createdAt: T2 });
      expect((await read('chat.png')).status).toBe(200);
      expect(db.projectMember.findUnique).not.toHaveBeenCalled();
      expect(db.messageAttachment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'asc' } })
      );

      db.messageAttachment.findFirst.mockResolvedValue(null);
      db.restaurantSopEvidence.findFirst.mockResolvedValue({
        serverCaptured: true,
        createdAt: T1,
        occurrence: { branchId: 'branch_a' },
      });
      db.restaurantBranchAssignment.findUnique.mockResolvedValue({ id: 'assignment_1' });
      expect((await read('sop-proof.jpg')).status).toBe(200);
      expect(db.projectMember.findUnique).not.toHaveBeenCalled();
    });

    it('denies an ambiguous file owned by two kinds of record at the same instant', async () => {
      mocks.actor.mockResolvedValue(actor('ADMIN'));
      db.projectFile.findFirst.mockResolvedValue({ projectId: 'project_1', createdAt: T1 });
      db.contract.findFirst.mockResolvedValue({ id: 'contract_1', createdAt: T1 });
      expect((await read('both.pdf')).status).toBe(404);
      expect(mocks.getUpload).not.toHaveBeenCalled();
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

  it('hides pharmacy licence evidence from non-admin tenant members before storage', async () => {
    db.branchRegulatoryProfile.findFirst.mockResolvedValue({ id: 'profile_1' });

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
    db.branchRegulatoryProfile.findFirst.mockResolvedValue({ id: 'profile_1' });

    expect((await read('licence.pdf')).status).toBe(200);
    expect(mocks.getUpload).toHaveBeenCalledExactlyOnceWith('org_a', 'licence.pdf');
  });

  it('keeps chat membership required even for admins', async () => {
    mocks.actor.mockResolvedValue(actor('ADMIN'));
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
