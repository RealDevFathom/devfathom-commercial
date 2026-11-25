/**
 * DEV-908 — the rules for a recorded stock transfer between two branches of the
 * same owner. The owner's answer: an optional, owner-enabled feature that moves
 * stock only between licensed premises of the same owner, never a controlled
 * drug, never another owner's stock, and never as a pay-here/collect-there sale.
 *
 * Every check here runs on the server, inside the transaction that allocates or
 * dispatches the transfer. The page only reflects the switch; it decides nothing.
 */
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { regulatoryProfileBindingDenial } from './regulatory';
import { regulatoryProfileInForceWhere, regulatoryStartInstant } from './regulatory-start';

export type BranchTransferRefusal =
  /** The owner has not switched recorded branch transfers on. */
  | 'BRANCH_TRANSFERS_DISABLED'
  /** A line carries a controlled drug; those never move between premises here. */
  | 'CONTROLLED_DRUG_TRANSFER'
  /** A branch is not an active branch of this owner (organization). */
  | 'BRANCH_NOT_SAME_OWNER'
  /** A branch has no real, in-force premises licence. */
  | 'PREMISES_NOT_LICENSED';

export class BranchTransferPolicyError extends Error {
  constructor(readonly reason: BranchTransferRefusal) {
    super(reason);
    this.name = 'BranchTransferPolicyError';
  }
}

/** The owner switch. Off by default; only the owner turns it on. */
export async function branchTransfersEnabled(
  db: ScopedDb,
  organizationId: string
): Promise<boolean> {
  const organization = await db.organization.findFirst({
    where: { id: organizationId },
    select: { pharmacyBranchTransfersEnabled: true },
  });
  return organization?.pharmacyBranchTransfersEnabled === true;
}

type Premises = { branchId: string; licenceNumber: string };

/**
 * The licence a branch trades under at `at`: the in-force regulatory profile,
 * bound to this active branch's own address, not a placeholder, with a licence
 * number, evidence and a validity window that covers `at`.
 */
export async function licensedPremises(
  db: ScopedDb,
  organizationId: string,
  branchId: string,
  at: Date,
  timeZone: string | null
): Promise<Premises> {
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: branchId, organizationId },
    select: { id: true, active: true, provinceCode: true, addressLine: true, city: true },
  });
  if (!branch || !branch.active) throw new BranchTransferPolicyError('BRANCH_NOT_SAME_OWNER');
  const profile = await db.branchRegulatoryProfile.findFirst({
    where: { organizationId, branchId, ...regulatoryProfileInForceWhere(at, timeZone) },
    orderBy: { effectiveFrom: 'desc' },
    select: {
      provinceCode: true,
      premises: true,
      isPlaceholder: true,
      licenceNumber: true,
      licenceEvidenceFileRef: true,
      licenceValidFrom: true,
      licenceValidTo: true,
    },
  });
  const startedAt = regulatoryStartInstant(at, timeZone);
  if (
    !profile ||
    profile.isPlaceholder ||
    regulatoryProfileBindingDenial(profile, branch) !== null ||
    !profile.licenceNumber.trim() ||
    !profile.licenceEvidenceFileRef.trim() ||
    startedAt < profile.licenceValidFrom ||
    at >= profile.licenceValidTo
  )
    throw new BranchTransferPolicyError('PREMISES_NOT_LICENSED');
  return { branchId, licenceNumber: profile.licenceNumber.trim() };
}

/**
 * Refuses a transfer the owner's rules do not allow, and returns the two
 * premises licences it moves between so the transfer can record them.
 *
 * `requireSwitch` is true where a person starts a transfer from the transfers
 * console. Dispatch re-checks drugs and licences for every transfer, whatever
 * started it, because dispatch is when stock actually leaves the premises.
 */
export async function assertBranchTransferAllowed(
  db: ScopedDb,
  input: {
    organizationId: string;
    fromBranchId: string;
    toBranchId: string;
    sourceLotIds: readonly string[];
    requireSwitch: boolean;
    at?: Date;
  }
): Promise<{ from: Premises; to: Premises }> {
  const at = input.at ?? new Date();
  const organization = await db.organization.findFirst({
    where: { id: input.organizationId },
    select: { pharmacyBranchTransfersEnabled: true, timezone: true },
  });
  if (!organization) throw new BranchTransferPolicyError('BRANCH_NOT_SAME_OWNER');
  if (input.requireSwitch && organization.pharmacyBranchTransfersEnabled !== true)
    throw new BranchTransferPolicyError('BRANCH_TRANSFERS_DISABLED');
  if (input.fromBranchId === input.toBranchId)
    throw new BranchTransferPolicyError('BRANCH_NOT_SAME_OWNER');

  const lotIds = [...new Set(input.sourceLotIds)];
  const lots = await db.pharmacyInventoryLot.findMany({
    where: { id: { in: lotIds }, organizationId: input.organizationId },
    select: {
      id: true,
      branchId: true,
      batch: { select: { medicine: { select: { controlled: true } } } },
    },
  });
  // Only this owner's stock at the sending branch; anything unaccounted for is refused.
  if (lots.length !== lotIds.length || lots.some((lot) => lot.branchId !== input.fromBranchId))
    throw new BranchTransferPolicyError('BRANCH_NOT_SAME_OWNER');
  if (lots.some((lot) => lot.batch.medicine.controlled !== false))
    throw new BranchTransferPolicyError('CONTROLLED_DRUG_TRANSFER');

  const timeZone = organization.timezone ?? null;
  const from = await licensedPremises(db, input.organizationId, input.fromBranchId, at, timeZone);
  const to = await licensedPremises(db, input.organizationId, input.toBranchId, at, timeZone);
  return { from, to };
}
