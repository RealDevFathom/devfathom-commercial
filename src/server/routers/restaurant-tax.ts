import { createHash } from 'node:crypto';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  findPakistanTaxProfile,
  PAKISTAN_TAX_PROFILE_CATALOG,
} from '@/lib/restaurant/pakistan-tax-profiles';
import { annotateAudit } from '../audit';
import { adminProcedure, router } from '../trpc';

const activationSchema = z.object({
  branchId: z.string().min(1),
  profileId: z.string().min(1),
  effectiveFrom: z.iso.datetime(),
  accountantConfirmation: z.boolean(),
  approvalReference: z.string().trim().min(1).max(240),
  eligibilityConfirmations: z.array(z.string().min(1)).default([]),
});

export const restaurantTaxRouter = router({
  configuration: adminProcedure.query(async ({ ctx }) => {
    const [branches, activeProfiles] = await Promise.all([
      ctx.db.restaurantBranch.findMany({
        where: { active: true },
        select: { id: true, name: true },
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
          branch: { select: { name: true } },
        },
        orderBy: { effectiveFrom: 'desc' },
      }),
    ]);
    return { branches, profiles: PAKISTAN_TAX_PROFILE_CATALOG, activeProfiles };
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
    const effectiveFrom = new Date(input.effectiveFrom);
    if (preset.effectiveFrom && effectiveFrom < new Date(`${preset.effectiveFrom}T00:00:00.000Z`)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `This profile is unavailable before ${preset.effectiveFrom}.`,
      });
    }
    const branch = await ctx.db.restaurantBranch.findUnique({
      where: { id: input.branchId },
      select: { id: true },
    });
    if (!branch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch not found.' });

    const existing = await ctx.db.restaurantTaxProfileVersion.findFirst({
      where: {
        branchId: input.branchId,
        status: 'PUBLISHED',
        effectiveFrom: { lte: effectiveFrom },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: effectiveFrom } }],
      },
      select: { id: true },
    });
    if (existing)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'An active profile already covers this effective date.',
      });

    const sourceFingerprint = createHash('sha256')
      .update(`WHA-526\n${preset.sourceUrl}`)
      .digest('hex');
    const source = await ctx.db.restaurantTaxOfficialSource.upsert({
      where: {
        organizationId_contentHash: {
          organizationId: ctx.entitlements.organizationId,
          contentHash: sourceFingerprint,
        },
      },
      update: {},
      create: {
        authorityCode: preset.authorityCode,
        documentTitle: preset.sourceTitle,
        sourceUrl: preset.sourceUrl,
        contentHash: sourceFingerprint,
        retrievedAt: new Date('2026-08-29T00:00:00.000Z'),
      },
    });
    const latest = await ctx.db.restaurantTaxProfileVersion.findFirst({
      where: { branchId: input.branchId },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true },
    });
    const now = new Date();
    const approvalReference = `WHA-526 · ${preset.id} · ${input.approvalReference}`;
    const created = await ctx.db.restaurantTaxProfileVersion.create({
      data: {
        branchId: input.branchId,
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        status: 'PUBLISHED',
        effectiveFrom,
        approvalReference,
        approvedAt: now,
        publishedAt: now,
        rules: {
          create: preset.rules.map((rule) => ({
            ...rule,
            officialSourceId: source.id,
            priceMode: 'EXCLUSIVE' as const,
            status: 'PUBLISHED' as const,
            effectiveFrom,
            approvalReference,
            approvedAt: now,
            publishedAt: now,
          })),
        },
      },
      include: { rules: true },
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
