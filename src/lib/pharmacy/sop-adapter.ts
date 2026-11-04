import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { PharmacySopRecordType } from '@/generated/prisma/client';

/**
 * DEV-751 — the pharmacy adapter onto the shared SOP engine.
 *
 * The engine (`src/lib/restaurant/sop-*.ts`) stores every template, assignment,
 * occurrence, evidence row and verification in the `restaurant_sop_*` tables,
 * keyed to an engine branch row, staff profile and job role. This module is the
 * only place pharmacy code translates its own scope into those keys:
 *
 * - **Branch.** Scope always comes from `pharmacy_branch_assignments` (the same
 *   source every other pharmacy surface uses). A pharmacy branch is bound to one
 *   engine branch row through `pharmacy_sop_sites`, created only by an explicit
 *   manager action. The engine branch is never used to decide access.
 * - **Actor.** Always derived from the authenticated session: the user must map
 *   to exactly one ACTIVE staff profile in the organization. Zero or several
 *   profiles fail closed. A client-supplied staff id is never accepted.
 * - **Roles.** Pharmacy duties use three job roles on the shared job-role
 *   tables. Holdings are per engine branch, so a holding at one pharmacy branch
 *   never reaches another.
 *
 * Nothing here grants restaurant access: the restaurant routers stay behind the
 * `restaurant-sop` module, which pharmacy packages do not license.
 */

export type PharmacySopAccessErrorReason =
  | 'UNAUTHENTICATED'
  | 'BRANCH_OUT_OF_SCOPE'
  | 'SITE_NOT_ENABLED'
  | 'NO_STAFF_PROFILE'
  | 'AMBIGUOUS_STAFF_PROFILE'
  | 'OCCURRENCE_OUT_OF_SCOPE'
  | 'ROLE_REQUIRED'
  | 'NOT_INDEPENDENT'
  | 'RECORD_OUT_OF_SCOPE'
  | 'INVALID_INPUT';

export class PharmacySopAccessError extends Error {
  constructor(
    message: string,
    readonly reason: PharmacySopAccessErrorReason
  ) {
    super(message);
    this.name = 'PharmacySopAccessError';
  }
}

/** The three pharmacy job roles, materialised on the shared job-role tables. */
export const PHARMACY_SOP_ROLE_KEYS = [
  'pharmacy-manager',
  'pharmacy-qualified-person',
  'pharmacy-assistant',
] as const;
export type PharmacySopRoleKey = (typeof PHARMACY_SOP_ROLE_KEYS)[number];

export const PHARMACY_SOP_ROLES: Readonly<
  Record<PharmacySopRoleKey, { name: string; description: string }>
> = {
  'pharmacy-manager': {
    name: 'Pharmacy manager',
    description: 'Runs branch procedures, incidents and corrective actions.',
  },
  'pharmacy-qualified-person': {
    name: 'Qualified person (pharmacist)',
    description: 'Covers licensed duties and verifies pharmacy procedures.',
  },
  'pharmacy-assistant': {
    name: 'Pharmacy assistant',
    description: 'Completes routine storage, receiving and hygiene checks.',
  },
};

/** Roles allowed to verify a submitted pharmacy occurrence (independently). */
export const PHARMACY_SOP_VERIFIER_ROLE_KEYS: readonly PharmacySopRoleKey[] = [
  'pharmacy-qualified-person',
  'pharmacy-manager',
];

export type PharmacySopScope = { organizationId: string; userId: string };

export type PharmacySopBranchSummary = {
  pharmacyBranchId: string;
  name: string;
  /** Null until a manager enables SOPs at this branch. */
  sopBranchId: string | null;
  timezone: string | null;
};

export type PharmacySopSiteRef = {
  pharmacyBranchId: string;
  sopBranchId: string;
  timezone: string;
  businessDayCutoff: string;
};

export type PharmacySopActor = { staffProfileId: string; displayName: string; userId: string };

/** Pharmacy branches the session user is actively assigned to, with SOP status. */
export async function listPharmacySopBranches(
  db: ScopedDb,
  scope: PharmacySopScope
): Promise<PharmacySopBranchSummary[]> {
  void db;
  void scope;
  throw new Error('not implemented');
}

/**
 * Resolve the SOP site for a pharmacy branch the user is actively assigned to.
 * Throws BRANCH_OUT_OF_SCOPE (no assignment / inactive / other tenant) or
 * SITE_NOT_ENABLED.
 */
export async function resolvePharmacySopSite(
  db: ScopedDb,
  scope: PharmacySopScope & { pharmacyBranchId: string }
): Promise<PharmacySopSiteRef> {
  void db;
  void scope;
  throw new Error('not implemented');
}

/**
 * Explicitly enable SOPs at one pharmacy branch: idempotently create the engine
 * branch row and the site link (serialized per branch). Also ensures the three
 * pharmacy job roles exist. Creates no assignment, schedule or holding.
 */
export async function enablePharmacySopSite(
  db: ScopedDb,
  scope: PharmacySopScope & {
    pharmacyBranchId: string;
    timezone: string;
    businessDayCutoff?: string;
  }
): Promise<{ site: PharmacySopSiteRef; created: boolean }> {
  void db;
  void scope;
  throw new Error('not implemented');
}

/** Server-derived actor: exactly one ACTIVE staff profile for the session user. */
export async function resolvePharmacySopActor(
  db: ScopedDb,
  scope: PharmacySopScope
): Promise<PharmacySopActor> {
  void db;
  void scope;
  throw new Error('not implemented');
}

/** Idempotently ensure the three pharmacy job roles; returns key → jobRoleId. */
export async function ensurePharmacySopJobRoles(
  db: ScopedDb
): Promise<Record<PharmacySopRoleKey, string>> {
  void db;
  throw new Error('not implemented');
}

/**
 * Grant (or revoke) a pharmacy SOP role to a tenant user at one SOP site. The
 * target user must be ACTIVE and actively assigned to the pharmacy branch. If
 * the user has no staff profile one is created and linked; if they have several
 * the grant fails closed (AMBIGUOUS_STAFF_PROFILE). Idempotent.
 */
export async function setPharmacySopRoleHolding(
  db: ScopedDb,
  input: {
    organizationId: string;
    site: PharmacySopSiteRef;
    targetUserId: string;
    roleKey: PharmacySopRoleKey;
    held: boolean;
    grantedByStaffProfileId: string;
  }
): Promise<{ staffProfileId: string; changed: boolean }> {
  void db;
  void input;
  throw new Error('not implemented');
}

/** Pharmacy role keys the staff profile holds at this SOP site. */
export async function pharmacySopRolesAt(
  db: ScopedDb,
  input: { staffProfileId: string; sopBranchId: string }
): Promise<PharmacySopRoleKey[]> {
  void db;
  void input;
  throw new Error('not implemented');
}

/**
 * Load an occurrence and assert it belongs to this SOP site (and so to the
 * user's pharmacy branch). Cross-branch or unknown ids throw
 * OCCURRENCE_OUT_OF_SCOPE with no detail about the other branch.
 */
export async function assertOccurrenceAtSite(
  db: ScopedDb,
  input: { occurrenceId: string; site: PharmacySopSiteRef }
): Promise<{
  id: string;
  status: string;
  templateVersionId: string;
  assignedStaffProfileId: string | null;
  claimedByStaffProfileId: string | null;
  poolJobRoleId: string | null;
}> {
  void db;
  void input;
  throw new Error('not implemented');
}

/**
 * Independent verification: the verifier must hold a verifier role at the site
 * and must not be the assignee, claimer, any step completer or any evidence
 * uploader of the occurrence. Throws ROLE_REQUIRED / NOT_INDEPENDENT.
 */
export async function assertIndependentPharmacyVerifier(
  db: ScopedDb,
  input: { occurrenceId: string; site: PharmacySopSiteRef; verifierStaffProfileId: string }
): Promise<void> {
  void db;
  void input;
  throw new Error('not implemented');
}

/**
 * Append-only link from an occurrence (optionally a step) to an EXISTING
 * pharmacy record at the same branch. Validates the record exists in the
 * tenant and, where the record carries a branch, at this branch. Never creates,
 * posts or edits the record. Idempotent on (occurrence, type, record).
 */
export async function linkPharmacySopRecord(
  db: ScopedDb,
  input: {
    site: PharmacySopSiteRef;
    occurrenceId: string;
    occurrenceStepId?: string | null;
    recordType: PharmacySopRecordType;
    recordId: string;
    note?: string | null;
    actor: PharmacySopActor;
  }
): Promise<{ linkId: string; created: boolean; outOfRange?: boolean }> {
  void db;
  void input;
  throw new Error('not implemented');
}
