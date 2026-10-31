import { createHash } from 'node:crypto';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  findPakistanTaxProfile,
  PAKISTAN_TAX_PROFILE_CATALOG,
} from '@/lib/restaurant/pakistan-tax-profiles';
import { calculateTax } from '@/lib/restaurant/tax-calculator';
import { zonedWallTimeToUtc } from '@/lib/restaurant/sop-recurrence';
import { publishTaxProfile } from '@/lib/restaurant/tax-publication';
import {
  endServiceChargePolicy,
  publishServiceChargePolicy,
  ServiceChargePolicyError,
} from '@/lib/restaurant/service-charge-policy';
import { requireRestaurantBranchScope } from '@/server/restaurant-branch-scope';
import { annotateAudit } from '../audit';
import { adminProcedure, capabilityProcedure, router } from '../trpc';

const configureProcedure = capabilityProcedure('restaurant:configure');
const serviceChargePublishSchema = z.object({
  branchId: z.string().min(1),
  rate: z.string().regex(/^(?:0\.\d{1,6}|1(?:\.0{1,6})?)$/),
  effectiveFrom: z.iso.datetime(),
  acknowledgementRef: z.string().trim().min(1).max(240),
  acknowledged: z.literal(true),
  replaceOpenPolicy: z.boolean().default(false),
  idempotencyKey: z.string().trim().min(8).max(128),
});
const serviceChargeEndSchema = z.object({
  branchId: z.string().min(1),
  policyVersionId: z.string().min(1),
  effectiveTo: z.iso.datetime(),
  idempotencyKey: z.string().trim().min(8).max(128),
});

function serviceChargeError(error: unknown): never {
  if (error instanceof ServiceChargePolicyError) {
    throw new TRPCError({
      code:
        error.reason === 'CONFLICT'
          ? 'CONFLICT'
          : error.reason === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : 'BAD_REQUEST',
      message: error.message,
    });
  }
  throw error;
}

const localDateSchema = z.iso.date();
const activationSchema = z.object({
  branchId: z.string().min(1),
  profileId: z.string().min(1),
  effectiveFrom: localDateSchema,
  accountantConfirmation: z.boolean(),
  approvalReference: z.string().trim().min(1).max(240),
  eligibilityConfirmations: z.array(z.string().min(1)).default([]),
  replaceOpenProfile: z.boolean().default(false),
  idempotencyKey: z.string().trim().min(8).max(128),
});

const jurisdictionSchema = z.enum(['PK-PB', 'PK-SD', 'PK-KP', 'PK-ICT', 'PK-BA']);
const rateSchema = z
  .string()
  .trim()
  .regex(/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/);
const customSchema = z.object({
  branchId: z.string().min(1),
  profileName: z.string().trim().min(1).max(120),
  jurisdictionCode: jurisdictionSchema,
  effectiveFrom: localDateSchema,
  effectiveTo: localDateSchema.optional(),
  priceMode: z.enum(['EXCLUSIVE', 'INCLUSIVE']),
  rates: z
    .array(z.object({ paymentCategory: z.string(), rate: rateSchema }))
    .length(3)
    .superRefine((rules, ctx) => {
      const categories = rules.map((rule) => rule.paymentCategory);
      if (
        new Set(categories).size !== 3 ||
        !['CASH', 'CARD', 'OTHER'].every((v) => categories.includes(v))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Rates must contain CASH, CARD, and OTHER exactly once.',
        });
    }),
  approvalReference: z.string().trim().min(1).max(240),
  accountantConfirmation: z.literal(true),
  replaceOpenProfile: z.boolean().default(false),
  idempotencyKey: z.string().trim().min(8).max(128),
});
const scheduleEndSchema = z.object({
  branchId: z.string().min(1),
  effectiveTo: localDateSchema,
});
const previewSchema = z.object({
  amount: z.string().regex(/^\d{1,9}(?:\.\d{1,2})?$/),
  rate: rateSchema,
  priceMode: z.enum(['EXCLUSIVE', 'INCLUSIVE']),
});

function payloadHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function canonicalActivationPayload(input: z.infer<typeof activationSchema>) {
  return {
    branchId: input.branchId,
    profileId: input.profileId,
    effectiveFrom: input.effectiveFrom,
    accountantConfirmation: input.accountantConfirmation,
    approvalReference: input.approvalReference.trim(),
    eligibilityConfirmations: [...new Set(input.eligibilityConfirmations)].sort(),
    // Preserve hashes for pre-replacement activations while binding an opted-in replacement.
    ...(input.replaceOpenProfile ? { replaceOpenProfile: true } : {}),
  };
}

export const restaurantTaxRouter = router({
  publishServiceCharge: configureProcedure
    .input(serviceChargePublishSchema)
    .mutation(async ({ ctx, input }) => {
      await requireRestaurantBranchScope(ctx, input.branchId);
      try {
        const published = await publishServiceChargePolicy(ctx.db, {
          ...input,
          organizationId: ctx.entitlements.organizationId,
          effectiveFrom: new Date(input.effectiveFrom),
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantServiceChargePolicyVersion',
          targetId: published.id,
          description: 'Published DINE_IN service-charge policy',
          metadata: {
            branchId: input.branchId,
            rate: published.rate.toString(),
            effectiveFrom: published.effectiveFrom.toISOString(),
            payloadHash: published.payloadHash,
            acknowledgedByUserId: ctx.session.user.id,
          },
        });
        return published;
      } catch (error) {
        serviceChargeError(error);
      }
    }),

  endServiceCharge: configureProcedure
    .input(serviceChargeEndSchema)
    .mutation(async ({ ctx, input }) => {
      await requireRestaurantBranchScope(ctx, input.branchId);
      try {
        const ended = await endServiceChargePolicy(ctx.db, {
          organizationId: ctx.entitlements.organizationId,
          ...input,
          effectiveTo: new Date(input.effectiveTo),
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantServiceChargePolicyVersion',
          targetId: ended.id,
          description: 'Ended DINE_IN service-charge policy',
          metadata: {
            branchId: input.branchId,
            effectiveTo: ended.effectiveTo?.toISOString(),
            payloadHash: ended.endPayloadHash,
            endedByUserId: ctx.session.user.id,
          },
        });
        return ended;
      } catch (error) {
        serviceChargeError(error);
      }
    }),

  previewCustom: adminProcedure.input(previewSchema).query(({ input }) => {
    const at = new Date('2030-01-01T00:00:00.000Z');
    const result = calculateTax(
      [{ id: 'preview-line', unitPrice: input.amount, quantity: 1 }],
      [
        {
          id: 'preview-profile',
          effectiveFrom: at,
          status: 'PUBLISHED',
          approvalReference: 'preview',
          approvedAt: at,
        },
      ],
      [
        {
          id: 'preview-rule',
          profileVersionId: 'preview-profile',
          paymentCategory: 'CASH',
          priceMode: input.priceMode,
          rate: input.rate,
          effectiveFrom: at,
          status: 'PUBLISHED',
          approvalReference: 'preview',
          approvedAt: at,
        },
      ],
      at,
      'CASH'
    );
    return {
      net: result.net.toFixed(2),
      tax: result.tax.toFixed(2),
      gross: result.gross.toFixed(2),
    };
  }),

  configuration: adminProcedure.query(async ({ ctx }) => {
    const [branches, activeProfiles] = await Promise.all([
      ctx.db.restaurantBranch.findMany({
        where: {
          organizationId: ctx.organization?.id ?? ctx.session!.user.organizationId,
          active: true,
        },
        select: { id: true, name: true, timezone: true },
        orderBy: { name: 'asc' },
      }),
      ctx.db.restaurantTaxProfileVersion.findMany({
        where: { status: 'PUBLISHED' },
        include: {
          rules: {
            select: {
              ruleCode: true,
              rate: true,
              paymentCategory: true,
              officialSource: { select: { documentTitle: true, sourceUrl: true } },
            },
          },
          branch: { select: { name: true, timezone: true } },
        },
        orderBy: { effectiveFrom: 'desc' },
      }),
    ]);
    return { branches, profiles: PAKISTAN_TAX_PROFILE_CATALOG, activeProfiles };
  }),

  publishCustom: adminProcedure.input(customSchema).mutation(async ({ ctx, input }) => {
    const canonical = {
      ...input,
      profileName: input.profileName.trim(),
      approvalReference: input.approvalReference.trim(),
      rates: [...input.rates]
        .map((rule) => ({ paymentCategory: rule.paymentCategory, rate: rule.rate }))
        .sort((a, b) => a.paymentCategory.localeCompare(b.paymentCategory)),
    };
    const hash = payloadHash(canonical);
    const created = await ctx.db.$transaction(async (tx) => {
      const replay = await tx.restaurantTaxProfileVersion.findUnique({
        where: {
          organizationId_activationIdempotencyKey: {
            organizationId: ctx.entitlements.organizationId,
            activationIdempotencyKey: input.idempotencyKey,
          },
        },
        include: { rules: true },
      });
      if (replay) {
        if (replay.activationPayloadHash !== hash)
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This idempotency key was already used for different tax configuration.',
          });
        return replay;
      }
      const branch = await tx.restaurantBranch.findFirst({
        where: {
          id: input.branchId,
          organizationId: ctx.entitlements.organizationId,
          active: true,
        },
        select: { id: true, timezone: true },
      });
      if (!branch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch not found.' });
      const effectiveFrom = zonedWallTimeToUtc(input.effectiveFrom, 0, branch.timezone).instant;
      const effectiveTo = input.effectiveTo
        ? zonedWallTimeToUtc(input.effectiveTo, 0, branch.timezone).instant
        : null;
      if (effectiveTo && (effectiveTo <= effectiveFrom || effectiveTo <= new Date()))
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The end date must be after the start date and cannot be retroactive.',
        });
      const approvalReference = `CUSTOMER SUPPLIED / NOT VERIFIED BY DEVFATHOM · ${canonical.approvalReference}`;
      const result = await publishTaxProfile(tx, {
        organizationId: ctx.entitlements.organizationId,
        branchId: input.branchId,
        effectiveFrom,
        effectiveTo,
        approvalReference,
        idempotencyKey: input.idempotencyKey,
        payloadHash: hash,
        source: {
          authorityCode: input.jurisdictionCode,
          documentTitle:
            'Customer-supplied accountant tax configuration (not an official instrument)',
          sourceUrl: 'customer-supplied:not-verified',
          contentHash: hash,
          retrievedAt: new Date(),
        },
        rules: canonical.rates.map((rule) => ({
          ruleCode: `CUSTOM-${rule.paymentCategory}`,
          paymentCategory: rule.paymentCategory as 'CASH' | 'CARD' | 'OTHER',
          rate: rule.rate,
          priceMode: input.priceMode,
        })),
        eligibilityEvidence: {
          kind: 'CUSTOMER_SUPPLIED',
          notVerifiedByDevFathom: true,
          accountantReviewed: true,
          approvalReference: canonical.approvalReference,
          canonicalPayloadHash: hash,
          approvedByUserId: ctx.session.user.id,
        },
        profileName: canonical.profileName,
        jurisdictionCode: input.jurisdictionCode,
        priceMode: input.priceMode,
        evidenceKind: 'CUSTOMER_SUPPLIED',
        replaceOpenProfile: input.replaceOpenProfile,
      });
      if (result.kind === 'occupied')
        throw new TRPCError({
          code: 'CONFLICT',
          message:
            'A published profile already covers this interval. Choose replace to close it atomically.',
        });
      if (result.kind === 'idempotency-conflict')
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This idempotency key was already used for different tax configuration.',
        });
      return result.profile;
    });
    annotateAudit(ctx, {
      targetType: 'RestaurantTaxProfileVersion',
      targetId: created.id,
      description: 'Published customer-supplied tax profile',
      metadata: {
        profileName: canonical.profileName,
        branchId: input.branchId,
        jurisdictionCode: input.jurisdictionCode,
        interval: { from: input.effectiveFrom, to: input.effectiveTo ?? null },
        priceMode: input.priceMode,
        rates: canonical.rates,
        payloadHash: hash,
        approvedByUserId: ctx.session.user.id,
      },
    });
    return created;
  }),

  scheduleEnd: adminProcedure.input(scheduleEndSchema).mutation(async ({ ctx, input }) => {
    const ended = await ctx.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.entitlements.organizationId}:${input.branchId}`}, 0))`;
      const branch = await tx.restaurantBranch.findFirst({
        where: {
          id: input.branchId,
          organizationId: ctx.entitlements.organizationId,
          active: true,
        },
        select: { timezone: true },
      });
      if (!branch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch not found.' });
      const effectiveTo = zonedWallTimeToUtc(input.effectiveTo, 0, branch.timezone).instant;
      if (effectiveTo <= new Date())
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'A profile end cannot be retroactive.',
        });
      const latest = await tx.restaurantTaxProfileVersion.findFirst({
        where: { branchId: input.branchId, status: 'PUBLISHED' },
        orderBy: { effectiveFrom: 'desc' },
        include: { rules: true },
      });
      if (!latest)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Published profile not found.' });
      if (latest.effectiveTo) {
        if (latest.effectiveTo.getTime() === effectiveTo.getTime()) return latest;
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'A published profile end cannot be reopened or changed.',
        });
      }
      if (effectiveTo <= latest.effectiveFrom)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The end date must be after the profile start.',
        });
      await tx.restaurantTaxRuleVersion.updateMany({
        where: { profileVersionId: latest.id, effectiveTo: null },
        data: { effectiveTo },
      });
      return tx.restaurantTaxProfileVersion.update({
        where: { id: latest.id },
        data: { effectiveTo },
        include: { rules: true },
      });
    });
    annotateAudit(ctx, {
      targetType: 'RestaurantTaxProfileVersion',
      targetId: ended.id,
      description: 'Scheduled published tax profile end',
      metadata: { branchId: input.branchId, effectiveTo: input.effectiveTo },
    });
    return ended;
  }),

  activate: adminProcedure.input(activationSchema).mutation(async ({ ctx, input }) => {
    const preset = findPakistanTaxProfile(input.profileId);
    if (!preset) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown tax profile.' });
    if (!preset.enabled)
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: preset.disabledReason });
    if (!input.accountantConfirmation) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Accountant confirmation is required.',
      });
    }
    const missing = preset.eligibilityControls.filter(
      (control) => !input.eligibilityConfirmations.includes(control.id)
    );
    if (missing.length) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `Missing eligibility confirmation: ${missing[0].label}`,
      });
    }
    const allowedConfirmations = new Set<string>(
      preset.eligibilityControls.map((control) => control.id)
    );
    const unknownConfirmation = input.eligibilityConfirmations.find(
      (confirmation) => !allowedConfirmations.has(confirmation)
    );
    if (unknownConfirmation) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Eligibility evidence does not match the selected profile.',
      });
    }
    if (preset.effectiveFrom && input.effectiveFrom < preset.effectiveFrom) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `This profile is unavailable before ${preset.effectiveFrom}.`,
      });
    }
    if (!preset.sourceContentHash) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'The official source content has not been pinned and reviewed.',
      });
    }
    const canonicalPayload = canonicalActivationPayload(input);
    const payloadHash = createHash('sha256').update(JSON.stringify(canonicalPayload)).digest('hex');
    const created = await ctx.db.$transaction(async (tx) => {
      const branch = await tx.restaurantBranch.findFirst({
        where: {
          id: input.branchId,
          organizationId: ctx.entitlements.organizationId,
          active: true,
        },
        select: { id: true, timezone: true },
      });
      if (!branch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch not found.' });
      const effectiveFrom = zonedWallTimeToUtc(input.effectiveFrom, 0, branch.timezone).instant;
      const approvalReference = `${preset.id} · ${canonicalPayload.approvalReference}`;
      const result = await publishTaxProfile(tx, {
        organizationId: ctx.entitlements.organizationId,
        branchId: input.branchId,
        effectiveFrom,
        approvalReference,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        presetId: preset.id,
        replaceOpenProfile: input.replaceOpenProfile,
        source: {
          authorityCode: preset.authorityCode,
          documentTitle: preset.sourceTitle,
          sourceUrl: preset.sourceUrl,
          contentHash: preset.sourceContentHash,
          retrievedAt: new Date('2026-08-29T00:00:00.000Z'),
        },
        rules: preset.rules.map((rule) => ({ ...rule, priceMode: 'EXCLUSIVE' as const })),
        eligibilityEvidence: {
          accountantReviewed: true,
          approvalReference: canonicalPayload.approvalReference,
          confirmations: preset.eligibilityControls.map((control) => ({
            id: control.id,
            label: control.label,
          })),
        },
      });
      if (result.kind === 'idempotency-conflict')
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This idempotency key was already used for a different activation.',
        });
      if (result.kind === 'occupied')
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'An active profile already covers this effective date.',
        });
      return result.profile;
    });
    annotateAudit(ctx, {
      targetType: 'RestaurantTaxProfileVersion',
      targetId: created.id,
      description: `Activated ${preset.id} tax profile`,
      metadata: {
        branchId: input.branchId,
        presetId: preset.id,
        effectiveFrom: input.effectiveFrom,
      },
    });
    return created;
  }),
});
