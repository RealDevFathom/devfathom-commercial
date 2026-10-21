import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  assertSeatAvailable: vi.fn(),
  hasModule: () => true,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { router, type TRPCContext } from '../trpc';
import { organizationAdminRouter } from './organization-admin';

const app = router({ organizationAdmin: organizationAdminRouter });
const db = {
  organization: { findUnique: vi.fn() },
  user: { findFirst: vi.fn(), findUnique: vi.fn() },
  userPermissionOverride: { upsert: vi.fn(), deleteMany: vi.fn(), findFirst: vi.fn() },
};
const caller = (role = 'ADMIN') =>
  app.createCaller({
    db,
    session: {
      expires: 'later',
      user: { id: 'owner', organizationId: 'org_a', role, status: 'ACTIVE' },
    },
    organization: { id: 'org_a' },
    entitlements: { organizationId: 'org_a', enabledModules: [], modules: [] },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).organizationAdmin;

describe('setMemberProcurement (per-person Goods in grant)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.organization.findUnique.mockResolvedValue({ vertical: 'PHARMACY' });
    db.user.findUnique.mockResolvedValue({ organizationRole: null, permissionOverrides: [] });
    db.user.findFirst.mockResolvedValue({
      id: 'pharmacist_1',
      email: 'p@x.test',
      status: 'ACTIVE',
    });
    db.userPermissionOverride.findFirst.mockResolvedValue(null);
  });

  it('keeps the Pharmacist template without pharmacy:procurement', () => {
    const pharmacist = PHARMACY_ROLE_TEMPLATES.find((t) => t.key === 'pharmacist')!;
    expect(pharmacist.capabilities).not.toContain('pharmacy:procurement');
  });

  it('grants pharmacy:procurement to one member as a tenant-scoped ALLOW override', async () => {
    await caller().setMemberProcurement({ id: 'pharmacist_1', enabled: true });
    expect(db.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pharmacist_1', organizationId: 'org_a' } })
    );
    expect(db.userPermissionOverride.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_capability: { userId: 'pharmacist_1', capability: 'pharmacy:procurement' },
        },
        create: expect.objectContaining({ organizationId: 'org_a', effect: 'ALLOW' }),
      })
    );
  });

  it('removes only an ALLOW override when disabled', async () => {
    await caller().setMemberProcurement({ id: 'pharmacist_1', enabled: false });
    expect(db.userPermissionOverride.deleteMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        userId: 'pharmacist_1',
        capability: 'pharmacy:procurement',
        effect: 'ALLOW',
      },
    });
  });

  it('refuses a member from another organization', async () => {
    db.user.findFirst.mockResolvedValue(null);
    await expect(
      caller().setMemberProcurement({ id: 'foreign', enabled: true })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.userPermissionOverride.upsert).not.toHaveBeenCalled();
  });

  it('refuses non-admins', async () => {
    await expect(
      caller('EMPLOYEE').setMemberProcurement({ id: 'pharmacist_1', enabled: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each([true, false])(
    'refuses with CONFLICT when a DENY exists (enabled=%s)',
    async (enabled) => {
      db.userPermissionOverride.findFirst.mockResolvedValue({ effect: 'DENY' });
      await expect(
        caller().setMemberProcurement({ id: 'pharmacist_1', enabled })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(db.userPermissionOverride.upsert).not.toHaveBeenCalled();
      expect(db.userPermissionOverride.deleteMany).not.toHaveBeenCalled();
    }
  );

  it('refuses an admin granting themselves', async () => {
    db.user.findFirst.mockResolvedValue({ id: 'owner', email: 'o@x.test', status: 'ACTIVE' });
    await expect(
      caller().setMemberProcurement({ id: 'owner', enabled: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.userPermissionOverride.upsert).not.toHaveBeenCalled();
  });

  it('refuses granting to a suspended (INACTIVE) member', async () => {
    db.user.findFirst.mockResolvedValue({
      id: 'pharmacist_1',
      email: 'p@x.test',
      status: 'INACTIVE',
    });
    await expect(
      caller().setMemberProcurement({ id: 'pharmacist_1', enabled: true })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.userPermissionOverride.upsert).not.toHaveBeenCalled();
  });
});
