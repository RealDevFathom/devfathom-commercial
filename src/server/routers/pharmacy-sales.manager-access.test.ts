import { beforeEach, describe, expect, it, vi } from 'vitest';

// Closing the day and opening, moving or closing a drawer are manager-or-owner
// actions, enforced on the server. A cashier cannot open, move or close their own
// drawer or close the day; a manager and an owner can, and so can a solo owner
// (tenant ADMIN with no organization role). The Pharmacist template does not
// carry `pharmacy:close`, so a pharmacist can open a drawer (via
// `pharmacy:dispense`) but cannot close the day. It does not carry
// `pharmacy:counter` either (pending in DEV-622 / DEV-97), so tender stays refused.
const mocks = vi.hoisted(() => ({
  openDrawer: vi.fn(),
  movement: vi.fn(),
  closeDrawer: vi.fn(),
  dailyClose: vi.fn(),
  closeDay: vi.fn(),
  closePreview: vi.fn(),
  applyTender: vi.fn(),
  createSale: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/settlement', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/settlement')>(
    '@/lib/pharmacy/settlement'
  )),
  openPharmacyDrawer: mocks.openDrawer,
  recordPharmacyCashMovement: mocks.movement,
  closePharmacyDrawer: mocks.closeDrawer,
  cutPharmacyDailyClose: mocks.dailyClose,
  applyPharmacyTender: mocks.applyTender,
}));
vi.mock('@/lib/pharmacy/sales', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/sales')>('@/lib/pharmacy/sales')),
  createSale: mocks.createSale,
}));
vi.mock('@/lib/pharmacy/day-close', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/day-close')>('@/lib/pharmacy/day-close')),
  closePharmacyDay: mocks.closeDay,
  readPharmacyClose: mocks.closePreview,
}));

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
type Caller = ReturnType<typeof app.createCaller>['pharmacySales'];
type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
type Persona = {
  role: 'ADMIN' | 'EMPLOYEE';
  organizationRole: { permissions: Rule[] } | null;
  overrides?: Rule[];
};
const allow = (...capabilities: string[]): Rule[] =>
  capabilities.map((capability) => ({ capability, effect: 'ALLOW' }));

// The seeded pharmacy templates (src/lib/vertical-catalog.ts).
const cashier: Persona = {
  role: 'EMPLOYEE',
  organizationRole: { permissions: allow('pharmacy:counter', 'pharmacy:orders') },
};
const manager: Persona = {
  role: 'EMPLOYEE',
  organizationRole: {
    permissions: allow('pharmacy:manage', 'pharmacy:orders', 'pharmacy:procurement'),
  },
};
const owner: Persona = {
  role: 'ADMIN',
  organizationRole: {
    permissions: allow('pharmacy:*', 'reports:operational', 'reports:financial'),
  },
};
const ownerOperator: Persona = {
  role: 'ADMIN',
  organizationRole: {
    permissions: allow('pharmacy:counter', 'pharmacy:close', 'pharmacy:manage'),
  },
};
const soloOwner: Persona = { role: 'ADMIN', organizationRole: null };
const pharmacistTemplate = PHARMACY_ROLE_TEMPLATES.find((role) => role.key === 'pharmacist')!;
const pharmacist: Persona = {
  role: 'EMPLOYEE',
  organizationRole: { permissions: allow(...pharmacistTemplate.capabilities) },
};

const BRANCH = 'branch-1';
const businessDate = new Date('2026-10-20T00:00:00.000Z');
let db: {
  $transaction: ReturnType<typeof vi.fn>;
  pharmacyBranch: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  pharmacyBranchAssignment: { findMany: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
};

function caller(persona: Persona): Caller {
  db.user.findUnique.mockResolvedValue({
    status: 'ACTIVE',
    organizationId: 'org-1',
    organizationRole: persona.organizationRole,
    permissionOverrides: persona.overrides ?? [],
  });
  return app.createCaller({
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'actor-1', role: persona.role, status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacySales;
}

const drawerCalls: Array<
  [string, (c: Caller) => Promise<unknown>, () => ReturnType<typeof vi.fn>]
> = [
  [
    'openDrawer',
    (c) =>
      c.openDrawer({
        branchId: BRANCH,
        deviceId: 'counter-device',
        businessDate,
        openingFloatMinor: 500,
      }),
    () => mocks.openDrawer,
  ],
  [
    'drawerMovement',
    (c) =>
      c.drawerMovement({
        branchId: BRANCH,
        drawerSessionId: 'drawer-1',
        kind: 'PAID_OUT',
        amountMinor: 100,
        reason: 'Courier',
      }),
    () => mocks.movement,
  ],
  [
    'closeDrawer',
    (c) => c.closeDrawer({ branchId: BRANCH, drawerSessionId: 'drawer-1', countedCashMinor: 500 }),
    () => mocks.closeDrawer,
  ],
];
const closeCalls: typeof drawerCalls = [
  [
    'closeDay',
    (c) =>
      c.closeDay({
        branchId: BRANCH,
        businessDate,
        sourceHash: 'a'.repeat(64),
        counts: [{ drawerSessionId: 'drawer-1', countedCashMinor: 500 }],
        varianceNote: '',
      }),
    () => mocks.closeDay,
  ],
  [
    'closePreview',
    (c) => c.closePreview({ branchId: BRANCH, businessDate }),
    () => mocks.closePreview,
  ],
  ['dailyClose', (c) => c.dailyClose({ branchId: BRANCH, businessDate }), () => mocks.dailyClose],
];
const calls = [...drawerCalls, ...closeCalls];

beforeEach(() => {
  vi.clearAllMocks();
  db = {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
      findFirst: vi.fn(async () => ({ id: BRANCH })),
    },
    pharmacyBranchAssignment: { findMany: vi.fn(async () => [{ branchId: BRANCH }]) },
    user: { findUnique: vi.fn() },
  };
  mocks.openDrawer.mockResolvedValue({ id: 'drawer-1', status: 'OPEN' });
  mocks.movement.mockResolvedValue({ id: 'movement-1' });
  mocks.closeDrawer.mockResolvedValue({ id: 'drawer-1', status: 'CLOSED' });
  mocks.dailyClose.mockResolvedValue({ id: 'close-1' });
  mocks.closeDay.mockResolvedValue({ id: 'close-1' });
  mocks.closePreview.mockResolvedValue({ sourceHash: 'a'.repeat(64) });
  mocks.applyTender.mockResolvedValue({ tenderId: 'tender-1', status: 'ACCEPTED' });
  mocks.createSale.mockResolvedValue({ id: 'sale-1' });
});

const takePayment = (c: Caller) =>
  c.tender({
    branchId: BRANCH,
    saleId: 'sale-1',
    deviceId: 'counter-device',
    businessDate,
    type: 'CASH',
    amountMinor: 500,
    cashReceivedMinor: 500,
    idempotencyKey: 'tender-key-1',
  });

describe('pharmacy drawer and close: manager-or-owner gate', () => {
  it.each(calls)('%s refuses a cashier before touching the branch', async (_name, run, domain) => {
    await expect(run(caller(cashier))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(domain()).not.toHaveBeenCalled();
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each(calls)(
    '%s refuses a tenant ADMIN assigned the cashier role',
    async (_name, run, domain) => {
      await expect(run(caller({ ...cashier, role: 'ADMIN' }))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(domain()).not.toHaveBeenCalled();
    }
  );

  it.each(calls)(
    '%s refuses a solo owner whose pharmacy:manage is DENIED',
    async (_name, run, domain) => {
      await expect(
        run(caller({ ...soloOwner, overrides: [{ capability: 'pharmacy:*', effect: 'DENY' }] }))
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(domain()).not.toHaveBeenCalled();
    }
  );

  it.each(calls)('%s fails closed when the permission lookup fails', async (_name, run, domain) => {
    const c = caller(soloOwner);
    db.user.findUnique.mockRejectedValue(new Error('lookup failed'));
    await expect(run(c)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(domain()).not.toHaveBeenCalled();
  });

  it('words the drawer refusal for the counter', async () => {
    await expect(drawerCalls[0][1](caller(cashier))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Manager or owner permission is required to open, move or close a drawer.',
    });
  });

  it.each(
    calls.flatMap(([name, run, domain]) =>
      (
        [
          ['manager', manager],
          ['owner', owner],
          ['owner / operator', ownerOperator],
          ['solo owner', soloOwner],
        ] as const
      ).map(([who, persona]) => [name, who, persona, run, domain] as const)
    )
  )('%s lets a %s through', async (_name, _who, persona, run, domain) => {
    await expect(run(caller(persona))).resolves.toBeDefined();
    expect(domain()).toHaveBeenCalledTimes(1);
    expect(domain().mock.calls[0][1]).toEqual({
      organizationId: 'org-1',
      branchId: BRANCH,
      actorId: 'actor-1',
    });
  });

  it('lets a solo owner whose clinical pharmacy:dispense is DENIED open a drawer', async () => {
    await expect(
      drawerCalls[0][1](
        caller({ ...soloOwner, overrides: [{ capability: 'pharmacy:dispense', effect: 'DENY' }] })
      )
    ).resolves.toBeDefined();
    expect(mocks.openDrawer).toHaveBeenCalledTimes(1);
  });

  it.each(calls)(
    '%s refuses a solo owner whose pharmacy:manage and pharmacy:close are DENIED',
    async (name, run, domain) => {
      const overrides: Rule[] = [
        { capability: 'pharmacy:manage', effect: 'DENY' },
        { capability: 'pharmacy:close', effect: 'DENY' },
      ];
      if (name === 'openDrawer')
        overrides.push({ capability: 'pharmacy:dispense', effect: 'DENY' });
      await expect(run(caller({ ...soloOwner, overrides }))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(domain()).not.toHaveBeenCalled();
    }
  );
});

describe('Pharmacist template: no day close, no counter selling', () => {
  it('has neither pharmacy:close nor pharmacy:counter', () => {
    expect(pharmacistTemplate.capabilities).toEqual([
      'pharmacy:dispense',
      'pharmacy:catalogue-review',
    ]);
  });

  it('lets a pharmacist start a sale', async () => {
    await expect(
      caller(pharmacist).create({ branchId: BRANCH, quotation: false })
    ).resolves.toEqual({ id: 'sale-1' });
    expect(mocks.createSale).toHaveBeenCalledTimes(1);
  });

  it('refuses payment from a pharmacist (no pharmacy:counter)', async () => {
    await expect(takePayment(caller(pharmacist))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.applyTender).not.toHaveBeenCalled();
  });

  it.each(closeCalls)('%s refuses a pharmacist', async (_name, run, domain) => {
    await expect(run(caller(pharmacist))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Day-close permission is required to reconcile and close a day.',
    });
    expect(domain()).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('closeDay refuses a pharmacist even as a tenant ADMIN bounded by the role', async () => {
    await expect(closeCalls[0][1](caller({ ...pharmacist, role: 'ADMIN' }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.closeDay).not.toHaveBeenCalled();
  });

  it('lets a pharmacist open a drawer (rides on pharmacy:dispense)', async () => {
    await expect(drawerCalls[0][1](caller(pharmacist))).resolves.toBeDefined();
    expect(mocks.openDrawer).toHaveBeenCalledTimes(1);
  });

  it.each(drawerCalls.slice(1))(
    '%s still refuses a pharmacist (manager or owner only)',
    async (_name, run, domain) => {
      await expect(run(caller(pharmacist))).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(domain()).not.toHaveBeenCalled();
    }
  );

  it('still refuses a cashier opening a drawer', async () => {
    await expect(drawerCalls[0][1](caller(cashier))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.openDrawer).not.toHaveBeenCalled();
  });

  it('refuses a pharmacist whose dispense grant is DENIED from opening a drawer', async () => {
    await expect(
      drawerCalls[0][1](
        caller({ ...pharmacist, overrides: [{ capability: 'pharmacy:dispense', effect: 'DENY' }] })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.openDrawer).not.toHaveBeenCalled();
  });
});
