import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
  annotateAudit: (
    ctx: { audit?: { detail: Record<string, unknown> } },
    detail: { metadata?: Record<string, unknown>; targetType?: string; targetId?: string }
  ) => {
    if (!ctx?.audit) return;
    const current = ctx.audit.detail;
    current.metadata = {
      ...((current.metadata as Record<string, unknown> | undefined) ?? {}),
      ...(detail.metadata ?? {}),
    };
    if (detail.targetType) current.targetType = detail.targetType;
    if (detail.targetId) current.targetId = detail.targetId;
  },
}));
vi.mock('@/lib/pharmacy/counter', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/counter')>()),
  readCounterReceipt: vi.fn(),
  readCounterCart: vi.fn(async () => ({ saleId: 'sale-a', lines: [] })),
}));
vi.mock('@/lib/pharmacy/sales', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/sales')>()),
  changeSaleStatus: vi.fn(async () => ({ sale: { id: 'sale-a', status: 'HELD' } })),
  readReturnHistory: vi.fn(async () => [{ id: 'return-1' }]),
  returnSaleLine: vi.fn(async () => ({ returnLineId: 'return-line-1' })),
}));
vi.mock('@/lib/pharmacy/settlement', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/settlement')>()),
  applyPharmacyTender: vi.fn(async () => ({ tenderId: 'tender-1' })),
  refundPharmacyTender: vi.fn(async () => ({ refundId: 'refund-1' })),
}));
vi.mock('@/lib/pharmacy/dispensing-label-source', () => ({
  readDispensingLabelSources: vi.fn(async () => []),
}));
vi.mock('@/lib/pharmacy/receipt-print', () => ({
  PharmacyReceiptPrintError: class PharmacyReceiptPrintError extends Error {
    constructor(reason: string) {
      super(reason);
      this.name = 'PharmacyReceiptPrintError';
    }
  },
  readPharmacyReceiptFormat: vi.fn(async () => ({ layout: { paperWidth: 32 }, revision: 1 })),
  readPharmacyReceiptTaxIdentity: vi.fn(async () => ({ ntn: null, strn: null })),
  buildPharmacyReceiptEscPosJob: vi.fn(
    (_receipt: unknown, _locale: unknown, options: { reprint: boolean }) => ({
      document: { kind: 'RECEIPT' },
      escPos: { encoding: 'base64', data: 'YQ==', byteCount: 1 },
      paperWidth: 32,
      reprint: options.reprint,
    })
  ),
  savePharmacyReceiptFormat: vi.fn(),
}));

import { hasModule } from '@/lib/entitlements';
import { readCounterCart, readCounterReceipt } from '@/lib/pharmacy/counter';
import { readDispensingLabelSources } from '@/lib/pharmacy/dispensing-label-source';
import { changeSaleStatus, readReturnHistory, returnSaleLine } from '@/lib/pharmacy/sales';
import { applyPharmacyTender, refundPharmacyTender } from '@/lib/pharmacy/settlement';
import {
  buildPharmacyReceiptEscPosJob,
  readPharmacyReceiptFormat,
  readPharmacyReceiptTaxIdentity,
  savePharmacyReceiptFormat,
} from '@/lib/pharmacy/receipt-print';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

type Permission = { capability: string; effect: 'ALLOW' | 'DENY' };

const dispense: Permission[] = [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }];

function fixture(
  permissions: Permission[],
  role: 'EMPLOYEE' | 'ADMIN' = 'EMPLOYEE',
  overrides: Permission[] = []
) {
  const db = {
    $queryRaw: vi.fn(async () => []),
    user: {
      findUnique: vi.fn(async () => ({
        status: 'ACTIVE',
        organizationId: 'org-a',
        organizationRole: { permissions },
        permissionOverrides: overrides,
      })),
    },
    pharmacyBranch: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] }; organizationId?: string } }) =>
        args.where.organizationId && args.where.organizationId !== 'org-a'
          ? []
          : args.where.id.in
              .filter((id) => id !== 'foreign-branch' && id !== 'closed-branch')
              .map((id) => ({ id }))
      ),
      findFirst: vi.fn(async (args?: { where?: { id?: string; organizationId?: string } }) => {
        const id = args?.where?.id;
        const organizationId = args?.where?.organizationId;
        if (organizationId && organizationId !== 'org-a') return null;
        if (id === 'foreign-branch' || id === 'closed-branch') return null;
        return {
          id: id ?? 'branch-a',
          name: 'Counter',
          receiptLayout: null,
          receiptLayoutRevision: 0,
        };
      }),
    },
    pharmacyBranchAssignment: {
      findMany: vi.fn(async () => [] as { branchId: string }[]),
    },
    pharmacySale: {
      findMany: vi.fn(async () => [
        {
          id: 'sale-a',
          receiptNumber: 7,
          receiptDeviceId: 'device-a',
          businessDate: new Date('2026-10-01T00:00:00.000Z'),
        },
      ]),
    },
    organization: { findUnique: vi.fn(async () => ({ currency: 'PKR' })) },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (inner: typeof db) => Promise<unknown>) => fn(db));
  const user = {
    id: 'user-a',
    role,
    department: 'COUNTER',
    status: 'ACTIVE' as string,
    organizationId: 'org-a',
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: { expires: 'later', user },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} as Record<string, unknown> },
  };
  return {
    db,
    user,
    context,
    caller: () => app.createCaller(context as unknown as TRPCContext).pharmacySales,
  };
}

function assign(f: ReturnType<typeof fixture>, branchIds: string[]) {
  f.db.pharmacyBranchAssignment.findMany.mockResolvedValue(
    branchIds.map((branchId) => ({ branchId }))
  );
}

const reads = () => [
  readCounterReceipt,
  readPharmacyReceiptFormat,
  readPharmacyReceiptTaxIdentity,
  readDispensingLabelSources,
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasModule).mockReturnValue(true);
  vi.mocked(readCounterReceipt).mockResolvedValue({
    receiptNumber: 7,
    completedAt: '2026-10-01T00:00:00.000Z',
  } as never);
  vi.mocked(readPharmacyReceiptFormat).mockResolvedValue({
    layout: { paperWidth: 32 },
    revision: 1,
  } as never);
  vi.mocked(readPharmacyReceiptTaxIdentity).mockResolvedValue({ ntn: null, strn: null });
});

type Caller = ReturnType<ReturnType<typeof fixture>['caller']>;

const paths: {
  name: string;
  run: (caller: Caller, branchId?: string) => Promise<unknown>;
  allowed: object;
}[] = [
  {
    name: 'counterReceipt',
    run: (caller, branchId = 'branch-a') => caller.counterReceipt({ branchId, saleId: 'sale-a' }),
    allowed: { receiptNumber: 7, dispensingLabelSources: [] },
  },
  {
    name: 'counterReceiptPrintJob',
    run: (caller, branchId = 'branch-a') =>
      caller.counterReceiptPrintJob({ branchId, saleId: 'sale-a', locale: 'en', reprint: false }),
    allowed: { status: 'READY', reprint: false },
  },
  {
    name: 'counterReceiptPrintJob reprint',
    run: (caller, branchId = 'branch-a') =>
      caller.counterReceiptPrintJob({ branchId, saleId: 'sale-a', locale: 'en', reprint: true }),
    allowed: { status: 'READY', reprint: true },
  },
  {
    name: 'lookupReceiptByNumber',
    run: (caller, branchId = 'branch-a') =>
      caller.lookupReceiptByNumber({ branchId, receiptNumber: 7 }),
    allowed: [expect.objectContaining({ id: 'sale-a', receiptDeviceId: 'device-a' })],
  },
  {
    name: 'counterReceiptFormat',
    run: (caller, branchId = 'branch-a') => caller.counterReceiptFormat({ branchId }),
    allowed: { revision: 1 },
  },
];

describe('counter receipt authorization', () => {
  it('supplies the regulatory identity effective at completion to browser receipt callers', async () => {
    const f = fixture(dispense);
    assign(f, ['branch-a']);
    vi.mocked(readPharmacyReceiptTaxIdentity).mockResolvedValue({
      ntn: 'HISTORICAL-NTN',
      strn: 'HISTORICAL-STRN',
    });

    await expect(
      f.caller().counterReceipt({ branchId: 'branch-a', saleId: 'sale-a' })
    ).resolves.toMatchObject({
      taxIdentity: { ntn: 'HISTORICAL-NTN', strn: 'HISTORICAL-STRN' },
    });
    expect(readPharmacyReceiptTaxIdentity).toHaveBeenCalledWith(
      f.db,
      expect.objectContaining({ organizationId: 'org-a', branchId: 'branch-a' }),
      new Date('2026-10-01T00:00:00.000Z')
    );
  });

  it('supplies the completion-time regulatory identity to browser receipts', async () => {
    const f = fixture(dispense);
    assign(f, ['branch-a']);
    vi.mocked(readPharmacyReceiptTaxIdentity).mockResolvedValue({
      ntn: 'NTN-HISTORICAL',
      strn: 'STRN-HISTORICAL',
    });

    await expect(
      f.caller().counterReceipt({ branchId: 'branch-a', saleId: 'sale-a' })
    ).resolves.toMatchObject({
      taxIdentity: { ntn: 'NTN-HISTORICAL', strn: 'STRN-HISTORICAL' },
    });
    expect(readPharmacyReceiptTaxIdentity).toHaveBeenCalledWith(
      f.db,
      { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' },
      new Date('2026-10-01T00:00:00.000Z')
    );
  });

  it('does not fall back to the current regulatory identity for an unsettled receipt', async () => {
    const f = fixture(dispense);
    assign(f, ['branch-a']);
    vi.mocked(readCounterReceipt).mockResolvedValue({
      receiptNumber: null,
      completedAt: null,
    } as never);

    await expect(
      f.caller().counterReceipt({ branchId: 'branch-a', saleId: 'sale-a' })
    ).resolves.toMatchObject({ taxIdentity: { ntn: null, strn: null } });
    expect(readPharmacyReceiptTaxIdentity).not.toHaveBeenCalled();
  });

  it('rejects status-only completion before opening a transaction', async () => {
    const f = fixture(dispense);
    assign(f, ['branch-a']);

    await expect(
      f.caller().transition({
        branchId: 'branch-a',
        saleId: 'sale-a',
        action: 'complete' as never,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      source: 'role',
      permissions: [{ capability: 'pharmacy:counter', effect: 'DENY' as const }],
      overrides: [{ capability: '*', effect: 'ALLOW' as const }],
    },
    {
      source: 'user',
      permissions: [{ capability: '*', effect: 'ALLOW' as const }],
      overrides: [{ capability: 'pharmacy:counter', effect: 'DENY' as const }],
    },
  ])('blocks transition when an admin has an explicit $source DENY', async (rules) => {
    const f = fixture(rules.permissions, 'ADMIN', rules.overrides);

    await expect(
      f.caller().transition({ branchId: 'branch-a', saleId: 'sale-a', action: 'hold' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(changeSaleStatus).not.toHaveBeenCalled();
  });

  it('keeps the all-capability admin transition shortcut without a branch assignment', async () => {
    const f = fixture([{ capability: '*', effect: 'ALLOW' }], 'ADMIN');

    await expect(
      f.caller().transition({ branchId: 'branch-a', saleId: 'sale-a', action: 'hold' })
    ).resolves.toMatchObject({ sale: { id: 'sale-a', status: 'HELD' } });
    expect(changeSaleStatus).toHaveBeenCalledWith(
      f.db,
      expect.objectContaining({ organizationId: 'org-a', branchId: 'branch-a' }),
      'sale-a',
      'hold',
      undefined,
      undefined
    );
  });

  it.each(paths)('$name allows an assigned dispenser on their own branch', async (path) => {
    const f = fixture(dispense);
    assign(f, ['branch-a']);
    await expect(path.run(f.caller())).resolves.toMatchObject(path.allowed);
    expect(f.db.pharmacyBranchAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-a',
          userId: 'user-a',
          active: true,
        }),
      })
    );
  });

  it.each(paths)('$name denies another branch before the receipt is read', async (path) => {
    const f = fixture(dispense);
    assign(f, ['branch-a']);
    await expect(path.run(f.caller(), 'branch-b')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const read of reads()) expect(read).not.toHaveBeenCalled();
    expect(f.db.pharmacySale.findMany).not.toHaveBeenCalled();
    expect(buildPharmacyReceiptEscPosJob).not.toHaveBeenCalled();
  });

  it.each(paths)('$name denies a dispenser with no assignment', async (path) => {
    const f = fixture(dispense);
    await expect(path.run(f.caller())).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Branch is outside your scope.',
    });
    for (const read of reads()) expect(read).not.toHaveBeenCalled();
    expect(f.db.pharmacySale.findMany).not.toHaveBeenCalled();
  });

  it.each(paths)('$name denies a session from another organization', async (path) => {
    const f = fixture(dispense, 'ADMIN');
    assign(f, ['branch-a']);
    f.user.organizationId = 'org-b';
    await expect(path.run(f.caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.pharmacyBranchAssignment.findMany).not.toHaveBeenCalled();
    for (const read of reads()) expect(read).not.toHaveBeenCalled();
    expect(f.db.pharmacySale.findMany).not.toHaveBeenCalled();
  });

  it.each(paths)('$name denies when the pharmacy module is off', async (path) => {
    vi.mocked(hasModule).mockReturnValue(false);
    const f = fixture(dispense);
    assign(f, ['branch-a']);
    await expect(path.run(f.caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.user.findUnique).not.toHaveBeenCalled();
    for (const read of reads()) expect(read).not.toHaveBeenCalled();
  });

  it.each(paths)('$name denies an inactive session before the receipt is read', async (path) => {
    const f = fixture(dispense);
    f.user.status = 'INACTIVE';
    await expect(path.run(f.caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.pharmacyBranchAssignment.findMany).not.toHaveBeenCalled();
    for (const read of reads()) expect(read).not.toHaveBeenCalled();
  });

  it('lets an assigned cashier use the receipt, the cart, return history, and cash tender', async () => {
    const f = fixture([
      { capability: 'pharmacy.counter', effect: 'ALLOW' },
      { capability: 'pharmacy:counter', effect: 'ALLOW' },
      { capability: 'pharmacy:orders', effect: 'ALLOW' },
    ]);
    assign(f, ['branch-a']);
    const tender = {
      branchId: 'branch-a',
      saleId: 'sale-a',
      deviceId: 'device-a',
      businessDate: new Date('2026-10-01T00:00:00.000Z'),
      type: 'CASH' as const,
      amountMinor: 100,
      idempotencyKey: 'cash-1',
    };
    await expect(
      f.caller().counterReceipt({ branchId: 'branch-a', saleId: 'sale-a' })
    ).resolves.toMatchObject({ receiptNumber: 7 });
    await expect(
      f.caller().counterCart({ branchId: 'branch-a', saleId: 'sale-a' })
    ).resolves.toMatchObject({ saleId: 'sale-a' });
    await expect(
      f.caller().returnHistory({ branchId: 'branch-a', saleId: 'sale-a' })
    ).resolves.toEqual([{ id: 'return-1' }]);
    await expect(f.caller().tender(tender)).resolves.toEqual({ tenderId: 'tender-1' });
    expect(readCounterCart).toHaveBeenCalled();
    expect(readReturnHistory).toHaveBeenCalled();
    expect(applyPharmacyTender).toHaveBeenCalled();
  });

  it('lets an assigned cashier holding the canonical pharmacy:counter do the same (#163)', async () => {
    // #163 migrates pharmacy.counter grants to pharmacy:counter, and the Cashier template grants it.
    const f = fixture([
      { capability: 'pharmacy:counter', effect: 'ALLOW' },
      { capability: 'pharmacy:orders', effect: 'ALLOW' },
    ]);
    assign(f, ['branch-a']);
    await expect(
      f.caller().counterReceipt({ branchId: 'branch-a', saleId: 'sale-a' })
    ).resolves.toMatchObject({ receiptNumber: 7 });
    await expect(
      f.caller().counterCart({ branchId: 'branch-a', saleId: 'sale-a' })
    ).resolves.toMatchObject({ saleId: 'sale-a' });
    await expect(
      f.caller().returnHistory({ branchId: 'branch-a', saleId: 'sale-a' })
    ).resolves.toEqual([{ id: 'return-1' }]);
    for (const type of ['CASH', 'CARD'] as const) {
      await expect(
        f.caller().tender({
          branchId: 'branch-a',
          saleId: 'sale-a',
          deviceId: 'device-a',
          businessDate: new Date('2026-10-01T00:00:00.000Z'),
          type,
          amountMinor: 100,
          idempotencyKey: `canonical-${type}`,
        })
      ).resolves.toEqual({ tenderId: 'tender-1' });
    }
    expect(readCounterCart).toHaveBeenCalled();
    expect(readReturnHistory).toHaveBeenCalled();
    expect(applyPharmacyTender).toHaveBeenCalledTimes(2);
  });

  it('does not let a user ALLOW override a role DENY when tendering', async () => {
    const f = fixture([{ capability: 'pharmacy:counter', effect: 'DENY' }], 'EMPLOYEE', [
      { capability: 'pharmacy:counter', effect: 'ALLOW' },
    ]);
    assign(f, ['branch-a']);

    await expect(
      f.caller().tender({
        branchId: 'branch-a',
        saleId: 'sale-a',
        deviceId: 'device-a',
        businessDate: new Date('2026-10-01T00:00:00.000Z'),
        type: 'CASH',
        amountMinor: 100,
        idempotencyKey: 'role-deny',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(applyPharmacyTender).not.toHaveBeenCalled();
  });

  it('lets a role DENY on pharmacy:receipt beat a user ALLOW on pharmacy:counter for reads and tender', async () => {
    const f = fixture([{ capability: 'pharmacy:receipt', effect: 'DENY' }], 'EMPLOYEE', [
      { capability: 'pharmacy:counter', effect: 'ALLOW' },
    ]);
    assign(f, ['branch-a']);
    await expect(
      f.caller().counterCart({ branchId: 'branch-a', saleId: 'sale-a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      f.caller().tender({
        branchId: 'branch-a',
        saleId: 'sale-a',
        deviceId: 'device-a',
        businessDate: new Date('2026-10-01T00:00:00.000Z'),
        type: 'CASH',
        amountMinor: 100,
        idempotencyKey: 'cross-alias-deny',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(readCounterCart).not.toHaveBeenCalled();
    expect(applyPharmacyTender).not.toHaveBeenCalled();
  });

  it('lets a user DENY on pharmacy:counter beat a role ALLOW on pharmacy:receipt', async () => {
    const f = fixture([{ capability: 'pharmacy:receipt', effect: 'ALLOW' }], 'EMPLOYEE', [
      { capability: 'pharmacy:counter', effect: 'DENY' },
    ]);
    assign(f, ['branch-a']);
    await expect(
      f.caller().counterCart({ branchId: 'branch-a', saleId: 'sale-a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(readCounterCart).not.toHaveBeenCalled();
  });

  it('denies counter reads and cash tender when the cashier is not assigned', async () => {
    const f = fixture([{ capability: 'pharmacy.counter', effect: 'ALLOW' }]);
    await expect(
      f.caller().counterCart({ branchId: 'branch-a', saleId: 'sale-a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
    await expect(
      f.caller().returnHistory({ branchId: 'branch-a', saleId: 'sale-a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      f.caller().tender({
        branchId: 'branch-a',
        saleId: 'sale-a',
        deviceId: 'device-a',
        businessDate: new Date('2026-10-01T00:00:00.000Z'),
        type: 'CASH',
        amountMinor: 100,
        idempotencyKey: 'cash-2',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(readCounterCart).not.toHaveBeenCalled();
    expect(readReturnHistory).not.toHaveBeenCalled();
    expect(applyPharmacyTender).not.toHaveBeenCalled();
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'refundTender',
      run: (caller: Caller) =>
        caller.refundTender({
          branchId: 'branch-a',
          originalTenderId: 'tender-1',
          deviceId: 'device-a',
          businessDate: new Date('2026-10-01T00:00:00.000Z'),
          amountMinor: 100,
          reason: 'Returned medicine',
          idempotencyKey: 'refund-1',
        }),
      write: refundPharmacyTender,
    },
    {
      name: 'returnLine',
      run: (caller: Caller) =>
        caller.returnLine({
          branchId: 'branch-a',
          saleLineId: 'line-1',
          canonicalUnits: 1,
          reason: 'Returned medicine',
          integrityDecision: 'Sealed pack',
          idempotencyKey: 'return-1',
        }),
      write: returnSaleLine,
    },
  ])('$name requires counter capability and assignment before writing (#578)', async (path) => {
    const noCapability = fixture([]);
    assign(noCapability, ['branch-a']);
    await expect(path.run(noCapability.caller())).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
    expect(noCapability.db.$transaction).not.toHaveBeenCalled();

    const unassigned = fixture(dispense);
    await expect(path.run(unassigned.caller())).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Branch is outside your scope.',
    });
    expect(unassigned.db.$transaction).not.toHaveBeenCalled();
    expect(path.write).not.toHaveBeenCalled();
  });

  it.each(['*', 'pharmacy:*', 'pharmacy:counter'])(
    'allows Khata tender with %s on the assigned branch',
    async (capability) => {
      const f = fixture([{ capability, effect: 'ALLOW' }]);
      assign(f, ['branch-a']);
      f.db.$transaction.mockRejectedValue(new Error('khata-reached'));
      await expect(
        f.caller().tender({
          branchId: 'branch-a',
          saleId: 'sale-a',
          deviceId: 'device-a',
          businessDate: new Date('2026-10-01T00:00:00.000Z'),
          type: 'KHATA',
          amountMinor: 100,
          familyAccountId: 'family-1',
          idempotencyKey: 'khata-1',
        })
      ).rejects.toThrow('khata-reached');
      expect(f.db.pharmacyBranchAssignment.findMany).toHaveBeenCalled();
      expect(applyPharmacyTender).not.toHaveBeenCalled();
    }
  );

  it('denies Khata tender when the cashier has no branch assignment', async () => {
    const f = fixture([{ capability: 'pharmacy:counter', effect: 'ALLOW' }]);
    await expect(
      f.caller().tender({
        branchId: 'branch-a',
        saleId: 'sale-a',
        deviceId: 'device-a',
        businessDate: new Date('2026-10-01T00:00:00.000Z'),
        type: 'KHATA',
        amountMinor: 100,
        familyAccountId: 'family-1',
        idempotencyKey: 'khata-1',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
    expect(f.db.pharmacyBranchAssignment.findMany).toHaveBeenCalled();
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(applyPharmacyTender).not.toHaveBeenCalled();
  });

  it('denies Khata tender with clinical dispense access alone', async () => {
    const f = fixture(dispense);
    await expect(
      f.caller().tender({
        branchId: 'branch-a',
        saleId: 'sale-a',
        deviceId: 'device-a',
        businessDate: new Date('2026-10-01T00:00:00.000Z'),
        type: 'KHATA',
        amountMinor: 100,
        familyAccountId: 'family-1',
        idempotencyKey: 'khata-clinical-only',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(applyPharmacyTender).not.toHaveBeenCalled();
  });

  it('denies pharmacy orders alone', async () => {
    const f = fixture([{ capability: 'pharmacy:orders', effect: 'ALLOW' }]);
    assign(f, ['branch-a']);
    await expect(
      f.caller().counterCart({ branchId: 'branch-a', saleId: 'sale-a' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
    expect(f.db.pharmacyBranchAssignment.findMany).not.toHaveBeenCalled();
    expect(readCounterCart).not.toHaveBeenCalled();
  });

  it('allows pharmacy.dispense and pharmacy:receipt when the branch is assigned', async () => {
    for (const capability of [
      'pharmacy.dispense',
      'pharmacy:receipt',
      'pharmacy.receipt',
    ] as const) {
      const f = fixture([{ capability, effect: 'ALLOW' }]);
      assign(f, ['branch-a']);
      await expect(
        f.caller().counterReceipt({ branchId: 'branch-a', saleId: 'sale-a' })
      ).resolves.toMatchObject({ receiptNumber: 7 });
    }
  });

  it('lets a DENY on any counter capability alias override an ALLOW on another', async () => {
    const denied = fixture([
      { capability: 'pharmacy:counter', effect: 'ALLOW' },
      { capability: 'pharmacy.receipt', effect: 'DENY' },
    ]);
    assign(denied, ['branch-a']);

    await expect(
      denied.caller().tender({
        branchId: 'branch-a',
        saleId: 'sale-a',
        deviceId: 'device-a',
        businessDate: new Date('2026-10-01T00:00:00.000Z'),
        type: 'CASH',
        amountMinor: 100,
        idempotencyKey: 'alias-deny',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(applyPharmacyTender).not.toHaveBeenCalled();
  });

  it('does not treat wildcard, prefix, legacy, or receipt grants as dispense grants', async () => {
    for (const capability of ['*', 'pharmacy:*', 'pharmacy.dispense', 'pharmacy:receipt']) {
      const f = fixture([{ capability, effect: 'ALLOW' }]);
      await expect(
        f.caller().redeemPoints({
          branchId: 'branch-a',
          saleId: 'sale-a',
          points: 1,
          deviceId: 'device-a',
          businessDate: new Date('2026-10-01T00:00:00.000Z'),
          idempotencyKey: `redeem-${capability}`,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('denies an inactive database user and an inactive assignment', async () => {
    const inactive = fixture(dispense);
    inactive.db.user.findUnique.mockResolvedValue({
      status: 'INACTIVE',
      organizationId: 'org-a',
      organizationRole: { permissions: dispense },
      permissionOverrides: [],
    });
    await expect(
      inactive.caller().counterReceipt({ branchId: 'branch-a', saleId: 'sale-a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(inactive.db.pharmacyBranchAssignment.findMany).not.toHaveBeenCalled();

    const paused = fixture(dispense);
    await expect(
      paused.caller().lookupReceiptByNumber({ branchId: 'branch-a', receiptNumber: 7 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(paused.db.pharmacySale.findMany).not.toHaveBeenCalled();
  });

  it('lets a session admin of this organization read without an assignment and records why', async () => {
    const f = fixture(dispense, 'ADMIN');
    await expect(
      f.caller().counterReceipt({ branchId: 'branch-a', saleId: 'sale-a' })
    ).resolves.toMatchObject({
      receiptNumber: 7,
    });
    expect(f.context.audit.detail).toMatchObject({
      targetType: 'PharmacyBranch',
      targetId: 'branch-a',
      metadata: {
        branchId: 'branch-a',
        reason: 'org-admin-receipt-access-without-branch-assignment',
      },
    });
  });

  it('does not treat a custom organization role as an administrator', async () => {
    const custom = fixture([{ capability: 'pharmacy:dispense', effect: 'ALLOW' }]);
    custom.user.role = 'EMPLOYEE';
    await expect(
      custom.caller().counterReceiptFormat({ branchId: 'branch-a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lets a session admin read a branch they are not assigned to even when another branch is', async () => {
    const admin = fixture(dispense, 'ADMIN');
    assign(admin, ['branch-b']);
    await expect(
      admin.caller().counterReceiptPrintJob({
        branchId: 'branch-a',
        saleId: 'sale-a',
        locale: 'en',
        reprint: true,
      })
    ).resolves.toMatchObject({ status: 'READY', reprint: true });
    expect(admin.context.audit.detail).toMatchObject({
      metadata: { reason: 'org-admin-receipt-access' },
    });
  });

  it('requires an active branch before an administrator saves the receipt format', async () => {
    const layout = {
      version: 1 as const,
      paperWidth: 80 as const,
      businessText: '',
      headerText: '',
      footerText: 'Thank you.',
      showOrderNumber: true,
      showChannel: true,
    };
    vi.mocked(savePharmacyReceiptFormat).mockResolvedValue({ layout, revision: 1 });
    const admin = fixture(dispense, 'ADMIN');
    await expect(
      admin.caller().counterSaveReceiptFormat({ branchId: 'branch-a', revision: 0, layout })
    ).resolves.toMatchObject({ revision: 1 });
    expect(savePharmacyReceiptFormat).toHaveBeenCalledWith(
      admin.db,
      'org-a',
      expect.objectContaining({ branchId: 'branch-a' })
    );

    vi.mocked(savePharmacyReceiptFormat).mockClear();
    await expect(
      admin.caller().counterSaveReceiptFormat({ branchId: 'closed-branch', revision: 0, layout })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
    expect(savePharmacyReceiptFormat).not.toHaveBeenCalled();

    const cashier = fixture([{ capability: 'pharmacy.counter', effect: 'ALLOW' }]);
    await expect(
      cashier.caller().counterSaveReceiptFormat({ branchId: 'branch-a', revision: 0, layout })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('denies a branch that is not in the session organization before the sale is read', async () => {
    const f = fixture(dispense, 'ADMIN');
    await expect(
      f.caller().counterReceipt({ branchId: 'foreign-branch', saleId: 'sibling-sale' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(readCounterReceipt).not.toHaveBeenCalled();
    expect(f.db.pharmacyBranch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['foreign-branch'] },
          organizationId: 'org-a',
          active: true,
        }),
      })
    );
  });
});
