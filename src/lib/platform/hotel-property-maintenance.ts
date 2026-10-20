import 'server-only';

import type { PrismaClient } from '@/generated/prisma/client';
import {
  countSellableRoomTypes,
  evaluateHotelOnboarding,
  hotelEvidence,
  type HotelChecklistItem,
} from '@/lib/hotel/onboarding-checklist';
import { PlatformSecurityError } from '@/lib/platform/security';
import { roleTemplatesForVertical } from '@/lib/vertical-catalog';

/**
 * PROP-04 (G1–G3) — the control-plane half of per-property access.
 *
 * `hotel_property_assignments` is the only thing that makes a property reachable:
 * the restrictive policy this lane completes (migration
 * `20260915010000_hotel_property_maintenance`) denies `hotel_properties` to any
 * tenant connection without an active assignment, and the tRPC resolver
 * (`src/server/hotel-property-scope.ts`) denies the request on top of that. Both
 * walls stay up. Nothing here grants a capability, widens a role, or assigns more
 * than the one property it was handed — the role is an `OrganizationRole` that
 * already exists with the permissions it already had, so recovery can only point
 * an existing ceiling at one property.
 *
 * Every function takes a `PrismaClient` that is already inside
 * `withPlatformDb`'s transaction. That transaction sets
 * `app.is_platform_admin = 'true'`, which is the single signal the completed
 * policy admits, and `withTenantDb` sets that same GUC to `'false'`, so a tenant
 * connection can never reach these rows through this door. Platform *identity*
 * and *capability* enforcement stay where they already are — `/api/platform/control`
 * checks `organizations:security:write` before any of this runs. SQL assignment membership
 * is not a substitute for that check and is never treated as one.
 */

/**
 * The role keys a hospitality organization is provisioned with. Read from the
 * vertical catalog rather than restated, because `requireHotelPropertyScope`
 * filters assignments by exactly this set — a key that is not here resolves to
 * no scope in tRPC no matter what the assignment row says.
 */
export const HOTEL_ROLE_KEYS: readonly string[] = roleTemplatesForVertical('HOSPITALITY').map(
  (template) => template.key
);

/**
 * The bootstrap `admin` role `bootstrapOrganization` creates before any vertical
 * role exists. It is accepted as a recovery target because it is the role the
 * named bootstrap administrator actually holds, but note that it is deliberately
 * NOT in {@link HOTEL_ROLE_KEYS}: an assignment carrying it makes the property
 * visible at the SQL layer and still resolves to no tRPC scope, which is why
 * provisioning names {@link HOSPITALITY_OWNER_ROLE_KEY} instead and why an audit
 * row carrying this key reports `resolvesTenantScope: false`.
 */
export const BOOTSTRAP_ADMIN_ROLE_KEY = 'admin';

/**
 * The hospitality Owner template (`vertical-catalog.ts`), which provisioning
 * instantiates for every HOSPITALITY organization and which
 * {@link assignBootstrapHotelPropertyManager} names as the bootstrap
 * assignment's role. It is in {@link HOTEL_ROLE_KEYS}, so unlike the bootstrap
 * `admin` role it actually resolves a tRPC property scope; its capabilities are
 * the same `'*'` the bootstrap `admin` role already carries, so naming it widens
 * nothing — the organization's own ABAC stays the ceiling and
 * `requireHotelPropertyScope` evaluates it before it reads any assignment.
 */
export const HOSPITALITY_OWNER_ROLE_KEY = 'owner';

/**
 * Organization lifecycle states a property may be returned to service in.
 * SUSPENDED, TERMINATED, PURGING and PURGED are omitted on purpose: reactivating
 * a property inside one of those would re-open access the lifecycle closed, which
 * is precisely the bypass this check exists to refuse.
 */
const REACTIVATABLE_ORGANIZATION_STATUSES = new Set(['ONBOARDING', 'ACTIVE', 'GRACE']);

/** The exact tuple every write here names. Nothing is inferred from it. */
export type HotelPropertyTuple = {
  organizationId: string;
  branchId: string;
  userId: string;
  organizationRoleId: string;
};

export type HotelPropertyAssignmentAudit = {
  organizationId: string;
  branchId: string;
  userId: string;
  organizationRoleId: string;
  roleKey: string;
  active: boolean;
  /** The locked property's own `active` flag, read inside the property lock. */
  propertyActive: boolean;
  /**
   * Whether `requireHotelPropertyScope` would resolve a scope for this
   * assignment — its role key is one of {@link HOTEL_ROLE_KEYS} AND the property
   * is in service, because the resolver filters on `property.active` too. Both
   * halves are required: recovery is deliberately permitted on an inactive
   * property (reactivation demands an eligible manager first), so the role alone
   * would report restored access the resolver still denies.
   *
   * This is a scope-resolution diagnostic and nothing more. It is NOT a statement
   * that the holder is authorized for any particular capability: the tenant
   * request evaluates `can(subjectFromSession(user), capability, …)` independently
   * and before it reads any assignment, and no permission decision is inferred
   * here from the operator's platform identity.
   */
  resolvesTenantScope: boolean;
};

type LockedProperty = { branchId: string; active: boolean; name: string };

/**
 * Take the property row's own lock and read it back inside that lock.
 *
 * `FOR UPDATE` on the exact `(organizationId, branchId)` tuple — not on the
 * organization, and not on the table — is what serializes two operators
 * recovering or deactivating the same property at once. The row is re-read here
 * rather than by Prisma beforehand so every decision below is made on the locked
 * state, not on a value that was true before the lock was granted.
 *
 * Raw SQL because Prisma has no `FOR UPDATE`; parameterized, and scoped by
 * `organizationId` as well as the primary key so a crafted branch id from another
 * tenant finds nothing even before RLS is consulted.
 */
async function lockProperty(
  db: PrismaClient,
  organizationId: string,
  branchId: string
): Promise<LockedProperty> {
  const rows = await db.$queryRawUnsafe<LockedProperty[]>(
    `SELECT "branchId", "active", "name"
       FROM "hotel_properties"
      WHERE "organizationId" = $1 AND "branchId" = $2
      FOR UPDATE`,
    organizationId,
    branchId
  );
  const property = rows[0];
  if (!property) throw new PlatformSecurityError('Hotel property not found.', 400);
  return property;
}

/**
 * The organization, refused unless it is a hospitality tenant. A property id that
 * belongs to another organization is already excluded by the composite predicate
 * in {@link lockProperty}; this refuses the case where the organization itself is
 * the wrong kind, which no property lookup can catch.
 */
async function requireHospitalityOrganization(db: PrismaClient, organizationId: string) {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, status: true, vertical: true },
  });
  if (!organization) throw new PlatformSecurityError('Organization not found.', 400);
  if (organization.vertical !== 'HOSPITALITY') {
    throw new PlatformSecurityError('This organization is not a hospitality tenant.', 400);
  }
  return organization;
}

/**
 * The named user and the named role, both required to be this organization's own
 * and both read after the property lock. A user who has left (`INACTIVE`,
 * `INVITED`) is refused rather than assigned: the SQL policy and the tRPC
 * resolver both require `ACTIVE`/`ON_LEAVE`, so an assignment to anyone else is a
 * row that grants nothing and reads as access that does not exist.
 */
async function requireAssignableTarget(db: PrismaClient, tuple: HotelPropertyTuple) {
  const user = await db.user.findFirst({
    where: {
      id: tuple.userId,
      organizationId: tuple.organizationId,
      status: { in: ['ACTIVE', 'ON_LEAVE'] },
    },
    select: { id: true, name: true, email: true, status: true },
  });
  if (!user) {
    throw new PlatformSecurityError(
      'Choose an active user in this organization to hold the property.',
      400
    );
  }
  const role = await db.organizationRole.findFirst({
    where: { id: tuple.organizationRoleId, organizationId: tuple.organizationId },
    select: { id: true, key: true, name: true },
  });
  if (!role) throw new PlatformSecurityError('Organization role not found.', 400);
  // The authorization ceiling: recovery points an EXISTING role at one property.
  // It never creates a role, never edits its permissions and never accepts a role
  // outside the hospitality set plus the bootstrap administrator, so it cannot be
  // used to hand someone a capability the organization did not already grant.
  if (!HOTEL_ROLE_KEYS.includes(role.key) && role.key !== BOOTSTRAP_ADMIN_ROLE_KEY) {
    throw new PlatformSecurityError(
      'Choose one of this organization’s hospitality roles for the property.',
      400
    );
  }
  return { user, role };
}

function assignmentAudit(
  tuple: HotelPropertyTuple,
  roleKey: string,
  active: boolean,
  propertyActive: boolean
): HotelPropertyAssignmentAudit {
  return {
    organizationId: tuple.organizationId,
    branchId: tuple.branchId,
    userId: tuple.userId,
    organizationRoleId: tuple.organizationRoleId,
    roleKey,
    active,
    propertyActive,
    // Both conditions the resolver's row predicate carries. A role key alone is
    // not access: an out-of-service property is denied to its own assigned user.
    resolvesTenantScope: HOTEL_ROLE_KEYS.includes(roleKey) && active && propertyActive,
  };
}

/**
 * G1 — the bootstrap administrator's assignment to the property provisioning just
 * created, written inside that same provisioning transaction.
 *
 * Deliberately takes ids and queries nothing. The caller has the exact tuple in
 * hand (the organization, the property row it just created, the operator-named
 * administrator it just created, and this organization's own Hospitality Owner
 * role), so there is no "oldest admin" or "first employee" to infer and no
 * lookup that
 * could pick a different person than the operator named.
 *
 * This is what closes the creation/RETURNING circularity. The restrictive policy
 * requires an assignment before the property is readable, and the first
 * assignment cannot exist before the property does; the platform transaction is
 * admitted by the completed policy, so the `INSERT ... RETURNING` yields
 * `branchId` and the assignment is written against it before the transaction
 * commits. Either both rows exist or neither does.
 *
 * The role the caller must hand in is the organization's own
 * {@link HOSPITALITY_OWNER_ROLE_KEY} role — the Owner template provisioning
 * already instantiates, carrying the identical `'*'` the bootstrap `admin` role
 * carries, so the recipient's privilege ceiling is unchanged and is still
 * enforced by the organization's own ABAC. It is named rather than `admin`
 * because `requireHotelPropertyScope` filters assignments by
 * {@link HOTEL_ROLE_KEYS}, and `admin` is not one of them: an assignment carrying
 * it makes the property visible in SQL and resolves to NO tRPC scope, which would
 * open every new hospitality tenant on a property nobody in it could operate.
 *
 * The property row is freshly created by the same transaction and is therefore
 * in service, which is why the audit reports `propertyActive: true` without a
 * read — the caller holds the row it just wrote.
 */
export async function assignBootstrapHotelPropertyManager(
  db: PrismaClient,
  tuple: HotelPropertyTuple
): Promise<HotelPropertyAssignmentAudit> {
  await db.hotelPropertyAssignment.create({
    data: {
      organizationId: tuple.organizationId,
      branchId: tuple.branchId,
      userId: tuple.userId,
      organizationRoleId: tuple.organizationRoleId,
      active: true,
    },
  });
  return assignmentAudit(tuple, HOSPITALITY_OWNER_ROLE_KEY, true, true);
}

export type HotelPropertyRecoveryResult = {
  audit: HotelPropertyAssignmentAudit;
  auditBefore: HotelPropertyAssignmentAudit | null;
  propertyName: string;
  userName: string;
  roleName: string;
};

/**
 * G2 — return one named property to one named person, audited, with a reason.
 *
 * The case this exists for is manager loss: the only person assigned to a
 * property has left, so nobody inside the tenant can reach it and nobody inside
 * the tenant can fix that, because the tenant write policy requires the actor to
 * already hold an assignment at that branch. Recovery therefore must not depend
 * on an existing manager, and this does not read one.
 *
 * What it is not: it is not impersonation (no tenant session is created, nothing
 * runs as the tenant user) and it is not a blanket grant (one property, one
 * person, one existing role — an operator who wants two properties issues two
 * audited commands and the ledger shows two).
 */
export async function recoverHotelPropertyManager(
  db: PrismaClient,
  tuple: HotelPropertyTuple
): Promise<HotelPropertyRecoveryResult> {
  const property = await lockProperty(db, tuple.organizationId, tuple.branchId);
  await requireHospitalityOrganization(db, tuple.organizationId);
  const { user, role } = await requireAssignableTarget(db, tuple);

  // Read after the lock, so a concurrent recovery of the same property is
  // serialized behind it and this sees that recovery's committed result rather
  // than the state it started from.
  const existing = await db.hotelPropertyAssignment.findFirst({
    where: {
      organizationId: tuple.organizationId,
      branchId: tuple.branchId,
      userId: tuple.userId,
    },
    select: { organizationRoleId: true, active: true, role: { select: { key: true } } },
  });

  const saved = await db.hotelPropertyAssignment.upsert({
    where: {
      organizationId_branchId_userId: {
        organizationId: tuple.organizationId,
        branchId: tuple.branchId,
        userId: tuple.userId,
      },
    },
    create: {
      organizationId: tuple.organizationId,
      branchId: tuple.branchId,
      userId: tuple.userId,
      organizationRoleId: tuple.organizationRoleId,
      active: true,
    },
    update: { organizationRoleId: tuple.organizationRoleId, active: true },
    select: { organizationRoleId: true, active: true },
  });

  // `property.active` comes from the locked row, and recovery is deliberately
  // permitted while a property is out of service — `reactivateHotelProperty`
  // refuses to return one without an eligible manager, so the manager has to be
  // assignable first. The ledger therefore records the assignment as written AND
  // that the resolver still denies it until the property is back in service,
  // rather than reporting access restored on a property nobody can reach.
  return {
    audit: assignmentAudit(
      { ...tuple, organizationRoleId: saved.organizationRoleId },
      role.key,
      saved.active,
      property.active
    ),
    auditBefore: existing
      ? assignmentAudit(
          { ...tuple, organizationRoleId: existing.organizationRoleId },
          existing.role.key,
          existing.active,
          property.active
        )
      : null,
    propertyName: property.name,
    userName: user.name,
    roleName: role.name,
  };
}

export type HotelPropertyLifecycleResult = {
  branchId: string;
  name: string;
  active: boolean;
  /** Blocking checklist rows, when reactivation refused. Empty on success. */
  blocking: readonly HotelChecklistItem[];
};

/**
 * G3 — take one named property out of service.
 *
 * Ordinary tenant access is denied for an inactive property by the restrictive
 * policy's own `"active"` predicate, which is why this is the only path back:
 * once the flag is down no tenant connection can see the row to raise it again.
 * Assignments are left untouched so the property returns to the same people.
 */
export async function deactivateHotelProperty(
  db: PrismaClient,
  organizationId: string,
  branchId: string
): Promise<HotelPropertyLifecycleResult> {
  const property = await lockProperty(db, organizationId, branchId);
  await requireHospitalityOrganization(db, organizationId);
  if (!property.active) {
    throw new PlatformSecurityError('This property is already out of service.', 400);
  }
  const saved = await db.hotelProperty.update({
    where: { branchId },
    data: { active: false },
    select: { branchId: true, name: true, active: true },
  });
  return { ...saved, blocking: [] };
}

/**
 * G3 — return one named property to service.
 *
 * Two conditions, neither bypassed:
 *
 *  - the organization is in a lifecycle state that may operate at all
 *    (see {@link REACTIVATABLE_ORGANIZATION_STATUSES}), and its own onboarding
 *    evidence still stands. The evidence is recomputed from the property row and
 *    the organization's roles through the same `hotelEvidence` the activation
 *    preflight uses — never read off a stored claim — and it is computed against
 *    THIS property rather than `evaluateHotelReadiness`'s "first active property",
 *    which by definition cannot see the inactive row being reactivated.
 *  - an eligible explicit manager already holds it: an active assignment, an
 *    `ACTIVE`/`ON_LEAVE` user, and a role in `HOTEL_ROLE_KEYS`. That is exactly
 *    the predicate `requireHotelPropertyScope` resolves on, so "eligible" means
 *    someone can genuinely reach the property once it is back, not merely that a
 *    row exists. A property whose only assignment is the bootstrap `admin` role
 *    does not qualify, and an operator grants a hospitality role first.
 */
export async function reactivateHotelProperty(
  db: PrismaClient,
  organizationId: string,
  branchId: string
): Promise<HotelPropertyLifecycleResult> {
  const property = await lockProperty(db, organizationId, branchId);
  const organization = await requireHospitalityOrganization(db, organizationId);
  if (property.active) {
    throw new PlatformSecurityError('This property is already in service.', 400);
  }
  if (!REACTIVATABLE_ORGANIZATION_STATUSES.has(organization.status)) {
    throw new PlatformSecurityError(
      `A ${organization.status} organization cannot return a property to service.`,
      400
    );
  }

  const requiredRoleKeys = roleTemplatesForVertical('HOSPITALITY').map((template) => template.key);
  const [facts, seededRoleKeys, eligibleManagers, roomTypes] = await Promise.all([
    db.hotelProperty.findUniqueOrThrow({
      where: { branchId },
      select: {
        mode: true,
        name: true,
        addressLine: true,
        city: true,
        timezone: true,
        checkInTime: true,
        checkOutTime: true,
        auditTime: true,
        taxProfileId: true,
        businessDatePolicy: true,
      },
    }),
    db.organizationRole.count({ where: { organizationId, key: { in: requiredRoleKeys } } }),
    db.hotelPropertyAssignment.count({
      where: {
        organizationId,
        branchId,
        active: true,
        user: { organizationId, status: { in: ['ACTIVE', 'ON_LEAVE'] } },
        role: { organizationId, key: { in: requiredRoleKeys } },
      },
    }),
    // Counted against THIS property, like the facts: the readiness resolver's
    // "first active property" cannot see the inactive row being reactivated.
    countSellableRoomTypes(db, organizationId, branchId),
  ]);

  const checklist = evaluateHotelOnboarding(
    organizationId,
    hotelEvidence(facts, seededRoleKeys, requiredRoleKeys.length, roomTypes)
  );
  const { blocking } = checklist;
  if (blocking.length) {
    throw new PlatformSecurityError(
      `This property is not ready to return to service: ${blocking
        .map((item) => item.label)
        .join(', ')}.`,
      400
    );
  }
  if (eligibleManagers === 0) {
    throw new PlatformSecurityError(
      'Assign a hospitality role at this property before returning it to service.',
      400
    );
  }

  const saved = await db.hotelProperty.update({
    where: { branchId },
    data: { active: true },
    select: { branchId: true, name: true, active: true },
  });
  return { ...saved, blocking: [] };
}
