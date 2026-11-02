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
  readReturnHistory: vi.fn(async () => [{ id: 'return-1' }]),
}));
vi.mock('@/lib/pharmacy/settlement', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/settlement')>()),
  applyPharmacyTender: vi.fn(async () => ({ tenderId: 'tender-1' })),
  openPharmacyDrawer: vi.fn(async () => ({ id: 'drawer-1' })),
  recordPharmacyCashMovement: vi.fn(async () => ({ id: 'movement-1' })),
  closePharmacyDrawer: vi.fn(async () => ({ id: 'drawer-1', status: 'CLOSED' })),
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
import { readReturnHistory } from '@/lib/pharmacy/sales';
import {
  applyPharmacyTender,
  closePharmacyDrawer,
  openPharmacyDrawer,
  recordPharmacyCashMovement,
} from '@/lib/pharmacy/settlement';
import {
  buildPharmacyReceiptEscPosJob,
  readPharmacyReceiptFormat,
  savePharmacyReceiptFormat,
} from '@/lib/pharmacy/receipt-print';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

type Permission = { capability: string; effect: 'ALLOW' | 'DENY' };

const dispense: Permission[] = [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }];

function fixture(permissions: Permission[], role: 'EMPLOYEE' | 'ADMIN' = 'EMPLOYEE') {
  const db = {
    user: {
      findUnique: vi.fn(async () => ({
        status: 'ACTIVE',
        organizationId: 'org-a',
        organizationRole: { permissions },
        permissionOverrides: [] as Permission[],
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

const reads = () => [readCounterReceipt, readPharmacyReceiptFormat, readDispensingLabelSources];

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

  it('keeps Khata tender off the branch-assignment guard', async () => {
    const f = fixture(dispense);
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
    expect(f.db.pharmacyBranchAssignment.findMany).not.toHaveBeenCalled();
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

const drawerPaths: { name: string; run: (caller: Caller) => Promise<unknown> }[] = [
  {
    name: 'openDrawer',
    run: (caller) =>
      caller.openDrawer({
        branchId: 'branch-a',
        deviceId: 'device-a',
        businessDate: new Date('2026-10-01T00:00:00.000Z'),
        openingFloatMinor: 500,
      }),
  },
  {
    name: 'drawerMovement',
    run: (caller) =>
      caller.drawerMovement({
        branchId: 'branch-a',
        drawerSessionId: 'drawer-1',
        kind: 'PAID_OUT',
        amountMinor: 100,
        reason: 'Petty cash',
      }),
  },
  {
    name: 'closeDrawer',
    run: (caller) =>
      caller.closeDrawer({
        branchId: 'branch-a',
        drawerSessionId: 'drawer-1',
        countedCashMinor: 400,
      }),
  },
];

describe('cash drawer authorization (#343)', () => {
  it.each(drawerPaths)(
    '$name denies an organization member without a counter capability',
    async (path) => {
      const f = fixture([]);
      assign(f, ['branch-a']);
      await expect(path.run(f.caller())).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'You do not have permission for this action.',
      });
      expect(f.db.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(drawerPaths)(
    '$name denies a counter operator without a branch assignment',
    async (path) => {
      const f = fixture([{ capability: 'pharmacy:counter', effect: 'ALLOW' }]);
      await expect(path.run(f.caller())).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Branch is outside your scope.',
      });
      expect(f.db.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(drawerPaths)('$name allows an assigned counter operator', async (path) => {
    const f = fixture([{ capability: 'pharmacy:counter', effect: 'ALLOW' }]);
    assign(f, ['branch-a']);
    await expect(path.run(f.caller())).resolves.toBeDefined();
    expect(f.db.$transaction).toHaveBeenCalledTimes(1);
  });

  it.each(drawerPaths)('$name keeps DENY stronger than ALLOW', async (path) => {
    const f = fixture([{ capability: 'pharmacy:counter', effect: 'ALLOW' }]);
    f.db.user.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      organizationId: 'org-a',
      organizationRole: {
        permissions: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }],
      },
      permissionOverrides: [{ capability: 'pharmacy:counter', effect: 'DENY' }],
    });
    assign(f, ['branch-a']);
    await expect(path.run(f.caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });

  it.each(drawerPaths)('$name lets a user-level ALLOW override a role DENY', async (path) => {
    const f = fixture([{ capability: 'pharmacy:counter', effect: 'DENY' }]);
    f.db.user.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      organizationId: 'org-a',
      organizationRole: {
        permissions: [{ capability: 'pharmacy:counter', effect: 'DENY' }],
      },
      permissionOverrides: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }],
    });
    assign(f, ['branch-a']);
    await expect(path.run(f.caller())).resolves.toBeDefined();
    expect(f.db.$transaction).toHaveBeenCalledTimes(1);
  });

  it.each(drawerPaths)(
    '$name does not accept dispense authority as counter authority',
    async (path) => {
      const f = fixture([{ capability: 'pharmacy:dispense', effect: 'ALLOW' }]);
      assign(f, ['branch-a']);
      await expect(path.run(f.caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.$transaction).not.toHaveBeenCalled();
    }
  );

  it('routes each allowed operation to its settlement command', async () => {
    const f = fixture([{ capability: 'pharmacy:counter', effect: 'ALLOW' }]);
    assign(f, ['branch-a']);
    for (const path of drawerPaths) await path.run(f.caller());
    expect(openPharmacyDrawer).toHaveBeenCalledTimes(1);
    expect(recordPharmacyCashMovement).toHaveBeenCalledTimes(1);
    expect(closePharmacyDrawer).toHaveBeenCalledTimes(1);
  });
});
