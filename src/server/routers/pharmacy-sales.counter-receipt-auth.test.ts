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
import { readCounterReceipt } from '@/lib/pharmacy/counter';
import { readDispensingLabelSources } from '@/lib/pharmacy/dispensing-label-source';
import {
  buildPharmacyReceiptEscPosJob,
  readPharmacyReceiptFormat,
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
  };
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

  it('denies a cashier without dispense or receipt capability', async () => {
    const f = fixture([
      { capability: 'pharmacy.counter', effect: 'ALLOW' },
      { capability: 'pharmacy:orders', effect: 'ALLOW' },
    ]);
    assign(f, ['branch-a']);
    await expect(
      f.caller().counterReceipt({ branchId: 'branch-a', saleId: 'sale-a' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
    expect(f.db.pharmacyBranchAssignment.findMany).not.toHaveBeenCalled();
    expect(readCounterReceipt).not.toHaveBeenCalled();
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

  it('does not treat a custom organization role or an admin assigned elsewhere as a grant', async () => {
    const custom = fixture([{ capability: 'pharmacy:dispense', effect: 'ALLOW' }]);
    custom.user.role = 'EMPLOYEE';
    await expect(
      custom.caller().counterReceiptFormat({ branchId: 'branch-a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const admin = fixture(dispense, 'ADMIN');
    assign(admin, ['branch-b']);
    await expect(
      admin.caller().counterReceiptPrintJob({
        branchId: 'branch-a',
        saleId: 'sale-a',
        locale: 'en',
        reprint: true,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(readCounterReceipt).not.toHaveBeenCalled();
  });

  it('denies a branch that is not in the session organization before the sale is read', async () => {
    const f = fixture(dispense, 'ADMIN');
    await expect(
      f.caller().counterReceipt({ branchId: 'foreign-branch', saleId: 'sibling-sale' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(readCounterReceipt).not.toHaveBeenCalled();
    expect(f.db.pharmacyBranch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'foreign-branch',
          organizationId: 'org-a',
          active: true,
        }),
      })
    );
  });
});
