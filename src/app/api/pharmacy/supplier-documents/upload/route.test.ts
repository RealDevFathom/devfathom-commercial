// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import {
  SUPPLIER_DOCUMENT_MAX_BYTES,
  SUPPLIER_DOCUMENT_TOKEN_HEADER,
  SUPPLIER_DOCUMENT_UPLOAD_URL,
} from '@/lib/pharmacy/supplier-document-contract';
import { SupplierLinkError } from '@/lib/pharmacy/supplier-action-links';
import { POST } from './route';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  permission: vi.fn(),
  scope: vi.fn(),
  slot: vi.fn(),
  release: vi.fn(),
  store: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.scope }));
vi.mock('@/lib/uploads/large-upload-slot', () => ({ acquireLargeUploadSlot: mocks.slot }));
vi.mock('@/lib/pharmacy/supplier-action-links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/supplier-action-links')>()),
  assertSupplierDocumentPermission: mocks.permission,
  uploadSupplierDocument: mocks.store,
}));

const origin = 'https://tenant.example.test';
const token = 'synthetic-supplier-token';
const db = {};
function upload(part: File | string) {
  const form = new FormData();
  form.set('file', part);
  form.set('idempotencyKey', 'retry-key');
  return new Request(origin + SUPPLIER_DOCUMENT_UPLOAD_URL, {
    method: 'POST',
    headers: { origin, [SUPPLIER_DOCUMENT_TOKEN_HEADER]: token },
    body: form,
  });
}

function pdf(size: number) {
  const bytes = new Uint8Array(size);
  if (size >= 5) bytes.set(new TextEncoder().encode('%PDF-'));
  return new File([bytes], 'evidence.pdf', { type: 'application/pdf' });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue({
    organization: { id: 'org' },
    session: { user: { id: 'supplier-user' } },
  });
  mocks.scope.mockImplementation(async (_organizationId, run) => run(db));
  mocks.slot.mockResolvedValue(mocks.release);
});

it('uploads a full 10 MB document through the per-user and per-business slot', async () => {
  const response = await POST(upload(pdf(10 * 1024 * 1024)));
  expect(response.status).toBe(204);
  expect(response.headers.get('Content-Security-Policy')).toContain("'nonce-");
  expect(mocks.permission).toHaveBeenCalledExactlyOnceWith(db, token);
  expect(mocks.slot).toHaveBeenCalledExactlyOnceWith('supplier-user', 'org');
  expect(mocks.store).toHaveBeenCalledExactlyOnceWith(db, {
    token,
    idempotencyKey: 'retry-key',
    fileName: 'evidence.pdf',
    declaredMimeType: 'application/pdf',
    content: expect.any(Buffer),
  });
  expect(mocks.store.mock.calls[0]![1].content.length).toBe(10 * 1024 * 1024);
  expect(mocks.permission.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.slot.mock.invocationCallOrder[0]!
  );
  expect(mocks.store.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.release.mock.invocationCallOrder[0]!
  );
});

it('rejects a file one byte over 10 MB with a plain size message', async () => {
  const response = await POST(upload(pdf(SUPPLIER_DOCUMENT_MAX_BYTES + 1)));
  expect(response.status).toBe(413);
  expect(response.headers.get('Content-Type')).toMatch(/^text\/plain\b/);
  expect(await response.text()).toBe('Choose a file of 10 MB or smaller.');
  expect(mocks.store).not.toHaveBeenCalled();
  expect(mocks.release).toHaveBeenCalledOnce();
});

it('rejects an oversized multipart declaration without reading the body', async () => {
  const request = upload(pdf(8));
  request.headers.set('content-length', String(11 * 1024 * 1024));
  const response = await POST(request);
  expect(response.status).toBe(413);
  expect(request.bodyUsed).toBe(false);
  expect(mocks.slot).not.toHaveBeenCalled();
  expect(mocks.store).not.toHaveBeenCalled();
});

it.each([
  ['missing session', 401, () => mocks.actor.mockResolvedValueOnce(null)],
  [
    'invalid supplier permission',
    404,
    () => mocks.permission.mockRejectedValueOnce(new SupplierLinkError('INVALID_LINK')),
  ],
] as const)('rejects %s without reading the body', async (_reason, status, reject) => {
  reject();
  const request = upload(pdf(8));
  const response = await POST(request);
  expect(response.status).toBe(status);
  expect(request.bodyUsed).toBe(false);
  expect(mocks.slot).not.toHaveBeenCalled();
  expect(mocks.store).not.toHaveBeenCalled();
});

it.each([
  new File(['text'], 'evidence.txt', { type: 'text/plain' }),
  new File([], 'evidence.pdf', { type: 'application/pdf' }),
  'not a file',
])('rejects unsupported or empty multipart entries before writing', async (entry) => {
  expect((await POST(upload(entry))).status).toBe(400);
  expect(mocks.store).not.toHaveBeenCalled();
});
