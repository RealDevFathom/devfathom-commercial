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

import { PharmacyInventoryError } from '@/lib/pharmacy/inventory';
import { addSaleLine } from '@/lib/pharmacy/sales';
import { verifySmartDiscountOwner } from '@/lib/pharmacy/smart-discount-approval';
vi.mock('@/lib/pharmacy/smart-discount-approval', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/smart-discount-approval')>()),
  verifySmartDiscountOwner: vi.fn(),
}));
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
  approvalPolicy: 'PHARMACIST_ON_DUTY',
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
  return { context, transaction, lotRead, caller: app.createCaller(context).pharmacySales };
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

describe('smart discount PIN transport', () => {
  it('derives approval identity from a verified owner and excludes the PIN from audit input', async () => {
    const f = fixture();
    const approval = {
      organizationId: 'org-1',
      branchId: 'branch-1',
      actorId: 'actor-1',
      ownerId: 'real-owner',
      signatureRef: 'pin:verified',
    };
    vi.mocked(verifySmartDiscountOwner).mockResolvedValue({ approval });
    vi.mocked(addSaleLine).mockResolvedValue({ line: { id: 'line-1' }, allocation: {} } as never);
    await f.caller.addLine({
      ...line,
      discountMinor: 50,
      discountKind: 'DISCOUNT',
      approvedByUserId: 'forged-owner',
      approvalPolicy: 'forged-policy',
      ownerAuthorization: { staffProfileId: 'owner-staff', pin: '1234' },
    });
    expect(vi.mocked(addSaleLine).mock.calls[0]![2]).toMatchObject({
      approvedByUserId: 'real-owner',
      approvalPolicy: 'smart-discount-owner-pin',
      smartDiscountApproval: approval,
    });
    expect(lastAudit().detail).toMatchObject({ skipInput: true });
  });
  it('returns failed PIN denials from the transaction without allocating stock', async () => {
    const f = fixture();
    vi.mocked(verifySmartDiscountOwner).mockResolvedValue({ blocked: 'Fresh owner PIN required' });
    expect(
      await f.caller.addLine({
        ...line,
        ownerAuthorization: { staffProfileId: 'owner', pin: '9999' },
      })
    ).toEqual({ blocked: 'Fresh owner PIN required' });
    expect(addSaleLine).not.toHaveBeenCalled();
    expect(f.transaction).toHaveBeenCalledOnce();
  });
  it('rejects client-supplied in-process approval proofs', async () => {
    const f = fixture();
    await expect(
      f.caller.addLine({ ...line, smartDiscountApproval: { ownerId: 'forged' } } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.transaction).not.toHaveBeenCalled();
  });
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
    expect(input.override).toEqual(override);

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
        approvalPolicy: 'PHARMACIST_ON_DUTY',
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
    const withoutReason = { inventoryLotId: override.inventoryLotId, approvalPolicy: 'X' };
    await expect(
      f.caller.addLine({ ...line, override: withoutReason } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
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
