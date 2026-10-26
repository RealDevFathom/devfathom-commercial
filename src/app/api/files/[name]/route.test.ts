// @vitest-environment node
// Actor, scoped database and storage are explicit substitutes; no HTTP or provider access.
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ actor: vi.fn(), tenantDb: vi.fn(), getUpload: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.tenantDb }));
vi.mock('@/lib/storage', async (importOriginal) => {
  const { StorageUnavailableError } = await importOriginal<typeof import('@/lib/storage')>();
  return { getUpload: mocks.getUpload, StorageUnavailableError };
});
import { StorageUnavailableError } from '@/lib/storage';
import { GET } from './route';
const db = {
  restaurantSopEvidence: { findFirst: vi.fn() },
  restaurantBranchAssignment: { findUnique: vi.fn() },
  branchRegulatoryProfile: { findFirst: vi.fn() },
  messageAttachment: { findFirst: vi.fn() },
  channelMember: { findUnique: vi.fn() },
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
  db.restaurantSopEvidence.findFirst.mockResolvedValue(null);
  db.branchRegulatoryProfile.findFirst.mockResolvedValue(null);
  db.messageAttachment.findFirst.mockResolvedValue(null);
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
    expect(db.branchRegulatoryProfile.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        licenceEvidenceFileRef: '/api/files/' + name,
      },
      select: { id: true },
    });
    expect(mocks.tenantDb.mock.calls.every(([org]) => org === 'org_a')).toBe(true);
  });

  it.each(['EMPLOYEE', 'HR'])('hides licence evidence from the %s role', async (role) => {
    db.branchRegulatoryProfile.findFirst.mockResolvedValue({ id: 'profile_1' });
    mocks.actor.mockResolvedValue(actor(role));

    expect((await read('pharmacy-licence.pdf')).status).toBe(404);
    expect(db.branchRegulatoryProfile.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: {
        organizationId: 'org_a',
        licenceEvidenceFileRef: '/api/files/pharmacy-licence.pdf',
      },
      select: { id: true },
    });
    expect(mocks.tenantDb).toHaveBeenCalledExactlyOnceWith('org_a', expect.any(Function));
    expect(mocks.getUpload).not.toHaveBeenCalled();
    expect(db.messageAttachment.findFirst).not.toHaveBeenCalled();
  });

  it('allows admins to read licence evidence', async () => {
    db.branchRegulatoryProfile.findFirst.mockResolvedValue({ id: 'profile_1' });

    mocks.actor.mockResolvedValue(actor('ADMIN'));
    expect((await read('pharmacy-licence.pdf')).status).toBe(200);
    expect(db.branchRegulatoryProfile.findFirst).not.toHaveBeenCalled();
    expect(mocks.getUpload).toHaveBeenCalledExactlyOnceWith('org_a', 'pharmacy-licence.pdf');
  });

  it('does not apply another tenant\'s licence evidence restriction', async () => {
    db.branchRegulatoryProfile.findFirst.mockImplementation(async ({ where }) =>
      where.organizationId === 'org_b' ? { id: 'foreign_profile' } : null
    );

    expect((await read('shared-name.pdf')).status).toBe(200);
    expect(db.branchRegulatoryProfile.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: {
        organizationId: 'org_a',
        licenceEvidenceFileRef: '/api/files/shared-name.pdf',
      },
      select: { id: true },
    });
    expect(mocks.getUpload).toHaveBeenCalledExactlyOnceWith('org_a', 'shared-name.pdf');
  });

  it('keeps the SOP branch membership gate and admin exception', async () => {
    db.restaurantSopEvidence.findFirst.mockResolvedValue({ occurrence: { branchId: 'branch_a' } });
    expect((await read('sop.png')).status).toBe(404);
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

  it.each(['disabled', 'invalid_configuration'] as const)('preserves accepted %s storage 503 without leaking provider details', async (reason) => {
    mocks.getUpload.mockRejectedValueOnce(new StorageUnavailableError(reason));
    const response = await read('ordinary.png');
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Files are unavailable.');
    expect(mocks.getUpload).toHaveBeenCalledExactlyOnceWith('org_a', 'ordinary.png');
  });

  it('retains storage 404 behavior and database error propagation', async () => {
    mocks.getUpload.mockRejectedValueOnce(new Error('storage unavailable'));
    expect((await read('ordinary.png')).status).toBe(404);
    const error = new Error('database unavailable');
    db.restaurantSopEvidence.findFirst.mockRejectedValueOnce(error);
    await expect(read('ordinary.png')).rejects.toBe(error);
  });
});
