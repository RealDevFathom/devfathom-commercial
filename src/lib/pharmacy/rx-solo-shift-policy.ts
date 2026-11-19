import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { RX_SOLO_SHIFT_DISCLAIMER, rxSoloShiftDisclaimerRecord } from './rx-solo-shift';

/**
 * DEV-960 — the owner setting "One pharmacist per shift", per branch, server side.
 *
 * Storage is the append-only `pharmacy_rx_solo_shift_policy_changes` (migration 20261118125100,
 * FORCE RLS): one row per change, the newest row of a branch is the setting in force, and no row
 * means OFF. The database numbers the versions, refuses any writer who is not the live owner and
 * requires the accepted statement on every row that turns it on. `readRxSoloShiftPolicy` is the
 * ONE reader the prescription self-sign rule asks.
 *
 * Fail closed: OFF is the strict state (the staff-list solo rule), so a missing row is OFF and a
 * malformed or unreadable row is OFF too. Only a stored, well-formed ON row turns it on.
 */

export type RxSoloShiftPolicyState = {
  enabled: boolean;
  version: number;
  source: 'DEFAULT' | 'STORED' | 'FAIL_CLOSED';
};

const DEFAULT_STATE: RxSoloShiftPolicyState = Object.freeze({
  enabled: false,
  version: 0,
  source: 'DEFAULT',
});

const FAIL_CLOSED_STATE: RxSoloShiftPolicyState = Object.freeze({
  enabled: false,
  version: 0,
  source: 'FAIL_CLOSED',
});

type PolicyRow = { enabled: unknown; version: unknown };

function stateFromRow(row: PolicyRow | null | undefined): RxSoloShiftPolicyState {
  if (row === undefined || row === null) return DEFAULT_STATE;
  if (
    typeof row.enabled !== 'boolean' ||
    typeof row.version !== 'number' ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1
  )
    return FAIL_CLOSED_STATE;
  return { enabled: row.enabled, version: row.version, source: 'STORED' };
}

function stateFromRows(rows: unknown): RxSoloShiftPolicyState {
  if (!Array.isArray(rows) || rows.length > 1) return FAIL_CLOSED_STATE;
  return stateFromRow(rows[0] as PolicyRow | undefined);
}

/**
 * The branch's setting lock. `share` is taken by a declared sign-off while it reads the setting,
 * `exclusive` by the owner's change (the database trigger takes it too), both until the end of
 * the transaction: a sign-off never commits on a setting the owner has already turned off.
 */
async function lockBranchSetting(
  db: ScopedDb,
  organizationId: string,
  branchId: string,
  mode: 'share' | 'exclusive'
) {
  if (mode === 'share')
    await db.$queryRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock_shared(pharmacy_rx_solo_shift_lock_key(${organizationId}, ${branchId}))::text AS "locked"`
    );
  else
    await db.$queryRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(pharmacy_rx_solo_shift_lock_key(${organizationId}, ${branchId}))::text AS "locked"`
    );
}

/**
 * The branch's "One pharmacist per shift" setting. Any failure reads as OFF. Inside a transaction
 * a failed read has also aborted the transaction, so the signature it guards cannot commit.
 */
export async function readRxSoloShiftPolicy(
  db: ScopedDb,
  organizationId: string | null | undefined,
  branchId: string | null | undefined,
  options: { lock?: 'share' | 'exclusive' } = {}
): Promise<RxSoloShiftPolicyState> {
  if (!organizationId || !branchId) return FAIL_CLOSED_STATE;
  try {
    if (options.lock) await lockBranchSetting(db, organizationId, branchId, options.lock);
    const rows = await db.$queryRaw<PolicyRow[]>(Prisma.sql`
      SELECT "enabled", "version"
        FROM "pharmacy_rx_solo_shift_policy_changes"
       WHERE "organizationId" = ${organizationId}
         AND "branchId" = ${branchId}
       ORDER BY "version" DESC
       LIMIT 1`);
    return stateFromRows(rows);
  } catch {
    return FAIL_CLOSED_STATE;
  }
}

/** Every branch's setting in one read, keyed by branch. A branch with no row is OFF. */
export async function readRxSoloShiftPolicies(
  db: ScopedDb,
  organizationId: string
): Promise<Map<string, RxSoloShiftPolicyState & { changedAt: Date; actorUserId: string }>> {
  const rows = await db.$queryRaw<
    Array<PolicyRow & { branchId: string; changedAt: Date; actorUserId: string }>
  >(Prisma.sql`
    SELECT DISTINCT ON ("branchId") "branchId", "enabled", "version", "changedAt", "actorUserId"
      FROM "pharmacy_rx_solo_shift_policy_changes"
     WHERE "organizationId" = ${organizationId}
     ORDER BY "branchId", "version" DESC`);
  return new Map(
    rows.map((row) => [
      row.branchId,
      { ...stateFromRow(row), changedAt: row.changedAt, actorUserId: row.actorUserId },
    ])
  );
}

export type RxSoloShiftPolicyRefusal =
  | 'NOT_OWNER'
  | 'SUPPORT_SESSION'
  | 'BRANCH_NOT_FOUND'
  | 'PIN_REQUIRED'
  | 'PIN_REJECTED'
  | 'PIN_LOCKED'
  | 'NO_PIN'
  | 'DISCLAIMER_REQUIRED'
  | 'STALE_DISCLAIMER'
  | 'VERSION_CONFLICT';

export class RxSoloShiftPolicyError extends Error {
  constructor(readonly reason: RxSoloShiftPolicyRefusal) {
    super(reason);
    this.name = 'RxSoloShiftPolicyError';
  }
}

/**
 * The owner's write for one branch. Idempotent on the desired state: asking for the state
 * already in force changes nothing and records nothing. A real change needs the version the
 * caller last saw, and turning the setting on needs the current statement accepted; the accepted
 * text is stored with the change. The database trigger numbers the version, stamps the actor and
 * time, and refuses anyone but the live owner.
 *
 * Call inside a transaction. The caller has already verified the owner and their fresh PIN.
 */
export async function writeRxSoloShiftPolicy(
  db: ScopedDb,
  scope: { organizationId: string; actorId: string },
  input: {
    branchId: string;
    enabled: boolean;
    expectedVersion: number;
    disclaimer?: { accepted: boolean; version: string };
  }
): Promise<{
  changed: boolean;
  previous: RxSoloShiftPolicyState;
  policy: RxSoloShiftPolicyState;
  acceptedDisclaimer: string | null;
}> {
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: input.branchId, organizationId: scope.organizationId },
    select: { id: true },
  });
  if (!branch) throw new RxSoloShiftPolicyError('BRANCH_NOT_FOUND');
  const current = await readRxSoloShiftPolicy(db, scope.organizationId, input.branchId, {
    lock: 'exclusive',
  });
  if (current.source === 'FAIL_CLOSED') throw new RxSoloShiftPolicyError('VERSION_CONFLICT');
  if (current.enabled === input.enabled)
    return { changed: false, previous: current, policy: current, acceptedDisclaimer: null };
  if (current.version !== input.expectedVersion)
    throw new RxSoloShiftPolicyError('VERSION_CONFLICT');
  let acceptedDisclaimer: string | null = null;
  if (input.enabled) {
    if (!input.disclaimer?.accepted) throw new RxSoloShiftPolicyError('DISCLAIMER_REQUIRED');
    if (input.disclaimer.version !== RX_SOLO_SHIFT_DISCLAIMER.version)
      throw new RxSoloShiftPolicyError('STALE_DISCLAIMER');
    acceptedDisclaimer = rxSoloShiftDisclaimerRecord();
  }
  const written = await db.$queryRaw<PolicyRow[]>(Prisma.sql`
    INSERT INTO "pharmacy_rx_solo_shift_policy_changes"
      ("organizationId", "branchId", "enabled", "disclaimerVersion", "acknowledgement",
       "actorUserId")
    VALUES (${scope.organizationId}, ${input.branchId}, ${input.enabled},
            ${input.enabled ? RX_SOLO_SHIFT_DISCLAIMER.version : null}, ${acceptedDisclaimer},
            ${scope.actorId})
    RETURNING "enabled", "version"`);
  const policy = stateFromRows(written);
  if (
    policy.source !== 'STORED' ||
    policy.enabled !== input.enabled ||
    policy.version !== current.version + 1
  )
    throw new RxSoloShiftPolicyError('VERSION_CONFLICT');
  return { changed: true, previous: current, policy, acceptedDisclaimer };
}

export type RxSoloShiftPolicyChange = {
  id: string;
  branchId: string;
  enabled: boolean;
  version: number;
  disclaimerVersion: string | null;
  acknowledgement: string | null;
  actorUserId: string;
  changedAt: Date;
};

/** The setting's audit trail, newest first: who, when, which branch, and the statement accepted. */
export async function readRxSoloShiftPolicyHistory(
  db: ScopedDb,
  organizationId: string,
  options: { branchId?: string; limit?: number } = {}
): Promise<RxSoloShiftPolicyChange[]> {
  const take = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 200);
  const branch = options.branchId ? Prisma.sql`AND "branchId" = ${options.branchId}` : Prisma.empty;
  return db.$queryRaw<RxSoloShiftPolicyChange[]>(Prisma.sql`
    SELECT "id", "branchId", "enabled", "version", "disclaimerVersion", "acknowledgement",
           "actorUserId", "changedAt"
      FROM "pharmacy_rx_solo_shift_policy_changes"
     WHERE "organizationId" = ${organizationId}
       ${branch}
     ORDER BY "changedAt" DESC, "version" DESC
     LIMIT ${take}`);
}
