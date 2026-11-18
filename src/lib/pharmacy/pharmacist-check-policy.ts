import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { PHARMACIST_CHECK_DISCLAIMER, pharmacistCheckDisclaimerRecord } from './pharmacist-check';

/**
 * DEV-911 — the owner switch for the pharmacist check and prescription record at each sale,
 * server side.
 *
 * Storage is the #518 owner-policy row (`pharmacy_owner_policies`, FORCE RLS) and its
 * append-only, trigger-written audit (`pharmacy_owner_policy_audit`), as DEV-753 uses it for
 * supplier checks. `readPharmacistCheckPolicy` is the ONE reader: every place that demands a
 * pharmacist's verification or a prescription at a sale asks `pharmacistCheckAtSaleEnabled`,
 * and nothing else reads the column.
 *
 * Fail closed: a missing row is the default (check ON), and a malformed or unreadable row is
 * enforced too. Only an explicit stored `false` turns the check off.
 */

export const PHARMACIST_CHECK_SETTING = 'pharmacistCheckEnabled';

export type PharmacistCheckPolicyState = {
  enabled: boolean;
  version: number;
  source: 'DEFAULT' | 'STORED' | 'FAIL_CLOSED';
};

const DEFAULT_STATE: PharmacistCheckPolicyState = Object.freeze({
  enabled: true,
  version: 0,
  source: 'DEFAULT',
});

const FAIL_CLOSED_STATE: PharmacistCheckPolicyState = Object.freeze({
  enabled: true,
  version: 0,
  source: 'FAIL_CLOSED',
});

type PolicyRow = { enabled: unknown; version: unknown };

function stateFromRows(rows: unknown): PharmacistCheckPolicyState {
  if (!Array.isArray(rows)) return FAIL_CLOSED_STATE;
  if (rows.length === 0) return DEFAULT_STATE;
  const row = rows[0] as PolicyRow | null | undefined;
  if (
    rows.length !== 1 ||
    !row ||
    typeof row.enabled !== 'boolean' ||
    typeof row.version !== 'number' ||
    !Number.isSafeInteger(row.version) ||
    row.version < 0 ||
    // An OFF state always has a positive version: the database bumps it on every change.
    (row.enabled === false && row.version < 1)
  ) {
    return FAIL_CLOSED_STATE;
  }
  return { enabled: row.enabled, version: row.version, source: 'STORED' };
}

/**
 * The organization's pharmacist-check setting. Any failure enforces the check. Inside a
 * transaction a failed read has also aborted the transaction, so the sale it guards cannot
 * commit either way.
 */
export async function readPharmacistCheckPolicy(
  db: ScopedDb,
  organizationId: string | null | undefined,
  options: { lock?: 'update' } = {}
): Promise<PharmacistCheckPolicyState> {
  if (!organizationId) return FAIL_CLOSED_STATE;
  try {
    if (options.lock === 'update') {
      // The owner's write: lock the row so concurrent changes serialize on the version.
      const rows = await db.$queryRaw<PolicyRow[]>(Prisma.sql`
        SELECT "pharmacistCheckEnabled" AS "enabled",
               "pharmacistCheckPolicyVersion" AS "version"
          FROM "pharmacy_owner_policies"
         WHERE "organizationId" = ${organizationId}
           FOR UPDATE`);
      return stateFromRows(rows);
    }
    const row = await db.pharmacyOwnerPolicy.findUnique({
      where: { organizationId },
      select: { pharmacistCheckEnabled: true, pharmacistCheckPolicyVersion: true },
    });
    return stateFromRows(
      row
        ? [{ enabled: row.pharmacistCheckEnabled, version: row.pharmacistCheckPolicyVersion }]
        : []
    );
  } catch {
    return FAIL_CLOSED_STATE;
  }
}

/**
 * True unless the owner has switched the pharmacist check off. Every pharmacist-verification
 * and prescription gate at a sale calls this, and only when it is about to refuse, so with
 * the check on the gate behaves exactly as before.
 */
export async function pharmacistCheckAtSaleEnabled(
  db: ScopedDb,
  organizationId: string | null | undefined
): Promise<boolean> {
  return (await readPharmacistCheckPolicy(db, organizationId)).enabled;
}

/** A live DENY on any of these takes the authority away, from the role or a user override. */
const POLICY_DENIALS = new Set(['*', 'pharmacy:*', 'pharmacy:manage', 'pharmacy:dispense']);

/**
 * Only the tenant owner may change this setting: an ACTIVE user of this organization holding
 * its system `owner` role, with no live DENY on '*', 'pharmacy:*', 'pharmacy:manage' or
 * 'pharmacy:dispense'. A manager, pharmacist, cashier, or an ADMIN without the owner role is
 * refused. Verified from the live database, never from the session. The database trigger
 * applies the same rule to any writer.
 */
export async function isPharmacistCheckPolicyOwner(
  db: ScopedDb,
  organizationId: string,
  userId: string,
  options: { now?: Date; lock?: boolean } = {}
): Promise<boolean> {
  if (!organizationId || !userId) return false;
  const now = options.now ?? new Date();
  if (options.lock) {
    await db.$queryRaw(Prisma.sql`
      SELECT "id" FROM "users"
       WHERE "id" = ${userId} AND "organizationId" = ${organizationId}
       FOR SHARE`);
  }
  const user = await db.user.findFirst({
    where: { id: userId, organizationId, status: 'ACTIVE' },
    select: {
      id: true,
      organizationId: true,
      status: true,
      organizationRole: {
        select: {
          key: true,
          isSystem: true,
          organizationId: true,
          permissions: { select: { capability: true, effect: true } },
        },
      },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  if (
    !user ||
    user.id !== userId ||
    user.organizationId !== organizationId ||
    user.status !== 'ACTIVE'
  )
    return false;
  const role = user.organizationRole;
  if (
    !role ||
    role.isSystem !== true ||
    role.key !== 'owner' ||
    role.organizationId !== organizationId
  )
    return false;
  return ![...(user.permissionOverrides ?? []), ...(role.permissions ?? [])].some(
    (rule) => rule.effect === 'DENY' && POLICY_DENIALS.has(rule.capability)
  );
}

export class PharmacistCheckPolicyError extends Error {
  constructor(
    readonly reason:
      | 'NOT_OWNER'
      | 'SUPPORT_SESSION'
      | 'PIN_REQUIRED'
      | 'PIN_REJECTED'
      | 'PIN_LOCKED'
      | 'NO_PIN'
      | 'DISCLAIMER_REQUIRED'
      | 'STALE_DISCLAIMER'
      | 'VERSION_CONFLICT'
  ) {
    super(reason);
    this.name = 'PharmacistCheckPolicyError';
  }
}

/**
 * The owner's write. Idempotent on the desired state: asking for the state already in force
 * changes nothing and audits nothing. A real change needs the version the caller last saw,
 * and turning the check off needs the current disclaimer accepted; the accepted text is
 * stored with the change. The row trigger bumps the version, stamps the actor and appends the
 * audit row in the same transaction.
 *
 * Call inside a transaction. The caller has already verified the owner and their fresh PIN.
 */
export async function writePharmacistCheckPolicy(
  db: ScopedDb,
  scope: { organizationId: string; actorId: string },
  input: {
    enabled: boolean;
    expectedVersion: number;
    disclaimer?: { accepted: boolean; version: string };
  }
): Promise<{
  changed: boolean;
  previous: PharmacistCheckPolicyState;
  policy: PharmacistCheckPolicyState;
  acceptedDisclaimer: string | null;
}> {
  const current = await readPharmacistCheckPolicy(db, scope.organizationId, { lock: 'update' });
  if (current.source === 'FAIL_CLOSED') throw new PharmacistCheckPolicyError('VERSION_CONFLICT');
  if (current.enabled === input.enabled) {
    return { changed: false, previous: current, policy: current, acceptedDisclaimer: null };
  }
  if (current.version !== input.expectedVersion) {
    throw new PharmacistCheckPolicyError('VERSION_CONFLICT');
  }
  let acceptedDisclaimer: string | null = null;
  if (!input.enabled) {
    if (!input.disclaimer?.accepted) throw new PharmacistCheckPolicyError('DISCLAIMER_REQUIRED');
    if (input.disclaimer.version !== PHARMACIST_CHECK_DISCLAIMER.version)
      throw new PharmacistCheckPolicyError('STALE_DISCLAIMER');
    acceptedDisclaimer = pharmacistCheckDisclaimerRecord();
  }

  const written =
    current.source === 'DEFAULT'
      ? // No row yet. A concurrent first write makes this insert a no-op, which is a conflict.
        await db.$queryRaw<PolicyRow[]>(Prisma.sql`
          INSERT INTO "pharmacy_owner_policies"
            ("organizationId", "pharmacistCheckEnabled", "pharmacistCheckAcknowledgement",
             "updatedByUserId")
          VALUES (${scope.organizationId}, ${input.enabled}, ${acceptedDisclaimer},
                  ${scope.actorId})
          ON CONFLICT ("organizationId") DO NOTHING
          RETURNING "pharmacistCheckEnabled" AS "enabled",
                    "pharmacistCheckPolicyVersion" AS "version"`)
      : await db.$queryRaw<PolicyRow[]>(Prisma.sql`
          UPDATE "pharmacy_owner_policies"
             SET "pharmacistCheckEnabled" = ${input.enabled},
                 "pharmacistCheckAcknowledgement" = ${acceptedDisclaimer},
                 "updatedByUserId" = ${scope.actorId}
           WHERE "organizationId" = ${scope.organizationId}
             AND "pharmacistCheckPolicyVersion" = ${input.expectedVersion}
          RETURNING "pharmacistCheckEnabled" AS "enabled",
                    "pharmacistCheckPolicyVersion" AS "version"`);
  const policy = stateFromRows(written);
  if (policy.source !== 'STORED' || policy.enabled !== input.enabled) {
    throw new PharmacistCheckPolicyError('VERSION_CONFLICT');
  }
  return { changed: true, previous: current, policy, acceptedDisclaimer };
}

export type PharmacistCheckPolicyChange = {
  id: string;
  oldValue: boolean | null;
  newValue: boolean;
  policyVersion: number | null;
  acknowledgement: string | null;
  actorUserId: string | null;
  changedAt: Date;
};

/** The pharmacist-check audit trail, newest first: who, when, and the disclaimer accepted. */
export async function readPharmacistCheckPolicyHistory(
  db: ScopedDb,
  organizationId: string,
  limit = 20
): Promise<PharmacistCheckPolicyChange[]> {
  const take = Math.min(Math.max(Math.trunc(limit), 1), 200);
  return db.$queryRaw<PharmacistCheckPolicyChange[]>(Prisma.sql`
    SELECT "id", "oldValue", "newValue", "policyVersion", "acknowledgement",
           "actorUserId", "changedAt"
      FROM "pharmacy_owner_policy_audit"
     WHERE "organizationId" = ${organizationId}
       AND "setting" = ${PHARMACIST_CHECK_SETTING}
     ORDER BY "changedAt" DESC, "id" DESC
     LIMIT ${take}`);
}
