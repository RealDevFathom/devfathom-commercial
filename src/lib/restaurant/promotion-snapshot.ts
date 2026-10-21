import 'server-only';

/**
 * WHA-288 / promotions Lane A — §5, the immutable reconstruction contract.
 *
 * This module turns an evaluation into rows, and rows back into an evaluation.
 * The load-bearing property, from §5.2:
 *
 *   "No reconstruction query may join current promotions, catalog, category,
 *    branch timezone, tax configuration, or loyalty configuration."
 *
 * {@link reconstructEvaluation} therefore takes ONLY snapshot content — the
 * canonical input, the evaluation context, and each candidate's `ruleSnapshot`
 * — and re-runs the same evaluator. That is what lets an auditor six months
 * later reproduce candidate ordering, eligibility, unit selection and cents
 * after the promotion has been superseded, the category retitled, and the
 * branch moved to another timezone.
 *
 * Canonical serialization is the other half. Two structurally identical
 * evaluations MUST hash the same, so:
 *   - object keys are emitted in sorted order, recursively;
 *   - `Decimal` becomes its exact string, never a float;
 *   - `Date` becomes an ISO-8601 instant;
 *   - `undefined` is omitted; `null` is preserved (they mean different things
 *     here — a null `effectiveTo` is an open-ended schedule).
 */

import { createHash } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import {
  PROMOTION_ENGINE_VERSION,
  PROMOTION_MONEY_VERSION,
  type PromotionEvaluationContext,
  type PromotionEvaluationResult,
  type PromotionInputLine,
  type PromotionRule,
} from '@/lib/restaurant/promotion-contracts';
import { evaluatePromotions } from '@/lib/restaurant/promotion-evaluator';
import { resolvePromotionLocalFacts } from '@/lib/restaurant/promotion-schedule';

/* -------------------------------------------------------------------------- */
/* Canonical serialization                                                     */
/* -------------------------------------------------------------------------- */

/** A JSON value after canonicalization. */
export type CanonicalJson =
  string | number | boolean | null | CanonicalJson[] | { [key: string]: CanonicalJson };

function canonicalize(value: unknown): CanonicalJson {
  if (value === null) return null;
  if (value instanceof Prisma.Decimal) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, CanonicalJson> = {};
    // Sorted keys: the hash must not depend on property insertion order.
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      result[key] = canonicalize(source[key]);
    }
    return result;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('Cannot canonicalize a non-finite number.');
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  throw new TypeError(`Cannot canonicalize value of type ${typeof value}.`);
}

/** The canonical JSON text of a value — the exact bytes that get hashed. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** SHA-256 over the canonical serialization, lowercase hex. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/* -------------------------------------------------------------------------- */
/* Rule <-> ruleSnapshot                                                       */
/* -------------------------------------------------------------------------- */

/** The canonical rule payload stored in `ruleSnapshot` and hashed into
 * `ruleHash`. `ruleHash` itself is excluded — a hash cannot cover itself. */
export function ruleSnapshotOf(rule: PromotionRule): CanonicalJson {
  const content: Record<string, unknown> = { ...rule };
  delete content.ruleHash;
  return canonicalize(content);
}

/** §3.1 the `ruleHash` over the canonical serialization of the rule content. */
export function computeRuleHash(rule: PromotionRule): string {
  return canonicalHash(ruleSnapshotOf(rule));
}

function decimalOrNull(value: CanonicalJson): Prisma.Decimal | null {
  return value === null ? null : new Prisma.Decimal(String(value));
}

/** Rebuild a rule from its stored `ruleSnapshot`. This is the ONLY way a
 * reconstruction obtains rule content — it never reads the live version row. */
export function ruleFromSnapshot(snapshot: CanonicalJson, ruleHash: string): PromotionRule {
  const record = snapshot as Record<string, CanonicalJson>;
  const strings = (key: string): string[] => (record[key] as string[] | undefined) ?? [];
  return {
    promotionId: String(record.promotionId),
    promotionCode: String(record.promotionCode),
    versionId: String(record.versionId),
    versionNumber: Number(record.versionNumber),
    status: record.status as PromotionRule['status'],
    effectiveFrom: new Date(String(record.effectiveFrom)),
    effectiveTo: record.effectiveTo === null ? null : new Date(String(record.effectiveTo)),
    timezone: String(record.timezone),
    dayMask: Number(record.dayMask),
    startMinute: record.startMinute === null ? null : Number(record.startMinute),
    endMinute: record.endMinute === null ? null : Number(record.endMinute),
    activationMode: record.activationMode as PromotionRule['activationMode'],
    couponCodeHash: record.couponCodeHash === null ? null : String(record.couponCodeHash),
    requiresCoAuthorization: Boolean(record.requiresCoAuthorization),
    targetKind: record.targetKind as PromotionRule['targetKind'],
    targetProductIds: strings('targetProductIds'),
    targetVariantIds: strings('targetVariantIds'),
    targetCategoryIds: strings('targetCategoryIds'),
    includeDescendants: Boolean(record.includeDescendants),
    componentTargeting: Boolean(record.componentTargeting),
    allowedBranchIds: strings('allowedBranchIds'),
    allowedChannels: strings('allowedChannels') as PromotionRule['allowedChannels'],
    customerSegmentRef:
      record.customerSegmentRef === null ? null : String(record.customerSegmentRef),
    minimumQuantity: record.minimumQuantity === null ? null : Number(record.minimumQuantity),
    minimumAmount: decimalOrNull(record.minimumAmount ?? null),
    benefitKind: record.benefitKind as PromotionRule['benefitKind'],
    benefitBasisPoints:
      record.benefitBasisPoints === null ? null : Number(record.benefitBasisPoints),
    benefitAmount: decimalOrNull(record.benefitAmount ?? null),
    buyQuantity: record.buyQuantity === null ? null : Number(record.buyQuantity),
    getQuantity: record.getQuantity === null ? null : Number(record.getQuantity),
    applicationBasis: record.applicationBasis as PromotionRule['applicationBasis'],
    maxBenefitAmount: decimalOrNull(record.maxBenefitAmount ?? null),
    currency: String(record.currency),
    components: ((record.components as Record<string, CanonicalJson>[] | undefined) ?? []).map(
      (component) => ({
        ordinal: Number(component.ordinal),
        productIds: (component.productIds as string[] | undefined) ?? [],
        categoryIds: (component.categoryIds as string[] | undefined) ?? [],
        quantity: Number(component.quantity),
      })
    ),
    priority: Number(record.priority),
    stackingGroup: String(record.stackingGroup),
    stackingMode: record.stackingMode as PromotionRule['stackingMode'],
    stopFurtherProcessing: Boolean(record.stopFurtherProcessing),
    maxApplicationsPerOrder:
      record.maxApplicationsPerOrder === null ? null : Number(record.maxApplicationsPerOrder),
    perOrderCap: record.perOrderCap === null ? null : Number(record.perOrderCap),
    globalCap: record.globalCap === null ? null : Number(record.globalCap),
    perCustomerCap: record.perCustomerCap === null ? null : Number(record.perCustomerCap),
    budgetAmount: decimalOrNull(record.budgetAmount ?? null),
    offlinePolicy: record.offlinePolicy as PromotionRule['offlinePolicy'],
    ruleHash,
  };
}

/* -------------------------------------------------------------------------- */
/* Input lines and context                                                     */
/* -------------------------------------------------------------------------- */

/** §5.1 one persisted input line. `extendedAmount` is the pre-discount extended
 * charge, stored rather than recomputed so the snapshot is self-describing. */
export function inputLineSnapshotOf(line: PromotionInputLine): CanonicalJson {
  const modifierTotal = line.modifierDeltas.reduce(
    (total, delta) => total.plus(delta),
    new Prisma.Decimal(0)
  );
  const grossUnit = line.unitPrice.plus(modifierTotal);
  return canonicalize({
    orderItemId: line.orderItemId,
    productId: line.productId,
    variantId: line.variantId,
    categoryAncestry: line.categoryAncestry,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    modifierDeltas: line.modifierDeltas,
    compAllocation: line.compAllocation,
    extendedAmount: grossUnit.times(line.quantity),
  });
}

export function inputLineFromSnapshot(snapshot: CanonicalJson): PromotionInputLine {
  const record = snapshot as Record<string, CanonicalJson>;
  return {
    orderItemId: String(record.orderItemId),
    productId: String(record.productId),
    variantId: record.variantId === null ? null : String(record.variantId),
    categoryAncestry: (record.categoryAncestry as string[] | undefined) ?? [],
    quantity: Number(record.quantity),
    unitPrice: new Prisma.Decimal(String(record.unitPrice)),
    modifierDeltas: ((record.modifierDeltas as string[] | undefined) ?? []).map(
      (delta) => new Prisma.Decimal(delta)
    ),
    compAllocation: new Prisma.Decimal(String(record.compAllocation)),
  };
}

export function contextSnapshotOf(context: PromotionEvaluationContext): CanonicalJson {
  return canonicalize(context);
}

export function contextFromSnapshot(snapshot: CanonicalJson): PromotionEvaluationContext {
  const record = snapshot as Record<string, CanonicalJson>;
  return {
    evaluatedAt: new Date(String(record.evaluatedAt)),
    branchId: String(record.branchId),
    channel: record.channel as PromotionEvaluationContext['channel'],
    currency: String(record.currency),
    customerId: record.customerId === null ? null : String(record.customerId),
    customerSegments: (record.customerSegments as string[] | undefined) ?? [],
    couponFingerprints: (record.couponFingerprints as string[] | undefined) ?? [],
    authorityActorId: record.authorityActorId === null ? null : String(record.authorityActorId),
    online: Boolean(record.online),
  };
}

/* -------------------------------------------------------------------------- */
/* Building the snapshot                                                       */
/* -------------------------------------------------------------------------- */

export type PromotionSnapshotIdentity = {
  organizationId: string;
  orderId: string;
  branchId: string;
  idempotencyKey: string;
  /** The branch/evaluation timezone whose local facts are recorded (§5.1).
   * Each candidate's own schedule verdict is already implied by its reason. */
  timezone: string;
  setRevisionId: string;
  setRevisionHash: string;
  source: 'ONLINE' | 'OFFLINE_RECONCILED';
  terminalDeviceId: string | null;
  priceListVersionId: string | null;
};

/** The rows one accepted evaluation appends. Field names match the Prisma
 * models so a caller writes them straight through in one transaction. */
export type PromotionEvaluationSnapshotPayload = {
  evaluation: {
    organizationId: string;
    orderId: string;
    branchId: string;
    channel: PromotionEvaluationContext['channel'];
    currency: string;
    idempotencyKey: string;
    evaluatedAt: Date;
    timezone: string;
    localDate: string;
    localMinute: number;
    utcOffsetMinutes: number;
    engineVersion: string;
    moneyVersion: string;
    setRevisionId: string;
    setRevisionHash: string;
    source: 'ONLINE' | 'OFFLINE_RECONCILED';
    terminalDeviceId: string | null;
    priceListVersionId: string | null;
    inputLines: CanonicalJson;
    evaluationContext: CanonicalJson;
    inputHash: string;
    outputHash: string;
    discountTotal: Prisma.Decimal;
  };
  candidates: {
    organizationId: string;
    ordinal: number;
    promotionId: string;
    promotionVersionId: string;
    versionNumber: number;
    ruleHash: string;
    ruleSnapshot: CanonicalJson;
    activationMode: PromotionRule['activationMode'];
    authorityActorId: string | null;
    couponFingerprint: string | null;
    outcome: 'ACCEPTED' | 'REJECTED';
    reasonCode: string;
  }[];
  applications: {
    organizationId: string;
    applicationOrdinal: number;
    promotionId: string;
    promotionVersionId: string;
    ruleHash: string;
    benefitKind: PromotionRule['benefitKind'];
    unroundedBenefit: Prisma.Decimal;
    roundedBenefit: Prisma.Decimal;
    qualifyingAmount: Prisma.Decimal;
    discountedQuantity: number;
    allocations: {
      organizationId: string;
      orderItemId: string;
      unitOrdinal: number;
      allocatedAmount: Prisma.Decimal;
    }[];
  }[];
};

/** §5.1 the canonical input hash: everything that determines the output. */
export function computeInputHash(params: {
  context: PromotionEvaluationContext;
  lines: readonly PromotionInputLine[];
  rules: readonly PromotionRule[];
}): string {
  return canonicalHash({
    engineVersion: PROMOTION_ENGINE_VERSION,
    moneyVersion: PROMOTION_MONEY_VERSION,
    context: contextSnapshotOf(params.context),
    lines: params.lines.map(inputLineSnapshotOf),
    // Rule hashes, sorted, identify the pinned revision content exactly without
    // restating it — each full rule already lives on its candidate row.
    ruleHashes: [...params.rules].map((rule) => rule.ruleHash).sort(),
  });
}

/** §5.1 the canonical output hash: the result an auditor must reproduce. */
export function computeOutputHash(result: PromotionEvaluationResult): string {
  return canonicalHash({
    discountTotal: result.discountTotal,
    candidates: result.candidates.map((candidate) => ({
      ordinal: candidate.ordinal,
      promotionVersionId: candidate.promotionVersionId,
      outcome: candidate.outcome,
      reasonCode: candidate.reasonCode,
      applicationCount: candidate.applicationCount,
    })),
    applications: result.applications.map((application) => ({
      applicationOrdinal: application.applicationOrdinal,
      promotionVersionId: application.promotionVersionId,
      ruleHash: application.ruleHash,
      roundedBenefit: application.roundedBenefit,
      allocations: application.allocations,
    })),
  });
}

/**
 * Build every row one evaluation appends. Pure: it performs no I/O and takes
 * the server-supplied identity from the caller, so the same result is always
 * snapshotted the same way.
 */
export function buildEvaluationSnapshot(params: {
  identity: PromotionSnapshotIdentity;
  context: PromotionEvaluationContext;
  lines: readonly PromotionInputLine[];
  rules: readonly PromotionRule[];
  result: PromotionEvaluationResult;
}): PromotionEvaluationSnapshotPayload {
  const { identity, context, lines, rules, result } = params;
  const organizationId = identity.organizationId;
  const facts = resolvePromotionLocalFacts(context.evaluatedAt, identity.timezone);
  const rulesByVersion = new Map(rules.map((rule) => [rule.versionId, rule]));

  return {
    evaluation: {
      organizationId,
      orderId: identity.orderId,
      branchId: identity.branchId,
      channel: context.channel,
      currency: context.currency,
      idempotencyKey: identity.idempotencyKey,
      evaluatedAt: context.evaluatedAt,
      timezone: identity.timezone,
      localDate: facts.localDate,
      localMinute: facts.localMinute,
      utcOffsetMinutes: facts.utcOffsetMinutes,
      engineVersion: result.engineVersion,
      moneyVersion: result.moneyVersion,
      setRevisionId: identity.setRevisionId,
      setRevisionHash: identity.setRevisionHash,
      source: identity.source,
      terminalDeviceId: identity.terminalDeviceId,
      priceListVersionId: identity.priceListVersionId,
      inputLines: lines.map(inputLineSnapshotOf),
      evaluationContext: contextSnapshotOf(context),
      inputHash: computeInputHash({ context, lines, rules }),
      outputHash: computeOutputHash(result),
      discountTotal: result.discountTotal,
    },
    candidates: result.candidates.map((candidate) => {
      const rule = rulesByVersion.get(candidate.promotionVersionId);
      if (rule === undefined) {
        throw new Error(
          `Candidate ${candidate.promotionVersionId} has no rule in the evaluated set.`
        );
      }
      return {
        organizationId,
        ordinal: candidate.ordinal,
        promotionId: candidate.promotionId,
        promotionVersionId: candidate.promotionVersionId,
        versionNumber: candidate.versionNumber,
        ruleHash: candidate.ruleHash,
        ruleSnapshot: ruleSnapshotOf(rule),
        activationMode: candidate.activationMode,
        // §10: only the actor and a non-reversible fingerprint are retained;
        // the fingerprint is already hashed before it reaches this lane.
        authorityActorId:
          rule.activationMode === 'STAFF' || rule.activationMode === 'MANAGER'
            ? context.authorityActorId
            : null,
        couponFingerprint: rule.activationMode === 'COUPON_CODE' ? rule.couponCodeHash : null,
        outcome: candidate.outcome,
        reasonCode: candidate.reasonCode,
      };
    }),
    applications: result.applications.map((application) => ({
      organizationId,
      applicationOrdinal: application.applicationOrdinal,
      promotionId: application.promotionId,
      promotionVersionId: application.promotionVersionId,
      ruleHash: application.ruleHash,
      benefitKind: application.benefitKind,
      unroundedBenefit: application.unroundedBenefit,
      roundedBenefit: application.roundedBenefit,
      qualifyingAmount: application.qualifyingAmount,
      discountedQuantity: application.discountedQuantity,
      allocations: application.allocations.map((allocation) => ({
        organizationId,
        orderItemId: allocation.orderItemId,
        unitOrdinal: allocation.unitOrdinal,
        allocatedAmount: allocation.allocatedAmount,
      })),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Reconstruction                                                              */
/* -------------------------------------------------------------------------- */

/** Exactly the snapshot content a reconstruction is allowed to read (§5.2).
 * Deliberately NOT a Prisma row type: nothing here may reach a live table. */
export type PromotionReconstructionInput = {
  inputLines: CanonicalJson;
  evaluationContext: CanonicalJson;
  candidates: readonly { ruleSnapshot: CanonicalJson; ruleHash: string }[];
};

/**
 * §5.2 — re-derive the evaluation from snapshot content ALONE.
 *
 * Every candidate is replayed, including the rejected ones, because they were
 * part of the ordering that produced the winner. The caller compares
 * {@link computeOutputHash} of this result against the stored `outputHash`; an
 * equal hash proves the checkout is reproducible without any live join.
 */
export function reconstructEvaluation(
  snapshot: PromotionReconstructionInput
): PromotionEvaluationResult {
  const lines = (snapshot.inputLines as CanonicalJson[]).map(inputLineFromSnapshot);
  const context = contextFromSnapshot(snapshot.evaluationContext);
  const rules = snapshot.candidates.map((candidate) =>
    ruleFromSnapshot(candidate.ruleSnapshot, candidate.ruleHash)
  );
  return evaluatePromotions({ context, lines, rules });
}

/**
 * §5.2 — a correction appends a reversal that NEGATES the original allocations
 * and references it. The original is never edited; the DB triggers refuse that
 * outright. The reversal's `discountTotal` is the exact accounting inverse.
 */
export function buildReversalSnapshot(params: {
  original: PromotionEvaluationSnapshotPayload['evaluation'] & { id: string };
  reversalReason: string;
  idempotencyKey: string;
}): PromotionEvaluationSnapshotPayload['evaluation'] & {
  reversesSnapshotId: string;
  reversalReason: string;
} {
  const { original, reversalReason, idempotencyKey } = params;
  return {
    ...original,
    idempotencyKey,
    discountTotal: original.discountTotal.negated(),
    reversesSnapshotId: original.id,
    reversalReason,
  };
}
