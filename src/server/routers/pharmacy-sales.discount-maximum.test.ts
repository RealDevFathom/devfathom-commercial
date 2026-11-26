import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', async () => ({
  annotateAudit: (await vi.importActual<typeof import('@/server/audit')>('@/server/audit'))
    .annotateAudit,
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/owner-data-export-pin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/owner-data-export-pin')>()),
  verifyOwnerExportPin: vi.fn(),
}));
vi.mock('@/lib/pharmacy/smart-discount-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/smart-discount-service')>()),
  readMaxDiscountSettings: vi.fn(),
  saveMaxDiscountBps: vi.fn(),
}));

import { verifyOwnerExportPin } from '@/lib/pharmacy/owner-data-export-pin';
import { readMaxDiscountSettings, saveMaxDiscountBps } from '@/lib/pharmacy/smart-discount-service';
import { recordTrpcAudit } from '@/server/audit';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

function fixture(options: { support?: boolean } = {}) {
  const db = {
    organization: { findFirst: vi.fn().mockResolvedValue({ requireApprovalAuthenticator: false }) },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
      findFirst: vi.fn(async () => ({ id: 'branch-1' })),
    },
    pharmacyBranchAssignment: { findMany: vi.fn(async () => [{ branchId: 'branch-1' }]) },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'owner-1',
        role: 'ADMIN',
        status: 'ACTIVE',
        organizationId: 'org-1',
        ...(options.support ? { isSupportSession: true } : {}),
      },
    },
    organization: { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, caller: app.createCaller(context).pharmacySales };
}

const save = { branchId: 'branch-1', maxDiscountBps: 1_500, pin: '2468' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readMaxDiscountSettings).mockResolvedValue({ maxDiscountBps: 10_000, canChange: true });
  vi.mocked(verifyOwnerExportPin).mockResolvedValue('OK');
  vi.mocked(saveMaxDiscountBps).mockResolvedValue({
    previousMaxDiscountBps: 10_000,
    maxDiscountBps: 1_500,
  });
});

describe("DEV-66 changing the owner's maximum discount", () => {
  it("needs the owner's fresh PIN and audits the old and the new value, never the PIN", async () => {
    const f = fixture();
    await expect(f.caller.saveDiscountMaximum(save)).resolves.toEqual({ maxDiscountBps: 1_500 });
    expect(verifyOwnerExportPin).toHaveBeenCalledWith({
      organizationId: 'org-1',
      userId: 'owner-1',
      pin: '2468',
      action: 'pharmacy.maxDiscount',
    });
    expect(saveMaxDiscountBps).toHaveBeenCalledWith(expect.anything(), expect.anything(), 1_500);
    const [audit] = vi.mocked(recordTrpcAudit).mock.calls[0]!;
    const detail = audit.ctx.audit?.detail;
    expect(detail).toMatchObject({
      operation: 'UPDATE',
      targetType: 'Organization',
      targetId: 'org-1',
      skipInput: true,
      changes: { pharmacyMaxDiscountBps: { before: 10_000, after: 1_500 } },
      metadata: { pinVerified: true },
    });
    expect(JSON.stringify(detail)).not.toContain('2468');
  });

  it('DEV-929: the audit reads "from no maximum" for the first maximum, and back to it', async () => {
    await fixture().caller.saveDiscountMaximum(save);
    expect(vi.mocked(recordTrpcAudit).mock.calls[0]![0].ctx.audit?.detail).toMatchObject({
      description: 'Changed the maximum discount from no maximum to 15%',
    });
    vi.mocked(saveMaxDiscountBps).mockResolvedValue({
      previousMaxDiscountBps: 1_500,
      maxDiscountBps: 10_000,
    });
    await fixture().caller.saveDiscountMaximum({ ...save, maxDiscountBps: 10_000 });
    expect(vi.mocked(recordTrpcAudit).mock.calls[1]![0].ctx.audit?.detail).toMatchObject({
      description: 'Changed the maximum discount from 15% to no maximum',
    });
  });

  it.each([
    ['REJECTED', 'FORBIDDEN'],
    ['LOCKED', 'TOO_MANY_REQUESTS'],
    ['NO_PIN', 'PRECONDITION_FAILED'],
  ] as const)('refuses a %s PIN and changes nothing', async (result, code) => {
    vi.mocked(verifyOwnerExportPin).mockResolvedValue(result);
    await expect(fixture().caller.saveDiscountMaximum(save)).rejects.toMatchObject({ code });
    expect(saveMaxDiscountBps).not.toHaveBeenCalled();
  });

  it('asks for the owner’s authenticator code when authenticator approval is enabled', async () => {
    const { db, caller } = fixture();
    db.organization.findFirst.mockResolvedValue({ requireApprovalAuthenticator: true });
    await expect(caller.saveDiscountMaximum({ ...save, pin: '' })).rejects.toThrow(
      'Enter your own authenticator code to confirm.'
    );
    vi.mocked(verifyOwnerExportPin).mockResolvedValue('REJECTED');
    await expect(caller.saveDiscountMaximum(save)).rejects.toThrow(
      'That authenticator code is not correct.'
    );
  });

  it('refuses an empty PIN without checking it', async () => {
    await expect(fixture().caller.saveDiscountMaximum({ ...save, pin: '' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(verifyOwnerExportPin).not.toHaveBeenCalled();
    expect(saveMaxDiscountBps).not.toHaveBeenCalled();
  });

  it('refuses anyone but the owner before asking for a PIN', async () => {
    vi.mocked(readMaxDiscountSettings).mockResolvedValue({
      maxDiscountBps: 10_000,
      canChange: false,
    });
    await expect(fixture().caller.saveDiscountMaximum(save)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(verifyOwnerExportPin).not.toHaveBeenCalled();
    expect(saveMaxDiscountBps).not.toHaveBeenCalled();
  });

  it('refuses a support session, and never offers it the change', async () => {
    const f = fixture({ support: true });
    await expect(f.caller.saveDiscountMaximum(save)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(saveMaxDiscountBps).not.toHaveBeenCalled();
    await expect(f.caller.discountMaximum({ branchId: 'branch-1' })).resolves.toEqual({
      maxDiscountBps: 10_000,
      canChange: false,
    });
  });
});
