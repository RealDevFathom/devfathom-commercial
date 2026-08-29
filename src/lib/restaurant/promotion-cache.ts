import {
  PROMOTION_ENGINE_VERSION,
  PROMOTION_ERROR,
  PromotionError,
  type PromotionEvaluationContext,
  type PromotionEvaluationResult,
  type PromotionInputLine,
  type PromotionRule,
} from '@/lib/restaurant/promotion-contracts';
import {
  evaluatePromotions,
  type PromotionEvaluationInput,
} from '@/lib/restaurant/promotion-evaluator';
import { Decimal } from '@/lib/restaurant/money-arithmetic';

import { POS_STORE_SCHEMA_VERSION, sameScope, type PosScope } from './pos-client-store';

export type SerializedPromotionRule = Omit<
  PromotionRule,
  | 'effectiveFrom'
  | 'effectiveTo'
  | 'minimumAmount'
  | 'benefitAmount'
  | 'maxBenefitAmount'
  | 'budgetAmount'
> & {
  effectiveFrom: string;
  effectiveTo: string | null;
  minimumAmount: string | null;
  benefitAmount: string | null;
  maxBenefitAmount: string | null;
  budgetAmount: string | null;
};

export type PromotionCachePayload = {
  schemaVersion: number;
  engineVersion: string;
  scope: PosScope;
  channel: PromotionEvaluationContext['channel'];
  revisionId: string;
  revisionHash: string;
  etag: string;
  issuedAt: string;
  validUntil: string;
  rules: SerializedPromotionRule[];
};

export type PromotionCacheEnvelope = {
  payload: PromotionCachePayload;
  signature: string;
};

export type TrustedTimeAnchor = {
  serverTimeMs: number;
  monotonicTimeMs: number;
};

export type PromotionCacheFailure =
  | 'MISSING'
  | 'SIGNATURE'
  | 'SCOPE'
  | 'CHANNEL'
  | 'SCHEMA'
  | 'ENGINE'
  | 'EXPIRED'
  | 'ONLINE_REQUIRED'
  | 'MALFORMED';

export type ValidatedPromotionCache = Omit<PromotionCachePayload, 'rules'> & {
  rules: PromotionRule[];
};

export type ValidatePromotionCacheResult =
  | { ok: true; cache: ValidatedPromotionCache }
  | { ok: false; reason: PromotionCacheFailure; message: string };

const decimal = (value: string | null): Decimal | null =>
  value === null ? null : new Decimal(value);

export function serializePromotionRule(rule: PromotionRule): SerializedPromotionRule {
  return {
    ...rule,
    effectiveFrom: rule.effectiveFrom.toISOString(),
    effectiveTo: rule.effectiveTo?.toISOString() ?? null,
    minimumAmount: rule.minimumAmount?.toString() ?? null,
    benefitAmount: rule.benefitAmount?.toString() ?? null,
    maxBenefitAmount: rule.maxBenefitAmount?.toString() ?? null,
    budgetAmount: rule.budgetAmount?.toString() ?? null,
  };
}

export function deserializePromotionRule(rule: SerializedPromotionRule): PromotionRule {
  const effectiveFrom = new Date(rule.effectiveFrom);
  const effectiveTo = rule.effectiveTo === null ? null : new Date(rule.effectiveTo);
  if (
    !Number.isFinite(effectiveFrom.getTime()) ||
    (effectiveTo !== null && !Number.isFinite(effectiveTo.getTime()))
  ) {
    throw new PromotionError(PROMOTION_ERROR.CACHE_INVALID, 'Promotion cache dates are invalid.');
  }
  return {
    ...rule,
    effectiveFrom,
    effectiveTo,
    minimumAmount: decimal(rule.minimumAmount),
    benefitAmount: decimal(rule.benefitAmount),
    maxBenefitAmount: decimal(rule.maxBenefitAmount),
    budgetAmount: decimal(rule.budgetAmount),
  };
}

export function canonicalPromotionCachePayload(payload: PromotionCachePayload): string {
  return JSON.stringify(payload);
}

export async function validatePromotionCache(input: {
  envelope: PromotionCacheEnvelope | null;
  scope: PosScope;
  channel: PromotionEvaluationContext['channel'];
  time: TrustedTimeAnchor;
  monotonicNowMs: number;
  verifySignature: (payload: string, signature: string) => boolean | Promise<boolean>;
}): Promise<ValidatePromotionCacheResult> {
  const envelope = input.envelope;
  if (!envelope) {
    return {
      ok: false,
      reason: 'MISSING',
      message: 'Promotion cache is missing. Reconnect to price this order.',
    };
  }
  const payload = envelope.payload;
  let signatureValid = false;
  try {
    signatureValid = await input.verifySignature(
      canonicalPromotionCachePayload(payload),
      envelope.signature
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return { ok: false, reason: 'SIGNATURE', message: 'Promotion cache signature is invalid.' };
  }
  if (!payload.scope || !sameScope(payload.scope, input.scope)) {
    return { ok: false, reason: 'SCOPE', message: 'Promotion cache belongs to another terminal.' };
  }
  if (payload.channel !== input.channel) {
    return {
      ok: false,
      reason: 'CHANNEL',
      message: 'Promotion cache does not cover this order channel.',
    };
  }
  if (payload.schemaVersion !== POS_STORE_SCHEMA_VERSION) {
    return { ok: false, reason: 'SCHEMA', message: 'Promotion cache schema is incompatible.' };
  }
  if (payload.engineVersion !== PROMOTION_ENGINE_VERSION) {
    return {
      ok: false,
      reason: 'ENGINE',
      message: 'Promotion cache requires a different pricing engine.',
    };
  }
  const validUntilMs = Date.parse(payload.validUntil);
  const elapsed = input.monotonicNowMs - input.time.monotonicTimeMs;
  const trustedNowMs = input.time.serverTimeMs + Math.max(0, elapsed);
  if (!Number.isFinite(validUntilMs) || trustedNowMs >= validUntilMs) {
    return {
      ok: false,
      reason: 'EXPIRED',
      message: 'Promotion cache has expired. Reconnect for an explicit reprice.',
    };
  }
  try {
    const rules = payload.rules.map(deserializePromotionRule);
    if (
      rules.some(
        (rule) =>
          rule.offlinePolicy !== 'ALLOW' ||
          rule.globalCap !== null ||
          rule.perCustomerCap !== null ||
          rule.budgetAmount !== null ||
          rule.customerSegmentRef !== null ||
          rule.activationMode === 'MANAGER'
      )
    ) {
      return {
        ok: false,
        reason: 'ONLINE_REQUIRED',
        message: 'This promotion set requires an online price.',
      };
    }
    return { ok: true, cache: { ...payload, rules } };
  } catch {
    return { ok: false, reason: 'MALFORMED', message: 'Promotion cache contains an invalid rule.' };
  }
}

export function invalidatePromotionCache(
  envelope: PromotionCacheEnvelope | null,
  etag: string
): PromotionCacheEnvelope | null {
  return envelope?.payload.etag === etag ? envelope : null;
}

export type SerializedPromotionInput = {
  context: Omit<
    PromotionEvaluationContext,
    'evaluatedAt' | 'online' | 'customerId' | 'customerSegments'
  > & { evaluatedAt: string };
  lines: Array<
    Omit<PromotionInputLine, 'unitPrice' | 'modifierDeltas' | 'compAllocation'> & {
      unitPrice: string;
      modifierDeltas: string[];
      compAllocation: string;
    }
  >;
};

export function serializePromotionInput(input: PromotionEvaluationInput): SerializedPromotionInput {
  const {
    evaluatedAt,
    online: _online,
    customerId: _customerId,
    customerSegments: _customerSegments,
    ...context
  } = input.context;
  return {
    context: {
      ...context,
      evaluatedAt: evaluatedAt.toISOString(),
    },
    lines: input.lines.map((line) => ({
      ...line,
      unitPrice: line.unitPrice.toString(),
      modifierDeltas: line.modifierDeltas.map((value) => value.toString()),
      compAllocation: line.compAllocation.toString(),
    })),
  };
}

export function evaluateCachedPromotions(
  cache: ValidatedPromotionCache,
  input: SerializedPromotionInput
): PromotionEvaluationResult {
  return evaluatePromotions({
    context: {
      ...input.context,
      evaluatedAt: new Date(input.context.evaluatedAt),
      customerId: null,
      customerSegments: [],
      online: false,
    },
    lines: input.lines.map((line) => ({
      ...line,
      unitPrice: new Decimal(line.unitPrice),
      modifierDeltas: line.modifierDeltas.map((value) => new Decimal(value)),
      compAllocation: new Decimal(line.compAllocation),
    })),
    rules: cache.rules,
  });
}

/** Decimal instances are never written to IndexedDB; their JSON form is the
 * canonical string form used by both online and offline queue payloads. */
export function serializePromotionResult(
  result: PromotionEvaluationResult
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
}
