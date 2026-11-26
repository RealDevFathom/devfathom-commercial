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
vi.mock('@/lib/pharmacy/bill-discount-service', () => ({
  BILL_DISCOUNT_CHANGE_REFUSED: 'Only the owner can change the whole-bill discount setting.',
  applyBillDiscount: vi.fn(),
  readBillDiscountEnabled: vi.fn(),
  saveBillDiscountEnabled: vi.fn(),
}));
vi.mock('@/lib/pharmacy/owner-data-export-pin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/owner-data-export-pin')>()),
  verifyOwnerExportPin: vi.fn(),
}));
vi.mock('@/lib/pharmacy/smart-discount-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/smart-discount-service')>()),
  readMaxDiscountSettings: vi.fn(),
}));
vi.mock('@/lib/pharmacy/counter-line-approval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pharmacy/counter-line-approval')>();
  return {
    ...actual,
    authorizeCounterApproval: vi.fn(actual.authorizeCounterApproval),
    confirmCounterApproval: vi.fn(actual.confirmCounterApproval),
  };
});
vi.mock('@/lib/abac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/abac')>()),
  can: vi.fn(),
}));

import { can } from '@/lib/abac';
import {
  applyBillDiscount,
  readBillDiscountEnabled,
  saveBillDiscountEnabled,
} from '@/lib/pharmacy/bill-discount-service';
import {
  authorizeCounterApproval,
  confirmCounterApproval,
} from '@/lib/pharmacy/counter-line-approval';
import { verifyOwnerExportPin } from '@/lib/pharmacy/owner-data-export-pin';
import { PharmacySaleError } from '@/lib/pharmacy/sales';
import { readMaxDiscountSettings } from '@/lib/pharmacy/smart-discount-service';
import { recordTrpcAudit } from '@/server/audit';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

function fixture(options: { support?: boolean } = {}) {
  const transaction = vi.fn(async (callback: (tx: unknown) => unknown) => callback(db));
  const db = {
    organization: {
      findFirst: vi.fn().mockResolvedValue({ requireApprovalAuthenticator: false }),
      findUnique: vi.fn().mockResolvedValue({ timezone: 'UTC' }),
    },
    $transaction: transaction,
    $queryRaw: vi.fn(async () => []),
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
      findFirst: vi.fn(async () => ({ id: 'branch-1' })),
    },
    user: {
      findUnique: vi.fn(async () => ({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: { permissions: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }] },
        permissionOverrides: [],
      })),
      findFirst: vi.fn(async () => ({
        id: 'actor-1',
        organizationId: 'org-1',
        status: 'ACTIVE',
        role: 'EMPLOYEE',
      })),
    },
    restaurantOperatorCredential: { findFirst: vi.fn(async () => ({ id: 'credential-1' })) },
    pharmacyBranchAssignment: {
      findMany: vi.fn(async () => [{ branchId: 'branch-1' }]),
      findFirst: vi.fn(async () => ({ branchId: 'branch-1' })),
    },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'actor-1',
        role: 'EMPLOYEE',
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
  return { transaction, caller: app.createCaller(context).pharmacySales };
}

const lastAudit = () => vi.mocked(recordTrpcAudit).mock.calls.at(-1)![0].ctx.audit?.detail;
const give = {
  branchId: 'branch-1',
  saleId: 'sale-1',
  discount: { kind: 'AMOUNT' as const, minor: 1_000 },
};
const applied = {
  status: 'APPLIED' as const,
  totalMinor: 1_000,
  previousTotalMinor: 0,
  lines: [{ saleLineId: 'line-1', discountMinor: 1_000 }],
  excluded: [],
};
const managerPin = { staffProfileId: 'staff-manager', pin: '2468' };

beforeEach(() => {
  vi.clearAllMocks();
  // The cashier may sell, but holds no discount right of their own.
  vi.mocked(can).mockImplementation(async (_subject, action) => action !== 'pharmacy:discount');
  vi.mocked(applyBillDiscount).mockResolvedValue(applied);
  vi.mocked(readMaxDiscountSettings).mockResolvedValue({ maxDiscountBps: 10_000, canChange: true });
  vi.mocked(readBillDiscountEnabled).mockResolvedValue(false);
  vi.mocked(verifyOwnerExportPin).mockResolvedValue('OK');
  vi.mocked(saveBillDiscountEnabled).mockResolvedValue({ previous: false, enabled: true });
});

describe('DEV-956 pharmacySales.applyBillDiscount', () => {
  beforeEach(() => vi.mocked(readBillDiscountEnabled).mockResolvedValue(true));

  it('refuses while the owner has it off, before any PIN is checked (no lockout strike)', async () => {
    vi.mocked(readBillDiscountEnabled).mockResolvedValue(false);
    const f = fixture();
    await expect(
      f.caller.applyBillDiscount({ ...give, discountApproval: managerPin })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'BILL_DISCOUNT_OFF' });
    expect(authorizeCounterApproval).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it('asks a cashier without the discount right for a manager PIN before touching the bill', async () => {
    const f = fixture();
    await expect(f.caller.applyBillDiscount(give)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'A discount needs a manager to approve it with their PIN.',
    });
    expect(f.transaction).not.toHaveBeenCalled();
    expect(applyBillDiscount).not.toHaveBeenCalled();
  });

  it('verifies the PIN first, re-checks it in the sale transaction and audits who gave and approved it', async () => {
    const f = fixture();
    const approval = {
      approvedByUserId: 'manager-1',
      approvalPolicy: 'MANAGER_PIN',
      selfApproved: false,
      credentialId: 'credential-1',
    };
    vi.mocked(authorizeCounterApproval).mockResolvedValueOnce(approval);
    await expect(
      f.caller.applyBillDiscount({ ...give, discountApproval: managerPin })
    ).resolves.toEqual(applied);
    expect(authorizeCounterApproval).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' },
      'DISCOUNT',
      managerPin
    );
    expect(confirmCounterApproval).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'DISCOUNT',
      approval
    );
    expect(applyBillDiscount).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      saleId: 'sale-1',
      request: give.discount,
      approval,
    });
    const detail = lastAudit();
    expect(detail).toMatchObject({
      operation: 'UPDATE',
      targetType: 'PharmacySale',
      targetId: 'sale-1',
      skipInput: true,
      description: 'Counter gave a whole-bill discount.',
      metadata: {
        givenByUserId: 'actor-1',
        approvedByUserId: 'manager-1',
        approvalPolicy: 'MANAGER_PIN',
        selfApproved: false,
        totalMinor: 1_000,
      },
    });
    expect(JSON.stringify(detail)).not.toContain('2468');
  });

  it('lets an operator with the owner-granted discount right give it without a PIN', async () => {
    const f = fixture();
    vi.mocked(can).mockResolvedValue(true);
    await f.caller.applyBillDiscount({ ...give, discount: { kind: 'PERCENT', bps: 500 } });
    expect(applyBillDiscount).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        approval: expect.objectContaining({
          approvedByUserId: 'actor-1',
          approvalPolicy: 'DISCOUNT_RIGHT',
        }),
      })
    );
  });

  it('removes the discount without an approval', async () => {
    const f = fixture();
    await f.caller.applyBillDiscount({ ...give, discount: { kind: 'AMOUNT', minor: 0 } });
    expect(authorizeCounterApproval).not.toHaveBeenCalled();
    expect(applyBillDiscount).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ approval: null })
    );
    expect(lastAudit()).toMatchObject({ description: 'Counter removed the whole-bill discount.' });
  });

  it('turns a server refusal into its reason for the counter', async () => {
    vi.mocked(can).mockResolvedValue(true);
    vi.mocked(applyBillDiscount).mockRejectedValueOnce(new PharmacySaleError('BILL_DISCOUNT_OFF'));
    await expect(fixture().caller.applyBillDiscount(give)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'BILL_DISCOUNT_OFF',
    });
  });

  it('refuses a branch outside the cashier’s assignments and a malformed discount', async () => {
    const f = fixture();
    await expect(
      f.caller.applyBillDiscount({ ...give, branchId: 'branch-other' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      f.caller.applyBillDiscount({ ...give, discount: { kind: 'PERCENT', bps: 10_001 } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      f.caller.applyBillDiscount({ ...give, discount: { kind: 'AMOUNT', minor: 1.5 } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(applyBillDiscount).not.toHaveBeenCalled();
  });
});

describe('DEV-956 the owner’s whole-bill discount switch', () => {
  const save = { branchId: 'branch-1', enabled: true, pin: '2468' };

  it('reads off by default for everyone at the branch', async () => {
    await expect(fixture().caller.billDiscountSetting({ branchId: 'branch-1' })).resolves.toEqual({
      enabled: false,
      canChange: true,
    });
  });

  it("needs the owner's fresh PIN and audits the old and the new value, never the PIN", async () => {
    await expect(fixture().caller.saveBillDiscountSetting(save)).resolves.toEqual({
      enabled: true,
    });
    expect(verifyOwnerExportPin).toHaveBeenCalledWith({
      organizationId: 'org-1',
      userId: 'actor-1',
      pin: '2468',
      action: 'pharmacy.billDiscount',
    });
    const detail = lastAudit();
    expect(detail).toMatchObject({
      operation: 'UPDATE',
      targetType: 'Organization',
      targetId: 'org-1',
      description: 'Turned on the whole-bill discount at the counter',
      changes: { pharmacyBillDiscountEnabled: { before: false, after: true } },
    });
    expect(JSON.stringify(detail)).not.toContain('2468');
  });

  it.each([
    ['REJECTED', 'FORBIDDEN'],
    ['LOCKED', 'TOO_MANY_REQUESTS'],
    ['NO_PIN', 'PRECONDITION_FAILED'],
  ] as const)('refuses a %s PIN and changes nothing', async (result, code) => {
    vi.mocked(verifyOwnerExportPin).mockResolvedValue(result);
    await expect(fixture().caller.saveBillDiscountSetting(save)).rejects.toMatchObject({ code });
    expect(saveBillDiscountEnabled).not.toHaveBeenCalled();
  });

  it('refuses anyone but the owner, and a support session, before asking for a PIN', async () => {
    vi.mocked(readMaxDiscountSettings).mockResolvedValue({
      maxDiscountBps: 10_000,
      canChange: false,
    });
    await expect(fixture().caller.saveBillDiscountSetting(save)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    vi.mocked(readMaxDiscountSettings).mockResolvedValue({
      maxDiscountBps: 10_000,
      canChange: true,
    });
    const support = fixture({ support: true });
    await expect(support.caller.saveBillDiscountSetting(save)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(support.caller.billDiscountSetting({ branchId: 'branch-1' })).resolves.toEqual({
      enabled: false,
      canChange: false,
    });
    expect(verifyOwnerExportPin).not.toHaveBeenCalled();
    expect(saveBillDiscountEnabled).not.toHaveBeenCalled();
  });
});
