import { claimUploadOrThrow } from '../upload-claims';
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
  reconcileTenantPackageGate,
  type PharmacyOnboardingGate,
} from '@/lib/pharmacy/onboarding';
import {
  pharmacyActivationSummary,
  pharmacyOnboardingChecklist,
} from '@/lib/pharmacy/onboarding-checklist';
import {
  BRANCH_PROVINCE_SET_ACTION,
  branchProvinceInput,
  fieldError,
  provinceName,
  regulatoryProfileInput,
  ruleSetOptions,
  rulesNotPublishedMessage,
  sameProvince,
  rulesPendingLegalReview,
  type RegulatoryProfileInput,
} from '@/lib/pharmacy/regulatory-profile-form';
import {
  evaluateBranchRegulatoryStatus,
  isLegacyPlaceholderProfile,
  normalizeRegulatoryPremises,
  normalizeRegulatoryProvince,
  presenceHoursCheckEnabled,
} from '@/lib/pharmacy/regulatory';
import {
  PHARMACIST_COVERAGE_DEFAULT_TIME_ZONE,
  PHARMACIST_COVERAGE_HOURS_SET_ACTION,
  normalizeCoverageWindows,
  pharmacistCoverageWindowsSchema,
  storedCoverageWindows,
} from '@/lib/pharmacy/pharmacist-coverage-hours';
import { Prisma } from '@/generated/prisma/client';
import { isIanaTimezone } from '@/lib/timezone';
import {
  regulatoryProfileInForceWhere,
  regulatoryStartInstant,
} from '@/lib/pharmacy/regulatory-start';
import { allRulesConfirmed } from '@/lib/platform/jurisdiction-rules';
import {
  FBR_TIER1_CHECK_ACTION,
  FBR_TIER1_CHECK_TARGET_TYPE,
  FBR_TIER1_CRITERIA,
  FBR_TIER1_DISCLAIMER,
  FBR_TIER1_MAX_RUPEES,
  evaluateFbrTier1,
  fbrTier1RecheckDueAt,
  isFbrTier1RecheckDue,
  parseStoredFbrTier1Answers,
  type FbrTier1Answers,
} from '@/lib/pharmacy/fbr-tier1';
import { readLicenceRenewalReminders } from '@/lib/pharmacy/licence-renewal-operations';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { recordAudit } from '../audit';
import { adminProcedure, assertModuleLicensed, router, type TRPCContext } from '../trpc';

// Server-rendered pages also use this router's standalone caller. Its paths
// lack the pharmacyOnboarding prefix used by the general module middleware.
const fbrTier1Procedure = adminProcedure.use(({ ctx, next }) => {
  assertModuleLicensed(ctx, 'pharmacy-core');
  return next();
});

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

const coverageBranchInput = z.object({ branchId: z.string().trim().min(1).max(128) }).strict();

/** The zone recorded hours are read in: the workspace's, else the gate's default. */
function coverageTimeZone(value: string | null | undefined): string {
  return value && isIanaTimezone(value) ? value : PHARMACIST_COVERAGE_DEFAULT_TIME_ZONE;
}

const fbrTier1Choice = z.enum(['YES', 'NO', 'UNSURE'], {
  message: 'Choose Yes, No or Not sure.',
});
const fbrTier1Rupees = z
  .number({ message: 'Enter an amount in whole rupees, or leave it blank if you do not know.' })
  .int('Enter an amount in whole rupees.')
  .min(0, 'An amount cannot be negative.')
  .max(FBR_TIER1_MAX_RUPEES, 'That amount is too large — check it and try again.')
  .nullable();

/** #709 — the FBR Tier-1 self-check answers. The result is never accepted from the client. */
const fbrTier1Input = z
  .object({
    chainOutlet: fbrTier1Choice,
    airConditionedMallOrPlaza: fbrTier1Choice,
    electricityBillRupees12Months: fbrTier1Rupees,
    bulkImportWholesaleAndRetail: fbrTier1Choice,
    bankCardPos: fbrTier1Choice,
    otherNotifiedCategory: fbrTier1Choice,
    annualTurnoverRupees: fbrTier1Rupees,
  })
  .strict();

/**
 * The latest stored self-check for this organization, re-read from its audit
 * row. The row keeps the verdict exactly as it was given; this view re-derives
 * it from the stored answers so the criteria and citations shown are the ones
 * the verdict rests on. A malformed row reads as "never asked", never as a
 * verdict. The re-check date is derived from when the answers were given.
 */
async function readFbrTier1Status(ctx: TRPCContext, now = new Date()) {
  const organizationId = ctx.entitlements.organizationId;
  const latest = await ctx.db.auditLog.findFirst({
    where: {
      organizationId,
      action: FBR_TIER1_CHECK_ACTION,
      targetType: FBR_TIER1_CHECK_TARGET_TYPE,
      outcome: 'SUCCESS',
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, createdAt: true, input: true, actorName: true },
  });
  const answers = latest ? parseStoredFbrTier1Answers(latest.input) : null;
  const assessment =
    latest && answers
      ? {
          id: latest.id,
          assessedAt: latest.createdAt,
          assessedBy: latest.actorName,
          answers,
          evaluation: evaluateFbrTier1(answers),
          recheckDueAt: fbrTier1RecheckDueAt(latest.createdAt),
        }
      : null;
  return {
    criteria: FBR_TIER1_CRITERIA,
    disclaimer: FBR_TIER1_DISCLAIMER,
    latest: assessment,
    recheckDue: isFbrTier1RecheckDue(assessment?.assessedAt ?? null, now),
  };
}

function midnightUtc(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

/** The checklist, activation summary and organization state, in one read. */
async function readOverview(ctx: TRPCContext) {
  const organizationId = ctx.entitlements.organizationId;
  const now = new Date();
  const organization = await ctx.db.organization.findFirst({
    where: { id: organizationId },
    select: { displayName: true, status: true, vertical: true, packageId: true, timezone: true },
  });
  const [evaluated, currentProfile] = await Promise.all([
    evaluatePharmacyReadiness(ctx.db, organizationId, now),
    ctx.db.branchRegulatoryProfile.findFirst({
      where: {
        organizationId,
        // DEV-298: a profile dated today is current from the workspace's local midnight.
        ...regulatoryProfileInForceWhere(now, organization?.timezone),
      },
      select: { licenceValidTo: true },
      orderBy: { effectiveFrom: 'desc' },
    }),
  ]);
  const readiness = reconcileTenantPackageGate(evaluated, organization);
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
      provisional: rulesPendingLegalReview(ruleSet),
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

  /** #709 — the latest FBR Tier-1 self-check, and whether it is due again. */
  fbrTier1Status: fbrTier1Procedure.query(({ ctx }) => readFbrTier1Status(ctx)),

  /**
   * #720 — branch licences, qualified-person registrations and supplier
   * licences inside a 90/60/30/7-day renewal window, with each one's renewal
   * checklist. Owner/admin only, like the rest of this router.
   */
  licenceRenewals: fbrTier1Procedure.query(({ ctx }) =>
    readLicenceRenewalReminders(ctx.db, {
      organizationId: ctx.entitlements.organizationId,
      timeZone: ctx.organization?.timezone,
    })
  ),

  /**
   * #709 — record an FBR Tier-1 self-check. The verdict is computed here from
   * the answers; the answers, the verdict, the criteria outcomes and their
   * sources are stored together in one audit row, inside a transaction so a
   * failed write fails the request rather than claiming a check that was not
   * kept.
   */
  recordFbrTier1Check: fbrTier1Procedure.input(fbrTier1Input).mutation(async ({ ctx, input }) => {
    const organizationId = ctx.entitlements.organizationId;
    const user = ctx.session.user;
    const answers: FbrTier1Answers = {
      chainOutlet: input.chainOutlet,
      airConditionedMallOrPlaza: input.airConditionedMallOrPlaza,
      electricityBillRupees12Months: input.electricityBillRupees12Months,
      bulkImportWholesaleAndRetail: input.bulkImportWholesaleAndRetail,
      bankCardPos: input.bankCardPos,
      otherNotifiedCategory: input.otherNotifiedCategory,
      annualTurnoverRupees: input.annualTurnoverRupees,
    };
    const evaluation = evaluateFbrTier1(answers);
    await ctx.db.$transaction(async (tx) => {
      await recordAudit(
        {
          organizationId,
          actorType: 'USER',
          actorId: user.id,
          actorName: user.name ?? null,
          actorEmail: user.email ?? null,
          actorRole: user.role ?? null,
          source: 'TRPC',
          category: 'PHARMACY',
          operation: 'CREATE',
          action: FBR_TIER1_CHECK_ACTION,
          description: `FBR Tier-1 self-check: ${evaluation.headline}`,
          targetType: FBR_TIER1_CHECK_TARGET_TYPE,
          targetId: organizationId,
          targetLabel: evaluation.headline,
          input: answers,
          result: {
            result: evaluation.result,
            headline: evaluation.headline,
            criteria: evaluation.criteria,
          },
          metadata: {
            rulesVersion: evaluation.rulesVersion,
            disclaimer: evaluation.disclaimer,
            ...(user.isSupportSession
              ? {
                  supportSessionId: user.supportSessionId ?? null,
                  platformUserId: user.platformUserId ?? null,
                  actingAsTenantUserId: user.id,
                }
              : {}),
          },
          path: 'pharmacyOnboarding.recordFbrTier1Check',
        },
        tx as unknown as ScopedDb
      );
    });
    return readFbrTier1Status(ctx);
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
      const organization = await ctx.db.organization.findFirst({
        where: { id: organizationId },
        select: { timezone: true },
      });
      const timeZone = organization?.timezone;
      // DEV-298: a version dated today is effective from the workspace's local midnight.
      const startedAt = regulatoryStartInstant(now, timeZone);
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
              jurisdictionRuleSetId: true,
              jurisdictionRuleSet: {
                select: {
                  code: true,
                  version: true,
                  licenceCategories: true,
                  permittedSchedules: true,
                  pharmacistCoverageRule: true,
                },
              },
            },
          })
        : [];

      // Include scheduled publications in the notice, but keep the selectable
      // jurisdictions and save procedure effective-dated. Never change a profile's binding.
      const successorRules = versions.length
        ? await ctx.db.jurisdictionRuleSet.findMany({
            where: {
              isPlaceholder: false,
              OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
            },
            orderBy: { version: 'desc' },
          })
        : [];

      return {
        branches,
        jurisdictions,
        selectedBranchId: selected?.id ?? null,
        versions: versions.map(({ jurisdictionRuleSet, ...version }) => {
          const effective =
            version.effectiveFrom <= startedAt &&
            (version.effectiveTo === null || version.effectiveTo > startedAt);
          const status = evaluateBranchRegulatoryStatus(
            {
              ...version,
              permittedSchedules: Array.isArray(version.permittedSchedules)
                ? version.permittedSchedules.filter(
                    (schedule): schedule is string => typeof schedule === 'string'
                  )
                : [],
              ruleSet: jurisdictionRuleSet,
            },
            effective,
            now,
            // Listed branches are all active (see the query above).
            selected ? { profile: version, site: { ...selected, active: true } } : undefined,
            timeZone
          );
          // Only for rules that still apply to the selected branch: after a province
          // change, the retained profile's former province is no longer relevant.
          const candidate =
            selected && sameProvince(selected.provinceCode, version.provinceCode)
              ? successorRules.find(
                  (rules) =>
                    sameProvince(rules.code, version.provinceCode) &&
                    allRulesConfirmed(rules) &&
                    rules.version > jurisdictionRuleSet.version
                )
              : undefined;
          // Once the owner has recorded a later profile version on these (or newer)
          // rules, adoption is already scheduled and the notice would invite a duplicate.
          const adoptionRecorded =
            candidate !== undefined &&
            versions.some(
              (other) =>
                other.effectiveFrom > version.effectiveFrom &&
                (other.effectiveTo === null || other.effectiveTo > now) &&
                sameProvince(other.jurisdictionRuleSet.code, candidate.code) &&
                other.jurisdictionRuleSet.version >= candidate.version
            );
          const newerRules = adoptionRecorded ? undefined : candidate;
          return {
            ...version,
            ...(newerRules
              ? {
                  newerConfirmedRuleSet: {
                    version: newerRules.version,
                    effectiveFrom: newerRules.effectiveFrom,
                  },
                }
              : {}),
            provinceName: provinceName(version.provinceCode),
            pendingLegalReview: rulesPendingLegalReview(jurisdictionRuleSet),
            ...status,
            // Legacy placeholders cannot be in force until a bound successor exists.
            premisesCompletionDue: status.inForce && isLegacyPlaceholderProfile(version),
          };
        }),
      };
    }),

  /**
   * DEV-846 (DEV-86) — the pharmacist coverage hours the owner has recorded for
   * one branch, and whether the live-sale hours check is on for it. The check is
   * on only when the rule set of the branch's profile in force publishes
   * presence hours; recorded hours never turn it on.
   */
  pharmacistCoverage: adminProcedure.input(coverageBranchInput).query(async ({ ctx, input }) => {
    const organizationId = ctx.entitlements.organizationId;
    const now = new Date();
    const branch = await ctx.db.pharmacyBranch.findFirst({
      where: { organizationId, id: input.branchId, active: true },
      select: { id: true, pharmacistCoverageHours: true, pharmacistCoverageRevision: true },
    });
    if (!branch) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Choose an active branch.' });
    }
    const organization = await ctx.db.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const profile = await ctx.db.branchRegulatoryProfile.findFirst({
      where: {
        organizationId,
        branchId: branch.id,
        ...regulatoryProfileInForceWhere(now, organization?.timezone),
      },
      orderBy: { version: 'desc' },
      select: { jurisdictionRuleSet: { select: { pharmacistCoverageRule: true } } },
    });
    const stored = branch.pharmacistCoverageHours as { timeZone?: unknown } | null;
    return {
      branchId: branch.id,
      timeZone:
        typeof stored?.timeZone === 'string'
          ? stored.timeZone
          : coverageTimeZone(organization?.timezone),
      windows: storedCoverageWindows(branch.pharmacistCoverageHours),
      revision: branch.pharmacistCoverageRevision,
      liveSaleHoursCheck: presenceHoursCheckEnabled(
        profile?.jurisdictionRuleSet.pharmacistCoverageRule
      ),
    };
  }),

  /**
   * DEV-846 — record a branch's pharmacist coverage hours. Owner/admin only
   * (adminProcedure), optimistic on the branch's coverage revision, and audited
   * with the before and after hours in the same transaction. Saving no windows
   * clears the record. This never changes what a sale is allowed to do.
   */
  savePharmacistCoverage: adminProcedure
    .input(
      coverageBranchInput
        .extend({
          revision: z.number().int().nonnegative(),
          windows: pharmacistCoverageWindowsSchema,
          timeZone: z.string().trim().min(1).max(64).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.entitlements.organizationId;
      const user = ctx.session.user;
      const branch = await ctx.db.pharmacyBranch.findFirst({
        where: { organizationId, id: input.branchId, active: true },
        select: { id: true, name: true, pharmacistCoverageHours: true },
      });
      if (!branch) {
        throw badRequest('branchId', 'Choose one of this workspace’s active branches.');
      }
      const organization = await ctx.db.organization.findFirst({
        where: { id: organizationId },
        select: { timezone: true },
      });
      const windows = normalizeCoverageWindows(input.windows);
      // A save never changes the zone already stored for the branch.
      const storedZone = (branch.pharmacistCoverageHours as { timeZone?: unknown } | null)
        ?.timeZone;
      const keptTimeZone =
        typeof storedZone === 'string' && isIanaTimezone(storedZone)
          ? storedZone
          : input.timeZone && isIanaTimezone(input.timeZone)
            ? input.timeZone
            : coverageTimeZone(organization?.timezone);
      const hours = windows.length ? { timeZone: keptTimeZone, windows } : null;
      const revision = input.revision + 1;
      await ctx.db.$transaction(async (tx) => {
        const updated = await tx.pharmacyBranch.updateMany({
          where: {
            organizationId,
            id: branch.id,
            active: true,
            pharmacistCoverageRevision: input.revision,
          },
          data: {
            pharmacistCoverageHours: hours ?? Prisma.DbNull,
            pharmacistCoverageRevision: { increment: 1 },
          },
        });
        if (updated.count !== 1) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'These hours changed while you were editing them. Reload and try again.',
          });
        }
        await recordAudit(
          {
            organizationId,
            actorType: 'USER',
            actorId: user.id,
            actorName: user.name ?? null,
            actorEmail: user.email ?? null,
            actorRole: user.role ?? null,
            source: 'TRPC',
            category: 'PHARMACY',
            operation: 'UPDATE',
            action: PHARMACIST_COVERAGE_HOURS_SET_ACTION,
            description: hours
              ? `Pharmacist coverage hours recorded (${windows.length} window${windows.length === 1 ? '' : 's'})`
              : 'Pharmacist coverage hours cleared',
            targetType: 'PharmacyBranch',
            targetId: branch.id,
            targetLabel: branch.name,
            changes: {
              pharmacistCoverageHours: { before: branch.pharmacistCoverageHours, after: hours },
            },
            metadata: {
              revision,
              ...(user.isSupportSession
                ? {
                    supportSessionId: user.supportSessionId ?? null,
                    platformUserId: user.platformUserId ?? null,
                    actingAsTenantUserId: user.id,
                  }
                : {}),
            },
            path: 'pharmacyOnboarding.savePharmacistCoverage',
          },
          tx as unknown as ScopedDb
        );
      });
      return { branchId: branch.id, windows, revision };
    }),

  /**
   * QA-3 — set the province a branch operates in. Owner/admin only
   * (adminProcedure) and audited twice: the procedure audit middleware records
   * the call, and this records the before and after province in the same
   * transaction as the change. The branch's province decides which published
   * jurisdiction rules its regulatory profile is recorded on (#977). It never
   * changes a retention period: pharmacy_retention_days() reads the rule set of
   * the profile in force, and its 10-year floor holds whatever the province.
   */
  setBranchProvince: adminProcedure.input(branchProvinceInput).mutation(async ({ ctx, input }) => {
    const organizationId = ctx.entitlements.organizationId;
    const user = ctx.session.user;
    const branch = await ctx.db.pharmacyBranch.findFirst({
      where: { organizationId, id: input.branchId, active: true },
      select: { id: true, name: true, provinceCode: true },
    });
    if (!branch) {
      throw badRequest('branchId', 'Choose one of this workspace’s active branches.');
    }
    if (sameProvince(branch.provinceCode, input.provinceCode)) {
      return { branchId: branch.id, provinceCode: branch.provinceCode, changed: false };
    }
    await ctx.db.$transaction(async (tx) => {
      const updated = await tx.pharmacyBranch.updateMany({
        where: { organizationId, id: branch.id, provinceCode: branch.provinceCode },
        data: { provinceCode: input.provinceCode },
      });
      if (updated.count !== 1) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This branch changed while you were editing it. Reload and try again.',
        });
      }
      await recordAudit(
        {
          organizationId,
          actorType: 'USER',
          actorId: user.id,
          actorName: user.name ?? null,
          actorEmail: user.email ?? null,
          actorRole: user.role ?? null,
          source: 'TRPC',
          category: 'PHARMACY',
          operation: 'UPDATE',
          action: BRANCH_PROVINCE_SET_ACTION,
          description: `Branch province changed from ${provinceName(branch.provinceCode)} to ${provinceName(input.provinceCode)}`,
          targetType: 'PharmacyBranch',
          targetId: branch.id,
          targetLabel: branch.name,
          changes: {
            provinceCode: { before: branch.provinceCode, after: input.provinceCode },
          },
          metadata: user.isSupportSession
            ? {
                supportSessionId: user.supportSessionId ?? null,
                platformUserId: user.platformUserId ?? null,
                actingAsTenantUserId: user.id,
              }
            : undefined,
          path: 'pharmacyOnboarding.setBranchProvince',
        },
        tx as unknown as ScopedDb
      );
    });
    return { branchId: branch.id, provinceCode: input.provinceCode, changed: true };
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
        select: { id: true, provinceCode: true, addressLine: true, city: true },
      });
      if (!branch) {
        throw badRequest('branchId', 'Choose one of this workspace’s active branches.');
      }

      const normalizeProvince = normalizeRegulatoryProvince;
      const normalizePremises = normalizeRegulatoryPremises;
      if (normalizeProvince(input.provinceCode) !== normalizeProvince(branch.provinceCode)) {
        throw badRequest('provinceCode', 'The regulatory province must match the selected branch.');
      }
      if (normalizePremises(input.premisesAddressLine) !== normalizePremises(branch.addressLine)) {
        throw badRequest(
          'premisesAddressLine',
          'The premises address must match the selected branch address.'
        );
      }
      if (normalizePremises(input.premisesCity) !== normalizePremises(branch.city)) {
        throw badRequest('premisesCity', 'The premises city must match the selected branch city.');
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
          'premisesPhone',
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
      // #977 — only the branch's own province can carry its profile (checked
      // above), so a province without published rules is reported as exactly
      // that rather than inviting the operator to pick another province.
      const jurisdiction = jurisdictions.find((candidate) =>
        sameProvince(candidate.provinceCode, branch.provinceCode)
      );
      if (!jurisdiction) {
        throw badRequest('provinceCode', rulesNotPublishedMessage(branch.provinceCode));
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
              phone: input.premisesPhone?.trim() || null,
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
        await claimUploadOrThrow(tx, input.licenceEvidenceFileRef, ctx.session.user.id, {
          type: 'PHARMACY_LICENCE_EVIDENCE',
          id: branch.id,
        });
        await claimUploadOrThrow(tx, input.qualifiedPersonCoverageRosterRef, ctx.session.user.id, {
          type: 'PHARMACY_COVERAGE_ROSTER',
          id: branch.id,
        });
      });

      // The saved profile is only half the answer; whether it moved the licences
      // gate is the half the operator came for.
      return { version: (latest?.version ?? 0) + 1, readiness: await readOverview(ctx) };
    }),
});

export type PharmacyRegulatoryProfileInput = RegulatoryProfileInput;
