import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', async () => ({
  // The integrated addLine labels its audit row through the real merge helper.
  annotateAudit: (await vi.importActual<typeof import('@/server/audit')>('@/server/audit'))
    .annotateAudit,
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
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
import { recordTrpcAudit } from '@/server/audit';
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

function fixture() {
  const transaction = vi.fn(async (callback: (tx: unknown) => unknown) => callback(db));
  const lotRead = vi.fn();
  const db = {
    $transaction: transaction,
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
    },
    pharmacyInventoryLot: { findMany: lotRead },
    user: {
      findFirst: vi.fn(async () => ({ id: 'manager-1', status: 'ACTIVE' })),
      findUnique: vi.fn(async () => ({
        organizationRole: {
          permissions: [
            { capability: 'pharmacy:safety', effect: 'ALLOW' },
            { capability: 'pharmacy:manage', effect: 'ALLOW' },
          ],
        },
        permissionOverrides: [],
      })),
    },
    pharmacyBranchAssignment: { findFirst: vi.fn(async () => ({ id: 'assignment-1' })) },
    restaurantOperatorCredential: {
      findFirst: vi.fn(async () => ({
        id: 'credential-1',
        credentialHash: 'hash',
        failedAttempts: 0,
        lockedUntil: null,
        staffProfile: {
          status: 'ACTIVE',
          user: { id: 'manager-1', status: 'ACTIVE', organizationId: 'org-1' },
        },
      })),
      update: vi.fn(),
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
});

describe('pharmacySales.addLine batch override (PH-A4)', () => {
  it('passes the override to the domain and labels the audit row with the override id', async () => {
    const f = fixture();
    vi.mocked(addSaleLine).mockResolvedValue({
      line: { id: 'line-1' },
      allocation: { overrideId: 'override-1', recommendedLotId: 'lot-fefo' },
    } as never);

    await f.caller.addLine({ ...line, override });

    expect(addSaleLine).toHaveBeenCalledOnce();
    const [, scope, input] = vi.mocked(addSaleLine).mock.calls[0]!;
    expect(scope).toEqual({ organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' });
    expect(input.override).toEqual({ ...override, approvalPolicy: 'PHARMACY_SAFETY' });

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
        approvalPolicy: 'PHARMACY_SAFETY',
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

      await expect(f.caller.addLine({ ...line, override })).rejects.toMatchObject({
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
    await expect(f.caller.addLine({ ...line, override })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('requires the authenticated operator to hold pharmacy safety permission', async () => {
    const f = fixture();
    f.db.user.findUnique.mockResolvedValue({
      organizationRole: { permissions: [] },
      permissionOverrides: [],
    });

    await expect(f.caller.addLine({ ...line, override })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(addSaleLine).not.toHaveBeenCalled();
  });
});

describe('pharmacySales.addLine discount approval (#482)', () => {
  const discountAuthorization = { staffProfileId: 'manager-profile', pin: '1234' };

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

  it('blocks a positive discount without PIN authorization', async () => {
    const f = fixture();

    await expect(f.caller.addLine({ ...line, discountMinor: 1 })).resolves.toEqual({
      blocked: 'An active manager must independently approve this discount with their PIN.',
    });

    expect(f.db.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('persists the manager authenticated by PIN under the server-owned policy', async () => {
    const f = fixture();
    vi.mocked(addSaleLine).mockResolvedValue({ line: { id: 'line-1' }, allocation: {} } as never);

    await f.caller.addLine({
      ...line,
      discountMinor: 1,
      discountAuthorization,
    });

    const input = vi.mocked(addSaleLine).mock.calls[0]![2];
    expect(input).toMatchObject({
      discountMinor: 1,
      approvedByUserId: 'manager-1',
      approvalPolicy: 'PHARMACY_MANAGER',
    });
    expect(input).not.toHaveProperty('discountAuthorization');
    expect(f.db.restaurantOperatorCredential.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ staffProfileId: 'manager-profile' }),
      })
    );
    expect(verifyOperatorCredential).toHaveBeenCalledWith('PIN', '1234', 'hash');
    expect(f.db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'credential-1', organizationId: 'org-1' },
      data: { failedAttempts: 0, lockedUntil: null },
    });
  });

  it('rejects a real manager who did not authenticate the approval', async () => {
    const f = fixture();
    vi.mocked(verifyOperatorCredential).mockResolvedValueOnce(false);

    await expect(
      f.caller.addLine({
        ...line,
        discountMinor: 1,
        discountAuthorization: { staffProfileId: 'manager-profile', pin: '9999' },
      })
    ).resolves.toEqual({
      blocked: 'An active manager must independently approve this discount with their PIN.',
    });
    expect(f.db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'credential-1', organizationId: 'org-1' },
      data: { failedAttempts: 1, lockedUntil: null },
    });
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('rejects an approver without an active assignment to this branch', async () => {
    const f = fixture();
    f.db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null as never);

    await expect(
      f.caller.addLine({
        ...line,
        discountMinor: 1,
        discountAuthorization,
      })
    ).resolves.toEqual({
      blocked: 'An active manager must independently approve this discount with their PIN.',
    });
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it.each([
    ['the current operator', { id: 'actor-1', status: 'ACTIVE', organizationId: 'org-1' }],
    ['an inactive user', { id: 'manager-1', status: 'INACTIVE', organizationId: 'org-1' }],
    [
      'a user in another organization',
      { id: 'manager-1', status: 'ACTIVE', organizationId: 'org-2' },
    ],
  ])('rejects %s as the independent approver', async (_label, user) => {
    const f = fixture();
    f.db.restaurantOperatorCredential.findFirst.mockResolvedValue({
      id: 'credential-1',
      credentialHash: 'hash',
      failedAttempts: 0,
      lockedUntil: null,
      staffProfile: { status: 'ACTIVE', user },
    });

    await expect(
      f.caller.addLine({ ...line, discountMinor: 1, discountAuthorization })
    ).resolves.toHaveProperty('blocked');
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('rejects an inactive staff profile', async () => {
    const f = fixture();
    const credential = await f.db.restaurantOperatorCredential.findFirst();
    f.db.restaurantOperatorCredential.findFirst.mockResolvedValue({
      ...credential,
      staffProfile: { ...credential.staffProfile, status: 'INACTIVE' },
    });

    await expect(
      f.caller.addLine({ ...line, discountMinor: 1, discountAuthorization })
    ).resolves.toHaveProperty('blocked');
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('rejects a locked credential', async () => {
    const f = fixture();
    const credential = await f.db.restaurantOperatorCredential.findFirst();
    f.db.restaurantOperatorCredential.findFirst.mockResolvedValue({
      ...credential,
      lockedUntil: new Date('2999-01-01T00:00:00Z'),
    });

    await expect(
      f.caller.addLine({ ...line, discountMinor: 1, discountAuthorization })
    ).resolves.toHaveProperty('blocked');
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('rejects an approver without pharmacy management permission', async () => {
    const f = fixture();
    f.db.user.findUnique.mockResolvedValue({
      organizationRole: { permissions: [] },
      permissionOverrides: [],
    });

    await expect(
      f.caller.addLine({ ...line, discountMinor: 1, discountAuthorization })
    ).resolves.toHaveProperty('blocked');
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
  });
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
