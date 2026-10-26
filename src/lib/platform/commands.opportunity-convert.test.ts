import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lockOpportunity: vi.fn(),
  packageFindUnique: vi.fn(),
  organizationCreate: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'hashed'), compare: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({ assertPlatformCapability: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => Promise<unknown>) => run(platformDb)),
}));

const platformDb = {
  $queryRawUnsafe: mocks.lockOpportunity,
  platformPackage: { findUnique: mocks.packageFindUnique },
  organization: { create: mocks.organizationCreate },
  platformAuditLog: { create: mocks.auditCreate },
};

import { executePlatformCommand } from './commands';
import { PlatformSecurityError } from './security';

const actor = { id: 'operator_1', role: 'SUPER_ADMIN' } as never;
const request = new Request('https://admin.devfathom.com/api/platform/control', { method: 'POST' });

const payload = {
  opportunityId: 'opportunity_missing',
  slug: 'acme',
  legalName: 'Acme Inc',
  displayName: 'Acme',
  deploymentMode: 'SHARED',
  packageId: 'package_1',
  timezone: 'UTC',
  locale: 'en-US',
  currency: 'USD',
  primaryContactName: 'Operations',
  primaryContactEmail: 'ops@acme.example',
  adminName: 'Acme Admin',
  adminEmail: 'admin@acme.example',
  adminPassword: 'a-strong-password',
};

describe('crm.opportunity.convert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lockOpportunity.mockResolvedValue([]);
    mocks.auditCreate.mockResolvedValue({ id: 'failure_audit_1' });
  });

  it('locks and rejects a nonexistent opportunity before provisioning anything', async () => {
    const error = await executePlatformCommand(
      actor,
      'crm.opportunity.convert',
      payload,
      request
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400, message: 'Opportunity not found.' });
    expect(mocks.lockOpportunity).toHaveBeenCalledWith(
      'SELECT id FROM platform_opportunities WHERE id = $1 FOR UPDATE',
      payload.opportunityId
    );
    expect(mocks.packageFindUnique).not.toHaveBeenCalled();
    expect(mocks.organizationCreate).not.toHaveBeenCalled();
  });
});
