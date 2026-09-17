/**
 * PROP-04 G2/G3 — the native platform commands that assign, recover and
 * lifecycle one hotel property, at the command boundary.
 *
 * Mock-style, modeled on `commands.vertical.test.ts`: every guard is asserted
 * against a fully mocked Prisma client, so the server's refusals are proven
 * without a database. That is also the limit of this file, stated up front —
 * these are NOT proof of the SQL policies. Whether `hotel_properties` is actually
 * unreadable without an assignment, and whether the completed restrictive policy
 * admits only `app.is_platform_admin`, is decided by PostgreSQL and is proven in
 * `hotel-property-maintenance.db.test.ts` against a real cluster (held for G5).
 * Nothing here should be read as RLS evidence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { roleTemplatesForVertical } from '@/lib/vertical-catalog';

const mocks = vi.hoisted(() => ({
  queryRawUnsafe: vi.fn(),
  orgFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
  roleFindFirst: vi.fn(),
  roleCount: vi.fn(),
  assignmentCreate: vi.fn(),
  assignmentFindFirst: vi.fn(),
  assignmentUpsert: vi.fn(),
  assignmentCount: vi.fn(),
  propertyFindUniqueOrThrow: vi.fn(),
  propertyUpdate: vi.fn(),
  auditCreate: vi.fn(),
  assertCapability: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'hashed'), compare: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({ assertPlatformCapability: mocks.assertCapability }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => Promise<unknown>) => run(platformDb)),
  withTenantDb: vi.fn(async (_organizationId: string, run: (db: unknown) => Promise<unknown>) =>
    run(platformDb)
  ),
}));

const platformDb = {
  $queryRawUnsafe: mocks.queryRawUnsafe,
  organization: { findUnique: mocks.orgFindUnique },
  user: { findFirst: mocks.userFindFirst },
  organizationRole: { findFirst: mocks.roleFindFirst, count: mocks.roleCount },
  hotelProperty: {
    findUniqueOrThrow: mocks.propertyFindUniqueOrThrow,
    update: mocks.propertyUpdate,
  },
  hotelPropertyAssignment: {
    create: mocks.assignmentCreate,
    findFirst: mocks.assignmentFindFirst,
    upsert: mocks.assignmentUpsert,
    count: mocks.assignmentCount,
  },
  platformAuditLog: { create: mocks.auditCreate },
};

import { executePlatformCommand } from './commands';
import {
  assignBootstrapHotelPropertyManager,
  BOOTSTRAP_ADMIN_ROLE_KEY,
  HOSPITALITY_OWNER_ROLE_KEY,
  HOTEL_ROLE_KEYS,
} from './hotel-property-maintenance';

const actor = { id: 'op_1', role: 'SUPER_ADMIN' } as never;
const request = new Request('https://admin.devfathom.com/api/platform/control', { method: 'POST' });

const ORG = 'org_hotel';
const BRANCH = 'prop_main';
const USER = 'user_gm';
const ROLE = 'role_gm';
const REASON = 'The only assigned general manager has left the company.';

function run(action: string, payload: unknown) {
  return executePlatformCommand(actor, action, payload, request);
}

function caught(promise: Promise<unknown>) {
  return promise.catch((error: unknown) => error);
}

/** The property row `lockProperty`'s `SELECT ... FOR UPDATE` returns. */
function lockedProperty(overrides: Record<string, unknown> = {}) {
  return [{ branchId: BRANCH, active: true, name: 'Serena Gulberg', ...overrides }];
}

/**
 * `$queryRawUnsafe` serves two callers: the property lock here and the
 * organization existence probe in the command-failure audit path. Dispatching on
 * the statement keeps a failure test from accidentally answering the lock.
 */
function routeRawQuery(property: unknown[] = lockedProperty()) {
  mocks.queryRawUnsafe.mockImplementation(async (sql: string) => {
    if (sql.includes('hotel_properties')) return property;
    return [{ id: ORG }];
  });
}

const HOSPITALITY_ROLE_KEYS = roleTemplatesForVertical('HOSPITALITY').map(
  (template) => template.key
);

/** A property whose every answerable onboarding step is satisfied. */
const READY_PROPERTY = {
  mode: 'HOTEL',
  name: 'Serena Gulberg',
  addressLine: '12 Main Boulevard',
  city: 'Lahore',
  timezone: 'Asia/Karachi',
  checkInTime: '14:00',
  checkOutTime: '12:00',
  auditTime: '03:00',
  taxProfileId: 'tax_1',
  businessDatePolicy: { rollAt: '03:00' },
};

beforeEach(() => {
  vi.clearAllMocks();
  routeRawQuery();
  mocks.orgFindUnique.mockResolvedValue({ id: ORG, status: 'ACTIVE', vertical: 'HOSPITALITY' });
  mocks.userFindFirst.mockResolvedValue({
    id: USER,
    name: 'Ayesha Khan',
    email: 'ayesha@serena.pk',
    status: 'ACTIVE',
  });
  mocks.roleFindFirst.mockResolvedValue({
    id: ROLE,
    key: 'general-manager',
    name: 'General Manager',
  });
  mocks.assignmentFindFirst.mockResolvedValue(null);
  mocks.assignmentUpsert.mockResolvedValue({ organizationRoleId: ROLE, active: true });
  mocks.assignmentCount.mockResolvedValue(1);
  mocks.roleCount.mockResolvedValue(HOSPITALITY_ROLE_KEYS.length);
  mocks.propertyFindUniqueOrThrow.mockResolvedValue(READY_PROPERTY);
  mocks.propertyUpdate.mockImplementation(async (args: { data: { active: boolean } }) => ({
    branchId: BRANCH,
    name: 'Serena Gulberg',
    active: args.data.active,
  }));
  mocks.auditCreate.mockResolvedValue({ id: 'audit_1' });
});

// ---------------------------------------------------------------------------
// G2 — manager-loss recovery
// ---------------------------------------------------------------------------
describe('organization.hotelproperty.recover', () => {
  const payload = {
    organizationId: ORG,
    branchId: BRANCH,
    userId: USER,
    organizationRoleId: ROLE,
    reason: REASON,
  };

  it('assigns the exact tuple it was given and never searches for a manager', async () => {
    await run('organization.hotelproperty.recover', payload);

    expect(mocks.assignmentUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.assignmentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_branchId_userId: {
            organizationId: ORG,
            branchId: BRANCH,
            userId: USER,
          },
        },
        create: {
          organizationId: ORG,
          branchId: BRANCH,
          userId: USER,
          organizationRoleId: ROLE,
          active: true,
        },
        update: { organizationRoleId: ROLE, active: true },
      })
    );
    // The whole point of the command: it must work when the property has no
    // manager at all, so nothing it reads may be an existing eligible manager.
    // The only assignment read is the (org, branch, user) row it is about to
    // write — the before-image for the ledger, not a precondition.
    expect(mocks.assignmentCount).not.toHaveBeenCalled();
    expect(mocks.assignmentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, branchId: BRANCH, userId: USER },
      })
    );
  });

  it('takes the property row’s own lock before deciding anything', async () => {
    await run('organization.hotelproperty.recover', payload);

    const lock = mocks.queryRawUnsafe.mock.calls.find(([sql]) =>
      String(sql).includes('hotel_properties')
    );
    expect(lock).toBeDefined();
    expect(String(lock![0])).toContain('FOR UPDATE');
    // Scoped by organization as well as by primary key: a crafted branch id from
    // another tenant finds no row here, before RLS is even consulted.
    expect(String(lock![0])).toContain('"organizationId" = $1');
    expect(String(lock![0])).toContain('"branchId" = $2');
    expect(lock!.slice(1)).toEqual([ORG, BRANCH]);
  });

  it('runs under organizations:write and audits the reason, not the reveal payload', async () => {
    await run('organization.hotelproperty.recover', payload);

    expect(mocks.assertCapability).toHaveBeenCalledWith(actor, 'organizations:write');
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    const audited = mocks.auditCreate.mock.calls[0]![0] as {
      data: {
        action: string;
        organizationId: string;
        targetType: string;
        after: Record<string, unknown>;
      };
    };
    expect(audited.data.action).toBe('organization.hotelproperty.recover');
    expect(audited.data.organizationId).toBe(ORG);
    expect(audited.data.targetType).toBe('HotelPropertyAssignment');
    expect(audited.data.after).toMatchObject({
      organizationId: ORG,
      branchId: BRANCH,
      userId: USER,
      roleKey: 'general-manager',
      active: true,
      reason: REASON,
      propertyActive: true,
      resolvesTenantScope: true,
    });
  });

  it('records the before-image when it retargets an existing assignment', async () => {
    mocks.assignmentFindFirst.mockResolvedValue({
      organizationRoleId: 'role_fda',
      active: false,
      role: { key: 'front-desk-agent' },
    });

    await run('organization.hotelproperty.recover', payload);

    const audited = mocks.auditCreate.mock.calls[0]![0] as {
      data: { before?: Record<string, unknown> };
    };
    expect(audited.data.before).toMatchObject({
      organizationRoleId: 'role_fda',
      roleKey: 'front-desk-agent',
      active: false,
    });
  });

  it('accepts the bootstrap admin role but reports that it resolves no tenant scope', async () => {
    mocks.roleFindFirst.mockResolvedValue({
      id: 'role_admin',
      key: 'admin',
      name: 'Organization administrator',
    });
    mocks.assignmentUpsert.mockResolvedValue({ organizationRoleId: 'role_admin', active: true });

    await run('organization.hotelproperty.recover', {
      ...payload,
      organizationRoleId: 'role_admin',
    });

    const audited = mocks.auditCreate.mock.calls[0]![0] as {
      data: { after: Record<string, unknown> };
    };
    // `requireHotelPropertyScope` filters assignments by the hospitality role
    // keys, and `admin` is not one. The ledger says so rather than implying the
    // operator has restored a working scope.
    expect(audited.data.after).toMatchObject({
      roleKey: 'admin',
      propertyActive: true,
      resolvesTenantScope: false,
    });
  });

  // PROP-04 F-C — recovery is deliberately permitted while a property is out of
  // service, because `reactivateHotelProperty` refuses to return one without an
  // eligible manager, so the manager must be assignable first. The ledger used to
  // report `resolvesTenantScope: true` for that write, which an auditor reads as
  // "tenant access restored" — but `requireHotelPropertyScope` additionally
  // requires `property.active`, so the resolver still denies. The role is
  // eligible; the access is not. Both facts are recorded, separately.
  it('does not report restored tenant access while the property is out of service', async () => {
    routeRawQuery(lockedProperty({ active: false }));

    await run('organization.hotelproperty.recover', payload);

    const audited = mocks.auditCreate.mock.calls[0]![0] as {
      data: { after: Record<string, unknown> };
    };
    expect(audited.data.after).toMatchObject({
      // The assignment itself was written, and with an eligible hospitality role.
      roleKey: 'general-manager',
      active: true,
      // The property is the reason the resolver still says no.
      propertyActive: false,
      resolvesTenantScope: false,
    });
  });

  // The diagnostic is about scope resolution only. It must never be read as a
  // capability decision — that stays with `can(subjectFromSession(user), …)` on
  // the tenant request, and nothing here infers it from the operator's platform
  // identity. A revoked assignment on a live property is the mirror case.
  it('reports no resolved scope for a revoked assignment on a live property', async () => {
    mocks.assignmentUpsert.mockResolvedValue({ organizationRoleId: ROLE, active: false });

    await run('organization.hotelproperty.recover', payload);

    const audited = mocks.auditCreate.mock.calls[0]![0] as {
      data: { after: Record<string, unknown> };
    };
    expect(audited.data.after).toMatchObject({
      roleKey: 'general-manager',
      active: false,
      propertyActive: true,
      resolvesTenantScope: false,
    });
  });

  it('refuses a role outside this organization’s hospitality set', async () => {
    mocks.roleFindFirst.mockResolvedValue({ id: 'role_x', key: 'cashier', name: 'Cashier' });

    const error = await caught(run('organization.hotelproperty.recover', payload));

    expect((error as Error).message).toContain('hospitality roles');
    expect(mocks.assignmentUpsert).not.toHaveBeenCalled();
  });

  it('refuses a property that is not this organization’s', async () => {
    routeRawQuery([]);

    const error = await caught(run('organization.hotelproperty.recover', payload));

    expect((error as Error).message).toBe('Hotel property not found.');
    expect(mocks.assignmentUpsert).not.toHaveBeenCalled();
    // The failure is on the ledger too. A rejected tuple is a 400, so it is
    // categorized as a validation failure and carries that category's constant
    // sentence — never the operator's payload and never the thrown message.
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'organization.hotelproperty.recover',
        success: false,
        reason: 'Platform command validation failed.',
        metadata: { outcomeCategory: 'validation_failed' },
      }),
    });
    expect(JSON.stringify(mocks.auditCreate.mock.calls[0])).not.toContain(REASON);
  });

  it('refuses an organization that is not a hospitality tenant', async () => {
    mocks.orgFindUnique.mockResolvedValue({ id: ORG, status: 'ACTIVE', vertical: 'RESTAURANT' });

    const error = await caught(run('organization.hotelproperty.recover', payload));

    expect((error as Error).message).toContain('not a hospitality tenant');
    expect(mocks.assignmentUpsert).not.toHaveBeenCalled();
  });

  it('refuses a user who is not an active member of this organization', async () => {
    // `requireAssignableTarget` scopes the lookup by organizationId and by an
    // operable status, so a wrong-tenant id and a departed user both arrive here
    // as "no row" — the command cannot tell them apart and refuses either way.
    mocks.userFindFirst.mockResolvedValue(null);

    const error = await caught(run('organization.hotelproperty.recover', payload));

    expect((error as Error).message).toContain('active user in this organization');
    expect(mocks.userFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: USER,
          organizationId: ORG,
          status: { in: ['ACTIVE', 'ON_LEAVE'] },
        }),
      })
    );
    expect(mocks.assignmentUpsert).not.toHaveBeenCalled();
  });

  it('refuses break-glass access with no usable reason', async () => {
    for (const reason of [undefined, '', 'fix']) {
      vi.clearAllMocks();
      routeRawQuery();
      const error = await caught(run('organization.hotelproperty.recover', { ...payload, reason }));
      expect(error, JSON.stringify(reason)).toBeInstanceOf(Error);
      expect(mocks.assignmentUpsert).not.toHaveBeenCalled();
      expect(mocks.queryRawUnsafe).not.toHaveBeenCalledWith(
        expect.stringContaining('FOR UPDATE'),
        expect.anything(),
        expect.anything()
      );
    }
  });
});

// ---------------------------------------------------------------------------
// G3 — inactive-property lifecycle
// ---------------------------------------------------------------------------
describe('organization.hotelproperty.deactivate', () => {
  const payload = {
    organizationId: ORG,
    branchId: BRANCH,
    reason: 'Closed for refurbishment until the new wing opens.',
  };

  it('takes the named property out of service and audits both sides', async () => {
    await run('organization.hotelproperty.deactivate', payload);

    expect(mocks.propertyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { branchId: BRANCH }, data: { active: false } })
    );
    const audited = mocks.auditCreate.mock.calls[0]![0] as {
      data: { before: Record<string, unknown>; after: Record<string, unknown>; targetId: string };
    };
    expect(audited.data.targetId).toBe(BRANCH);
    expect(audited.data.before).toMatchObject({ branchId: BRANCH, active: true });
    expect(audited.data.after).toMatchObject({
      branchId: BRANCH,
      active: false,
      reason: payload.reason,
    });
  });

  it('refuses a property that is already out of service', async () => {
    routeRawQuery(lockedProperty({ active: false }));

    const error = await caught(run('organization.hotelproperty.deactivate', payload));

    expect((error as Error).message).toContain('already out of service');
    expect(mocks.propertyUpdate).not.toHaveBeenCalled();
  });
});

describe('organization.hotelproperty.reactivate', () => {
  const payload = {
    organizationId: ORG,
    branchId: BRANCH,
    reason: 'Refurbishment finished and the property reopens on Monday.',
  };

  beforeEach(() => {
    routeRawQuery(lockedProperty({ active: false }));
  });

  it('returns the property to service once readiness and a manager both hold', async () => {
    await run('organization.hotelproperty.reactivate', payload);

    expect(mocks.propertyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { branchId: BRANCH }, data: { active: true } })
    );
    // ROOM_TYPES is unanswerable in this build for every property, new or
    // returning, so it is reported and not used as a bar reactivation could never
    // clear. Every other blocking step is enforced — see the next test.
  });

  it('checks readiness against THIS property, not the first active one', async () => {
    await run('organization.hotelproperty.reactivate', payload);

    // `evaluateHotelReadiness` reads `findFirst({ active: true })`, which by
    // definition cannot see the inactive row being reactivated. The evidence is
    // therefore recomputed from the exact property instead.
    expect(mocks.propertyFindUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { branchId: BRANCH } })
    );
  });

  it('refuses a property whose onboarding evidence no longer stands', async () => {
    mocks.propertyFindUniqueOrThrow.mockResolvedValue({
      ...READY_PROPERTY,
      taxProfileId: null,
      businessDatePolicy: {},
    });

    const error = await caught(run('organization.hotelproperty.reactivate', payload));

    expect((error as Error).message).toContain('not ready to return to service');
    expect((error as Error).message).toContain('Tax profile');
    expect(mocks.propertyUpdate).not.toHaveBeenCalled();
  });

  it('refuses when no eligible explicit manager holds the property', async () => {
    mocks.assignmentCount.mockResolvedValue(0);

    const error = await caught(run('organization.hotelproperty.reactivate', payload));

    expect((error as Error).message).toContain('Assign a hospitality role');
    expect(mocks.propertyUpdate).not.toHaveBeenCalled();
    // "Eligible" is the same predicate the tRPC resolver uses, so it means
    // someone can genuinely reach the property once it is back — an active
    // assignment, an operable user, and a hospitality role.
    expect(mocks.assignmentCount).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        branchId: BRANCH,
        active: true,
        user: { organizationId: ORG, status: { in: ['ACTIVE', 'ON_LEAVE'] } },
        role: { organizationId: ORG, key: { in: HOSPITALITY_ROLE_KEYS } },
      },
    });
  });

  it('refuses to reopen a property inside a suspended or terminated organization', async () => {
    for (const status of ['SUSPENDED', 'TERMINATED', 'PURGING', 'PURGED']) {
      vi.clearAllMocks();
      routeRawQuery(lockedProperty({ active: false }));
      mocks.orgFindUnique.mockResolvedValue({ id: ORG, status, vertical: 'HOSPITALITY' });
      mocks.propertyUpdate.mockResolvedValue({ branchId: BRANCH, name: 'x', active: true });

      const error = await caught(run('organization.hotelproperty.reactivate', payload));

      expect((error as Error).message, status).toContain('cannot return a property to service');
      expect(mocks.propertyUpdate, status).not.toHaveBeenCalled();
    }
  });

  it('refuses a property that is already in service', async () => {
    routeRawQuery(lockedProperty({ active: true }));

    const error = await caught(run('organization.hotelproperty.reactivate', payload));

    expect((error as Error).message).toContain('already in service');
    expect(mocks.propertyUpdate).not.toHaveBeenCalled();
  });
});

// PROP-04 F-B — called directly rather than through the command boundary,
// because `organization.create` is `commands.vertical.test.ts`'s subject. What is
// pinned here is the audit fact that provisioning depends on: the bootstrap
// assignment names a role the tenant resolver accepts, so the ledger's claim that
// tenant scope resolves is true.
describe('assignBootstrapHotelPropertyManager', () => {
  const tuple = {
    organizationId: ORG,
    branchId: BRANCH,
    userId: USER,
    organizationRoleId: 'role_owner',
  };

  it('writes exactly the tuple it was handed and reports a resolvable scope', async () => {
    mocks.assignmentCreate.mockResolvedValue({ id: 'hpa_1' });

    const audit = await assignBootstrapHotelPropertyManager(platformDb as never, tuple);

    // One row, the exact tuple, nothing searched for.
    expect(mocks.assignmentCreate).toHaveBeenCalledTimes(1);
    expect(mocks.assignmentCreate).toHaveBeenCalledWith({ data: { ...tuple, active: true } });
    expect(mocks.userFindFirst).not.toHaveBeenCalled();
    expect(mocks.roleFindFirst).not.toHaveBeenCalled();

    expect(audit.roleKey).toBe(HOSPITALITY_OWNER_ROLE_KEY);
    expect(audit.propertyActive).toBe(true);
    expect(audit.resolvesTenantScope).toBe(true);
  });

  it('names a role key the tRPC resolver filters on, which `admin` is not', async () => {
    // The end-to-end predicate the first delivery broke: the assignment satisfied
    // the SQL policy (which never inspects a role key) and still resolved to no
    // tRPC scope, so a newly provisioned tenant opened on an unreachable property.
    expect(HOTEL_ROLE_KEYS).toContain(HOSPITALITY_OWNER_ROLE_KEY);
    expect(HOTEL_ROLE_KEYS).not.toContain(BOOTSTRAP_ADMIN_ROLE_KEY);
  });
});
