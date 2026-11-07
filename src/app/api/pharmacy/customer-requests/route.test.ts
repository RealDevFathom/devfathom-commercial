import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { can } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import {
  reauthenticatePortalStaff,
  assertPortalStaffBranch,
} from '@/lib/pharmacy/customer-portal-staff';
import { savePortalSettings, updatePortalRequest } from '@/lib/pharmacy/customer-portal';

const db = vi.hoisted(() => ({
  pharmacyBranch: { findMany: vi.fn().mockResolvedValue([{ id: 'branch-a', name: 'Branch A' }]) },
  $queryRaw: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: (_org: string, run: (db: unknown) => unknown) => run(db),
}));
vi.mock('@/lib/abac', () => ({ can: vi.fn(), subjectFromSession: (user: unknown) => user }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/lib/pharmacy/customer-portal-staff', () => ({
  reauthenticatePortalStaff: vi.fn(),
  assertPortalStaffBranch: vi.fn(),
}));
vi.mock('@/lib/pharmacy/customer-portal', async (original) => {
  const { CustomerPortalError } = await original<typeof import('@/lib/pharmacy/customer-portal')>();
  return {
    CustomerPortalError,
    portalSettings: vi.fn().mockResolvedValue({ enabled: false }),
    portalEvent: vi.fn(),
    savePortalSettings: vi.fn().mockResolvedValue({ enabled: true }),
    updatePortalRequest: vi.fn().mockResolvedValue({ id: 'request-a', status: 'APPROVED' }),
  };
});
vi.mock('@/lib/pharmacy/counter', () => ({ readCounterReceipt: vi.fn() }));
vi.mock('@/lib/pharmacy/family-khata', () => ({ readKhataBalance: vi.fn() }));
vi.mock('@/lib/pharmacy/prescription-files', () => ({ persistPrescriptionFile: vi.fn() }));

const actor = {
  organization: { id: 'org-a' },
  session: { user: { id: 'owner-a', organizationId: 'org-a', role: 'ADMIN' } },
} as NonNullable<Awaited<ReturnType<typeof resolveTenantActor>>>;
const post = (input: unknown) =>
  new Request('http://acme.localhost/api/pharmacy/customer-requests', {
    method: 'POST',
    headers: {
      origin: 'http://acme.localhost',
      host: 'acme.localhost',
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });
const approve = {
  action: 'APPROVE',
  branchId: 'branch-a',
  requestId: 'cc56d757-2cd8-4bbf-b077-18def61fa649',
  pin: '1234',
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveTenantActor).mockResolvedValue(actor);
  vi.mocked(can).mockResolvedValue(true);
  vi.mocked(hasModule).mockReturnValue(true);
  vi.mocked(reauthenticatePortalStaff).mockResolvedValue(true);
  vi.mocked(assertPortalStaffBranch).mockResolvedValue();
});

describe('customer request pharmacist transport', () => {
  it('rejects anonymous access and customer sessions', async () => {
    vi.mocked(resolveTenantActor).mockResolvedValue(null);
    expect(
      (
        await GET(
          new Request('http://acme.localhost/api/pharmacy/customer-requests', {
            headers: { cookie: 'df_customer=opaque' },
          })
        )
      ).status
    ).toBe(401);
    expect((await POST(post(approve))).status).toBe(401);
    expect(reauthenticatePortalStaff).not.toHaveBeenCalled();
  });
  it('denies capability and module revocations before reading requests', async () => {
    vi.mocked(can).mockResolvedValue(false);
    expect((await POST(post(approve))).status).toBe(403);
    vi.mocked(can).mockResolvedValue(true);
    vi.mocked(hasModule).mockReturnValue(false);
    expect((await POST(post(approve))).status).toBe(403);
    expect(updatePortalRequest).not.toHaveBeenCalled();
  });
  it('requires the current solo owner’s PIN without a second staff account', async () => {
    const response = await POST(post(approve));
    expect(response.status).toBe(200);
    expect(reauthenticatePortalStaff).toHaveBeenCalledWith(
      db,
      { organizationId: 'org-a', branchId: 'branch-a', actorId: 'owner-a' },
      '1234'
    );
    expect(updatePortalRequest).toHaveBeenCalledWith(
      db,
      { organizationId: 'org-a', branchId: 'branch-a', actorId: 'owner-a' },
      approve.requestId,
      'APPROVE',
      undefined
    );
  });
  it('returns a committed denial after a bad PIN and never changes the request', async () => {
    vi.mocked(reauthenticatePortalStaff).mockResolvedValue(false);
    expect((await POST(post(approve))).status).toBe(403);
    expect(updatePortalRequest).not.toHaveBeenCalled();
  });
  it('requires administrator access as well as dispensing permission for settings', async () => {
    vi.mocked(resolveTenantActor).mockResolvedValue({
      ...actor,
      session: { ...actor.session, user: { ...actor.session.user, role: 'EMPLOYEE' } },
    });
    expect(
      (await POST(post({ action: 'settings', branchId: 'branch-a', pin: '1234', settings: {} })))
        .status
    ).toBe(403);
    expect(savePortalSettings).not.toHaveBeenCalled();
  });
  it('allows the authorized owner to configure Raast and offer settings with PIN verification', async () => {
    expect(
      (
        await POST(
          post({
            action: 'settings',
            branchId: 'branch-a',
            pin: '1234',
            settings: { enabled: true, raastId: '03001234567', raastPayeeLabel: 'Store account' },
          })
        )
      ).status
    ).toBe(200);
    expect(savePortalSettings).toHaveBeenCalledWith(
      db,
      { organizationId: 'org-a', branchId: 'branch-a', actorId: 'owner-a' },
      expect.objectContaining({
        enabled: true,
        raastId: '03001234567',
        raastPayeeLabel: 'Store account',
      })
    );
  });
});
