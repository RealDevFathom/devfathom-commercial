import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  platform: vi.fn(),
  tenant: vi.fn(),
  load: vi.fn(),
  preview: vi.fn(),
  seed: vi.fn(),
}));
vi.mock('@/lib/platform/auth', () => ({ requirePlatformSession: mocks.session }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: mocks.platform,
  withTenantDb: mocks.tenant,
}));
vi.mock('@/lib/pharmacy/catalog/preload', () => ({
  loadBundledPharmacyCatalog: mocks.load,
  catalogSeedPreview: mocks.preview,
  seedPharmacyCatalog: mocks.seed,
}));

import { PLATFORM_RULE_SOURCES } from '@/lib/pharmacy/catalog/platform-authz';
import { backfillPharmacyCatalogAction } from './catalog-backfill';

function identity(role: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    id: 'platform-user-1',
    name: 'Platform user',
    email: 'platform@example.test',
    role,
    expiresAt: new Date(Date.now() + 60_000),
    mfaEnabled: true,
    ...extra,
  };
}

function expectNoDatabaseAccess() {
  expect(mocks.platform).not.toHaveBeenCalled();
  expect(mocks.tenant).not.toHaveBeenCalled();
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.preview).not.toHaveBeenCalled();
  expect(mocks.seed).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mocks.platform.mockImplementation(async (run) =>
    run({
      organization: { findMany: vi.fn().mockResolvedValue([{ id: 'org_a' }]) },
      platformAuditLog: { create: vi.fn() },
    })
  );
  mocks.tenant.mockImplementation((_id, run) => run({}));
  mocks.load.mockResolvedValue({ version: 'pharmacy-catalog-v1', count: 0, items: [] });
  mocks.preview.mockResolvedValue({ wouldCreate: 0, existing: 0, total: 0 });
});

describe('backfillPharmacyCatalogAction (CAT-SEC-02)', () => {
  it.each(['OPERATIONS', 'SUPPORT', 'AUDITOR'])(
    'denies %s through the central decision before parsing input or touching the database',
    async (role) => {
      mocks.session.mockResolvedValue(identity(role));
      // Malformed on purpose: authorization must come first, so this is 403, not a parse error.
      await expect(backfillPharmacyCatalogAction({ organizationId: 42 })).rejects.toMatchObject({
        status: 403,
      });
      expectNoDatabaseAccess();
    }
  );

  it('denies a SuperAdmin session that still has to enrol MFA before touching the database', async () => {
    mocks.session.mockResolvedValue(identity('SUPER_ADMIN', { enrollmentOnly: true }));
    await expect(
      backfillPharmacyCatalogAction({ organizationId: 'org_a', apply: true })
    ).rejects.toMatchObject({ status: 403 });
    expectNoDatabaseAccess();
  });

  it('denies a SuperAdmin with an explicit DENY over the role ALLOW (mixed grant) before touching the database', async () => {
    mocks.session.mockResolvedValue(identity('SUPER_ADMIN'));
    vi.spyOn(PLATFORM_RULE_SOURCES, 'actorRules').mockReturnValue([
      { capability: 'pharmacy:catalog-backfill', effect: 'DENY' },
    ]);
    await expect(
      backfillPharmacyCatalogAction({ organizationId: 'org_a', apply: true })
    ).rejects.toMatchObject({ status: 403 });
    expect(PLATFORM_RULE_SOURCES.actorRules).toHaveBeenCalledWith('platform-user-1');
    expectNoDatabaseAccess();
  });

  it('lets an authorized SuperAdmin through to the (dry-run) service', async () => {
    mocks.session.mockResolvedValue(identity('SUPER_ADMIN'));
    await expect(
      backfillPharmacyCatalogAction({ organizationId: 'org_a', apply: false })
    ).resolves.toMatchObject({ dryRun: true });
    expect(mocks.platform).toHaveBeenCalledTimes(1);
    expect(mocks.seed).not.toHaveBeenCalled();
  });
});
