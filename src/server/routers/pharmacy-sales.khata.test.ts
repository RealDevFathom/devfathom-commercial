import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  // The same merge into the request audit row as the real helper.
  annotateAudit: (ctx: { audit?: { detail: Record<string, unknown> } }, detail: object) => {
    if (ctx?.audit) Object.assign(ctx.audit.detail, detail);
  },
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/abac', () => ({
  can: vi.fn(async () => true),
  subjectFromSession: (user: unknown) => user,
}));
vi.mock('@/lib/pharmacy/settlement', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/settlement')>()),
  refundPharmacyTender: vi.fn(),
  applyPharmacyTender: vi.fn(),
  readPharmacyTenderOutcome: vi.fn(),
}));
import {
  applyPharmacyTender,
  readPharmacyTenderOutcome,
  refundPharmacyTender,
} from '@/lib/pharmacy/settlement';
import { can } from '@/lib/abac';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';
const app = router({ pharmacySales: pharmacySalesRouter });
const input = {
  branchId: 'branch-a',
  saleId: 'sale-a',
  deviceId: 'device-a',
  businessDate: new Date('2026-10-02'),
  type: 'KHATA' as const,
  amountMinor: 100,
  idempotencyKey: 'key-a',
  familyAccountId: 'family-a',
};
function fixture() {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch-a' }),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        status: 'ACTIVE',
        organizationId: 'org-a',
        permissionOverrides: [],
        organizationRole: null,
      }),
    },
    pharmacyBranchAssignment: { findFirst: vi.fn().mockResolvedValue({ branchId: 'branch-a' }) },
    pharmacyTender: { findFirst: vi.fn().mockResolvedValue({ type: 'CREDIT' }) },
    pharmacySale: { findFirst: vi.fn().mockResolvedValue({ customerId: 'customer-a' }) },
    pharmacyFamilyAccount: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'family-a',
          displayName: 'Family',
          creditLimitMinor: 100,
          members: [{ id: 'member-a' }],
        },
      ]),
      update: vi.fn().mockResolvedValue({}),
    },
    pharmacyKhataEvent: {
      findFirst: vi.fn(),
      groupBy: vi.fn().mockResolvedValue([]),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
    },
    pharmacyKhataLimitDecision: { create: vi.fn().mockResolvedValue({}) },
  };
  db.$transaction.mockImplementation(async (callback) => callback(db));
  const user = {
    id: 'owner-a',
    role: 'ADMIN',
    status: 'ACTIVE',
    organizationId: 'org-a',
    passwordAuthenticatedAt: Date.now(),
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: { expires: 'later', user },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  };
  return {
    db,
    user,
    context,
    caller: () => app.createCaller(context as unknown as TRPCContext).pharmacySales,
  };
}
/** ABAC answers only these actions, as a persisted role grants them. */
function grant(...actions: string[]) {
  vi.mocked(can).mockImplementation(async (_subject, action) => actions.includes(action));
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(can).mockResolvedValue(true);
  vi.mocked(readPharmacyTenderOutcome).mockResolvedValue({
    status: 'NOT_FOUND',
    replayUnsafe: true,
  });
  vi.mocked(applyPharmacyTender).mockResolvedValue({
    tenderId: 'tender-a',
    settled: false,
    receiptNumber: null,
    remainingMinor: 100,
    replayed: false,
  });
});
describe('Khata router trust and recovery boundary', () => {
  it('uses server tenant, CREDIT settlement and an atomic member charge', async () => {
    const f = fixture();
    await f.caller().tender(input);
    expect(applyPharmacyTender).toHaveBeenCalledWith(
      f.db,
      { organizationId: 'org-a', branchId: 'branch-a', actorId: 'owner-a' },
      { ...input, type: 'CREDIT' }
    );
    expect(f.db.pharmacyKhataEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 'khata:tender-a',
        memberId: 'member-a',
        dueAt: input.businessDate,
        familyAccountId: 'family-a',
        kind: 'CHARGE',
        amountMinor: 100,
      }),
    });
  });
  it('hands only the fresh server-session claim to the audited owner gate', async () => {
    const f = fixture();
    await f.caller().tender({
      ...input,
      amountMinor: 101,
      ownerOverride: true,
      overrideReason: 'Regular family',
    });
    expect(f.db.pharmacyKhataLimitDecision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reasons: expect.objectContaining({
          ownerAuthorizedByUserId: 'owner-a',
          ownerReauthenticatedAt: new Date(f.user.passwordAuthenticatedAt).toISOString(),
        }),
      }),
    });
  });
  it.each(['passwordAuthenticatedAt', 'organizationId', 'ownerAuthorizedByUserId'])(
    'rejects client %s',
    async (field) => {
      const f = fixture();
      await expect(
        f.caller().tender({ ...input, [field]: 'forged' } as never)
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(applyPharmacyTender).not.toHaveBeenCalled();
    }
  );
  it('rejects stale owner evidence and non-owner override', async () => {
    const f = fixture();
    const overLimit = { ...input, amountMinor: 101, ownerOverride: true, overrideReason: 'Known' };
    f.user.passwordAuthenticatedAt -= 301000;
    await expect(f.caller().tender(overLimit)).rejects.toMatchObject({
      message: 'OWNER_ACTION_REQUIRED',
    });
    f.user.passwordAuthenticatedAt = Date.now();
    f.user.role = 'EMPLOYEE';
    grant('pharmacy:dispense');
    await expect(f.caller().tender(overLimit)).rejects.toMatchObject({
      message: 'OWNER_ACTION_REQUIRED',
    });
    expect(applyPharmacyTender).not.toHaveBeenCalled();
    expect(f.db.pharmacyKhataLimitDecision.create).not.toHaveBeenCalled();
  });
  it('replays exact accepted evidence without reauthorizing or duplicating a charge', async () => {
    const f = fixture();
    f.user.passwordAuthenticatedAt = 0;
    const result = { tenderId: 'tender-a', settled: true, receiptNumber: 1, remainingMinor: 0 };
    vi.mocked(readPharmacyTenderOutcome).mockResolvedValue({
      status: 'ACCEPTED',
      replayUnsafe: true,
      result,
    });
    expect(await f.caller().tender({ ...input, ownerOverride: true })).toEqual({
      ...result,
      replayed: true,
    });
    expect(applyPharmacyTender).not.toHaveBeenCalled();
    expect(f.db.pharmacyKhataEvent.create).not.toHaveBeenCalled();
    await f.caller().tenderOutcome(input);
    expect(readPharmacyTenderOutcome).toHaveBeenLastCalledWith(
      f.db,
      expect.objectContaining({ organizationId: 'org-a' }),
      { ...input, type: 'CREDIT' }
    );
  });
  it('denies inactive branches, absent capability and a different vertical before money writes', async () => {
    const f = fixture();
    f.db.pharmacyBranch.findFirst.mockResolvedValue(null as never);
    await expect(f.caller().tender(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    vi.mocked(can).mockResolvedValue(false);
    await expect(f.caller().tender(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    f.context.organization.vertical = 'RESTAURANT';
    await expect(
      f.caller().khataAccounts({ branchId: 'branch-a', saleId: 'sale-a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(applyPharmacyTender).not.toHaveBeenCalled();
  });
  it('appends a refund payment once without editing the original charge', async () => {
    const f = fixture();
    const charge = { id: 'khata:tender-a', familyAccountId: 'family-a' };
    f.db.pharmacyKhataEvent.findFirst
      .mockResolvedValueOnce(charge)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(charge)
      .mockResolvedValueOnce({ id: 'khata-refund:refund-a' });
    vi.mocked(refundPharmacyTender).mockResolvedValue({
      refundId: 'refund-a',
      originalTenderId: 'tender-a',
      amountMinor: 50,
      replayed: false,
    });
    const refund = {
      branchId: 'branch-a',
      originalTenderId: 'tender-a',
      deviceId: 'device-a',
      businessDate: input.businessDate,
      amountMinor: 50,
      reason: 'Return',
      idempotencyKey: 'refund-a',
    };
    await f.caller().refundTender(refund);
    await f.caller().refundTender(refund);
    expect(f.db.pharmacyKhataEvent.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        id: 'khata-refund:refund-a',
        kind: 'PAYMENT',
        settlesChargeId: 'khata:tender-a',
        amountMinor: 50,
      }),
    });
  });
});

describe('Khata over-limit approval by Owner, Manager or tenant ADMIN (#313)', () => {
  const overLimit = {
    ...input,
    amountMinor: 101,
    ownerOverride: true,
    overrideReason: '  Known family, pays at month end  ',
  };

  it('lets a standard Manager, with no counter or dispense grant, read accounts and approve with a reason', async () => {
    const f = fixture();
    f.user.role = 'EMPLOYEE';
    grant('pharmacy:manage');
    await expect(
      f.caller().khataAccounts({ branchId: 'branch-a', saleId: 'sale-a' })
    ).resolves.toEqual([expect.objectContaining({ id: 'family-a', creditLimitMinor: 100 })]);
    await f.caller().tender(overLimit);
    const approval = {
      saleId: 'sale-a',
      reason: 'Known family, pays at month end',
      approverBasis: 'pharmacy:manage',
      chargeAmountMinor: 101,
      balanceBeforeMinor: 0,
      previousLimitMinor: 100,
      approvedLimitMinor: 101,
      amountOverLimitMinor: 1,
    };
    expect(f.db.pharmacyFamilyAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { creditLimitMinor: 101 } })
    );
    expect(f.db.pharmacyKhataLimitDecision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'OVERRIDDEN',
        appliedLimitMinor: 101,
        ownerActorId: 'owner-a',
        reasons: expect.objectContaining({
          ownerAuthorizedByUserId: 'owner-a',
          overLimitCharge: approval,
        }),
      }),
    });
    expect(applyPharmacyTender).toHaveBeenCalledOnce();
    expect(f.context.audit.detail).toMatchObject({
      category: 'PHARMACY',
      action: 'khata_credit_limit_override',
      targetType: 'PharmacyFamilyAccount',
      targetId: 'family-a',
      metadata: { branchId: 'branch-a', approverId: 'owner-a', ...approval },
    });
  });

  it('preserves main ADMIN dispense plus admin:access approval without manage', async () => {
    const f = fixture();
    grant('pharmacy:dispense', 'admin:access');
    await f.caller().tender(overLimit);
    expect(f.db.pharmacyKhataLimitDecision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reasons: expect.objectContaining({
          overLimitCharge: expect.objectContaining({ approverBasis: 'tenant-admin' }),
        }),
      }),
    });
  });

  it('does not let a manager-only approval grant cross an assignment boundary', async () => {
    const f = fixture();
    f.user.role = 'EMPLOYEE';
    grant('pharmacy:manage');
    f.db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null as never);
    await expect(
      f.caller().khataAccounts({ branchId: 'branch-a', saleId: 'sale-a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.caller().tender(overLimit)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(applyPharmacyTender).not.toHaveBeenCalled();
  });

  it.each(['pharmacy:manage', 'pharmacy:*'])(
    'does not let ADMIN outrun a %s DENY',
    async (capability) => {
      const f = fixture();
      grant('admin:access');
      f.db.user.findUnique.mockResolvedValue({
        status: 'ACTIVE',
        organizationId: 'org-a',
        organizationRole: null,
        permissionOverrides: [{ capability, effect: 'DENY' }],
      } as never);
      await expect(
        f.caller().khataAccounts({ branchId: 'branch-a', saleId: 'sale-a' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(f.caller().tender(overLimit)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(applyPharmacyTender).not.toHaveBeenCalled();
    }
  );

  it('refuses an approval without a non-blank reason before any write', async () => {
    const f = fixture();
    f.user.role = 'EMPLOYEE';
    grant('pharmacy:manage');
    const withoutReason = { ...input, amountMinor: 101, ownerOverride: true };
    await expect(f.caller().tender(withoutReason)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'OVERRIDE_REASON_REQUIRED',
    });
    await expect(f.caller().tender({ ...overLimit, overrideReason: '   ' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(f.db.pharmacyFamilyAccount.update).not.toHaveBeenCalled();
    expect(f.db.pharmacyKhataLimitDecision.create).not.toHaveBeenCalled();
    expect(applyPharmacyTender).not.toHaveBeenCalled();
    expect(f.context.audit.detail).not.toHaveProperty('action');
  });

  it('keeps a Cashier capped at the credit limit even with a reason', async () => {
    const f = fixture();
    f.user.role = 'EMPLOYEE';
    grant('pharmacy:dispense');
    await expect(f.caller().tender(overLimit)).rejects.toMatchObject({
      message: 'OWNER_ACTION_REQUIRED',
    });
    expect(f.db.pharmacyKhataLimitDecision.create).not.toHaveBeenCalled();
    expect(applyPharmacyTender).not.toHaveBeenCalled();
    await f.caller().tender({ ...input, amountMinor: 100 });
    expect(applyPharmacyTender).toHaveBeenCalledOnce();
    expect(f.db.pharmacyKhataLimitDecision.create).not.toHaveBeenCalled();
  });

  it('admits an approver to Khata reads and tenders only, not to Khata refunds', async () => {
    const f = fixture();
    f.user.role = 'EMPLOYEE';
    grant('pharmacy:manage');
    await expect(
      f.caller().refundTender({
        branchId: 'branch-a',
        originalTenderId: 'tender-a',
        deviceId: 'device-a',
        businessDate: input.businessDate,
        amountMinor: 50,
        reason: 'Return',
        idempotencyKey: 'refund-a',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(refundPharmacyTender).not.toHaveBeenCalled();
  });

  it('rejects an override reason on a tender that is not Khata', async () => {
    const f = fixture();
    await expect(
      f.caller().tender({
        ...input,
        type: 'CASH',
        familyAccountId: undefined,
        overrideReason: 'Not Khata',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Khata fields require Khata tender.' });
    expect(applyPharmacyTender).not.toHaveBeenCalled();
  });
});

// #646 / SEC-646-01: permission combinations must not bypass branch assignment.
describe('Khata assigned-branch admission (#646)', () => {
  const actors = [
    { name: 'Manager (manage only)', grants: ['pharmacy:manage'] },
    { name: 'Manager (manage and dispense)', grants: ['pharmacy:manage', 'pharmacy:dispense'] },
    {
      name: 'Owner (wildcard resolves manage, not sensitive dispense)',
      grants: ['pharmacy:manage'],
    },
    {
      name: 'Owner (manage plus exact dispense)',
      grants: ['pharmacy:manage', 'pharmacy:dispense'],
    },
    { name: 'Cashier (dispense only)', grants: ['pharmacy:dispense'] },
  ];
  const routes = ['accounts', 'statement', 'outcome', 'CREDIT outcome', 'KHATA', 'CREDIT'] as const;
  function invoke(f: ReturnType<typeof fixture>, route: (typeof routes)[number]) {
    if (route === 'accounts')
      return f.caller().khataAccounts({ branchId: input.branchId, saleId: input.saleId });
    if (route === 'statement')
      return f.caller().khataStatement({
        branchId: input.branchId,
        saleId: input.saleId,
        familyAccountId: input.familyAccountId,
      });
    if (route === 'outcome') return f.caller().tenderOutcome(input);
    if (route === 'CREDIT outcome')
      return f.caller().tenderOutcome({ ...input, type: 'CREDIT', familyAccountId: undefined });
    return f.caller().tender({ ...input, type: route });
  }
  function expectNoEffects(f: ReturnType<typeof fixture>) {
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(f.db.$queryRaw).not.toHaveBeenCalled();
    expect(f.db.pharmacySale.findFirst).not.toHaveBeenCalled();
    expect(f.db.pharmacyFamilyAccount.findMany).not.toHaveBeenCalled();
    expect(f.db.pharmacyFamilyAccount.update).not.toHaveBeenCalled();
    expect(f.db.pharmacyKhataLimitDecision.create).not.toHaveBeenCalled();
    expect(f.db.pharmacyKhataEvent.create).not.toHaveBeenCalled();
    expect(applyPharmacyTender).not.toHaveBeenCalled();
    expect(readPharmacyTenderOutcome).not.toHaveBeenCalled();
  }
  for (const actor of actors) {
    it.each(routes)(`${actor.name} may use %s at an assigned branch`, async (route) => {
      const f = fixture();
      f.user.role = 'EMPLOYEE';
      grant(...actor.grants);
      await expect(invoke(f, route)).resolves.toBeDefined();
      expect(f.db.pharmacyBranchAssignment.findFirst).toHaveBeenCalledWith({
        where: { organizationId: 'org-a', branchId: 'branch-a', userId: 'owner-a', active: true },
        select: { branchId: true },
      });
      if (route === 'KHATA' || route === 'CREDIT')
        expect(f.db.pharmacyKhataEvent.create).toHaveBeenCalledOnce();
    });
    it.each(routes)(`${actor.name} may not use %s at an unassigned branch`, async (route) => {
      const f = fixture();
      f.user.role = 'EMPLOYEE';
      grant(...actor.grants);
      f.db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null as never);
      await expect(invoke(f, route)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expectNoEffects(f);
    });
  }
  it.each(routes)('assignment without manage or dispense cannot admit %s', async (route) => {
    const f = fixture();
    f.user.role = 'EMPLOYEE';
    grant('admin:access');
    await expect(invoke(f, route)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expectNoEffects(f);
  });
  it.each(routes)(
    'ADMIN admin:access plus manage without dispense cannot admit %s',
    async (route) => {
      const f = fixture();
      grant('admin:access', 'pharmacy:manage');
      await expect(invoke(f, route)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expectNoEffects(f);
    }
  );
  it.each(routes)(
    'main ADMIN dispense gate retains active same-tenant branch access for %s',
    async (route) => {
      const f = fixture();
      grant('pharmacy:dispense', 'admin:access');
      f.db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null as never);
      await expect(invoke(f, route)).resolves.toBeDefined();
      expect(f.db.pharmacyBranchAssignment.findFirst).not.toHaveBeenCalled();
    }
  );
  for (const mismatch of ['session', 'organization', 'entitlement'] as const) {
    it.each(routes)(`${mismatch} tenant mismatch cannot admit %s`, async (route) => {
      const f = fixture();
      f.user.role = 'EMPLOYEE';
      grant('pharmacy:manage', 'pharmacy:dispense');
      if (mismatch === 'session') f.user.organizationId = 'org-other';
      if (mismatch === 'organization') f.context.organization.id = 'org-other';
      if (mismatch === 'entitlement') f.context.entitlements.organizationId = 'org-other';
      await expect(invoke(f, route)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expectNoEffects(f);
    });
  }
  it.each(routes)('a foreign or inactive branch cannot admit %s', async (route) => {
    const f = fixture();
    f.user.role = 'EMPLOYEE';
    grant('pharmacy:manage', 'pharmacy:dispense');
    f.db.pharmacyBranch.findMany.mockResolvedValue([]);
    await expect(invoke(f, route)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expectNoEffects(f);
  });
  it('preserves main ADMIN approval with exact manage DENY but dispense ALLOW', async () => {
    const f = fixture();
    grant('pharmacy:dispense', 'admin:access');
    f.db.user.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      organizationId: 'org-a',
      organizationRole: null,
      permissionOverrides: [{ capability: 'pharmacy:manage', effect: 'DENY' }],
    } as never);
    await f.caller().tender({
      ...input,
      amountMinor: 101,
      ownerOverride: true,
      overrideReason: 'Main ADMIN approval',
    });
    expect(f.db.pharmacyKhataLimitDecision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reasons: expect.objectContaining({
          overLimitCharge: expect.objectContaining({ approverBasis: 'tenant-admin' }),
        }),
      }),
    });
  });
});
