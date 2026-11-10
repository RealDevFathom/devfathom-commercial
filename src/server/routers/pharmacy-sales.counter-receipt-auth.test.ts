import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';

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
  createSale: vi.fn(async () => ({ id: 'sale-new' })),
  changeSaleStatus: vi.fn(async () => ({ sale: { id: 'sale-a', status: 'HELD' } })),
  readReturnHistory: vi.fn(async () => [{ id: 'return-1' }]),
  returnSaleLine: vi.fn(async () => ({ returnLineId: 'return-line-1' })),
}));
vi.mock('@/lib/pharmacy/regulatory', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/regulatory')>()),
  assertStoredPharmacyMayOperate: vi.fn(async () => undefined),
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

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { hasModule } from '@/lib/entitlements';
import { readCounterCart, readCounterReceipt } from '@/lib/pharmacy/counter';
import { readDispensingLabelSources } from '@/lib/pharmacy/dispensing-label-source';
import {
  changeSaleStatus,
  createSale,
  readReturnHistory,
  returnSaleLine,
} from '@/lib/pharmacy/sales';
import { applyPharmacyTender, refundPharmacyTender } from '@/lib/pharmacy/settlement';
import { RawPrintValidationError } from '@/lib/restaurant/printing/contract';
import {
  assertStoredPharmacyMayOperate,
  BranchOperationDeniedError,
} from '@/lib/pharmacy/regulatory';
import {
  buildPharmacyReceiptEscPosJob,
  readPharmacyReceiptFormat,
  readPharmacyReceiptTaxIdentity,
  savePharmacyReceiptFormat,
} from '@/lib/pharmacy/receipt-print';
import { router, type TRPCContext } from '../trpc';
import { canAccessPharmacyCounter, pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

type Permission = { capability: string; effect: 'ALLOW' | 'DENY' };

const dispense: Permission[] = [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }];

function fixture(
  permissions: Permission[],
  role: 'EMPLOYEE' | 'ADMIN' = 'EMPLOYEE',
  overrides: Permission[] = []
) {
  let printCopyCount = 0;
  const db = {
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
    auditLog: { create: vi.fn(async () => ({ id: 'audit-a' })) },
    $queryRaw: vi.fn(async () => [{ copyCount: ++printCopyCount }]),
    $executeRaw: vi.fn<(query: Prisma.Sql) => Promise<number>>(async () => 1),
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
  vi.mocked(assertStoredPharmacyMayOperate).mockResolvedValue(undefined);
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

describe('DEV-52 server-authorized Counter navigation', () => {
  const access = (f: ReturnType<typeof fixture>) =>
    canAccessPharmacyCounter(f.context as unknown as TRPCContext);

  it('refuses an assigned Procurement employee in a licensed pharmacy', async () => {
    const template = PHARMACY_ROLE_TEMPLATES.find((role) => role.key === 'procurement')!;
    const f = fixture(template.capabilities.map((capability) => ({ capability, effect: 'ALLOW' })));
    assign(f, ['branch-a']);
    await expect(access(f)).resolves.toBe(false);
  });

  it.each([
    'pharmacy:counter', 'pharmacy.counter', 'pharmacy:receipt', 'pharmacy.receipt',
    'pharmacy:dispense', 'pharmacy.dispense',
  ])('preserves assigned counter access through %s', async (capability) => {
    const f = fixture([{ capability, effect: 'ALLOW' }]);
    assign(f, ['branch-a']);
    await expect(access(f)).resolves.toBe(true);
    expect(f.db.pharmacyBranch.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a', active: true,
        branchAssignments: { some: { organizationId: 'org-a', userId: 'user-a', active: true } },
      },
      select: { id: true },
    });
  });

  it('honors an explicit DENY on another counter-family alias', async () => {
    const f = fixture(
      [{ capability: 'pharmacy:counter', effect: 'ALLOW' }],
      'EMPLOYEE',
      [{ capability: 'pharmacy.receipt', effect: 'DENY' }]
    );
    assign(f, ['branch-a']);
    await expect(access(f)).resolves.toBe(false);
  });

  it('refuses an unassigned member and preserves the granted administrator exception', async () => {
    await expect(access(fixture(dispense))).resolves.toBe(false);
    const admin = fixture([{ capability: 'pharmacy:*', effect: 'ALLOW' }], 'ADMIN');
    await expect(access(admin)).resolves.toBe(true);
    expect(admin.context.audit.detail).toEqual({});
    await expect(access(fixture([], 'ADMIN'))).resolves.toBe(false);
  });

  it('refuses missing active branches, inactive members and tenant mismatches', async () => {
    const f = fixture(dispense);
    assign(f, ['branch-a']);
    f.db.pharmacyBranch.findFirst.mockResolvedValueOnce(null);
    await expect(access(f)).resolves.toBe(false);
    f.db.user.findUnique.mockResolvedValueOnce({
      status: 'DISABLED', organizationId: 'org-a',
      organizationRole: { permissions: dispense }, permissionOverrides: [],
    });
    await expect(access(f)).resolves.toBe(false);
    f.user.organizationId = 'another-org';
    await expect(access(f)).resolves.toBe(false);
  });

  it('requires the counter license and propagates unexpected database failures', async () => {
    const f = fixture(dispense);
    vi.mocked(hasModule).mockReturnValueOnce(false);
    await expect(access(f)).resolves.toBe(false);
    expect(f.db.pharmacyBranch.findFirst).not.toHaveBeenCalled();
    f.db.pharmacyBranch.findFirst.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(access(f)).rejects.toThrow('database unavailable');
  });
});

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
      caller.counterReceiptPrintJob({ branchId, saleId: 'sale-a', locale: 'en' }),
    allowed: { status: 'READY', reprint: false },
  },
  {
    name: 'counterReceiptBrowserPrint',
    run: (caller, branchId = 'branch-a') =>
      caller.counterReceiptBrowserPrint({ branchId, saleId: 'sale-a', locale: 'en' }),
    allowed: { reprint: false, copyNumber: 1 },
  },
  {
    name: 'counterReceiptBrowserPrintFailed',
    run: (caller, branchId = 'branch-a') =>
      caller.counterReceiptBrowserPrintFailed({ branchId, saleId: 'sale-a', locale: 'en' }),
    allowed: { recorded: true },
  },
  {
    name: 'counterReceiptBrowserPrintDispatched',
    run: (caller, branchId = 'branch-a') =>
      caller.counterReceiptBrowserPrintDispatched({
        branchId,
        saleId: 'sale-a',
        locale: 'en',
        copyNumber: 1,
      }),
    allowed: { recorded: true },
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
  it.each<[string, (caller: Caller) => Promise<unknown>]>([
    ['create', (caller: Caller) => caller.create({ branchId: 'branch-a', quotation: false })],
    [
      'settle',
      (caller: Caller) =>
        caller.tender({
          branchId: 'branch-a',
          saleId: 'sale-a',
          deviceId: 'device-a',
          businessDate: new Date('2026-10-01T00:00:00.000Z'),
          type: 'CASH',
          amountMinor: 100,
          idempotencyKey: 'regulated-operation',
        }),
    ],
  ])('maps a shared %s regulatory denial to FORBIDDEN', async (name, run) => {
    const f = fixture([{ capability: 'pharmacy:counter', effect: 'ALLOW' }], 'ADMIN');
    // The gate now lives inside createSale/applyPharmacyTender so every caller shares it.
    const denied = new BranchOperationDeniedError('PROFILE_MISSING');
    if (name === 'create') vi.mocked(createSale).mockRejectedValueOnce(denied);
    else vi.mocked(applyPharmacyTender).mockRejectedValueOnce(denied);

    await expect(run(f.caller())).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'PROFILE_MISSING',
    });
    expect(f.db.$transaction).toHaveBeenCalled();
  });

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

  // Receipt lookup never refuses an unassigned branch: it answers "not found" without reading.
  const branchBound = paths.filter((path) => path.name !== 'lookupReceiptByNumber');

  it.each(branchBound)('$name denies another branch before the receipt is read', async (path) => {
    const f = fixture(dispense);
    assign(f, ['branch-a']);
    await expect(path.run(f.caller(), 'branch-b')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const read of reads()) expect(read).not.toHaveBeenCalled();
    expect(f.db.pharmacySale.findMany).not.toHaveBeenCalled();
    expect(buildPharmacyReceiptEscPosJob).not.toHaveBeenCalled();
  });

  it.each(branchBound)('$name denies a dispenser with no assignment', async (path) => {
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

  it('lets an assigned cashier holding canonical pharmacy:counter use every counter workflow (DEV-295)', async () => {
    // DEV-295: the Cashier template grants pharmacy:counter, so this must work without
    // also granting its legacy pharmacy.counter alias.
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

  it.each(['pharmacy:dispense', 'reports:financial'])(
    'denies Khata tender with %s access alone',
    async (capability) => {
      const f = fixture([{ capability, effect: 'ALLOW' }]);
      await expect(
        f.caller().tender({
          branchId: 'branch-a',
          saleId: 'sale-a',
          deviceId: 'device-a',
          businessDate: new Date('2026-10-01T00:00:00.000Z'),
          type: 'KHATA',
          amountMinor: 100,
          familyAccountId: 'family-1',
          idempotencyKey: 'khata-denied',
        })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Pharmacy counter permission required.',
      });
      expect(f.db.$transaction).not.toHaveBeenCalled();
      expect(f.db.pharmacyBranchAssignment.findMany).not.toHaveBeenCalled();
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

  it('denies finance-only Khata account reads without a branch assignment', async () => {
    const f = fixture([{ capability: 'reports:financial', effect: 'ALLOW' }]);
    await expect(
      f.caller().khataAccounts({ branchId: 'branch-a', saleId: 'sale-a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
    expect(f.db.pharmacyBranchAssignment.findMany).toHaveBeenCalled();
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

    // Without an active assignment, lookup has no branch to search: the same "not found".
    const paused = fixture(dispense);
    await expect(
      paused.caller().lookupReceiptByNumber({ branchId: 'branch-a', receiptNumber: 7 })
    ).resolves.toEqual([]);
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
      })
    ).resolves.toMatchObject({ status: 'READY', reprint: false, copyNumber: 1 });
    expect(admin.context.audit.detail).toMatchObject({
      metadata: { reason: 'org-admin-receipt-access' },
    });
  });

  describe.each([
    'counterReceiptBrowserPrint',
    'counterReceiptBrowserPrintDispatched',
  ] as const)('%s sale ID bounds', (procedure) => {
    const call = (caller: Caller, saleId: string) => {
      const input = { branchId: 'branch-a', saleId, locale: 'en' as const };
      return procedure === 'counterReceiptBrowserPrint'
        ? caller.counterReceiptBrowserPrint(input)
        : caller.counterReceiptBrowserPrintDispatched({ ...input, copyNumber: 1 });
    };

    it.each([0, 129])(
      'rejects a %i-character sale ID in direct tRPC calls before receipt or print-state access',
      async (length) => {
        const f = fixture(dispense, 'ADMIN');

        await expect(call(f.caller(), 's'.repeat(length))).rejects.toMatchObject({
          code: 'BAD_REQUEST',
        });
        expect(readCounterReceipt).not.toHaveBeenCalled();
        expect(f.db.$transaction).not.toHaveBeenCalled();
        expect(f.db.$queryRaw).not.toHaveBeenCalled();
        expect(f.db.$executeRaw).not.toHaveBeenCalled();
      }
    );

    it('accepts a 128-character sale ID in direct tRPC calls', async () => {
      const f = fixture(dispense, 'ADMIN');

      await expect(call(f.caller(), 's'.repeat(128))).resolves.toMatchObject(
        procedure === 'counterReceiptBrowserPrint'
          ? { copyNumber: 1, reprint: false }
          : { recorded: true }
      );
      expect(f.db.$executeRaw).toHaveBeenCalledTimes(1);
    });
  });

  it.each(['counterReceiptPrintJob', 'counterReceiptBrowserPrint'] as const)(
    '%s rejects a caller-controlled marker before receipt or allocation access',
    async (procedure) => {
      const f = fixture(dispense, 'ADMIN');
      await expect(f.caller()[procedure]({
        branchId: 'branch-a', saleId: 'sale-a', locale: 'en', reprint: false,
      } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(readCounterReceipt).not.toHaveBeenCalled();
      expect(f.db.$transaction).not.toHaveBeenCalled();
      expect(f.db.$queryRaw).not.toHaveBeenCalled();
      expect(f.db.$executeRaw).not.toHaveBeenCalled();
    }
  );

  it('allocates one original then durably marks and audits every later copy', async () => {
    const f = fixture(dispense, 'ADMIN');
    const input = { branchId: 'branch-a', saleId: 'sale-a', locale: 'en' as const };

    await expect(f.caller().counterReceiptPrintJob(input)).resolves.toMatchObject({
      reprint: false,
      copyNumber: 1,
    });
    await expect(f.caller().counterReceiptPrintJob(input)).resolves.toMatchObject({
      reprint: true,
      copyNumber: 2,
    });

    expect(f.db.$queryRaw).toHaveBeenCalledTimes(2);
    expect(f.db.$executeRaw).toHaveBeenCalledTimes(2);
    expect(buildPharmacyReceiptEscPosJob).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'en',
      expect.objectContaining({ reprint: true })
    );
  });

  it('shares durable copy numbering between browser and ESC/POS transports', async () => {
    const f = fixture(dispense, 'ADMIN');
    const input = { branchId: 'branch-a', saleId: 'sale-a', locale: 'en' as const };

    await expect(f.caller().counterReceiptBrowserPrint(input)).resolves.toEqual({
      reprint: false,
      copyNumber: 1,
    });
    await expect(f.caller().counterReceiptPrintJob(input)).resolves.toMatchObject({
      reprint: true,
      copyNumber: 2,
    });
    // Browser allocation binding + thermal dispatch audit.
    expect(f.db.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('durably audits failed browser preflight without consuming the original', async () => {
    const f = fixture(dispense, 'ADMIN');
    const input = { branchId: 'branch-a', saleId: 'sale-a', locale: 'en' as const };
    await expect(f.caller().counterReceiptBrowserPrintFailed(input)).resolves.toEqual({ recorded: true });
    expect(f.db.auditLog.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        organizationId: 'org-a', actorId: 'user-a', outcome: 'FAILURE',
        targetId: 'sale-a', errorCode: 'BROWSER_PRINT_NOT_READY',
        metadata: { branchId: 'branch-a', locale: 'en' },
      }),
    });
    expect(f.db.$queryRaw).not.toHaveBeenCalled();
    expect(f.db.$executeRaw).not.toHaveBeenCalled();
    await expect(f.caller().counterReceiptPrintJob(input)).resolves.toMatchObject({
      copyNumber: 1, reprint: false,
    });
  });

  it('binds each browser allocation to the requesting operator and locale', async () => {
    const f = fixture(dispense, 'ADMIN');
    const input = { branchId: 'branch-a', saleId: 'sale-a', locale: 'ur' as const };

    await expect(f.caller().counterReceiptBrowserPrint(input)).resolves.toEqual({
      copyNumber: 1,
      reprint: false,
    });
    const binding = vi.mocked(f.db.$executeRaw).mock.calls[0]![0] as unknown as {
      sql: string;
      values: unknown[];
    };
    expect(binding.sql).toContain('"pharmacy_receipt_print_allocations"');
    expect(binding.values).toEqual(
      expect.arrayContaining(['org-a', 'branch-a', 'sale-a', 1, 'user-a', 'ur'])
    );
  });

  it('records a browser dispatch only against the caller\'s own allocation', async () => {
    const f = fixture(dispense, 'ADMIN');
    const input = { branchId: 'branch-a', saleId: 'sale-a', locale: 'en' as const, copyNumber: 1 };

    await expect(f.caller().counterReceiptBrowserPrintDispatched(input)).resolves.toEqual({
      recorded: true,
    });
    const insert = vi.mocked(f.db.$executeRaw).mock.calls[0]![0] as unknown as {
      sql: string;
      values: unknown[];
    };
    expect(insert.sql).toContain('FROM "pharmacy_receipt_print_allocations"');
    expect(insert.sql).toContain('"actorId" =');
    expect(insert.sql).toContain('"locale" =');
    expect(insert.values).toEqual(expect.arrayContaining(['user-a', 'en', 1]));
  });

  it('treats a repeated confirmation of a recorded allocation as idempotent success', async () => {
    const f = fixture(dispense, 'ADMIN');
    vi.mocked(f.db.$executeRaw).mockResolvedValueOnce(0);
    vi.mocked(f.db.$queryRaw).mockResolvedValueOnce([{ recorded: true }] as never);

    await expect(
      f.caller().counterReceiptBrowserPrintDispatched({
        branchId: 'branch-a',
        saleId: 'sale-a',
        locale: 'en',
        copyNumber: 1,
      })
    ).resolves.toEqual({ recorded: true });
  });

  it('rejects confirming an allocation that belongs to another operator or locale', async () => {
    const f = fixture(dispense, 'ADMIN');
    vi.mocked(f.db.$executeRaw).mockResolvedValueOnce(0);
    vi.mocked(f.db.$queryRaw).mockResolvedValueOnce([] as never);

    await expect(
      f.caller().counterReceiptBrowserPrintDispatched({
        branchId: 'branch-a',
        saleId: 'sale-a',
        locale: 'en',
        copyNumber: 1,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('does not consume the original copy when thermal validation falls back inside a tenant transaction', async () => {
    // ScopedDb reuses the request's transaction, so a caught validation error
    // does not roll back an allocation made before the error.
    const f = fixture(dispense, 'ADMIN');
    const input = { branchId: 'branch-a', saleId: 'sale-a', locale: 'en' as const };
    vi.mocked(buildPharmacyReceiptEscPosJob).mockImplementationOnce(() => {
      throw new RawPrintValidationError('UNSUPPORTED_PRINT_TEXT');
    });

    await expect(f.caller().counterReceiptPrintJob(input)).resolves.toMatchObject({
      status: 'FALLBACK',
      fallback: 'BROWSER_OS',
    });
    expect(f.db.$queryRaw).not.toHaveBeenCalled();
    expect(f.db.$executeRaw).not.toHaveBeenCalled();

    await expect(f.caller().counterReceiptBrowserPrint(input)).resolves.toEqual({
      copyNumber: 1,
      reprint: false,
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

  describe('receipt lookup scope', () => {
    const sales = [
      { id: 'sale-a', branchId: 'branch-a', receiptNumber: 7 },
      { id: 'sale-a2', branchId: 'branch-a', receiptNumber: 8 },
      { id: 'sale-b', branchId: 'branch-b', receiptNumber: 8 },
      { id: 'sale-b9', branchId: 'branch-b', receiptNumber: 9 },
    ];
    type LookupArgs = {
      where: {
        organizationId: string;
        branchId: string | { in: string[] };
        receiptNumber: number;
        status: string;
      };
      take: number;
    };
    function lookupFixture(assigned: string[], role?: 'ADMIN') {
      const f = fixture(dispense, role);
      assign(f, assigned);
      const find = async ({ where, take }: LookupArgs) =>
        sales
          .filter((sale) =>
            typeof where.branchId === 'string'
              ? sale.branchId === where.branchId
              : where.branchId.in.includes(sale.branchId)
          )
          .filter((sale) => sale.receiptNumber === where.receiptNumber)
          .slice(0, take)
          .map((sale) => ({
            ...sale,
            receiptDeviceId: 'device-a',
            businessDate: new Date('2026-10-01T00:00:00.000Z'),
          }));
      f.db.pharmacySale.findMany.mockImplementation(find as never);
      return f;
    }
    type LookupCall = [LookupArgs];
    const searchedBranches = (f: ReturnType<typeof fixture>) =>
      (f.db.pharmacySale.findMany.mock.calls as unknown as LookupCall[]).flatMap(
        ([args]) =>
          typeof args.where.branchId === 'string' ? [args.where.branchId] : args.where.branchId.in
      );

    it('finds a receipt in the cashier own active branch', async () => {
      const f = lookupFixture(['branch-a']);
      await expect(
        f.caller().lookupReceiptByNumber({ branchId: 'branch-a', receiptNumber: 7 })
      ).resolves.toEqual([expect.objectContaining({ id: 'sale-a' })]);
      expect(searchedBranches(f)).toEqual(['branch-a']);
    });

    it('searches all assigned branches with active-branch matches first', async () => {
      // Assignment order must not decide which matching receipt appears first.
      const f = lookupFixture(['branch-b', 'branch-a']);
      await expect(
        f.caller().lookupReceiptByNumber({ branchId: 'branch-a', receiptNumber: 8 })
      ).resolves.toEqual([
        expect.objectContaining({ id: 'sale-a2' }),
        expect.objectContaining({ id: 'sale-b' }),
      ]);
      expect(searchedBranches(f)).toEqual(['branch-a', 'branch-b']);
      expect(f.db.pharmacySale.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: {
            organizationId: 'org-a',
            branchId: 'branch-a',
            receiptNumber: 8,
            status: 'COMPLETED',
          },
          take: 50,
        })
      );
      expect(f.db.pharmacySale.findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: {
            organizationId: 'org-a',
            branchId: { in: ['branch-b'] },
            receiptNumber: 8,
            status: 'COMPLETED',
          },
          take: 49,
        })
      );
    });

    it('finds a receipt held only in another assigned branch', async () => {
      const f = lookupFixture(['branch-a', 'branch-b']);
      await expect(
        f.caller().lookupReceiptByNumber({ branchId: 'branch-a', receiptNumber: 9 })
      ).resolves.toEqual([expect.objectContaining({ id: 'sale-b9' })]);
      expect(searchedBranches(f)).toEqual(['branch-a', 'branch-b']);
    });

    it('answers "not found" for a receipt held by another branch', async () => {
      const f = lookupFixture(['branch-a']);
      const api = f.caller();
      const branchId = 'branch-a';
      const foreign = await api.lookupReceiptByNumber({ branchId, receiptNumber: 9 });
      const missing = await api.lookupReceiptByNumber({ branchId, receiptNumber: 99999 });
      expect(foreign).toEqual([]);
      expect(foreign).toEqual(missing);
      expect(searchedBranches(f)).not.toContain('branch-b');
    });

    it('does not reveal scope when the active branch is not assigned', async () => {
      const f = lookupFixture(['branch-a']);
      await expect(
        f.caller().lookupReceiptByNumber({ branchId: 'branch-b', receiptNumber: 8 })
      ).resolves.toEqual([]);
      expect(f.db.pharmacySale.findMany).not.toHaveBeenCalled();

      const none = lookupFixture([]);
      await expect(
        none.caller().lookupReceiptByNumber({ branchId: 'branch-a', receiptNumber: 7 })
      ).resolves.toEqual([]);
      expect(none.db.pharmacySale.findMany).not.toHaveBeenCalled();
    });

    it('lets an unassigned session admin search the active branch and records why', async () => {
      const f = lookupFixture([], 'ADMIN');
      await expect(
        f.caller().lookupReceiptByNumber({ branchId: 'branch-a', receiptNumber: 7 })
      ).resolves.toEqual([expect.objectContaining({ id: 'sale-a' })]);
      expect(searchedBranches(f)).toEqual(['branch-a']);
    });
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

it('DEV-295 authorizes the actual shipped Cashier template after canonical migration', async () => {
  const template = PHARMACY_ROLE_TEMPLATES.find((role) => role.key === 'cashier')!;
  expect(template.capabilities).toContain('pharmacy:counter');
  expect(template.capabilities).not.toContain('pharmacy.counter');
  const permissions = template.capabilities.map((capability) => ({
    capability,
    effect: 'ALLOW' as const,
  }));
  const f = fixture(permissions);
  assign(f, ['branch-a']);
  await expect(
    f.caller().counterCart({ branchId: 'branch-a', saleId: 'sale-a' })
  ).resolves.toMatchObject({ saleId: 'sale-a' });
  await expect(
    f.caller().counterReceipt({ branchId: 'branch-a', saleId: 'sale-a' })
  ).resolves.toMatchObject({ receiptNumber: 7 });
  await expect(
    f.caller().returnHistory({ branchId: 'branch-a', saleId: 'sale-a' })
  ).resolves.toEqual([{ id: 'return-1' }]);
  for (const type of ['CASH', 'CARD'] as const) {
    await expect(
      f.caller().tender({
        branchId: 'branch-a',
        saleId: 'sale-a',
        deviceId: 'device-a',
        businessDate: new Date('2026-11-03'),
        type,
        amountMinor: 100,
        idempotencyKey: `template-${type}`,
      })
    ).resolves.toEqual({ tenderId: 'tender-1' });
  }
  const denied = fixture(permissions, 'EMPLOYEE', [
    { capability: 'pharmacy:counter', effect: 'DENY' },
  ]);
  assign(denied, ['branch-a']);
  await expect(
    denied.caller().counterCart({ branchId: 'branch-a', saleId: 'sale-a' })
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
