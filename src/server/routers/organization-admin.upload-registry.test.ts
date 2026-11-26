/** DEV-837 — the upload registry report is admin-only, read-only and tenant-scoped. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ can: vi.fn(), queryRaw: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(() => ({})),
  withPlatformDb: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  assertSeatAvailable: vi.fn(),
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

import type { TRPCContext } from '../trpc';
import { organizationAdminRouter } from './organization-admin';

const db = { $queryRaw: mocks.queryRaw };

function caller(role = 'ADMIN') {
  return organizationAdminRouter.createCaller({
    db,
    entitlements: { enabledModules: [], activeSeats: 1, seatLimit: 50 },
    session: {
      expires: 'later',
      user: { id: 'user_a', organizationId: 'org_a', role, status: 'ACTIVE' },
    },
    organization: { id: 'org_a' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.queryRaw
    .mockResolvedValueOnce([{ recordType: 'PROJECT_FILE', count: 2 }])
    .mockResolvedValueOnce([{ recordType: 'CLIENT_LOGO', count: 1 }])
    .mockResolvedValueOnce([
      { count: 2, oldest: new Date(0), newest: new Date(10), withoutUploader: 1 },
    ]);
});

describe('organizationAdmin.uploadRegistryReport', () => {
  it('reports tombstoned files and unregistered references by record type', async () => {
    await expect(caller().uploadRegistryReport()).resolves.toEqual({
      tombstoned: [{ recordType: 'PROJECT_FILE', count: 2 }],
      unregisteredReferences: [{ recordType: 'CLIENT_LOGO', count: 1 }],
      unattached: { count: 2, oldest: new Date(0), newest: new Date(10), withoutUploader: 1 },
      note: expect.stringContaining('nothing is deleted from storage'),
    });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(3);
    const sql = mocks.queryRaw.mock.calls
      .map(([query]) => (query as { strings: string[] }).strings.join('?'))
      .join('\n');
    // Read-only: the report never writes or deletes anything.
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i);
    expect(sql).toContain('"uploaded_file_legacy_bindings"');
  });

  it('refuses anyone without the admin capability before reading', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller('EMPLOYEE').uploadRegistryReport()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});
