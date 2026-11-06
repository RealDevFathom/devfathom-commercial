import { beforeEach, describe, expect, it, vi } from 'vitest';

// The drawer and close family, and the tender and refund that move cash through
// the same drawer, take their branch from the input. `scopeFor` refuses a branch
// that is not an active pharmacy branch of the caller's organization (one
// `assertInOrganization` lookup); the counter's cash tender reaches it through
// `branchScopeOrForbidden`, which words that refusal as a scope denial. Every one
// of these nine procedures must refuse such a branch before the settlement
// library takes a lock, reads a drawer or writes anything. The close procedures
// keep their day-close capability gate in front of that check; no capability is
// added for the counter.
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

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
type Caller = ReturnType<typeof app.createCaller>['pharmacySales'];
type Refusal = { code: string; message: string };

const BRANCH = 'branch-elsewhere';
const businessDate = new Date('2026-10-20T00:00:00.000Z');
/** `scopeFor`'s refusal. */
const NOT_IN_WORKSPACE: Refusal = {
  code: 'BAD_REQUEST',
  message: 'That record is not in this workspace.',
};
/** The same refusal, as the counter's receipt-access path words it. */
const OUTSIDE: Refusal = { code: 'FORBIDDEN', message: 'Branch is outside your scope.' };

/** The stored row of the session user (an active ADMIN of org-1) with no custom rules. */
const memberWithoutCustomRules = {
  role: 'ADMIN',
  status: 'ACTIVE',
  organizationId: 'org-1',
  organizationRole: null,
  permissionOverrides: [],
};

const procedures: Array<[string, (caller: Caller) => Promise<unknown>, Refusal]> = [
  ['manualPaymentSettings', (c) => c.manualPaymentSettings({ branchId: BRANCH }), OUTSIDE],
  [
    'saveManualPaymentSettings',
    (c) => {
      // `adminProcedure` asks ABAC for `admin:access`; a user row with no custom
      // rules lets the session ADMIN reach the branch scope check.
      db.user.findUnique.mockResolvedValue(memberWithoutCustomRules);
      return c.saveManualPaymentSettings({ branchId: BRANCH, revision: 0, settings: {} });
    },
    OUTSIDE,
  ],
  [
    'drawerStatus',
    (c) => c.drawerStatus({ branchId: BRANCH, deviceId: 'counter-device' }),
    NOT_IN_WORKSPACE,
  ],
  [
    'openDrawer',
    (c) =>
      c.openDrawer({
        branchId: BRANCH,
        deviceId: 'counter-device',
        businessDate,
        openingFloatMinor: 500,
      }),
    NOT_IN_WORKSPACE,
  ],
  [
    'drawerMovement',
    (c) =>
      c.drawerMovement({
        branchId: BRANCH,
        drawerSessionId: 'drawer-1',
        kind: 'PAID_IN',
        amountMinor: 100,
        reason: 'Float top-up',
      }),
    NOT_IN_WORKSPACE,
  ],
  [
    'closeDrawer',
    (c) => c.closeDrawer({ branchId: BRANCH, drawerSessionId: 'drawer-1', countedCashMinor: 0 }),
    NOT_IN_WORKSPACE,
  ],
  ['dailyClose', (c) => c.dailyClose({ branchId: BRANCH, businessDate }), NOT_IN_WORKSPACE],
  ['closePreview', (c) => c.closePreview({ branchId: BRANCH, businessDate }), NOT_IN_WORKSPACE],
  [
    'closeDay',
    (c) =>
      c.closeDay({
        branchId: BRANCH,
        businessDate,
        sourceHash: 'a'.repeat(64),
        counts: [],
        varianceNote: '',
      }),
    NOT_IN_WORKSPACE,
  ],
  [
    'tender',
    (c) =>
      c.tender({
        branchId: BRANCH,
        saleId: 'sale-1',
        deviceId: 'counter-device',
        businessDate,
        type: 'CASH',
        amountMinor: 500,
        cashReceivedMinor: 500,
        idempotencyKey: 'tender-1',
      }),
    OUTSIDE,
  ],
  [
    'refundTender',
    (c) =>
      c.refundTender({
        branchId: BRANCH,
        originalTenderId: 'tender-1',
        deviceId: 'counter-device',
        businessDate,
        amountMinor: 500,
        reason: 'Returned medicine',
        idempotencyKey: 'refund-1',
      }),
    OUTSIDE,
  ],
];
const closeProcedures = procedures.filter(([name]) =>
  ['dailyClose', 'closePreview', 'closeDay'].includes(name)
);

let db: {
  $transaction: ReturnType<typeof vi.fn>;
  $queryRaw: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
  pharmacyBranch: { findMany: ReturnType<typeof vi.fn> };
  // One mock for every assignment read: the close gate's findFirst (DEV-739) and the
  // counter/drawer gate's findMany (DEV-279 / #1086).
  pharmacyBranchAssignment: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  pharmacyDailyClose: { findFirst: ReturnType<typeof vi.fn> };
  pharmacyDrawerSession: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  pharmacyDrawerMovement: { create: ReturnType<typeof vi.fn> };
  pharmacyTender: { findFirst: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
};

function caller(role = 'ADMIN'): Caller {
  return app.createCaller({
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'actor-1', role, status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacySales;
}

beforeEach(() => {
  db = {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    // Unknown, inactive and another tenant's branch all read as "no such active branch".
    pharmacyBranch: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyBranchAssignment: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyDrawerSession: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'drawer-new', status: 'OPEN' }),
    },
    pharmacyDrawerMovement: { create: vi.fn().mockResolvedValue({}) },
    pharmacyTender: { findFirst: vi.fn().mockResolvedValue(null) },
    // A user row with no custom rules: the close gate reads it for an ADMIN's DENYs.
    user: { findUnique: vi.fn().mockResolvedValue(memberWithoutCustomRules) },
  };
});

describe('pharmacy drawer, close and cash procedures: the branch in the input', () => {
  it('refuses non-admin changes to reference-skip policy before accessing the branch', async () => {
    // A real member row, so the refusal is the ADMIN policy, not a missing user.
    db.user.findUnique.mockResolvedValue(memberWithoutCustomRules);
    await expect(
      caller('EMPLOYEE').saveManualPaymentSettings({
        branchId: BRANCH,
        revision: 0,
        settings: {
          RAAST: { destination: 'Till', allowReferenceSkip: true },
        },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
  });
  it.each(procedures)(
    '%s refuses a branch that is not an active branch of the organization, touching nothing',
    async (_name, run, refusal) => {
      await expect(run(caller())).rejects.toMatchObject(refusal);
      expect(db.pharmacyBranch.findMany).toHaveBeenCalledExactlyOnceWith({
        where: { id: { in: [BRANCH] }, organizationId: 'org-1', active: true },
        select: { id: true },
      });
      // No day lock, no day, drawer or tender read, no write.
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(db.$executeRaw).not.toHaveBeenCalled();
      expect(db.pharmacyDailyClose.findFirst).not.toHaveBeenCalled();
      expect(db.pharmacyDrawerSession.findFirst).not.toHaveBeenCalled();
      expect(db.pharmacyDrawerSession.create).not.toHaveBeenCalled();
      expect(db.pharmacyDrawerMovement.create).not.toHaveBeenCalled();
      expect(db.pharmacyTender.findFirst).not.toHaveBeenCalled();
    }
  );

  it.each(closeProcedures)(
    '%s keeps the day-close capability gate in front of the branch check',
    async (_name, run) => {
      db.user.findUnique.mockResolvedValue({ ...memberWithoutCustomRules, role: 'EMPLOYEE' });
      await expect(run(caller('EMPLOYEE'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Day-close permission is required to reconcile and close a day.',
      });
      expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(closeProcedures)(
    '%s lets a non-admin with pharmacy:close reach the normal branch scope check',
    async (_name, run, refusal) => {
      db.user.findUnique.mockResolvedValue({
        role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1',
        organizationRole: { key: 'manager', isSystem: true,
          permissions: [{ capability: 'pharmacy:close', effect: 'ALLOW' }],
        },
        permissionOverrides: [],
      });
      await expect(run(caller('EMPLOYEE'))).rejects.toMatchObject(refusal);
      expect(db.pharmacyBranch.findMany).toHaveBeenCalledOnce();
    }
  );

  // DEV-739: `pharmacy:close` is an organization-role grant, so a non-admin closer
  // must also be an active member assigned to the branch being counted and cut.
  const closer = (status = 'ACTIVE') => ({
    status,
    role: 'EMPLOYEE',
    organizationId: 'org-1',
    organizationRole: { key: 'manager', isSystem: true, permissions: [{ capability: 'pharmacy:close', effect: 'ALLOW' }] },
    permissionOverrides: [],
  });
  const assignmentLookup = {
    where: {
      organizationId: 'org-1',
      userId: 'actor-1',
      branchId: BRANCH,
      active: true,
      branch: { organizationId: 'org-1', active: true },
    },
    select: { id: true },
  };

  it.each(closeProcedures)(
    '%s refuses a pharmacy:close holder on an active branch they are not assigned to, touching nothing',
    async (_name, run) => {
      db.pharmacyBranch.findMany.mockResolvedValue([{ id: BRANCH }]);
      db.user.findUnique.mockResolvedValue(closer());
      await expect(run(caller('EMPLOYEE'))).rejects.toMatchObject(OUTSIDE);
      expect(db.pharmacyBranchAssignment.findFirst).toHaveBeenCalledExactlyOnceWith(
        assignmentLookup
      );
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(db.$executeRaw).not.toHaveBeenCalled();
      expect(db.pharmacyDailyClose.findFirst).not.toHaveBeenCalled();
      expect(db.pharmacyDrawerSession.findFirst).not.toHaveBeenCalled();
    }
  );

  it.each(closeProcedures)(
    '%s refuses an assigned pharmacy:close holder whose membership is not active',
    async (_name, run) => {
      db.pharmacyBranch.findMany.mockResolvedValue([{ id: BRANCH }]);
      db.user.findUnique.mockResolvedValue(closer('SUSPENDED'));
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue({ id: 'assignment-1' });
      await expect(run(caller('EMPLOYEE'))).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Day-close permission is required to reconcile and close a day.' });
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(closeProcedures)(
    '%s admits a pharmacy:close holder assigned to the branch into the close transaction',
    async (_name, run) => {
      db.pharmacyBranch.findMany.mockResolvedValue([{ id: BRANCH }]);
      db.user.findUnique.mockResolvedValue(closer());
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue({ id: 'assignment-1' });
      // The settlement library then runs against this bare mock and may refuse for
      // its own reasons; access is what is under test, so only the branch refusal
      // is excluded.
      await run(caller('EMPLOYEE')).catch((error: unknown) =>
        expect(error).not.toMatchObject(OUTSIDE)
      );
      expect(db.pharmacyBranchAssignment.findFirst).toHaveBeenCalledExactlyOnceWith(
        assignmentLookup
      );
      expect(db.$transaction).toHaveBeenCalledOnce();
    }
  );

  it.each(closeProcedures)(
    '%s keeps organization-wide reach for a session ADMIN without a branch assignment',
    async (_name, run) => {
      db.pharmacyBranch.findMany.mockResolvedValue([{ id: BRANCH }]);
      await run(caller('ADMIN')).catch((error: unknown) =>
        expect(error).not.toMatchObject(OUTSIDE)
      );
      expect(db.pharmacyBranchAssignment.findFirst).not.toHaveBeenCalled();
      expect(db.$transaction).toHaveBeenCalledOnce();
    }
  );

  // Day close is for managers and owners only (Saad, DEV-32; reaffirmed on DEV-739).
  // The role matrix runs the shipped templates through the real can() and guard.
  const NO_CLOSE: Refusal = {
    code: 'FORBIDDEN',
    message: 'Day-close permission is required to reconcile and close a day.',
  };
  const member = (
    rules: Array<{ capability: string; effect: string }>,
    overrides: Array<{ capability: string; effect: string }> = [],
    stored: { role?: string; status?: string; organizationId?: string; key?: string; isSystem?: boolean } = {}
  ) => ({
    role: stored.role ?? 'EMPLOYEE',
    status: stored.status ?? 'ACTIVE',
    organizationId: stored.organizationId ?? 'org-1',
    organizationRole: { key: stored.key ?? 'manager', isSystem: stored.isSystem ?? true, permissions: rules },
    permissionOverrides: overrides,
  });
  const ADMIN_ROW = { role: 'ADMIN' };
  const template = (key: string) =>
    PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)!.capabilities.map((capability) => ({
      capability,
      effect: 'ALLOW',
    }));
  // Every shipped template: only these close by default; a template that later picks
  // up pharmacy:close fails here until the policy says so.
  const CLOSES_BY_DEFAULT = new Set(['manager', 'owner', 'owner-operator']);
  const closeRoleMatrix = closeProcedures.flatMap(([name, run]) =>
    PHARMACY_ROLE_TEMPLATES.map(
      (role) => [name, role.key, CLOSES_BY_DEFAULT.has(role.key), run] as const
    )
  );

  it.each(closeRoleMatrix)(
    '%s: the %s template, assigned to the branch, may close the day: %s',
    async (_name, role, allowed, run) => {
      db.pharmacyBranch.findMany.mockResolvedValue([{ id: BRANCH }]);
      db.user.findUnique.mockResolvedValue(member(template(role), [], { key: role }));
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue({ id: 'assignment-1' });
      if (allowed) {
        await run(caller('EMPLOYEE')).catch((error: unknown) => {
          expect(error).not.toMatchObject(NO_CLOSE);
          expect(error).not.toMatchObject(OUTSIDE);
        });
        expect(db.$transaction).toHaveBeenCalledOnce();
      } else {
        await expect(run(caller('EMPLOYEE'))).rejects.toMatchObject(NO_CLOSE);
        // Refused at the capability gate: no branch, assignment or close work.
        expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
        expect(db.pharmacyBranchAssignment.findFirst).not.toHaveBeenCalled();
        expect(db.$transaction).not.toHaveBeenCalled();
      }
    }
  );

  it.each(
    closeProcedures.flatMap(([name, run]) =>
      (
        [
          ['a user DENY over the manager role grant', template('manager'), 'pharmacy:close'],
          ['a user pharmacy:* DENY over the manager role grant', template('manager'), 'pharmacy:*'],
          ['a user * DENY over the owner role grant', template('owner'), '*'],
        ] as const
      ).map(([label, rules, deny]) => [name, label, rules, deny, run] as const)
    )
  )('%s refuses %s before the branch check', async (_name, _label, rules, deny, run) => {
    db.pharmacyBranch.findMany.mockResolvedValue([{ id: BRANCH }]);
    db.user.findUnique.mockResolvedValue(
      member([...rules], [{ capability: deny, effect: 'DENY' }])
    );
    db.pharmacyBranchAssignment.findFirst.mockResolvedValue({ id: 'assignment-1' });
    await expect(run(caller('EMPLOYEE'))).rejects.toMatchObject(NO_CLOSE);
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each(
    closeProcedures.flatMap(([name, run]) =>
      (
        [
          [
            'an explicit role DENY',
            member([{ capability: 'pharmacy:close', effect: 'DENY' }], [], ADMIN_ROW),
          ],
          [
            'a user pharmacy:* DENY',
            member([], [{ capability: 'pharmacy:*', effect: 'DENY' }], ADMIN_ROW),
          ],
          ['a role * DENY', member([{ capability: '*', effect: 'DENY' }], [], ADMIN_ROW)],
        ] as const
      ).map(([label, rules]) => [name, label, rules, run] as const)
    )
  )('%s refuses a session ADMIN with %s', async (_name, _label, rules, run) => {
    db.pharmacyBranch.findMany.mockResolvedValue([{ id: BRANCH }]);
    db.user.findUnique.mockResolvedValue(rules);
    await expect(run(caller('ADMIN'))).rejects.toMatchObject(NO_CLOSE);
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each(closeProcedures)(
    '%s refuses a session ADMIN whose user row cannot be read (fails closed)',
    async (_name, run) => {
      db.pharmacyBranch.findMany.mockResolvedValue([{ id: BRANCH }]);
      db.user.findUnique.mockResolvedValue(null);
      await expect(run(caller('ADMIN'))).rejects.toMatchObject(NO_CLOSE);
      expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(closeProcedures)(
    '%s keeps a session ADMIN whose only DENY is on another action',
    async (_name, run) => {
      db.pharmacyBranch.findMany.mockResolvedValue([{ id: BRANCH }]);
      db.user.findUnique.mockResolvedValue(
        member([], [{ capability: 'pharmacy:counter', effect: 'DENY' }], ADMIN_ROW)
      );
      await run(caller('ADMIN')).catch((error: unknown) =>
        expect(error).not.toMatchObject(NO_CLOSE)
      );
      expect(db.$transaction).toHaveBeenCalledOnce();
    }
  );

  // Active identity: the session says ADMIN, the stored row decides.
  it.each(
    closeProcedures.flatMap(([name, run]) =>
      (
        [
          ['suspended', { ...ADMIN_ROW, status: 'SUSPENDED' }],
          ['moved to another organization', { ...ADMIN_ROW, organizationId: 'org-2' }],
        ] as const
      ).map(([label, stored]) => [name, label, stored, run] as const)
    )
  )('%s refuses a session ADMIN whose stored row is %s', async (_name, _label, stored, run) => {
    db.pharmacyBranch.findMany.mockResolvedValue([{ id: BRANCH }]);
    db.user.findUnique.mockResolvedValue(member([], [], stored));
    await expect(run(caller('ADMIN'))).rejects.toMatchObject(NO_CLOSE);
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each(closeProcedures)(
    '%s treats a session ADMIN demoted to a plain employee as that employee (no close)',
    async (_name, run) => {
      db.pharmacyBranch.findMany.mockResolvedValue([{ id: BRANCH }]);
      db.user.findUnique.mockResolvedValue(member(template('pharmacist')));
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue({ id: 'assignment-1' });
      await expect(run(caller('ADMIN'))).rejects.toMatchObject(NO_CLOSE);
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(closeProcedures)(
    '%s treats a session ADMIN demoted to Manager as a manager: assigned branches only',
    async (_name, run) => {
      db.pharmacyBranch.findMany.mockResolvedValue([{ id: BRANCH }]);
      db.user.findUnique.mockResolvedValue(member(template('manager')));
      await expect(run(caller('ADMIN'))).rejects.toMatchObject(OUTSIDE);
      expect(db.$transaction).not.toHaveBeenCalled();
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue({ id: 'assignment-1' });
      await run(caller('ADMIN')).catch((error: unknown) => {
        expect(error).not.toMatchObject(NO_CLOSE);
        expect(error).not.toMatchObject(OUTSIDE);
      });
      expect(db.$transaction).toHaveBeenCalledOnce();
    }
  );

  it.each(closeProcedures.flatMap(([name, run]) =>
    ['pharmacist', 'cashier', 'staff', 'unknown'].map((key) => [name, run, key] as const)
  ))('%s refuses the %s role even with an explicit close grant', async (_name, run, key) => {
    db.user.findUnique.mockResolvedValue(member(
      [{ capability: 'pharmacy:close', effect: 'ALLOW' }], [], { key }
    ));
    await expect(run(caller('EMPLOYEE'))).rejects.toMatchObject(NO_CLOSE);
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each(closeProcedures)('%s refuses a Pharmacist with a user override', async (_name, run) => {
    db.user.findUnique.mockResolvedValue(member([], [{ capability: 'pharmacy:close', effect: 'ALLOW' }], { key: 'pharmacist' }));
    await expect(run(caller('EMPLOYEE'))).rejects.toMatchObject(NO_CLOSE);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each(closeProcedures)('%s rejects a missing or non-system role even with a grant', async (_name, run) => {
    for (const organizationRole of [null, { key: 'manager', isSystem: false, permissions: [{ capability: 'pharmacy:close', effect: 'ALLOW' }] }]) {
      db.user.findUnique.mockResolvedValue({ ...member([]), organizationRole, permissionOverrides: [{ capability: 'pharmacy:close', effect: 'ALLOW' }] });
      await expect(run(caller('EMPLOYEE'))).rejects.toMatchObject(NO_CLOSE);
    }
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each(closeProcedures)('%s refuses an unknown coarse role', async (_name, run) => {
    db.user.findUnique.mockResolvedValue(member([{ capability: 'pharmacy:close', effect: 'ALLOW' }], [], { role: 'UNKNOWN' }));
    await expect(run(caller('EMPLOYEE'))).rejects.toMatchObject(NO_CLOSE);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each(closeProcedures)('%s accepts the system admin role and rejects a denied owner', async (_name, run) => {
    db.pharmacyBranch.findMany.mockResolvedValue([{ id: BRANCH }]);
    db.pharmacyBranchAssignment.findFirst.mockResolvedValue({ id: 'assignment-1' });
    db.user.findUnique.mockResolvedValue(member([{ capability: 'pharmacy:close', effect: 'ALLOW' }], [], { key: 'admin' }));
    await run(caller('EMPLOYEE')).catch((error: unknown) => expect(error).not.toMatchObject(NO_CLOSE));
    expect(db.$transaction).toHaveBeenCalledOnce();
    db.$transaction.mockClear();
    db.user.findUnique.mockResolvedValue(member(template('owner'), [{ capability: '*', effect: 'DENY' }], { key: 'owner' }));
    await expect(run(caller('EMPLOYEE'))).rejects.toMatchObject(NO_CLOSE);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  // DEV-739: the UI is offered what the close procedures would admit: the role decision
  // first, then the branches that viewer may close (none means no offer).
  it('reports the role decision for the UI, then the branches it may close', async () => {
    db.user.findUnique.mockResolvedValue(member(template('manager')));
    db.pharmacyBranchAssignment.findMany.mockResolvedValue([{ branchId: BRANCH }]);
    await expect(caller('EMPLOYEE').dayCloseAccess()).resolves.toEqual({
      allowed: true,
      branchIds: [BRANCH],
      userId: 'actor-1',
      organizationId: 'org-1',
    });
    // An eligible manager assigned to no branch is offered nothing.
    db.pharmacyBranchAssignment.findMany.mockResolvedValue([]);
    await expect(caller('EMPLOYEE').dayCloseAccess()).resolves.toMatchObject({
      allowed: false,
      branchIds: [],
    });
    // An ineligible role is refused before any branch or assignment is read.
    db.pharmacyBranchAssignment.findMany.mockClear();
    db.user.findUnique.mockResolvedValue(
      member([{ capability: 'pharmacy:close', effect: 'ALLOW' }], [], { key: 'pharmacist' })
    );
    await expect(caller('EMPLOYEE').dayCloseAccess()).resolves.toMatchObject({
      allowed: false,
      branchIds: [],
    });
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
    expect(db.pharmacyBranchAssignment.findMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each(closeProcedures)('%s refuses an ADMIN assigned the Pharmacist role', async (_name, run) => {
    db.user.findUnique.mockResolvedValue(member([{ capability: 'pharmacy:close', effect: 'ALLOW' }], [], { role: 'ADMIN', key: 'pharmacist' }));
    await expect(run(caller('ADMIN'))).rejects.toMatchObject(NO_CLOSE);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  // Counting one's own drawer is not day close: closeDrawer keeps its own policy
  // (DEV-279 / DEV-659, #1086) and is never refused by the day-close gate. Only that is
  // pinned here, so a drawer policy that adds its own gate does not break this test.
  it.each(['pharmacist', 'cashier'])(
    'lets the %s template reach closeDrawer without pharmacy:close',
    async (role) => {
      db.pharmacyBranch.findMany.mockResolvedValue([{ id: BRANCH }]);
      db.user.findUnique.mockResolvedValue(member(template(role), [], { key: role }));
      await caller('EMPLOYEE')
        .closeDrawer({ branchId: BRANCH, drawerSessionId: 'drawer-1', countedCashMinor: 0 })
        .catch((error: unknown) => expect(error).not.toMatchObject(NO_CLOSE));
    }
  );

  it('opens a drawer on an active branch of the organization, scoped to that branch', async () => {
    db.pharmacyBranch.findMany.mockResolvedValue([{ id: BRANCH }]);
    await expect(
      caller('EMPLOYEE').openDrawer({
        branchId: BRANCH,
        deviceId: 'counter-device',
        businessDate,
        openingFloatMinor: 0,
      })
    ).resolves.toMatchObject({ id: 'drawer-new' });
    expect(db.pharmacyDrawerSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-1',
        branchId: BRANCH,
        openedByActorId: 'actor-1',
      }),
    });
  });
});
