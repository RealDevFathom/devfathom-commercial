import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createTRPCContext: vi.fn(),
  resolveTenantActor: vi.fn(),
  readArchive: vi.fn(),
  verifyPin: vi.fn(),
  recordAudit: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/trpc')>()),
  createTRPCContext: mocks.createTRPCContext,
}));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: mocks.recordAudit,
}));
vi.mock('@/lib/pharmacy/data-export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/data-export')>()),
  readPharmacyDataExportArchive: mocks.readArchive,
}));
vi.mock('@/lib/pharmacy/data-export-pin', () => ({ verifyOwnerExportPin: mocks.verifyPin }));
vi.mock('@/server/routers/_app', async () => {
  const { router } = await import('@/server/trpc');
  const { pharmacyDataExportRouter } = await import('@/server/routers/pharmacy-data-export');
  return { appRouter: router({ pharmacyDataExport: pharmacyDataExportRouter }) };
});

import { POST } from './route';

function fixture() {
  const currentUser = {
    id: 'owner-1',
    organizationId: 'org-a',
    status: 'ACTIVE',
    role: 'ADMIN',
    organizationRole: {
      organizationId: 'org-a',
      key: 'owner',
      isSystem: true,
      permissions: [] as { organizationId: string; capability: string; effect: string }[],
    },
    permissionOverrides: [],
  };
  const context = {
    db: { user: { findFirst: vi.fn(async () => currentUser) } },
    session: { user: { id: 'owner-1', organizationId: 'org-a', status: 'ACTIVE', role: 'ADMIN' } },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-core'] },
    support: null,
    audit: { detail: {} },
    requestMeta: { ip: null, userAgent: null },
  };
  mocks.createTRPCContext.mockResolvedValue(context);
  mocks.resolveTenantActor.mockResolvedValue(context);
  return { currentUser, context };
}

function request() {
  return new Request('https://pharmacy.example/api/pharmacy/data-export', {
    method: 'POST',
    headers: {
      origin: 'https://pharmacy.example',
      host: 'pharmacy.example',
      'x-forwarded-proto': 'https',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ id: 'exp-1', pin: '2468' }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyPin.mockResolvedValue('OK');
  mocks.readArchive.mockResolvedValue({ data: Buffer.from('PK-archive'), fileName: 'export.zip' });
});

describe('HTTP download through the live owner router guard', () => {
  it('streams for the current owner, then rejects the same session after ownership transfer', async () => {
    const f = fixture();
    const allowed = await POST(request());
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe('PK-archive');
    expect(allowed.headers.get('Cache-Control')).toBe('private, no-store');
    f.currentUser.organizationRole.key = 'manager';
    const denied = await POST(request());
    expect(denied.status).toBe(403);
    expect(await denied.text()).toBe('Owner access is required.');
    expect(f.context.db.user.findFirst).toHaveBeenCalledTimes(2);
    expect(mocks.verifyPin).toHaveBeenCalledTimes(1);
    expect(mocks.readArchive).toHaveBeenCalledTimes(1);
    expect(mocks.recordAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: 'pharmacyDataExport.download',
        outcome: 'FAILURE',
      })
    );
  });

  it.each(['ordinary admin', 'other tenant', 'explicit DENY'])(
    'returns 403 for %s without checking PIN or reading an archive',
    async (scenario) => {
      const f = fixture();
      if (scenario === 'ordinary admin') f.currentUser.organizationRole.key = 'admin';
      if (scenario === 'other tenant') f.context.session.user.organizationId = 'org-b';
      if (scenario === 'explicit DENY') {
        f.currentUser.organizationRole.permissions.push({
          organizationId: 'org-a',
          capability: '*',
          effect: 'DENY',
        });
      }
      const response = await POST(request());
      expect(response.status).toBe(403);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(mocks.verifyPin).not.toHaveBeenCalled();
      expect(mocks.readArchive).not.toHaveBeenCalled();
    }
  );
});
