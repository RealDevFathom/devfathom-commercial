import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-279 / DEV-659: opening, moving cash in or out of, and closing a cash drawer
// take the same gate as cash tender. The router asks the canonical `can()` for
// `pharmacy:counter`, then checks the counter capability family, then an active
// branch assignment, all before the settlement transaction starts. Both
// capability checks are deny-wins: an explicit DENY, from the role or from a
// user override, beats every ALLOW. A user ALLOW must never beat a role DENY.
// `can()` is not mocked here; it reads the same member rows the router reads.
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
vi.mock('@/lib/pharmacy/settlement', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/settlement')>()),
  openPharmacyDrawer: vi.fn(async () => ({ id: 'drawer-1', status: 'OPEN' })),
  recordPharmacyCashMovement: vi.fn(async () => ({ id: 'movement-1' })),
  closePharmacyDrawer: vi.fn(async () => ({ id: 'drawer-1', status: 'CLOSED' })),
  applyPharmacyTender: vi.fn(async () => ({ tenderId: 'tender-1' })),
}));
vi.mock('@/lib/pharmacy/counter', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/counter')>()),
  readCounterCart: vi.fn(async () => ({ saleId: 'sale-a', lines: [] })),
}));
vi.mock('@/lib/pharmacy/receipt-print', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/receipt-print')>()),
  readPharmacyReceiptFormat: vi.fn(async () => ({ layout: { paperWidth: 32 }, revision: 1 })),
}));

import { hasModule } from '@/lib/entitlements';
import { readCounterCart } from '@/lib/pharmacy/counter';
import { readPharmacyReceiptFormat } from '@/lib/pharmacy/receipt-print';
import {
  applyPharmacyTender,
  closePharmacyDrawer,
  openPharmacyDrawer,
  recordPharmacyCashMovement,
} from '@/lib/pharmacy/settlement';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };

const COUNTER: Rule = { capability: 'pharmacy:counter', effect: 'ALLOW' };
const NO_PERMISSION = { code: 'FORBIDDEN', message: 'You do not have permission for this action.' };
const OUTSIDE = { code: 'FORBIDDEN', message: 'Branch is outside your scope.' };

function fixture(
  roleRules: Rule[],
  options: {
    overrides?: Rule[];
    role?: 'EMPLOYEE' | 'ADMIN';
    assigned?: string[];
    memberStatus?: string;
  } = {}
) {
  const member = {
    status: options.memberStatus ?? 'ACTIVE',
    organizationId: 'org-a',
    organizationRole: { permissions: roleRules },
    permissionOverrides: options.overrides ?? [],
  };
  const db = {
    $queryRaw: vi.fn(async () => []),
    // Both `can()` and the router's member check read this row.
    user: { findUnique: vi.fn(async () => member) },
    pharmacyBranch: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] }; organizationId?: string } }) =>
        args.where.organizationId !== 'org-a'
          ? []
          : args.where.id.in.filter((id) => id !== 'foreign-branch').map((id) => ({ id }))
      ),
      findFirst: vi.fn(async (args?: { where?: { id?: string; organizationId?: string } }) => {
        const where = args?.where ?? {};
        if (where.organizationId !== 'org-a' || where.id === 'foreign-branch') return null;
        return { id: where.id ?? 'branch-a', name: 'Counter' };
      }),
    },
    pharmacyBranchAssignment: {
      findMany: vi.fn(async () => (options.assigned ?? []).map((branchId) => ({ branchId }))),
    },
    organization: { findUnique: vi.fn(async () => ({ currency: 'PKR' })) },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (inner: typeof db) => Promise<unknown>) => fn(db));
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'user-a',
        role: options.role ?? 'EMPLOYEE',
        department: 'COUNTER',
        status: 'ACTIVE',
        organizationId: 'org-a',
      },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} as Record<string, unknown> },
  };
  return {
    db,
    context,
    caller: () => app.createCaller(context as unknown as TRPCContext).pharmacySales,
  };
}

type Caller = ReturnType<ReturnType<typeof fixture>['caller']>;

const settlement = () => [openPharmacyDrawer, recordPharmacyCashMovement, closePharmacyDrawer];

const drawerPaths: {
  name: string;
  run: (caller: Caller, branchId?: string) => Promise<unknown>;
  command: () => unknown;
}[] = [
  {
    name: 'openDrawer',
    run: (caller, branchId = 'branch-a') =>
      caller.openDrawer({
        branchId,
        deviceId: 'device-a',
        businessDate: new Date('2026-10-01T00:00:00.000Z'),
        openingFloatMinor: 500,
      }),
    command: () => openPharmacyDrawer,
  },
  {
    name: 'drawerMovement',
    run: (caller, branchId = 'branch-a') =>
      caller.drawerMovement({
        branchId,
        drawerSessionId: 'drawer-1',
        kind: 'PAID_OUT',
        amountMinor: 100,
        reason: 'Petty cash',
      }),
    command: () => recordPharmacyCashMovement,
  },
  {
    name: 'closeDrawer',
    run: (caller, branchId = 'branch-a') =>
      caller.closeDrawer({ branchId, drawerSessionId: 'drawer-1', countedCashMinor: 400 }),
    command: () => closePharmacyDrawer,
  },
];

/**
 * Each case holds an ALLOW that would admit the caller on its own, and a DENY
 * from the role or from a user override. The DENY must win in every case.
 */
const denyWins: { name: string; role: Rule[]; overrides: Rule[] }[] = [
  {
    name: 'a role DENY beats a user ALLOW',
    role: [{ capability: 'pharmacy:counter', effect: 'DENY' }],
    overrides: [COUNTER],
  },
  {
    name: 'a user DENY beats a role ALLOW',
    role: [COUNTER],
    overrides: [{ capability: 'pharmacy:counter', effect: 'DENY' }],
  },
  {
    name: 'a role DENY beats a role ALLOW on the same capability',
    role: [COUNTER, { capability: 'pharmacy:counter', effect: 'DENY' }],
    overrides: [],
  },
  {
    name: 'a role wildcard DENY beats a user ALLOW',
    role: [{ capability: 'pharmacy:*', effect: 'DENY' }],
    overrides: [COUNTER],
  },
  {
    name: 'a user all-capability DENY beats a role ALLOW',
    role: [COUNTER],
    overrides: [{ capability: '*', effect: 'DENY' }],
  },
  {
    name: 'a role DENY on the legacy pharmacy.counter alias beats a user ALLOW',
    role: [{ capability: 'pharmacy.counter', effect: 'DENY' }],
    overrides: [COUNTER],
  },
  {
    name: 'a role DENY on pharmacy:receipt beats a user ALLOW on pharmacy:counter',
    role: [{ capability: 'pharmacy:receipt', effect: 'DENY' }],
    overrides: [COUNTER],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasModule).mockReturnValue(true);
});

describe('cash drawer authorization (DEV-279, DEV-659)', () => {
  it.each(drawerPaths)('$name allows an assigned counter operator', async (path) => {
    const f = fixture([COUNTER], { assigned: ['branch-a'] });
    await expect(path.run(f.caller())).resolves.toBeDefined();
    expect(f.db.$transaction).toHaveBeenCalledTimes(1);
    expect(path.command()).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' },
      expect.objectContaining({ branchId: 'branch-a' })
    );
  });

  it.each(drawerPaths)(
    '$name authorizes before the settlement transaction starts',
    async (path) => {
      const f = fixture([COUNTER], { assigned: ['branch-a'] });
      await path.run(f.caller());
      const [lastAuthorizationRead] =
        f.db.pharmacyBranchAssignment.findMany.mock.invocationCallOrder;
      const [transaction] = f.db.$transaction.mock.invocationCallOrder;
      expect(lastAuthorizationRead).toBeLessThan(transaction);
    }
  );

  it.each(drawerPaths)('$name denies a member with no counter grant', async (path) => {
    const f = fixture([], { assigned: ['branch-a'] });
    await expect(path.run(f.caller())).rejects.toMatchObject(NO_PERMISSION);
    expect(f.db.$transaction).not.toHaveBeenCalled();
    for (const command of settlement()) expect(command).not.toHaveBeenCalled();
  });

  it.each(
    drawerPaths.flatMap((path) =>
      [
        { capability: 'pharmacy:dispense', effect: 'ALLOW' as const },
        { capability: 'pharmacy:receipt', effect: 'ALLOW' as const },
        { capability: 'pharmacy.counter', effect: 'ALLOW' as const },
      ].map((grant) => ({ ...path, grant }))
    )
  )('$name does not accept $grant.capability as counter authority', async ({ run, grant }) => {
    const f = fixture([grant], { assigned: ['branch-a'] });
    await expect(run(f.caller())).rejects.toMatchObject(NO_PERMISSION);
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });

  it.each(drawerPaths)(
    '$name denies a counter operator with no branch assignment',
    async (path) => {
      const f = fixture([COUNTER]);
      await expect(path.run(f.caller())).rejects.toMatchObject(OUTSIDE);
      expect(f.db.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(drawerPaths)(
    '$name denies a counter operator assigned only to another branch',
    async (path) => {
      const f = fixture([COUNTER], { assigned: ['branch-b'] });
      await expect(path.run(f.caller())).rejects.toMatchObject(OUTSIDE);
      expect(f.db.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(drawerPaths)(
    '$name refuses another tenant’s branch before reading the member',
    async (path) => {
      const f = fixture([COUNTER], { assigned: ['foreign-branch'] });
      await expect(path.run(f.caller(), 'foreign-branch')).rejects.toMatchObject(OUTSIDE);
      expect(f.db.user.findUnique).not.toHaveBeenCalled();
      expect(f.db.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(drawerPaths)('$name denies an inactive member', async (path) => {
    const f = fixture([COUNTER], { assigned: ['branch-a'], memberStatus: 'SUSPENDED' });
    await expect(path.run(f.caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });

  it.each(drawerPaths.flatMap((path) => denyWins.map((rules) => ({ ...path, rules }))))(
    '$name: $rules.name',
    async ({ run, rules }) => {
      const f = fixture(rules.role, { overrides: rules.overrides, assigned: ['branch-a'] });
      await expect(run(f.caller())).rejects.toMatchObject(NO_PERMISSION);
      expect(f.db.$transaction).not.toHaveBeenCalled();
      for (const command of settlement()) expect(command).not.toHaveBeenCalled();
    }
  );

  it.each(drawerPaths)(
    '$name keeps an explicit DENY binding on an organization administrator',
    async (path) => {
      const f = fixture([{ capability: 'pharmacy:counter', effect: 'DENY' }], {
        role: 'ADMIN',
        overrides: [COUNTER],
      });
      await expect(path.run(f.caller())).rejects.toMatchObject(NO_PERMISSION);
      expect(f.db.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(drawerPaths)(
    '$name does not let a session ADMIN without a counter grant open the drawer family',
    async (path) => {
      const f = fixture([], { role: 'ADMIN' });
      await expect(path.run(f.caller())).rejects.toMatchObject(NO_PERMISSION);
      expect(f.db.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(drawerPaths)(
    '$name keeps the audited administrator branch exception for a counter-capable ADMIN',
    async (path) => {
      const f = fixture([COUNTER], { role: 'ADMIN' });
      await expect(path.run(f.caller())).resolves.toBeDefined();
      expect(f.context.audit.detail).toMatchObject({
        targetType: 'PharmacyBranch',
        targetId: 'branch-a',
        metadata: {
          branchId: 'branch-a',
          reason: 'org-admin-receipt-access-without-branch-assignment',
        },
      });
    }
  );
});

const cashTender = (caller: Caller) =>
  caller.tender({
    branchId: 'branch-a',
    saleId: 'sale-a',
    deviceId: 'device-a',
    businessDate: new Date('2026-10-01T00:00:00.000Z'),
    type: 'CASH',
    amountMinor: 100,
    idempotencyKey: 'deny-wins-cash',
  });

const counterPaths: { name: string; run: (caller: Caller) => Promise<unknown>; read: unknown }[] = [
  {
    name: 'counterCart',
    run: (caller) => caller.counterCart({ branchId: 'branch-a', saleId: 'sale-a' }),
    read: readCounterCart,
  },
  {
    name: 'counterReceiptFormat',
    run: (caller) => caller.counterReceiptFormat({ branchId: 'branch-a' }),
    read: readPharmacyReceiptFormat,
  },
  { name: 'cash tender', run: cashTender, read: applyPharmacyTender },
];

describe('counter receipt reads and cash tender keep DENY over ALLOW (DEV-659)', () => {
  it.each(counterPaths)('$name admits an assigned counter operator', async (path) => {
    const f = fixture([COUNTER], { assigned: ['branch-a'] });
    await expect(path.run(f.caller())).resolves.toBeDefined();
    expect(path.read).toHaveBeenCalledTimes(1);
  });

  it.each(counterPaths.flatMap((path) => denyWins.map((rules) => ({ ...path, rules }))))(
    '$name: $rules.name',
    async ({ run, read, rules }) => {
      const f = fixture(rules.role, { overrides: rules.overrides, assigned: ['branch-a'] });
      await expect(run(f.caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(read).not.toHaveBeenCalled();
    }
  );
});
