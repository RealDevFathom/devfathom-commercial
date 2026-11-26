// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { MAX_PRESCRIPTION_FILE_BYTES } from '@/lib/pharmacy/prescription-files';
import { POST } from './route';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  persist: vi.fn(),
  submit: vi.fn(),
  limit: vi.fn(),
}));
vi.mock('@/lib/tenancy/host', () => ({
  requestHost: () => 'tenant.example.test',
  resolveOrganizationForRequest: async () => ({ id: 'org', status: 'ACTIVE' }),
  isTenantLifecycleAccessible: () => true,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: async (_org: string, run: (db: unknown) => Promise<unknown>) =>
    run({ pharmacyCustomer: { findFirst: async () => ({ patientId: 'patient' }) } }),
}));
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: async () => ({}),
  hasModule: () => true,
}));
vi.mock('@/lib/rate-limit', () => ({
  clientIp: () => 'fixture',
  rateLimit: mocks.limit,
}));
vi.mock('@/lib/uploads/large-upload-slot', () => ({ acquireLargeUploadSlot: vi.fn() }));
vi.mock('@/lib/pharmacy/customer-portal', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/customer-portal')>()),
  readPortalSession: mocks.session,
  createPortalRequest: mocks.submit,
}));
vi.mock('@/lib/pharmacy/prescription-files', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/prescription-files')>()),
  persistPrescriptionFile: mocks.persist,
}));

function request(size: number) {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(size)], 'photo.png', { type: 'image/png' }));
  form.set('note', 'test note');
  return new Request('https://tenant.example.test/api/pharmacy/portal/prescription-upload', {
    method: 'POST',
    headers: { host: 'tenant.example.test', origin: 'https://tenant.example.test' },
    body: form,
  });
}

const session = {
  sessionId: 'session',
  customerId: 'customer',
  organizationId: 'org',
  branchId: 'main',
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue(session);
  mocks.limit.mockResolvedValue({ ok: true });
  mocks.persist.mockResolvedValue({ sourceFileRef: '/fixture' });
  mocks.submit.mockResolvedValue({ id: 'request' });
});

it('uses multipart to store the full 5 MB photo through the existing prescription store', async () => {
  const response = await POST(request(5 * 1024 * 1024));
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Security-Policy')).toContain("'nonce-");
  expect(mocks.session).toHaveBeenCalledTimes(2);
  expect(mocks.limit).toHaveBeenCalledWith('pharmacy-portal:request-ip:fixture', 20, 600_000);
  expect(mocks.persist).toHaveBeenCalledExactlyOnceWith('org', 'portal-customer:customer', {
    patientId: 'patient',
    contentType: 'image/png',
    dataBase64: expect.any(String),
  });
  expect(Buffer.from(mocks.persist.mock.calls[0]![2].dataBase64, 'base64').length).toBe(
    5 * 1024 * 1024
  );
  expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(expect.anything(), session, {
    kind: 'RX_ORDER',
    prescriptionFileRef: '/fixture',
    note: 'test note',
  });
});

it('rejects a photo over the upload limit', async () => {
  const response = await POST(request(MAX_PRESCRIPTION_FILE_BYTES + 1));
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({
    ok: false,
    message: 'The photo must be 5 MB or smaller.',
  });
  expect(mocks.persist).not.toHaveBeenCalled();
});

it('refuses a signed-out customer before opening the upload', async () => {
  mocks.session.mockResolvedValueOnce(null);
  const incoming = request(8);
  expect((await POST(incoming)).status).toBe(401);
  expect(incoming.bodyUsed).toBe(false);
  expect(mocks.limit).not.toHaveBeenCalled();
  expect(mocks.persist).not.toHaveBeenCalled();
});

it('does not store a photo if the portal session was revoked while uploading', async () => {
  mocks.session.mockResolvedValueOnce(session).mockResolvedValueOnce(null);
  expect((await POST(request(8))).status).toBe(401);
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(mocks.submit).not.toHaveBeenCalled();
});
