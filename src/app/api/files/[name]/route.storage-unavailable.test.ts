// @vitest-environment node
import { beforeEach, expect, test, vi } from 'vitest';
const m = vi.hoisted(() => ({
  actor: vi.fn(),
  licence: vi.fn(),
  sop: vi.fn(),
  branch: vi.fn(),
  attachment: vi.fn(),
  member: vi.fn(),
  site: vi.fn(),
  get: vi.fn(),
  tenant: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: m.actor }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: m.tenant }));
vi.mock('@/lib/storage', async (original) => ({
  ...(await original<typeof import('@/lib/storage')>()),
  getUpload: m.get,
}));
import { StorageUnavailableError } from '@/lib/storage';
import { GET } from './route';
const read = (name = 'proof.png') =>
  GET(new Request('https://example.test/api/files/' + name), { params: Promise.resolve({ name }) });
beforeEach(() => {
  vi.resetAllMocks();
  m.actor.mockResolvedValue({
    organization: { id: 'org-a' },
    session: { user: { id: 'user-a', role: 'STAFF' } },
  });
  m.tenant.mockImplementation(async (_org, callback) =>
    callback({
      branchRegulatoryProfile: { findFirst: m.licence },
      restaurantSopEvidence: { findFirst: m.sop },
      restaurantBranchAssignment: { findUnique: m.branch },
      pharmacySopSite: { findFirst: m.site },
      messageAttachment: { findFirst: m.attachment },
      channelMember: { findUnique: m.member },
    })
  );
  m.get.mockRejectedValue(new StorageUnavailableError('disabled'));
});
test('authorized file read returns truthful 503 scoped to tenant', async () => {
  const response = await read();
  expect(response.status).toBe(503);
  expect(await response.text()).toBe('Files are unavailable.');
  expect(m.get).toHaveBeenCalledWith('org-a', 'proof.png');
  expect(m.tenant.mock.calls.every((call) => call[0] === 'org-a')).toBe(true);
});
test('anonymous and traversal requests never reach storage', async () => {
  m.actor.mockResolvedValueOnce(null);
  expect((await read()).status).toBe(401);
  expect((await read('../file.png')).status).toBe(400);
  expect(m.get).not.toHaveBeenCalled();
});
test('SOP branch denial hides resource even when storage is disabled', async () => {
  m.sop.mockResolvedValue({ occurrence: { branchId: 'branch-a' } });
  expect((await read()).status).toBe(404);
  expect(m.get).not.toHaveBeenCalled();
});
test('licence evidence denial hides resource even when storage is disabled', async () => {
  m.licence.mockResolvedValue({ id: 'regulatory-profile' });
  expect((await read('licence.pdf')).status).toBe(404);
  expect(m.get).not.toHaveBeenCalled();
});
test('chat membership denial hides resource even when storage is disabled', async () => {
  m.attachment.mockResolvedValue({ message: { channelId: 'private-channel' } });
  expect((await read()).status).toBe(404);
  expect(m.get).not.toHaveBeenCalled();
});
test('authorized branch and channel member gets unavailable response', async () => {
  m.sop.mockResolvedValue({ occurrence: { branchId: 'branch-a' } });
  m.branch.mockResolvedValue({ id: 'assignment' });
  m.attachment.mockResolvedValue({ message: { channelId: 'channel' } });
  m.member.mockResolvedValue({ id: 'member' });
  expect((await read()).status).toBe(503);
});
test('configured read keeps private response and missing files remain hidden', async () => {
  m.get.mockResolvedValueOnce(Buffer.from('proof'));
  const response = await read();
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('proof');
  expect(response.headers.get('cache-control')).toBe('private, max-age=3600');
  m.get.mockRejectedValueOnce(new Error('fake missing blob'));
  expect((await read()).status).toBe(404);
});
