/**
 * PLAT-03 — the twelve-step pharmacy onboarding readiness gates of PRD §6.1.
 *
 * The design rule this module exists to enforce is the acceptance criterion:
 * *seed data cannot fake readiness*. A `pharmacy_onboarding_gate_states` row is
 * therefore a **claim** an operator recorded, never the verdict. Readiness is
 * recomputed on every read by {@link evaluatePharmacyReadiness}, which:
 *
 * - answers each *evidence-backed* gate from the underlying data alone, so a
 *   stored PASSED with nothing behind it is downgraded to FAILED; and
 * - accepts an *attested* gate's PASSED claim only when it carries both an
 *   evidence reference and the actor who recorded it, so a bulk seed writing
 *   bare statuses cannot move one.
 *
 * Six gates have real data to derive from today. The other six are console
 * steps whose backing surfaces do not exist yet; they stay explicitly
 * NOT_STARTED rather than being quietly assumed complete, which is what keeps
 * `assertActivationReady` fail-closed for pharmacy organizations.
 */
import type { PrismaClient } from '@/generated/prisma/client';
import {
  isPackageCompatibleWithVertical,
  PHARMACY_OPT_IN_ROLE_KEYS,
  roleTemplatesForVertical,
} from '@/lib/vertical-catalog';

import { assertStoredBranchMayOperate, BranchOperationDeniedError } from './regulatory';
import { regulatoryStartInstant } from './regulatory-start';
import { readSupplierCompliancePolicy } from './supplier-compliance-policy';

export type PharmacyOnboardingGate =
  | 'ORG_TYPE'
  | 'LEGAL_BUSINESS'
  | 'LAUNCH_JURISDICTION'
  | 'PREMISES_AND_LICENCES'
  | 'BRANCHES_AND_LOCATIONS'
  | 'COMMERCIAL_PACKAGE'
  | 'OWNER_AND_ROLE_TEMPLATES'
  | 'MEDICINE_CATALOG_READINESS'
  | 'OPENING_STOCK_READINESS'
  | 'PARTIES_AND_BALANCES'
  | 'DEVICES_AND_DOCUMENTS'
  | 'READINESS_AND_PARALLEL_RUN';

export type PharmacyOnboardingGateStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'PASSED' | 'FAILED';

export type PharmacyOnboardingStep = {
  gate: PharmacyOnboardingGate;
  /** 1-based position in the PRD §6.1 walk. */
  step: number;
  label: string;
  /** P0 gates block activation; every §6.1 step is P0 in the PRD. */
  p0: boolean;
  /**
   * True when the platform can answer this gate from data. Evidence-backed
   * gates ignore the stored claim entirely; attested gates are the console
   * steps that have no backing surface yet.
   */
  evidenceBacked: boolean;
};

/** The twelve steps of PRD §6.1 PLAT-03, in the order the operator walks them. */
export const PHARMACY_ONBOARDING_STEPS: readonly PharmacyOnboardingStep[] = [
  { gate: 'ORG_TYPE', step: 1, label: 'Organization type', p0: true, evidenceBacked: false },
  { gate: 'LEGAL_BUSINESS', step: 2, label: 'Legal business', p0: true, evidenceBacked: false },
  {
    gate: 'LAUNCH_JURISDICTION',
    step: 3,
    label: 'Launch jurisdiction',
    p0: true,
    evidenceBacked: false,
  },
  {
    gate: 'PREMISES_AND_LICENCES',
    step: 4,
    label: 'Premises and licences',
    p0: true,
    evidenceBacked: true,
  },
  {
    gate: 'BRANCHES_AND_LOCATIONS',
    step: 5,
    label: 'Branches and locations',
    p0: true,
    evidenceBacked: false,
  },
  {
    gate: 'COMMERCIAL_PACKAGE',
    step: 6,
    label: 'Commercial package',
    p0: true,
    evidenceBacked: true,
  },
  {
    gate: 'OWNER_AND_ROLE_TEMPLATES',
    step: 7,
    label: 'Owner and role templates',
    p0: true,
    evidenceBacked: true,
  },
  {
    gate: 'MEDICINE_CATALOG_READINESS',
    step: 8,
    label: 'Medicine catalog readiness',
    p0: true,
    evidenceBacked: true,
  },
  {
    gate: 'OPENING_STOCK_READINESS',
    step: 9,
    label: 'Opening stock readiness',
    p0: true,
    evidenceBacked: true,
  },
  {
    gate: 'PARTIES_AND_BALANCES',
    step: 10,
    label: 'Parties and balances',
    p0: true,
    evidenceBacked: true,
  },
  {
    gate: 'DEVICES_AND_DOCUMENTS',
    step: 11,
    label: 'Devices and documents',
    p0: true,
    evidenceBacked: false,
  },
  {
    gate: 'READINESS_AND_PARALLEL_RUN',
    step: 12,
    label: 'Readiness and parallel run',
    p0: true,
    evidenceBacked: false,
  },
];

const STEP_BY_GATE = new Map(PHARMACY_ONBOARDING_STEPS.map((step) => [step.gate, step]));

export function pharmacyOnboardingStep(gate: PharmacyOnboardingGate): PharmacyOnboardingStep {
  const step = STEP_BY_GATE.get(gate);
  if (!step) throw new Error(`Unknown pharmacy onboarding gate: ${gate}`);
  return step;
}

/** The stored claim for one gate, as recorded by an operator. */
export type PharmacyGateClaim = {
  gate: PharmacyOnboardingGate;
  status: PharmacyOnboardingGateStatus;
  evidenceRef?: string | null;
  actorId?: string | null;
  recordedAt?: Date | null;
};

export type PharmacyGateResult = PharmacyOnboardingStep & {
  status: PharmacyOnboardingGateStatus;
  /** The status the operator claimed, kept so a downgrade is visible and not silent. */
  claimedStatus: PharmacyOnboardingGateStatus;
  evidenceRef: string | null;
  actorId: string | null;
  recordedAt: Date | null;
  /** Why the evaluated status differs from the claim, when it does. */
  downgradeReason: 'EVIDENCE_ABSENT' | 'ATTESTATION_INCOMPLETE' | null;
};

export type PharmacyReadiness = {
  organizationId: string;
  gates: readonly PharmacyGateResult[];
  /** Every P0 gate evaluated to PASSED. */
  ready: boolean;
  /** P0 gates that are not PASSED, in walk order. */
  blocking: readonly PharmacyOnboardingGate[];
  /** DEV-753: false only when supplier checks are turned off. Absent reads as on. */
  supplierChecksEnabled?: boolean;
};

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Resolve one gate from its claim and, for an evidence-backed gate, the answer
 * the evidence query gave.
 *
 * Kept pure and exported so the downgrade rules are testable without a database
 * and so a caller cannot reach readiness by any other route.
 */
export function evaluateGate(
  step: PharmacyOnboardingStep,
  claim: PharmacyGateClaim | undefined,
  evidenceSatisfied: boolean | null
): PharmacyGateResult {
  const claimedStatus = claim?.status ?? 'NOT_STARTED';
  const base = {
    ...step,
    claimedStatus,
    evidenceRef: claim?.evidenceRef ?? null,
    actorId: claim?.actorId ?? null,
    recordedAt: claim?.recordedAt ?? null,
  };

  if (step.evidenceBacked) {
    // The data is the answer. A PASSED claim the query contradicts is not
    // ignored, it is recorded as FAILED: somebody asserted something untrue.
    if (evidenceSatisfied) return { ...base, status: 'PASSED', downgradeReason: null };
    return claimedStatus === 'PASSED'
      ? { ...base, status: 'FAILED', downgradeReason: 'EVIDENCE_ABSENT' }
      : { ...base, status: claimedStatus, downgradeReason: null };
  }

  // An attested gate has no backing surface yet, so the claim stands — but only
  // if it was actually attested. A seeded status with no evidence reference and
  // no actor never counts as PASSED.
  if (claimedStatus === 'PASSED' && !(nonEmpty(base.evidenceRef) && nonEmpty(base.actorId))) {
    return { ...base, status: 'NOT_STARTED', downgradeReason: 'ATTESTATION_INCOMPLETE' };
  }
  return { ...base, status: claimedStatus, downgradeReason: null };
}

/** The evidence answers for the six gates the platform can derive today. */
export type PharmacyReadinessEvidence = Partial<
  Record<PharmacyOnboardingGate, boolean | null | undefined>
>;

export function evaluateReadiness(
  organizationId: string,
  claims: readonly PharmacyGateClaim[],
  evidence: PharmacyReadinessEvidence
): PharmacyReadiness {
  const claimByGate = new Map(claims.map((claim) => [claim.gate, claim]));
  const gates = PHARMACY_ONBOARDING_STEPS.map((step) =>
    evaluateGate(step, claimByGate.get(step.gate), evidence[step.gate] ?? false)
  );
  const blocking = gates
    .filter((gate) => gate.p0 && gate.status !== 'PASSED')
    .map((gate) => gate.gate);
  return { organizationId, gates, ready: blocking.length === 0, blocking };
}

/**
 * Run the evidence queries for one organization and evaluate all twelve gates.
 *
 * Every query below is scoped by `organizationId`; the tenant boundary is still
 * forced row-level security, and this function never widens it.
 */
export async function evaluatePharmacyReadiness(
  db: PrismaClient,
  organizationId: string,
  at: Date = new Date()
): Promise<PharmacyReadiness> {
  // Owner / Operator and Pharmacist and cashier are opt-in, never activation prerequisites.
  const requiredRoleKeys = roleTemplatesForVertical('PHARMACY')
    .filter((template) => !PHARMACY_OPT_IN_ROLE_KEYS.has(template.key))
    .map((template) => template.key);
  // DEV-753: the owner's supplier checks. Never rejects; a missing or unreadable row is on.
  const supplierPolicy = readSupplierCompliancePolicy(db, organizationId);

  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { packageId: true, package: { select: { vertical: true } }, timezone: true },
  });
  // DEV-298: a profile dated today is in force from the workspace's local midnight.
  const timeZone = organization?.timezone;
  const startedAt = regulatoryStartInstant(at, timeZone);

  const [claims, branch, seededRoleKeys, catalogReady, receivedLotCount, supplierCount] =
    await Promise.all([
      db.pharmacyOnboardingGateState.findMany({
        where: { organizationId },
        select: { gate: true, status: true, evidenceRef: true, actorId: true, recordedAt: true },
      }),
      // The licences gate is answered per branch; the organization is ready when
      // at least one branch has an effective profile that PLAT-02 allows to
      // operate. Pick the branch that owns the most recent effective profile.
      db.branchRegulatoryProfile.findFirst({
        where: {
          organizationId,
          branch: { active: true },
          effectiveFrom: { lte: startedAt },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: startedAt } }],
        },
        select: { branchId: true },
        orderBy: { effectiveFrom: 'desc' },
      }),
      // "Roles seeded" means the vertical's own role templates are present, not
      // merely that the organization has some roles from another vertical.
      db.organizationRole.count({
        where: { organizationId, key: { in: requiredRoleKeys } },
      }),
      medicineCatalogReady(db, organizationId, at),
      // INV-01 receipt: a lot exists but is only opening stock once received.
      db.pharmacyInventoryLot.count({ where: { organizationId, receivedAt: { not: null } } }),
      // With supplier checks off, an active supplier counts whether or not it is authorized.
      supplierPolicy.then(({ checksEnabled }) =>
        db.pharmacySupplier.count({
          where: checksEnabled
            ? { organizationId, authorized: true, active: true }
            : { organizationId, active: true },
        })
      ),
    ]);

  const evidence: PharmacyReadinessEvidence = {
    PREMISES_AND_LICENCES: branch
      ? await branchMayOperate(db, organizationId, branch.branchId, at, timeZone)
      : false,
    COMMERCIAL_PACKAGE: Boolean(
      organization?.packageId &&
      isPackageCompatibleWithVertical(organization.package?.vertical ?? 'AGENCY', 'PHARMACY')
    ),
    OWNER_AND_ROLE_TEMPLATES:
      requiredRoleKeys.length > 0 && seededRoleKeys >= requiredRoleKeys.length,
    MEDICINE_CATALOG_READINESS: catalogReady,
    OPENING_STOCK_READINESS: receivedLotCount > 0,
    PARTIES_AND_BALANCES: supplierCount > 0,
  };

  return {
    ...evaluateReadiness(organizationId, claims as PharmacyGateClaim[], evidence),
    supplierChecksEnabled: (await supplierPolicy).checksEnabled,
  };
}

async function medicineCatalogReady(
  db: PrismaClient,
  organizationId: string,
  at: Date
): Promise<boolean> {
  // MED-05: without a reviewed, published, saleable medicine, pack evidence
  // cannot satisfy this gate and does not need to be queried.
  const publishedEntryCount = await db.medicinePublicationEntry.count({
    where: {
      organizationId,
      batch: { status: 'PUBLISHED' },
      assertion: {
        status: { in: ['ACCEPTED', 'CORRECTED'] },
        reviewer: { not: null },
        medicine: { saleable: true },
      },
    },
  });
  if (publishedEntryCount === 0) return false;

  // DEV-18: opening stock is scanned, so publication alone is insufficient;
  // an effective pack of a saleable medicine must also carry a barcode.
  const barcodedPackCount = await db.packLevel.count({
    where: {
      organizationId,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      barcodes: { some: { organizationId } },
      presentation: { medicine: { saleable: true } },
    },
  });
  return barcodedPackCount > 0;
}

/**
 * The licences gate reuses PLAT-02's fail-closed primitive rather than
 * reimplementing the licence and qualified-person rules, which would be free to
 * drift from the guard that actually blocks dispensing.
 *
 * That primitive audits every denial, so a readiness evaluation on a branch that
 * may not operate writes an audit row. That is deliberate — the alternative is a
 * second, divergent copy of the rules — but it does mean a caller that polls
 * readiness will produce audit volume; the recorded action is
 * `ONBOARDING_READINESS`, so those entries stay distinguishable from a real
 * refused operation.
 */
async function branchMayOperate(
  db: PrismaClient,
  organizationId: string,
  branchId: string,
  at: Date,
  timeZone: string | null | undefined
): Promise<boolean> {
  try {
    await assertStoredBranchMayOperate(db, organizationId, branchId, {
      name: 'ONBOARDING_READINESS',
      at,
      timeZone,
      requiresQualifiedPerson: true,
    });
    return true;
  } catch (error) {
    if (error instanceof BranchOperationDeniedError) return false;
    throw error;
  }
}
