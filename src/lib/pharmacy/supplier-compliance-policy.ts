import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { can } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  assertSupplierEligible,
  licenceEvidence,
  PharmacyPurchasingError,
  type SupplierComplianceOutcome,
  type SupplierCompliancePolicy,
  type SupplierLicenceEvidence,
} from './purchasing';
import {
  SUPPLIER_COMPLIANCE_WARNING,
  supplierComplianceAcknowledgementRecord,
  type SupplierComplianceOperation,
} from './supplier-compliance';

/**
 * DEV-753 — the owner switch for supplier compliance checks, server side.
 *
 * Storage is the #518 owner-policy row (`pharmacy_owner_policies`, FORCE RLS) and its
 * append-only, trigger-written audit (`pharmacy_owner_policy_audit`). This module is the
 * one reader and the one writer of the supplier columns. It deliberately adds nothing for
 * the prescription column: that API is pending elsewhere and nothing here reads it.
 *
 * Fail closed: a missing row is the default (checks ON), and a malformed or unreadable
 * row is enforced too. Only an explicit stored `false` turns the checks off.
 */

export const SUPPLIER_COMPLIANCE_SETTING = 'supplierComplianceChecksEnabled';

export type SupplierCompliancePolicyState = SupplierCompliancePolicy & {
  source: 'DEFAULT' | 'STORED' | 'FAIL_CLOSED';
  updatedAt: Date | null;
  updatedByUserId: string | null;
};

const DEFAULT_STATE: SupplierCompliancePolicyState = Object.freeze({
  checksEnabled: true,
  version: 0,
  source: 'DEFAULT',
  updatedAt: null,
  updatedByUserId: null,
});

const FAIL_CLOSED_STATE: SupplierCompliancePolicyState = Object.freeze({
  checksEnabled: true,
  version: 0,
  source: 'FAIL_CLOSED',
  updatedAt: null,
  updatedByUserId: null,
});

type PolicyRow = {
  checksEnabled: unknown;
  version: unknown;
  updatedAt: unknown;
  updatedByUserId: unknown;
};

function stateFromRows(rows: readonly PolicyRow[]): SupplierCompliancePolicyState {
  if (rows.length === 0) return DEFAULT_STATE;
  const row = rows[0]!;
  if (
    rows.length !== 1 ||
    typeof row.checksEnabled !== 'boolean' ||
    typeof row.version !== 'number' ||
    !Number.isSafeInteger(row.version) ||
    row.version < 0
  ) {
    return FAIL_CLOSED_STATE;
  }
  return {
    checksEnabled: row.checksEnabled,
    version: row.version,
    source: 'STORED',
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt : null,
    updatedByUserId: typeof row.updatedByUserId === 'string' ? row.updatedByUserId : null,
  };
}

/**
 * The organization's supplier-compliance policy. Inside a write transaction pass
 * `lock: 'share'`: a concurrent owner change then waits for this write to commit, so
 * the decision this write records is the policy in force when it committed.
 *
 * Any failure enforces. Inside a transaction a failed read has also aborted the
 * transaction, so the write it guards cannot commit either way.
 */
export async function readSupplierCompliancePolicy(
  db: ScopedDb,
  organizationId: string,
  options: { lock?: 'share' | 'update' } = {}
): Promise<SupplierCompliancePolicyState> {
  if (!organizationId) return FAIL_CLOSED_STATE;
  const lock =
    options.lock === 'update'
      ? Prisma.sql` FOR UPDATE`
      : options.lock === 'share'
        ? Prisma.sql` FOR SHARE`
        : Prisma.empty;
  try {
    const rows = await db.$queryRaw<PolicyRow[]>(Prisma.sql`
      SELECT "supplierComplianceChecksEnabled" AS "checksEnabled",
             "supplierCompliancePolicyVersion" AS "version",
             "updatedAt",
             "updatedByUserId"
        FROM "pharmacy_owner_policies"
       WHERE "organizationId" = ${organizationId}${lock}`);
    return stateFromRows(rows);
  } catch {
    return FAIL_CLOSED_STATE;
  }
}

/**
 * The settings capability that governs this policy. Central ABAC decides it from the
 * persisted role grants and live user overrides, and an explicit DENY always wins.
 */
export const SUPPLIER_POLICY_CAPABILITY = 'pharmacy:manage' as const;

/** A live user-level DENY on any of these also takes the authority away. */
const SUPPLIER_POLICY_DENIALS = [
  '*',
  'pharmacy:*',
  'pharmacy:manage',
  'pharmacy:procurement',
] as const;

export type SupplierPolicyAuthority =
  { allowed: true; basis: 'OWNER' | 'ADMIN' } | { allowed: false; basis: null };

const NO_AUTHORITY: SupplierPolicyAuthority = Object.freeze({ allowed: false, basis: null });

/**
 * Who may change the supplier-compliance policy, verified from the live database and
 * never from the session. The user must be ACTIVE in this organization and be either
 * the genuine tenant owner (this organization's system `owner` role) or a tenant
 * ADMIN by their stored user role. On top of that, central ABAC must grant the
 * pharmacy settings capability (`pharmacy:manage`, where an explicit DENY wins), and
 * the user must hold no live DENY on `*`, `pharmacy:*`, `pharmacy:manage` or
 * `pharmacy:procurement`.
 *
 * This is bounded to this one setting. It does not make an ADMIN the owner anywhere
 * else and grants nothing. A session that merely claims ADMIN, a demoted or inactive
 * user, another tenant's user, an ADMIN with no settings grant, and staff holding
 * `pharmacy:manage` without being ADMIN or owner (manager, owner-operator employee) are
 * all refused.
 *
 * With `lock`, the user row is share-locked for the rest of the transaction, so a
 * concurrent demotion or deactivation waits for the write this check guards.
 */
export async function supplierPolicyAuthority(
  db: ScopedDb,
  organizationId: string,
  userId: string,
  options: { now?: Date; lock?: boolean } = {}
): Promise<SupplierPolicyAuthority> {
  if (!organizationId || !userId) return NO_AUTHORITY;
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
      role: true,
      department: true,
      organizationRole: { select: { key: true, isSystem: true, organizationId: true } },
      permissionOverrides: {
        where: {
          capability: { in: [...SUPPLIER_POLICY_DENIALS] },
          effect: 'DENY',
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { id: true },
      },
    },
  });
  if (
    !user ||
    user.id !== userId ||
    user.organizationId !== organizationId ||
    user.status !== 'ACTIVE' ||
    user.permissionOverrides.length > 0
  ) {
    return NO_AUTHORITY;
  }
  const owner =
    user.organizationRole?.isSystem === true &&
    user.organizationRole.key === 'owner' &&
    user.organizationRole.organizationId === organizationId;
  const admin = user.role === 'ADMIN';
  if (!owner && !admin) return NO_AUTHORITY;
  const granted = await can(
    { id: user.id, role: user.role, department: user.department, status: user.status },
    SUPPLIER_POLICY_CAPABILITY,
    undefined,
    { db, now }
  );
  if (!granted) return NO_AUTHORITY;
  return { allowed: true, basis: owner ? 'OWNER' : 'ADMIN' };
}

/**
 * DEV-466: the ids, among `licenceIds`, that any filing in the organization supersedes.
 * Read across the whole register, so a filing superseded from another supplier's record
 * is still superseded (strict reading; it fails closed).
 */
export async function supersededLicenceIds(
  db: ScopedDb,
  organizationId: string,
  licenceIds: readonly string[]
): Promise<Set<string>> {
  if (licenceIds.length === 0) return new Set();
  const rows = await db.pharmacySupplierLicence.findMany({
    where: { organizationId, supersedesId: { in: [...licenceIds] } },
    select: { supersedesId: true },
  });
  return new Set(rows.map((row) => row.supersedesId).filter((id): id is string => Boolean(id)));
}

export async function strictLicenceEvidence(
  db: ScopedDb,
  organizationId: string,
  licences: readonly { id: string; expiresAt: Date; verifiedAt: Date | null }[]
): Promise<SupplierLicenceEvidence[]> {
  const superseded = await supersededLicenceIds(
    db,
    organizationId,
    licences.map((licence) => licence.id)
  );
  return licenceEvidence(licences, superseded);
}

export type SupplierComplianceSubject = {
  operation: SupplierComplianceOperation;
  purchaseOrderId?: string | null;
  goodsReceiptId?: string | null;
  reference?: string | null;
};

/** Append one immutable "supplier gate passed without a check" evidence row. */
export async function recordSupplierComplianceSkip(
  db: ScopedDb,
  scope: { organizationId: string; actorId: string },
  input: SupplierComplianceSubject & {
    supplierId: string;
    outcome: Extract<SupplierComplianceOutcome, { checked: false }>;
  }
): Promise<void> {
  if (!scope.actorId) throw new PharmacyPurchasingError('NOT_FOUND');
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "pharmacy_supplier_compliance_skips"
      ("organizationId", "operation", "supplierId", "purchaseOrderId", "goodsReceiptId",
       "reference", "policyVersion", "supplierAuthorized", "licenceStatus", "actorUserId")
    VALUES (${scope.organizationId}, ${input.operation}, ${input.supplierId},
            ${input.purchaseOrderId ?? null}, ${input.goodsReceiptId ?? null},
            ${input.reference ?? null}, ${input.outcome.policyVersion},
            ${input.outcome.supplierAuthorized}, ${input.outcome.licenceStatus},
            ${scope.actorId})`);
}

/**
 * PUR-01 at a write, policy-aware. ON: today's refusal, with supersession read strictly.
 * OFF: no refusal on supplier licence or trade authorization alone, plus one evidence
 * row naming the policy version and the facts that went unchecked. Everything else the
 * caller checks (tenancy, capability, branch, approval, PIN, stock, money) is untouched.
 */
export async function enforceSupplierCompliance(
  db: ScopedDb,
  scope: { organizationId: string; actorId: string },
  supplier: {
    id: string;
    authorized: boolean;
    licences: readonly { id: string; expiresAt: Date; verifiedAt: Date | null }[];
  },
  at: Date,
  subject: SupplierComplianceSubject,
  options: {
    policy?: SupplierCompliancePolicy;
    /**
     * `false` when the caller writes the evidence itself once the order or receipt it
     * guards exists, so the row can name it (purchase-order create).
     */
    record?: boolean;
  } = {}
): Promise<SupplierComplianceOutcome> {
  const policy =
    options.policy ??
    (await readSupplierCompliancePolicy(db, scope.organizationId, { lock: 'share' }));
  const outcome = assertSupplierEligible({
    authorized: supplier.authorized,
    licences: await strictLicenceEvidence(db, scope.organizationId, supplier.licences),
    at,
    policy,
  });
  if (!outcome.checked && options.record !== false) {
    await recordSupplierComplianceSkip(db, scope, { ...subject, supplierId: supplier.id, outcome });
  }
  return outcome;
}

export class SupplierCompliancePolicyError extends Error {
  constructor(
    readonly reason:
      | 'NOT_OWNER'
      | 'SUPPORT_SESSION'
      | 'ACKNOWLEDGEMENT_REQUIRED'
      | 'STALE_WARNING'
      | 'VERSION_CONFLICT'
  ) {
    super(reason);
  }
}

/**
 * The owner's write. Idempotent on the desired state: asking for the state already in
 * force changes nothing and audits nothing, whatever version the caller last saw. A real
 * change needs the version the caller last saw (optimistic concurrency), and turning the
 * checks off needs the current warning acknowledged. The row trigger bumps the version,
 * stamps the actor and appends the audit row in the same transaction.
 *
 * Call inside a transaction. The caller has already verified the owner.
 */
export async function writeSupplierCompliancePolicy(
  db: ScopedDb,
  scope: { organizationId: string; actorId: string },
  input: {
    checksEnabled: boolean;
    expectedVersion: number;
    acknowledgement?: { accepted: boolean; warningVersion: string };
  }
): Promise<{
  changed: boolean;
  previous: SupplierCompliancePolicyState;
  policy: SupplierCompliancePolicyState;
}> {
  const current = await readSupplierCompliancePolicy(db, scope.organizationId, {
    lock: 'update',
  });
  if (current.source === 'FAIL_CLOSED') throw new SupplierCompliancePolicyError('VERSION_CONFLICT');
  if (current.checksEnabled === input.checksEnabled) {
    return { changed: false, previous: current, policy: current };
  }
  if (current.version !== input.expectedVersion) {
    throw new SupplierCompliancePolicyError('VERSION_CONFLICT');
  }
  let acknowledgement: string | null = null;
  if (!input.checksEnabled) {
    if (!input.acknowledgement?.accepted) {
      throw new SupplierCompliancePolicyError('ACKNOWLEDGEMENT_REQUIRED');
    }
    if (input.acknowledgement.warningVersion !== SUPPLIER_COMPLIANCE_WARNING.version) {
      throw new SupplierCompliancePolicyError('STALE_WARNING');
    }
    acknowledgement = supplierComplianceAcknowledgementRecord();
  }

  const written =
    current.source === 'DEFAULT'
      ? // No row yet. A concurrent first write makes this insert a no-op, which is a conflict.
        await db.$queryRaw<PolicyRow[]>(Prisma.sql`
          INSERT INTO "pharmacy_owner_policies"
            ("organizationId", "supplierComplianceChecksEnabled",
             "supplierComplianceAcknowledgement", "updatedByUserId")
          VALUES (${scope.organizationId}, ${input.checksEnabled}, ${acknowledgement},
                  ${scope.actorId})
          ON CONFLICT ("organizationId") DO NOTHING
          RETURNING "supplierComplianceChecksEnabled" AS "checksEnabled",
                    "supplierCompliancePolicyVersion" AS "version",
                    "updatedAt", "updatedByUserId"`)
      : await db.$queryRaw<PolicyRow[]>(Prisma.sql`
          UPDATE "pharmacy_owner_policies"
             SET "supplierComplianceChecksEnabled" = ${input.checksEnabled},
                 "supplierComplianceAcknowledgement" = ${acknowledgement},
                 "updatedByUserId" = ${scope.actorId}
           WHERE "organizationId" = ${scope.organizationId}
             AND "supplierCompliancePolicyVersion" = ${input.expectedVersion}
          RETURNING "supplierComplianceChecksEnabled" AS "checksEnabled",
                    "supplierCompliancePolicyVersion" AS "version",
                    "updatedAt", "updatedByUserId"`);
  const policy = stateFromRows(written);
  if (
    written.length !== 1 ||
    policy.source !== 'STORED' ||
    policy.checksEnabled !== input.checksEnabled
  ) {
    throw new SupplierCompliancePolicyError('VERSION_CONFLICT');
  }
  return { changed: true, previous: current, policy };
}

/**
 * When and by whom the supplier setting last changed, from its own audit rows: the
 * policy row's `updatedAt`/`updatedByUserId` are shared with the prescription setting.
 */
export async function readSupplierCompliancePolicyLastChange(
  db: ScopedDb,
  organizationId: string
): Promise<{ changedAt: Date; actorUserId: string | null } | null> {
  const rows = await db.$queryRaw<{ changedAt: Date; actorUserId: string | null }[]>(Prisma.sql`
    SELECT "changedAt", "actorUserId"
      FROM "pharmacy_owner_policy_audit"
     WHERE "organizationId" = ${organizationId}
       AND "setting" = ${SUPPLIER_COMPLIANCE_SETTING}
     ORDER BY "changedAt" DESC, "id" DESC
     LIMIT 1`);
  return rows[0] ?? null;
}

export type SupplierCompliancePolicyChange = {
  id: string;
  oldValue: boolean | null;
  newValue: boolean;
  policyVersion: number | null;
  acknowledgement: string | null;
  actorUserId: string | null;
  changedAt: Date;
};

/** The supplier-policy audit trail, newest first. The prescription rows are not read. */
export async function readSupplierCompliancePolicyHistory(
  db: ScopedDb,
  organizationId: string,
  limit = 50
): Promise<SupplierCompliancePolicyChange[]> {
  const take = Math.min(Math.max(Math.trunc(limit), 1), 200);
  return db.$queryRaw<SupplierCompliancePolicyChange[]>(Prisma.sql`
    SELECT "id", "oldValue", "newValue", "policyVersion", "acknowledgement",
           "actorUserId", "changedAt"
      FROM "pharmacy_owner_policy_audit"
     WHERE "organizationId" = ${organizationId}
       AND "setting" = ${SUPPLIER_COMPLIANCE_SETTING}
     ORDER BY "changedAt" DESC, "id" DESC
     LIMIT ${take}`);
}

export type SupplierComplianceSkipRecord = {
  id: string;
  operation: SupplierComplianceOperation;
  supplierId: string;
  purchaseOrderId: string | null;
  goodsReceiptId: string | null;
  reference: string | null;
  policyVersion: number;
  supplierAuthorized: boolean;
  licenceStatus: string;
  actorUserId: string;
  recordedAt: Date;
};

/** Writes that passed the supplier gate unchecked, for one supplier or one order/receipt. */
export async function readSupplierComplianceSkips(
  db: ScopedDb,
  organizationId: string,
  filter: { supplierId?: string; purchaseOrderId?: string; goodsReceiptId?: string },
  limit = 50
): Promise<SupplierComplianceSkipRecord[]> {
  const take = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const conditions = [Prisma.sql`"organizationId" = ${organizationId}`];
  if (filter.supplierId) conditions.push(Prisma.sql`"supplierId" = ${filter.supplierId}`);
  if (filter.purchaseOrderId) {
    conditions.push(Prisma.sql`"purchaseOrderId" = ${filter.purchaseOrderId}`);
  }
  if (filter.goodsReceiptId) {
    conditions.push(Prisma.sql`"goodsReceiptId" = ${filter.goodsReceiptId}`);
  }
  return db.$queryRaw<SupplierComplianceSkipRecord[]>(Prisma.sql`
    SELECT "id", "operation", "supplierId", "purchaseOrderId", "goodsReceiptId", "reference",
           "policyVersion", "supplierAuthorized", "licenceStatus", "actorUserId", "recordedAt"
      FROM "pharmacy_supplier_compliance_skips"
     WHERE ${Prisma.join(conditions, ' AND ')}
     ORDER BY "recordedAt" DESC, "id" DESC
     LIMIT ${take}`);
}
