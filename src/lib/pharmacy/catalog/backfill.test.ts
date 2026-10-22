import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  platform: vi.fn(),
  tenant: vi.fn(),
  load: vi.fn(),
  preview: vi.fn(),
  seed: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: mocks.platform,
  withTenantDb: mocks.tenant,
}));
vi.mock('./preload', () => ({
  loadBundledPharmacyCatalog: mocks.load,
  catalogSeedPreview: mocks.preview,
  seedPharmacyCatalog: mocks.seed,
}));
import { backfillPharmacyCatalog } from './backfill';
import { PLATFORM_RULE_SOURCES } from './platform-authz';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue({ version: 'pharmacy-catalog-v1', count: 2, items: [] });
  mocks.preview.mockResolvedValue({ wouldCreate: 2, existing: 0, total: 2 });
  mocks.platform.mockImplementation(async (run) =>
    run({
      organization: { findMany: vi.fn().mockResolvedValue([{ id: 'org_a' }]) },
      platformAuditLog: { create: vi.fn() },
    })
  );
  mocks.tenant.mockImplementation((_id, run) => run({}));
});

function expectNoDatabaseAccess() {
  expect(mocks.platform).not.toHaveBeenCalled();
  expect(mocks.tenant).not.toHaveBeenCalled();
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.seed).not.toHaveBeenCalled();
}

describe('catalogue backfill', () => {
  it('rejects every non-SuperAdmin before database access', async () => {
    await expect(
      backfillPharmacyCatalog({ id: 'actor', role: 'OPERATIONS' }, { allPharmacy: true }, false)
    ).rejects.toMatchObject({ status: 403 });
    expectNoDatabaseAccess();
  });

  it('rejects a deactivated SuperAdmin (the CLI path) before database access', async () => {
    await expect(
      backfillPharmacyCatalog(
        { id: 'actor', role: 'SUPER_ADMIN', active: false },
        { allPharmacy: true },
        true
      )
    ).rejects.toMatchObject({ status: 403 });
    expectNoDatabaseAccess();
  });

  it('rejects a SuperAdmin with an explicit DENY (mixed grant) through the same central decision', async () => {
    await expect(
      backfillPharmacyCatalog({ id: 'actor', role: 'SUPER_ADMIN' }, { allPharmacy: true }, true, {
        roleRules: PLATFORM_RULE_SOURCES.roleRules,
        actorRules: () => [{ capability: 'pharmacy:catalog-backfill', effect: 'DENY' }],
      })
    ).rejects.toMatchObject({ status: 403 });
    expectNoDatabaseAccess();
  });

  it('makes no seed or audit writes during dry-run', async () => {
    const result = await backfillPharmacyCatalog(
      { id: 'actor', role: 'SUPER_ADMIN' },
      { organizationId: 'org_a' },
      false
    );
    expect(result.dryRun).toBe(true);
    expect(mocks.seed).not.toHaveBeenCalled();
    expect(mocks.platform).toHaveBeenCalledTimes(1);
  });
});
