import 'server-only';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { canPlatform, requirePlatformSession } from '@/lib/platform/auth';
import { PlatformSecurityError } from '@/lib/platform/security';
import { withPlatformDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { publicProcedure, router } from '@/server/trpc';

const MAX_USD = 1_000_000n;

/**
 * Parse USD without ever passing it through a binary floating-point number.
 * The returned canonical string is built from integer minor units and is safe
 * to hand directly to Prisma Decimal.
 */
function exactUsd(decimalPlaces: number) {
  return z
    .string()
    .trim()
    .max(32)
    .regex(/^\d+(?:\.\d+)?$/, 'Enter a positive USD amount.')
    .transform((value, ctx) => {
      const [whole, fraction = ''] = value.split('.');
      if (fraction.length > decimalPlaces) {
        ctx.addIssue({ code: 'custom', message: `Use at most ${decimalPlaces} decimal places.` });
        return z.NEVER;
      }
      const units =
        BigInt(whole) * 10n ** BigInt(decimalPlaces) +
        BigInt(fraction.padEnd(decimalPlaces, '0'));
      if (units <= 0n || units > MAX_USD * 10n ** BigInt(decimalPlaces)) {
        ctx.addIssue({ code: 'custom', message: 'USD amount is outside the allowed range.' });
        return z.NEVER;
      }
      const padded = units.toString().padStart(decimalPlaces + 1, '0');
      return `${padded.slice(0, -decimalPlaces)}.${padded.slice(-decimalPlaces)}`;
    });
}

const budgetUsd = exactUsd(4);
const modelPriceUsd = exactUsd(6);
const modelName = z.string().trim().min(1).max(200);
const provider = z.enum(['anthropic', 'bedrock']);
const tier = z.enum(['cheap', 'standard', 'deep']);

function platformCapabilityProcedure(capability: 'settings:read' | 'settings:write') {
  return publicProcedure.use(async ({ ctx, next }) => {
    try {
      const actor = await requirePlatformSession();
      if (!canPlatform(actor, capability)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have permission for this action.',
        });
      }
      return next({ ctx: { ...ctx, platformActor: actor } });
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
}

const platformReadProcedure = platformCapabilityProcedure('settings:read');
const platformWriteProcedure = platformCapabilityProcedure('settings:write');

type AiSettingsContext = { platformDb?: ScopedDb };

function withAiSettingsDb<T>(ctx: AiSettingsContext, run: (db: ScopedDb) => Promise<T>) {
  return ctx.platformDb ? run(ctx.platformDb) : withPlatformDb(run);
}

async function lockSettings(db: ScopedDb) {
  await db.$queryRawUnsafe('SELECT id FROM ai_settings WHERE id = $1 FOR UPDATE', 'default');
}

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
  get: platformReadProcedure.query(async ({ ctx }) =>
    withAiSettingsDb(ctx, async (db) => {
      const settings = await db.aISetting.findUniqueOrThrow({ where: { id: 'default' } });
      return serializeSettings(settings);
    })
  ),

  updateMode: platformWriteProcedure
    .input(
      z.object({ mode: z.enum(['Auto', 'ForceAnthropic', 'ForceBedrock', 'Disabled']) }).strict()
    )
    .mutation(async ({ ctx, input }) =>
      withAiSettingsDb(ctx, async (db) => {
        await lockSettings(db);
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

  updateMonthlyBudget: platformWriteProcedure
    .input(z.object({ monthlyAnthropicBudgetUsd: budgetUsd }).strict())
    .mutation(async ({ ctx, input }) =>
      withAiSettingsDb(ctx, async (db) => {
        await lockSettings(db);
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

  updateTierModel: platformWriteProcedure
    .input(z.object({ provider, tier, model: modelName }).strict())
    .mutation(async ({ ctx, input }) =>
      withAiSettingsDb(ctx, async (db) => {
        await lockSettings(db);
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

  listModelPrices: platformReadProcedure.query(({ ctx }) =>
    withAiSettingsDb(ctx, async (db) => {
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

  upsertModelPrice: platformWriteProcedure
    .input(
      z
        .object({
          provider,
          model: modelName,
          inputUsdPerMTok: modelPriceUsd,
          outputUsdPerMTok: modelPriceUsd,
          effectiveFrom: z.coerce.date(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) =>
      withAiSettingsDb(ctx, async (db) => {
        const key = {
          provider: input.provider,
          model: input.model,
          effectiveFrom: input.effectiveFrom,
        };
        // The composite row may not exist yet, so a row lock cannot serialize
        // competing creates. A transaction-scoped advisory lock on the exact
        // unique key makes the pre-image and its audit row truthful.
        await db.$queryRawUnsafe(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          `${key.provider}\u0000${key.model}\u0000${key.effectiveFrom.toISOString()}`
        );
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
