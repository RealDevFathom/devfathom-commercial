/**
 * PLAT-02 / PLAT-03 tenant surfaces — the twelve-step onboarding checklist, the
 * branch regulatory profile, and the activation status the operator reads when
 * activation is refused.
 *
 * Two rules shape this router:
 *
 * - **Readiness is never read off the stored rows.** Every response recomputes
 *   it with `evaluatePharmacyReadiness`, the same function
 *   `assertActivationReady` calls, so this surface can never tell an operator
 *   they are ready and then watch activation refuse them (or the reverse).
 * - **A rejection lands on a field.** Business rules are thrown as a
 *   `BAD_REQUEST` carrying a `ZodError`, which the tRPC error formatter
 *   publishes as `data.validation[field]` — the same channel a shape failure
 *   uses, so the form marks the input either way (UX rule 11).
 *
 * Every query carries an explicit `organizationId` predicate. Forced row-level
 * security is the second wall and never the only one (UX rule 16).
 */
import { randomUUID } from 'node:crypto';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  PHARMACY_ONBOARDING_STEPS,
  evaluatePharmacyReadiness,
  pharmacyOnboardingStep,
  type PharmacyOnboardingGate,
  type PharmacyReadiness,
} from '@/lib/pharmacy/onboarding';
import {
  pharmacyActivationSummary,
  pharmacyOnboardingChecklist,
} from '@/lib/pharmacy/onboarding-checklist';
import {
  fieldError,
  provinceName,
  regulatoryProfileInput,
  ruleSetOptions,
  type RegulatoryProfileInput,
} from '@/lib/pharmacy/regulatory-profile-form';
import { assertBranchMayOperate, BranchOperationDeniedError } from '@/lib/pharmacy/regulatory';
import { adminProcedure, router, type TRPCContext } from '../trpc';

/** The gates an operator may attest to; the rest are answered from data. */
const ATTESTABLE_GATES = PHARMACY_ONBOARDING_STEPS.filter((step) => !step.evidenceBacked).map(
  (step) => step.gate
);

const gateInput = z.enum(
  PHARMACY_ONBOARDING_STEPS.map((step) => step.gate) as [
    PharmacyOnboardingGate,
    ...PharmacyOnboardingGate[],
  ]
);

function badRequest(field: string, message: string): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message, cause: fieldError(field, message) });
}

function midnightUtc(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

/**
 * `evaluatePharmacyReadiness` answers the commercial-package gate by reading the
 * assigned package's own vertical. `platform_packages` is FORCE row-level
 * security and carries no tenant policy, so under a *tenant* connection that
 * read returns nothing and the gate is reported outstanding — while
 * `assertActivationReady`, which runs on the platform connection, sees it
 * satisfied and activates. The tenant surface would then be telling the operator
 * to fix something that is not broken, and naming a step activation does not
 * hold against them.
 *
 * The two facts a tenant CAN see are sufficient to settle it: the organization's
 * own vertical, and that a package is assigned. A package of another vertical
 * can never be assigned to this organization — `assertPackageCompatibleWithVertical`
 * refuses that pairing at creation and at every package change — so a pharmacy
 * organization with a package has a pharmacy package.
 *
 * This only ever moves the tenant surface *towards* the platform's own verdict;
 * it can never report ready where activation would refuse, because activation
 * re-evaluates on the connection that can see the package.
 */
function reconcilePackageGate(
  readiness: PharmacyReadiness,
  organization: { vertical: string | null; packageId: string | null } | null
): PharmacyReadiness {
  const packageAssigned = Boolean(organization?.packageId) && organization?.vertical === 'PHARMACY';
  const gate = readiness.gates.find((candidate) => candidate.gate === 'COMMERCIAL_PACKAGE');
  if (!packageAssigned || !gate || gate.status === 'PASSED') return readiness;

  const gates = readiness.gates.map((candidate) =>
    candidate.gate === 'COMMERCIAL_PACKAGE'
      ? { ...candidate, status: 'PASSED' as const, downgradeReason: null }
      : candidate
  );
  const blocking = gates
    .filter((candidate) => candidate.p0 && candidate.status !== 'PASSED')
    .map((candidate) => candidate.gate);
  return { ...readiness, gates, blocking, ready: blocking.length === 0 };
}

/** The checklist, activation summary and organization state, in one read. */
async function readOverview(ctx: TRPCContext) {
  const organizationId = ctx.entitlements.organizationId;
  const now = new Date();
  const [organization, evaluated, currentProfile] = await Promise.all([
    ctx.db.organization.findFirst({
      where: { id: organizationId },
      select: { displayName: true, status: true, vertical: true, packageId: true },
    }),
    evaluatePharmacyReadiness(ctx.db, organizationId, now),
    ctx.db.branchRegulatoryProfile.findFirst({
      where: {
        organizationId,
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      select: { licenceValidTo: true },
      orderBy: { effectiveFrom: 'desc' },
    }),
  ]);
  const readiness = reconcilePackageGate(evaluated, organization);
  const checklist = pharmacyOnboardingChecklist(readiness, {
    at: now,
    licenceValidTo: currentProfile?.licenceValidTo,
  });
  return {
    organization: {
      displayName: organization?.displayName ?? 'This workspace',
      status: organization?.status ?? 'ONBOARDING',
      vertical: organization?.vertical ?? 'PHARMACY',
    },
    items: checklist.items,
    doneCount: checklist.doneCount,
    totalCount: checklist.totalCount,
    blocking: checklist.blocking,
    ready: checklist.ready,
    activationSummary: pharmacyActivationSummary(checklist),
  };
}

/** Published jurisdiction rules in force on a date, newest first per province. */
async function jurisdictionsInForce(ctx: TRPCContext, at: Date) {
  const ruleSets = await ctx.db.jurisdictionRuleSet.findMany({
    where: {
      isPlaceholder: false,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: [{ code: 'asc' }, { effectiveFrom: 'desc' }],
  });
  // One rule set per province — the first, because the ordering puts the most
  // recently effective version of each code first.
  const byCode = new Map<string, (typeof ruleSets)[number]>();
  for (const ruleSet of ruleSets) if (!byCode.has(ruleSet.code)) byCode.set(ruleSet.code, ruleSet);
  return [...byCode.values()].map((ruleSet) => {
    const categories = ruleSetOptions(ruleSet.licenceCategories);
    const schedules = ruleSetOptions(ruleSet.permittedSchedules);
    return {
      id: ruleSet.id,
      provinceCode: ruleSet.code,
      provinceName: provinceName(ruleSet.code),
      version: ruleSet.version,
      effectiveFrom: ruleSet.effectiveFrom,
      licenceCategories: categories.values,
      permittedSchedules: schedules.values,
      // Provisional anywhere is provisional everywhere: the regulatory guard
      // refuses the branch if *any* of the three fields it reads is unconfirmed,
      // so the surface must report the same thing rather than a rosier subset.
      provisional:
        categories.provisional ||
        schedules.provisional ||
        ruleSetOptions(ruleSet.pharmacistCoverageRule).provisional,
    };
  });
}

export const pharmacyOnboardingRouter = router({
  /** The workspace-home checklist and the activation status beside it. */
  overview: adminProcedure.query(({ ctx }) => readOverview(ctx)),

  /**
   * Record an operator's attestation for one of the gates the platform cannot
   * derive from data.
   *
   * An evidence-backed gate is refused outright rather than stored and silently
   * downgraded: offering the control at all would be the "seed data can fake
   * readiness" move PLAT-03 exists to prevent.
   */
  recordGate: adminProcedure
    .input(
      z
        .object({
          gate: gateInput,
          evidenceRef: z
            .string({ message: 'Say where the evidence for this step is recorded.' })
            .trim()
            .min(1, 'Say where the evidence for this step is recorded.')
            .max(500, 'This value is too long — shorten it.'),
          note: z.string().trim().max(1000).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.entitlements.organizationId;
      const actorId = ctx.session.user.id;
      const step = pharmacyOnboardingStep(input.gate);
      if (!ATTESTABLE_GATES.includes(input.gate)) {
        throw badRequest(
          'gate',
          `“${step.label}” is answered from your records, not from a note. Complete the work it asks for and it will tick itself.`
        );
      }

      const recordedAt = new Date();
      await ctx.db.$transaction(async (tx) => {
        // The gate rows hang off the onboarding state by organization, and no
        // other surface creates it, so this is where it comes into existence.
        await tx.pharmacyOnboardingState.upsert({
          where: { organizationId },
          create: { id: randomUUID(), organizationId },
          update: {},
        });
        const previous = await tx.pharmacyOnboardingGateState.findUnique({
          where: { organizationId_gate: { organizationId, gate: input.gate } },
          select: { status: true },
        });
        await tx.pharmacyOnboardingGateState.upsert({
          where: { organizationId_gate: { organizationId, gate: input.gate } },
          create: {
            id: randomUUID(),
            organizationId,
            gate: input.gate,
            status: 'PASSED',
            evidenceRef: input.evidenceRef,
            actorId,
            recordedAt,
          },
          update: {
            status: 'PASSED',
            evidenceRef: input.evidenceRef,
            actorId,
            recordedAt,
          },
        });
        // Append-only history: who said this was done, when, and on what
        // evidence. This is the record an inspection reads.
        await tx.pharmacyOnboardingEvent.create({
          data: {
            id: randomUUID(),
            organizationId,
            gate: input.gate,
            fromStatus: previous?.status ?? null,
            toStatus: 'PASSED',
            evidenceRef: input.evidenceRef,
            actorId,
            ...(input.note ? { note: input.note } : {}),
          },
        });
      });

      // Recomputed, not assumed: an attestation that does not actually move the
      // gate must be visible as such the moment it is saved.
      return readOverview(ctx);
    }),

  /**
   * The regulatory profile page: this organization's branches, the jurisdictions
   * whose rules are published, and the selected branch's effective-dated
   * versions.
   */
  regulatory: adminProcedure
    .input(
      z
        .object({ branchId: z.string().trim().max(128).optional() })
        .strict()
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.entitlements.organizationId;
      const now = new Date();
      const branches = await ctx.db.pharmacyBranch.findMany({
        where: { organizationId, active: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, city: true, addressLine: true, provinceCode: true },
      });
      const jurisdictions = await jurisdictionsInForce(ctx, now);
      // Never `branches[0]` as a fallback for "nothing chosen" (UX rule 5): a
      // requested branch outside this organization resolves to nothing, and the
      // page shows its empty state rather than another branch's licence.
      const selected = input?.branchId
        ? (branches.find((branch) => branch.id === input.branchId) ?? null)
        : (branches[0] ?? null);

      const versions = selected
        ? await ctx.db.branchRegulatoryProfile.findMany({
            where: { organizationId, branchId: selected.id },
            orderBy: { version: 'desc' },
            select: {
              id: true,
              branchId: true,
              version: true,
              effectiveFrom: true,
              effectiveTo: true,
              provinceCode: true,
              licenceCategory: true,
              licenceNumber: true,
              licenceValidFrom: true,
              licenceValidTo: true,
              licenceEvidenceFileRef: true,
              permittedSchedules: true,
              qualifiedPersonRegistration: true,
              qualifiedPersonValidFrom: true,
              qualifiedPersonValidTo: true,
              qualifiedPersonCoverageRosterRef: true,
              ntn: true,
              strn: true,
              fiscalStatus: true,
              retentionPolicy: true,
              premises: true,
              createdAt: true,
              isPlaceholder: true,
              jurisdictionRuleSet: {
                select: {
                  licenceCategories: true,
                  permittedSchedules: true,
                  pharmacistCoverageRule: true,
                },
              },
            },
          })
        : [];

      return {
        branches,
        jurisdictions,
        selectedBranchId: selected?.id ?? null,
        versions: versions.map(({ jurisdictionRuleSet, ...version }) => {
          const effective =
            version.effectiveFrom <= now &&
            (version.effectiveTo === null || version.effectiveTo > now);
          let inForce = effective;
          if (effective) {
            try {
              assertBranchMayOperate(
                {
                  ...version,
                  permittedSchedules: Array.isArray(version.permittedSchedules)
                    ? version.permittedSchedules.filter(
                        (schedule): schedule is string => typeof schedule === 'string'
                      )
                    : [],
                  ruleSet: jurisdictionRuleSet,
                  auditDenied: () => undefined,
                },
                { name: 'REGULATORY_PROFILE_VIEW', at: now, requiresQualifiedPerson: true }
              );
            } catch (error) {
              if (!(error instanceof BranchOperationDeniedError)) throw error;
              inForce = false;
            }
          }
          return {
            ...version,
            provinceName: provinceName(version.provinceCode),
            pendingLegalReview: [
              jurisdictionRuleSet.licenceCategories,
              jurisdictionRuleSet.permittedSchedules,
              jurisdictionRuleSet.pharmacistCoverageRule,
            ].some((field) => ruleSetOptions(field).provisional),
            effective,
            inForce,
            licenceExpired: effective && now >= version.licenceValidTo,
            qualifiedPersonCoverageExpired: effective && now >= version.qualifiedPersonValidTo,
          };
        }),
      };
    }),

  /**
   * Append the next effective-dated version of a branch's regulatory profile.
   *
   * The table is append-only in PostgreSQL: the only permitted UPDATE is a
   * one-time close of an open version's `effectiveTo`. This procedure performs
   * exactly that close and the successor INSERT inside one transaction, so a
   * failure can never leave the branch with its history closed and no version in
   * force.
   */
  saveRegulatoryProfile: adminProcedure
    .input(regulatoryProfileInput)
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.entitlements.organizationId;
      const effectiveFrom = midnightUtc(input.effectiveFrom);

      const branch = await ctx.db.pharmacyBranch.findFirst({
        where: { organizationId, id: input.branchId, active: true },
        select: { id: true },
      });
      if (!branch) {
        throw badRequest('branchId', 'Choose one of this workspace’s active branches.');
      }

      const activePlaceholder = await ctx.db.branchRegulatoryProfile.findFirst({
        where: {
          organizationId,
          branchId: branch.id,
          isPlaceholder: true,
          effectiveTo: null,
        },
        select: { id: true },
      });
      if (!activePlaceholder) {
        const placeholderField = [
          'premisesAddressLine',
          'premisesCity',
          'premisesStorageDescription',
          'licenceCategory',
          'licenceNumber',
          'licenceEvidenceFileRef',
          'qualifiedPersonRegistration',
          'qualifiedPersonCoverageRosterRef',
          'ntn',
          'strn',
          'fiscalStatus',
        ].find((field) => /\bPLACEHOLDER\b/i.test(String(input[field as keyof typeof input])));
        if (placeholderField) {
          throw badRequest(
            placeholderField,
            'PLACEHOLDER text is reserved for the active platform placeholder rule set.'
          );
        }
      }

      const jurisdictions = await jurisdictionsInForce(ctx, effectiveFrom);
      const jurisdiction = jurisdictions.find(
        (candidate) => candidate.provinceCode === input.provinceCode
      );
      if (!jurisdiction) {
        throw badRequest(
          'provinceCode',
          'No jurisdiction rules are published for that province on the date you chose. Pick a province that appears in the list.'
        );
      }
      if (
        jurisdiction.licenceCategories.length > 0 &&
        !jurisdiction.licenceCategories.includes(input.licenceCategory)
      ) {
        throw badRequest(
          'licenceCategory',
          `Choose one of the licence categories ${jurisdiction.provinceName} publishes.`
        );
      }
      const unpermitted = input.permittedSchedules.filter(
        (schedule) =>
          jurisdiction.permittedSchedules.length > 0 &&
          !jurisdiction.permittedSchedules.includes(schedule)
      );
      if (unpermitted.length > 0) {
        throw badRequest(
          'permittedSchedules',
          `${jurisdiction.provinceName} does not permit ${unpermitted.join(', ')} at a branch of this kind.`
        );
      }

      const latest = await ctx.db.branchRegulatoryProfile.findFirst({
        where: { organizationId, branchId: branch.id },
        orderBy: { effectiveFrom: 'desc' },
        select: { id: true, version: true, effectiveFrom: true, effectiveTo: true },
      });
      if (latest && effectiveFrom <= latest.effectiveFrom) {
        throw badRequest(
          'effectiveFrom',
          'A newer version must start after the version already on file. Choose a later date.'
        );
      }
      if (latest?.effectiveTo && latest.effectiveTo > effectiveFrom) {
        throw badRequest(
          'effectiveFrom',
          'That date falls inside a version already on file. Choose a date after it ends.'
        );
      }

      await ctx.db.$transaction(async (tx) => {
        if (latest && latest.effectiveTo === null) {
          await tx.branchRegulatoryProfile.update({
            where: { id: latest.id },
            data: { effectiveTo: effectiveFrom },
          });
        }
        await tx.branchRegulatoryProfile.create({
          data: {
            id: randomUUID(),
            organizationId,
            branchId: branch.id,
            version: (latest?.version ?? 0) + 1,
            effectiveFrom,
            provinceCode: input.provinceCode,
            jurisdictionRuleSetId: jurisdiction.id,
            premises: {
              addressLine: input.premisesAddressLine,
              city: input.premisesCity,
              storageDescription: input.premisesStorageDescription,
            },
            licenceCategory: input.licenceCategory,
            licenceNumber: input.licenceNumber,
            licenceValidFrom: midnightUtc(input.licenceValidFrom),
            licenceValidTo: midnightUtc(input.licenceValidTo),
            licenceEvidenceFileRef: input.licenceEvidenceFileRef,
            permittedSchedules: input.permittedSchedules,
            qualifiedPersonRegistration: input.qualifiedPersonRegistration,
            qualifiedPersonValidFrom: midnightUtc(input.qualifiedPersonValidFrom),
            qualifiedPersonValidTo: midnightUtc(input.qualifiedPersonValidTo),
            qualifiedPersonCoverageRosterRef: input.qualifiedPersonCoverageRosterRef,
            ntn: input.ntn?.trim() ? input.ntn.trim() : null,
            strn: input.strn?.trim() ? input.strn.trim() : null,
            fiscalStatus: input.fiscalStatus,
            retentionPolicy: {
              prescriptionYears: input.retentionPrescriptionYears,
              invoiceYears: input.retentionInvoiceYears,
              controlledRegisterYears: input.retentionControlledRegisterYears,
            },
          },
        });
      });

      // The saved profile is only half the answer; whether it moved the licences
      // gate is the half the operator came for.
      return { version: (latest?.version ?? 0) + 1, readiness: await readOverview(ctx) };
    }),
});

export type PharmacyRegulatoryProfileInput = RegulatoryProfileInput;
