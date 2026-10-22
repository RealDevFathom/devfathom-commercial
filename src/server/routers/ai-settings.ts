import 'server-only';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { requirePlatformSession } from '@/lib/platform/auth';
import { PlatformSecurityError } from '@/lib/platform/security';
import { withPlatformDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { publicProcedure, router } from '@/server/trpc';

const MAX_USD = 1_000_000;
const money = z.coerce.number().finite().positive().max(MAX_USD);
const modelName = z.string().trim().min(1).max(200);
const provider = z.enum(['anthropic', 'bedrock']);
const tier = z.enum(['cheap', 'standard', 'deep']);

const superAdminProcedure = publicProcedure.use(async ({ next }) => {
  try {
    const actor = await requirePlatformSession();
    if (actor.role !== 'SUPER_ADMIN') {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'SuperAdmin access is required.' });
    }
    return next({ ctx: { platformActor: actor } });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (error instanceof PlatformSecurityError) {
      throw new TRPCError({
        code: error.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
        message: error.message,
      });
    }
    throw error;
  }
});

function serializeSettings(settings: {
  mode: string;
  monthlyAnthropicBudgetUsd: { toString(): string };
  cheapAnthropicModel: string;
  standardAnthropicModel: string;
  deepAnthropicModel: string;
  cheapBedrockModel: string;
  standardBedrockModel: string;
  deepBedrockModel: string;
  updatedAt: Date;
  updatedBy: string | null;
}) {
  return { ...settings, monthlyAnthropicBudgetUsd: settings.monthlyAnthropicBudgetUsd.toString() };
}

async function auditChange(
  db: ScopedDb,
  actorId: string,
  entity: string,
  entityId: string,
  field: string,
  before: unknown,
  after: unknown
) {
  await db.platformAuditLog.create({
    data: {
      actorPlatformUserId: actorId,
      action: 'ai.settings.updated',
      targetType: entity,
      targetId: entityId,
      before: { [field]: before },
      after: { [field]: after },
      metadata: { field },
    },
  });
}

const modelField = {
  anthropic: {
    cheap: 'cheapAnthropicModel',
    standard: 'standardAnthropicModel',
    deep: 'deepAnthropicModel',
  },
  bedrock: {
    cheap: 'cheapBedrockModel',
    standard: 'standardBedrockModel',
    deep: 'deepBedrockModel',
  },
} as const;

export const aiSettingsRouter = router({
  get: superAdminProcedure.query(async () =>
    withPlatformDb(async (db) => {
      const settings = await db.aISetting.findUniqueOrThrow({ where: { id: 'default' } });
      return serializeSettings(settings);
    })
  ),

  updateMode: superAdminProcedure
    .input(
      z.object({ mode: z.enum(['Auto', 'ForceAnthropic', 'ForceBedrock', 'Disabled']) }).strict()
    )
    .mutation(async ({ ctx, input }) =>
      withPlatformDb(async (db) => {
        const before = await db.aISetting.findUniqueOrThrow({ where: { id: 'default' } });
        const after = await db.aISetting.update({
          where: { id: 'default' },
          data: { mode: input.mode, updatedBy: ctx.platformActor.id },
        });
        await auditChange(
          db,
          ctx.platformActor.id,
          'AISetting',
          'default',
          'mode',
          before.mode,
          after.mode
        );
        return serializeSettings(after);
      })
    ),

  updateMonthlyBudget: superAdminProcedure
    .input(z.object({ monthlyAnthropicBudgetUsd: money }).strict())
    .mutation(async ({ ctx, input }) =>
      withPlatformDb(async (db) => {
        const before = await db.aISetting.findUniqueOrThrow({ where: { id: 'default' } });
        const after = await db.aISetting.update({
          where: { id: 'default' },
          data: {
            monthlyAnthropicBudgetUsd: input.monthlyAnthropicBudgetUsd,
            updatedBy: ctx.platformActor.id,
          },
        });
        await auditChange(
          db,
          ctx.platformActor.id,
          'AISetting',
          'default',
          'monthlyAnthropicBudgetUsd',
          before.monthlyAnthropicBudgetUsd.toString(),
          after.monthlyAnthropicBudgetUsd.toString()
        );
        return serializeSettings(after);
      })
    ),

  updateTierModel: superAdminProcedure
    .input(z.object({ provider, tier, model: modelName }).strict())
    .mutation(async ({ ctx, input }) =>
      withPlatformDb(async (db) => {
        const field = modelField[input.provider][input.tier];
        const before = await db.aISetting.findUniqueOrThrow({ where: { id: 'default' } });
        const after = await db.aISetting.update({
          where: { id: 'default' },
          data: { [field]: input.model, updatedBy: ctx.platformActor.id },
        });
        await auditChange(
          db,
          ctx.platformActor.id,
          'AISetting',
          'default',
          field,
          before[field],
          after[field]
        );
        return serializeSettings(after);
      })
    ),

  listModelPrices: superAdminProcedure.query(() =>
    withPlatformDb(async (db) => {
      const prices = await db.aIModelPrice.findMany({
        orderBy: [{ provider: 'asc' }, { model: 'asc' }, { effectiveFrom: 'desc' }],
      });
      return prices.map((price) => ({
        ...price,
        inputUsdPerMTok: price.inputUsdPerMTok.toString(),
        outputUsdPerMTok: price.outputUsdPerMTok.toString(),
      }));
    })
  ),

  upsertModelPrice: superAdminProcedure
    .input(
      z
        .object({
          provider,
          model: modelName,
          inputUsdPerMTok: money,
          outputUsdPerMTok: money,
          effectiveFrom: z.coerce.date(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) =>
      withPlatformDb(async (db) => {
        const key = {
          provider: input.provider,
          model: input.model,
          effectiveFrom: input.effectiveFrom,
        };
        const before = await db.aIModelPrice.findUnique({
          where: { provider_model_effectiveFrom: key },
        });
        const after = await db.aIModelPrice.upsert({
          where: { provider_model_effectiveFrom: key },
          create: {
            ...key,
            inputUsdPerMTok: input.inputUsdPerMTok,
            outputUsdPerMTok: input.outputUsdPerMTok,
          },
          update: {
            inputUsdPerMTok: input.inputUsdPerMTok,
            outputUsdPerMTok: input.outputUsdPerMTok,
          },
        });
        await db.platformAuditLog.create({
          data: {
            actorPlatformUserId: ctx.platformActor.id,
            action: 'ai.model-price.upserted',
            targetType: 'AIModelPrice',
            targetId: after.id,
            before: before
              ? {
                  inputUsdPerMTok: before.inputUsdPerMTok.toString(),
                  outputUsdPerMTok: before.outputUsdPerMTok.toString(),
                }
              : null,
            after: {
              inputUsdPerMTok: after.inputUsdPerMTok.toString(),
              outputUsdPerMTok: after.outputUsdPerMTok.toString(),
            },
            metadata: {
              field: 'price',
              provider: input.provider,
              model: input.model,
              effectiveFrom: input.effectiveFrom.toISOString(),
            },
          },
        });
        return {
          ...after,
          inputUsdPerMTok: after.inputUsdPerMTok.toString(),
          outputUsdPerMTok: after.outputUsdPerMTok.toString(),
        };
      })
    ),
});
