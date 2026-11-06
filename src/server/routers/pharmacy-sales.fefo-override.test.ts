import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// #482: manager PINs are verified in an independent tenant transaction. The mock records
// whether a write happened inside it, i.e. outside the (rollback-prone) request transaction.
const independentTx = vi.hoisted(() => ({ db: null as unknown, active: false }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(),
  withTenantDb: vi.fn(async (_organizationId: string, run: (db: unknown) => unknown) => {
    independentTx.active = true;
    try {
      return await run(independentTx.db);
    } finally {
      independentTx.active = false;
    }
  }),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', async (importOriginal) => {
  // Keep real annotateAudit + toAuditJson so PIN-redaction assertions exercise the helper.
  const actual = await importOriginal<typeof import('@/server/audit')>();
  return {
    ...actual,
    ipFromHeaders: vi.fn(() => null),
    isAuditExcludedPath: vi.fn(() => false),
    recordTrpcAudit: vi.fn(),
  };
});
vi.mock('@/lib/pharmacy/sales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/sales')>()),
  addSaleLine: vi.fn(),
}));
vi.mock('@/lib/pharmacy/stock-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/stock-ledger')>()),
  onHand: vi.fn(),
}));
vi.mock('@/lib/restaurant/operator-credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restaurant/operator-credentials')>()),
  verifyOperatorCredential: vi.fn(async () => true),
}));

import { PharmacyInventoryError } from '@/lib/pharmacy/inventory';
import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { addSaleLine } from '@/lib/pharmacy/sales';
import { onHand } from '@/lib/pharmacy/stock-ledger';
import { recordTrpcAudit, toAuditJson } from '@/server/audit';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { MAX_FAILED_ATTEMPTS } from '@/lib/restaurant/operator-credentials';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

const line = {
  branchId: 'branch-1',
  saleId: 'sale-1',
  medicineId: 'medicine-1',
  presentationId: 'presentation-1',
  packLevelId: 'pack-1',
  saleUnit: 'STRIP' as const,
  quantity: 1,
  canonicalUnitsPerSaleUnit: 10,
  idempotencyKey: 'counter:sale-1:medicine-1',
};
const override = {
  inventoryLotId: 'lot-later',
  reason: 'Customer travelling; wants longer dating',
};
const managerApproval = { staffProfileId: 'manager-profile', pin: '1234' };

function fixture() {
  const transaction = vi.fn(async (callback: (tx: unknown) => unknown) => callback(db));
  const lotRead = vi.fn();
  const db = {
    $transaction: transaction,
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
      findFirst: vi.fn(async () => ({ id: 'branch-1' })),
    },
    pharmacyInventoryLot: { findMany: lotRead },
    user: {
      findFirst: vi.fn(async () => ({ id: 'manager-1', status: 'ACTIVE' })),
      count: vi.fn(async () => 2),
      findUnique: vi.fn(async (_args?: { where: { id: string } }) => ({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: {
          permissions: [
            { capability: 'pharmacy:safety', effect: 'ALLOW' },
            { capability: 'pharmacy:manage', effect: 'ALLOW' },
            { capability: 'pharmacy:counter', effect: 'ALLOW' },
          ],
        },
        permissionOverrides: [],
      })),
    },
    pharmacyBranchAssignment: {
      findFirst: vi.fn(async () => ({ id: 'assignment-1' })),
      findMany: vi.fn(async () => [{ branchId: 'branch-1' }]),
    },
    restaurantOperatorCredential: {
      findFirst: vi.fn(async () => ({
        id: 'credential-1',
        credentialHash: 'hash',
        failedAttempts: 0,
        lockedUntil: null as Date | null,
        staffProfile: {
          status: 'ACTIVE',
          user: { id: 'manager-1', status: 'ACTIVE', organizationId: 'org-1' },
        },
      })),
      update: vi.fn((_args: unknown) => ({ independent: independentTx.active })),
    },
    $queryRaw: vi.fn(),
    // Integrated tip: addLine first reads the medicine to route controlled lines; these are not.
    medicine: { findFirst: vi.fn(async () => null) },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'actor-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  independentTx.db = db;
  return { context, db, transaction, lotRead, caller: app.createCaller(context).pharmacySales };
}

function lastAudit() {
  const calls = vi.mocked(recordTrpcAudit).mock.calls;
  expect(calls).toHaveLength(1);
  const [args] = calls[0]!;
  return { ...args, detail: args.ctx.audit?.detail };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyOperatorCredential).mockResolvedValue(true);
});

describe('pharmacySales.addLine batch override (PH-A4)', () => {
  it('passes the override to the domain and labels the audit row with the override id', async () => {
    const f = fixture();
    vi.mocked(addSaleLine).mockResolvedValue({
      line: { id: 'line-1' },
      allocation: { overrideId: 'override-1', recommendedLotId: 'lot-fefo' },
    } as never);

    await f.caller.addLine({ ...line, override, managerApproval });

    expect(addSaleLine).toHaveBeenCalledOnce();
    const [, scope, input] = vi.mocked(addSaleLine).mock.calls[0]!;
    expect(scope).toEqual({ organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' });
    expect(input.override).toEqual({ ...override, approvalPolicy: 'PHARMACY_MANAGER_PIN' });
    expect(input).not.toHaveProperty('managerApproval');

    const audit = lastAudit();
    expect(audit.outcome).toBe('SUCCESS');
    expect(audit.path).toBe('pharmacySales.addLine');
    expect(audit.detail).toMatchObject({
      category: 'PHARMACY_SAFETY',
      action: 'fefo_override',
      targetType: 'PharmacySale',
      targetId: 'sale-1',
      metadata: {
        branchId: 'branch-1',
        medicineId: 'medicine-1',
        selectedLotId: 'lot-later',
        recommendedLotId: 'lot-fefo',
        overrideId: 'override-1',
        saleLineId: 'line-1',
        reason: override.reason,
        approvalPolicy: 'PHARMACY_MANAGER_PIN',
        managerApproval: {
          kinds: ['FEFO_OVERRIDE'],
          outcome: 'APPROVED',
          approverStaffProfileId: 'manager-profile',
          approvedByUserId: 'manager-1',
        },
      },
    });
  });

  it('leaves a plain FEFO add unlabelled', async () => {
    const f = fixture();
    vi.mocked(addSaleLine).mockResolvedValue({
      line: { id: 'line-1' },
      allocation: { overrideId: null, recommendedLotId: 'lot-fefo' },
    } as never);

    await f.caller.addLine(line);

    // No FEFO-override label; only the tip's always-on skipInput flag (keeps PINs out of audit rows).
    expect(lastAudit().detail).toEqual({ skipInput: true });
  });

  it.each([
    ['blank', '   '],
    ['empty', ''],
    ['over 500 characters', 'x'.repeat(501)],
  ])('refuses a %s reason before any stock is touched', async (_label, reason) => {
    const f = fixture();
    await expect(
      f.caller.addLine({ ...line, override: { ...override, reason } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.transaction).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('refuses an override with no reason field at all', async () => {
    const f = fixture();
    const withoutReason = { inventoryLotId: override.inventoryLotId };
    await expect(
      f.caller.addLine({ ...line, override: withoutReason } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('rejects a caller-supplied override approval policy before stock is touched', async () => {
    const f = fixture();

    await expect(
      f.caller.addLine({
        ...line,
        override: { ...override, approvalPolicy: 'CALLER_SUPPLIED' },
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(f.transaction).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it.each([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['OVERRIDE_EVIDENCE_MISSING', 'BAD_REQUEST'],
    ['INSUFFICIENT_STOCK', 'BAD_REQUEST'],
  ] as const)(
    'maps a refused override (%s) to %s and still audits the attempt',
    async (reason, code) => {
      const f = fixture();
      vi.mocked(addSaleLine).mockRejectedValue(new PharmacyInventoryError(reason));

      await expect(f.caller.addLine({ ...line, override, managerApproval })).rejects.toMatchObject({
        code,
        message: reason,
      });

      const audit = lastAudit();
      expect(audit.outcome).toBe('FAILURE');
      expect(audit.detail).toMatchObject({
        action: 'fefo_override',
        metadata: { selectedLotId: 'lot-later', reason: override.reason },
      });
    }
  );

  it('keeps a blocked override lot a FORBIDDEN refusal', async () => {
    const f = fixture();
    vi.mocked(addSaleLine).mockRejectedValue(new PharmacyInventoryError('BLOCKED_STOCK'));
    await expect(f.caller.addLine({ ...line, override, managerApproval })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('requires the authenticated operator to hold pharmacy safety permission', async () => {
    const f = fixture();
    f.db.user.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      organizationId: 'org-1',
      organizationRole: { permissions: [] },
      permissionOverrides: [],
    });

    await expect(f.caller.addLine({ ...line, override, managerApproval })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(addSaleLine).not.toHaveBeenCalled();
  });
});

describe('pharmacySales.addLine manager PIN approval (#482)', () => {
  const refusal = 'An active owner or manager must approve this with their PIN.';

  type CredentialRow = {
    id: string;
    credentialHash: string;
    failedAttempts: number;
    lockedUntil: Date | null;
    staffProfile: { status: string; user: { id: string; status: string; organizationId: string } };
  };
  function credentialRow(overrides: Partial<CredentialRow> = {}): CredentialRow {
    return {
      id: 'credential-1',
      credentialHash: 'hash',
      failedAttempts: 0,
      lockedUntil: null,
      staffProfile: {
        status: 'ACTIVE',
        user: { id: 'manager-1', status: 'ACTIVE', organizationId: 'org-1' },
      },
      ...overrides,
    };
  }

  it('rejects a caller-supplied manager id before stock is touched', async () => {
    const f = fixture();

    await expect(
      f.caller.addLine({ ...line, discountMinor: 1, approvedByUserId: 'manager-1' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(f.transaction).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('rejects a caller-supplied discount approval policy before stock is touched', async () => {
    const f = fixture();

    await expect(
      f.caller.addLine({ ...line, discountMinor: 1, approvalPolicy: 'CALLER_SUPPLIED' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(f.transaction).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('refuses a positive discount without a PIN and audits the refusal as a FAILURE', async () => {
    const f = fixture();

    await expect(f.caller.addLine({ ...line, discountMinor: 1 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: refusal,
    });

    expect(f.db.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
    const audit = lastAudit();
    expect(audit.outcome).toBe('FAILURE');
    expect(audit.detail).toMatchObject({
      skipInput: true,
      action: 'discount_approval',
      targetType: 'PharmacySale',
      targetId: 'sale-1',
      metadata: {
        discountMinor: 1,
        managerApproval: {
          kinds: ['DISCOUNT'],
          outcome: 'REJECTED',
          reason: 'MISSING',
          approverStaffProfileId: null,
        },
      },
    });
  });

  it('refuses a FEFO override without a manager PIN', async () => {
    const f = fixture();

    await expect(f.caller.addLine({ ...line, override })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    expect(addSaleLine).not.toHaveBeenCalled();
    const audit = lastAudit();
    expect(audit.outcome).toBe('FAILURE');
    expect(audit.detail).toMatchObject({
      action: 'fefo_override',
      metadata: {
        selectedLotId: 'lot-later',
        managerApproval: { kinds: ['FEFO_OVERRIDE'], outcome: 'REJECTED', reason: 'MISSING' },
      },
    });
  });

  it('persists the manager authenticated by PIN under the server-owned policy', async () => {
    const f = fixture();
    f.db.restaurantOperatorCredential.findFirst.mockResolvedValue(
      credentialRow({ failedAttempts: 2 })
    );
    vi.mocked(addSaleLine).mockResolvedValue({ line: { id: 'line-1' }, allocation: {} } as never);

    await f.caller.addLine({ ...line, discountMinor: 1, managerApproval });

    const input = vi.mocked(addSaleLine).mock.calls[0]![2];
    expect(input).toMatchObject({
      discountMinor: 1,
      approvedByUserId: 'manager-1',
      approvalPolicy: 'PHARMACY_MANAGER_PIN',
    });
    expect(input).not.toHaveProperty('managerApproval');
    expect(f.db.restaurantOperatorCredential.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          staffProfileId: 'manager-profile',
          type: 'PIN',
          revokedAt: null,
          deviceId: null,
        }),
      })
    );
    expect(verifyOperatorCredential).toHaveBeenCalledWith('PIN', '1234', 'hash');
    expect(f.db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'credential-1', organizationId: 'org-1' },
      data: { failedAttempts: 0, lockedUntil: null },
    });
    const audit = lastAudit();
    expect(audit.outcome).toBe('SUCCESS');
    expect(audit.detail).toMatchObject({
      action: 'discount_approval',
      metadata: {
        managerApproval: {
          kinds: ['DISCOUNT'],
          outcome: 'APPROVED',
          approvedByUserId: 'manager-1',
        },
      },
    });
  });

  it('commits a failed attempt outside the request transaction and audits it as a FAILURE', async () => {
    const f = fixture();
    vi.mocked(verifyOperatorCredential).mockResolvedValueOnce(false);

    await expect(
      f.caller.addLine({
        ...line,
        discountMinor: 1,
        managerApproval: { staffProfileId: 'manager-profile', pin: '9999' },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: refusal });

    expect(withTenantDb).toHaveBeenCalledWith(
      'org-1',
      expect.any(Function),
      expect.objectContaining({ skipDrain: true, userId: 'actor-1' })
    );
    expect(f.db.restaurantOperatorCredential.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'credential-1', organizationId: 'org-1' },
      data: { failedAttempts: 1, lockedUntil: null },
    });
    // The counter write ran in the independent transaction, so a rollback of the request
    // (e.g. a deliberately failing call batched alongside) cannot discard it.
    expect(f.db.restaurantOperatorCredential.update.mock.results[0]!.value).toEqual({
      independent: true,
    });
    expect(f.transaction).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
    const audit = lastAudit();
    expect(audit.outcome).toBe('FAILURE');
    expect(audit.detail).toMatchObject({
      skipInput: true,
      metadata: {
        managerApproval: {
          outcome: 'REJECTED',
          reason: 'INVALID_PIN',
          approverStaffProfileId: 'manager-profile',
        },
      },
    });
  });

  it('never writes a PIN into the audit row', async () => {
    const f = fixture();
    vi.mocked(verifyOperatorCredential).mockResolvedValueOnce(false);

    await expect(
      f.caller.addLine({
        ...line,
        override,
        discountMinor: 1,
        managerApproval: { staffProfileId: 'manager-profile', pin: '864209' },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const audit = lastAudit();
    // The middleware stores '[skipped]' for input when skipInput is set; detail goes through
    // the central redaction in toAuditJson. Neither may carry the PIN.
    expect(audit.detail?.skipInput).toBe(true);
    const stored = JSON.stringify({
      detail: toAuditJson(audit.detail),
      error: String(audit.error),
    });
    expect(stored).not.toContain('864209');
    // The central redaction also covers a PIN that reached the raw input.
    expect(JSON.stringify(toAuditJson(audit.input))).not.toContain('864209');
  });

  it('locks the credential durably on the fifth wrong PIN and stops verifying', async () => {
    const f = fixture();
    let state = { failedAttempts: 0, lockedUntil: null as Date | null };
    f.db.restaurantOperatorCredential.findFirst.mockImplementation(async () =>
      credentialRow({ ...state })
    );
    f.db.restaurantOperatorCredential.update.mockImplementation(((args: { data: typeof state }) => {
      state = { ...args.data };
      return { independent: independentTx.active };
    }) as never);
    vi.mocked(verifyOperatorCredential).mockResolvedValue(false);
    const attempt = (pin: string) =>
      f.caller.addLine({
        ...line,
        discountMinor: 1,
        managerApproval: { staffProfileId: 'manager-profile', pin },
      });

    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i += 1) {
      await expect(attempt(`100${i}`)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(state.failedAttempts).toBe(i);
    }
    await expect(attempt('1005')).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(state.lockedUntil).toBeInstanceOf(Date);
    expect(verifyOperatorCredential).toHaveBeenCalledTimes(MAX_FAILED_ATTEMPTS);

    // Even the right PIN is not checked while the lock holds.
    vi.mocked(verifyOperatorCredential).mockResolvedValue(true);
    await expect(attempt('1234')).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(verifyOperatorCredential).toHaveBeenCalledTimes(MAX_FAILED_ATTEMPTS);
    expect(addSaleLine).not.toHaveBeenCalled();
    expect(
      f.db.restaurantOperatorCredential.update.mock.results.every(
        (result) => (result.value as { independent: boolean }).independent
      )
    ).toBe(true);
  });

  it('serializes concurrent attempts on the credential row before reading its counters', async () => {
    const f = fixture();
    vi.mocked(verifyOperatorCredential).mockResolvedValueOnce(false);

    await expect(
      f.caller.addLine({ ...line, discountMinor: 1, managerApproval })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const lock = f.db.$queryRaw.mock.invocationCallOrder[0]!;
    const read = f.db.restaurantOperatorCredential.findFirst.mock.invocationCallOrder[0]!;
    expect(lock).toBeLessThan(read);
    expect(String(f.db.$queryRaw.mock.calls[0]![0])).toContain('FOR UPDATE');
  });

  it('rejects an approver without an active assignment to this branch', async () => {
    const f = fixture();
    f.db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null as never);

    await expect(
      f.caller.addLine({ ...line, discountMinor: 1, managerApproval })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the current operator when another active member exists',
      { id: 'actor-1', status: 'ACTIVE', organizationId: 'org-1' },
    ],
    ['an inactive user', { id: 'manager-1', status: 'INACTIVE', organizationId: 'org-1' }],
    [
      'a user in another organization',
      { id: 'manager-1', status: 'ACTIVE', organizationId: 'org-2' },
    ],
  ])('rejects %s as the independent approver', async (_label, user) => {
    const f = fixture();
    f.db.restaurantOperatorCredential.findFirst.mockResolvedValue(
      credentialRow({ staffProfile: { status: 'ACTIVE', user } })
    );

    await expect(
      f.caller.addLine({ ...line, discountMinor: 1, managerApproval })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('lets a solo all-capability owner approve with their own PIN and retains the audit fields', async () => {
    const f = fixture();
    f.db.user.count.mockResolvedValue(1);
    f.db.restaurantOperatorCredential.findFirst.mockResolvedValue(
      credentialRow({
        staffProfile: {
          status: 'ACTIVE',
          user: { id: 'actor-1', status: 'ACTIVE', organizationId: 'org-1' },
        },
      })
    );
    vi.mocked(addSaleLine).mockResolvedValue({ line: { id: 'line-1' } } as never);

    await f.caller.addLine({ ...line, discountMinor: 1, managerApproval });

    expect(verifyOperatorCredential).toHaveBeenCalledWith('PIN', '1234', 'hash');
    expect(addSaleLine).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: 'org-1', branchId: 'branch-1' }),
      expect.objectContaining({
        approvedByUserId: 'actor-1',
        approvalPolicy: 'PHARMACY_MANAGER_PIN',
      })
    );
  });

  it('rejects an inactive staff profile', async () => {
    const f = fixture();
    f.db.restaurantOperatorCredential.findFirst.mockResolvedValue(
      credentialRow({
        staffProfile: {
          status: 'INACTIVE',
          user: { id: 'manager-1', status: 'ACTIVE', organizationId: 'org-1' },
        },
      })
    );

    await expect(
      f.caller.addLine({ ...line, discountMinor: 1, managerApproval })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('rejects a locked credential without comparing the PIN', async () => {
    const f = fixture();
    f.db.restaurantOperatorCredential.findFirst.mockResolvedValue(
      credentialRow({ lockedUntil: new Date('2999-01-01T00:00:00Z') })
    );

    await expect(
      f.caller.addLine({ ...line, discountMinor: 1, managerApproval })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
    expect(lastAudit().detail).toMatchObject({
      metadata: { managerApproval: { outcome: 'REJECTED', reason: 'LOCKED' } },
    });
  });

  it('rejects an approver without pharmacy management permission', async () => {
    const f = fixture();
    f.db.user.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      organizationId: 'org-1',
      organizationRole: {
        permissions: [{ capability: 'pharmacy:safety', effect: 'ALLOW' }],
      },
      permissionOverrides: [],
    });

    await expect(
      f.caller.addLine({ ...line, discountMinor: 1, managerApproval })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('does not spend a manager PIN attempt when the operator may not override', async () => {
    const f = fixture();
    f.db.user.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      organizationId: 'org-1',
      organizationRole: { permissions: [] },
      permissionOverrides: [],
    });

    await expect(f.caller.addLine({ ...line, override, managerApproval })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(withTenantDb).not.toHaveBeenCalled();
    expect(f.db.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
  });
});

describe('pharmacySales.counterApprovers (#482)', () => {
  function withApproverProfiles(f: ReturnType<typeof fixture>) {
    const findMany = vi.fn(async () => [
      {
        id: 'manager-profile',
        displayName: 'Manager',
        user: {
          id: 'manager-1',
          status: 'ACTIVE',
          organizationId: 'org-1',
          organizationRole: {
            permissions: [{ capability: 'pharmacy:manage', effect: 'ALLOW' }],
          },
          permissionOverrides: [],
        },
      },
      {
        id: 'operator-profile',
        displayName: 'Operator',
        user: {
          id: 'actor-1',
          status: 'ACTIVE',
          organizationId: 'org-1',
          organizationRole: {
            permissions: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }],
          },
          permissionOverrides: [],
        },
      },
    ]);
    (f.db as unknown as { restaurantStaffProfile: unknown }).restaurantStaffProfile = {
      findMany,
    };
    return findMany;
  }

  it('lists branch-assigned managers with a stored PIN, never credentials', async () => {
    const f = fixture();
    const findMany = withApproverProfiles(f);

    await expect(f.caller.counterApprovers({ branchId: 'branch-1' })).resolves.toEqual([
      { id: 'manager-profile', name: 'Manager' },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          credentials: { some: { type: 'PIN', revokedAt: null, deviceId: null } },
        }),
      })
    );
  });

  it('refuses a caller without counter receipt capability (IDOR guard)', async () => {
    const f = fixture();
    withApproverProfiles(f);
    f.db.user.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      organizationId: 'org-1',
      organizationRole: {
        permissions: [{ capability: 'pharmacy:manage', effect: 'ALLOW' }],
      },
      permissionOverrides: [],
    });

    await expect(f.caller.counterApprovers({ branchId: 'branch-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses a caller with counter capability but no active branch assignment', async () => {
    const f = fixture();
    withApproverProfiles(f);
    f.db.pharmacyBranchAssignment.findMany.mockResolvedValue([]);

    await expect(f.caller.counterApprovers({ branchId: 'branch-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('pharmacySales.addLine four-role PIN gate (#482)', () => {
  type RoleCaps = { capability: string; effect: 'ALLOW' }[];

  const roles: Array<{ name: string; caps: RoleCaps; fefoReachesPin: boolean }> = [
    {
      name: 'owner',
      caps: [
        { capability: 'pharmacy:counter', effect: 'ALLOW' },
        { capability: 'pharmacy:safety', effect: 'ALLOW' },
        { capability: 'pharmacy:manage', effect: 'ALLOW' },
      ],
      fefoReachesPin: true,
    },
    {
      name: 'manager',
      caps: [
        { capability: 'pharmacy:counter', effect: 'ALLOW' },
        { capability: 'pharmacy:safety', effect: 'ALLOW' },
        { capability: 'pharmacy:manage', effect: 'ALLOW' },
      ],
      fefoReachesPin: true,
    },
    {
      name: 'pharmacist',
      caps: [
        { capability: 'pharmacy:counter', effect: 'ALLOW' },
        { capability: 'pharmacy:safety', effect: 'ALLOW' },
        { capability: 'pharmacy:dispense', effect: 'ALLOW' },
      ],
      fefoReachesPin: true,
    },
    {
      name: 'cashier',
      caps: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }],
      // FEFO is a pharmacy:safety decision; cashier without safety is refused before PIN.
      fefoReachesPin: false,
    },
  ];

  function asRole(f: ReturnType<typeof fixture>, caps: RoleCaps) {
    // findUnique serves both the session actor (ABAC) and the PIN approver
    // (pharmacy:manage). Keep the manager-profile user eligible to approve.
    f.db.user.findUnique.mockImplementation(async (args?: { where: { id: string } }) => {
      if (args?.where.id === 'manager-1') {
        return {
          status: 'ACTIVE',
          organizationId: 'org-1',
          organizationRole: {
            permissions: [{ capability: 'pharmacy:manage', effect: 'ALLOW' }],
          },
          permissionOverrides: [],
        };
      }
      return {
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: { permissions: caps },
        permissionOverrides: [],
      };
    });
  }

  it.each(roles.map((r) => [r.name, r.caps] as const))(
    '%s with discount reaches the manager PIN gate',
    async (_name, caps) => {
      const f = fixture();
      asRole(f, caps);
      vi.mocked(addSaleLine).mockResolvedValue({
        line: { id: 'line-1' },
        allocation: { movementIds: [] },
      } as never);

      await f.caller.addLine({ ...line, discountMinor: 1, managerApproval });
      expect(verifyOperatorCredential).toHaveBeenCalled();
      expect(addSaleLine).toHaveBeenCalled();
    }
  );

  it.each(roles.map((r) => [r.name, r.caps, r.fefoReachesPin] as const))(
    '%s FEFO override gate order (safety before PIN when required)',
    async (_name, caps, reachesPin) => {
      const f = fixture();
      asRole(f, caps);
      vi.mocked(addSaleLine).mockResolvedValue({
        line: { id: 'line-1' },
        allocation: { movementIds: [] },
      } as never);

      if (reachesPin) {
        await f.caller.addLine({ ...line, override, managerApproval });
        expect(verifyOperatorCredential).toHaveBeenCalled();
        expect(addSaleLine).toHaveBeenCalled();
      } else {
        await expect(
          f.caller.addLine({ ...line, override, managerApproval })
        ).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: 'Pharmacy safety permission is required for a FEFO override.',
        });
        expect(verifyOperatorCredential).not.toHaveBeenCalled();
        expect(f.db.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
      }
    }
  );
});

describe('pharmacySales.counterLotOptions (PH-A4)', () => {
  const bucket = (inventoryLotId: string, onHandUnits: number, blockedBy: string | null) => ({
    inventoryLotId,
    stockLocationId: 'store',
    disposition: 'AVAILABLE',
    onHandUnits,
    sealedPacks: 0,
    looseUnits: onHandUnits,
    unitsPerPack: 10,
    blockedBy,
  });

  it('lists lots in FEFO order with sellable units and the reason a lot is blocked', async () => {
    const f = fixture();
    vi.mocked(onHand).mockResolvedValue([
      bucket('lot-expired', 10, 'EXPIRED'),
      bucket('lot-fefo', 30, null),
      bucket('lot-fefo', 5, 'QUARANTINED'),
      bucket('lot-later', 100, null),
    ] as never);
    f.lotRead.mockResolvedValue([
      { id: 'lot-later', batch: { batchNumber: 'L-3', expiresAt: new Date('2028-01-01Z') } },
      { id: 'lot-expired', batch: { batchNumber: 'E-1', expiresAt: new Date('2026-01-01Z') } },
      { id: 'lot-fefo', batch: { batchNumber: 'F-2', expiresAt: new Date('2026-11-01Z') } },
    ]);

    const rows = await f.caller.counterLotOptions({
      branchId: 'branch-1',
      medicineId: 'medicine-1',
    });

    expect(rows).toEqual([
      {
        inventoryLotId: 'lot-expired',
        batchNumber: 'E-1',
        expiresAt: '2026-01-01T00:00:00.000Z',
        sellableUnits: 0,
        blockedBy: 'EXPIRED',
      },
      {
        inventoryLotId: 'lot-fefo',
        batchNumber: 'F-2',
        expiresAt: '2026-11-01T00:00:00.000Z',
        sellableUnits: 30,
        blockedBy: null,
      },
      {
        inventoryLotId: 'lot-later',
        batchNumber: 'L-3',
        expiresAt: '2028-01-01T00:00:00.000Z',
        sellableUnits: 100,
        blockedBy: null,
      },
    ]);
    const [, scope, medicineId] = vi.mocked(onHand).mock.calls[0]!;
    expect(scope).toMatchObject({ organizationId: 'org-1', branchId: 'branch-1' });
    expect(medicineId).toBe('medicine-1');
    expect(f.lotRead.mock.calls[0]![0].where).toEqual({
      id: { in: ['lot-expired', 'lot-fefo', 'lot-later'] },
      organizationId: 'org-1',
      branchId: 'branch-1',
    });
    // A read: nothing is written and nothing is audited.
    expect(f.transaction).not.toHaveBeenCalled();
    expect(recordTrpcAudit).not.toHaveBeenCalled();
  });

  it('drops a lot the scoped read does not return and skips the read when nothing is on hand', async () => {
    const f = fixture();
    vi.mocked(onHand).mockResolvedValue([bucket('lot-foreign', 10, null)] as never);
    f.lotRead.mockResolvedValue([]);
    expect(
      await f.caller.counterLotOptions({ branchId: 'branch-1', medicineId: 'medicine-1' })
    ).toEqual([]);

    vi.mocked(onHand).mockResolvedValue([]);
    f.lotRead.mockClear();
    expect(
      await f.caller.counterLotOptions({ branchId: 'branch-1', medicineId: 'medicine-1' })
    ).toEqual([]);
    expect(f.lotRead).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller before reading stock', async () => {
    const f = fixture();
    await expect(
      app
        .createCaller({ ...f.context, session: null } as unknown as TRPCContext)
        .pharmacySales.counterLotOptions({ branchId: 'branch-1', medicineId: 'medicine-1' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(onHand).not.toHaveBeenCalled();
  });
});
