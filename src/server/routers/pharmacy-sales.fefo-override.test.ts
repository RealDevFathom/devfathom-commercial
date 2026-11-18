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
vi.mock('@/lib/pharmacy/counter-line-approval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pharmacy/counter-line-approval')>();
  // The real check runs unless a test stubs one call (DEV-843 manager PIN approvals).
  return {
    ...actual,
    authorizeCounterApproval: vi.fn(actual.authorizeCounterApproval),
    listCounterApprovers: vi.fn(actual.listCounterApprovers),
  };
});
vi.mock('@/lib/abac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/abac')>()),
  can: vi.fn(),
}));

import { can } from '@/lib/abac';
import {
  authorizeCounterApproval,
  listCounterApprovers,
  CounterApprovalDenied,
} from '@/lib/pharmacy/counter-line-approval';
import { PharmacyInventoryError } from '@/lib/pharmacy/inventory';
import { addSaleLine, PharmacySaleError } from '@/lib/pharmacy/sales';
import { PharmacySerializedPackError } from '@/lib/pharmacy/serialized-pack-sale';
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
    // DEV-631: a counter bill or line is refused while today's business day is closed.
    organization: { findUnique: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacySaleLine: { findFirst: vi.fn(async () => null) },
    $transaction: transaction,
    $queryRaw: vi.fn(async () => []),
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
      findFirst: vi.fn(async () => ({ id: 'branch-1' })),
    },
    // DEV-607: addLine admits only an active counter member assigned to the branch.
    // #520: the override approver is the session actor, resolved from the database.
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
    pharmacyBranchAssignment: { findMany: vi.fn(async () => [{ branchId: 'branch-1' }]) },
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
  // The actor is the pharmacist on duty unless a test says otherwise.
  vi.mocked(can).mockResolvedValue(true);
});

describe('pharmacySales.addLine batch override (PH-A4)', () => {
  it('preserves the shelf-label lot constraint without granting an override', async () => {
    const f = fixture();
    vi.mocked(addSaleLine).mockResolvedValue({ line: { id: 'line-1' }, allocation: {} } as never);
    await f.caller.addLine({ ...line, shelfLabelLotId: 'lot-fefo' });
    expect(vi.mocked(addSaleLine).mock.calls[0]?.[2]).toMatchObject({
      shelfLabelLotId: 'lot-fefo',
    });
    expect(vi.mocked(addSaleLine).mock.calls[0]?.[2].override).toBeUndefined();
  });

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
    // The approval policy is derived on the server, never taken from the caller.
    expect(input.override).toEqual({ ...override, approvalPolicy: 'PHARMACIST_ON_DUTY' });
    expect(can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'actor-1' }),
      'pharmacy:dispense',
      undefined,
      expect.anything()
    );

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
        approvedByUserId: 'actor-1',
      },
    });
  });

  it('refuses a caller-supplied override approval policy before any stock is touched (#520)', async () => {
    const f = fixture();
    await expect(
      f.caller.addLine({
        ...line,
        override: { ...override, approvalPolicy: 'PHARMACIST_ON_DUTY' },
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.transaction).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('refuses a non-pharmacist override without a pharmacist PIN (#520)', async () => {
    const f = fixture();
    vi.mocked(can).mockResolvedValue(false);
    await expect(f.caller.addLine({ ...line, override })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'A non-FEFO batch needs a pharmacist to approve it with their PIN.',
    });
    // Approval is settled before the sale transaction takes a connection.
    expect(f.transaction).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      outcome: 'FAILURE',
      detail: { action: 'fefo_override' },
    });
  });

  it('re-checks the approver inside the sale transaction before any stock is touched (#520)', async () => {
    const f = fixture();
    // Authorized before the transaction, revoked by the time the sale re-checks.
    vi.mocked(can).mockResolvedValueOnce(true).mockResolvedValue(false);
    await expect(f.caller.addLine({ ...line, override })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'A non-FEFO batch needs a pharmacist to approve it with their PIN.',
    });
    expect(f.transaction).toHaveBeenCalledOnce();
    expect(addSaleLine).not.toHaveBeenCalled();
  });
});

describe('DEV-889 scanned-pack approver directory', () => {
  it('uses the scanned-pack approval policy under the counter branch gate', async () => {
    const f = fixture();
    const profiles = [{ id: 'manager-profile', name: 'Manager', self: false }];
    vi.mocked(listCounterApprovers).mockResolvedValueOnce(profiles);
    await expect(f.caller.scannedPackFefoApprovers({ branchId: 'branch-1' })).resolves.toEqual(
      profiles
    );
    expect(listCounterApprovers).toHaveBeenCalledWith(
      expect.anything(),
      {
        organizationId: 'org-1',
        branchId: 'branch-1',
        actorId: 'actor-1',
      },
      'SCANNED_PACK_FEFO'
    );
  });

  it('refuses an unassigned branch before listing approvers', async () => {
    const f = fixture();
    await expect(
      f.caller.scannedPackFefoApprovers({ branchId: 'branch-other' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(listCounterApprovers).not.toHaveBeenCalled();
  });
});

describe('DEV-929 discount approver directory', () => {
  it('lists the discount approvers under the counter branch gate', async () => {
    const f = fixture();
    const profiles = [{ id: 'owner-profile', name: 'Owner', self: true }];
    vi.mocked(listCounterApprovers).mockResolvedValueOnce(profiles);
    await expect(f.caller.discountApprovers({ branchId: 'branch-1' })).resolves.toEqual(profiles);
    expect(listCounterApprovers).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' },
      'DISCOUNT'
    );
  });

  it('refuses an unassigned branch before listing approvers', async () => {
    const f = fixture();
    await expect(f.caller.discountApprovers({ branchId: 'branch-other' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(listCounterApprovers).not.toHaveBeenCalled();
  });
});

describe('pharmacySales.addLine scanned pack approval (DEV-843)', () => {
  const scannedPack = { payload: ']d2010896123450001321A1B2C3D4E5F6' };
  const managerPin = { staffProfileId: 'staff-manager', pin: '2468' };
  const packLine = { ...line, saleUnit: 'PACK' as const, canonicalUnitsPerSaleUnit: 1 };
  const managerApproval = {
    approvedByUserId: 'manager-1',
    approvalPolicy: 'MANAGER_PIN',
    selfApproved: false,
    credentialId: null,
  };

  it('forwards a scan without a PIN with no approval, even for the pharmacist on duty', async () => {
    const f = fixture();
    vi.mocked(addSaleLine).mockResolvedValue({
      line: { id: 'line-1' },
      allocation: { overrideId: null, recommendedLotId: 'lot-fefo' },
    } as never);

    await f.caller.addLine({ ...packLine, scannedPack });

    const [, , input] = vi.mocked(addSaleLine).mock.calls[0]!;
    expect(input.scannedPack).toEqual({ payload: scannedPack.payload });
    expect(input.override).toBeUndefined();
    expect(authorizeCounterApproval).not.toHaveBeenCalled();
    // A pack from the FEFO lot is a plain add, with no safety label.
    expect(lastAudit().detail).not.toHaveProperty('action');
  });

  it('verifies a manager PIN sent with the scan and forwards only its server-derived policy', async () => {
    const f = fixture();
    vi.mocked(authorizeCounterApproval).mockResolvedValueOnce(managerApproval);
    vi.mocked(addSaleLine).mockResolvedValue({
      line: { id: 'line-1' },
      allocation: { overrideId: 'override-1', recommendedLotId: 'lot-fefo' },
    } as never);

    await f.caller.addLine({ ...packLine, scannedPack: { ...scannedPack, approval: managerPin } });

    expect(authorizeCounterApproval).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' },
      'SCANNED_PACK_FEFO',
      managerPin
    );
    const [, , input] = vi.mocked(addSaleLine).mock.calls[0]!;
    // Exact on purpose: the PIN itself never reaches the sale domain.
    expect(input.scannedPack).toEqual({
      payload: scannedPack.payload,
      fefoApprovalPolicy: 'MANAGER_PIN:manager-1',
    });
    const audit = lastAudit();
    expect(audit.outcome).toBe('SUCCESS');
    expect(audit.detail).toMatchObject({
      category: 'PHARMACY_SAFETY',
      action: 'fefo_override',
      description: 'Counter sold a scanned pack out of FEFO order.',
      metadata: {
        medicineId: 'medicine-1',
        scannedPackApprovalPolicy: 'MANAGER_PIN',
        scannedPackApprovedByUserId: 'manager-1',
        overrideId: 'override-1',
        recommendedLotId: 'lot-fefo',
        saleLineId: 'line-1',
      },
    });
  });

  it('records a solo owner self-approval on the safety audit row', async () => {
    const f = fixture();
    vi.mocked(authorizeCounterApproval).mockResolvedValueOnce({
      approvedByUserId: 'actor-1',
      approvalPolicy: 'SOLE_APPROVER_PIN_REAUTH',
      selfApproved: true,
      credentialId: null,
    });
    vi.mocked(addSaleLine).mockResolvedValue({
      line: { id: 'line-1' },
      allocation: { overrideId: 'override-1', recommendedLotId: 'lot-fefo' },
    } as never);

    await f.caller.addLine({ ...packLine, scannedPack: { ...scannedPack, approval: managerPin } });

    const [, , input] = vi.mocked(addSaleLine).mock.calls[0]!;
    // The self-approver is the actor, so the policy carries no second user id.
    expect(input.scannedPack).toEqual({
      payload: scannedPack.payload,
      fefoApprovalPolicy: 'SOLE_APPROVER_PIN_REAUTH',
    });
    expect(lastAudit()).toMatchObject({
      outcome: 'SUCCESS',
      detail: {
        category: 'PHARMACY_SAFETY',
        action: 'fefo_override',
        metadata: {
          scannedPackApprovalPolicy: 'SOLE_APPROVER_PIN_REAUTH',
          scannedPackApprovedByUserId: 'actor-1',
          overrideId: 'override-1',
        },
      },
    });
  });

  it('refuses a wrong or ineligible manager PIN before the sale transaction opens', async () => {
    const f = fixture();
    vi.mocked(authorizeCounterApproval).mockRejectedValueOnce(
      new CounterApprovalDenied('SCANNED_PACK_FEFO')
    );
    await expect(
      f.caller.addLine({ ...packLine, scannedPack: { ...scannedPack, approval: managerPin } })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message:
        'A scanned pack that is not from the earliest-expiry batch needs a manager or owner to approve it with their PIN.',
    });
    expect(f.transaction).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
    // Labelled as a refused approval, without claiming the pack was out of order.
    expect(lastAudit()).toMatchObject({
      outcome: 'FAILURE',
      detail: {
        category: 'PHARMACY_SAFETY',
        action: 'fefo_override',
        description: 'Counter refused the manager PIN sent with a scanned pack.',
      },
    });
  });

  it('refuses an unapproved later-expiry scan as FORBIDDEN and labels the refusal', async () => {
    const f = fixture();
    vi.mocked(addSaleLine).mockRejectedValue(
      new PharmacySerializedPackError('SERIAL_FEFO_APPROVAL_REQUIRED')
    );

    await expect(f.caller.addLine({ ...packLine, scannedPack })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'SERIAL_FEFO_APPROVAL_REQUIRED',
    });
    expect(lastAudit()).toMatchObject({
      outcome: 'FAILURE',
      detail: {
        category: 'PHARMACY_SAFETY',
        action: 'fefo_override',
        description: 'Counter refused a scanned pack out of FEFO order without a manager approval.',
      },
    });
  });

  it('refuses a scanned pack sent with a typed batch override before any approval or stock', async () => {
    const f = fixture();
    await expect(f.caller.addLine({ ...packLine, scannedPack, override })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(authorizeCounterApproval).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('refuses a caller-supplied scanned-pack approval policy before any stock is touched', async () => {
    const f = fixture();
    await expect(
      f.caller.addLine({
        ...packLine,
        scannedPack: { ...scannedPack, fefoApprovalPolicy: 'MANAGER_PIN' },
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.transaction).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
  });
});

describe('pharmacySales.addLine discount approval (#520)', () => {
  it.each([
    ['approver id and policy text', { approvedByUserId: 'actor-1', approvalPolicy: 'ANY' }],
    ['approver id alone', { approvedByUserId: 'manager-1' }],
    ['policy text alone', { approvalPolicy: 'MANAGER_APPROVED' }],
  ])('refuses a caller-supplied %s before any stock is touched', async (_label, fields) => {
    const f = fixture();
    await expect(
      f.caller.addLine({ ...line, discountKind: 'DISCOUNT', discountMinor: 1, ...fields } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.transaction).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('refuses a discount with no manager PIN approval', async () => {
    const f = fixture();
    // DEV-66: by default nobody holds the owner-granted discount right.
    vi.mocked(can).mockImplementation(async (_subject, action) => action !== 'pharmacy:discount');
    await expect(
      f.caller.addLine({ ...line, discountKind: 'DISCOUNT', discountMinor: 1 })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'A discount needs a manager to approve it with their PIN.',
    });
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('DEV-66: lets an operator the owner granted the discount right discount without a PIN', async () => {
    const f = fixture();
    vi.mocked(addSaleLine).mockResolvedValue({
      line: { id: 'line-1' },
      allocation: { overrideId: null, recommendedLotId: 'lot-fefo' },
    } as never);
    await f.caller.addLine({ ...line, discountKind: 'DISCOUNT', discountMinor: 1 });
    const [, , input] = vi.mocked(addSaleLine).mock.calls[0]!;
    expect(input).toMatchObject({ approvedByUserId: 'actor-1', approvalPolicy: 'DISCOUNT_RIGHT' });
    expect(can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'actor-1' }),
      'pharmacy:discount',
      undefined,
      expect.anything()
    );
  });

  it('adds an undiscounted line with no approver recorded', async () => {
    const f = fixture();
    vi.mocked(addSaleLine).mockResolvedValue({
      line: { id: 'line-1' },
      allocation: { overrideId: null, recommendedLotId: 'lot-fefo' },
    } as never);
    await f.caller.addLine(line);
    const [, , input] = vi.mocked(addSaleLine).mock.calls[0]!;
    expect(input.approvedByUserId).toBeUndefined();
    expect(input.approvalPolicy).toBeUndefined();
    expect(can).not.toHaveBeenCalled();
  });

  it('leaves a plain FEFO add unlabelled', async () => {
    const f = fixture();
    vi.mocked(addSaleLine).mockResolvedValue({
      line: { id: 'line-1' },
      allocation: { overrideId: null, recommendedLotId: 'lot-fefo' },
    } as never);

    await f.caller.addLine(line);

    // No FEFO-override label; only the always-on skipInput flag (keeps PINs out of audit
    // rows) and the bill the add targeted (DEV-712).
    expect(lastAudit().detail).toEqual({
      skipInput: true,
      targetType: 'PharmacySale',
      targetId: 'sale-1',
      metadata: { branchId: 'branch-1' },
    });
  });

  // DEV-712: a refused add on a settled bill was audited with no trace of the bill.
  it('names the bill on a refused add without recording the input', async () => {
    const f = fixture();
    vi.mocked(addSaleLine).mockRejectedValue(new PharmacySaleError('INVALID_STATE'));

    await expect(f.caller.addLine(line)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'INVALID_STATE',
    });

    const audit = lastAudit();
    expect(audit.outcome).toBe('FAILURE');
    expect(audit.detail).toEqual({
      skipInput: true,
      targetType: 'PharmacySale',
      targetId: 'sale-1',
      metadata: { branchId: 'branch-1' },
    });
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

describe('pharmacySales.addLine closed business day (DEV-631)', () => {
  it('refuses a line while today is closed, before any stock is allocated', async () => {
    const f = fixture();
    const db = f.context.db as unknown as {
      pharmacyDailyClose: { findFirst: ReturnType<typeof vi.fn> };
    };
    db.pharmacyDailyClose.findFirst.mockResolvedValue({ id: 'close-1', reopen: null });
    await expect(f.caller.addLine(line)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'DAY_CLOSED',
    });
    expect(addSaleLine).not.toHaveBeenCalled();
  });

  it('adds the line once the owner reopened the day for trading', async () => {
    const f = fixture();
    const db = f.context.db as unknown as {
      pharmacyDailyClose: { findFirst: ReturnType<typeof vi.fn> };
    };
    db.pharmacyDailyClose.findFirst.mockResolvedValue({ id: 'close-1', reopen: { id: 'r-1' } });
    vi.mocked(addSaleLine).mockResolvedValue({ line: { id: 'line-1' }, allocation: {} } as never);
    await f.caller.addLine(line);
    expect(addSaleLine).toHaveBeenCalledOnce();
  });
});
