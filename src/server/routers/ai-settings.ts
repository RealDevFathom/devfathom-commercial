import 'server-only';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { AISetting, Prisma } from '@/generated/prisma/client';
import {
  AI_TIERS,
  ROUTED_AI_PROVIDERS,
  capEnvName,
  modelEnvName,
  type TieredAIProviderName,
} from '@/lib/ai/model-defaults';
import { isRoutedProviderConfigured, readAISelector } from '@/lib/ai/provider';
import { candidateChain, karachiMonthBounds, resolveRoutingSettings } from '@/lib/ai/router';
import { readProviderSpend, storedSettingsFromRow, type AIRoutingMode } from '@/lib/ai/spend';
import type { AITier } from '@/lib/ai/tiers';
import { canPlatform, requirePlatformSession } from '@/lib/platform/auth';
import { PlatformSecurityError } from '@/lib/platform/security';
import { withPlatformDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { publicProcedure, router } from '@/server/trpc';

type Env = Record<string, string | undefined>;
type Provider = TieredAIProviderName;

// BigInt() rather than literals: the project targets ES2017.
const ZERO = BigInt(0);
const TEN = BigInt(10);
const MAX_USD = BigInt(1_000_000);
const SETTINGS_ID = 'default';
/** The router reads saved settings through a 30 s cache (src/lib/ai/router.ts). */
export const AI_SETTINGS_APPLY_WITHIN_SECONDS = 30;

export const AI_ROUTING_MODES = [
  'Auto',
  'ForceAnthropic',
  'ForceOpenAI',
  'ForceBedrock',
  'Disabled',
] as const satisfies readonly AIRoutingMode[];

/**
 * Parse USD without ever passing it through a binary floating-point number.
 * The returned canonical string is built from integer minor units and is safe
 * to hand directly to Prisma Decimal.
 */
function exactUsd(decimalPlaces: number, { allowZero = false }: { allowZero?: boolean } = {}) {
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
      const scale = TEN ** BigInt(decimalPlaces);
      const units = BigInt(whole) * scale + BigInt(fraction.padEnd(decimalPlaces, '0'));
      if ((!allowZero && units === ZERO) || units > MAX_USD * scale) {
        ctx.addIssue({ code: 'custom', message: 'USD amount is outside the allowed range.' });
        return z.NEVER;
      }
      const padded = units.toString().padStart(decimalPlaces + 1, '0');
      return `${padded.slice(0, -decimalPlaces)}.${padded.slice(-decimalPlaces)}`;
    });
}

/** A monthly cap may be zero: that blocks the provider without removing it from the order. */
const monthlyCapUsd = exactUsd(4, { allowZero: true });
const modelPriceUsd = exactUsd(6);
const modelName = z.string().trim().min(1).max(200);
/** A model id is one token: no spaces, tabs or newlines anywhere in it. */
const modelId = modelName.regex(/^\S+$/, 'A model id cannot contain whitespace.');
/** Azure is not a routed provider, so it is rejected here like any unknown name. */
const provider = z.enum(ROUTED_AI_PROVIDERS);
const tier = z.enum(AI_TIERS);
const providerOrder = z
  .array(provider)
  .min(1, 'Keep at least one provider in the order.')
  .max(ROUTED_AI_PROVIDERS.length)
  .refine((order) => new Set(order).size === order.length, 'Each provider can appear only once.');

const CAP_COLUMN = {
  anthropic: 'anthropicMonthlyCapUsd',
  openai: 'openaiMonthlyCapUsd',
  bedrock: 'bedrockMonthlyCapUsd',
} as const satisfies Record<Provider, keyof AISetting>;

const MODEL_COLUMN = {
  anthropic: {
    cheap: 'cheapAnthropicModel',
    standard: 'standardAnthropicModel',
    deep: 'deepAnthropicModel',
  },
  openai: { cheap: 'cheapOpenaiModel', standard: 'standardOpenaiModel', deep: 'deepOpenaiModel' },
  bedrock: {
    cheap: 'cheapBedrockModel',
    standard: 'standardBedrockModel',
    deep: 'deepBedrockModel',
  },
} as const satisfies Record<Provider, Record<AITier, keyof AISetting>>;

type CapColumn = (typeof CAP_COLUMN)[Provider];
type ModelColumn = (typeof MODEL_COLUMN)[Provider][AITier];
type SettingsColumn = 'mode' | 'providerOrder' | 'fallbackEnabled' | CapColumn | ModelColumn;
type SettingsWrite = Partial<{
  mode: AIRoutingMode;
  providerOrder: Provider[];
  fallbackEnabled: boolean;
}> &
  Partial<Record<CapColumn, string | null>> &
  Partial<Record<ModelColumn, string | null>>;

const capWrite = (name: Provider, value: string | null) =>
  ({ [CAP_COLUMN[name]]: value }) as SettingsWrite;
const modelWrite = (name: Provider, level: AITier, value: string | null) =>
  ({ [MODEL_COLUMN[name][level]]: value }) as SettingsWrite;

/** Every stored override cleared: the singleton then routes exactly like no row at all. */
const ALL_DEFAULTS: SettingsWrite = (() => {
  const data: SettingsWrite = { mode: 'Auto', providerOrder: [], fallbackEnabled: true };
  for (const name of ROUTED_AI_PROVIDERS) {
    Object.assign(data, capWrite(name, null));
    for (const level of AI_TIERS) Object.assign(data, modelWrite(name, level, null));
  }
  return data;
})();

type PlatformActor = Awaited<ReturnType<typeof requirePlatformSession>>;
type AiSettingsContext = {
  platformDb?: ScopedDb;
  session?: { user?: unknown } | null;
  requestMeta?: { ip?: string | null; userAgent?: string | null };
};

const FORBIDDEN_MESSAGE = 'You do not have permission for this action.';

/**
 * Exactly SUPER_ADMIN, through the central capability table as well. A tenant
 * session without a platform session is refused rather than asked to sign in.
 */
function superAdminProcedure(capability: 'settings:read' | 'settings:write') {
  return publicProcedure.use(async ({ ctx, next }) => {
    let actor: PlatformActor;
    try {
      actor = await requirePlatformSession();
    } catch (error) {
      if (error instanceof PlatformSecurityError) {
        const tenantSession = Boolean((ctx as AiSettingsContext).session?.user);
        if (error.status === 401 && !tenantSession) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: error.message });
        }
        throw new TRPCError({ code: 'FORBIDDEN', message: FORBIDDEN_MESSAGE });
      }
      throw error;
    }
    if (actor.role !== 'SUPER_ADMIN' || !canPlatform(actor, capability)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: FORBIDDEN_MESSAGE });
    }
    return next({ ctx: { ...ctx, platformActor: actor } });
  });
}

const platformReadProcedure = superAdminProcedure('settings:read');
const platformWriteProcedure = superAdminProcedure('settings:write');

function withAiSettingsDb<T>(ctx: AiSettingsContext, run: (db: ScopedDb) => Promise<T>) {
  return ctx.platformDb ? run(ctx.platformDb) : withPlatformDb(run);
}

const decimalText = (value: { toString(): string } | null) =>
  value === null ? null : value.toString();

/** The stored overrides as plain JSON. NULL / an empty order means "environment default". */
function serializeStored(row: AISetting | null) {
  const capsUsd = {} as Record<Provider, string | null>;
  const models = {} as Record<Provider, Record<AITier, string | null>>;
  for (const name of ROUTED_AI_PROVIDERS) {
    capsUsd[name] = row ? decimalText(row[CAP_COLUMN[name]]) : null;
    models[name] = {} as Record<AITier, string | null>;
    for (const level of AI_TIERS) models[name][level] = row?.[MODEL_COLUMN[name][level]] ?? null;
  }
  return {
    mode: (row?.mode ?? 'Auto') as AIRoutingMode,
    providerOrder: (row?.providerOrder ?? []) as Provider[],
    fallbackEnabled: row?.fallbackEnabled ?? true,
    capsUsd,
    models,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

/** Audit values for the named columns; a missing row records every stored value as null. */
function snapshot(row: AISetting | null, columns: SettingsColumn[]): Prisma.InputJsonObject {
  const values: Record<string, string | boolean | string[] | null> = {};
  for (const column of columns) {
    if (!row) {
      values[column] = null;
      continue;
    }
    const value = row[column];
    values[column] =
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      Array.isArray(value)
        ? value
        : value.toString();
  }
  return values;
}

/**
 * Upsert the singleton and write its audit row in one platform transaction. The
 * row may not exist yet, so a row lock cannot serialize two first saves; a
 * transaction-scoped advisory lock keeps the audit pre-image truthful.
 */
async function writeSettings(
  ctx: AiSettingsContext & { platformActor: PlatformActor },
  action: 'ai.settings.updated' | 'ai.settings.reset',
  data: SettingsWrite,
  metadata: Record<string, string> = {}
) {
  const actor = ctx.platformActor;
  const columns = Object.keys(data) as SettingsColumn[];
  return withAiSettingsDb(ctx, async (db) => {
    await db.$queryRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      `ai_settings:${SETTINGS_ID}`
    );
    const before = await db.aISetting.findUnique({ where: { id: SETTINGS_ID } });
    const after = await db.aISetting.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, ...data, updatedBy: actor.id },
      update: { ...data, updatedBy: actor.id },
    });
    await db.platformAuditLog.create({
      data: {
        actorPlatformUserId: actor.id,
        action,
        targetType: 'AISetting',
        targetId: SETTINGS_ID,
        before: snapshot(before, columns),
        after: snapshot(after, columns),
        metadata: { ...metadata, fields: columns, created: !before },
        ip: ctx.requestMeta?.ip ?? null,
        userAgent: ctx.requestMeta?.userAgent?.slice(0, 500) ?? null,
      },
    });
    return serializeStored(after);
  });
}

export type CapStatus = 'unknown' | 'under' | 'near' | 'at' | 'over';

/** Mirrors the router: a provider whose spend reaches its cap is skipped. */
export function capStatus(spentUsd: number | null, capUsd: number): CapStatus {
  if (spentUsd === null) return 'unknown';
  if (spentUsd > capUsd) return 'over';
  if (spentUsd >= capUsd) return 'at';
  if (spentUsd >= capUsd * 0.8) return 'near';
  return 'under';
}

/** Where an environment default comes from: a set variable, or the code default. */
const defaultSource = (env: Env, name: string): 'environment' | 'built-in' =>
  env[name]?.trim() ? 'environment' : 'built-in';

/**
 * What the router will do with these settings: the effective values, which of
 * them are SuperAdmin overrides, the environment defaults a reset returns to,
 * this month's spend against each cap and which providers are configured.
 * Configuration is reported as booleans and variable names, never values of secrets.
 */
async function describeSettings(row: AISetting | null, env: Env, now: Date) {
  const stored = row ? storedSettingsFromRow(row) : null;
  const effective = resolveRoutingSettings(stored, env);
  const defaults = resolveRoutingSettings(null, env);
  const month = karachiMonthBounds(now);
  // One at a time: each read is its own short platform transaction, and this
  // request may already hold a pooled connection for the batch transaction.
  const spend: Array<number | null> = [];
  for (const name of ROUTED_AI_PROVIDERS) {
    try {
      spend.push(await readProviderSpend(name, month.from, month.to));
    } catch (error) {
      // Unknown spend is shown as unknown; the router skips such a provider.
      console.error('[ai-settings] could not read provider spend', {
        provider: name,
        error: error instanceof Error ? error.name : 'Error',
      });
      spend.push(null);
    }
  }
  const selector = readAISelector(env);
  const pkt = new Date(now.getTime() + 5 * 60 * 60 * 1000);

  return {
    mode: { value: effective.mode, isOverride: effective.mode !== 'Auto' },
    providerOrder: {
      value: effective.providerOrder,
      isOverride: Boolean(stored?.providerOrder.length),
      defaultValue: defaults.providerOrder,
      defaultSource: defaultSource(env, 'AI_PROVIDER_ORDER'),
    },
    fallbackEnabled: { value: effective.fallbackEnabled, isOverride: !effective.fallbackEnabled },
    /** The providers a call tries right now, in order. */
    chain: candidateChain(effective, env),
    /**
     * `active` when AI_PROVIDER selects the routed chain. `bypassed` when it names
     * an explicit provider outside routing, which these settings do not govern.
     */
    routing:
      selector.kind === 'routed'
        ? ('active' as const)
        : selector.kind === 'legacy'
          ? ('bypassed' as const)
          : selector.kind === 'disabled'
            ? ('disabled' as const)
            : ('invalid' as const),
    environmentPreferred: selector.kind === 'routed' ? selector.preferred : null,
    providers: ROUTED_AI_PROVIDERS.map((name, index) => {
      const spentUsd = spend[index] ?? null;
      const capUsd = effective.capsUsd[name];
      return {
        provider: name,
        configured: isRoutedProviderConfigured(name, env),
        spentUsd,
        capUsd,
        capIsOverride: stored?.capsUsd[name] !== undefined,
        defaultCapUsd: defaults.capsUsd[name],
        defaultCapSource: defaultSource(env, capEnvName(name)),
        capStatus: capStatus(spentUsd, capUsd),
        models: AI_TIERS.map((level) => ({
          tier: level,
          value: effective.models[name][level],
          isOverride: Boolean(stored?.models[name][level]),
          defaultValue: defaults.models[name][level],
          defaultSource: defaultSource(env, modelEnvName(name, level)),
        })),
      };
    }),
    month: {
      label: `${pkt.getUTCFullYear()}-${String(pkt.getUTCMonth() + 1).padStart(2, '0')}`,
      from: month.from,
      to: month.to,
    },
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
    appliesWithinSeconds: AI_SETTINGS_APPLY_WITHIN_SECONDS,
  };
}

export type AISettingsView = Awaited<ReturnType<typeof describeSettings>>;

const resetInput = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('all') }).strict(),
  z.object({ scope: z.literal('mode') }).strict(),
  z.object({ scope: z.literal('providerOrder') }).strict(),
  z.object({ scope: z.literal('fallbackEnabled') }).strict(),
  z.object({ scope: z.literal('cap'), provider }).strict(),
  z.object({ scope: z.literal('model'), provider, tier }).strict(),
]);

function resetData(input: z.infer<typeof resetInput>): SettingsWrite {
  switch (input.scope) {
    case 'all':
      return { ...ALL_DEFAULTS };
    case 'mode':
      return { mode: 'Auto' };
    case 'providerOrder':
      return { providerOrder: [] };
    case 'fallbackEnabled':
      return { fallbackEnabled: true };
    case 'cap':
      return capWrite(input.provider, null);
    case 'model':
      return modelWrite(input.provider, input.tier, null);
  }
}

export const aiSettingsRouter = router({
  get: platformReadProcedure.query(async ({ ctx }) => {
    const row = await withAiSettingsDb(ctx, (db) =>
      db.aISetting.findUnique({ where: { id: SETTINGS_ID } })
    );
    return describeSettings(row, process.env, new Date());
  }),

  /** The active-provider switch. Auto follows the order; Force* puts one provider first. */
  setMode: platformWriteProcedure
    .input(z.object({ mode: z.enum(AI_ROUTING_MODES) }).strict())
    .mutation(({ ctx, input }) => writeSettings(ctx, 'ai.settings.updated', { mode: input.mode })),

  setProviderOrder: platformWriteProcedure
    .input(z.object({ providerOrder }).strict())
    .mutation(({ ctx, input }) =>
      writeSettings(ctx, 'ai.settings.updated', { providerOrder: input.providerOrder })
    ),

  setFallbackEnabled: platformWriteProcedure
    .input(z.object({ fallbackEnabled: z.boolean() }).strict())
    .mutation(({ ctx, input }) =>
      writeSettings(ctx, 'ai.settings.updated', { fallbackEnabled: input.fallbackEnabled })
    ),

  setMonthlyCap: platformWriteProcedure
    .input(z.object({ provider, capUsd: monthlyCapUsd }).strict())
    .mutation(({ ctx, input }) =>
      writeSettings(ctx, 'ai.settings.updated', capWrite(input.provider, input.capUsd), {
        provider: input.provider,
      })
    ),

  setTierModel: platformWriteProcedure
    .input(z.object({ provider, tier, model: modelId }).strict())
    .mutation(({ ctx, input }) =>
      writeSettings(
        ctx,
        'ai.settings.updated',
        modelWrite(input.provider, input.tier, input.model),
        { provider: input.provider, tier: input.tier }
      )
    ),

  /** Return one value, or everything, to the environment default (NULL / empty order). */
  reset: platformWriteProcedure
    .input(resetInput)
    .mutation(({ ctx, input }) =>
      writeSettings(ctx, 'ai.settings.reset', resetData(input), { scope: input.scope })
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
          JSON.stringify([key.provider, key.model, key.effectiveFrom.toISOString()])
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
            before: {
              inputUsdPerMTok: before ? before.inputUsdPerMTok.toString() : null,
              outputUsdPerMTok: before ? before.outputUsdPerMTok.toString() : null,
            },
            after: {
              inputUsdPerMTok: after.inputUsdPerMTok.toString(),
              outputUsdPerMTok: after.outputUsdPerMTok.toString(),
            },
            metadata: {
              field: 'price',
              provider: input.provider,
              model: input.model,
              effectiveFrom: input.effectiveFrom.toISOString(),
              created: !before,
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
