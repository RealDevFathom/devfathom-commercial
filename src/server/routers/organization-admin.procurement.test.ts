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
  userPermissionOverride: { deleteMany: vi.fn(), findFirst: vi.fn() },
  $executeRaw: vi.fn(),
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
    db.$executeRaw.mockResolvedValue(1);
    db.userPermissionOverride.deleteMany.mockResolvedValue({ count: 1 });
  });

  it('keeps the Pharmacist template without pharmacy:procurement', () => {
    const pharmacist = PHARMACY_ROLE_TEMPLATES.find((t) => t.key === 'pharmacist')!;
    expect(pharmacist.capabilities).not.toContain('pharmacy:procurement');
  });

  it('grants pharmacy:procurement with one conditional tenant-scoped write', async () => {
    await caller().setMemberProcurement({ id: 'pharmacist_1', enabled: true });
    expect(db.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pharmacist_1', organizationId: 'org_a' } })
    );
    expect(db.$executeRaw).toHaveBeenCalledOnce();
    const [sql, ...values] = db.$executeRaw.mock.calls[0]!;
    const text = (sql as string[]).join('?');
    expect(text).toContain('ON CONFLICT ("userId", capability) DO UPDATE');
    expect(text).toContain("WHERE user_permission_overrides.effect = 'ALLOW'");
    expect(values).toEqual(
      expect.arrayContaining(['org_a', 'pharmacist_1', 'pharmacy:procurement'])
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
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses non-admins', async () => {
    await expect(
      caller('EMPLOYEE').setMemberProcurement({ id: 'pharmacist_1', enabled: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('returns CONFLICT when the conditional write affects 0 rows because a DENY exists', async () => {
    db.$executeRaw.mockResolvedValue(0);
    await expect(
      caller().setMemberProcurement({ id: 'pharmacist_1', enabled: true })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('returns CONFLICT on removal when only a DENY exists, and leaves it', async () => {
    db.userPermissionOverride.deleteMany.mockResolvedValue({ count: 0 });
    db.userPermissionOverride.findFirst.mockResolvedValue({ id: 'deny_1' });
    await expect(
      caller().setMemberProcurement({ id: 'pharmacist_1', enabled: false })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.userPermissionOverride.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ effect: 'ALLOW' }),
    });
  });

  it('refuses an admin granting themselves', async () => {
    db.user.findFirst.mockResolvedValue({ id: 'owner', email: 'o@x.test', status: 'ACTIVE' });
    await expect(
      caller().setMemberProcurement({ id: 'owner', enabled: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it.each(['INACTIVE', 'ON_LEAVE', 'INVITED'])(
    'refuses granting to a %s member',
    async (status) => {
      db.user.findFirst.mockResolvedValue({
        id: 'pharmacist_1',
        email: 'p@x.test',
        status,
      });
      await expect(
        caller().setMemberProcurement({ id: 'pharmacist_1', enabled: true })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(db.$executeRaw).not.toHaveBeenCalled();
    }
  );
});
